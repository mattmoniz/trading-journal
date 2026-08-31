// VOLUME_BUILDING_CALIBRATION: roster-wide recalibration of the volume-building signal wired
// live (informational-only) onto every real FADE fire's active_setups.vol_building_signal.
// Computes median AND p60-percentile cutoffs for 4 measures -- avgVolZ/volZTrend (existing
// time-of-day-relative baseline) and avgDayVolZ/dayVolZTrend (day-relative, z-scored against
// this session's own running volume since open) -- from the real (origin_status ACTIVE/SHADOW)
// fired FADE population. Persists a single roster-wide row so the live INSERT paths in acd.js
// always read a fresh, self-recalibrating cutoff rather than a hardcoded number.
//
// Origin: docs/OPEN_THREADS.md 2026-08-28 entry. Both measures used via the SAME shared
// function the live code calls (server/services/touchQuality.js's computeVolumeBuildingMeasures)
// -- per CLAUDE.md's "export the real function, never reimplement" rule, this script does not
// hand-roll the volZ/pearson math a second time.
import { query } from '../server/db.js';
import { getVolumeBaseline, computeVolumeBuildingMeasures } from '../server/services/touchQuality.js';

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
function percentile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

// FIXED 2026-08-28 (DeepSeek code QA, independently verified): unbounded backward scan meant a
// missing session-open bar (a real, if occasional, data gap) silently matched a PRIOR session's
// boundary bar instead, spanning multiple sessions -- same root cause as the live
// getSessionBarsSinceOpen() fix in acd.js. Capped at 1200 bars (20 hours of 1-min bars, a session
// is at most ~15h) so a missing boundary bar now correctly returns null (caller skips the row)
// instead of silently walking into a prior session.
const MAX_SESSION_LOOKBACK_BARS = 1200;
function findSessionStartIdx(barsSorted, touchGlobalIdx) {
  const touchMod = barsSorted[touchGlobalIdx].mod;
  const isRTH = touchMod >= 570 && touchMod < 1080;
  const boundaryMod = isRTH ? 570 : 1080;
  const floor = Math.max(0, touchGlobalIdx - MAX_SESSION_LOOKBACK_BARS);
  for (let i = touchGlobalIdx; i >= floor; i--) {
    if (barsSorted[i].mod === boundaryMod) return i;
  }
  return null;
}

async function main() {
  const setupsRes = await query(`
    SELECT a.trade_date::text as trade_date, a.setup_type, a.fired_at, a.resolution, a.actual_pnl
    FROM active_setups a
    WHERE a.origin_status IN ('ACTIVE','SHADOW')
      AND a.resolution IN ('STOP_HIT','TARGET_HIT')
      AND a.actual_pnl IS NOT NULL
      AND a.setup_type LIKE '%FADE%'
      AND a.fired_at IS NOT NULL
    ORDER BY a.fired_at ASC
  `);
  console.log(`Roster-wide real FADE population: N=${setupsRes.rows.length}`);

  const barsRes = await query(`
    SELECT ts, COALESCE(bid_volume,0)+COALESCE(ask_volume,0) as volume,
           (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as mod
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const barsSorted = barsRes.rows.map(b => ({ ts: b.ts, mod: b.mod, volume: Number(b.volume) }));
  const tsIndex = new Map();
  for (let i = 0; i < barsSorted.length; i++) tsIndex.set(barsSorted[i].ts.getTime(), i);

  const baselineCache = new Map();
  async function getBaselineCached(date) {
    if (!baselineCache.has(date)) baselineCache.set(date, await getVolumeBaseline(query, date));
    return baselineCache.get(date);
  }

  const rows = { avgVolZ: [], volZTrend: [], avgDayVolZ: [], dayVolZTrend: [] };
  const compositeScores = []; // for quintile cutoffs backing the live display gauge
  const priorAvgs = []; // momentum-context: avg composite score over the preceding (up to) 30
  // bars WITHIN THE SAME SESSION (never crosses the session boundary -- matches the live
  // computeLiveVolumeBuildingSignal() guard, a stricter version of the retrospective research
  // scripts this backs, per RESEARCH_CLAIM building_strength_momentum_feeds_momentum /
  // momentum_feeds_momentum_robust_across_daytype, 2026-08-29).
  let matched = 0, noMatch = 0, noSession = 0;
  for (const s of setupsRes.rows) {
    const flooredFiredAt = new Date(s.fired_at); flooredFiredAt.setSeconds(0, 0);
    const touchGlobalIdx = tsIndex.get(flooredFiredAt.getTime());
    if (touchGlobalIdx === undefined) { noMatch++; continue; }
    const sessionStartIdx = findSessionStartIdx(barsSorted, touchGlobalIdx);
    if (sessionStartIdx === null) { noSession++; continue; }
    const sessionBars = barsSorted.slice(sessionStartIdx, touchGlobalIdx + 1);
    const touchIdx = sessionBars.length - 1;
    const baseline = await getBaselineCached(s.trade_date);
    const m = computeVolumeBuildingMeasures(sessionBars, touchIdx, baseline);
    if (m.avgVolZ == null || m.avgDayVolZ == null) continue;
    matched++;
    rows.avgVolZ.push(m.avgVolZ);
    rows.volZTrend.push(m.volZTrend);
    rows.avgDayVolZ.push(m.avgDayVolZ);
    rows.dayVolZTrend.push(m.dayVolZTrend);
    compositeScores.push(m.avgVolZ + m.volZTrend + m.avgDayVolZ + m.dayVolZTrend);

    if (touchIdx >= 30) {
      const priorScores = [];
      for (let k = touchIdx - 30; k < touchIdx; k++) {
        const pm = computeVolumeBuildingMeasures(sessionBars, k, baseline);
        if (pm.avgVolZ != null && pm.avgDayVolZ != null) priorScores.push(pm.avgVolZ + pm.volZTrend + pm.avgDayVolZ + pm.dayVolZTrend);
      }
      if (priorScores.length >= 20) priorAvgs.push(priorScores.reduce((a, b) => a + b, 0) / priorScores.length);
    }
  }
  console.log(`Matched with full measures: N=${matched} (no bar match: ${noMatch}, no session start found: ${noSession})`);
  console.log(`Momentum-context prior-avg sample: N=${priorAvgs.length}`);

  if (matched < 100) {
    console.log('Population too thin (<100) to recalibrate -- leaving prior calibration row in place.');
    process.exit(0);
  }

  const calib = {
    avgVolZMed: +median(rows.avgVolZ).toFixed(4),
    volZTrendMed: +median(rows.volZTrend).toFixed(4),
    avgDayVolZMed: +median(rows.avgDayVolZ).toFixed(4),
    dayVolZTrendMed: +median(rows.dayVolZTrend).toFixed(4),
    avgVolZP60: +percentile(rows.avgVolZ, 0.6).toFixed(4),
    volZTrendP60: +percentile(rows.volZTrend, 0.6).toFixed(4),
    avgDayVolZP60: +percentile(rows.avgDayVolZ, 0.6).toFixed(4),
    dayVolZTrendP60: +percentile(rows.dayVolZTrend, 0.6).toFixed(4),
    // Momentum-context median (RESEARCH_CLAIM momentum_feeds_momentum_robust_across_daytype):
    // classifies a spike as ACTIVE- vs QUIET-then-spike. null (not 0) if the sample's too thin
    // to trust yet -- computeLiveVolumeBuildingSignal() must treat null as "don't classify",
    // never fall back to a hardcoded number.
    momentumContextPriorAvgMedian: priorAvgs.length >= 50 ? +median(priorAvgs).toFixed(4) : null,
    momentumContextCalibratedFrom: priorAvgs.length,
    // Composite-strength quintile cutoffs (RESEARCH_CLAIM volume_building_no_level_initiative_test
    // magnitude dose-response, confirmed via independent Gemini replication 2026-08-29) -- backs
    // the live display gauge's plain-English bucket, informational only.
    compositeStrengthP20: +percentile(compositeScores, 0.2).toFixed(4),
    compositeStrengthP40: +percentile(compositeScores, 0.4).toFixed(4),
    compositeStrengthP60: +percentile(compositeScores, 0.6).toFixed(4),
    compositeStrengthP80: +percentile(compositeScores, 0.8).toFixed(4),
    calibratedFrom: matched,
    calibratedAt: new Date().toISOString(),
  };
  console.log('New calibration:', calib);

  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes)
    VALUES (CURRENT_DATE, 0, 'VOLUME_BUILDING_CALIBRATION', 'ROSTER_WIDE_FADE', $1, $2)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET sample_size = EXCLUDED.sample_size, notes = EXCLUDED.notes
  `, [matched, JSON.stringify(calib)]);
  console.log('Persisted VOLUME_BUILDING_CALIBRATION / ROSTER_WIDE_FADE.');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
