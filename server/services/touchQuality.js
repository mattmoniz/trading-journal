// Shared order-flow "touch-quality" classification.
// Used by scripts/calibrate_touch_quality.mjs (historical calibration, writes
// performance_audit signal_type='TOUCH_QUALITY') AND server/routes/acd.js's live
// resolution loop (resolveSetupsByPrice) — do not reimplement this a third time,
// per CLAUDE.md's "share modules" convention (rigorDiagnostics.js precedent).
//
// Origin: docs/OPEN_THREADS.md "Touch-quality" thread, 2026-07-15. User's explicit
// guidance before building this: major structural levels draw genuine two-sided
// fighting between buyers and sellers, so heavy volume at a touch does NOT
// automatically mean "absorbed" — it can mean a fight the adverse side won. Hence
// 3 buckets, not 2 (ABSORBED vs OVERRUN are kept separate).
//
// Volume baseline reuses the existing VOLUME_SPIKE convention already in acd.js
// (90-day trailing per-minute-of-day avg/std z-score) — not a new static threshold.

async function getVolumeBaseline(queryFn, date) {
  const res = await queryFn(`
    SELECT (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int AS mod,
           AVG(COALESCE(bid_volume,0)+COALESCE(ask_volume,0))::float AS avg_vol,
           STDDEV(COALESCE(bid_volume,0)+COALESCE(ask_volume,0))::float AS std_vol
    FROM price_bars_primary
    WHERE ts::date >= $1::date - INTERVAL '90 days' AND ts::date < $1::date
    GROUP BY 1
  `, [date]);
  return new Map(res.rows.map(r => [r.mod, r]));
}

// windowBars: [{ mod, bid_volume, ask_volume }] — bars 1..W since touch, W = the
// setup_type's own calibrated reaction window (p25 of its bars-to-resolution).
// entry/direction: for the adverse-excursion-past-bar-1 check.
// baseline: Map from getVolumeBaseline.
// highVolZCutoff: setup_type's own calibrated tercile cutoff (from performance_audit).
// Returns null if no baseline coverage for any window bar (can't classify).
function classifyTouch({ windowBars, direction, baseline, highVolZCutoff, gaveFurtherGround }) {
  let maxZ = -Infinity;
  let adverseVol = 0, favorableVol = 0;
  for (const b of windowBars) {
    const bl = baseline.get(b.mod);
    const totalVol = (b.bid_volume || 0) + (b.ask_volume || 0);
    if (bl && bl.std_vol > 0) {
      const z = (totalVol - bl.avg_vol) / bl.std_vol;
      if (z > maxZ) maxZ = z;
    }
    const adverse   = direction === 'LONG' ? (b.bid_volume || 0) : (b.ask_volume || 0);
    const favorable = direction === 'LONG' ? (b.ask_volume || 0) : (b.bid_volume || 0);
    adverseVol += adverse;
    favorableVol += favorable;
  }
  if (maxZ === -Infinity) return null;

  const netAdverseDelta = adverseVol - favorableVol;
  if (maxZ <= highVolZCutoff) return { bucket: 'QUIET', maxVolZ: maxZ, netAdverseDelta };
  return {
    bucket: gaveFurtherGround ? 'HIGH_VOL_OVERRUN' : 'HIGH_VOL_ABSORBED',
    maxVolZ: maxZ,
    netAdverseDelta,
  };
}

// Volume-building signal (2026-08-28, docs/OPEN_THREADS.md's roster-wide volume-building
// thread): does trading interest rise into a touch by TWO reference frames -- the existing
// time-of-day-relative baseline above (is this loud for this historical clock-time) AND a
// day-relative baseline (is this loud for how today itself has traded so far).
//
// RETRACTED, DO NOT CITE AS VALIDATED (corrected 2026-09-03, DeepSeek code+efficacy review):
// this comment used to describe a "both-agree-at-p60" WR lift to 54.3%/EV=$7.11 (N=105) as
// the real, validated version of this idea -- that number was itself an artifact of 2 bugs
// (a guard-mismatch letting bar-10-13 touches through with structurally-null day-relative
// values, and a session-boundary bug pulling in prior-session bars). Re-running the IDENTICAL
// full-sample backtest with both bugs fixed FLIPPED THE SIGN (p60-agree EV=-$8.57/trade N=92,
// worse than the -$2.00 do-nothing baseline), and a separate walk-forward split (TRAIN
// EV=$15.52 -> TEST EV=-$18.06) failed out-of-sample before the bugfix even landed. See
// RESEARCH_CLAIMs fade_roster_volume_building_pooled_vs_pertype (the bugfix reversal) and
// fade_roster_volume_building_walkforward_negative (the walk-forward failure) -- both STALE.
// A separate, independent bar-level test the same day (scratch/test_order_flow_signals.mjs,
// unrelated signal) found the LIVE `compositeStrength` sum below (not the AND-gate) also has
// no real forward-continuation edge. Treat "rising volume predicts a bigger directional move"
// as a refuted hypothesis, not an open question, until someone produces a genuine held-out
// replication on bugfixed code. The one fragment that DOES still hold (see
// volume_building_no_level_initiative_test) is weaker and non-directional: elevated composite
// strength predicts a bigger move in EITHER direction (more volatility), not continuation.
//
// Wired live INFORMATIONAL ONLY via active_setups.vol_building_signal -- does not gate/size
// anything, self-recalibrates weekly via scripts/backtest_volume_building_signal.mjs.
const VOL_BUILD_APPROACH_BARS = 10;

function pearsonCorr(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { cov += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; vy += (ys[i] - my) ** 2; }
  return (vx > 0 && vy > 0) ? cov / Math.sqrt(vx * vy) : 0;
}

// sessionBars: chronological bars SINCE THIS SESSION'S OWN OPEN (RTH 9:30am or Globex 6pm)
// through the current/touch bar, each { mod, volume }. touchIdx: index of the touch/current
// bar within sessionBars. baseline: Map from getVolumeBaseline (mod -> {avg_vol, std_vol}).
// Day-relative z at each bar uses only bars STRICTLY BEFORE it (no lookahead), matching the
// backtest convention exactly.
function computeVolumeBuildingMeasures(sessionBars, touchIdx, baseline) {
  // FIXED 2026-08-28 (DeepSeek code QA, independently verified): this guard used to only require
  // touchIdx >= VOL_BUILD_APPROACH_BARS (10), but the day-relative accumulator below only starts
  // producing values once its own running count reaches 10 -- so for touchIdx 10-13 the
  // approach-window day-relative measures NEVER had the required 5 values (always null despite
  // passing the guard), and for touchIdx 14-19 the two "reference frames" were computed over
  // different effective sample sizes (day-relative over fewer bars than time-of-day). Requiring
  // touchIdx >= 2*VOL_BUILD_APPROACH_BARS guarantees the day-relative accumulator already has
  // count>=10 at the FIRST bar of the approach window, so both measures cover the same full
  // (VOL_BUILD_APPROACH_BARS+1)-bar window consistently.
  if (touchIdx < 2 * VOL_BUILD_APPROACH_BARS) return { avgVolZ: null, volZTrend: null, avgDayVolZ: null, dayVolZTrend: null };
  const dayVolZByIdx = new Array(touchIdx + 1).fill(null);
  let sum = 0, sumSq = 0, count = 0;
  for (let i = 0; i <= touchIdx; i++) {
    if (count >= 10) {
      const mean = sum / count;
      const variance = Math.max(0, sumSq / count - mean * mean);
      const std = Math.sqrt(variance);
      if (std > 0) dayVolZByIdx[i] = (sessionBars[i].volume - mean) / std;
    }
    sum += sessionBars[i].volume;
    sumSq += sessionBars[i].volume ** 2;
    count++;
  }

  const volZs = [], dayVolZs = [];
  for (let i = touchIdx - VOL_BUILD_APPROACH_BARS; i <= touchIdx; i++) {
    const b = sessionBars[i];
    const bl = baseline.get(b.mod);
    if (bl && bl.std_vol > 0) volZs.push((b.volume - bl.avg_vol) / bl.std_vol);
    if (dayVolZByIdx[i] != null) dayVolZs.push(dayVolZByIdx[i]);
  }
  const idxArr = (arr) => Array.from({ length: arr.length }, (_, i) => i);
  return {
    avgVolZ: volZs.length >= 5 ? volZs.reduce((a, b) => a + b, 0) / volZs.length : null,
    volZTrend: volZs.length >= 5 ? pearsonCorr(idxArr(volZs), volZs) : null,
    avgDayVolZ: dayVolZs.length >= 5 ? dayVolZs.reduce((a, b) => a + b, 0) / dayVolZs.length : null,
    dayVolZTrend: dayVolZs.length >= 5 ? pearsonCorr(idxArr(dayVolZs), dayVolZs) : null,
  };
}

// calib: { avgVolZMed, volZTrendMed, avgDayVolZMed, dayVolZTrendMed, avgVolZP60, volZTrendP60,
// avgDayVolZP60, dayVolZTrendP60 } from the latest VOLUME_BUILDING_CALIBRATION row.
function classifyVolumeBuilding(measures, calib) {
  const { avgVolZ, volZTrend, avgDayVolZ, dayVolZTrend } = measures;
  if ([avgVolZ, volZTrend, avgDayVolZ, dayVolZTrend].some(v => v == null) || !calib) {
    return { ...measures, agreesMedian: null, agreesP60: null };
  }
  const timeOfDayMedian = avgVolZ > calib.avgVolZMed && volZTrend > calib.volZTrendMed;
  const dayMedian = avgDayVolZ > calib.avgDayVolZMed && dayVolZTrend > calib.dayVolZTrendMed;
  const timeOfDayP60 = avgVolZ > calib.avgVolZP60 && volZTrend > calib.volZTrendP60;
  const dayP60 = avgDayVolZ > calib.avgDayVolZP60 && dayVolZTrend > calib.dayVolZTrendP60;
  return { ...measures, agreesMedian: timeOfDayMedian && dayMedian, agreesP60: timeOfDayP60 && dayP60 };
}

// Cumulative-delta "point of no return" baseline (2026-09-03, docs/
// EXTREME_PRESSURE_POINT_OF_NO_RETURN_SPEC.md) -- a DIFFERENT baseline shape from
// getVolumeBaseline() above. getVolumeBaseline answers "what does THIS bar usually look
// like" (per-bar instantaneous stats); this answers "what does the RUNNING SUM usually
// look like by this point since IB close" (per-bar-index cumulative-sum stats). Nobody
// computed that distribution anywhere else in this codebase before this.
//
// DeepSeek design review (scratch/deepseek_response.md, 2026-09-03) found the original
// plan's "key by a running bar-index counter" was unsafe -- a single mid-session data
// gap on a historical day silently time-shifts every later index on that day. Fixed by
// keying on `mod - IB_CLOSE_MOD` (minute-of-day minus IB close, same `mod` convention
// getVolumeBaseline itself uses) so a missing minute just leaves a gap in the index
// space rather than shifting everything after it. Early-close days are excluded from the
// trailing window (via marketCalendar.js's getMarketStatus) since they'd otherwise
// contribute truncated cumulative series that can never reach the live poller's own
// afternoon evaluation window.
//
// Returns a Map: idx (minutes since IB close) -> { mean, std, n } across the trailing
// window. dir: 'SHORT' baseline tracks cumulative (bid_volume - ask_volume) [sell-side
// pressure]; 'LONG' tracks the mirror (ask_volume - bid_volume) [buy-side pressure] --
// see docs/EXTREME_PRESSURE_POINT_OF_NO_RETURN_SPEC.md, downside(SHORT)-only validated
// so far, LONG kept symmetric but UNUSED/unvalidated (upside failed rigor).
const IB_CLOSE_MOD = 630; // 10:30 AM ET -- IB is always 9:30-10:30
async function getCumulativeDeltaBaseline(queryFn, date, dir, marketStatusFn) {
  const res = await queryFn(`
    SELECT ts::date::text as d, (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int AS mod,
           COALESCE(bid_volume,0)::float AS bid_volume, COALESCE(ask_volume,0)::float AS ask_volume
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts::date >= $1::date - INTERVAL '90 days' AND ts::date < $1::date
      AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int >= ${IB_CLOSE_MOD}
    ORDER BY ts
  `, [date]);
  const byDate = new Map();
  for (const r of res.rows) {
    if (marketStatusFn && marketStatusFn(r.d)?.type === 'EARLY_CLOSE') continue;
    if (!byDate.has(r.d)) byDate.set(r.d, []);
    byDate.get(r.d).push(r);
  }
  // Per historical day: running cumulative signed delta, keyed by idx = mod - IB_CLOSE_MOD
  // (gap-safe -- a missing minute just means that idx has no entry for this day, not a
  // shift in every later idx).
  const cumByIdx = new Map(); // idx -> array of cumulative values across days
  for (const bars of byDate.values()) {
    let cum = 0;
    for (const b of bars) {
      const signed = dir === 'LONG' ? (b.ask_volume - b.bid_volume) : (b.bid_volume - b.ask_volume);
      cum += signed;
      const idx = b.mod - IB_CLOSE_MOD;
      if (!cumByIdx.has(idx)) cumByIdx.set(idx, []);
      cumByIdx.get(idx).push(cum);
    }
  }
  const baseline = new Map();
  for (const [idx, vals] of cumByIdx) {
    if (vals.length < 15) continue; // matches getVolumeBaseline-adjacent convention elsewhere -- too few days to trust
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    const std = Math.sqrt(variance);
    if (std > 0) baseline.set(idx, { mean, std, n: vals.length });
  }
  return baseline;
}

export {
  getVolumeBaseline, classifyTouch, computeVolumeBuildingMeasures, classifyVolumeBuilding,
  getCumulativeDeltaBaseline, IB_CLOSE_MOD,
};
