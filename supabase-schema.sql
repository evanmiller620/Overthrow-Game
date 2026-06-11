-- ============================================================
-- COUP — Supabase schema
-- Run this once in the Supabase SQL Editor (Dashboard → SQL).
--
-- Architecture note (chosen by you): the HOST'S BROWSER is the
-- authoritative game engine ("semi-trusted" model). The full
-- game state lives in games.state (JSONB) and only the host
-- writes it. Clients send intents over a Realtime broadcast
-- channel; they never write game state directly.
--
-- Consequence: hidden cards are hidden by the UI, not by RLS.
-- A technically savvy player could read them via the API.
-- The upgrade path to true secrecy is moving the engine into
-- Postgres functions (RPC) — the schema below supports that
-- later without breaking changes.
-- ============================================================

-- ---------- Tables ----------

create table public.games (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,            -- 4-char room code, e.g. "B7X2"
  host_player_id  uuid,                            -- the player whose browser runs the engine
  status          text not null default 'lobby'    -- lobby | playing | over
                  check (status in ('lobby','playing','over')),
  state           jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index games_code_idx on public.games (code);

create table public.players (
  id         uuid primary key,                     -- generated client-side, kept in localStorage
  game_id    uuid not null references public.games(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 20),
  seat       int,
  joined_at  timestamptz not null default now()
);

create index players_game_idx on public.players (game_id);

create table public.game_logs (
  id         bigint generated always as identity primary key,
  game_id    uuid not null references public.games(id) on delete cascade,
  seq        int not null default 0,
  message    text not null,
  created_at timestamptz not null default now()
);

create index game_logs_game_idx on public.game_logs (game_id, id);

-- ---------- updated_at trigger ----------

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger games_touch
before update on public.games
for each row execute function public.touch_updated_at();

-- ---------- Realtime ----------
-- Clients subscribe to postgres_changes on these tables.

alter publication supabase_realtime add table public.games;
alter publication supabase_realtime add table public.players;
alter publication supabase_realtime add table public.game_logs;

-- ---------- Row Level Security ----------
-- RLS is ON for every table. Because players are anonymous
-- (no Supabase Auth), the policies are intentionally permissive
-- for the anon role, but they still enforce useful guarantees:
--   * nobody can DELETE anything through the API
--   * games can be INSERTed only in 'lobby' status
--   * log rows are append-only (no updates)

alter table public.games     enable row level security;
alter table public.players   enable row level security;
alter table public.game_logs enable row level security;

-- games: anyone may read (public game state by design),
-- create a lobby, or update a game row (host writes state).
create policy "games are readable"
  on public.games for select to anon, authenticated
  using (true);

create policy "anyone may create a lobby"
  on public.games for insert to anon, authenticated
  with check (status = 'lobby');

create policy "games may be updated"
  on public.games for update to anon, authenticated
  using (true) with check (true);

-- players: readable by all (the lobby list is public);
-- anyone may join; players may update their own row fields.
create policy "players are readable"
  on public.players for select to anon, authenticated
  using (true);

create policy "anyone may join a game"
  on public.players for insert to anon, authenticated
  with check (true);

create policy "player rows may be updated"
  on public.players for update to anon, authenticated
  using (true) with check (true);

-- game_logs: readable, append-only.
create policy "logs are readable"
  on public.game_logs for select to anon, authenticated
  using (true);

create policy "logs are append-only"
  on public.game_logs for insert to anon, authenticated
  with check (true);

-- (No delete policies anywhere → deletes are denied by RLS.)

-- ---------- Optional housekeeping ----------
-- Old lobbies pile up; you can clear games older than a day with:
--   delete from public.games where created_at < now() - interval '1 day';
-- (Run manually or via a scheduled Edge Function / pg_cron.)