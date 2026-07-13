# Hardcoded Constants & Design Decisions

Living audit of every hardcoded value in the trading codebase — what it is, why it exists, its category, and what it would take to replace it. Also tracks recently removed hardcoded items so the cleanup history is preserved.

Updated by the Stop hook when structural files change. Add an entry here whenever a hardcoded item is added OR removed from the live codebase.

---

## How to use this file

**Adding a constant:** Document it here before committing — category, reason, replacement plan.

**Removing a constant:** Move it to the "Removed" section with date and how it was replaced.

**Categories:**
- `DATA_DERIVED_FALLBACK` — only fires when performance_audit has no row yet; safe
- `SIMULATION_PARAMETER` — used in retrospective reporting, not live trading decisions
- `STATISTICAL_CLASSIFICATION` — classification boundary, not a trading threshold; defensible
- `SESSION_STRUCTURE` — fixed time/session boundaries (RTH open/close, IB close, etc.); stable
- `BUSINESS_RULE` — prop firm rules or display choices; external constraints
- `TODO` — genuinely needs data-derivation; tagged for removal

---

## Currently Active Constants

### `STOP = 90`, `TARGET = 40` in `acd.js` (level fade fallback)

- **Category:** `DATA_DERIVED_FALLBACK`
- **Location:** `server/routes/acd.js` line ~4110
- **When it fires:** Only when `liveStats._opt[type]` is null AND `lv.mae_p75` is null — i.e., a level type with zero OPTIMAL_STOP data
- **Normal path:** All active level types have OPTIMAL_STOP rows in performance_audit; these constants are never reached in normal operation
- **Replacement:** Ensure every level in keepLevels has ≥20 resolved trades. Then remove constants entirely.

---

### `IB_BULLISH/BEARISH` stop fallback `?? 50` in `acd.js`

- **Category:** `DATA_DERIVED_FALLBACK`
- **Location:** `server/routes/acd.js` line ~3189: `ibOpt?.stop ?? 50`
- **When it fires:** Only when OPTIMAL_STOP has no row for IB_BULLISH/IB_BEARISH
- **Normal path:** Stop sweep runs weekly and always writes a row for both types

---

### `mae_p75: 50, mfe: 15, mfe_p75: 30` on `IB_MID_SCALP_FADE` level object

- **Category:** `DATA_DERIVED_FALLBACK`
- **Location:** `server/routes/acd.js` line ~4481
- **When it fires:** These are spread into the level definition object — `...(ls('IB_MID_SCALP') || {})` overwrites them when DB data exists. Only active if OPTIMAL_STOP has no row for IB_MID_SCALP_FADE.
- **Normal path:** OPTIMAL_STOP row exists for IB_MID_SCALP_FADE_LONG; fallbacks rarely fire

---

### `mae_p75: 35, mfe: 20, mfe_p75: 40` on `OR_MID_AFTER_IB_FADE` level object

- **Category:** `DATA_DERIVED_FALLBACK`
- **Location:** `server/routes/acd.js` line ~4482
- Same pattern as IB_MID_SCALP above

---

### `cfg = { target: 20, stop: 25 }` in `morningBrief.js`

- **Category:** `SIMULATION_PARAMETER`
- **Location:** `server/routes/morningBrief.js` line ~510
- **What it is:** Used in the retrospective morning brief session simulator — checks whether each level approach during the day resulted in a 20pt move before a 25pt adverse move. This is a coarse "did something happen here?" filter for retrospective reporting, not a live trade threshold.
- **Why not OPTIMAL_STOP:** The simulation runs across multiple level types in a single loop; per-type stop/target lookup would add complexity with minimal benefit (the morning brief result is informational, not actionable). The 20pt target is intentionally a "minimum meaningful move" threshold, not a trade target.
- **Replacement:** Could use median OPTIMAL_STOP values from performance_audit. Low priority.

---

### Level Exhaustion WR description strings in `morningBrief.js`

- **Category:** `SIMULATION_PARAMETER` (cosmetic display text)
- **Location:** `server/routes/morningBrief.js` lines 1254, 1269
- **What:** `'65% WR at triple confluence (N=112)'`, `'62% WR at this stretch (N=437)'`, `'59% WR (N=907)'`
- **Replacement:** Wire to CONTEXT_ANALYSIS or LEVEL_FADE_AUDIT rows in performance_audit. Low priority — these are description strings in coaching alerts.

---

### POC Magnet `'66% WR, 20pt target, 25pt stop. [Backtested N=402]'` in `morningBrief.js`

- **Category:** `SIMULATION_PARAMETER` (cosmetic display text)
- **Location:** `server/routes/morningBrief.js` line ~1045
- **Replacement:** Wire `sample_size` and `win_rate` from OPTIMAL_STOP row for `PD_POC_FADE`. Low priority.

---

### MARGINAL-tier base discount in `sizeMultiplier` IIFE (`acd.js`)

- **Category:** `TODO`
- **Location:** `server/routes/acd.js` line ~4593: `if (lv.ev < 30 && confluenceCount < 2) mult = Math.max(mult - 0.25, 0.25)`
- **What:** MARGINAL setups (EV < $30) with no confluence partner start at 0.75× size. Confluent setups always start at 1.0×.
- **Why `$30`:** Midpoint of SOLID tier ($20–$50). Should eventually be derived as the EV at the 40th percentile of all active setup_types — but current N is too small.
- **Replacement:** When N per setup_type is large enough, derive the EV percentile cutoff from performance_audit and replace `30` with `liveStats._opt.evP40 ?? 30`. Target: N≥50 per type, ~2026-10.

---

### Tier EV thresholds in `acd.js`

- **Category:** `BUSINESS_RULE`
- **Location:** `server/routes/acd.js` lines 4703/4765
- **What:** `lv.ev >= 50 → PRIME, >= 20 → SOLID, >= 0 → MARGINAL, >= -20 → WEAK, else KILL`
- **Why:** These are display classification boundaries based on the Jul 2025–Jul 2026 full-year backtest quartiles. PRIME=$50 = top quartile. Changing them changes what shows green in the UI, not live trade behavior.
- **Replacement:** Not warranted — these are business-rule display choices, not trading thresholds.

---

### `proximityThreshold = Math.max(30, Math.round(devRange * 0.12))` in `morningBrief.js`

- **Category:** `DATA_DERIVED_FALLBACK` (partially dynamic)
- **Location:** `server/routes/morningBrief.js` line ~1221
- **What:** Minimum 30pt or 12% of daily range — controls which levels are "in proximity" for exhaustion alerts. The 0.12 and 30pt floor are semi-arbitrary but range-scaled.
- **Replacement:** Low priority; range-scaling already makes it adaptive.

---

### `Z_UP_STRONG=2.0`, `Z_UP=1.5`, `Z_SUPPRESS=2.0`, `WR_UP_STRONG=0.75`, `WR_UP=0.65`, `WR_SUPPRESS=0.55` in `backtest_day_type_alpha.js`

- **Category:** `STATISTICAL_CLASSIFICATION`
- **Location:** `scripts/backtest_day_type_alpha.js` lines 24–30
- **What:** Classification boundaries for DAY_TYPE_ALPHA cells (SIZE_UP_STRONG/SIZE_UP/SUPPRESS/NEUTRAL). Results flow into `liveStats._dta` and the sizeMultiplier IIFE.
- **Why z=1.5/2.0:** Standard statistical significance conventions at typical cell sizes (N=25-70), z=1.5 requires ~8-12% WR divergence.
- **Why WR floors:** SIZE_UP cells must also have meaningful absolute WR, not just be statistically above a poor baseline.
- **Replacement:** Not warranted — these are classification boundaries, not trading thresholds.

---

### `nl30 > 9` / `nl30 < -9` in `caseEngine.js`

- **Category:** `STATISTICAL_CLASSIFICATION`
- **Location:** `server/services/caseEngine.js` lines 240-241, 354, 878-879, 1089-1094, 1393, 1400
- **What:** ACD methodology constant — NL30 above/below ±9 ticks defines structural trend bias. Feeds into sizeMultiplier (+2/-3 for alignment/counter-trend).
- **Why 9:** Mark Fisher's ACD system defines "significant" as a meaningful NL score relative to daily ACD value. 9 ≈ 1× daily A value on an average day.
- **Replacement:** Could be tuned as a rolling percentile of |nl30| distribution. Major downstream effects — needs dedicated research session before changing. Not high priority.

---

### `EXPIRY_WINDOW` map in `acd.js`

- **Category:** `BUSINESS_RULE`
- **Location:** `server/routes/acd.js` line ~5466
- **What:** Per-setup-type expiry windows (minutes from fired_at before a setup expires if unresolved).
- **Replacement:** Could derive from "how long after detection does price stay near the level" analysis. Low priority — operational config.

---

### `COOLDOWN_MINUTES = 15` in `cooldown.js`

- **Category:** `BUSINESS_RULE`
- **Location:** `server/routes/cooldown.js` line 7
- **What:** Post-loss cooldown period. Operational config, not a performance threshold.

---

### Session phase minute boundaries (`570`, `630`, `750`, `870`, `960`) throughout codebase

- **Category:** `SESSION_STRUCTURE`
- **What:** `570=9:30 ET` (RTH open), `630=10:30 ET` (IB close), `750=12:30` (midday), `870=2:30` (late), `960=4:00 PM` (RTH close). These are fixed market session structure times — stable and correct.

---

### COIL SURGE parameters in `acd.js`

- **Category:** `TODO` (low priority)
- **Location:** `server/routes/acd.js` line ~3611: `const cRW = 15, cRT = 40, cVR = 0.40, cBB = 20, cPOP = 2.5`
- **What:** Range window (15 bars), range threshold (40pt), volume ratio (40% above baseline), baseline bars (20), price pop (2.5pt).
- **Why:** Calibrated manually from ~30 visual reviews. COIL_SURGE has insufficient N for data derivation.
- **Replacement:** When COIL_SURGE reaches N≥20 resolved trades, run a sweep on cRT and cVR.

---

### `PASS_TARGET = 3000` in `dll.js`

- **Category:** `BUSINESS_RULE`
- **Location:** `server/routes/dll.js` line ~155
- **What:** Prop firm evaluation profit target. External constraint.

---

### `meter > 15` / `meter < -15` in `caseEngine.js`

- **Category:** `STATISTICAL_CLASSIFICATION`
- **Location:** `server/services/caseEngine.js` line ~1344
- **What:** Classification boundary on the [-100, 100] composite conviction score ("meter"). Above +15 = bullish lean; below -15 = bearish lean; between ±15 = neutral. Used for daily coaching/read summaries only.
- **Why not data-derived:** `meter` is a synthetic composite score computed on the fly from NL30, ACD signals, and day-type factors. It is NOT stored in any DB table. There is no historical distribution to query — rolling percentiles would require first logging meter values for every session. ±15 = ≈15% of max range, which is a standard "just outside noise" classification threshold.
- **Replacement:** Not warranted without first adding a `meter_score` column to `daily_log` or equivalent and accumulating 90+ days of history. The ±15 boundary can then be derived as p33/p67 of the historical distribution.

---

### `favor >= 20, adverse >= 30` in `morningBrief.js` (VWAP simulation)

- **Category:** `SIMULATION_PARAMETER`
- **Location:** `server/routes/morningBrief.js` lines ~567-568
- **What:** Used in the VWAP_MAGNET retrospective simulator — checks whether each VWAP approach during the day yielded 20pt in the favorable direction before a 30pt adverse move. Used for morning-brief "did VWAP work today?" reporting only.
- **Why not OPTIMAL_STOP:** No `OPTIMAL_STOP` row exists for `VWAP_MAGNET` — the setup is SHADOW (insufficient N for live deployment). `performance_audit` has no authoritative target/stop for this type yet.
- **Replacement:** When VWAP_MAGNET reaches N≥20 resolved trades, run `update_optimal_stops.mjs` and wire `liveStats._opt['VWAP_MAGNET']` here.

---

## Removed Constants (cleanup log)

| Removed | Date | What it was | How it was replaced |
|---|---|---|---|
| `suppressedFades` Set in `acd.js` | 2026-07-09 | Hardcoded set of 10+ suppressed setup types. Was blocking setups with positive EV (CAM_S3_FADE_LONG +$87). | `backtest_setup_status.mjs` → `performance_audit SETUP_STATUS` → `liveStats._suppressedSetups`. Re-evaluates weekly, auto-promotes recovering setups. |
| `mondaySkip` array in `acd.js` | 2026-07-09 | Hardcoded list of 6 setups blocked on Mondays. Was blocking elite Monday setups (+$89, +$100, +$125 EV). | `backtest_setup_status.mjs` per-DOW section → `performance_audit SETUP_STATUS_DOW` → `liveStats._dowSuppressToday`. Re-evaluates weekly. |
| `isMonday ? 60 : 90` STOP / `isMonday ? 30 : 40` TARGET in `acd.js` | 2026-07-09 | Monday-specific tighter stop/target fallbacks with no data backing. | Unified fallback: `STOP = 90, TARGET = 40` (both annotated `// Fallback`). IB types use sweep-optimal 50pt via `_opt`. |
| IB_BULLISH/BEARISH stop `(isBull ? 50 : 80)` in `acd.js` | 2026-07-09 | Hardcoded IB stops (50pt BULLISH, 80pt BEARISH). IB_BEARISH 80pt was too wide — sweep found 50pt optimal for both. | `update_optimal_stops.mjs` stop sweep → `performance_audit OPTIMAL_STOP` → `liveStats._opt[IB_BULLISH/IB_BEARISH].stop`. (2026-07-13: generalized from an IB-only 20-150pt flat-grid special case to a percentile-anchored sweep — p25/p40/p50/p60/p75/p90 of that type's own MAE distribution — applied to all 66 setup_types. The flat-grid version briefly went live and let several types drift to an arbitrary 150pt ceiling unrelated to their real MAE distribution; caught and reverted same-day before being kept live.) |
| `sizeMultiplier: confluenceCount >= 2 ? 1.0 : (lv.ev >= 30 ? 1.0 : 0.75)` | 2026-07-09 | EV-based starting multiplier was outside the IIFE, hiding a `$30` hardcoded threshold from the Stop hook scanner. | Moved inside IIFE as explicit comment: `if (lv.ev < 30 && confluenceCount < 2) mult -= 0.25`. Same behavior, now visible and scannable. |
| IB description text `'N=89'`, `'73% WR'`, `'80pt'` | 2026-07-09 | Stale stats baked into the conflicting-signal description string and targetLabel. | Replaced with live `_opt.IB_BEARISH` stats via IIFE template literal. |
| Monday description text `'60pt stop, 30pt target, post-IB only'` | 2026-07-09 | Stale stop/target values in level fade description string. | Changed to `'post-IB only (waits for IB close 10:30 ET)'` — operational text only, stop/target shown separately from `_opt`. |
| `ibRange < 50 → TIGHT_IB, > 100 → WIDE_IB` in `morningBrief.js` | 2026-07-09 | IB range classification hardcoded at 50/100pt. 252-day distribution: p10=93pt (so < 50 NEVER fired), p20=114pt (so > 100 fired ~80% of sessions). Both thresholds completely wrong. | Rolling p33/p67 from last 90 sessions via `price_bars_primary` query, with fallbacks 146/229 (252d sample values). |
