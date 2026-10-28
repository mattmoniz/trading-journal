# Passive tracker: IB value-migration states S2 / S3 (frozen 2026-10-28)

Purpose: log the two IB-migration states every night so a result can accumulate with no effort and no peeking. NOT a search: nothing is
evaluated until the look rule below is met. Intraday AMT states are the main research line; this is the background line.

## States (decided at 10:30:00 ET, after the IB bar 10:29 closes; uses only prior VAH/VAL and the 09:30-10:29 bars)
Prior VAH/VAL = 70% value area of the prior full RTH session (`compute_va_fn`, verified against the JS reference).
- S2 (profile-based): IB_VAL/IB_VAH = the 70% value area of the 60 IB bars alone (same function). MIGRATE_UP iff IB_VAL > prior VAH; MIGRATE_DN iff IB_VAH < prior VAL; else OVERLAP.
- S3 (price-only): MIGRATE_UP iff IB low > prior VAH; MIGRATE_DN iff IB high < prior VAL; else OVERLAP. (S3 UP is a subset of S2 UP; the cells overlap.)

## Outcome (starts AT the decision time; the open-to-10:30 move is already known and is not part of it)
y_1030 = (close of the 15:59 bar - open of the 10:30 bar) / ATR20, ATR20 = mean RTH high-low range of the 20 prior full sessions. Also stored: y_oc (09:30 open to 15:59 close) for reference only.
Signed excess for a state = s*(y_1030 - mu): s = +1 for MIGRATE_UP, -1 for MIGRATE_DN; positive = continuation. mu = mean of y_1030 over all eligible forward days up to the look. Per-trade mean = sum/N.

## Data split (fixed now)
- History through 2026-10-26 is in the table but is NOT analysed for S2/S3 outcomes (descriptive counts of states only). It is not evidence and not used to tune anything.
- FORWARD = sessions from 2026-10-27 on. Only forward rows can confirm.

## Look rule (single, frozen)
- Four counted cells: S2-UP, S2-DN, S3-UP, S3-DN (the cells overlap, so no further multiplicity gain is claimed). One-sided alpha 0.0125 per cell (0.05 / 4).
- Interim reads (descriptive only, no CONFIRM or CLOSE authority): when a cell reaches 60 forward state days. A 60-day read can only detect about 0.26 ATR20 (about 75 points).
- DECISION look, once per cell: when the cell reaches 150 forward state days (smallest detectable effect about 0.16 ATR20, about 47 points). CONFIRMED iff the one-sided 98.75% lower bound (day bootstrap, 5000 iterations, seed 20261028) > 0 AND the matched-control excess point estimate > 0. Otherwise NOT CONFIRMED (underpowered for effects below 0.16 ATR20), never "no effect". No CLOSE is declared from forward data below the decision N.
- Matched control at the look: Mahalanobis, K = 5 nearest OVERLAP days, covariates gap, overnight range, prior RTH range, IB range, IB-period return (open 10:30 vs open 09:30), all /ATR20 and all known at 10:30; common-support trim at the 90th percentile of leave-one-out nearest-neighbour distances among OVERLAP days; retained share under 50% = control NOT EVALUABLE.
- A confirmed cell authorizes only a context-lens use and a separate prereg for anything tradeable.
- The nightly job prints counts and "NO DATA YET" until a threshold is met; it never prints an outcome statistic before then (checking nightly cannot cause optional stopping).
