# Audit of Fable's outside review of scratch/fable_brief_20261110.md (2026-11-10 night)

Reviewer ran no queries; every SD in the review is back-solved or guessed (their label). Audit per hr-034/035: re-query the checkable claims, take diagnoses, do not owe the remedies. Look-free: no outcome labels were read; roll scan reads bar prices only.

## Verified against our data

1. **Roll list incomplete: CONFIRMED, and wider than the review said.** `price_bars_contract_calendar` shows 14 switches 2023-06..2026-09; the brief listed 7. Measured stitch at each switch (price_bars_primary, first bar vs previous close; scripts `scratch/roll_cal_scan_20261110.mjs`, `scratch/roll_cal_scan2_20261110.mjs`):
   - 2023-06-12 +176.5 (in repo list) | **2023-09-10 18:00 +188.8 (NOT in repo list, NOT a 00:00 bar)** | 2023-12-11 +210.0 (not in repo list) | 2024-03-11 +247.5 (not in repo list) | 2024-06-16 18:00 +258.5 (listed) | 2024-09-16 +236.5 (listed) | **2024-12-17 +300.8 and 2025-03-18 +208.5 (Tuesdays, one day AFTER the repo window)** | 2025-05-29: no single stitch, intraday jumps +89.0 at 11:56 and +76.8 on 05-30 (contract flip mid-session; sealed window) | 2025-09-28: no gap (-2.8) | 2025-12-14 +260.8 | 2026-03-15 +164.8 | 2026-06-14 +513.3 (includes a weekend gap) | 2026-09-14 +296.3.
   - Cause: `getNqRollWeekDates()` (acdShared.js) is a CALENDAR rule (2nd Thursday to the Monday before the 3rd Friday). The data's stitch date is wherever the calendar table switched, which differs by -6 to +1 days from that window. The capitulation replay lib adds a data-detected rule (00:00 bar jump > 150 pt, window -5/+1 days), which catches 2023-12, 2024-03, 2024-12, 2025-03 but NOT a Sunday-18:00 stitch (2023-09-10 is the one explore-window date neither rule catches). `globex_roc3_test.py` detects by session-file boundary and is fine.
   - Reviewer's guessed dates (2023-09-11, 2024-06-17, ~06-15-2026) were off by a day, the substance is right. Two listed dates being Tuesdays: right.
   - Impact: any study using only the calendar helper and holding or computing across a Sunday-night/Monday-morning boundary in those weeks. Not quantified; 68 files reference the roll helpers. Live code (volatilityRegime, contractSymbol) uses the calendar rule for a different purpose (the live front-month switch) and must not be changed by this.
2. **Pass-probability simulator "build first": already largely built.** Day-block bootstrap P(pass)/P(fail)/unresolved exists in `scripts/learning_monitor_build.mjs` (Opus 11-08) and `scripts/vacuum_sim/unified_exit_lock.py` (row 45: tell 0.385 -> 0.135 with the lock). Missing is the roster-level version that applies SKIP rules (dollar-risk cap, same-thesis lockout, Globex off) to a pooled daily P&L. The reviewer's closed form for the zero-edge pass probability, exp(-3000/2000) = 22.3%, is correct for a driftless trailing floor; its tell-at-research-mean figure (32%) is close to our bootstrap's 38.5% (ours has skew and EOD trailing). So the 22% bar is a fair reference line, not a replacement for our bootstrap.
3. **Tell "inconsistency" (full-stop share): resolved, not a contradiction.** On the 1,750 explore V1 replays (`scratch/unified_exit_lock_20261110/tell_pairs.csv`, base_why): STOP 62.3% at mean -$55.15, FADE 18.1% at +$120.12, TIMEOUT 16.8% at +$80.19, EOD 2.8% at +$43.12. Live: 35 stops of 45 filled = 77.8% at mean -$82.8. Live stop share is 2.1 SD above research (binomial, p 0.623, n 45), and live stops are 50% larger per stop. The "non-breaker -$25" is a mix that includes positive timeouts (+$80), which is why the reviewer's arithmetic looked impossible. Rows 46-48 already showed stop scale and trend do not explain the gap; the stop SHARE and the three huge entry slips remain the open pieces (handoff item 1).

## Already done or already known (reviewer did not have it)

- Tell hold-out replay -$6.64 per entry on 1,486 entries predates live (OPEN_THREADS 11-04), so "live can catch a disaster, cannot confirm an edge" is consistent with what we hold.
- Capitulation = price target (H - T): the reviewer's "answered, drop the flow-exit program" matches co-025 handling: parked, not retired; the disagreement-set contrast (H - T on rows where thrust precedes the target vs target with no thrust) is NOT run and is cheap.
- Exit family trails/BE/lock all negative: reviewer agrees.
- Vacuum 18,425-onset SE: reviewer's SE (~$0.7) rests on a guessed SD; with SD 90 it is right in order of magnitude. Our own row 49/50 already show gross about zero.

## Reviewer ideas worth keeping (none registered yet; all need the user's go under co-023/co-024)

Cheap, outcome-blind or explore-only, high information:
- A. Geometry-matched null on the 1,760 tells: realized touch-before-stop rate vs the driftless-walk implied rate (stop/(stop+distance to boundary)), by decile. SE about 1 pp. Directly answers "does the tell have any directional information".
- B. Thin-vs-crowded split of vacuum onsets using the clock duration of the thrust bars vs the time-of-day norm. This is the part of the user's ORIGINAL idea (duration gate) the live rule dropped; matches the user's observation that bars go FAST at turning points (which our speed lead, row 44, found in the OPPOSITE direction for exits). Must be tested with the user's definitions (feedback: test their definitions, do not rewrite).
- C. Turn-signal ablation ladder on 513 explore sessions (extended climax alone, + ignition, + held).
- D. Risk rules, judged by simulated P(pass)/P(bust)/days, not mean: dollar-risk cap (skip trades whose stop > ~3% of cushion), same-thesis lockout (P(stop | previous same-day same-direction tell stopped) vs unconditional), Globex off for continuation. Needs the roster-level simulator in item 2.
- E. Meta-check: rebuild p-values for the ~1,060 claims and look at the histogram. Many claims have no stored p; coverage is the first question.
- F. Roll-list repair (below).

Caution flags on the reviewer's own proposals (hr-035: take the diagnosis, not the remedy):
- Its "conditional H - C0 is selection on a post-entry event" critique is correct and is already half-stated in our notes (unconditional H - A is -2.4). Keep the conditional result labelled plausible/unconfirmed.
- Its multiplicity count (Holm bar near 0.01) is a GUESS at our contrast count; the ledger holds the real count.
- "Stop reading p-values on explore" conflicts with how rows 36-50 were judged (explore p plus sealed look). Not adopted automatically; it is a program-level choice for the user.
- C2 ("treating a search as a measurement") is a fair general warning and consistent with cv-033/co-025 tension: cv-033 says split pooled verdicts, co-025 says never retire. The reviewer is right that the two together guarantee a passing subgroup eventually; the existing control is forward-only judgement (co-024). No change proposed without the user.
- Not in the review but relevant: it assumes continuous intraday trailing; the user said END-OF-DAY trailing, which is kinder (the reviewer flagged it as unconfirmed).

## Items needing the user (recorded as decisions)
1. Fix the research roll-exclusion list (data-derived from `price_bars_contract_calendar`, new helper, calendar helper untouched for live code) and re-run the two or three studies that rely on the calendar list only? Needs a go because it touches shared code and may move earlier results.
2. Which Fable candidates to register for the quarter (co-024, max 8, Holm 0.10). Recommended order by cost: A (tell geometry null), B (thin vs crowded), C (turn ladder), D (risk rules via simulator). Not a request to run them now.
