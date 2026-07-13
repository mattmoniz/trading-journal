# Open Threads / Pending Work

Living continuity tracker — distinct from [KNOWN_ISSUES.md](KNOWN_ISSUES.md) (bugs/tech debt found in code) and [ARCHITECTURE.md](../ARCHITECTURE.md) (structure). This file exists so that clearing context never loses a thread: confirmed-but-unimplemented decisions, proposals awaiting the user's go-ahead, stale stats discovered but not yet refreshed, and multi-session analysis work that isn't finished.

All hardcoded thresholds, suppressed setups, and design rationale: [docs/HARDCODED_CONSTANTS.md](HARDCODED_CONSTANTS.md)

When an item is finished, delete it (don't mark it done — git history is the record of what was fixed and when, same convention as KNOWN_ISSUES.md). When a session confirms a decision, proposes a follow-up, or finds a stats/data-freshness gap and doesn't finish it in the same session, add it here before the session ends.

## Pending decisions / unconfirmed proposals

- **WPP_FADE_SHORT_GAP_UP — monitor at N=50 (live 2026-07-09).** Gap-up subset (historical/retrospective): WR=59.3%, EV=+$8.7, N=27. **Checked 2026-07-13: live N=0** (zero rows with `setup_type='WPP_FADE_SHORT_GAP_UP'` in `active_setups` since going live — only 2 trading days have passed). Re-check when live N reaches 50; suppress via pipeline if EV drops below -$5.

- **OPEN_TEST_DRIVE_SHORT/LONG — deeply net-negative under every tested target scheme (2026-07-13).** N=64-69, WR 28-33%, EV -$38 to -$100/trade (current live `t1Guard` PD-VAL-or-formula-fallback target). Tested switching T1 to `p75_mfe` (the original OPEN_THREADS proposal) — makes it *worse* (EV -$66 vs current -$52 for SHORT), so that change was **not** implemented. Both directions clear N≥20 and stay negative regardless of target logic — candidate for suppression via the standard pipeline (`scripts/backtest_setup_status.mjs`). Not yet suppressed; flagging for review.

- **90-day degradation watch (flagged 2026-07-09).** Three setups with alarming 90d EV vs prior history (not suppressed — all-time EV still positive, auto-suppression will catch them if it continues):
  - `OR_HIGH_FADE_SHORT`: prior=$90/trade → 90d=-$18/trade (N=20).
  - `PD_VAH_FADE_SHORT`: prior=$48 → 90d=-$68/trade (N=15).
  - `CAM_S2_FADE_LONG`: prior=$85 → 90d=-$13/trade (N=11). Monitor on next weekly run (Sun 9:20 PM).

- **TOD_ALPHA wiring decision pending (analysis 2026-07-08).** 42 rows in `performance_audit` (signal_type='TOD_ALPHA'). RED FLAG: BALANCE 90d POST_IB reversed to -$49.17 EV / 53.3% WR (N=105). DOW breakdown (20 rows, signal_type='DOW_TOD_ALPHA'): POST_IB BALANCE only reliable on Wednesdays in last 90d. Decision: wire DOW_TOD_ALPHA into sizeMultiplier (e.g., suppress POST_IB sizing on Mon/Thu/Fri) or surface as informational chip? Hold until BALANCE 90d POST_IB degradation is explained.

- **IB_BEARISH all-stop sweep negative (2026-07-09).** Best EV at 20pt stop = -$21 (all-day-type blended, BALANCE drag). On TURBULENT IB_BEARISH is elite. Monitor: if TURBULENT-only IB_BEARISH shows negative EV via DAY_TYPE_ALPHA, consider removing from candidates entirely.

- **Hardcoded processes — prevention items pending (audit 2026-07-09).** The audit found 4 acceptable hardcoded items (nl30 > 9 ACD constant, EXPIRY_WINDOW map, bar pattern TA definitions, morningBrief.js coaching text strings — all low priority). Prevention items not yet wired:
  - Pre-commit hook grepping `acd.js`/`caseEngine.js` for numeric literals near `suppress`, `EV`, `WR`, `threshold` keywords.
  - Session-start check: verify every `setup_type` in recent `active_setups` has a SETUP_STATUS row dated within 8 days (currently checked manually).

- **Pulse score — revisit at N≥100 live setups.** Demoted to informational 2026-07-08 (too many false negatives on strong days). Score chip visible in setup cards. `scripts/backtest_pulse_score.mjs` accumulates data weekly. Revisit: if BALANCE_SCORE_0 false-negative rate <40% on non-TURBULENT days at N≥100, consider re-enabling -0.10× penalty only.

- **sizeMultiplier re-audit at N≥100 (~2026-08-20).** `size_multiplier` column added 2026-07-06. Re-run `SELECT ROUND(size_multiplier,1), COUNT(*), ROUND(AVG((resolution='TARGET_HIT')::int)*100,1) AS wr FROM active_setups WHERE size_multiplier IS NOT NULL GROUP BY 1 ORDER BY 1` when N≥100. Freeze policy: no new ±0.10 factor tweaks until capture ratio improves or audit completes.

- **Bar body chip — backtest before suppressing (wired 2026-07-08).** DOJI (<30% body) and STRONG BODY (≥65%) chips are informational. Next: run `scripts/backtest_session_delta.mjs` with body_pct enrichment to get WR by body quality tier (N≥20 per bucket).

- **Top confluence pairs not yet surfaced near current price.** 520 pairs in `scripts/output/confluence_pairs_latest.json` (15pt proximity, min N=20, top: 5D_OR_MID+RTH_VWAP N=89 74.2% $82 EV). No endpoint surfaces pairs near current price. Future: endpoint reads current price from bars, finds levels within 15pt from `level_prices`, checks JSON for matching pairs.

- **AI_SETUP_AGG accumulating — monitor (~2026-08-07).** `scripts/aggregate_ai_setup_reviews.js` flags NEEDS_ADJUST when avg < 3.5⭐ and N≥20. Currently N=1 for all 8 setups — need ~4 weeks of daily reviews.


- **HomeAssistant hosting (future, no timeline).** Access journal from HA sidebar via Cloudflare Tunnel (already running). Easiest: add `panel_iframe` to HA `configuration.yaml` pointing at tunnel URL — no backend/frontend changes. Prerequisite: verify tunnel URL is stable (not ephemeral trycloudflare.com free tier).

## 30-day shadow validation

- **IB_MID_SCALP_FADE_SHORT and OR_MID_AFTER_IB_FADE_SHORT** — both flip positive with tight stops but currently suppressed pending live validation. Check ~2026-08-05.
