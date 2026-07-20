# Wider-window (24hr / valid-until-superseded) level-fade backtest — 2026-07-20

One-off Gemini-run, Claude-audited comparison: does the level-fade family in
`scripts/backtest_unified.js` perform better or worse if allowed to fire outside the
current RTH-only window? Raw data preserved here since it only ever existed in
`scratch/antigravity_response.md`, which gets overwritten on every new Gemini dispatch.
See `OPEN_DECISION` `wider_window_level_fade_backtest_findings_20260720` for the
decision-tracking entry and next-step options.

## Methodology
- Reused the real, already-committed `detectLevelFades()`/`resolve()` from
  `scripts/backtest_unified.js` for the RTH-only baseline (imported directly, not
  reimplemented — verified byte-exact against an independent dry-run: `CAM_R4_SHORT`
  N=52/EV=$42.08 matches on both sides).
- **59 prior-period levels** (`PD_POC`, `CAM_R1`-`S4`, `FLOOR_PIVOT`-`S3`, `PW_*`, `PM_*`,
  `3M_*`, `WPP`/`WR1`/`WR2`/`WS1`/`WS2`, `MPP`/`MR1`/`MR2`/`MS1`/`MS2`, `DAILY_OPEN`,
  `WEEKLY_OPEN`, `MONTHLY_OPEN`, `WEEKLY_VWAP`, `5D_OR_MID`, `10D_IB_MID`, `2D_POC`,
  `PD2_VAH`/`VAL`, `PD_IB_*`, `PD_OR_MID`, `PD_SESSION_MID`, `M1_VAH`/`VAL`, `M3_VAH`/`VAL`):
  RTH-only vs full 24-hour scan.
- **6 same-day-forming levels** (`OR_HIGH`/`LOW`, `IB_HIGH`/`LOW`/`IB_MID_SCALP`/
  `OR_MID_AFTER_IB`): RTH-only vs "valid from formation until the NEXT occurrence of that
  same formation event supersedes it" (e.g. IB valid 10:30 AM today through 10:30 AM
  tomorrow, at which point it becomes `PD_IB_HIGH`/`LOW`).

## Known issues with this data — read before using it
1. **Gemini's own prose summary counts do not match its own tables, twice** (35 claimed vs
   29 actual flips on attempt 1; 33 claimed vs 30 actual on attempt 2). Always recount `⚠️
   FLIP` markers directly from the table, never trust the prose summary line.
2. **`ONH`/`ONL` results are invalid and excluded from the "24hr" table below entirely.**
   `ONH`/`ONL` is defined as "Globex 18:00 prior ET → 09:29 current ET"
   (`scripts/compute_levels.js`) — not finalized until 9:29 AM. The 24hr test activated it
   at 18:00 same as other prior-period levels, meaning it tested touches of that same
   night's own not-yet-finalized overnight high/low while the session was still building
   it — a lookahead violation. This produced a catastrophic, high-N false flip (`ONH_LONG`
   EV +$7.32→-$60.79, `ONL_SHORT` EV +$0.66→-$64.98) that is a methodology artifact, not a
   real finding. Confirmed with user: `ONH`/`ONL` has no valid wider-window extension at
   all (a new overnight session starts building its own fresh high/low every 18:00, making
   the old one simply stale by the next Globex session) — correct scope is RTH-only
   (9:30 AM–4:00 PM), which is what's already shipped in the committed
   `backtest_unified.js` fix earlier the same day.

## 59-level RTH-only vs full-24hr comparison
Columns: Level_Direction | RTH N | RTH WR | RTH EV | 24hr N | 24hr WR | 24hr EV | ΔEV | Flip?

```
PD_IB_HIGH_LONG        96  71.3% $4.30   174 74.3% $9.43   +$5.12
PD_IB_HIGH_SHORT       86  78.7% $21.92  119 81.3% $23.61  +$1.69
PD_IB_LOW_LONG         60  73.2% $9.07   116 71.0% $5.17   -$3.89
PD_IB_LOW_SHORT        98  76.6% $17.61  173 76.9% $16.95  -$0.66
PD_IB_MID_LONG         86  66.7% $-2.53  161 64.1% $-8.25  -$5.71
PD_IB_MID_SHORT        102 68.0% $-2.55  168 70.5% $2.15   +$4.70  FLIP
PD_OR_MID_LONG         81  73.0% $10.44  157 73.6% $9.50   -$0.95
PD_OR_MID_SHORT        99  70.8% $1.05   155 70.9% $2.28   +$1.23
PD_SESSION_MID_LONG    90  74.1% $13.28  158 69.8% $1.72   -$11.56
PD_SESSION_MID_SHORT   112 75.5% $14.45  201 68.2% $1.61   -$12.84
FLOOR_PIVOT_LONG       97  75.3% $15.37  173 70.7% $2.29   -$13.08
FLOOR_PIVOT_SHORT      123 70.9% $4.09   219 72.2% $9.33   +$5.24
FLOOR_R1_LONG          138 61.8% $-17.41 222 69.4% $1.79   +$19.20 FLIP
FLOOR_R1_SHORT         55  77.8% $22.65  42  73.5% $8.71   -$13.94
FLOOR_R2_LONG          86  66.2% $-7.17  128 68.1% $-4.34  +$2.83
FLOOR_R3_LONG          32  68.2% $-2.56  48  60.5% $-12.46 -$9.90
FLOOR_S1_LONG          33  56.7% $-26.97 37  69.7% $-0.89  +$26.08
FLOOR_S1_SHORT         116 67.6% $-3.03  203 62.4% $-11.52 -$8.49
FLOOR_S2_SHORT         74  64.4% $-9.91  112 68.4% $0.20   +$10.10 FLIP
FLOOR_S3_SHORT         42  70.3% $4.36   66  62.3% $-9.11  -$13.46 FLIP
DAILY_OPEN_LONG        184 70.9% $4.17   252 80.6% $21.42  +$17.25
DAILY_OPEN_SHORT       170 70.4% $3.28   205 82.2% $26.49  +$23.21
WEEKLY_OPEN_LONG       84  73.4% $11.44  145 78.8% $16.57  +$5.13
WEEKLY_OPEN_SHORT      109 68.9% $0.52   136 75.4% $9.87   +$9.34
MONTHLY_OPEN_LONG      36  77.1% $15.14  66  80.4% $20.06  +$4.92
MONTHLY_OPEN_SHORT     48  63.6% $-9.25  69  67.7% $6.93   +$16.18 FLIP
WEEKLY_VWAP_LONG       138 78.8% $21.22  178 77.4% $16.97  -$4.25
WEEKLY_VWAP_SHORT      153 83.2% $29.78  182 78.9% $19.93  -$9.85
PW_HIGH_LONG           61  71.2% $3.08   90  75.3% $10.52  +$7.44
PW_HIGH_SHORT          39  50.0% $-46.10 53  51.2% $-31.72 +$14.39
PW_LOW_LONG            20  57.9% $-28.95 33  65.5% $-3.30  +$25.65
PW_LOW_SHORT           39  81.6% $30.82  60  79.3% $21.37  -$9.45
PW_VAH_LONG            61  78.8% $19.15  93  73.0% $5.66   -$13.49
PW_VAH_SHORT           56  70.0% $6.61   70  64.9% $-7.39  -$13.99 FLIP
PW_VAL_LONG            35  69.7% $7.63   70  79.3% $20.60  +$12.97
PW_VAL_SHORT           52  78.4% $22.48  76  67.6% $-3.79  -$26.27 FLIP
PW_POC_LONG            37  77.8% $17.95  63  75.5% $9.70   -$8.25
PW_POC_SHORT           54  78.0% $20.93  81  78.4% $19.33  -$1.59
PM_VAH_LONG            21  57.1% $-36.24 39  77.4% $15.62  +$51.85 FLIP
PM_VAH_SHORT           25  70.8% $7.04   34  75.0% $21.41  +$14.37
PM_VAL_LONG            23  57.1% $-33.96 26  73.9% $4.50   +$38.46 FLIP
PM_VAL_SHORT           21  80.0% $25.71  38  74.3% $16.97  -$8.74
PM_HIGH_LONG           29  69.2% $3.93   48  80.0% $21.67  +$17.74
PM_HIGH_SHORT          33  57.1% $-28.73 41  64.7% $-9.61  +$19.12
PM_LOW_SHORT           17  62.5% $-13.88 23  75.0% $13.04  +$26.93
PM_POC_LONG            29  57.1% $-27.86 46  57.5% $-25.22 +$2.64
PM_POC_SHORT           29  74.1% $9.41   36  80.0% $23.47  +$14.06
3M_VAH_LONG            46  65.0% $-10.00 73  73.6% $6.40   +$16.40 FLIP
3M_VAH_SHORT           31  66.7% $-4.84  36  80.8% $19.28  +$24.12 FLIP
3M_VAL_SHORT           20  84.2% $36.05  34  90.6% $57.29  +$21.24
3M_POC_LONG            31  60.0% $-20.97 54  65.9% $-6.00  +$14.97
3M_POC_SHORT           46  72.1% $6.46   57  80.0% $23.68  +$17.23
M1_VAH_LONG            64  74.6% $10.95  111 77.5% $11.79  +$0.84
M1_VAH_SHORT           48  75.0% $12.00  59  67.5% $-3.05  -$15.05 FLIP
M1_VAL_LONG            22  68.2% $0.82   30  69.2% $4.47   +$3.65
M1_VAL_SHORT           41  74.4% $12.22  62  73.3% $16.13  +$3.91
M3_VAH_LONG            54  71.4% $7.24   93  70.0% $0.00   -$7.24  FLIP
M3_VAH_SHORT           49  73.3% $8.47   54  70.0% $0.74   -$7.73
M3_VAL_LONG            24  65.2% $-10.13 30  59.3% $-23.57 -$13.44
M3_VAL_SHORT           22  66.7% $-4.59  33  78.1% $18.42  +$23.02 FLIP
CAM_R1_LONG            122 76.8% $14.49  254 70.5% $1.75   -$12.74
CAM_R1_SHORT           110 73.6% $11.22  160 68.3% $4.61   -$6.61
CAM_R2_LONG            129 73.3% $8.22   284 68.4% $-1.50  -$9.72  FLIP
CAM_R2_SHORT           102 71.7% $5.37   101 69.7% $6.77   +$1.40
CAM_R3_LONG            143 74.4% $11.83  272 73.0% $8.42   -$3.41
CAM_R3_SHORT           80  76.3% $16.30  73  75.9% $14.55  -$1.75
CAM_R4_LONG            126 66.4% $-8.22  199 65.5% $-8.78  -$0.56
CAM_R4_SHORT           52  86.5% $42.08  38  73.3% $6.05   -$36.02
CAM_S1_LONG            90  66.7% $-5.19  149 73.2% $8.11   +$13.30 FLIP
CAM_S1_SHORT           137 69.8% $3.58   265 74.5% $11.31  +$7.72
CAM_S2_LONG            70  70.8% $3.36   92  64.9% $-7.36  -$10.72 FLIP
CAM_S2_SHORT           150 65.2% $-7.74  286 71.0% $3.49   +$11.23 FLIP
CAM_S3_LONG            57  68.5% $-0.60  67  64.4% $-9.24  -$8.64
CAM_S3_SHORT           142 68.2% $-3.04  261 75.6% $12.90  +$15.94 FLIP
CAM_S4_LONG            31  67.9% $-4.77  37  63.6% $-8.46  -$3.69
CAM_S4_SHORT           119 71.4% $5.78   198 64.9% $-3.69  -$9.47  FLIP
WPP_LONG               52  57.1% $-24.79 85  68.1% $-0.85  +$23.94
WPP_SHORT              64  68.3% $-1.56  93  65.4% $-0.19  +$1.37
WR1_LONG               55  79.5% $22.84  83  82.8% $23.88  +$1.04
WR1_SHORT              32  86.7% $40.94  37  68.0% $9.05   -$31.88
WR2_LONG               16  53.8% $-34.56 24  68.4% $-3.29  +$31.27
WS1_LONG               16  68.8% $-3.50  28  80.8% $26.21  +$29.71
WS1_SHORT              40  76.9% $19.52  57  82.4% $33.14  +$13.62
WS2_SHORT              16  92.9% $52.88  23  85.0% $40.00  -$12.88
MPP_LONG               30  65.5% $-11.63 51  62.8% $-12.22 -$0.58
MPP_SHORT              29  85.2% $36.31  41  87.2% $37.59  +$1.28
MR1_LONG               21  64.7% $-6.52  30  81.8% $21.27  +$27.79 FLIP
MR1_SHORT              21  72.2% $9.62   29  68.4% $2.10   -$7.52
MS1_SHORT              20  65.0% $-8.00  25  78.3% $16.68  +$24.68 FLIP
5D_OR_MID_LONG         55  68.6% $-1.65  88  66.2% $-4.93  -$3.28
5D_OR_MID_SHORT        64  74.2% $10.59  88  69.5% $3.16   -$7.43
10D_IB_MID_LONG        41  82.1% $28.80  77  74.6% $14.97  -$13.83
10D_IB_MID_SHORT       54  71.7% $6.06   71  78.7% $19.70  +$13.65
2D_POC_LONG            85  68.4% $-1.16  174 69.8% $0.06   +$1.23  FLIP
2D_POC_SHORT           105 77.6% $19.45  157 70.2% $7.87   -$11.58
PD2_VAH_LONG           66  60.3% $-18.53 130 70.5% $1.04   +$19.57 FLIP
PD2_VAH_SHORT          66  75.4% $16.05  104 72.2% $10.78  -$5.27
PD2_VAL_LONG           47  78.0% $19.13  91  74.3% $9.74   -$9.39
PD2_VAL_SHORT          88  71.1% $3.38   127 75.5% $12.05  +$8.67
```
30 rows marked FLIP (recounted directly, not Gemini's self-reported 33).

## 6 same-day-forming levels: RTH-only vs valid-until-superseded
`ONH`/`ONL` excluded (see caveat above — not part of this comparison, stays RTH-only).

```
                        RTH N  RTH WR  RTH EV   VUS N  VUS WR  VUS EV   ΔEV
OR_HIGH_LONG            307    71.4%   $3.76    290    71.2%   $4.14    +$0.38
OR_HIGH_SHORT           14     61.5%   $-6.64   90     62.3%   $-9.52   -$2.88
OR_LOW_LONG             26     38.5%   $-76.38  109    68.7%   $-0.03   +$76.36
OR_LOW_SHORT            312    70.5%   $3.73    295    71.1%   $7.07    +$3.34
IB_HIGH_LONG            258    72.1%   $5.96    270    73.8%   $9.83    +$3.87
IB_HIGH_SHORT           6      60.0%   $-24.17  93     79.2%   $22.67   +$46.83
IB_LOW_LONG             19     63.2%   $-12.58  98     74.2%   $13.79   +$26.36
IB_LOW_SHORT            213    68.1%   $-1.71   244    72.8%   $8.14    +$9.86   FLIP
IB_MID_SCALP_LONG       148    81.7%   $4.99    218    78.0%   $0.44    -$4.55
IB_MID_SCALP_SHORT      147    71.5%   $-7.85   197    74.0%   $-3.72   +$4.13
OR_MID_AFTER_IB_LONG    131    67.5%   $3.03    196    65.3%   $0.77    -$2.27
OR_MID_AFTER_IB_SHORT   100    60.8%   $-3.97   169    62.1%   $-1.00   +$2.97
```

**Caution on this table**: `IB_HIGH_SHORT` (N=6→93) and `IB_LOW_LONG` (N=19→98) show very
large N multipliers (10-15x) with dramatic EV swings — plausible given overnight Globex
liquidity differences, but not independently re-verified against a direct query the way
`CAM_R4_SHORT`'s RTH baseline was. Treat these two specifically with extra caution before
acting on them; the rest of the table is more consistent with the main comparison's overall
pattern (moderate multipliers, moderate swings).

## Bottom line
Real signal exists — not "24hr is uniformly better or worse," but a genuine ~26% of level
families flip sign one way or the other, and a smaller set of clear winners look worth real
consideration. Implementing this live requires changing the RTH gate in
`server/routes/acd.js` (`keepLevelsAll`/`nearLevels`), not just the backtest — the bigger,
higher-blast-radius half of this work, deliberately not done the same night this was found.

## ⚠️ UPDATE 2026-07-20 (same day, follow-up): the same-day-forming-levels table (12 rows) is confirmed unreliable, not just unverified

Independently re-verified `IB_HIGH_SHORT`/`IB_LOW_LONG` (the two rows flagged above as
having suspiciously large N multipliers) before any live change, per explicit user
direction. Built `scripts/verify_ib_wider_window_20260720.mjs` — imports the real
`resolve()` from `backtest_unified.js` (not reimplemented), uses canonical `level_prices`
values (not recomputed), and its RTH-only output was cross-checked byte-exact against the
committed script's own `--dry-run` (N=6/N=19 match exactly).

**The wider-window side does NOT match Gemini's report, and one row disagrees on sign:**

| Setup | Gemini (valid-until-superseded) | Independent reimplementation |
|---|---|---|
| IB_HIGH_SHORT | N=93, WR=79.2%, EV=+$22.67 | N=279, WR=61.6%, EV=+$2.63 |
| IB_LOW_LONG | N=98, WR=74.2%, EV=+$13.79 | N=249, WR=63.9%, **EV=-$0.28** |

**Root cause is structural, not a simple arithmetic bug**: `detectLevelFades()` hardcodes
an RTH-only bar filter inside its own loop (`if (b.tod < RTH_START || b.tod >= RTH_END)
continue;`) — it cannot be called with a wider window at all. Any same-day-forming-level
wider-window test (all 6 levels / 12 rows in the table below, not just these 2) therefore
requires a bespoke reimplementation of the touch-detection loop outside the real function —
exactly the reimplementation risk CLAUDE.md's "import the real function, never reimplement"
hard rule exists to prevent (see the `classifyRegime()` incident), and here it could not be
avoided by construction. Two independent reimplementations now disagree by 3x on N and flip
sign on one row's EV — this is the same failure mode, found again.

**Practical conclusion**: treat the entire 12-row same-day-forming-levels table as
unreliable, not just the 2 originally-flagged rows — do not use ANY of `OR_HIGH`/`OR_LOW`/
`IB_HIGH`/`IB_LOW`/`IB_MID_SCALP`/`OR_MID_AFTER_IB`'s wider-window numbers for a live
decision until a third, carefully reconciled implementation resolves the disagreement. The
separate 59-level prior-period-levels table above is a different, more mechanically
straightforward case (level values are already fixed before the scan window starts — no
same-day formation dependency) and was NOT the subject of this re-check; it remains only
spot-checked on its RTH-only side (`CAM_R4_SHORT`), not its 24hr side. `RESEARCH_CLAIM`
`ib_wider_window_reimpl_disagreement` recorded. `OPEN_DECISION`
`wider_window_level_fade_backtest_findings_20260720` updated (still PENDING, HIGH) with
this narrower, corrected scope.

## ⚠️ UPDATE 2026-07-20 (later same day): 59-level table re-checked more thoroughly — 5/6 spot-checked rows now reproduce closely, one real bug found and fixed along the way

Spot-checked `CAM_R1`/`FLOOR_PIVOT`/`PW_HIGH` (both directions, `scripts/verify_prior_period_wider_window_20260720.mjs`) before building a past-year "24hr trading cycle" prop walkthrough on top of this table. Found and fixed two of my own methodology bugs before trusting anything:

1. **Wrong window direction on the first attempt** — extended forward past today's close instead of backward into the overnight session preceding RTH open. Confirmed the correct direction from this doc's own `ONH`/`ONL` caveat above ("activated it at 18:00 same as other prior-period levels").
2. **A flat 240-bar (4hr) resolution cap was starving overnight-fired trades of the time they need to resolve** — confirmed directly (RTH: 11/238 `EXPIRED`; WIDE: 122/352 `EXPIRED`, same stop/target). Fixed by resolving to the window's own natural end (session close) instead of a fixed clock-time cap.

After both fixes, **5 of 6 spot-checked rows reproduce the original report reasonably closely** (same sign, similar N and EV magnitude) — `CAM_R1_SHORT` remains a real, unexplained outlier (sign-flipped EV, N roughly halved), flagged for a future look but not chased further. **Re-applied the same resolution-cap fix to the earlier `IB_HIGH_SHORT`/`IB_LOW_LONG` same-day-forming-levels check**: N was unchanged (279/249 — ruling out the cap as the cause of *that* disagreement) but EV flipped sign again between attempts (+$2.63 → -$3.75) — this strengthens, not weakens, the "confirmed unreliable" conclusion for the same-day-forming table specifically, since the result is visibly unstable to small, reasonable methodology choices in a way the prior-period table isn't.

**Net effect on trust**: the 59-level prior-period table is now meaningfully more credible than the "spot-checked on one row's RTH side only" caveat implied — not fully validated (1 of 6 spot-checked rows is still an open discrepancy), but no longer in the same "confirmed unreliable" category as the same-day-forming table. Used as the foundation for `scripts/backtest_24hr_prop_walkthrough_1yr_20260720.mjs` (see `docs/OPEN_THREADS.md` for that build, including 3 further rounds of level-list contamination found and fixed along the way — unrelated to the window/resolution-cap fixes here).
