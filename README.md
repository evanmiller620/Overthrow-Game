# Coup — Accessible Online Multiplayer

A lightweight, low-vision-friendly web implementation of the card game **Coup** for 2–6 players.
No build step, no server to run: static files on **GitHub Pages** + **Supabase** for realtime sync.

```
index.html            UI shell (semantic HTML, Tailwind theme, card guide dialog)
app.js                Lobby, rendering, Realtime sync, and the host-driven game engine
config.js             Your Supabase URL + anon key (the only file you must edit)
supabase-schema.sql   Database tables, Realtime publication, RLS policies
test-engine.js        Headless engine tests (optional): node test-engine.js
```

---

## 1. Set up Supabase (≈5 minutes)

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** → paste the entire contents of `supabase-schema.sql` → **Run**.
3. Go to **Project Settings → API** and copy:
   - the **Project URL**
   - the **anon / public** key
4. Paste both into `config.js`. (The anon key is designed to be public in a static site.)

## 2. Run locally

Any static server works — for example:

```bash
npx serve .        # or: python3 -m http.server 8080
```

Open the printed URL in Chrome. Open it in two windows to play against yourself.

## 3. Deploy to GitHub Pages

1. Push these files to a GitHub repository (root or `/docs` folder).
2. Repo → **Settings → Pages** → Source: *Deploy from a branch* → pick the branch/folder.
3. Your game is live at `https://<user>.github.io/<repo>/`. Share that link plus the room code.

Everything is loaded from CDNs (Tailwind Play CDN, Supabase JS, Google Fonts), so there is
nothing to compile. If you later want a production-grade Tailwind build, the classes used
here port directly into a Vite + Tailwind CLI setup.

---

## How a game flows

1. **Create game** → a 4-character room code (lookalike letters like O/0 and I/1 are excluded).
2. Friends **Join** with the code. The host presses **Start game** with 2–6 players.
3. On your turn, pick an action. Role actions open a **15-second window** where other
   players can **Challenge** or **Block** — it ends early as soon as everyone has passed,
   otherwise the action resolves automatically when time runs out, and play moves on.
4. Choosing a card to lose, and Ambassador exchanges, have a 30-second window with a
   sensible automatic fallback so one absent player can never freeze the game.
5. Last player with a hidden card wins. The host gets a one-click **rematch** button.

Refreshing the page? Re-enter the same room code from the same browser and you resume
your seat (identity is kept in `localStorage` per room).

## Architecture: who is in charge?

You chose the **host-driven, semi-trusted** model:

- The **host's browser** is the single authoritative engine. Players broadcast *intents*
  (`action`, `challenge`, `block`, `pass`, `lose`, `exchange_keep`) over a Supabase
  Realtime channel. Only the host validates them and writes the new state to
  `games.state`. Every client — host included — renders exclusively from
  `postgres_changes` UPDATE events on that row, so there is exactly one source of truth
  and no write conflicts.
- The host also runs the **clock**: every deadline (`deadlineAt` in the state) is
  enforced by the host with a timeout that resolves the window if it expires.
- The host must keep their tab open. If the host refreshes, the engine rehydrates from
  the database and re-arms the clock automatically.

**Honest-player caveat:** because there is no server-side engine, the full state
(including everyone's hidden cards) is technically readable through the API by a
determined player. The UI never shows them, but this is *privacy by convention*, not
cryptography — exactly the trade-off of the "semi-trusted" choice. The schema and the
intent protocol were designed so you can later move the engine into Postgres functions
(RPC) for true RLS-enforced secrecy without changing the tables or the client flow.

Known limitations (kept deliberately simple):
- No host migration — if the host closes the tab mid-game, the game stalls.
- The lobby list shows who has *joined*, not who is currently connected.
- Action costs (Assassinate's 3 coins, Coup's 7) are paid on declaration and are not
  refunded, even if the action is blocked or successfully challenged.

## Accessibility (WCAG AAA targets)

- **Contrast:** charcoal `#121214` background with `#F5F5F2` text (≈17:1) and `#FFD60A`
  accents (≈12.6:1); the danger/success tints also clear the 7:1 AAA threshold.
- **Never color-only:** turn state, eliminations, blocks, and the countdown are always
  expressed in words and symbols ("◀ taking turn", "OUT", a numeral beside the timer
  ruler), not just color.
- **Type:** Atkinson Hyperlegible (designed by the Braille Institute), root size 18px,
  all interactive text 24px+, thick 4px borders, 64px+ touch targets.
- **Keyboard & screen readers:** semantic `<main>/<section>/<button>` structure, a skip
  link, a native `<dialog>` card guide (focus-trapped, Esc closes), `role="status"` turn
  banner and an `aria-live` game log, and a visible 4px focus outline everywhere. When a
  decision is required of *you*, focus moves to your first option — and only then, so
  focus is never stolen while you're reading.
- **Zoom & responsive:** a single fluid column that holds together on mobile and at
  200% browser zoom; `prefers-reduced-motion` disables the countdown animation.

## Testing the rules engine

The whole engine is exercised headlessly (no browser, no network):

```bash
node test-engine.js
```

It covers turn rotation, all-pass and timeout resolution, proven and bluffed challenges,
blocks, challenge-the-block, the double-loss assassination case, post-challenge block
windows, exchanges with deck conservation, mandatory Coup at 10+ coins, win detection,
and rejection of illegal intents.
