# Scope: the tell as context for the roster, with an expansion-forecast model (2026-11-02; nothing run, nothing frozen)

Origin: user, 2026-11-02, "scope this out" after the recommendation to start the roster-context study (item 2 of `docs/SCOPE_HARD_TODOS_20261101.md`) with an expansion-forecast model as its ML piece. Written for the trader and the next session. Revised order of work: `docs/AGENTIC_SYSTEM_SCOPE_20261101.md` section 9 (this is step 3; G0 and the look ledger come first, and this can run beside G0 because its first step touches nothing live).

## 1. The question, in plain English
The tell says "price is about to travel further than usual" (about +18 percent over the next 5-60 minutes, side a coin flip). Does knowing that help the setups that already fire automatically? Examples: skip a fade that expansion tends to run through, widen a stop, size down or up. The ML piece predicts HOW FAR price will travel (never which way) from information available at the moment a roster setup fires.

## 2. Facts that shape the design (queried 2026-11-02)
- **The live roster is one setup type.** The LIVE_ROSTER row of 2026-10-30 lists only `CAM_S1_FADE_LONG` as passing (n=61, 19 days, mean +21.30, CI lower +5.23, but halves +4.3 / +37.7 and best day 2026-10-23); `WS1_FADE_LONG` passed earlier. Plus the Stage 2 tell itself. So today's dollar impact of any context rule is small; the study mainly decides whether context is worth carrying for setups that regain live status. I overstated the roster earlier by saying "the roster that already trades".
- **Real roster rows only exist since 2026-07-09**, all inside the sealed, not-extracted window: ACTIVE 1,683 rows (1,392 primaries), SHADOW 9,880 (6,883 primaries); real RTH primaries 5,668 on 82 days. Real rows before July 2026 do not exist (none before 2026-07-09; the older ones are simulated BACKFILL).
- **The tell's bars exist only for the explore window** (500-volume bars through 2025-05-16, 488 dates, `decision_points_explore.csv` 41,272 rows). The 340 sessions after 2025-05-16 are sealed and not extracted; live tell state exists only from 2026-10-28 (8 sessions).
- **Overlap of tell bars and roster rows is thin.** BACKFILL (simulated) rows through 2025-05-16: 3,891 (3,541 RTH) on only 126 days, 1,787 RTH rows fired 10:00-14:30 ET (the tell's tested decision window), spread over about 250 setup types. `CAM_S1_FADE_LONG` has 47 such rows, `WS1_FADE_LONG` 19. Real rows overlap the tell bars on zero days (the real window is the unextracted one).
- **Tell research is RTH 10:00-14:30 only; Globex untested** (`PREREG_GLOBEX.md` is a draft). The study is RTH-first, and Globex is a recorded gap (hr-002), not a silent skip.

## 3. The key design choice: split the ML from the roster
The forecast does NOT have to be trained on roster rows. Its target (unsigned travel E = MFE + MAE in ATR20 units at 15/30/60 minutes) exists at every decision point of the 488 explore dates (41k points), so the model is trained and judged there, where the data is plentiful, with no outcome of any roster setup involved. Roster rows come in only at the dollars step, as the population the forecast is applied to. This keeps the ML result from depending on 126 days of simulated rows.

## 4. The pieces
**A. `tell_state_at(ts)`** (build first; nothing live). A causal function giving, at any time inside a session, the tell's state from only completed 500-volume bars: tell active within the prior N minutes (N = 5/15/30/60), nodes L, pace A, back-and-forth Q, minutes since the last tell, plus the forecast inputs. It must reuse the live sidecar's code (`scripts/amt_tell_live/core.py`, which replays the research code literally), never a second copy (hr-022). Parity gate in the style of `scripts/amt_marks_live/` (prefix-invariance: state at time t identical whether computed on the prefix or the full session, with a mutation test proving the gate fails when lookahead is injected).
**B. Expansion forecast.** Target E (and the signed-free A) at 15/30/60 minutes. Baseline to beat: time-of-day by ATR20 mean. Candidate: small regularised model (ridge, then a shallow tree ensemble only if ridge shows signal) on causal features: clock bucket, day-of-week, range so far over ATR20, overnight range, pace/Q/L, tell flags, volume versus its same-hour baseline, distance to the nearest level family. Walk-forward expanding by date, a day-block label-permutation null (the repo convention), out-of-sample rank correlation and R-squared increment over the baseline with day-blocked CI. The tell indicator alone is the intermediate control (does the model add beyond "tell yes or no"?). Stop if the incremental interval includes zero.
**C. Roster counterfactuals** (only if B beats baseline). On roster rows with a known fire time, same trades, paired comparison, realistic fills and the real $2 round trip: skip when forecast high, widen stop, half size. Split by structural family BEFORE pooling (cv-033): mean-reversion fades (CAM, WS, PD_*) and breakout/trend setups should move in opposite directions because expansion raises both MFE and MAE. Kill rule in ABSOLUTE dollars per trade, not MAE/MFE, with real and BACKFILL reported separately and the 2026-10-11/12 boundary and roster-churn confound respected (hr-061, hr-063).
**D. Forward shadow tagging** (free evidence). Log `tell_state` and forecast beside every roster fire (ACTIVE and SHADOW, zero order impact), through the running sidecar. About 70 RTH primaries a day (5,668 on 82 days) arrive with true unseen tell state. Needs a small live write path, so it ships with the next coordinated restart, not before.

## 5. The user's open question: which population
Recommendation: **explore on BACKFILL through 2025-05-16, as exploration only; confirm on real rows later through a deliberate, single look.**
- BACKFILL is simulated (about 80 percent of `active_setups` is synthetic, hr-006), so it can generate hypotheses and test the forecast's mechanics, never prove dollars. The forecast itself (B) does not use it at all (section 3).
- Real post-2025-05-16 rows exist only from 2026-07-09. Using them needs 500-volume bars for those sessions (about 80-85 sessions of extraction, hours of compute, smaller than the full 340). That reads part of the sealed window the tell's own hold-out look relies on, so it needs your decision: either (a) retire the tell's hold-out for this window and spend it once as the roster-context confirmation under its own ledger family, or (b) keep it sealed for the tell and confirm roster-context only on forward live tags (D), which is slower (weeks) but clean. I recommend (b) first: it costs nothing now and keeps both options, and (a) only if D is too slow to matter.
- Nothing is extracted or spent until you say so.

## 6. Phases, size and kill rules (working sessions; estimates)
P0 (1-2): pre-registration (at most 8 hypotheses, multiplicity budget, BH within family, power statement computed from the data first), look-ledger entry, `tell_state_at` and its parity test.
P1 (1): descriptive on the 41k decision points only: tell state versus E by clock bucket and ATR regime; no roster rows. Kill: no E difference beyond the earlier expansion result.
P2 (1-2): forecast model B. Kill: incremental out-of-sample interval over baseline includes zero, or the permutation null is not beaten.
P3 (1): roster counterfactuals C on BACKFILL (exploration), per family. Kill: no family shows a paired absolute-dollar effect with a day-blocked CI excluding zero. Output is hypotheses for D, not a finding.
P4 (0.5, with the next restart): forward tagging D; first readable look after enough real fires, number fixed in P0.
P5: confirmation look, only with your choice in section 5.
Resolution to state honestly in P0: 126 days and 1,787 rows across ~250 types cannot show a 5-10 dollar per trade effect for any single type; only family-level or forecast-level effects are testable, which is why B is judged on E, not dollars.

## 7. What this cannot do
It creates no side edge and does not make the tell tradable by itself. With one live setup type, a positive result changes sizing or skipping for `CAM_S1_FADE_LONG` and for whichever setups the roster gate later promotes. My earlier "30-40 percent chance of a usable effect" applied to the broader roster; for the current live roster it is lower. If P2 kills the forecast, the tell stays an expansion marker and this thread closes with a recorded claim.

## 8. Needs from the user
1. Population: explore on BACKFILL only, confirmation deferred (recommended), or extract Jul-Oct 2026 sessions now (section 5).
2. OK to keep the primary RTH 10:00-14:30 with Globex as a recorded untested gap.
3. Later: a go for any hold-out spend and for the forward-tagging write path at a restart.

## Update 2026-11-02 (P0 done)
- Population decision resolved (user delegated): explore on BACKFILL through 2025-05-16, exploration only; no sealed-window read; confirmation on forward tags. Plan frozen in `scripts/amt_context/PREREG_ROSTER_CONTEXT.md` (written before any outcome; counts only were read).
- New fact from counts: ALL 1,787 backfill rows in the tell window (10:00-14:30 ET, through 2025-05-16, 120 types) are level-fade or magnet types. A fade-versus-trend split is therefore NOT testable on backfill; it can only come from forward live tags (H5).
- `scripts/amt_context/tell_state.py` (`state_at`) built on the research functions; `parity_state.py` passes: 960 cut points on 60 sessions, 0 violations, and both mutation variants (2-minute lookahead, whole-session overnight range) are caught on all 240 cut points each (`parity_state_output.txt`). No outcome has been read yet; the next step (P1) logs a look in the ledger first.
