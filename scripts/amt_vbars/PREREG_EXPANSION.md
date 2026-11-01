# Pre-registration: is the tell an expansion detector (bigger excursion in BOTH directions) with a near coin-flip side? (written 2026-11-01 BEFORE any outcome)

Origin: user "every time it fired it was at a good point, great entries, there is something it is seeing"; DeepSeek method audit (scratch/deepseek_response_tell_audit_20261101.md, item 2 and 3). The existing descriptive file (`descriptive_extension_output.txt`, not pre-registered, no intervals) shows TELL5 MFE 0.230 / MAE 0.219 ATR20 against moving-only 0.192 / 0.191 and favorable beating adverse only 51.5 vs 50.0 percent: larger excursions on BOTH sides. This tests that with intervals and a node-isolating control. Explore only (`decision_points_explore.csv`, 41,272 rows = every 10th completed bar 10:00-14:30 per side, same population as the descriptive file; the AMT tell hold-out is not extracted). Script `run_expansion.py`, one run.

## Quantities (per decision point, ATR20 units, 60-minute window, from the file)
- E = mfe + mae (the window's high-low travel measured from the entry; unsigned, direction-free).
- A = mfe - mae (directional asymmetry in the tell direction d; zero if the side is a coin flip).
- B = brk (a close beyond the range edge on side d within the window), fwd (signed 60-minute move).

## Arms
- TELL = ncomp == 5 (the descriptive file's definition).
- CONTROL_MOVING = moving and ncomp < 5 (the descriptive file's control).
- CONTROL_NONODE = nodes false and fast, flip, osc, strides all true (every non-node component present, no node ladder): isolates what the ladder adds beyond flow, oscillation and strides.
All arms use the same sampling (the file's every-10th-bar points).

## Statistics (per-point means = sum/N, never day-weighted; day-blocked bootstrap for intervals only, 2000 draws, seeded)
Within the three `stratum` classes (distance to the boundary, already in the file, data-derived terciles) take the difference of arm means in each stratum and report the tell-mix-weighted average difference (stratum weights = the tell's own stratum counts) with a day-blocked CI of that weighted difference. Report it for E (primary), A and fwd (secondary), and brk rate. Counts first (points, dates per arm and stratum). Chronological halves by median date.

## Reading rule (stated before the run)
- EXPANSION DETECTOR: tell minus CONTROL_MOVING on E > 0 with the CI excluding zero, same sign in both halves, >= 200 tell points on >= 100 dates. Tell minus CONTROL_NONODE on E reported separately as the ladder's marginal contribution (>0 with CI excluding zero = the ladder adds expansion information beyond the flow components; otherwise not shown).
- DIRECTION: tell minus control on A with CI excluding zero would mean a real side signal; a CI around zero means the side is not shown beyond the control.
Anything else = not shown; the CI half-width is the stated resolution. Not tested: monetization (an expansion with an unknown side is not a trade rule); a straddle/two-sided structure is the user's own trade idea and needs its own pre-registration with realistic fills and costs.
