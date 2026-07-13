# Open Threads / Pending Work

Living continuity tracker — distinct from [KNOWN_ISSUES.md](KNOWN_ISSUES.md) (bugs/tech debt found in code) and [ARCHITECTURE.md](../ARCHITECTURE.md) (structure). This file exists so that clearing context never loses a thread: confirmed-but-unimplemented decisions, proposals awaiting the user's go-ahead, stale stats discovered but not yet refreshed, and multi-session analysis work that isn't finished.

All hardcoded thresholds, suppressed setups, and design rationale: [docs/HARDCODED_CONSTANTS.md](HARDCODED_CONSTANTS.md)

When an item is finished, delete it (don't mark it done — git history is the record of what was fixed and when, same convention as KNOWN_ISSUES.md). When a session confirms a decision, proposes a follow-up, or finds a stats/data-freshness gap and doesn't finish it in the same session, add it here before the session ends.

## Pending decisions / unconfirmed proposals

- **WPP_FADE_SHORT_GAP_UP — monitor at N=50 (live 2026-07-09).** Gap-up subset (historical/retrospective): WR=59.3%, EV=+$8.7, N=27. **Checked 2026-07-13: live N=0** (zero rows with `setup_type='WPP_FADE_SHORT_GAP_UP'` in `active_setups` since going live — only 2 trading days have passed). Re-check when live N reaches 50; suppress via pipeline if EV drops below -$5.

- **90-day degradation watch (flagged 2026-07-09).** Three setups with alarming 90d EV vs prior history (not suppressed — all-time EV still positive, auto-suppression will catch them if it continues):
  - `OR_HIGH_FADE_SHORT`: prior=$90/trade → 90d=-$18/trade (N=20).
  - `PD_VAH_FADE_SHORT`: prior=$48 → 90d=-$68/trade (N=15).
  - `CAM_S2_FADE_LONG`: prior=$85 → 90d=-$13/trade (N=11). Monitor on next weekly run (Sun 9:20 PM).

- **IB_BEARISH all-stop sweep negative (2026-07-09).** Best EV at 20pt stop = -$21 (all-day-type blended, BALANCE drag). On TURBULENT IB_BEARISH is elite. Monitor: if TURBULENT-only IB_BEARISH shows negative EV via DAY_TYPE_ALPHA, consider removing from candidates entirely.

- **Pulse score — revisit at N≥100 live setups.** Demoted to informational 2026-07-08 (too many false negatives on strong days). Score chip visible in setup cards. `scripts/backtest_pulse_score.mjs` accumulates data weekly. Revisit: if BALANCE_SCORE_0 false-negative rate <40% on non-TURBULENT days at N≥100, consider re-enabling -0.10× penalty only.

- **sizeMultiplier re-audit at N≥100 (~2026-08-20).** `size_multiplier` column added 2026-07-06. Re-run `SELECT ROUND(size_multiplier,1), COUNT(*), ROUND(AVG((resolution='TARGET_HIT')::int)*100,1) AS wr FROM active_setups WHERE size_multiplier IS NOT NULL GROUP BY 1 ORDER BY 1` when N≥100. Freeze policy: no new ±0.10 factor tweaks until capture ratio improves or audit completes.

- **AI_SETUP_AGG accumulating — monitor (~2026-08-07).** `scripts/aggregate_ai_setup_reviews.js` flags NEEDS_ADJUST when avg < 3.5⭐ and N≥20. Currently N=1 for all 8 setups — need ~4 weeks of daily reviews.

- **HomeAssistant hosting (future, no timeline).** Access journal from HA sidebar via Cloudflare Tunnel (already running). Easiest: add `panel_iframe` to HA `configuration.yaml` pointing at tunnel URL — no backend/frontend changes. Prerequisite: verify tunnel URL is stable (not ephemeral trycloudflare.com free tier).

## 30-day shadow validation

- **IB_MID_SCALP_FADE_SHORT and OR_MID_AFTER_IB_FADE_SHORT** — both flip positive with tight stops but currently suppressed pending live validation. Check ~2026-08-05.
