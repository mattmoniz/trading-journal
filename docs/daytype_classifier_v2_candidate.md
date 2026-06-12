# Day-Type Classifier v2 — IB-Based Candidate

**Status: CANDIDATE — NOT VALIDATED, NOT DEPLOYED**
Designed 2026-06-06. Do not wire into caseEngine.js until ground-truth accuracy
of the current v1 classifier is measured and this design is scored against it.

---

## Problem with v1 (current classifier in caseEngine.js)

`classifyDayType` commits at 9:35 ET using only 5 bars and never updates.
Inputs: `openingType` (5-bar), `nl30` (prior-session), `orWidth` (by 10:00),
`asOfMinutes`. All freeze by 10:00. An opening drive that reverses by 10:30
stays labeled TREND all day. Backtested 41% overall, 25% on TREND calls.

---

## Proposed v2 Design

Two phases. Phase 1 is identical to v1 (early signal, low confidence).
Phase 2 fires at 10:30 ET when the Initial Balance closes and overrides Phase 1.

### New inputs required (all available in computeCase by 10:30)

| Input | Source |
|---|---|
| `currentPrice` | last bar close |
| `ibHigh`, `ibLow` | bars filtered to 9:30–10:30 |
| `ibWidth` | ibHigh − ibLow |
| `orHigh`, `orLow` | from acd_daily_log or 9:30–10:00 bars |
| `deltaConf` | confirmedDeltaDir(bars, 3) — must move before classifyDayType call |

### Phase 1: PRE_IB (9:35–10:30 ET) — same logic as v1, lower stated probability

| Condition | Label | Probability |
|---|---|---|
| OpenDrive + NL aligned + wideOR | TREND | 60–70% |
| OPEN_AUCTION or narrowOR | BALANCE | 65% |
| wideOR, no drive | TURBULENT | 50% |
| default | BALANCE | 55% |

Note: probabilities reduced vs v1 to reflect that IB hasn't confirmed anything yet.

### Phase 2: IB_CONFIRMED (10:30 ET+) — IB break overrides Phase 1

Decision tree in priority order:

```
if price > ibHigh:
    TREND (bull)
    probability: 82% if delta aligned (3-bar LONG streak), 70% if not
    playbook: "IB High broken. Lean long — add on holds above IB High.
               Trail stop after T1. 2R+ targets."
    whatWouldChangeIt: "Price closes back below IB High on 3-bar bearish delta"

if price < ibLow:
    TREND (bear)
    probability: 82% if delta aligned (3-bar SHORT streak), 70% if not
    playbook: "IB Low broken. Lean short — add on bounces below IB Low.
               Trail stop after T1. 2R+ targets."
    whatWouldChangeIt: "Price reclaims IB Low on 3-bar bullish delta"

if isDrive AND price crossed back through OR midpoint (drive reversed):
    TURBULENT
    probability: 65%
    playbook: "Opening drive reversed through OR midpoint — trapped inventory.
               Fade session extreme. Reduce size."
    whatWouldChangeIt: "Price reclaims OR midpoint and closes outside IB on volume"

if ibWidth > orWidth * 2.0 AND price still inside IB:
    TURBULENT
    probability: 60%
    playbook: "IB expanded 2x+ OR without directional break — wide rotational day.
               Fade IB extremes. No extension plays."
    whatWouldChangeIt: "Price closes outside IB on above-avg volume with delta"

else (price inside IB, normal expansion):
    BALANCE
    probability: 72%
    playbook: "Price inside IB at 10:30 — range day. Fade IB extremes.
               1–1.5R targets. Stand aside near IB midpoint."
    whatWouldChangeIt: "Price closes outside IB High or IB Low on above-avg volume"
```

### Implementation notes

- `driveReversed` = `isDrive AND ((driveLong AND currentPrice < orMid) OR (!driveLong AND currentPrice > orMid))`
- `deltaConf` must be computed before `classifyDayType` is called (currently computed after — requires reorder)
- `DAYTYPE_LOW_CONFIDENCE` stays `true` throughout v2 until accuracy log validates
- Add `phase: 'PRE_IB' | 'IB_CONFIRMED'` field to return value so UI can show which phase fired

---

## Adoption gate

Do not deploy v2 until:
1. Ground-truth derivation script (derive_day_types.js) is run and backfills `acd_daily_log.day_type`
2. `daily_coaching.js` is fixed to log `intraday_call` from `computeCase(tradeDate, '10:05')`
3. `daytype_accuracy_log` has ≥ 20 sessions of v1 predictions vs ground truth
4. v2 is scored against the same ground truth on historical sessions
5. v2 accuracy > v1 accuracy before deployment

If v2 does not beat v1 on the historical backtest, do not deploy it.
