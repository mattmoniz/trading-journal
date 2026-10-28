# Audit of Gemini's review of the trader's exit plan (2026-10-28)

Plan reviewed (user, verbatim): "We can start with a 65 point profit target, but really we should try and take profit at one level and then have a second runner that traverses value or goes to some other major LVN."
Source: `scratch/antigravity_response_exit_plan_20261028.md` (Gemini 3.8 Flash (High), ALLOW_FLASH=1, read-only design review). The file is TRUNCATED AT THE START again (begins mid-sentence in section 1.2). Web searches I ran found no rigorous published evidence for LVN acceleration or for the 80% rule (only vendor/community pages and a ~62% forum anecdote); scale-out sources say the effect depends on how often the runner catches a move.

## Verified / adopt
- A runner needs two contracts; the trader trades one. Model the legs as separate single-contract rules on identical entries (the two-lot book is their sum; per contract it is their average).
- 65 points is about 0.22 x ATR20 (mean ATR20 about 293 points) and is a static number: keep it as one pre-specified arm, compare with a data-derived size.
- Runner-stop trap: moving the runner's stop on progress is the "arm a stop" mechanism that failed here under realistic fills; the stop stays at its original structural level, later adjustments only on completed-bar structure, effective the next bar, with slippage. This matches the project's own exit record.
- Exits cannot create edge from entries with none (optional stopping for bounded rules on a driftless process; true up to costs and any real serial structure): an exit study on null entries measures drag and reshapes the distribution. Wait for an entry construct before optimizing exits; a diagnostic placebo now is fine.
- Structural targets are unproven (our own POC/LVN null: 922 events, 0 of 6 cells; floor-to-POC 19.6% vs 17.0%); treat them as test arms against duration-matched time exits.
- Evaluate on payoff distribution, not win rate; a variance-penalizing summary (it suggests Omega / a mean-variance utility, labelled "CRRA" loosely) fits a trader who wants frequent small wins and occasional home runs.

## Wrong / weak
- **Its expected win rate for +65/-40 on null entries (40-48%) is internally inconsistent:** a driftless price hits +65 before -40 with probability 40/105 = 38.1%; 48% would imply a large edge. Its "average win/loss 1.3-1.5:1" also does not match 65/40 = 1.63. Several of its distribution numbers are unlabelled guesses.
- **The -40 stop is its invention.** The user gave no stop; the whole outcome shape depends on it, so the stop must be an explicit arm or a pre-registered structural rule.
- **Its LVN rule is full of hand-tuned constants** (Gaussian sigma 4 points, a +/-5-point minimum window, a 0.40 prominence ratio, a 20-point floor, "next LVN at least max(T1, 20) away"), which breaks the no-static-thresholds rule and differs from the Sierra valley rule already tested; any LVN definition has to be data-derived or the Sierra rule used as-is for comparability.
- **"Disqualify the traversal arm when the distance is under T1"** breaks the pairing between arms; all arms must be evaluated on the common subset of trades.
- **Power:** it assumes a trade SD of 35 points. A +65/-40 binary-like outcome has SD about 51 points, so resolving 5 points/trade needs about (2.8 x 51 / 5)^2 = 816 trades, not 384 (if arms are not highly correlated); an entry signal at 0.5 trades/day over 850 sessions gives about 425, which is underpowered for a 5-point difference.
- **Its stated placebo drag "-2.5 to -4.0 points per trade"** was asserted before any run; measured below it is smaller (-0.4 to -1.5 points).
- Its "target must be penetrated by 1 tick AND 1 tick slippage" is a harsher fill model than the project's convention (conservative, double-counted).
- The "expected 25% win rate -> 10 straight losses is ~100%" statement is a binomial guess; it is directionally right but unverified.

## The diagnostic I ran (placebo, NOT a hypothesis test): `exit_placebo_diagnostic.py`
898 full RTH sessions, 20 random-time random-direction entries per session (10:00-14:00), +65 target, realistic fills (next-bar-open entry +1 tick, stop gaps at the open, 1 tick slippage on exits, flatten at the 15:58 open), $2 round trip (=1.0 point). Session-clustered SE shown.
| stop | zero-drift win% | actual win% | target% | stop% | flat% | mean net points | mean $ per trade |
|---|---|---|---|---|---|---|---|
| 30 | 31.6 | 33.0 | 28.2 | 65.4 | 6.4 | -1.48 (SE 0.37) | -2.96 |
| 40 | 38.1 | 39.9 | 33.5 | 56.9 | 9.7 | -1.09 (SE 0.40) | -2.18 |
| 65 | 50.0 | 50.1 | 41.0 | 40.4 | 18.6 | -0.71 (SE 0.43) | -1.42 |
| 100 | 60.6 | 56.4 | 45.4 | 24.9 | 29.7 | -0.43 (SE 0.54) | -0.86 |
Reading: on entries with no edge the +65 geometry wins about what the gambler's-ruin arithmetic says (slightly above, since NQ drifted up) and loses roughly the round-trip cost (about 1.5 points all-in); wider stops lose less only because more trades end at the flatten. So any positive result for this exit on AMT entries must beat these numbers, and a first target alone cannot make a zero-edge entry profitable.
