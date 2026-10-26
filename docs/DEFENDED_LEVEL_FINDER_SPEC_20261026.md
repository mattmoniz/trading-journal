# Defended-level finder — spec for review (nothing scored, nothing built beyond this page) — 2026-10-26

Origin: the user's own words (`reports/user_messages_20261026.md`, including the multiple-choice answer at 16:33) and the DeepSeek blind interpretation (`reports/deepseek_blind_interpretation_of_user_idea_2026-10-26_raw.md`) and fidelity audit (`reports/deepseek_fidelity_audit_batch*_2026-10-26_raw.md`). This replaces the four-hour level engine of `docs/FOUR_HOUR_DEFENDED_LEVEL_PREREG_20261026.md`, which the audit graded NARROWED (a 2-day fresh-low "level"). Purpose: build what the user described, show them the events on charts, and only then decide what to score.

## What the user described (their words, short)
A "distinct floor" at the PW VAL and 3-month VAL, "dates back to august ... the fourth approach", "345 bars that seem to terminate at the same price level" meaning four-hour bars ("a lot of time that it is being defended"), floors AND tops; "I wait for a hold or several defenses"; ONE supporting metric, volume vs normal ("I do not want 10 metrics"); ES as confirming ("NQ could be leading but just needs a friend"); "stalks and hunts before it attacks"; a mechanism that works from a current setup like a defended level, not a new setup; trade = large stop, far target (the 3-month POC and further). "All this togetherness creates a picture."

## The level (not invented from price; the lines the user reads)
- Candidate levels at each time t = the stored-in-Sierra style lines, from REAL tick volume (`volume_at_price_daily`, `server/services/tickVolumeProfile.js`): current 3-month block VAH/VAL/POC (calendar quarter, all sessions, to the prior close), previous block VAH/VAL/POC, prior-month VAH/VAL/POC, prior-week VAH/VAL/POC, prior-day VAH/VAL/POC, plus prior-month and prior-week high/low. Causal: each line uses data through the prior close only.
- Plus swing pivots from price action (`server/services/swingPivots.js` ZigZag-ATR) as a second level class, shown separately, never mixed in the counts.
- OPEN, to confirm with the user: whether their prior-month and prior-week lines are all-session or day-session profiles (3-month is all-session per the study settings they gave).

## Defense and hold (counted on four-hour bars, long memory)
- Four-hour bars aligned to the Globex open (as `scripts/lib/fourHourLevels.mjs`). For a FLOOR line L at time t: a DEFENSE is a four-hour bar whose low is within band `b` of L and whose close stays above `L - b`; a TOP is the mirror.
- `K` = number of defense bars in the lookback (the whole block / 90 days, not 2 days); `A` = number of separate APPROACHES = defense bars separated by at least 6 bars (one day). Both are printed on every chart ("4th approach").
- Band `b`: from the data, a fraction of the mean four-hour bar range over the prior 20 days (`H4`); the charts show `0.25 x H4` and `0.5 x H4` side by side for the user to judge. No fixed point value.
- The event fires on HOLD: after `K >= 3` (or `A >= 2`) defenses, the first four-hour bar that closes at least `0.5 x H4` away from the level on the defended side (a bounce that held) — "I wait for a hold or several defenses". Entry is the open of the next one-minute bar. A level that breaks (a four-hour close beyond `L - b`) is dead until re-formed.
- The user's own four-hour reading (bars that END at the level) and a one-minute reading (approaches) are both computed; the user says which matches what they see.

## The one supporting metric
Volume vs normal at the defense bars: mean over the defense bars of (bar volume / mean volume of the same session-slot four-hour bar over the prior 20 trade days), printed on each event. No other metric gates anything. ES synchrony is shown as a CLUE on the chart (did ES turn at the same time), not a gate, because the user asked for it as confirmation; its use is decided after they have seen it.

## Mechanism, not a new setup
The events are a layer over the existing level-fade setups and standalone detectors: "this touch of a level that is defended K times is a candidate for a larger-risk, far-target version of that trade". Nothing in this spec fires or sizes a live trade. How it attaches (a flag on existing fades vs a separate shadow row) is decided after the user has seen the events.

## Exit to be tested later (not now)
Large stop and a far target at the next period line / POC (the user's "run up to the blue POC"), as the primary arm; the earlier no-target 24-hour hold only as a sensitivity.

## Review step (before any scoring)
A chart page shows each event (four-hour candles, all active lines, defense bars marked, K, A, volume vs normal, ES clue). The user taps TAKE / NOT MINE / UNSURE with an optional note. Their ratings define which events count as "their picture"; any test then runs on their set, pre-registered after seeing nothing but those ratings' definitions, never on outcomes.

## What this does NOT claim
Nothing here shows an edge. It only builds the thing the user described so that, if tests show nothing, the null is about their idea and not mine.

---
## Amendment 1 (2026-10-26, after the blind DeepSeek fidelity check, `reports/deepseek_finder_spec_fidelity_2026-10-26_raw.md`)
Matched per DeepSeek: volume vs normal as the one metric, floors and tops, far-target exit, mechanism not a new setup; partly: the "picture" (no overnight high/low, MGI or 500-volume lines yet), four-hour as the unit but not multi-timeframe. Changes made: lookback widened from 90 to 130 trade days (780 four-hour bars; the count restarts only when the level breaks); events whose only lines are prior-day lines are excluded from the review sample (a line formed yesterday is not "dates back to August"); the review sample is stratified by separate approaches (1, 2, 3+) so the user's ratings show where their picture starts; a free-text "setup I would have taken that you did not show" box and five questions (tolerance, hold, levels in scope, lookback/break, is ES required) are on the page; thirty cards first, thirty optional. Still guessed and put in front of the user: the 0.25 x H4 band, the 0.5 x H4 hold threshold, the 6-bar approach separation, all-session period lines for prior week/month. ES stays a clue until the user answers question 5.
Review artifact: https://claude.ai/artifact/YHeS7J7MLJut3i659WMyxN (source `reports/artifacts_20261026/defended_review_template.html`, built by `scripts/build_defended_review_page_20261026.py` from `scripts/build_defended_level_events_20261026.mjs` + `scripts/sample_defended_events_for_review_20261026.mjs`; ratings in the artifact database, collections `ratings`, `missed`, `notes`; read with ArtifactData). No outcome is computed or shown anywhere in this pipeline.
