# Pre-registration: do the direction cues get sharper when the forecast says "busy"? (OPTION 2; designed 2026-11-02, user: "Ok do options 2 and 3"; scripts to be written and run BEFORE any outcome is read; nothing was computed here)

Why: over all moments the direction cues are weak or mechanical. Tell side vs control: tell side breaks first 73.6% vs 60.6% (+13.0 pts), but the NEAR-boundary side explains most of it (near: 85.8% vs 85.0%; far: 29.2% vs 19.9%) (`scripts/amt_vbars/run_first_break_output.txt`, claim `amt_tell_first_break_side_above_control_20261101`). This asks the narrower market-behaviour question the repo requires before any trade rule (hr-057): when more travel is expected, is the move toward the NEARER boundary larger than when travel is expected to be small? Explore only (<= 2025-05-16); sealed window not read.

## Population and variables (frozen)
- Decision points: the research grid (every 10th completed bar 10:00-14:30, one row per bar), both range sides still inside (`trade.inside_range` for both directions), as in the first-break control. Boundaries from `trade.boundary`. d* = the side of the NEARER boundary in ATR20 units (ties dropped and counted).
- Forecast: the walk-forward no-tell model of Amendment 3 at each point; HIGH = above the causal expanding 2/3 quantile of earlier points' forecasts, LOW = below the 1/3 quantile (first 120 dates train-only; the first 2,000 points seed the cutoffs).
- Outcomes (price only): (a) first-break side within 120 minutes (as `PREREG_FIRST_BREAK_SIDE.md`): share where the first break is on d*; (b) signed move toward d*: S30 = d* x (close of the last complete bar within 30 minutes minus the decision close) / ATR20, and S60 likewise.
- Control for drift (lesson of Part A: a side-signed delta vs not-state is drift dominated): report CONDITIONAL MINUS UNCONDITIONAL excess, i.e. mean(S | HIGH) minus mean(S over all points), and the same for LOW, with day-blocked CIs.

## Tests (counted family B1, B2; BH q=0.10; day-blocked bootstrap 3000 seed 20261102; permutation of the HIGH/LOW label across dates 1000 draws; halves by median date)
- B1: share of first breaks on d* is higher in HIGH than in LOW (difference of shares among breaking points). PASS = CI lower > 0, p < 0.05, positive in both halves.
- B2: S30 excess in HIGH minus LOW is above zero. PASS = same rule.
- Uncounted: S60; by the four chronological quarters (cv-033: era flips); the near-versus-far split of B1 (does it hold in the FAR cell, where the tell's lift was?); counts and resolution.

## Reading rules (fixed now)
Both pass in every quarter with >= 30 points -> a pre-registered TRADE rule (entry at d*, stop and exit written first, realistic fills) is the next step, NOT run here. B1 passes and B2 fails -> the cue predicts which edge breaks, not that the move pays (consistent with `BREAK_ENTRY` not shown). Both fail -> direction cues do not sharpen with the forecast; recorded with resolution. No dollar claim. Ledger: one look, tests = 4.
