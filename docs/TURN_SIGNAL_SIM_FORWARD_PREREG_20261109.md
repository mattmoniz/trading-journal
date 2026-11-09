# Turn signal: Sim1 forward test (frozen 2026-11-09 BEFORE any order; user: "I want to see trades fire ... like in Sierra chart")

Code: detector `scripts/vacuum_sim/turn_signal.py` (shared by research and live), live daemon `scripts/vacuum_live/shadow.py` (table `turn_signal_events`), orders `server/services/turnSignalOrders.js` (setup types `VACUUM_EXP_TURN_LONG/SHORT`, so every `VACUUM_EXP_` wire applies). Phase-1 counts and recall findings: `docs/OPEN_THREADS.md` 2026-11-09 16:00 entry, `scratch/vacuum_sim_20261108/turn_signal_phase1_output.txt`. The trader's words define it: entry / exit points that mark the END of the last move and the BEGINNING of a new one, not a setup.

## What is logged (everything, so the definition can be revised without losing data)
`S1_CLUSTER` (onset of >= 3 of the last 5 bars fast by the user's own pace rule), `S1_SPIKE` (cluster + Ratio and ROC through their Bollinger bands; strict or "a poke in one and a close poke in the other"; hook delay when it occurs), `S2_IGNITION` (strict thrust onset, linked backward to the latest opposite Stage 1 within 30 bars, `held` = its extreme not breached by more than 0.5 x EMA10(TR)). Extension = direction x (close - close 240 min earlier) / ADR20. All causal at the event's own bar. The live Ratio is the trade-count PROXY (live depth is not ingested); the real-depth recall check showed the climax is recognised by the cluster, the Ratio + ROC spike belongs to the ignition.

## The ORDER rule (fixed)
A Stage-2 ignition whose linked Stage 1 is the OPPOSITE direction, within 30 bars, HELD, with Stage-1 extension >= the top-tercile cutoff of the same track (data-derived: the explore real-depth distribution until the table holds 60 Stage-1 events per track, then the rolling distribution of the table's own PRIOR sessions; starting cutoffs 0.31 ADR20 RTH / 0.25 ADR20 Globex). Globex from 18:30 ET (system no-trade at the reopen), RTH 09:35-15:50, one position at a time per track, fresh signals only (<= 150 s). Orders: 1 MNQ market at the next bar open, stop = signal close -/+ 2.5 x EMA10(TR), no target, exit 30 bars after the entry bar or the hard flat, SIM ONLY (sim-profile exemption). Expected frequency from the 68 real-depth explore sessions: 22 qualifying events (RTH 7 on 6 sessions, Globex 15 on 10 sessions), about one order every three sessions.

## The built-in control (what makes it a test and not just orders)
The daemon scores the same 30-bar outcome (no stop / 2.5 x EMA10(TR) stop, 2 pt cost) for EVERY `S2_IGNITION`, qualified or not. The question the trader's hypothesis poses: do ignitions that follow a held, extended opposite climax do better than ignitions that do not?

## Judgement (forward only, no peeking before the floor; the sessions 2026-11-05, 11-06 and 11-09 were seen in the definition work and are EXCLUDED from every evaluation)
Floor: 20 qualified (taken) events on at least 12 distinct days, counted from the first order. Then: (1) day-blocked bootstrap of the mean net per qualified event after cost, lower 90% bound > 0 AND (2) qualified minus unqualified ignitions paired by day, lower 90% bound > 0, AND (3) the result survives dropping the best session. CONFIRM: all three. FAIL: upper 90% bound of (2) below 0, or of (1) below 0, at the floor. CONTINUE otherwise, re-look at 40 events. The order rule is NOT tuned during the test (cutoff method, windows, stop and exit stay fixed).

## Next-step tree (co-022)
Confirm: extend with the trader's exits (ROC hook, zero-cross) and the ratchet as arms (register rows 28-30), then a size / roster decision with the user. Fail: autopsy by track, extension tercile, time of day, linked Stage-1 kind; park (co-025), keep logging. Continue: nothing changes.

## Known limits (stated before data)
Proxy Ratio live; Stage 1 recall on the trader's seen examples was poor with the v1 spike definition (the cluster variant is the live Stage 1); about one order per three sessions means 20 events take roughly 3 months; one MNQ on a sim account, outcomes are small-sample and heavy-tailed; the 18:19 and 04:36 examples are 11-05 / 11-06 sessions (seen, excluded).
