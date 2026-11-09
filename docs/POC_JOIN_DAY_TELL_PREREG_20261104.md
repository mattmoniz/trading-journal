# Pre-registration (descriptive): are POC rotation joins a tell of an eventual kind of day? (written 2026-11-04 BEFORE any join was linked to a day shape)

STATUS: FROZEN. User (2026-11-04): "Are POC rotation joins a tell of an eventual certain kind of day?" Events come from the REAL detector (`detectSignalEvents` in `server/services/pocRotationService.js`, via `scripts/lib/pocJoinLoader.mjs`, R = 65, default construction), replayed on `price_bars_primary` 1-minute bars for 2023-03-07..2026-10-19; day shapes from the exact 500-contract bars (explore and hold-out files, `profile_shape.py`). Day-level N about 880. Ledger family `poc_join_day_tell_20261104`, counted tests 4; nothing is live.
## 1. Per day, causal measures (RTH 09:30-16:00 events by their entry time)
JOINS_BY_t = number of joins whose entry bar is at or before t (t = 11:00, 13:00, close); LONGS and SHORTS; first join time. Baseline measure the joins must beat (they are a subset of rotations): ROT_BY_t = the number of confirmed R = 65 rotation legs by t (`detectRotationLegs`).
## 2. Targets (final RTH profile, frozen cuts from the explore window)
Multi-hump (bimodality >= 0.365), P/b vs D (letter by the value-area midpoint), strong B (>= 0.61) vs strong D (<= 0.09 with letter D).
## 3. Counted tests (4)
T1: AUC of JOINS_BY_13:00 for the final multi-hump flag; T2: AUC of JOINS_BY_11:00 for P/b vs D; T3: the same two AUCs for ROT_BY_t; T3 is counted as the contrast (JOINS minus ROT) for the multi-hump flag at 13:00 with a week-block bootstrap CI; T4: share of days that END multi-hump among days with at least 2 joins by 13:00 versus days with none, with a week-block CI. AUC 0.5 = no information; a join count adds something only if it beats the rotation-count baseline.
## 4. Printed, uncounted
Rate of each final letter and of multi-hump by number of joins (0, 1, 2, 3+) by 11:00 and by 13:00; by direction mix (all long, all short, mixed); first-join time terciles; the explore and hold-out windows separately (the hold-out window is NOT sealed for this family: it is read once, as a second window, and reported beside the explore window with the look logged).
## 5. Limits
Joins and rotations are both volatility-driven (a wide day has more of both), so a join count that only tracks range is not a tell of SHAPE; the DB 1-minute bars have known degraded-density periods; day shapes are hindsight labels; a tell is informative only if available before the shape is, hence the t = 11:00 / 13:00 versions.
