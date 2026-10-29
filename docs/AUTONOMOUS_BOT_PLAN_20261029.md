# Autonomous decision bot: plan and gates (2026-10-29, for DeepSeek critique)

## The ask (user)
Turn the app into a bot that assesses and fires: judges when to fire and when to hold, uses probabilities and quicker judgement calls, reads order flow and depth, "thinks and fires".

## Where the repo actually is (honest baseline)
- Execution plumbing exists: DTC order placement on simulated accounts (`server/services/sierraChart/`), kill switch (armed per profile, fail-closed on boot), daily-loss gate, reconciliation against the broker, live-roster gate, a log-only ML veto gate. No edge justifies real money yet.
- Evidence for entries is thin and exploratory: the counter-trend-spike with-trend rule is about +12 dollars per session (1 MNQ, S2 re-entry, 38 percent win days, drawdown about 1.8k) tuned by eye on the same sessions; context gates showed no significant benefit; a learned multi-factor gate was worse than none; the ML meta-label checkpoint added no value on unseen trades; most order-flow studies (big orders, bubbles, stuffed orders, delta) were null; shelf/absorption/breakout-state tests were null.
- DATA: 1-minute bars with bid/ask volume (explore 2023-03..2025-05, sealed hold-out after); a tick archive of trades with aggressor side (RTH, 836 sessions); 500-volume bars; ES 1-minute bars. NO market-depth (order book) recording exists anywhere. Depth would have to be recorded going forward (Sierra Chart depth recording) and accumulated for months before any claim can be tested.

## What "judgment" means here (design)
A DECISION ENGINE, not a free-roaming model: every judgment is an explicit, versioned, replayable function.
1. STATE: features from the same single code path as research (prefix-safe context, order flow from ticks, later depth), computed each bar (later each N ticks).
2. CANDIDATES: detectors propose (spike counter-trend, others only if they pass pre-registered tests).
3. PROBABILITIES: for each candidate, calibrated estimates (walk-forward, out-of-sample reliability checked): probability the trade reaches its target distance before its structural stop, expected net after costs with an uncertainty band; ABSTAIN when the band includes zero or the data are thin.
4. FIRE / HOLD / EXIT: fire if expected net minus a safety margin > 0; hold/exit as a sequence of updated probabilities (time-to-event / survival style) but ALWAYS inside hard structural limits (stop at the defended extreme, flatten 15:55, no stop widening); the model may close early, never loosen risk.
5. ARBITER and RISK: one position at a time, daily loss limit, news-window rules, broker-truth reconciliation, kill switch (halting is unilateral, arming needs the user).
6. LEARNING LOOP: every decision logged with its feature vector, probabilities and calibration version; weekly offline recalibration (versioned artifacts), drift monitors, kill criteria; live code only looks up parameters.
7. WHERE AN LLM FITS: offline research assistant, reviewer and explainer; NOT in the tick-by-tick decision loop (latency, non-determinism, cannot be replayed or verified bar by bar).

## Stages and authority (each gate needs evidence written down first)
0. NOW: research + tested framework (done: context module, parity gate with mutation test, calibration store, no-order guard). Sealed look on the frozen claim (user go).
1. SHADOW (no orders): decision engine runs live, logs everything; 40-60 sessions of forward data; parity gate green on every deploy; drift monitors green. Start UNGATED, gate decisions logged as tags.
2. SIM ACCOUNT, bot may FIRE and manage within the hard limits; user can halt; reconciliation clean; compare to shadow.
3. Real money only after sim results match shadow and explore estimates, at 1 contract, with the user arming each session or an explicit standing authorisation.
4. Faster / richer inputs (tick-level order flow, depth) enter only as separately pre-registered research that must beat the bar-level engine out of sample; they never bypass the stages.

## What is NOT claimed
That a bot judges better than the user. The user's discretion (spike/absorption reads, holding through grinds, news awareness) is the source of the hypotheses; a labeling mode would turn it into exact data to learn from and to measure the bot against. Speed alone is not an edge unless an out-of-sample test shows it.
