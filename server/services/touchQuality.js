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
// day-relative baseline (is this loud for how today itself has traded so far). Pooled
// roster-wide across all real FADE fires, neither measure alone moved the hit rate, but
// requiring BOTH to agree did (baseline WR=49.5%/EV=-$1.24 -> both-agree WR=51.7%/EV=$2.40,
// tightened to a p60-both-agree cutoff: WR=54.3%/EV=$7.11 at N=105) -- see RESEARCH_CLAIMs
// fade_roster_volume_building_pooled_vs_pertype, volz_day_relative_vs_timeofday_reference_frame,
// fade_roster_volume_building_dose_response_cutoff. Wired live INFORMATIONAL ONLY via
// active_setups.vol_building_signal -- does not gate/size anything yet, self-recalibrates
// weekly via scripts/backtest_volume_building_signal.mjs.
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

export { getVolumeBaseline, classifyTouch, computeVolumeBuildingMeasures, classifyVolumeBuilding };
