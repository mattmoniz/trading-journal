// One written next-step tree per monitor on the Monitor & Learning page (CLAUDE.md co-022, docs/IMPROVEMENT_REGISTER_20261104.md row 9).
// Every number is read from the monitor's own data or floor constant (hr-019); the rules quoted are the pre-registered ones in the spec named in `spec`.
// Each entry: review (when it is judged), ifConfirmed, ifFailed, spec. Phone page and app both render these from GET /api/setups/monitor-summary `nextSteps`.
const step = (spec, review, ifConfirmed, ifFailed) => ({ spec, review, ifConfirmed, ifFailed });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function buildNextSteps({ sb, un, fw, lm }) {
  const out = {};
  if (sb?.state === 'OK') {
    const left = Math.max(0, (sb.firstLookDays || 0) - (sb.daysSoFar || 0));
    out.scoreboard = step('docs/ROSTER_SCOREBOARD_PREREG_20261025.md',
      left > 0 ? `First look at ${sb.firstLookDays} distinct days (${plural(left, 'day')} to go), then one look per 10 more days; nothing is decided between looks.` : `First look is due now (${sb.daysSoFar} days); then one per 10 more days.`,
      'PASS (CI above 0 and both halves positive): keep the live roster and test one more setup at a time as SHADOW.',
      'FAIL (CI below 0 and both halves negative): ask the user whether to pause the roster gate; autopsy = fired vs skipped by setup type and session. Anything else = not shown, keep running.');
  }
  if (un?.state === 'OK') {
    const days = un.latest?.unseenDays ?? 0;
    out.mlUnseen = step('docs/ML_CLEANUP_20261102.md',
      `Judged when ${un.daysNeeded} unseen days exist (${days} now) and the gate rule passes two weeks running; if that has not happened by the end-of-year review, it is retired.`,
      'Passes twice in a row: propose a SHADOW veto arm to the user; it stays log-only until the user says otherwise.',
      'Does not pass by the end-of-year review: retire the daily chain, keep the weekly scorecard as a record; autopsy = by session (Globex flipped sign once).');
  }
  if (fw && fw.state !== 'ERROR') {
    const f = fw.forecast || {}, r = fw.regime || {}, t = fw.tell || {};
    out.forecast = step('docs/FORECAST_SERVICE_20261102.md (F1, learning loop)',
      `Counts only until the first look at ${f.daysNeeded} forward days (${f.days} now), then one non-overlapping look per 20 days; a sealed span is read once.`,
      'Beats the clock baseline AND is compared with persistence: keep it as the width forecast and start the shadow consumers (width-scaled stops and targets).',
      'Fails or the decay alarm fires: drop the model, keep persistence plus clock as the forecast; autopsy = which horizon and clock bucket lost skill.');
    out.regime = step('docs/REGIME_GAUGE_20261102.md',
      `Counts only until ${r.needed} realized outlooks (${r.realized} now), then a bucket calibration is shown as a monitor.`,
      'Buckets separate realized range: use the outlook for expectation and cushion only, never to pick a side.',
      'Buckets do not separate: retire the card and fall back to the plain overnight range.');
    out.tell = step('docs/TELL_STAGE2_END_RULE_20261104.md (adopted 2026-11-04), docs/AMT_TELL_LIVE_PROJECT_SPEC_20261028.md (section 10 evidence floor)',
      `Rules are frozen until ${t.floor} tell trades (${t.trades} now, ${t.days} days) and at least ${t.floorDates} dates; judged ONCE at both floors by the nightly check (scripts/tell_stage2_floor_check.mjs); the flip override gets its own look after 5 live flips.`,
      'At the floors: day-block 95% CI of net per linked trade entirely above 0 = evidence of an edge on the sim account (present to the user; no live money without a decision); the interval includes 0 = review with the user, continue only on their word.',
      'At the floors: the interval entirely below 0 = RETIRE the tell orders (a HIGH decision is flagged, nothing switches off by itself) and keep the tell as a move-detector context feature (register row 1); autopsy = by day shape and entry time.');
  }
  out.bot = step('learning_monitor_build.mjs (bot contract)',
    lm?.bot ? 'Judged on its own frozen version: needs at least 20 TAKE trades on distinct days before any verdict.' : 'There is no bot yet; this is a placeholder. A bot is only counted once a frozen version writes decisions (contract above).',
    'TAKE arm beats take-all with a CI above 0 after slippage: propose it to the user as SHADOW to live.',
    'No frozen bot by the end-of-year review: remove the placeholder. A bot that loses: autopsy = calibration table, then retrain only as a new version.');
  out.delay = step('docs/FILL_MODEL_SCOPE_20261103.md',
    'Reviewed monthly. It is a measurement, not a test.',
    'Median stays near the realistic assumption: the fill model keeps that assumption.',
    'A day whose p90 passes the stress assumption: treat that day\'s market-entry results as unreliable and open an incident; autopsy = poll stall vs order path.');
  out.passRace = step('memory: reference-prop-account-rules-20261102',
    'Reviewed when an attempt ends (pass or bust) or after 20 trading days; the virtual account resets itself.',
    'The roster arm passes before busting: that is the objective; compare how many days it took with take-all.',
    'A bust: autopsy = the days that drove the drop (size, day type, entry time) and whether take-all would have busted too.');
  out.gates = step('this page (read-only)',
    'Reviewed whenever a gate flips, and in every register review.',
    'A gate that is on and doing its job stays.',
    'A gate that stays off and is not referenced by any open test at the next register review is removed from this card and from the code.');
  out.dayContext = step('docs/DAYTYPE_FORECAST_PREREG_20261104.md, docs/B_SHAPE_NOTES_20261103.md',
    'A readout, not a test: no pass/fail. Checked against the user\'s own chart read at each register review and after any change to the profile rules.',
    'Matches the user\'s read: it stays, and its width estimate feeds the width-scaled stop test (register row 4).',
    'The user\'s read disagrees: log the date and the disagreement in OPEN_THREADS and compare with the TradingView TPO rules; autopsy = shape rule vs IB state vs single prints.');
  out.structureModel = step('docs/STRUCTURE_SHADOW_MODEL_DESIGN_20261105.md (section 3 forward rules)',
    'Counts only until the FIRST LOOK at 60 complete forward days (240 rows), the SECOND at 120, then one non-overlapping look per 60: improvement over the HARD baseline (HAR-X + clock + the last-30-minute range + the range so far) with a week-block 95% CI, both halves and a circular-shift placebo.',
    'CI lower bound above 0 and both halves positive: keep it as the next-hour range display; no consumer is wired without the user\'s word.',
    'At the SECOND look the CI includes 0 or the estimate is negative: retire to the hard baseline and write the autopsy (which decision time and which feature group lost skill).');
  out.tellContext = step('docs/TELL_CONTEXT_OVERLAY_SCOPE_20261103.md',
    `Forward log judged once at the tell evidence floor (${fw?.tell?.floor ?? '?'} trades, ${fw?.tell?.floorDates ?? '?'} dates; ${fw?.tell?.trades ?? '?'} trades now), together with the flip review.`,
    'AGREES beats AGAINST on the same fires with a day-block CI above 0: keep the label as a context feature and test a TPO-based AGAINST label (register row 2).',
    'The labels do not separate: retire the label and keep the log; autopsy = by day shape and time of day.');
  out.tellShadow = step('docs/TELL_WATCHER_AND_SHADOW_BOOKS_DESIGN_20261103.md, docs/TELL_OVERRIDE_LIVE_DESIGN_20261103.md, docs/TELL_STOP_PLACEMENT_ARMS_PREREG_20261104.md section 7',
    `Flip override: first review after 5 live flips (OPEN_DECISION flip_override_vs_explore_replay_20261103). Books A/B/C are compared paired on the same fires at the tell floor; the forward stop books D/E/F get ONE look at the same floor (${fw?.tell?.floor ?? '?'} fires, ${fw?.tell?.floorDates ?? '?'} dates; ${fw?.tell?.trades ?? '?'} tell trades now).`,
    'Flip pays on live fills: keep it. A stop book (D, E or F) has a paired CI above 0 with both halves positive: propose a sim-account trial of that stop to the user (never automatic); adopt the watcher stop only if its paired difference has a CI above 0 (register row 3).',
    'Flip does not pay: ask the user to turn it off and keep the books as shadow. Stop books do not pay: retire them or keep the one with a stable sign for a second look; autopsy = by label, entry hour, day shape and stop distance.');
  return out;
}
