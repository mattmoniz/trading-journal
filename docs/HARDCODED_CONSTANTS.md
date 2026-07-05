# Hardcoded Constants & Design Decisions

This file documents every hardcoded threshold in the live codebase — what it is, why it exists, its current status (true hardcode vs. data-derived fallback), and what would need to happen to replace it. Maintained alongside OPEN_THREADS.md.

Last updated: 2026-07-05

---

## Day-Type Significance Classification (`scripts/backtest_day_type_alpha.js`)

These constants govern how the weekly DAY_TYPE_ALPHA backtest classifies (setup_type × day_type) cells into SIZE_UP_STRONG / SIZE_UP / SIZE_DOWN / SUPPRESS / NEUTRAL. Results are read by `liveStats._dta` in `acd.js` and flow into the `sizeMultiplier` IIFE.

```js
const MIN_N          = 20;    // N≥20 rule (CLAUDE.md) — below this always NEUTRAL
const SCALE_FACTOR   = 0.07;  // size_delta = |z_score| × 0.07, capped 0.25
const Z_UP_STRONG    = 2.0;   // z ≥ 2.0 → SIZE_UP_STRONG (strong statistical evidence)
const Z_UP           = 1.5;   // z ≥ 1.5 → SIZE_UP
const Z_DOWN         = 1.5;   // z ≤ -1.5 → SIZE_DOWN
const Z_SUPPRESS     = 2.0;   // z ≤ -2.0 AND WR < 0.55 → SUPPRESS
const WR_UP_STRONG   = 0.75;  // absolute WR floor for SIZE_UP_STRONG
const WR_UP          = 0.65;  // absolute WR floor for SIZE_UP
const WR_SUPPRESS    = 0.55;  // absolute WR ceiling for SUPPRESS
```

**What's hardcoded:** The z-score thresholds (1.5/2.0) and WR floors (0.75/0.65/0.55). These are classification boundaries, not trading thresholds — they don't gate entries or set stops.

**Why these values:**
- z=1.5/2.0: standard statistical significance conventions. At typical cell sizes (N=25-70), z=1.5 requires ~8-12% WR divergence, z=2.0 requires ~11-16%. Both are large enough to be practically meaningful.
- WR_UP_STRONG=0.75 / WR_UP=0.65: a SIZE_UP cell must ALSO have meaningful absolute performance, not just be statistically above a poor baseline.
- SCALE_FACTOR=0.07: at z=1.5 → size_delta=0.105; at z=2.0 → 0.14; at z=3.0 → 0.21; capped at 0.25. Keeps day-type adjustments proportional to evidence without ever dominating other sizeMultiplier signals.

**Current findings (as of 2026-07-05):** Only 2 actionable cells — WEEKLY_VWAP_FADE_LONG BALANCE (z=1.9, SIZE_UP, delta=0.13) and IB_HIGH_FADE_SHORT TREND (z=-1.6, SIZE_DOWN — already globally suppressed). All other day-type WR differences are within noise once each setup's own (already high) baseline is accounted for. The system will auto-discover new actionable cells as data accumulates.

**Replacement:** The thresholds are intentional statistical choices. SCALE_FACTOR could be increased to give more weight to day-type signals; current 0.07 is conservative to avoid over-fitting on limited N.

---

## Stop & Target Distances

### `STOP` / `TARGET` in `server/routes/acd.js` (line ~3804)

```js
const STOP   = isMonday ? 60 : 90;
const TARGET = isMonday ? 30 : 40;
```

**Status:** Last-resort fallback. The live path now has two layers above these before it falls through:
1. `liveStats._opt[type]` — directional p75_mae / p50_mfe from `performance_audit` (OPTIMAL_STOP rows), updated weekly
2. `lv.mae_p75` / `lv.mfe` — per-level stats loaded from `performance_audit` (UNIFIED_BACKTEST)

These constants are only hit if both (1) and (2) return null — e.g. a brand new level with zero historical data.

**Why 90/30 non-Monday:** Historical UNIFIED_BACKTEST p75_mae across all level fades clustered around 60–90pt; 40pt target was the p50_mfe median before individual-level data existed. These values are now obsolete for any level with N≥20 data.

**Why 60/30 Monday:** Monday backtest (MON_BACKTEST rows) showed consistently tighter MAE — price moves slower before IB closes. 60pt stop / 30pt target was the p75/p50 cluster from ~60 Monday trades per level group.

**Replacement:** Already replaced in practice. To remove the constants entirely, ensure every level in `keepLevels` has OPTIMAL_STOP data (N≥20 resolved trades). Gap today: very new levels (MONTHLY_OPEN, 3M_POC, etc.) may still hit these fallbacks.

---

### `mae_p75: 50, mfe: 15, mfe_p75: 30` on `IB_MID_SCALP_FADE` (line ~4127)

```js
{ name: 'IB_MID_SCALP_FADE', level: ..., mae_p75: 50, mfe: 15, mfe_p75: 30, ...(ls('IB_MID_SCALP') || {}) }
```

**Status:** Inline override. These are baked into the level definition object and spread last-to-first — they get overwritten by `ls('IB_MID_SCALP')` if DB data exists, so they're only active when the DB lookup returns nothing.

**Why:** IB_MID_SCALP is a scalp-mode setup (tight in/out). Before the OPTIMAL_STOP system existed, these numbers came from a manual review of ~50 IB mid setups. The 50pt stop / 15pt target captures the scalp nature — wider stop allows the typical IB mid oscillation, tight target books the first move.

**Replacement:** The OPTIMAL_STOP row for IB_MID_SCALP_FADE_LONG / SHORT now supersedes these. The inline numbers are kept as safety fallback.

---

### `mae_p75: 35, mfe: 20, mfe_p75: 40` on `OR_MID_AFTER_IB_FADE` (line ~4128)

Same structure as IB_MID_SCALP above. 35pt stop / 20pt target came from early OR_MID backtest analysis. OPTIMAL_STOP rows now supersede for any setup_type with N≥20.

---

### `DEFAULT_STOP = 65`, `DEFAULT_TARGET = 35` in `scripts/update_optimal_stops.mjs`

```js
const DEFAULT_STOP = 65;
const DEFAULT_TARGET = 35;
```

**Status:** Script-only fallback. Only used when `p75_mae` comes back null for a row (shouldn't happen since the query filters `mae_points IS NOT NULL`). Effectively dead code.

---

## Proximity & Window Thresholds

### `15pt` level proximity — level fade alert trigger (`acd.js` line ~4134)

```js
const nearLevels = keepLevels.filter(lv => Math.abs(currentPrice - lv.level) <= 15);
```

**Status:** Hardcoded. This is the "within 15 points = approaching this level" gate for the live alert banner. Also used in the early-touch backfill scanner.

**Why 15:** Widened from 10pt on 2026-07-05 after backtests showed the 10pt window was missing approaches that reversed before piercing — price gets to within 10–14pt of a level and snaps back. 15pt still excludes noise (levels 20pt away that never get tested). Widening to 20pt showed too many false alerts in range-bound sessions.

**Replacement:** Could be derived from σ of "closest approach distance" per level, but 15pt has tested well. Low priority to change.

---

### `60pt` PROX in key-level hit-rate section (`acd.js` line ~1679)

```js
const PROX = 60;
```

**Status:** Hardcoded. Used in the key-levels hit-rate subsection (reads condition breakdown data for levels within 60pt of current price). This is a different subsection from the fade alert — it governs which levels show statistical hit rates in the full key-levels panel.

**Why 60:** Wider window intentionally — this is for informational display, not trading triggers. 60pt shows the context of nearby levels that could matter if price moves.

---

### `>= 60 bars` COIL SURGE gate + `ci = 50` scan start (`acd.js` lines ~3609, 3621)

```js
if (allRthBarsRow.rows.length >= 60) { ... }
for (let ci = 50; ci < cbars.length; ci++) { ... }
```

**Status:** Hardcoded.

**Why 60/50:** COIL SURGE requires detecting a range contraction (15-bar rolling window) followed by a volume pop. 60 bars minimum = ~1 hour of RTH data, enough to compute a baseline volume. The scan starts at bar 50 (not 0) because the rolling window needs the prior 15 bars plus 35 bars of volume baseline — starting earlier would reference pre-session data in the wrong context.

---

### `<= 960 minutes` RTH end in `maeMfeReplay.js`

```js
AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) <= 960
```

**Status:** Hardcoded. 960 = 4:00 PM ET. This is the RTH session close — correct and stable.

---

## Tier EV Thresholds

### `tier: lv.ev >= 50 ? 'PRIME' : ev >= 20 ? 'SOLID' : ev >= 0 ? 'MARGINAL' : ev >= -20 ? 'WEAK' : 'KILL'` (`acd.js` line ~4172)

**Status:** Hardcoded thresholds applied to EV-per-trade (dollars at 1 MNQ).

**Why these numbers:**
- **PRIME ≥ $50:** Top quartile of level fades in the Jul 2025–Jul 2026 full-year backtest. At 1 MNQ, $50/trade compounds meaningfully.
- **SOLID ≥ $20:** Second quartile — reliably positive, worth taking at standard size.
- **MARGINAL ≥ $0:** Technically positive but noise-sensitive. Take AM first-touch only.
- **WEAK ≥ -$20:** Marginal negative — a different stop calibration might flip these positive. Don't suppress without a stop-sweep test first.
- **KILL < -$20:** Structurally negative EV. Already on the `suppressedFades` list if directional analysis confirmed.

**What drives the action instructions in the playbook strip:**
- PRIME / SOLID → `TAKE IT` (differ only by "full" vs "standard" size)
- MARGINAL → `OPTIONAL — AM first touch only, skip re-tests`
- WEAK / KILL → `BELOW THRESHOLD — skip`

**Replacement:** These are business rules, not parameters to tune. Changing $50→$40 as PRIME threshold changes what gets shown to the user in green. Low value in making these data-derived.

---

## Session Phase Time Boundaries

### Playbook strip phases in `src/App.jsx` (line ~18589)

```js
const isPreIb   = etMin >= 570 && etMin < 630;  // 9:30–10:29 ET
const isMornAdj = etMin >= 630 && etMin < 750;  // 10:30–12:29 ET
const isMidday  = etMin >= 750 && etMin < 870;  // 12:30–2:29 ET
// Late Session: 870+ (2:30 ET+)
```

**Status:** Hardcoded. These are trading session structure boundaries, not tunable parameters.

**Why these specific minute values:**
- **570 = 9:30 ET** — RTH open
- **630 = 10:30 ET** — IB closes. This is the most important boundary: first-touch fades before IB close have higher WR (pre-IB-close price hasn't established the day's range yet).
- **750 = 12:30 ET** — Lunch/midday transition. Volume drops, mean-reversion weakens.
- **870 = 2:30 ET** — Late session starts. Fill risk increases, setups degrade.

**Playbook guidance differs by phase:**
- EARLY AM (9:30–10:30): Highest WR. "Statistically highest WR window."
- MID MORNING (10:30–12:30): Re-test risk — confirm level hasn't already been visited.
- LATE SESSION (2:30+): Reduce size, expect lower follow-through.

These boundaries also control the AM-only gate on level fade setups: `etMinNow < 720` in the keepLevels firing condition (720 = noon ET).

---

## Size & Position Rules

### `1 MNQ / account` in playbook strip (`App.jsx` line ~18647)

```js
<span ...>1 MNQ / account</span>
```

**Status:** Hardcoded display string. Reflects current prop firm constraint (account-level sizing).

---

### `sizeMultiplier` in level fade setup (`acd.js` line ~4169)

```js
sizeMultiplier: confluenceCount >= 2 ? 1.0 : (lv.ev >= 30 ? 1.0 : 0.75)
```

**Status:** Hardcoded. Sets multiplier passed to the frontend's contracts-recommendation logic.

**Why:** Single-level setups with EV < $30 get 0.75× size (reduced size for marginal entries). Confluence (2+ levels stacking) or EV ≥ $30 gets full 1.0×. The $30 EV split was chosen as the midpoint of SOLID tier ($20–$50).

**Note:** This is a static threshold — technically a CLAUDE.md violation (hard rules: no static thresholds). However, modifying it requires the contracts-recommendation UI to expose a σ-based size curve. Logged in OPEN_THREADS.md as future work.

---

### Runner guidance thresholds in playbook strip (`App.jsx` line ~18621)

```js
'Full size. If up 30pt in 10 min → move stop to BE, hold half to 2×T1 (~${t2Pt}pt)'
```

**Status:** Hardcoded. The 30pt / 10min trail rule came from observational analysis of TURBULENT-day fade setups. 30pt in 10 minutes = ~3pt/min momentum — strong enough that the setup has proven itself and half-position management is appropriate. This is judgment, not a backtest-derived number.

---

## Sample Size Floor

### `MIN_N = 20` in `update_optimal_stops.mjs` and throughout

```js
const MIN_N = 20;
```

**Status:** Hard floor from CLAUDE.md convention (enforced project-wide). Below N=20, no WR or EV claim is reported as decisive. This number is documented as a rule, not a parameter — changing it would require amending CLAUDE.md explicitly.

---

## Suppressed Fades (Direction-Specific)

### `suppressedFades` Set in `acd.js` (lines ~3921–3935)

These are setups where the directional backtest showed negative EV at N≥20 AND no stop calibration recovered positive EV.

| Setup | WR | N | EV | Reason |
|---|---|---|---|---|
| `PD_POC_FADE_SHORT` | 52.9% | 34 | -$30 | KILL — structurally fails SHORT |
| `IB_MID_SCALP_FADE_SHORT` | 63.6% | 66 | -$16 | Stop width kills SHORT edge |
| `IB_MID_SCALP_FADE_LONG` (BALANCE/TURBULENT only) | — | — | $0.58 | Near-zero EV noise; TREND day LONG is 82% WR — conditional suppress |
| `IB_HIGH_FADE_SHORT` | 55.7% | 79 | -$35 | Stop-wide structural loser SHORT; 54.5% WR even with 35pt stop |
| `OR_MID_AFTER_IB_FADE_SHORT` | 61.7% | 60 | -$32 | LONG side solid ($97 EV); SHORT kills combined edge |
| `CAM_R4_FADE_LONG` | 64.3% | 28 | -$28 | Fading LONG from extreme resistance fails structurally |
| `CAM_S2_FADE_SHORT` | 60.0% | 30 | -$23 | Selling support level fails structurally |
| `CAM_R1_FADE_LONG` | 61.5% | 39 | -$17 | WEAK/KILL boundary |
| `CAM_R1_FADE_SHORT` | 61.8% | 34 | -$16 | WEAK; symmetric loser both sides |
| `PD_VAH_FADE_SHORT` | 60.0% | 45 | -$16 | VAH SHORT fails; VAH LONG is PRIME |

**Shadow-period fades** (in suppressedFades, monitoring for 30 days before unsuppressing):
- `IB_MID_SCALP_FADE_SHORT` — stop sweep showed +$38 EV at 50pt stop. Review ~2026-08-05.
- `OR_MID_AFTER_IB_FADE_SHORT` — stop sweep showed +$36 EV at 35pt stop. Review ~2026-08-05.

**Permanently suppressed via force-null (not suppressedFades):**
- `OPEN_TEST_DRIVE_LONG/SHORT`: 27–32% WR, -$7.7K/yr. `candidates.filter()` removes them upstream.
- `C_STANDALONE_UP`: 53.7% WR N=95, -$60 EV.

---

## Monday-Specific Overrides

### `mondaySkip` array (`acd.js` line ~3914)

```js
const mondaySkip = isMonday
  ? ['OR_HIGH_FADE', 'FLOOR_PIVOT_FADE', 'IB_HIGH_FADE', 'IB_LOW_FADE', 'OR_LOW_FADE', 'PD_SESSION_MID_FADE']
  : [];
```

**Status:** Hardcoded based on MON_BACKTEST analysis. These six levels showed materially lower Monday WR vs. all-days WR. The Monday backtest rows in `performance_audit` (signal_type='MON_BACKTEST') capture this — these levels don't appear in that table at all because they never hit significance.

### `mondayGate = isMonday ? etMinNow >= 630 : true` (line ~3801)

Mondays: don't fire any level fade before 10:30 ET (IB close). Non-Mondays: fire from 9:30. Monday open trades have historically been low-quality (low volume, wide spreads pre-IB-close).

---

## COIL SURGE Internal Parameters (`acd.js` line ~3611)

```js
const cRW = 15, cRT = 40, cVR = 0.40, cBB = 20, cPOP = 2.5;
```

| Constant | Value | Meaning |
|---|---|---|
| `cRW` | 15 | Rolling window size (bars) for range measurement |
| `cRT` | 40 | Range threshold — must be < 40pt to qualify as a coil |
| `cVR` | 0.40 | Volume ratio threshold — current bar must be ≥ 40% above baseline |
| `cBB` | 20 | Baseline bars — volume average window before the coil window |
| `cPOP` | 2.5 | Minimum price pop (points) from close to VWAP |

These were calibrated manually from ~30 COIL SURGE visual reviews. They are not yet in the optimal-stop system because COIL SURGE is logged to `active_setups` but has low N (< 20 resolved).

---

## Optimal Stop System Summary

For the ~68 setup types with N≥20 resolved trades in `active_setups`, stop and target distances are fully data-derived:
- **Stop = `p75_mae`** — 75th percentile of max adverse excursion across resolved trades for that exact setup_type (e.g., `OR_HIGH_FADE_SHORT`)
- **Target = `p50_mfe`** — median of max favorable excursion

These live in `performance_audit` (signal_type='OPTIMAL_STOP') and are recomputed weekly. The live path reads them at startup and caches for 60s. See `scripts/update_optimal_stops.mjs` and `server/services/maeMfeReplay.js`.

The hardcoded values above (`STOP`, `TARGET`, `DEFAULT_STOP`, `DEFAULT_TARGET`) are only hit for setups outside the 68-type coverage — currently new/rare level types that haven't accumulated N=20 resolved trades yet.
