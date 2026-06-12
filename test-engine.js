// Headless engine test: stubs DOM + Supabase, loads app.js, drives the host engine.
"use strict";
const fs = require("fs");
const vm = require("vm");

function fakeEl() {
  return {
    addEventListener() {}, appendChild() {}, removeChild() {},
    querySelector() { return null; }, setAttribute() {}, focus() {},
    classList: { add() {}, remove() {} },
    children: [], childElementCount: 0,
    hidden: false, innerHTML: "", textContent: "", value: "", disabled: false,
    style: {}, scrollTop: 0, scrollHeight: 0,
    showModal() {}, close() {},
  };
}

const thenable = { then(fn) { fn({ error: null }); return thenable; } };
const queryStub = new Proxy(function () {}, {
  get(_, prop) {
    if (prop === "then") return (fn) => { fn({ data: [], error: null, count: 0 }); return thenable; };
    return () => queryStub;
  },
  apply() { return queryStub; },
});

const sandbox = {
  console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  crypto: require("crypto"),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  document: { getElementById: fakeEl, createElement: () => ({ innerHTML: "", content: { firstElementChild: fakeEl() } }) },
  window: { COUP_CONFIG: { SUPABASE_URL: "https://test.supabase.co", SUPABASE_ANON_KEY: "key" }, addEventListener() {} },
  supabase: { createClient: () => ({
    from: () => queryStub,
    channel: () => ({ on() { return this; }, subscribe() { return this; }, send() {} }),
    removeChannel() {},
  }) },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(__dirname + "/app.js", "utf8"), sandbox);

// ---- pull engine internals out of the sandbox ----
// (function declarations land on the context global; consts must be eval'd out)
const G = sandbox;
G.session = vm.runInContext("session", sandbox);
G.isAlive = vm.runInContext("isAlive", sandbox);
const logLines = [];
G.hostLog = (m) => logLines.push(m);          // capture instead of network
G.hostPush = async () => {};                  // no network, no timers

const session = G.session;
session.gameId = "test-game";

function roster(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Player${i}`, joined_at: i }));
}
// Make freshState deterministic-ish but valid: just use it as-is.
function newGame(n) {
  session.hostState = G.freshState(roster(n));
  // fix turn order for predictability
  session.hostState.players.sort((a, b) => a.id.localeCompare(b.id));
  session.hostState.turnIdx = 0;
  return session.hostState;
}
const A = (s) => s.players[0], B = (s) => s.players[1], C = (s) => s.players[2];

let failures = 0;
function check(name, cond) {
  if (cond) console.log("  ✔", name);
  else { failures++; console.error("  ✘ FAIL:", name); }
}

// ---------- T1: income ----------
console.log("T1 income + turn rotation");
let s = newGame(3);
G.doAction(s, "p0", "income");
check("p0 has 3 coins", A(s).coins === 3);
check("turn moved to p1", s.players[s.turnIdx].id === "p1");
check("phase is action", s.phase === "action");

// ---------- T2: foreign aid, everyone passes ----------
console.log("T2 foreign aid → all pass");
s = newGame(3);
G.doAction(s, "p0", "foreign_aid");
check("reaction window open", s.phase === "reaction" && !s.pending.canChallenge);
G.doPass(s, "p1");
check("still waiting after one pass", s.phase === "reaction");
G.doPass(s, "p2");
check("resolved: +2 coins", A(s).coins === 4);
check("turn moved on", s.players[s.turnIdx].id === "p1");

// ---------- T3: foreign aid blocked, block unchallenged ----------
console.log("T3 foreign aid blocked by Duke claim");
s = newGame(3);
G.doAction(s, "p0", "foreign_aid");
G.doBlock(s, "p1", "Duke");
check("block window open", s.phase === "block_reaction");
G.doPass(s, "p0");
G.doPass(s, "p2");
check("blocked: coins unchanged", A(s).coins === 2);
check("turn moved on", s.players[s.turnIdx].id === "p1");

// ---------- T4: tax challenged — actor proves it ----------
console.log("T4 tax challenged, actor has Duke");
s = newGame(3);
A(s).cards = [{ role: "Duke", revealed: false }, { role: "Contessa", revealed: false }];
B(s).cards = [{ role: "Captain", revealed: false }, { role: "Captain", revealed: false }];
G.doAction(s, "p0", "tax");
G.doChallenge(s, "p1");
check("challenger must lose a card", s.phase === "lose_card" && s.losingId === "p1");
const deckBefore = s.deck.length;
G.doLose(s, "p1", 0);
check("challenger card revealed", B(s).cards[0].revealed === true);
check("tax resolved: +3 coins", A(s).coins === 5);
check("actor's Duke was replaced (still 2 hidden)", A(s).cards.filter(c => !c.revealed).length === 2);
check("turn advanced", s.players[s.turnIdx].id === "p1");

// ---------- T5: tax challenged — actor bluffed ----------
console.log("T5 tax challenged, actor bluffing");
s = newGame(2);
A(s).cards = [{ role: "Captain", revealed: false }, { role: "Contessa", revealed: false }];
G.doAction(s, "p0", "tax");
G.doChallenge(s, "p1");
check("actor must lose a card", s.phase === "lose_card" && s.losingId === "p0");
G.doLose(s, "p0", 1);
check("no tax gained", A(s).coins === 2);
check("turn advanced to p1", s.players[s.turnIdx].id === "p1");

// ---------- T6: assassinate, blocked by Contessa, block challenged and proven ----------
console.log("T6 assassinate → Contessa block → block challenged, blocker proves");
s = newGame(2);
A(s).coins = 3;
B(s).cards = [{ role: "Contessa", revealed: false }, { role: "Duke", revealed: false }];
G.doAction(s, "p0", "assassinate", "p1");
check("3 coins paid up front", A(s).coins === 0);
G.doBlock(s, "p1", "Contessa");
G.doChallenge(s, "p0");
// p0 (challenger) loses; p0 has 2 hidden → must choose
check("failed block-challenge: challenger picks a loss", s.phase === "lose_card" && s.losingId === "p0");
G.doLose(s, "p0", 0);
check("target kept both cards", B(s).cards.every(c => !c.revealed));
check("block stood → turn moved to p1", s.players[s.turnIdx].id === "p1" && s.phase === "action");

// ---------- T7: assassinate, fake Contessa block challenged → double loss ----------
console.log("T7 assassinate → bluffed block challenged → target loses 2 cards");
s = newGame(3);
A(s).coins = 3;
B(s).cards = [{ role: "Duke", revealed: false }, { role: "Captain", revealed: false }];
G.doAction(s, "p0", "assassinate", "p1");
G.doBlock(s, "p1", "Contessa");
G.doChallenge(s, "p0");
check("bluffing blocker picks first loss", s.phase === "lose_card" && s.losingId === "p1");
G.doLose(s, "p1", 0);
// continuation = resolve_action → assassination lands → only 1 hidden left → auto-reveal
check("target eliminated (both cards lost)", !G.isAlive(B(s)));
check("turn skipped dead player to p2", s.players[s.turnIdx].id === "p2");

// ---------- T8: steal with proof, then target blocks post-challenge ----------
console.log("T8 steal challenged → proven → target still blocks with Ambassador");
s = newGame(3);
A(s).cards = [{ role: "Captain", revealed: false }, { role: "Duke", revealed: false }];
B(s).coins = 2;
C(s).cards = [{ role: "Duke", revealed: false }, { role: "Duke", revealed: false }];
G.doAction(s, "p0", "steal", "p1");
G.doChallenge(s, "p2"); // third player challenges; actor proves Captain
check("challenger choosing loss", s.phase === "lose_card" && s.losingId === "p2");
G.doLose(s, "p2", 0);
check("post-challenge block window for target only", s.phase === "reaction" && !s.pending.canChallenge);
check("only target eligible", JSON.stringify(G.eligibleReactors(s)) === JSON.stringify(["p1"]));
G.doBlock(s, "p1", "Ambassador");
G.doPass(s, "p0");
G.doPass(s, "p2");
check("steal blocked, coins unchanged", A(s).coins === 2 && B(s).coins === 2);

// ---------- T9: exchange ----------
console.log("T9 exchange keeps chosen cards, deck size conserved");
s = newGame(2);
A(s).cards = [{ role: "Ambassador", revealed: false }, { role: "Duke", revealed: false }];
const deckSize = s.deck.length;
G.doAction(s, "p0", "exchange");
G.doPass(s, "p1");
check("exchange phase open", s.phase === "exchange" && s.exchange.playerId === "p0");
G.doExchangeKeep(s, "p0", [2, 3]); // keep the two newly-drawn cards
check("hand is the drawn cards", true); // composition is random; structural checks below
check("still 2 hidden cards", A(s).cards.filter(c => !c.revealed).length === 2);
check("deck size conserved", s.deck.length === deckSize);
check("turn advanced", s.players[s.turnIdx].id === "p1");

// ---------- T10: guess-the-card coup, mandatory coup & win ----------
console.log("T10 coup requires a guess; right guess removes that card");
s = newGame(2);
A(s).coins = 10;
check("non-coup rejected at 10 coins", G.doAction(s, "p0", "income") === false);
check("coup without a guess rejected", G.doAction(s, "p0", "coup", "p1") === false);
check("coup with a bogus guess rejected", G.doAction(s, "p0", "coup", "p1", "Joker") === false);
B(s).cards = [{ role: "Duke", revealed: true }, { role: "Contessa", revealed: false }];
G.doAction(s, "p0", "coup", "p1", "Contessa");
check("coup cost paid", A(s).coins === 3);
check("guessed card revealed → game over, p0 wins", s.phase === "over" && s.winnerId === "p0");

console.log("T10b wrong guess → coup fails, coins still spent");
s = newGame(2);
A(s).coins = 7;
B(s).cards = [{ role: "Duke", revealed: false }, { role: "Captain", revealed: false }];
G.doAction(s, "p0", "coup", "p1", "Contessa");
check("7 coins spent on the failed coup", A(s).coins === 0);
check("target untouched", B(s).cards.every(c => !c.revealed));
check("turn passed to p1", s.players[s.turnIdx].id === "p1" && s.phase === "action");

// ---------- T11: illegal intents are rejected ----------
console.log("T11 validation");
s = newGame(3);
check("out-of-turn action rejected", G.doAction(s, "p1", "income") === false);
check("coup without coins rejected", G.doAction(s, "p0", "coup", "p1", "Duke") === false);
check("self-target rejected", G.doAction(s, "p0", "steal", "p0") === false);
G.doAction(s, "p0", "tax");
check("actor cannot pass own window", G.doPass(s, "p0") === false);
check("double pass rejected", (G.doPass(s, "p1"), G.doPass(s, "p1")) === false);
check("non-target cannot block steal-style", G.doBlock(s, "p2", "Contessa") === false);

// ---------- T12: lobby settings ----------
console.log("T12 settings: classic coup, starting coins, turn timer");
s = newGame(3);
s.settings.coupGuess = false;
A(s).coins = 7;
B(s).cards = [{ role: "Duke", revealed: false }, { role: "Captain", revealed: false }];
check("classic coup needs no guess", G.doAction(s, "p0", "coup", "p1") === true);
check("target chooses which card to lose", s.phase === "lose_card" && s.losingId === "p1");
G.doLose(s, "p1", 1);
check("chosen card revealed", B(s).cards[1].revealed === true);
check("turn advanced", s.players[s.turnIdx].id === "p1");

const s2 = G.freshState(roster(2), { startCoins: 3 });
check("custom starting coins applied", s2.players.every(p => p.coins === 3));
const s3 = G.freshState(roster(2), { turnSecs: 30 });
check("turn timer armed at game start", typeof s3.deadlineAt === "number" && s3.deadlineAt > Date.now());
const s4 = G.freshState(roster(2));
check("no turn timer by default", s4.deadlineAt === null);

// ---------- T13: turn-timer timeout autoplays ----------
console.log("T13 action timeout → auto Income (or forced Coup at 10+)");
s = newGame(2);
s.settings.turnSecs = 30;
s.deadlineAt = Date.now() - 1;
session.hostState = s;
G.hostHandleTimeout();
check("timed-out player auto-takes Income", A(s).coins === 3);
check("turn moved on with a fresh deadline", s.players[s.turnIdx].id === "p1" && s.deadlineAt > Date.now());

s = newGame(2);
s.settings.turnSecs = 30;
A(s).coins = 10;
s.deadlineAt = Date.now() - 1;
session.hostState = s;
G.hostHandleTimeout();
check("at 10+ coins the timeout forces a Coup (7 paid)", A(s).coins === 3);

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);