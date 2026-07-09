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
- **Audit all Gemini output before acting on it.** Gemini produces plausible-looking but sometimes wrong analysis. After reading `scratch/antigravity_response.md`, verify 3–5 key claims by re-querying the DB directly before promoting any finding to `performance_audit` or changing live parameters. Specific checks: (1) 100%/0% WR with N≥10 → always check `COUNT(DISTINCT log_date)` for single-session clustering; (2) grid output → compare "current params" cell to existing `performance_audit` baseline; (3) N counts → verify with a direct `COUNT(*)`; (4) any TRADE recommendation → re-run the WR/EV query yourself. User delegated this explicitly: "I want Claude to audit anything and everything Gemini does. It lies sometimes."

## Conventions

- Backtest scripts live in `scripts/`, named `backtest_<hypothesis>.js`, run manually via `node`, and typically write findings to the `performance_audit` table. They are not imported by the running app.
- Sierra Chart TAL data is stored as JSONB under `custom_fields->'sierra_data'` rather than typed columns — this lets new TAL columns appear without a migration and lets old Activity Log format rows coexist.
- Account filter state is lifted to `App.jsx` and shared between Calendar and Dashboard — don't duplicate it locally in a component.
- **Server-autonomous detection:** `server/index.js` runs a `setInterval` every 60s during 9:30–4 PM ET Mon–Fri calling `GET /api/acd/today`. This is intentional — it makes level fade detection independent of browser clients. Do not remove it. The INSERT in `acd.js` is `ON CONFLICT DO NOTHING` so concurrent client polls don't double-write.
- **Level fade detection gate:** `acd.js` line ~3838 checks `allRthBarsRow.rows.length >= 3` (not 60). IB-specific levels (`ibHighToday`/`ibLowToday`, `IB_MID_SCALP_FADE`, `OR_MID_AFTER_IB_FADE`) self-gate via `etMinNow >= 630` — do not restore the 60-bar gate.
- **sizeMultiplier is an IIFE** inside the `levelScalpSetup` object in `acd.js`. All sizing adjustments live there. When adding a new factor: (a) research backs it (N≥20), (b) add to the IIFE, (c) update `AlphaEngineOverview.jsx`, (d) document in OPEN_THREADS.
- **New setup type checklist (anti-hardcode gate):** Before any new `setup_type` goes live in `acd.js`, ALL of the following must be satisfied:
  1. Run `node scripts/backtest_setup_status.mjs` → generates/updates `SETUP_STATUS` row in `performance_audit`
  2. Run `node scripts/update_optimal_stops.mjs` → generates/updates `OPTIMAL_STOP` row with data-derived stop/target
  3. If N<20 resolved trades, do NOT fire live — insert as `status='SHADOW'` only until N≥20
  4. Never write a stop, target, or WR claim as a literal number in `acd.js` — always read from `liveStats._opt[type]` or `performance_audit`
  - The `Stop` hook (`.claude/hooks/check-docs-drift.sh`) scans for hardcoded anti-patterns and will warn if any of these are violated. The `SessionStart` hook checks for setup_types missing a fresh SETUP_STATUS row.
- **Unified suppression pipeline (the only suppression source):** All suppression of level fade setups flows through `scripts/backtest_setup_status.mjs` → `performance_audit` SETUP_STATUS/SETUP_STATUS_DOW → `liveStats._suppressedSetups` / `liveStats._dowSuppressToday`. Never add a hardcoded suppression list or day-of-week skip list to `acd.js` — the pipeline handles it automatically and re-evaluates weekly.
- **`acd.js` block-scoping footgun:** `liveStats` is declared with `let` inside the level-fade block (`if (currentPrice && allRthBarsRow.rows.length >= 3)` at line ~4065, inner `if (last5.length >= 3...)` at ~4108). Anything outside those blocks — including `const candidates`, the `for (const cand of candidates)` loop, `shadowCandidates`, and the INSERT body — is outside `liveStats`'s scope and will throw a ReferenceError if it references `liveStats` directly. The fix pattern is `getCached(todayET, 'levelFadeStats')` at the outer scope (already done at line ~5064). **When adding any new reference to `liveStats` in `acd.js`, check whether the call site is inside or outside the level-fade block.** Similarly, `ls()` and `lsMon()` are only valid inside the inner block — do not call them from the `candidates` array or below.**

## Collaboration

- **Standing permission to run commands in this repo without asking first.** This covers all normal tool use — Bash commands, file edits/writes, running scripts/backtests, git commits, schema/doc regeneration, dropping confirmed-dead tables after backup, etc. Don't pause to confirm routine actions; just do the work. This was restated explicitly on 2026-06-30 because re-asking was burning the user's time/limits unnecessarily.
- The one carve-out: genuinely high-blast-radius or hard-to-reverse actions outside normal project workflow still warrant a heads-up — force-push, `git reset --hard`, dropping data without a backup, anything touching production secrets, or actions visible outside this repo (sending messages, posting externally). This carve-out is narrow on purpose; don't expand it to cover ordinary commands.
- **Gemini timeout/fallback:** After invoking Gemini and waiting: (1) 5 min with no `scratch/antigravity_response.md` update → nudge by re-invoking with the same task; (2) another 5 min still nothing (10 min total) → Gemini's context ran out, Claude does the task directly. Don't block on Gemini indefinitely. Check elapsed time with `stat --format='%Y' scratch/antigravity_response.md` vs invocation time.
- **Gemini quota exhaustion:** If `invoke_gemini.sh` exits in under 10 seconds with 0 lines written, diagnose immediately: `agy --log-file /tmp/agy_diag.log --print "test" 2>&1; grep -i "RESOURCE_EXHAUSTED\|quota" /tmp/agy_diag.log`. If it shows `RESOURCE_EXHAUSTED (429)`, quota is exhausted — **do not wait, do not pause work.** Claude does the task directly right now (read the files, run the queries, write the findings). Note the reset time from the log for future Gemini use, but keep moving immediately.

## Where to look

- Conviction/session read logic: `server/services/caseEngine.js`
- Opening range / day-type: `server/services/acdService.js` + `server/routes/acd.js`
- **Level fade alpha engine** (size multiplier stack, suppression logic, keepLevels, sizeMultiplier IIFE): `server/routes/acd.js` lines ~3830–4430. Gate is 3 bars (~9:34 AM). Server polls every 60s via `setInterval` in `server/index.js`.
- **Alpha Engine overview page**: Edge → Alpha Engine tab (`src/components/dashboard/AlphaEngineOverview.jsx`) — human-readable summary of every system component, size multiplier factor, suppressed setup, and pending road map.
- **Opus audit prompts**: `docs/OPUS_AUDIT_PROMPT.md` (Audit 1 — code/bugs/behavioral forensics; all 9 findings implemented 2026-07-07) · `docs/OPUS_AUDIT_PROMPT_2.md` (Audit 2 — sizeMultiplier discrimination, objective alignment, edge attribution, coaching efficacy, untapped data). Run via Claude Opus 4.8 — not invoked automatically, triggered manually when strategic review is needed.
- Shared query helpers (NL30/NL10, gap drift, prior-week range): `server/services/queries.js` — check here before writing a new one
- Risk guardrails (DLL, profit-lock, cooldown): `server/routes/dll.js`, `profitLock.js`, `cooldown.js`
- Optimal stops/targets (data-derived, weekly recompute): `performance_audit` rows with `signal_type='OPTIMAL_STOP'`; computed by `scripts/update_optimal_stops.mjs`; read in acd.js as `liveStats._opt[setup_type]`
- Day-type per-setup edge (SIZE_UP/SUPPRESS flags): `performance_audit` rows with `signal_type='DAY_TYPE_ALPHA'`; computed by `scripts/backtest_day_type_alpha.js` Sunday 9:10 PM; read in acd.js as `liveStats._dta[setup_type-day_type]`
- Nightly latency audit results: `performance_audit` rows with `signal_type='LATENCY_AUDIT'`; alerts in `scratch/gemini_alerts.txt`
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
