# The user's exact Sierra Chart indicator settings for the 500V liquidity-vacuum idea (from 7 screenshots, 2026-11-08)

Chart: "NQZ26[M]/MNQZ26 [CV][M] 500 Volume #2" (the meaning of the combined symbol notation is NOT confirmed: ask the user which symbol's market depth feeds the depth study; only NQ depth files exist locally, no MNQ).

| Study (ID) | Settings (as shown) | Role |
|---|---|---|
| Bid & Ask Depth Bars (ID:5, hidden, region 3) | Calculation Mode = **Sum**; Automatically Set Draw Styles = Yes; Draw Zeros = Yes; based on the main price graph | per-bar resting depth |
| EMA-BIDASK-DEPTH (ID:25, Moving Average Exponential, hidden) | Input Data = **Close** (of study ID:5); Length = **10** | smoothed depth (the denominator) |
| True Range (ID:18, hidden) | no inputs, the standard Sierra True Range, unmodified | TR |
| EMA-True Range (ID:23, Moving Average Exponential, hidden) | Input Data = TR; Length = **10**; based on ID:18 | smoothed true range (the numerator) |
| Study Subgraphs Divide/Ratio (ID:2, region 2) | Input Study 1 = ID23.SG1 (EMA-True Range); Input Study 2 = ID25.SG1 (EMA-BIDASK-DEPTH); Study 2 Subgraph Offset = 0; Draw Zeros = No | **Ratio = EMA10(TR) / EMA10(Bid&Ask Depth Close)** |
| Bollinger Bands-Divide/Ratio (ID:8) | not in the screenshots; the notes say 50-period SMA +- 1.5 sigma | bands on the Ratio |
| Rate Of Change - Points (ID:28, region 5) | Input Data = **Last**; Length = **10** | ROC10 = Last_t - Last_{t-10} |
| Bollinger Bands-ROC (ID:46, region 5) | Input Data = ROC (ID:28); Length = **50**; Standard Deviations = **2**; Moving Average Type = **Simple Moving Avg** | bands on ROC10 |
| Bar Time Duration (ID:?; CalcOrder 2), Clock - RealTime (ID:10) | listed in the study stack, settings not shown | duration gate |

## What Sierra's own documentation says (https://www.sierrachart.com/index.php?page=doc%2FStudiesReference.php&ID=213, fetched 2026-11-08)
- The study creates candlestick bars from the Bid and Ask market depth quantity totals that occur DURING THE FORMATION of each chart bar; intraday charts only; "these calculations are performed individually for each chart bar".
- Mode **Sum** = Total Ask Quantities + Total Bid Quantities (the sum over the depth levels counted). Sum Bid Side / Sum Ask Side are separate modes.
- The number of levels used is set in Chart >> Chart Settings >> Market Depth >> "Number of Levels for Bid/Ask Depth Calculations" (the Global Settings "Max Depth Levels" must be 0 or at least that number). **The user's value is NOT known yet.**
- The page does not say how the Open / High / Low / Close subgraphs are derived inside a bar ("display the highest and lowest values of the calculated formulas"); the user's EMA takes the CLOSE subgraph. ASSUMPTION to verify (hr-027): Close = the Sum at the last depth update of the bar. Check against numbers read off the user's chart.

## Consequences for the build
- Ratio is exactly reproducible only from the recorded depth (`NQ*.depth` files from mid-June 2026) once the number of levels is known; every earlier date needs the V0 trade-count proxy, which is a DIFFERENT quantity (state this in every result).
- ROC10 on the chart = Last_t - Last_{t-10} with Sierra's Bollinger (SMA 50, 2 SD; Sierra's standard-deviation convention to be confirmed, population assumed).
- CORRECTION 2026-11-08: Nov 6 check with this definition: ROC10 Z = -2.32 at 12:36:52 (split bars) and -2.24 (whole bars), i.e. it DID breach the -2 SD band; an earlier note saying the V0 M1 rule would not have fired was an artifact of printing every third row.

## Added by the user 2026-11-08 (verbal): the role of Bar Time Duration
"There is an element of bar time duration that helps determine INSTITUTIONAL INVOLVEMENT." Reading (to confirm with the user): a 500-contract bar that completes in seconds means size is being hit fast (the notes: 15 s or less in RTH is about 33+ contracts per second, fast institutional sweeps; overnight is judged relative to its own pace, dt <= 0.65 x SMA50 and <= 120 s, a halving of duration = urgency). It separates two situations the Ratio alone cannot: a thin book with NO urgency (Ratio high, slow bars: nothing is happening) from a thin book being swept (Ratio high, fast bars: institutions are in). TEST DESIGN CONSEQUENCE: duration is not only a gate, it is a hypothesis to test as its own pre-registered contrast: among Ratio + ROC expansions, forward drift of FAST-duration events versus SLOW-duration events (same session and clock hour), and an ablation with and without the duration gate.

## Depth-levels calibration on Nov 6 (2026-11-09, `scripts/vacuum_sim/depth_calibrate.py`, no outcome read)
Book rebuilt from `/mnt/c/SierraChart-DTC/Data/MarketDepthData/NQZ26.2026-11-06.depth` (70.7 M records, snapshot every 10 minutes); depth = the sum of the top-L bid and top-L ask quantities at each 500V bar CLOSE (Sierra 'Bid & Ask Depth Bars', Sum, Close subgraph); Ratio = EMA10(TR) / EMA10(depth). Result: only the FULL recorded book (L = all) reproduces the user's magnitude: Ratio 0.033 at 12:36 then 0.045 at 12:37 and 0.041 at 12:40 (user: about 0.040 -> 0.052), depth about 460 contracts at 12:37, stall 13:00-14:37 mean 0.034 with 22 percent of bars under 0.030 (user: under 0.030). L=50 gives 0.07-0.09, L=20 about 0.2, L=10 about 0.4, L=5 about 1.0 (all too large by 2x to 25x). So the user's chart sums a LARGE number of levels (or the whole recorded book); the exact setting is still unconfirmed (ask the user to read Chart Settings >> Market Depth >> Number of Levels), and the match is about 15-25 percent low, plausibly the bar construction (split vs whole) or the study's in-bar aggregation. One day only; do not tune further on it.
