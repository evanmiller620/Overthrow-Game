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

const REACTION_SECONDS = 15; // challenge / block window
const DECIDE_SECONDS   = 30; // pick a card to lose / exchange picks

// Room codes avoid lookalike glyphs (no 0/O, 1/I/L, 5/S, 8/B...kept B for brevity? no — drop them all)
const CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXYZ234679";

const ACTIONS = {
  income:      { label: "Income — take 1 coin",                       cost: 0, targeted: false, claim: null,         blockRoles: [] },
  foreign_aid: { label: "Foreign aid — take 2 coins",                 cost: 0, targeted: false, claim: null,         blockRoles: ["Duke"] },
  coup:        { label: "Coup — pay 7, target loses a card",          cost: 7, targeted: true,  claim: null,         blockRoles: [] },
  tax:         { label: "Tax — claim Duke, take 3 coins",             cost: 0, targeted: false, claim: "Duke",       blockRoles: [] },
  assassinate: { label: "Assassinate — claim Assassin, pay 3",        cost: 3, targeted: true,  claim: "Assassin",   blockRoles: ["Contessa"] },
  steal:       { label: "Steal — claim Captain, take 2 from a player",cost: 0, targeted: true,  claim: "Captain",    blockRoles: ["Captain", "Ambassador"] },
  exchange:    { label: "Exchange — claim Ambassador, swap cards",    cost: 0, targeted: false, claim: "Ambassador", blockRoles: [] },
};

function actionPhrase(action, targetName) {
  switch (action) {
    case "income":      return "take Income (1 coin)";
    case "foreign_aid": return "take Foreign aid (2 coins)";
    case "coup":        return `launch a Coup against ${targetName}`;
    case "tax":         return "take Tax as Duke (3 coins)";
    case "assassinate": return `assassinate ${targetName} (claiming Assassin)`;
    case "steal":       return `steal 2 coins from ${targetName} (claiming Captain)`;
    case "exchange":    return "exchange cards (claiming Ambassador)";
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

const BTN_PRIMARY = "min-h-[64px] w-full text-2xl font-bold bg-sun text-ink border-4 border-sun rounded-xl px-5 py-3 hover:brightness-110";
const BTN_NEUTRAL = "min-h-[64px] w-full text-2xl font-bold bg-panel text-mist border-4 border-mist rounded-xl px-5 py-3 hover:bg-line/40";
const BTN_DANGER  = "min-h-[64px] w-full text-2xl font-bold bg-panel text-alert border-4 border-alert rounded-xl px-5 py-3 hover:bg-line/40";

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

function freshState(rosterRows) {
  const deck = shuffle(ROLES.flatMap((r) => [r, r, r])); // 15 cards
  const order = shuffle([...rosterRows]);
  const players = order.map((row) => ({
    id: row.id,
    name: row.name,
    coins: 2,
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
    deadlineAt: null,
    winnerId: null,
    gen: 0,
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
    case "reaction":
      hostLog("Time is up — no one reacted.");
      resolveAction(s);
      break;
    case "block_reaction":
      hostLog("Time is up — the block stands.");
      blockSucceeds(s);
      break;
    case "lose_card": {
      const p = byId(s, s.losingId);
      const idx = p.cards.findIndex((c) => !c.revealed);
      hostLog(`Time is up — ${p.name} loses a card automatically.`);
      revealCard(s, p, idx);
      continueAfterReveal(s);
      break;
    }
    case "exchange": {
      hostLog("Time is up — the exchange keeps the original cards.");
      finishExchange(s, null); // null → keep current hand
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
    session.hostState = freshState(session.roster);
    const s = session.hostState;
    hostLog(`Game started with ${s.players.length} players. Turn order: ${s.players.map((p) => p.name).join(", ")}.`);
    hostLog(`It is ${currentPlayer(s).name}'s turn.`);
    hostPush();
    return;
  }

  const s = session.hostState;
  if (!s || s.phase === "over") return;
  const actor = byId(s, from);
  if (!actor || !isAlive(actor)) return;

  let changed = false;
  switch (type) {
    case "action":        changed = doAction(s, from, intent.action, intent.target); break;
    case "pass":          changed = doPass(s, from); break;
    case "challenge":     changed = doChallenge(s, from); break;
    case "block":         changed = doBlock(s, from, intent.role); break;
    case "lose":          changed = doLose(s, from, intent.cardIndex); break;
    case "exchange_keep": changed = doExchangeKeep(s, from, intent.keep); break;
  }
  if (changed) hostPush();
}

/* ----- Action declaration ----- */

function doAction(s, pid, action, targetId) {
  if (s.phase !== "action") return false;
  if (currentPlayer(s).id !== pid) return false;
  const spec = ACTIONS[action];
  if (!spec) return false;
  const actor = byId(s, pid);

  if (actor.coins >= 10 && action !== "coup") return false;     // mandatory coup
  if (actor.coins < spec.cost) return false;

  let target = null;
  if (spec.targeted) {
    target = byId(s, targetId);
    if (!target || target.id === pid || !isAlive(target)) return false;
    if (action === "steal" && target.coins === 0) return false;
  }

  actor.coins -= spec.cost; // costs are paid on declaration and are not refunded

  if (action === "income") {
    actor.coins += 1;
    hostLog(`${actor.name} takes Income (+1 coin, now ${actor.coins}).`);
    endTurn(s);
    return true;
  }

  if (action === "coup") {
    hostLog(`${actor.name} pays 7 coins to launch a Coup against ${target.name}. It cannot be blocked.`);
    enqueueLoss(s, target.id, "end");
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
  s.deadlineAt = Date.now() + REACTION_SECONDS * 1000;

  const phrase = actionPhrase(action, target ? target.name : "");
  if (spec.claim) hostLog(`${actor.name} wants to ${phrase}. ${REACTION_SECONDS} seconds to challenge${spec.blockRoles.length ? " or block" : ""}.`);
  else hostLog(`${actor.name} wants to ${phrase}. ${REACTION_SECONDS} seconds to block.`);
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
    if (s.phase === "reaction") {
      hostLog("Everyone passed.");
      resolveAction(s);
    } else {
      hostLog("Everyone passed — the block stands.");
      blockSucceeds(s);
    }
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
  s.deadlineAt = Date.now() + REACTION_SECONDS * 1000;
  hostLog(`${blocker.name} claims ${role} to block. ${REACTION_SECONDS} seconds to challenge.`);
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

  hostLog(`${challenger.name} challenges ${accused.name}'s claim of ${claimedRole}!`);
  const idx = accused.cards.findIndex((c) => !c.revealed && c.role === claimedRole);

  if (idx >= 0) {
    // Proof: show the card, shuffle it back, draw a replacement, challenger loses a card
    hostLog(`${accused.name} reveals ${claimedRole} — the challenge fails. The card is shuffled back and replaced.`);
    s.deck.push(claimedRole);
    shuffle(s.deck);
    accused.cards[idx] = { role: s.deck.pop(), revealed: false };
    s.continuation = provedCont;
    enqueueLoss(s, challenger.id, null /* continuation already set */);
  } else {
    hostLog(`${accused.name} was bluffing and does not show ${claimedRole}.`);
    s.continuation = bluffCont;
    enqueueLoss(s, accused.id, null);
  }
  return true;
}

function blockSucceeds(s) {
  const { action, actorId } = s.pending;
  const actor = byId(s, actorId);
  hostLog(`${actor.name}'s ${action.replace("_", " ")} is blocked and has no effect.`);
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
    s.deadlineAt = Date.now() + DECIDE_SECONDS * 1000;
    hostLog(`${p.name} must choose a card to lose (${DECIDE_SECONDS} seconds).`);
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
  hostLog(`${p.name} loses influence and turns ${p.cards[idx].role} face up.`);
  if (!isAlive(p)) hostLog(`${p.name} has no influence left and is out of the game.`);
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
        s.deadlineAt = Date.now() + REACTION_SECONDS * 1000;
        hostLog(`${target.name} may still block (${spec.blockRoles.join(" or ")}). ${REACTION_SECONDS} seconds.`);
      } else {
        resolveAction(s);
      }
      break;
    }
    case "block_stands": {
      blockSucceeds(s);
      break;
    }
    case "action_fails": {
      const actor = byId(s, s.pending ? s.pending.actorId : null) || currentPlayer(s);
      hostLog(`${actor.name}'s action fails.`);
      endTurn(s);
      break;
    }
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
      hostLog(`${actor.name} takes Foreign aid (+2 coins, now ${actor.coins}).`);
      endTurn(s);
      break;
    case "tax":
      actor.coins += 3;
      hostLog(`${actor.name} takes Tax (+3 coins, now ${actor.coins}).`);
      endTurn(s);
      break;
    case "steal": {
      if (target && isAlive(target)) {
        const amt = Math.min(2, target.coins);
        target.coins -= amt;
        actor.coins += amt;
        hostLog(`${actor.name} steals ${amt} coin${amt === 1 ? "" : "s"} from ${target.name}.`);
      } else {
        hostLog(`The steal has no target left and fizzles.`);
      }
      endTurn(s);
      break;
    }
    case "assassinate": {
      if (target && isAlive(target)) {
        hostLog(`The assassination of ${target.name} goes through.`);
        enqueueLoss(s, target.id, "end");
      } else {
        hostLog(`The assassination target is already out; nothing happens.`);
        endTurn(s);
      }
      break;
    }
    case "exchange": {
      const drawn = [s.deck.pop(), s.deck.pop()];
      s.exchange = { playerId: actorId, drawn };
      s.phase = "exchange";
      s.deadlineAt = Date.now() + DECIDE_SECONDS * 1000;
      hostLog(`${actor.name} draws 2 cards for the Exchange and is choosing what to keep (${DECIDE_SECONDS} seconds).`);
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
  hostLog(`${p.name} finishes the Exchange and returns 2 cards to the deck.`);
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
    hostLog(`${alive[0].name} wins the game! 🏆`);
    return;
  }

  let i = s.turnIdx;
  do { i = (i + 1) % s.players.length; } while (!isAlive(s.players[i]));
  s.turnIdx = i;
  s.phase = "action";
  const p = currentPlayer(s);
  hostLog(`It is ${p.name}'s turn.${p.coins >= 10 ? " They have 10+ coins and must Coup." : ""}`);
}

/* ============================================================
   7. RENDERING — every client renders from games.state
   ============================================================ */

function renderAll() {
  if (!configured) { showScreen("screen-config"); return; }
  if (!session.gameId) { showScreen("screen-landing"); return; }

  const g = session.game;
  if (g.status === "lobby") { renderLobby(); return; }
  renderGame(g.state);
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
      <li class="border-4 border-line rounded-xl px-4 py-3 bg-panel flex justify-between gap-3">
        <span class="font-bold">${esc(p.name)}${isMe ? " (you)" : ""}</span>
        <span>${isHost ? "★ Host" : ""}</span>
      </li>`));
  }

  $("lobby-host-controls").hidden = !session.isHost;
  $("lobby-wait-msg").hidden = session.isHost;
  if (session.isHost) {
    const ok = session.roster.length >= 2 && session.roster.length <= 6;
    $("btn-start").disabled = !ok;
  }
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
        ? "Your turn — choose an action below."
        : `${turnP.name}'s turn — they are choosing an action.`;
      break;
    case "reaction": {
      const { action, actorId, targetId, canChallenge } = s.pending;
      const phrase = actionPhrase(action, targetId ? youOr(s, targetId, false) : "");
      const opts = actorId === session.playerId
        ? "Waiting to see if anyone reacts."
        : (canChallenge ? "Challenge or block now, or pass." : "Block now, or pass.");
      text = `${youOr(s, actorId)} want${actorId === session.playerId ? "" : "s"} to ${phrase}. ${opts}`;
      break;
    }
    case "block_reaction": {
      const { block } = s.pending;
      text = `${youOr(s, block.by)} claim${block.by === session.playerId ? "" : "s"} ${block.role} to block. Challenge or pass.`;
      break;
    }
    case "lose_card":
      text = s.losingId === session.playerId
        ? "You must choose one of your cards to lose."
        : `${nameOf(s, s.losingId)} is choosing a card to lose.`;
      break;
    case "exchange":
      text = s.exchange.playerId === session.playerId
        ? "Exchange: choose which cards to keep."
        : `${nameOf(s, s.exchange.playerId)} is exchanging cards.`;
      break;
    case "over":
      text = `Game over — ${youOr(s, s.winnerId)} win${s.winnerId === session.playerId ? "" : "s"}! 🏆`;
      break;
  }
  b.textContent = text;
}

function renderCountdown(s) {
  const wrap = $("countdown-wrap");
  if (!s.deadlineAt || s.phase === "over") { wrap.hidden = true; return; }
  wrap.hidden = false;
  tickCountdown(); // immediate paint; interval keeps it fresh
}

let countdownInterval = setInterval(tickCountdown, 250);
function tickCountdown() {
  const s = session.game && session.game.state;
  if (!s || !s.deadlineAt || $("countdown-wrap").hidden) return;
  const total = (s.phase === "lose_card" || s.phase === "exchange") ? DECIDE_SECONDS : REACTION_SECONDS;
  const left = Math.max(0, Math.ceil((s.deadlineAt - Date.now()) / 1000));
  $("countdown-num").textContent = left;

  const ruler = $("countdown-ruler");
  if (ruler.childElementCount !== total) {
    ruler.innerHTML = "";
    for (let i = 0; i < total; i++) {
      ruler.appendChild(el(`<span class="tick h-5 flex-1 rounded-sm bg-sun"></span>`));
    }
  }
  [...ruler.children].forEach((t, i) => { t.style.opacity = i < left ? "1" : "0.15"; });
}

/* ----- Decision buttons ----- */


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

function renderDecisions(s, me) {
  const box = $("decision-buttons");
  box.innerHTML = "";
  const head = $("decision-h");

  if (!me) { head.textContent = "You are spectating"; return; }
  if (!isAlive(me) && s.phase !== "over") {
    head.textContent = "You are out of the game — watching";
    return;
  }

  let promptKey = null;

  if (s.phase === "over") {
    head.textContent = "Game over";
    if (session.isHost) {
      box.appendChild(button("Back to lobby for a rematch", BTN_PRIMARY, async () => {
        await sb.from("games").update({ status: "lobby", state: {} }).eq("id", session.gameId);
        session.hostState = null;
      }));
    }
    return;
  }

  if (s.phase === "action" && s.players[s.turnIdx].id === me.id) {
    head.textContent = "Your turn — choose an action";
    promptKey = "action:" + promptSignature(s);
    const mustCoup = me.coins >= 10;
    for (const [key, spec] of Object.entries(ACTIONS)) {
      if (mustCoup && key !== "coup") continue;
      if (me.coins < spec.cost) continue;
      if (!spec.targeted) {
        box.appendChild(button(spec.label, key === "coup" ? BTN_DANGER : BTN_PRIMARY,
          () => sendIntent({ type: "action", action: key })));
      } else {
        const targets = alivePlayers(s).filter((p) => p.id !== me.id && !(key === "steal" && p.coins === 0));
        for (const t of targets) {
          box.appendChild(button(`${spec.label} → ${t.name}`,
            key === "coup" || key === "assassinate" ? BTN_DANGER : BTN_PRIMARY,
            () => sendIntent({ type: "action", action: key, target: t.id })));
        }
      }
    }
    if (mustCoup) box.appendChild(el(`<p class="text-xl font-bold text-alert">You have 10 or more coins, so you must Coup.</p>`));
  }

  else if (s.phase === "reaction" || s.phase === "block_reaction") {
    const eligible = eligibleReactors(s);
    if (eligible.includes(me.id) && !s.pending.passes.includes(me.id)) {
      head.textContent = "Respond now";
      promptKey = "react:" + promptSignature(s);
      const canCh = s.phase === "block_reaction" || s.pending.canChallenge;
      if (canCh) {
        box.appendChild(button("⚡ Challenge — call the bluff", BTN_DANGER, () => sendIntent({ type: "challenge" })));
      }
      if (s.phase === "reaction" && canBlockNow(s, me.id)) {
        for (const role of ACTIONS[s.pending.action].blockRoles) {
          box.appendChild(button(`${ROLE_SYMBOL[role]} Block — claim ${role}`, BTN_NEUTRAL,
            () => sendIntent({ type: "block", role })));
        }
      }
      box.appendChild(button("Pass — do nothing", BTN_NEUTRAL, () => sendIntent({ type: "pass" })));
    } else {
      head.textContent = eligible.includes(me.id) ? "You passed — waiting for others" : "Waiting for other players";
    }
  }

  else if (s.phase === "lose_card" && s.losingId === me.id) {
    head.textContent = "Choose a card to lose (it turns face up)";
    promptKey = "lose:" + promptSignature(s);
    me.cards.forEach((c, i) => {
      if (c.revealed) return;
      box.appendChild(button(`Give up ${ROLE_SYMBOL[c.role]} ${c.role}`, BTN_DANGER,
        () => sendIntent({ type: "lose", cardIndex: i })));
    });
  }

  else if (s.phase === "exchange" && s.exchange && s.exchange.playerId === me.id) {
    head.textContent = "Exchange — pick the cards to keep";
    promptKey = "exchange:" + promptSignature(s);
    renderExchangePicker(s, me, box);
  }

  else {
    head.textContent = "Waiting for other players";
  }

  // Move keyboard focus to the first new prompt meant for this player
  if (promptKey && promptKey !== session.lastPromptKey) {
    session.lastPromptKey = promptKey;
    const first = box.querySelector("button");
    if (first) first.focus();
  }
}

function renderExchangePicker(s, me, box) {
  const hidden = me.cards.filter((c) => !c.revealed).map((c) => c.role);
  const pool = [...hidden, ...s.exchange.drawn];
  const keepCount = hidden.length;
  const picked = new Set();

  const info = el(`<p class="text-xl">Select exactly <strong>${keepCount}</strong> card${keepCount === 1 ? "" : "s"} to keep. The rest go back to the deck.</p>`);
  box.appendChild(info);

  const grid = el(`<div class="grid grid-cols-1 sm:grid-cols-2 gap-3"></div>`);
  const confirm = button(`Keep selected (0 of ${keepCount})`, BTN_PRIMARY, () => {
    if (picked.size !== keepCount) return;
    sendIntent({ type: "exchange_keep", keep: [...picked] });
  });
  confirm.disabled = true;
  confirm.classList.add("disabled:opacity-40");

  pool.forEach((role, i) => {
    const b = el(`
      <button type="button" aria-pressed="false"
        class="min-h-[64px] text-2xl font-bold bg-panel text-mist border-4 border-mist rounded-xl px-4 py-3 text-left">
        <span aria-hidden="true">${ROLE_SYMBOL[role]}</span> ${role}
        <span class="block text-lg font-normal">${i < keepCount ? "from your hand" : "newly drawn"}</span>
      </button>`);
    b.addEventListener("click", () => {
      if (picked.has(i)) {
        picked.delete(i);
        b.setAttribute("aria-pressed", "false");
        b.className = b.className.replace("border-sun text-sun", "border-mist text-mist");
      } else {
        if (picked.size >= keepCount) return;
        picked.add(i);
        b.setAttribute("aria-pressed", "true");
        b.className = b.className.replace("border-mist text-mist", "border-sun text-sun");
      }
      confirm.disabled = picked.size !== keepCount;
      confirm.textContent = `Keep selected (${picked.size} of ${keepCount})`;
    });
    grid.appendChild(b);
  });

  box.appendChild(grid);
  box.appendChild(confirm);
}

function button(label, cls, onClick) {
  const b = el(`<button type="button" class="${cls}"></button>`);
  b.textContent = label;
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
      <li class="border-4 ${c.revealed ? "border-line opacity-60" : "border-sun"} rounded-xl bg-panel px-4 py-5">
        <p class="text-2xl font-bold"><span aria-hidden="true">${ROLE_SYMBOL[c.role]}</span> ${c.role}</p>
        <p class="text-lg mt-1">${c.revealed ? "LOST — face up for everyone" : "Hidden — only you can see this"}</p>
      </li>`));
  }
}

function renderTable(s, turnP) {
  const ul = $("table-players");
  ul.innerHTML = "";
  for (const p of s.players) {
    const alive = isAlive(p);
    const isTurn = p.id === turnP.id && s.phase !== "over";
    const revealed = p.cards.filter((c) => c.revealed).map((c) => `${ROLE_SYMBOL[c.role]} ${c.role}`);
    const hiddenCount = p.cards.filter((c) => !c.revealed).length;
    const isMe = p.id === session.playerId;
    ul.appendChild(el(`
      <li class="border-4 ${isTurn ? "border-sun" : "border-line"} ${alive ? "" : "opacity-60"} rounded-xl bg-panel px-4 py-3">
        <p class="text-2xl font-bold flex flex-wrap gap-x-3">
          <span>${esc(p.name)}${isMe ? " (you)" : ""}</span>
          ${isTurn ? `<span class="text-sun">◀ taking turn</span>` : ""}
          ${alive ? "" : `<span class="text-alert">OUT</span>`}
        </p>
        <p class="text-xl mt-1">
          Coins: <strong>${p.coins}</strong> ·
          Hidden cards: <strong>${hiddenCount}</strong>
          ${revealed.length ? `· Lost: ${revealed.join(", ")}` : ""}
        </p>
      </li>`));
  }
}

/* ----- Log ----- */

function appendLog(message) {
  const ul = $("game-log");
  ul.appendChild(el(`<li class="border-b-2 border-line/60 pb-2">${esc(message)}</li>`));
  while (ul.childElementCount > 200) ul.removeChild(ul.firstChild);
  ul.scrollTop = ul.scrollHeight;
}

/* ---------------- 8. Wiring ---------------- */

$("btn-create").addEventListener("click", createGame);
$("btn-join").addEventListener("click", joinGame);
$("join-code").addEventListener("keydown", (e) => { if (e.key === "Enter") joinGame(); });
$("player-name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("join-code").focus(); });
$("btn-start").addEventListener("click", () => sendIntent({ type: "start" }));

$("btn-guide").addEventListener("click", () => $("guide-dialog").showModal());
$("btn-guide-close").addEventListener("click", () => $("guide-dialog").close());

window.addEventListener("beforeunload", () => {
  if (session.channel) sb.removeChannel(session.channel);
  if (session.dbChannel) sb.removeChannel(session.dbChannel);
});

renderAll();
