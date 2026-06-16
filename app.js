/* ============================================================
   COUP — app.js
   Frontend + host-driven game engine.

   Sync model (chosen architecture):
   - The HOST's browser is the authoritative engine.
   - Clients send "intents" over a Supabase Realtime broadcast
     channel (room:<gameId>, event "intent").
   - Only the host validates intents, mutates state, and writes
     it to games.state. Everyone renders from postgres_changes
     UPDATE events on the games row — one source of truth.
   - Logs are append-only rows in game_logs; clients render
     INSERTs into an aria-live region.
   ============================================================ */

"use strict";

/* ---------------- 0. Constants ---------------- */

const ROLES = ["Duke", "Assassin", "Captain", "Ambassador", "Contessa"];
const ROLE_SYMBOL = { Duke: "◆", Assassin: "✦", Captain: "▲", Ambassador: "⬟", Contessa: "●" };

// Host-customizable settings (chosen in the lobby) with their defaults.
const DEFAULT_SETTINGS = {
  reactionSecs: 15,  // challenge / block window
  decideSecs:   30,  // pick a card to lose / exchange picks
  turnSecs:     0,   // time per turn; 0 = unlimited
  startCoins:   2,
  coupGuess:    true, // true: attacker guesses a card · false: classic (target chooses)
};
const SETTING_OPTIONS = {
  reactionSecs: { label: "Reaction time",  unit: "s", values: [10, 8, 15, 20, 30, 0], zeroName: "∞" },
  decideSecs:   { label: "Decision time",  unit: "s", values: [15, 8, 30, 45, 60, 0], zeroName: "∞" },
  turnSecs:     { label: "Turn timer",     unit: "s", values: [0, 8, 30, 60, 90],     zeroName: "Off" },
  startCoins:   { label: "Starting coins", unit: "",  values: [1, 2, 3] },
  coupGuess:    { label: "Coup style",     unit: "",  values: [true, false],
                  names: { true: "Guess a card", false: "Classic" } },
};
function getSettings(s) { return { ...DEFAULT_SETTINGS, ...((s && s.settings) || {}) }; }

// Open a timed window. secs = 0 means "no limit": the window only resolves
// when everyone has explicitly responded (or the player decides).
function armWindow(s, kind) {
  const st = getSettings(s);
  const secs = kind === "reaction" ? st.reactionSecs : st.decideSecs;
  s.openedAt = Date.now();
  s.deadlineAt = secs > 0 ? Date.now() + secs * 1000 : null;
}

const ARM_DELAY_MS = 1200; // reaction buttons stay disabled briefly to prevent misclicks

// Big-moment overlay events, written by the host into the state
function fx(s, text) {
  s.fxSeq = (s.fxSeq || 0) + 1;
  s.fx = { key: s.fxSeq, text };
}

// Room codes avoid lookalike glyphs (no 0/O, 1/I/L, 5/S, 8/B...kept B for brevity? no — drop them all)
const CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXYZ234679";

const ACTIONS = {
  income:      { label: "Income", sub: "+1 coin · safe",              cost: 0, targeted: false, claim: null,         blockRoles: [] },
  foreign_aid: { label: "Foreign aid", sub: "+2 · Duke can block",    cost: 0, targeted: false, claim: null,         blockRoles: ["Duke"] },
  coup:        { label: "Coup", sub: "pay 7 · guess a card",          cost: 7, targeted: true,  claim: null,         blockRoles: [], guess: true },
  tax:         { label: "Tax", sub: "+3 · claim Duke",                cost: 0, targeted: false, claim: "Duke",       blockRoles: [] },
  assassinate: { label: "Assassinate", sub: "pay 3 · claim Assassin", cost: 3, targeted: true,  claim: "Assassin",   blockRoles: ["Contessa"] },
  steal:       { label: "Steal", sub: "take 2 · claim Captain",       cost: 0, targeted: true,  claim: "Captain",    blockRoles: ["Captain", "Ambassador"] },
  exchange:    { label: "Exchange", sub: "swap · claim Ambassador",   cost: 0, targeted: false, claim: "Ambassador", blockRoles: [] },
};

function actionPhrase(action, targetName) {
  switch (action) {
    case "income":      return "take Income";
    case "foreign_aid": return "take Foreign aid (+2)";
    case "coup":        return `coup ${targetName}`;
    case "tax":         return "take Tax as Duke (+3)";
    case "assassinate": return `assassinate ${targetName}`;
    case "steal":       return `steal 2 from ${targetName}`;
    case "exchange":    return "exchange cards as Ambassador";
    default:            return action;
  }
}

/* ---------------- 1. Supabase setup ---------------- */

const CFG = window.COUP_CONFIG || {};
const configured =
  CFG.SUPABASE_URL && !CFG.SUPABASE_URL.includes("YOUR-PROJECT-REF") &&
  CFG.SUPABASE_ANON_KEY && !CFG.SUPABASE_ANON_KEY.includes("YOUR-ANON");

const sb = configured ? supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;

/* ---------------- 2. Local session ---------------- */

const session = {
  gameId: null,
  code: null,
  playerId: null,
  playerName: null,
  isHost: false,
  channel: null,        // broadcast channel for intents
  dbChannel: null,      // postgres_changes channel
  roster: [],           // players table rows (lobby)
  game: null,           // games table row (incl. state)
  hostState: null,      // host-only in-memory authoritative state
  hostTimer: null,      // host-only timeout handle
  logSeq: 0,
  lastPromptKey: null,  // focus management
};

function identityKey(code) { return `coup:identity:${code}`; }

function uuid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });
}

/* ---------------- 3. DOM helpers ---------------- */

const $ = (id) => document.getElementById(id);
const screens = ["screen-config", "screen-landing", "screen-lobby", "screen-game"];

function showScreen(id) {
  for (const s of screens) $(s).hidden = (s !== id);
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

const BTN_PRIMARY = "min-h-[48px] w-full text-base font-bold bg-sun text-ink rounded-lg px-3 py-2 text-left hover:brightness-110";
const BTN_NEUTRAL = "min-h-[48px] w-full text-base font-bold bg-card text-mist border border-line rounded-lg px-3 py-2 text-left hover:border-mist";
const BTN_DANGER  = "min-h-[48px] w-full text-base font-bold bg-card text-alert border border-alert/60 rounded-lg px-3 py-2 text-left hover:border-alert";
const BTN_BACK    = "min-h-[40px] w-full text-sm font-bold text-dim bg-transparent border border-line rounded-lg px-3 py-1.5 text-left hover:text-mist hover:border-mist";

/* ---------------- 4. Landing: create / join ---------------- */

function landingError(msg) {
  const p = $("landing-error");
  p.textContent = msg || "";
  p.hidden = !msg;
}

function readName() {
  const name = $("player-name").value.trim();
  if (!name) {
    landingError("Please enter your name first.");
    $("player-name").focus();
    return null;
  }
  return name.slice(0, 20);
}

function randomCode() {
  let s = "";
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

async function createGame() {
  const name = readName();
  if (!name) return;
  landingError("");
  $("btn-create").disabled = true;
  try {
    // Try a few codes in case of a rare collision
    let game = null;
    for (let attempt = 0; attempt < 5 && !game; attempt++) {
      const code = randomCode();
      const { data, error } = await sb.from("games")
        .insert({ code, status: "lobby", state: {} })
        .select().single();
      if (!error) game = data;
      else if (!String(error.message).toLowerCase().includes("duplicate")) throw error;
    }
    if (!game) throw new Error("Could not generate a unique room code. Please try again.");

    const playerId = uuid();
    const { error: pErr } = await sb.from("players")
      .insert({ id: playerId, game_id: game.id, name });
    if (pErr) throw pErr;

    await sb.from("games").update({ host_player_id: playerId }).eq("id", game.id);
    game.host_player_id = playerId;

    localStorage.setItem(identityKey(game.code), JSON.stringify({ id: playerId, name }));
    await enterRoom(game, playerId, name);
  } catch (e) {
    landingError(`Could not create the game: ${e.message}`);
  } finally {
    $("btn-create").disabled = false;
  }
}

async function joinGame() {
  const name = readName();
  if (!name) return;
  const code = $("join-code").value.trim().toUpperCase();
  if (code.length !== 4) {
    landingError("Room codes are exactly 4 letters or numbers.");
    $("join-code").focus();
    return;
  }
  landingError("");
  $("btn-join").disabled = true;
  try {
    const { data: game, error } = await sb.from("games")
      .select().eq("code", code).order("created_at", { ascending: false })
      .limit(1).maybeSingle();
    if (error) throw error;
    if (!game) { landingError(`No game found with code ${code}. Check the letters and try again.`); return; }

    // Resume if this browser already joined this room
    const saved = localStorage.getItem(identityKey(code));
    let playerId = null;
    if (saved) {
      const id = JSON.parse(saved).id;
      const { data: existing } = await sb.from("players")
        .select().eq("id", id).eq("game_id", game.id).maybeSingle();
      if (existing) playerId = existing.id;
    }

    if (!playerId) {
      if (game.status !== "lobby") { landingError("That game has already started. Ask the host for a new room."); return; }
      const { count } = await sb.from("players")
        .select("*", { count: "exact", head: true }).eq("game_id", game.id);
      if ((count ?? 0) >= 6) { landingError("That room is full (6 players maximum)."); return; }
      playerId = uuid();
      const { error: pErr } = await sb.from("players")
        .insert({ id: playerId, game_id: game.id, name });
      if (pErr) throw pErr;
      localStorage.setItem(identityKey(code), JSON.stringify({ id: playerId, name }));
    }

    await enterRoom(game, playerId, name);
  } catch (e) {
    landingError(`Could not join: ${e.message}`);
  } finally {
    $("btn-join").disabled = false;
  }
}

/* ---------------- 5. Room: subscriptions & routing ---------------- */

async function enterRoom(game, playerId, name) {
  session.gameId = game.id;
  session.code = game.code;
  session.playerId = playerId;
  session.playerName = name;
  session.game = game;
  session.isHost = game.host_player_id === playerId;

  await refreshRoster();
  await loadRecentLogs();

  // Postgres changes: game state + roster + logs
  session.dbChannel = sb.channel(`db:${game.id}`)
    .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${game.id}` },
      (payload) => {
        session.game = payload.new;
        session.isHost = payload.new.host_player_id === session.playerId;
        renderAll();
      })
    .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "players", filter: `game_id=eq.${game.id}` },
      async () => { await refreshRoster(); renderAll(); })
    .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "game_logs", filter: `game_id=eq.${game.id}` },
      (payload) => appendLog(payload.new.message))
    .subscribe();

  // Broadcast: client intents → host engine
  session.channel = sb.channel(`room:${game.id}`, { config: { broadcast: { self: true } } })
    .on("broadcast", { event: "intent" }, ({ payload }) => {
      if (session.isHost) hostHandleIntent(payload);
    })
    .subscribe();

  // Host rejoining a live game: rehydrate the engine and re-arm the clock
  if (session.isHost && game.status === "playing" && game.state && game.state.phase) {
    session.hostState = game.state;
    hostArmTimer();
  }

  // Show the room code in the header so anyone can read it out / rejoin
  const chip = $("header-code");
  chip.textContent = game.code;
  chip.hidden = false;

  // Don't replay a big-moment overlay from before we joined
  if (game.state && game.state.fx) lastFxKey = game.state.fx.key;

  renderAll();
}

async function refreshRoster() {
  const { data } = await sb.from("players")
    .select().eq("game_id", session.gameId).order("joined_at", { ascending: true });
  session.roster = data || [];
}

async function loadRecentLogs() {
  const { data } = await sb.from("game_logs")
    .select().eq("game_id", session.gameId).order("id", { ascending: true }).limit(200);
  $("game-log").innerHTML = "";
  for (const row of data || []) appendLog(row.message);
  session.logSeq = data && data.length ? data[data.length - 1].seq : 0;
}

function sendIntent(intent) {
  session.channel.send({
    type: "broadcast",
    event: "intent",
    payload: { ...intent, from: session.playerId },
  });
}

/* ============================================================
   6. HOST ENGINE — only runs in the host's browser
   ============================================================ */

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function freshState(rosterRows, settings) {
  const st = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const deck = shuffle(ROLES.flatMap((r) => [r, r, r])); // 15 cards
  const order = shuffle([...rosterRows]);
  const players = order.map((row) => ({
    id: row.id,
    name: row.name,
    coins: st.startCoins,
    cards: [
      { role: deck.pop(), revealed: false },
      { role: deck.pop(), revealed: false },
    ],
  }));
  return {
    phase: "action",
    players,
    deck,
    turnIdx: 0,
    pending: null,
    lossQueue: [],
    losingId: null,
    continuation: null,
    exchange: null,
    deadlineAt: st.turnSecs > 0 ? Date.now() + st.turnSecs * 1000 : null,
    winnerId: null,
    gen: 0,
    settings: st,
    fxSeq: 0,
    fx: null,
  };
}

const byId = (s, id) => s.players.find((p) => p.id === id);
const isAlive = (p) => p.cards.some((c) => !c.revealed);
const alivePlayers = (s) => s.players.filter(isAlive);
const currentPlayer = (s) => s.players[s.turnIdx];

function hostLog(message) {
  session.logSeq += 1;
  sb.from("game_logs")
    .insert({ game_id: session.gameId, seq: session.logSeq, message })
    .then(({ error }) => { if (error) console.error("log insert failed", error); });
}

async function hostPush() {
  const s = session.hostState;
  s.gen += 1;
  const status = s.phase === "over" ? "over" : "playing";
  const { error } = await sb.from("games")
    .update({ state: s, status })
    .eq("id", session.gameId);
  if (error) console.error("state push failed", error);
  hostArmTimer();
}

/* ----- Host clock: enforces every deadline ----- */

function hostArmTimer() {
  clearTimeout(session.hostTimer);
  const s = session.hostState;
  if (!s || !s.deadlineAt || s.phase === "over") return;
  const wait = Math.max(0, s.deadlineAt - Date.now()) + 200; // small grace
  const genAtArm = s.gen;
  session.hostTimer = setTimeout(() => {
    if (!session.hostState || session.hostState.gen !== genAtArm) return; // stale
    hostHandleTimeout();
  }, wait);
}

function hostHandleTimeout() {
  const s = session.hostState;
  switch (s.phase) {
    case "action": {
      const p = currentPlayer(s);
      if (p.coins >= 10) {
        const targets = alivePlayers(s).filter((x) => x.id !== p.id);
        const t = targets[Math.floor(Math.random() * targets.length)];
        const guess = ROLES[Math.floor(Math.random() * ROLES.length)];
        hostLog(`${p.name} ran out of time — forced Coup.`);
        doAction(s, p.id, "coup", t.id, guess);
      } else {
        hostLog(`${p.name} ran out of time — Income.`);
        doAction(s, p.id, "income");
      }
      break;
    }
    case "reaction":
      resolveAction(s);
      break;
    case "block_reaction":
      blockSucceeds(s);
      break;
    case "lose_card": {
      const p = byId(s, s.losingId);
      const idx = p.cards.findIndex((c) => !c.revealed);
      revealCard(s, p, idx);
      continueAfterReveal(s);
      break;
    }
    case "exchange": {
      finishExchange(s, null); // null -> keep current hand
      break;
    }
    default:
      return;
  }
  hostPush();
}

/* ----- Intent router ----- */

function hostHandleIntent(intent) {
  const { type, from } = intent;

  if (type === "start") {
    if (from !== session.playerId) return;            // only the host starts
    if (session.game.status !== "lobby") return;
    if (session.roster.length < 2 || session.roster.length > 6) return;
    const lobbySettings = (session.game.state && session.game.state.settings) || {};
    session.hostState = freshState(session.roster, lobbySettings);
    const s = session.hostState;
    hostLog(`Game on — turn order: ${s.players.map((p) => p.name).join(" → ")}.`);
    hostPush();
    return;
  }

  const s = session.hostState;
  if (!s || s.phase === "over") return;
  const actor = byId(s, from);
  if (!actor || !isAlive(actor)) return;

  let changed = false;
  switch (type) {
    case "action":        changed = doAction(s, from, intent.action, intent.target, intent.guess); break;
    case "pass":          changed = doPass(s, from); break;
    case "challenge":     changed = doChallenge(s, from); break;
    case "block":         changed = doBlock(s, from, intent.role); break;
    case "lose":          changed = doLose(s, from, intent.cardIndex); break;
    case "exchange_keep": changed = doExchangeKeep(s, from, intent.keep); break;
  }
  if (changed) hostPush();
}

/* ----- Action declaration ----- */

function doAction(s, pid, action, targetId, guess) {
  if (s.phase !== "action") return false;
  if (currentPlayer(s).id !== pid) return false;
  const spec = ACTIONS[action];
  if (!spec) return false;
  const actor = byId(s, pid);

  if (actor.coins >= 10 && action !== "coup") return false;     // mandatory coup
  if (actor.coins < spec.cost) return false;
  const guessMode = action === "coup" && getSettings(s).coupGuess;
  if (guessMode && !ROLES.includes(guess)) return false;

  let target = null;
  if (spec.targeted) {
    target = byId(s, targetId);
    if (!target || target.id === pid || !isAlive(target)) return false;
    if (action === "steal" && target.coins === 0) return false;
  }

  actor.coins -= spec.cost; // costs are paid on declaration and are not refunded

  if (action === "income") {
    actor.coins += 1;
    hostLog(`${actor.name}: Income → ${actor.coins} coins.`);
    endTurn(s);
    return true;
  }

  if (action === "coup") {
    if (guessMode) {
      // House rule: the attacker names a card. Right → that card is lost.
      // Wrong → the coup fails (the 7 coins are spent either way).
      const idx = target.cards.findIndex((c) => !c.revealed && c.role === guess);
      if (idx >= 0) {
        hostLog(`${actor.name} coups ${target.name}, guessing ${guess} — correct!`);
        fx(s, `💥 COUP HITS! ${target.name} had ${guess}`);
        revealCard(s, target, idx);
      } else {
        hostLog(`${actor.name} coups ${target.name}, guessing ${guess} — wrong. The coup fails.`);
        fx(s, `💨 Coup misses — no ${guess} there`);
      }
      endTurn(s);
    } else {
      hostLog(`${actor.name} coups ${target.name}.`);
      fx(s, `💥 COUP on ${target.name}!`);
      enqueueLoss(s, target.id, "end");
    }
    return true;
  }

  // Everything else opens a reaction window
  s.pending = {
    action,
    actorId: pid,
    targetId: target ? target.id : null,
    canChallenge: !!spec.claim,
    block: null,
    passes: [],
  };
  s.phase = "reaction";
  armWindow(s, "reaction");

  hostLog(`${actor.name}: ${actionPhrase(action, target ? target.name : "")}.`);
  return true;
}

/* ----- Reaction windows ----- */

// Who may still act in the current window?
function eligibleReactors(s) {
  if (s.phase === "reaction") {
    const { actorId, targetId, canChallenge, action } = s.pending;
    if (canChallenge) {
      return alivePlayers(s).filter((p) => p.id !== actorId).map((p) => p.id);
    }
    // block-only window (foreign aid, or post-challenge block window)
    const spec = ACTIONS[action];
    if (!spec.blockRoles.length) return [];
    if (spec.targeted) {
      const t = byId(s, targetId);
      return t && isAlive(t) ? [t.id] : [];
    }
    return alivePlayers(s).filter((p) => p.id !== actorId).map((p) => p.id);
  }
  if (s.phase === "block_reaction") {
    return alivePlayers(s).filter((p) => p.id !== s.pending.block.by).map((p) => p.id);
  }
  return [];
}

function canBlockNow(s, pid) {
  if (s.phase !== "reaction") return false;
  const { action, actorId, targetId } = s.pending;
  const spec = ACTIONS[action];
  if (!spec.blockRoles.length) return false;
  if (pid === actorId) return false;
  if (spec.targeted) return pid === targetId;
  return true; // foreign aid: anyone else may claim Duke
}

function doPass(s, pid) {
  if (s.phase !== "reaction" && s.phase !== "block_reaction") return false;
  const eligible = eligibleReactors(s);
  if (!eligible.includes(pid) || s.pending.passes.includes(pid)) return false;
  s.pending.passes.push(pid);
  if (eligible.every((id) => s.pending.passes.includes(id))) {
    if (s.phase === "reaction") resolveAction(s);
    else blockSucceeds(s);
  }
  return true;
}

function doBlock(s, pid, role) {
  if (!canBlockNow(s, pid)) return false;
  const spec = ACTIONS[s.pending.action];
  if (!spec.blockRoles.includes(role)) return false;
  const blocker = byId(s, pid);
  s.pending.block = { by: pid, role };
  s.phase = "block_reaction";
  s.pending.passes = [];
  armWindow(s, "reaction");
  hostLog(`${blocker.name} blocks with ${role}.`);
  return true;
}

function doChallenge(s, pid) {
  if (s.phase !== "reaction" && s.phase !== "block_reaction") return false;
  if (s.phase === "reaction" && !s.pending.canChallenge) return false;
  const eligible = eligibleReactors(s);
  if (!eligible.includes(pid)) return false;

  const challenger = byId(s, pid);
  let accused, claimedRole, provedCont, bluffCont;
  if (s.phase === "reaction") {
    accused = byId(s, s.pending.actorId);
    claimedRole = ACTIONS[s.pending.action].claim;
    provedCont = "post_challenge_block_window"; // action survives; target may still block
    bluffCont = "action_fails";
  } else {
    accused = byId(s, s.pending.block.by);
    claimedRole = s.pending.block.role;
    provedCont = "block_stands";
    bluffCont = "resolve_action";
  }

  hostLog(`${challenger.name} challenges ${accused.name}'s ${claimedRole}!`);
  const idx = accused.cards.findIndex((c) => !c.revealed && c.role === claimedRole);

  if (idx >= 0) {
    // Proof: show the card, shuffle it back, draw a replacement, challenger loses a card
    hostLog(`${accused.name} shows ${claimedRole} — challenge fails. Card replaced.`);
    fx(s, `🛡 ${accused.name} really had ${claimedRole}!`);
    s.deck.push(claimedRole);
    shuffle(s.deck);
    accused.cards[idx] = { role: s.deck.pop(), revealed: false };
    s.continuation = provedCont;
    enqueueLoss(s, challenger.id, null /* continuation already set */);
  } else {
    hostLog(`${accused.name} was bluffing!`);
    fx(s, `🎭 BLUFF CALLED — ${accused.name} faked ${claimedRole}`);
    s.continuation = bluffCont;
    enqueueLoss(s, accused.id, null);
  }
  return true;
}

function blockSucceeds(s) {
  const actor = byId(s, s.pending.actorId);
  hostLog(`${actor.name}'s ${s.pending.action.replace("_", " ")} is blocked.`);
  endTurn(s);
}

/* ----- Losing influence ----- */

function enqueueLoss(s, pid, continuation) {
  if (continuation !== null && continuation !== undefined) s.continuation = continuation;
  s.lossQueue.push(pid);
  processLossQueue(s);
}

// Returns when either someone must choose (phase=lose_card) or the queue is empty
function processLossQueue(s) {
  while (s.lossQueue.length) {
    const pid = s.lossQueue[0];
    const p = byId(s, pid);
    if (!p || !isAlive(p)) { s.lossQueue.shift(); continue; }
    const hidden = p.cards.filter((c) => !c.revealed);
    if (hidden.length === 1) {
      const idx = p.cards.findIndex((c) => !c.revealed);
      revealCard(s, p, idx);
      s.lossQueue.shift();
      continue;
    }
    // Player must choose which card to give up
    s.phase = "lose_card";
    s.losingId = pid;
    armWindow(s, "decide");
    return false;
  }
  runContinuation(s);
  return true;
}

function doLose(s, pid, cardIndex) {
  if (s.phase !== "lose_card" || s.losingId !== pid) return false;
  const p = byId(s, pid);
  const card = p.cards[cardIndex];
  if (!card || card.revealed) return false;
  revealCard(s, p, cardIndex);
  continueAfterReveal(s);
  return true;
}

function continueAfterReveal(s) {
  s.lossQueue.shift();
  s.losingId = null;
  s.deadlineAt = null;
  processLossQueue(s);
}

function revealCard(s, p, idx) {
  p.cards[idx].revealed = true;
  hostLog(`${p.name} loses ${p.cards[idx].role}.`);
  if (!isAlive(p)) {
    hostLog(`${p.name} is out.`);
    fx(s, `☠ ${p.name} is OUT`);
  }
}

function runContinuation(s) {
  const cont = s.continuation;
  s.continuation = null;
  switch (cont) {
    case "resolve_action":
      resolveAction(s);
      break;
    case "post_challenge_block_window": {
      // The claim was proved; the target may still block (steal/assassinate)
      const { action, targetId } = s.pending;
      const spec = ACTIONS[action];
      const target = targetId ? byId(s, targetId) : null;
      if (spec.blockRoles.length && spec.targeted && target && isAlive(target)) {
        s.phase = "reaction";
        s.pending.canChallenge = false;
        s.pending.passes = [];
        armWindow(s, "reaction");
      } else {
        resolveAction(s);
      }
      break;
    }
    case "block_stands": {
      blockSucceeds(s);
      break;
    }
    case "action_fails":
      endTurn(s);
      break;
    case "end":
    default:
      endTurn(s);
  }
}

/* ----- Resolving actions ----- */

function resolveAction(s) {
  const { action, actorId, targetId } = s.pending;
  const actor = byId(s, actorId);
  const target = targetId ? byId(s, targetId) : null;
  s.deadlineAt = null;

  switch (action) {
    case "foreign_aid":
      actor.coins += 2;
      hostLog(`${actor.name} +2 → ${actor.coins} coins.`);
      endTurn(s);
      break;
    case "tax":
      actor.coins += 3;
      hostLog(`${actor.name} +3 → ${actor.coins} coins.`);
      endTurn(s);
      break;
    case "steal": {
      if (target && isAlive(target)) {
        const amt = Math.min(2, target.coins);
        target.coins -= amt;
        actor.coins += amt;
        hostLog(`${actor.name} steals ${amt} from ${target.name}.`);
      } else {
        hostLog(`The steal fizzles — no target left.`);
      }
      endTurn(s);
      break;
    }
    case "assassinate": {
      if (target && isAlive(target)) {
        hostLog(`The assassination lands.`);
        enqueueLoss(s, target.id, "end");
      } else {
        endTurn(s);
      }
      break;
    }
    case "exchange": {
      const drawn = [s.deck.pop(), s.deck.pop()];
      s.exchange = { playerId: actorId, drawn };
      s.phase = "exchange";
      armWindow(s, "decide");
      break;
    }
    default:
      endTurn(s);
  }
}

function doExchangeKeep(s, pid, keepIndices) {
  if (s.phase !== "exchange" || !s.exchange || s.exchange.playerId !== pid) return false;
  return finishExchange(s, keepIndices), true;
}

// keepIndices: indices into [hidden cards…, drawn cards…]; null → keep current hand
function finishExchange(s, keepIndices) {
  const p = byId(s, s.exchange.playerId);
  const hiddenIdxs = p.cards.map((c, i) => (!c.revealed ? i : -1)).filter((i) => i >= 0);
  const pool = [...hiddenIdxs.map((i) => p.cards[i].role), ...s.exchange.drawn];
  const keepCount = hiddenIdxs.length;

  let keep;
  if (Array.isArray(keepIndices) &&
      keepIndices.length === keepCount &&
      new Set(keepIndices).size === keepCount &&
      keepIndices.every((i) => Number.isInteger(i) && i >= 0 && i < pool.length)) {
    keep = keepIndices;
  } else {
    keep = hiddenIdxs.map((_, i) => i); // default / timeout: keep what you had
  }

  const kept = keep.map((i) => pool[i]);
  const returned = pool.filter((_, i) => !keep.includes(i));
  hiddenIdxs.forEach((cardIdx, j) => { p.cards[cardIdx] = { role: kept[j], revealed: false }; });
  s.deck.push(...returned);
  shuffle(s.deck);
  s.exchange = null;
  hostLog(`${p.name} exchanged cards.`);
  endTurn(s);
}

/* ----- Turn & win handling ----- */

function endTurn(s) {
  s.pending = null;
  s.exchange = null;
  s.losingId = null;
  s.lossQueue = [];
  s.continuation = null;
  s.deadlineAt = null;

  const alive = alivePlayers(s);
  if (alive.length === 1) {
    s.phase = "over";
    s.winnerId = alive[0].id;
    hostLog(`🏆 ${alive[0].name} wins!`);
    fx(s, `🏆 ${alive[0].name.toUpperCase()} WINS`);
    return;
  }

  let i = s.turnIdx;
  do { i = (i + 1) % s.players.length; } while (!isAlive(s.players[i]));
  s.turnIdx = i;
  s.phase = "action";
  const st = getSettings(s);
  if (st.turnSecs > 0) s.deadlineAt = Date.now() + st.turnSecs * 1000;
}

/* ============================================================
   7. RENDERING — every client renders from games.state
   ============================================================ */

function renderAll() {
  if (!configured) { showScreen("screen-config"); return; }
  if (!session.gameId) { showScreen("screen-landing"); return; }

  const g = session.game;
  if (g.status === "lobby") { renderLobby(); return; }
  maybeFx(g.state);
  renderGame(g.state);
}

/* ----- Big-moment overlay ----- */

let lastFxKey = 0;
let fxTimer = null;
function maybeFx(s) {
  if (!s || !s.fx || s.fx.key === lastFxKey) return;
  lastFxKey = s.fx.key;
  const overlay = $("fx-overlay");
  const card = $("fx-card");
  card.textContent = s.fx.text;
  card.classList.toggle("fx-big", s.fx.text.includes("🏆"));
  overlay.hidden = false;
  card.classList.remove("fx-pop");
  void card.offsetWidth; // restart the animation
  card.classList.add("fx-pop");
  clearTimeout(fxTimer);
  fxTimer = setTimeout(() => { overlay.hidden = true; }, 1900);
}

/* ----- Lobby ----- */

function renderLobby() {
  showScreen("screen-lobby");
  $("lobby-code").textContent = session.code;
  $("lobby-count").textContent = session.roster.length;

  const ul = $("lobby-players");
  ul.innerHTML = "";
  for (const p of session.roster) {
    const isHost = p.id === session.game.host_player_id;
    const isMe = p.id === session.playerId;
    ul.appendChild(el(`
      <li class="border border-line rounded-lg px-2.5 py-2 bg-panel flex items-center gap-2">
        ${avatarHtml(p.name, "w-6 h-6 text-xs")}
        <span class="font-bold truncate">${esc(p.name)}${isMe ? " (you)" : ""}</span>
        ${isHost ? `<span class="text-sun shrink-0 ml-auto" title="Host">★</span>` : ""}
      </li>`));
  }

  renderLobbySettings();

  $("lobby-host-controls").hidden = !session.isHost;
  $("lobby-wait-msg").hidden = session.isHost;
  if (session.isHost) {
    const ok = session.roster.length >= 2 && session.roster.length <= 6;
    $("btn-start").disabled = !ok;
  }
}

function renderLobbySettings() {
  const box = $("lobby-settings");
  box.innerHTML = "";
  const st = getSettings(session.game.state);
  box.appendChild(el(`<h3 class="text-sm font-bold text-dim mb-2">GAME SETTINGS${session.isHost ? "" : " <span class=\"font-normal\">(host picks)</span>"}</h3>`));

  for (const [key, opt] of Object.entries(SETTING_OPTIONS)) {
    const row = el(`<div class="flex items-center gap-2 mb-1.5"></div>`);
    row.appendChild(el(`<span class="text-sm text-dim w-28 shrink-0">${opt.label}</span>`));
    const valName = (v) => opt.names ? opt.names[v] : (v === 0 ? (opt.zeroName || "Off") : v + opt.unit);

    if (!session.isHost) {
      row.appendChild(el(`<span class="text-sm font-bold">${valName(st[key])}</span>`));
    } else {
      const group = el(`<div class="flex flex-wrap gap-1.5" role="group" aria-label="${opt.label}"></div>`);
      for (const v of opt.values) {
        const active = st[key] === v;
        const b = el(`<button type="button" aria-pressed="${active}"
          class="min-h-[34px] px-2.5 text-sm font-bold rounded-md border ${active ? "bg-sun text-ink border-sun" : "bg-card text-dim border-line hover:text-mist hover:border-mist"}">${valName(v)}</button>`);
        b.addEventListener("click", () => updateLobbySetting(key, v));
        group.appendChild(b);
      }
      row.appendChild(group);
    }
    box.appendChild(row);
  }
}

async function updateLobbySetting(key, value) {
  const cur = session.game.state || {};
  const settings = { ...getSettings(cur), [key]: value };
  await sb.from("games")
    .update({ state: { ...cur, settings } })
    .eq("id", session.gameId);
}

/* ----- Game ----- */

function renderGame(s) {
  showScreen("screen-game");
  if (!s || !s.players) return;

  const me = s.players.find((p) => p.id === session.playerId);
  const turnP = s.players[s.turnIdx];

  renderBanner(s, me, turnP);
  renderCountdown(s);
  renderDecisions(s, me);
  renderHand(s, me);
  renderTable(s, turnP);
}

function nameOf(s, id) { const p = byId(s, id); return p ? p.name : "?"; }
function youOr(s, id, capital = true) {
  if (id === session.playerId) return capital ? "You" : "you";
  return nameOf(s, id);
}

function renderBanner(s, me, turnP) {
  const b = $("turn-banner");
  let text = "";
  switch (s.phase) {
    case "action":
      text = turnP.id === session.playerId
        ? "▶ Your turn"
        : `${turnP.name} is choosing an action…`;
      break;
    case "reaction": {
      const { action, actorId, targetId, canChallenge } = s.pending;
      const phrase = actionPhrase(action, targetId ? youOr(s, targetId, false) : "");
      const tail = actorId === session.playerId
        ? " — waiting for reactions"
        : (canChallenge ? "" : "");
      text = `${youOr(s, actorId)} want${actorId === session.playerId ? "" : "s"} to ${phrase}${tail}`;
      break;
    }
    case "block_reaction": {
      const { block } = s.pending;
      text = `${youOr(s, block.by)} block${block.by === session.playerId ? "" : "s"} with ${block.role}`;
      break;
    }
    case "lose_card":
      text = s.losingId === session.playerId
        ? "Choose a card to lose"
        : `${nameOf(s, s.losingId)} is choosing a card to lose…`;
      break;
    case "exchange":
      text = s.exchange.playerId === session.playerId
        ? "Exchange — pick your cards"
        : `${nameOf(s, s.exchange.playerId)} is exchanging cards…`;
      break;
    case "over":
      text = `🏆 ${youOr(s, s.winnerId)} win${s.winnerId === session.playerId ? "" : "s"}!`;
      break;
  }
  b.textContent = text;
}

function renderCountdown(s) {
  const wrap = $("countdown-wrap");
  if (!s.deadlineAt || s.phase === "over") { wrap.hidden = true; return; }
  wrap.hidden = false;
  tickCountdown();
}

let countdownInterval = setInterval(tickCountdown, 250);
function tickCountdown() {
  const s = session.game && session.game.state;
  if (!s || !s.deadlineAt || $("countdown-wrap").hidden) return;
  const st = getSettings(s);
  const total = s.phase === "action" ? st.turnSecs
    : (s.phase === "lose_card" || s.phase === "exchange") ? st.decideSecs
    : st.reactionSecs;
  if (!total) return;
  const left = Math.max(0, Math.ceil((s.deadlineAt - Date.now()) / 1000));
  $("countdown-num").textContent = left;

  const ruler = $("countdown-ruler");
  if (ruler.childElementCount !== total) {
    ruler.innerHTML = "";
    for (let i = 0; i < total; i++) {
      ruler.appendChild(el(`<span class="tick h-1.5 flex-1 rounded-full bg-sun"></span>`));
    }
  }
  [...ruler.children].forEach((t, i) => { t.style.opacity = i < left ? "1" : "0.12"; });
}

/* ----- Decision buttons (two-step menus) ----- */

// A key that only changes when the *situation* changes (not on every state
// push), so keyboard focus isn't yanked away while someone is reading.
function promptSignature(s) {
  const p = s.pending;
  return [
    s.phase, s.turnIdx,
    p ? p.action : "", p && p.block ? p.block.role + p.block.by : "",
    p ? String(p.canChallenge) : "",
    s.losingId || "", s.exchange ? s.exchange.playerId : "",
  ].join("|");
}

// Local (per-client) menu navigation for the action picker.
const menu = { action: null, target: null };
function resetMenu() { menu.action = null; menu.target = null; }
function renavigate(s) {
  renderGame(s);
  const first = $("decision-buttons").querySelector("button");
  if (first) first.focus();
}

function renderDecisions(s, me) {
  const box = $("decision-buttons");
  box.innerHTML = "";
  box.className = "grid gap-2";
  const head = $("decision-h");

  if (!me) { head.textContent = "SPECTATING"; return; }
  if (!isAlive(me) && s.phase !== "over") {
    head.textContent = "YOU'RE OUT — WATCHING";
    return;
  }

  let promptKey = null;

  if (s.phase === "over") {
    head.textContent = "GAME OVER";
    if (session.isHost) {
      box.appendChild(button("Rematch — back to lobby", null, BTN_PRIMARY, async () => {
        const settings = getSettings(s);
        await sb.from("games").update({ status: "lobby", state: { settings } }).eq("id", session.gameId);
        session.hostState = null;
      }));
    }
    return;
  }

  if (s.phase === "action" && s.players[s.turnIdx].id === me.id) {
    promptKey = "action:" + promptSignature(s);
    if (promptKey !== session.lastPromptKey) resetMenu();
    renderActionMenu(s, me, box, head);
  }

  else if (s.phase === "reaction" || s.phase === "block_reaction") {
    const eligible = eligibleReactors(s);
    if (eligible.includes(me.id) && !s.pending.passes.includes(me.id)) {
      head.textContent = "RESPOND";
      promptKey = "react:" + promptSignature(s);
      const canCh = s.phase === "block_reaction" || s.pending.canChallenge;
      const armed = [];
      if (canCh) {
        armed.push(box.appendChild(button("⚡ Challenge", "call the bluff — loser gives up a card", BTN_DANGER,
          () => sendIntent({ type: "challenge" }))));
      }
      if (s.phase === "reaction" && canBlockNow(s, me.id)) {
        for (const role of ACTIONS[s.pending.action].blockRoles) {
          armed.push(box.appendChild(button(`${ROLE_SYMBOL[role]} Block as ${role}`, null, BTN_NEUTRAL,
            () => sendIntent({ type: "block", role }))));
        }
      }
      box.appendChild(button("Pass", "do nothing", BTN_NEUTRAL, () => sendIntent({ type: "pass" })));
      // Disable the committing buttons for a beat after the window opens, so a
      // tap aimed at the previous screen can't land on Challenge by accident.
      const openedAt = s.openedAt || (s.deadlineAt ? s.deadlineAt - getSettings(s).reactionSecs * 1000 : 0);
      const armIn = openedAt + ARM_DELAY_MS - Date.now();
      if (armIn > 0 && armed.length) {
        armed.forEach((b) => { b.disabled = true; b.classList.add("opacity-40"); });
        setTimeout(() => {
          armed.forEach((b) => {
            if (b.isConnected) { b.disabled = false; b.classList.remove("opacity-40"); }
          });
        }, armIn);
      }
    } else {
      head.textContent = eligible.includes(me.id) ? "PASSED — WAITING FOR OTHERS" : "WAITING…";
    }
  }

  else if (s.phase === "lose_card" && s.losingId === me.id) {
    head.textContent = "GIVE UP A CARD";
    promptKey = "lose:" + promptSignature(s);
    box.className = "grid grid-cols-2 gap-2";
    me.cards.forEach((c, i) => {
      if (c.revealed) return;
      box.appendChild(button(`${ROLE_SYMBOL[c.role]} ${c.role}`, "turn face up", BTN_DANGER,
        () => sendIntent({ type: "lose", cardIndex: i })));
    });
  }

  else if (s.phase === "exchange" && s.exchange && s.exchange.playerId === me.id) {
    head.textContent = "EXCHANGE — PICK CARDS TO KEEP";
    promptKey = "exchange:" + promptSignature(s);
    renderExchangePicker(s, me, box);
  }

  else {
    head.textContent = "WAITING…";
  }

  // Your-move state: glow the banner and animate the fresh prompt in
  const bannerBox = $("banner-box");
  if (bannerBox) {
    bannerBox.className = promptKey
      ? "mb-3 border-2 border-sun rounded-xl bg-panel px-3.5 py-2.5 transition-shadow shadow-[0_0_26px_rgba(255,214,10,0.16)]"
      : "mb-3 border-2 border-line rounded-xl bg-panel px-3.5 py-2.5 transition-shadow";
  }

  // Move keyboard focus to the first new prompt meant for this player
  if (promptKey && promptKey !== session.lastPromptKey) {
    session.lastPromptKey = promptKey;
    box.classList.add("rise");
    const first = box.querySelector("button");
    if (first) first.focus();
  } else if (!promptKey) {
    box.classList.remove("rise");
  }
}

// Step 1: pick an action · Step 2: pick a target · Step 3 (coup): guess a card
function renderActionMenu(s, me, box, head) {
  const mustCoup = me.coins >= 10;

  if (!menu.action) {
    head.textContent = mustCoup ? "10+ COINS — YOU MUST COUP" : "CHOOSE AN ACTION";
    box.className = "grid grid-cols-2 gap-2";
    const coupGuess = getSettings(s).coupGuess;
    for (const [key, spec] of Object.entries(ACTIONS)) {
      if (mustCoup && key !== "coup") continue;
      if (me.coins < spec.cost) continue;
      const cls = (key === "coup" || key === "assassinate" ? BTN_DANGER : BTN_NEUTRAL) + " !min-h-[60px] !text-lg";
      const sub = (key === "coup" && !coupGuess ? "pay 7 · they lose a card" : spec.sub) + (spec.targeted ? " ›" : "");
      box.appendChild(button(spec.label, sub, cls, () => {
        if (!spec.targeted) { sendIntent({ type: "action", action: key }); return; }
        menu.action = key;
        renavigate(s); // re-render into step 2
      }));
    }
    return;
  }

  const spec = ACTIONS[menu.action];

  if (!menu.target) {
    head.textContent = `${spec.label.toUpperCase()} — PICK A TARGET`;
    box.appendChild(button("‹ Back", null, BTN_BACK, () => { resetMenu(); renavigate(s); }));
    const targets = alivePlayers(s).filter((p) => p.id !== me.id && !(menu.action === "steal" && p.coins === 0));
    box.className = "grid gap-2";
    for (const t of targets) {
      const hidden = t.cards.filter((c) => !c.revealed).length;
      box.appendChild(button(t.name, `${t.coins} coins · ${hidden} card${hidden === 1 ? "" : "s"}`, BTN_NEUTRAL + " !min-h-[56px] !text-lg", () => {
        if (menu.action === "coup" && getSettings(s).coupGuess) { menu.target = t.id; renavigate(s); return; }
        sendIntent({ type: "action", action: menu.action, target: t.id });
        resetMenu();
      }));
    }
    return;
  }

  // Coup: guess one of the target's cards
  head.textContent = `COUP ${nameOf(s, menu.target).toUpperCase()} — GUESS A CARD`;
  box.appendChild(button("‹ Back", null, BTN_BACK, () => { menu.target = null; renavigate(s); }));
  const grid = el(`<div class="grid grid-cols-2 gap-2"></div>`);
  for (const role of ROLES) {
    grid.appendChild(button(`${ROLE_SYMBOL[role]} ${role}`, "right: they lose it · wrong: coup fails", BTN_DANGER + " !min-h-[56px] !text-lg", () => {
      sendIntent({ type: "action", action: "coup", target: menu.target, guess: role });
      resetMenu();
    }));
  }
  box.appendChild(grid);
}

function renderExchangePicker(s, me, box) {
  const hidden = me.cards.filter((c) => !c.revealed).map((c) => c.role);
  const pool = [...hidden, ...s.exchange.drawn];
  const keepCount = hidden.length;
  const picked = new Set();

  const grid = el(`<div class="grid grid-cols-2 gap-2"></div>`);
  const confirm = button(`Keep selected (0/${keepCount})`, null, BTN_PRIMARY, () => {
    if (picked.size !== keepCount) return;
    sendIntent({ type: "exchange_keep", keep: [...picked] });
  });
  confirm.disabled = true;
  confirm.classList.add("disabled:opacity-40");

  pool.forEach((role, i) => {
    const b = el(`
      <button type="button" aria-pressed="false"
        class="min-h-[48px] text-base font-bold bg-card text-mist border border-line rounded-lg px-3 py-2 text-left">
        <span aria-hidden="true">${ROLE_SYMBOL[role]}</span> ${role}
        <span class="block text-xs font-normal text-dim">${i < keepCount ? "yours" : "drawn"}</span>
      </button>`);
    b.addEventListener("click", () => {
      if (picked.has(i)) {
        picked.delete(i);
        b.setAttribute("aria-pressed", "false");
        b.className = b.className.replace("border-sun text-sun", "border-line text-mist");
      } else {
        if (picked.size >= keepCount) return;
        picked.add(i);
        b.setAttribute("aria-pressed", "true");
        b.className = b.className.replace("border-line text-mist", "border-sun text-sun");
      }
      confirm.disabled = picked.size !== keepCount;
      confirm.textContent = `Keep selected (${picked.size}/${keepCount})`;
    });
    grid.appendChild(b);
  });

  box.appendChild(grid);
  box.appendChild(confirm);
}

function nameHue(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
function avatarHtml(name, size) {
  const cls = size || "w-5 h-5 text-[10px]";
  return `<span class="inline-flex items-center justify-center ${cls} rounded-full font-bold text-ink shrink-0" style="background:hsl(${nameHue(name)} 62% 70%)" aria-hidden="true">${esc(String(name)[0].toUpperCase())}</span>`;
}

function button(label, sub, cls, onClick) {
  const b = el(`<button type="button" class="${cls}"></button>`);
  b.appendChild(document.createTextNode(label));
  if (sub) b.appendChild(el(`<span class="block text-xs font-normal opacity-75">${esc(sub)}</span>`));
  b.addEventListener("click", onClick);
  return b;
}

/* ----- Hand & table ----- */

function renderHand(s, me) {
  const ul = $("my-hand");
  ul.innerHTML = "";
  if (!me) { $("my-coins").textContent = "—"; return; }
  $("my-coins").textContent = me.coins;
  for (const c of me.cards) {
    ul.appendChild(el(`
      <li class="flex-1 border ${c.revealed ? "border-line opacity-50" : "border-sun/70 shadow-[0_0_16px_rgba(255,214,10,0.10)]"} rounded-lg bg-card px-3 py-2.5">
        <p class="text-base font-bold"><span aria-hidden="true">${ROLE_SYMBOL[c.role]}</span> ${c.role}</p>
        <p class="text-xs text-dim mt-0.5">${c.revealed ? "lost — face up" : "hidden"}</p>
      </li>`));
  }
}

function renderTable(s, turnP) {
  const ul = $("table-players");
  ul.innerHTML = "";
  for (const p of s.players) {
    const alive = isAlive(p);
    const isTurn = p.id === turnP.id && s.phase !== "over";
    const lost = p.cards.filter((c) => c.revealed).map((c) => ROLE_SYMBOL[c.role] + " " + c.role);
    const hiddenCount = p.cards.filter((c) => !c.revealed).length;
    const isMe = p.id === session.playerId;
    ul.appendChild(el(`
      <li class="border ${isTurn ? "border-sun shadow-[0_0_14px_rgba(255,214,10,0.12)]" : "border-line"} ${alive ? "" : "opacity-40 grayscale"} rounded-md bg-panel px-2 py-1.5">
        <p class="text-sm font-bold flex items-center gap-1.5">
          ${avatarHtml(p.name)}
          <span class="truncate">${esc(p.name)}${isMe ? " (you)" : ""}</span>
          ${isTurn ? `<span class="text-sun ml-auto shrink-0" aria-label="taking turn">▶</span>` : ""}
          ${alive ? "" : `<span class="text-alert text-[10px] font-bold ml-auto shrink-0">OUT</span>`}
        </p>
        <p class="text-xs text-dim mt-0.5">
          🜚 ${p.coins} · 🂠 ${hiddenCount}${lost.length ? ` · <span class="text-alert">${lost.join(", ")}</span>` : ""}
        </p>
      </li>`));
  }
}

/* ----- Log ----- */

function appendLog(message) {
  const ul = $("game-log");
  ul.appendChild(el(`<li class="leading-snug">${esc(message)}</li>`));
  while (ul.childElementCount > 150) ul.removeChild(ul.firstChild);
  ul.scrollTop = ul.scrollHeight;
  const latest = $("log-latest");
  if (latest) latest.textContent = "· " + (message.length > 48 ? message.slice(0, 47) + "…" : message);
}

/* ---------------- 8. Wiring ---------------- */

$("btn-create").addEventListener("click", createGame);
$("btn-join").addEventListener("click", joinGame);
$("join-code").addEventListener("keydown", (e) => { if (e.key === "Enter") joinGame(); });
$("player-name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("join-code").focus(); });
$("btn-start").addEventListener("click", () => sendIntent({ type: "start" }));

$("btn-guide").addEventListener("click", () => $("guide-dialog").showModal());
$("btn-guide-close").addEventListener("click", () => $("guide-dialog").close());
$("btn-howto").addEventListener("click", () => $("howto-dialog").showModal());
$("btn-howto-close").addEventListener("click", () => $("howto-dialog").close());
$("header-code").addEventListener("click", async () => {
  const chip = $("header-code");
  try {
    await navigator.clipboard.writeText(session.code);
    const code = session.code;
    chip.textContent = "Copied!";
    setTimeout(() => { chip.textContent = code; }, 1100);
  } catch { /* clipboard unavailable: the code is still visible/selectable */ }
});

window.addEventListener("beforeunload", () => {
  if (session.channel) sb.removeChannel(session.channel);
  if (session.dbChannel) sb.removeChannel(session.dbChannel);
});

renderAll();