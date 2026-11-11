# Handoff, 2026-11-09 night (after the context clear): read this, then docs/OPEN_THREADS.md

## State right now
- ONE `./start.sh` supervisor running DETACHED (started from a Claude shell, log `scratch/start_20261109c.log`): plain `node server/index.js` (no nodemon), vite up, Sierra switch auto-re-armed on Sim1. Run `./stop.sh` or take it over in your own terminal before long idle (co-021). Check `ps -ef | grep "node server/index.js"` shows exactly one (hr-017, hr-071).
- Vacuum daemon (`scripts/vacuum_live/shadow.py`, health :8906) LIVE; vacuum + turn-signal order services NOT paused. The AMT TELL order service is SELF-PAUSED for today by the user's choice (alarm AMT_UNFLATTENED 12:13 for setup 158556); clear = delete that alarm row + restart, only on the user's go.
- Nothing is committed (about 65 changed/new files). Commit only when asked, grouped.

## Decisions made this session (user)
- Level families (bet classes VALUE_FADE, GLOBEX_LEVEL) are MONITOR-ONLY: detected as SHADOW, never fire; used as confluence for market setups. Implemented in `scripts/calibrate_live_roster.mjs` (`MONITOR_ONLY_BET_CLASSES`). OVER-REACH: it also catches pattern setups (STOP_SWEEP, FAILED_AUCTION, TRT, VALUE_AREA_RESPONSIVE, VWAP_MAGNET); narrow to families 1-8 once the user classifies families 9 and 17-23.
- co-025 NARROWED: default is still "never retire on an estimate/prior, park"; ONLY exception = 2 pre-registered nulls each MDE <= 0.15 ADR20 retire an idea (Argon's constants, flagged `co025_adr20_bar_check_20261109`, LOW).
- Argon = thinker only (hr-030). Calibration/cleanup items J (risk caps) skipped by the user.

## Registered, NOT run (all need a prereg amendment/ledger look before outcomes)
- Row 30 A4 historical replay R1 VALUE_FADE / R2 GLOBEX_LEVEL (explore LEAD): claim `capitulation_exit_replay_20261109`; Phase 1 counts DONE (look 219, all classes clear the floor). Run script not written (import the logger virtual-P&L function).
- Row 33 level-confluence tags on market-setup fires (not built). Row 34 vacuum-thrust ENTRY timing (Phase 1 counts need the user's go). Row 35 setup-library census + overlay tests per structural group (needs the user to classify families 9 and 17-23 + Argon's design answers).
- Rows 28/29/31 counted tests all NOT SHOWN, parked.

## Update (after the clear): Argon's reply ARRIVED and was audited
See `docs/ARGON_REVIEW_AUDIT_ROWS30_34_20261109.md` and prereg amendment A5 (OPEN_THREADS top entry). R1/R2 not built or run; new user decision `co025_threshold_vacuous_20261109`.

## Waiting on
- (DONE, see Update) ARGON reply to the brief (artifact https://claude.ai/artifact/NCRjX587uubSXHN4k5LgLS, source `/tmp/claude-1000/-home-mmoniz-trading-journal/307b3aaa-9c60-43e1-ba2e-57d671574bfc/scratchpad/argon_rows30_34_brief.md`, 9 questions). When it arrives: audit every claim (hr-034), apply accepted points as dated PRE-OUTCOME amendments, then build/run in the order Argon's Q7 suggests. Copy of the brief is also saved in `scratch/argon_rows30_34_brief_20261109.md`.
- User: classify families 9 and 17-23; go for row 34 Phase 1; go to clear the tell pause; exit-refusal design review; re-base the staged OHLC patch (`scratch/staged_vacuum_ohlc_20261109/`) on the fixed shadow.py; DeepSeek rounds 17/18 + corrected D1 request in `scratch/staged_argon_requests/`.
