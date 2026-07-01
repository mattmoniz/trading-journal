# CLAUDE.md

Trading journal: React frontend (Vite, port 3000) + Express backend (port 3002) + PostgreSQL (`trading_journal` db). See [ARCHITECTURE.md](ARCHITECTURE.md) for full route/service/table inventory — this file is conventions and rules, not structure.

**Start of session / after a context clear: read [docs/OPEN_THREADS.md](docs/OPEN_THREADS.md) first.** It tracks unfinished work, unconfirmed proposals, and stale-stats findings from prior sessions — the goal is to never lose a thread to a context reset.

## Dev workflow

- Start: `./start.sh` (kills stale processes, starts server + client) — Stop: `./stop.sh` or `fuser -k 3002/tcp`
- Server only: `npm run server` (nodemon, port from `.env` `PORT=3002`) — Client only: `npm run client`
- DB: `server/schema.sql` is a full `pg_dump --schema-only` snapshot (122 tables/views, regenerated 2026-06-30 after a dead-table cleanup) — there's still no tracked migration history, so it drifts again the moment a table is added/altered live without regenerating. See the regen command in [ARCHITECTURE.md](ARCHITECTURE.md#schema-source-of-truth). When in doubt, query `information_schema.tables`/`information_schema.columns` against the live DB rather than trusting the file is current.

## Hard rules

- **No static thresholds.** Every threshold in this codebase must be derived from a rolling distribution (σ from a rolling mean/std), never a hardcoded number. This applies to entries, stops, targets, signal triggers — everything. If you're about to write a literal number as a cutoff, stop and compute it from historical data instead.
- **P&L must use the CumPL diff method**, not `SUM(pnl)` or `SUM(FlatToFlat)` — both overcount. See the SQL pattern in [ARCHITECTURE.md](ARCHITECTURE.md#pnl-calculation-cumpl-diff--critical-dont-regress-this). `/api/daily-logs` and `/api/stats/daily` both implement this — keep them in sync if you touch either.
- **Never fabricate a stat.** Any win-rate/hit-rate claim needs N≥20 in the sample before it's reported as decisive (see `engineReadHitRates.js` convention). Below that, say so explicitly rather than rounding to a confident-sounding number.
- **No lookahead in backtests/replays.** Case engine, day-type reassessment, and all backtest scripts must only use information that would have been available at that point in time. This is a frequent source of subtle bugs — when writing a new backtest script, explicitly check that no future bar/level data leaks into a decision made earlier in the session.
- **Do not guess on third-party tool behavior** (especially Sierra Chart specifics) — fetch documentation or ask before asserting how an external tool behaves.

## Conventions

- Backtest scripts live in `scripts/`, named `backtest_<hypothesis>.js`, run manually via `node`, and typically write findings to the `performance_audit` table. They are not imported by the running app.
- Sierra Chart TAL data is stored as JSONB under `custom_fields->'sierra_data'` rather than typed columns — this lets new TAL columns appear without a migration and lets old Activity Log format rows coexist.
- Account filter state is lifted to `App.jsx` and shared between Calendar and Dashboard — don't duplicate it locally in a component.

## Collaboration

- **Standing permission to run commands in this repo without asking first.** This covers all normal tool use — Bash commands, file edits/writes, running scripts/backtests, git commits, schema/doc regeneration, dropping confirmed-dead tables after backup, etc. Don't pause to confirm routine actions; just do the work. This was restated explicitly on 2026-06-30 because re-asking was burning the user's time/limits unnecessarily.
- The one carve-out: genuinely high-blast-radius or hard-to-reverse actions outside normal project workflow still warrant a heads-up — force-push, `git reset --hard`, dropping data without a backup, anything touching production secrets, or actions visible outside this repo (sending messages, posting externally). This carve-out is narrow on purpose; don't expand it to cover ordinary commands.

## Where to look

- Conviction/session read logic: `server/services/caseEngine.js`
- Opening range / day-type: `server/services/acdService.js` + `server/routes/acd.js`
- Shared query helpers (NL30/NL10, gap drift, prior-week range): `server/services/queries.js` — check here before writing a new one
- Risk guardrails (DLL, profit-lock, cooldown): `server/routes/dll.js`, `profitLock.js`, `cooldown.js`
- Known bugs / tech debt: [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md)
- Pending decisions, unconfirmed proposals, stale-stats findings, unfinished multi-session work: [docs/OPEN_THREADS.md](docs/OPEN_THREADS.md) — **check this at the start of any session**, especially after a context clear.

## Documentation maintenance — keep this perpetually current

This file and [ARCHITECTURE.md](ARCHITECTURE.md) are the handoff point for the next session (human or Claude) — treat letting them go stale as a real cost, the same as introducing a bug. A `Stop` hook (`.claude/settings.json`) checks at the end of every session whether structural files changed without a matching doc update and prints a reminder — if you see that reminder, act on it before ending the turn rather than dismissing it.

Concretely, whenever a session does any of the following, update the relevant doc **in that same session**, not as a follow-up:
- Add/remove a route file, service file, or DB table → update [ARCHITECTURE.md](ARCHITECTURE.md)'s route/service/table tables, and if a table was added/dropped/altered, regenerate `server/schema.sql` (command is in ARCHITECTURE.md)
- Add/remove a dashboard component → update the frontend structure table in [ARCHITECTURE.md](ARCHITECTURE.md)
- Establish a new hard rule or convention (the user corrects an approach, or confirms a non-obvious one) → add it to the **Hard rules** or **Conventions** section above
- Fix something listed in [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) → remove that entry; discover a new one → add it
- The user confirms a fix/decision but it isn't fully implemented in the same session, proposes a follow-up that isn't confirmed yet, or you find a stat/display that's stale or disconnected from its source of truth → add it to [docs/OPEN_THREADS.md](docs/OPEN_THREADS.md) **before the session ends** — don't rely on conversation memory alone to carry pending work forward. This is on you to maintain proactively; the user has delegated it rather than asking for it each time.
- `docs/` also holds point-in-time specs (`MONTE_CARLO_SPEC*.md`, `BACKTESTING_PLAYBOOK.md`) and parked design docs (`*_parked.md`) — those describe proposals, not live state, and aren't required to track the running app. Don't confuse them with ARCHITECTURE.md.

There is exactly one canonical architecture doc — `/ARCHITECTURE.md` at the repo root. If you're ever tempted to write a second one (e.g. inside `docs/`), update the existing one instead; a prior session already made that mistake once (`docs/ARCHITECTURE_2026-06-07_superseded.md`) and it silently went stale because nothing pointed back to it.
