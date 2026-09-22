// Live read for the Globex overnight rotation-count badge (2026-09-21). Own dedicated
// service/route file, not folded into acd.js/setups.js -- matches this codebase's own
// "isolate non-trading features" convention: this is a pure market-behavior/informational
// signal, never gates or sizes a real trade. Full research + methodology:
// RESEARCH_CLAIM overnight_rotation_count_predicts_rth_range_20260921,
// docs/OPEN_THREADS.md's 2026-09-21 entry, and scripts/calibrate_globex_rotation_badge.mjs
// (the weekly self-recalibration this reads from -- both the rotation-count thresholds AND
// the checkpoint TIMES are re-derived fresh every week, never hardcoded here).
//
// What this predicts: whether TODAY's RTH session is heading for an unusually large or small
// total range (direction-agnostic -- does not predict which way price moves, only how big).

import { query } from '../db.js';
import { getGlobalCalib } from './acdShared.js';
import { detectRotationLegs, ROTATION_LEG_THRESHOLD } from './rotationDetector.js';

async function getLatestCalibration() {
  return getGlobalCalib('globexRotationBadgeCalib', async () => {
    const r = await query(`
      SELECT run_date::text as run_date, notes FROM performance_audit
      WHERE signal_type='GLOBEX_ROTATION_BADGE_CALIB' AND signal_name='ALL_SESSIONS'
      ORDER BY run_date DESC LIMIT 1
    `);
    try { return r.rows[0] ? { runDate: r.rows[0].run_date, ...JSON.parse(r.rows[0].notes) } : null; } catch (_) { return null; }
  });
}

// Minutes since 6:00pm ET (the overnight session's own open), for an ET Date built via this
// codebase's standard naive-timestamp convention (db.js's header comment): the ET wall-clock
// string is mislabeled as UTC ("2026-09-21 19:12:00" -> new Date("2026-09-21T19:12:00Z")), so
// the ET digits must be read back with UTC getters -- NEVER local getters (.getHours()/
// .getMinutes()), even though this process runs with TZ=America/New_York. FIXED 2026-09-22
// (user-caught live: "I saw 5 rotations by 9pm... pretty sure 6 by 12am" didn't match what the
// badge/detector were computing) -- this function used LOCAL getters on a Z-mislabeled Date,
// which double-shifted every bar's minutesSinceOpen by the real ET-UTC offset (-4h during EDT,
// -5h during EST) as soon as this process's ambient TZ was ALSO America/New_York (it is,
// per server/index.js's own fail-fast guard) -- local getters re-interpret the already-ET
// digits as if they were a genuine UTC instant, subtracting the offset a second time. This
// silently misclassified which checkpoint (9pm/12am) each rotation leg belonged to for both
// this badge AND overnightOrderflowEntryDetector.js's own firing-window/order-flow-direction
// gate (which imports this function) since the night it shipped, 2026-09-21 -- see
// docs/OPEN_THREADS.md's 2026-09-22 entry for the full incident and corrected numbers.
// Matches scripts/calibrate_globex_rotation_badge.mjs's own convention in EFFECT (hh>=18 ->
// same-evening minutes; hh<18 -> next-morning minutes, offset by 360) -- that script sidesteps
// this whole bug class by extracting hh/mm via string-slicing a formatted timestamp instead of
// Date-object getters, which is why its calibration output (the stage1/stage2 thresholds,
// checkpoint times, hit rates) was never affected by this bug.
export function minutesSinceOvernightOpen(etDate) {
  const hh = etDate.getUTCHours(), mm = etDate.getUTCMinutes();
  return hh >= 18 ? (hh - 18) * 60 + mm : 360 + hh * 60 + mm;
}

export async function getGlobexRotationBadgeState() {
  const calib = await getLatestCalibration();
  if (!calib || !calib.stage1) {
    return { state: 'NO_CALIBRATION', label: null, explanation: 'No weekly calibration available yet.' };
  }

  // Z-mislabeled convention (matches overnightOrderflowEntryDetector.js's own nowEt exactly) --
  // must be read back via minutesSinceOvernightOpen's UTC getters, never local ones. Previously
  // built via `new Date().toLocaleString(...)`, a genuinely-local-zoned Date incompatible with
  // that contract -- part of the same 2026-09-22 fix (see minutesSinceOvernightOpen's header).
  const nowRow = await query(`SELECT (NOW() AT TIME ZONE 'America/New_York')::text as now_et, CURRENT_DATE::text as today`);
  const nowET = new Date(nowRow.rows[0].now_et.replace(' ', 'T') + 'Z');
  const todayET = nowRow.rows[0].today;
  const nowMin = minutesSinceOvernightOpen(nowET);
  // Only meaningful during the overnight window itself (6pm through 9:30am ET, i.e. up to
  // 930 minutes since open -- 6pm + 15.5h = 9:30am) -- outside that window there's no "today's
  // overnight session" to read yet, or RTH has already started and the badge's whole premise
  // (a pre-open flag) no longer applies. FIXED 2026-09-22 alongside the getter bug above: this
  // was 810 (= 7:30am, not 9:30am) since the file's creation -- a plain arithmetic error, off
  // by exactly 2 hours from its own stated intent and from the bars query's own correct 9:30am
  // (570 raw minutes-since-midnight) bound below.
  if (nowMin > 930) {
    return { state: 'OUT_OF_WINDOW', label: null, explanation: 'Outside the overnight (6pm-9:30am ET) window this badge applies to.' };
  }

  // Real overnight bars for the CURRENT session, 6pm ET through now.
  const barsRes = await query(`
    SELECT ts::text as ts, high::float, low::float FROM price_bars_primary WHERE symbol='NQ'
      AND ((ts::date = $1::date - 1 AND EXTRACT(hour FROM ts) >= 18)
        OR (ts::date = $1::date AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) < 570))
    ORDER BY ts ASC
  `, [todayET]);
  if (barsRes.rows.length < 10) {
    return { state: 'INSUFFICIENT_DATA', label: null, explanation: 'Not enough overnight bars yet to read a rotation count.' };
  }
  const bars = barsRes.rows.map((b) => ({ ...b, min: minutesSinceOvernightOpen(new Date(b.ts.replace(' ', 'T') + 'Z')) }));
  // Live running total through THIS MOMENT -- fine for "rotations so far" display, but NOT
  // valid for the checkpoint classification below (see the bug this fixed, 2026-09-22).
  const currentRotCount = detectRotationLegs(bars, ROTATION_LEG_THRESHOLD).length;

  const { stage1, stage2, missedEverything, highCutoffLegs } = calib;

  // Stage 1 checkpoint not reached yet -- nothing to report either way.
  if (nowMin < stage1.checkpointMin) {
    return {
      state: 'PENDING', label: 'Pending', currentRotCount,
      explanation: `Too early to read (Stage 1 check is at ${stage1.checkpointLabel} ET).`,
    };
  }

  // FIXED 2026-09-22 (user-caught live: badge showed "6 confirmed rotations by 9pm ET, 97%
  // historical hit rate" at 7:21am, but this session only had 1 leg confirmed by the real 9pm
  // checkpoint and 3 by 12am -- the other 3 built up overnight, after both checkpoints had
  // already passed and been missed). The bug: `currentRotCount` above is the running total
  // through NOW, not a snapshot frozen at the checkpoint -- checking it against
  // stage1.thresholdLegs at ANY later time (even hours after 9pm) falsely attributes a later
  // rotation count to "by 9pm," misapplying that checkpoint's calibrated hit-rate stat to a
  // session that never actually belonged to that population. Fixed by freezing each
  // checkpoint's own count from bars bounded to that checkpoint's own cutoff minute --
  // matching overnightOrderflowEntryDetector.js's bars12am/bars9pm convention exactly.
  const rotAtStage1 = detectRotationLegs(bars.filter((b) => b.min <= stage1.checkpointMin), ROTATION_LEG_THRESHOLD).length;

  if (rotAtStage1 >= stage1.thresholdLegs) {
    return {
      state: 'HIGH_LIKELIHOOD', label: 'HIGH — big RTH range likely', currentRotCount,
      checkpoint: stage1.checkpointLabel, checkpointRotCount: rotAtStage1, thresholdLegs: stage1.thresholdLegs,
      hitRate: stage1.hitRate, ci: [stage1.lo, stage1.hi], n: stage1.n,
      explanation: `${rotAtStage1} confirmed overnight rotations by ${stage1.checkpointLabel} ET (>= the calibrated ${stage1.thresholdLegs}-leg Stage 1 threshold). Historically, sessions reaching this by ${stage1.checkpointLabel} go on to land in the high-rotation tier (>${highCutoffLegs} legs by 9:30am, which predicts an unusually large RTH range) ${(stage1.hitRate*100).toFixed(0)}% of the time (${stage1.n} real sessions, 95% range ${(stage1.lo*100).toFixed(0)}-${(stage1.hi*100).toFixed(0)}%). Direction-agnostic -- says nothing about which way the session will move.${currentRotCount !== rotAtStage1 ? ` (${currentRotCount} confirmed as of right now.)` : ''}`,
    };
  }

  // Stage 1 missed -- check Stage 2 if its own checkpoint has arrived.
  if (stage2 && nowMin >= stage2.checkpointMin) {
    const rotAtStage2 = detectRotationLegs(bars.filter((b) => b.min <= stage2.checkpointMin), ROTATION_LEG_THRESHOLD).length;
    if (rotAtStage2 >= stage2.thresholdLegs) {
      return {
        state: 'HIGH_LIKELIHOOD', label: 'HIGH — big RTH range likely', currentRotCount,
        checkpoint: stage2.checkpointLabel, checkpointRotCount: rotAtStage2, thresholdLegs: stage2.thresholdLegs,
        hitRate: stage2.hitRate, ci: [stage2.lo, stage2.hi], n: stage2.n,
        explanation: `Missed the Stage 1 (${stage1.checkpointLabel}) check, but ${rotAtStage2} confirmed overnight rotations by ${stage2.checkpointLabel} ET clears the Stage 2 threshold (>=${stage2.thresholdLegs}). Historically this still predicts landing in the high-rotation tier ${(stage2.hitRate*100).toFixed(0)}% of the time (${stage2.n} real sessions, 95% range ${(stage2.lo*100).toFixed(0)}-${(stage2.hi*100).toFixed(0)}%).${currentRotCount !== rotAtStage2 ? ` (${currentRotCount} confirmed as of right now.)` : ''}`,
      };
    }
    // Missed both stages -- the precise LOW-likelihood state (never say "unlikely" bare).
    if (missedEverything) {
      return {
        state: 'LOW_LIKELIHOOD', label: 'LOW — big-range lean does not apply', currentRotCount,
        checkpoint: missedEverything.checkpointLabel ?? stage2.checkpointLabel,
        hitRate: missedEverything.hitRate, ci: [missedEverything.lo, missedEverything.hi], n: missedEverything.n,
        explanation: `Missed both the Stage 1 (${stage1.checkpointLabel}, ${rotAtStage1} legs) and Stage 2 (${stage2.checkpointLabel}, ${rotAtStage2} legs) rotation-count checks. Of real overnight sessions that also missed both, only ${(missedEverything.hitRate*100).toFixed(1)}% (${missedEverything.n} sessions, 95% range ${(missedEverything.lo*100).toFixed(1)}-${(missedEverything.hi*100).toFixed(1)}%) still went on to reach the high-rotation tier by 9:30am. This means the overnight rotation count specifically is very unlikely to still climb into the high zone before RTH opens -- not a claim that "nothing will happen" in the market generally. (${currentRotCount} confirmed as of right now.)`,
      };
    }
  }

  // Stage 1 missed, Stage 2 checkpoint not reached yet (or no valid Stage 2 this week).
  return {
    state: 'STAGE1_MISSED_AWAITING_STAGE2', label: 'Awaiting Stage 2', currentRotCount,
    explanation: stage2
      ? `Missed the Stage 1 (${stage1.checkpointLabel}) check with ${currentRotCount} rotations so far; Stage 2 check is at ${stage2.checkpointLabel} ET.`
      : `Missed the Stage 1 (${stage1.checkpointLabel}) check; no Stage 2 threshold cleared in this week's calibration.`,
  };
}
