// GET /api/market/pulse's internal logic — extracted 2026-09-27 (acd.js file-size reduction,
// opportunistic pass beyond docs/ACDJS_FILE_SIZE_REDUCTION_SPEC.md's original Phase A/B scope).
// Confirmed genuinely self-contained before moving (only `query`/`getLatestBars`/`getCached`/
// `setCached`, no closure over runSetupDetection's liveStats or any other router-scoped state) --
// same shape as Phase B's /performance-audit/unified extraction. Route registration stays in
// acd.js (the one explicit exception to "move new logic to services") as a thin wrapper that
// calls this function and does the res.json()/error handling -- matching the existing
// detectGlobexSetup()/computeStackVolSignal() precedent this codebase already uses elsewhere.
//
// This is a HOT, live-polled endpoint (App.jsx and MarketPulseBar.jsx both poll it every 30s,
// quick-check.html fetches it too) -- byte-diffed the real live response before and after this
// move (only the `ts` field, a fresh timestamp on every call, differs) before trusting it, per
// this codebase's own verification discipline for extractions touching a hot path.
import { query } from '../db.js';
import { getLatestBars } from './priceRetrieval.js';
import { getCached, setCached } from './acdShared.js';

export async function computeMarketPulse() {
  // FIXED 2026-08-24 (DeepSeek quick-check.html audit): was a hardcoded `etOffset = -4`
  // (EDT), silently correct only during EDT months -- would have been off by exactly 1hr
  // every day of EST season (Nov-Mar), shifting the date rollover and RTH-window boundary
  // an hour early, the same naive-offset bug class CLAUDE.md's hard rules document
  // elsewhere. Now uses this file's own established DST-aware pattern (toLocaleString/
  // toLocaleDateString with timeZone: 'America/New_York', e.g. runSetupDetection's
  // nowET/todayET just above) instead of a hand-computed offset.
  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const etHour = etNow.getHours();
  const etMin  = etNow.getMinutes();
  const etMinTotal = etHour * 60 + etMin;
  const isRTH = etMinTotal >= 570 && etMinTotal < 960 &&
    etNow.getDay() >= 1 && etNow.getDay() <= 5;

  // Current price + session bars + live setup + ACD state
  const [priceQ, sessionQ, rthBarsQ, setupQ, acdQ] = await Promise.all([
    getLatestBars('NQ', { limit: 1, columns: 'close::float' }, 'trend-watch.currentPrice').then(rows => ({ rows })),
    query(`SELECT MAX(high)::float as h, MIN(low)::float as l FROM price_bars_primary
           WHERE symbol='NQ' AND ts::date=$1
           AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959`, [todayET]),
    query(`SELECT close::float, COALESCE(ask_volume,0)::int as ask_vol, COALESCE(bid_volume,0)::int as bid_vol, volume::int,
           (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min
           FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
           AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
           ORDER BY ts`, [todayET]),
    query(`SELECT setup_type, status FROM active_setups
           WHERE trade_date=$1 AND status IN ('PENDING','ACTIVE','ACTIVE_MANAGING')
           ORDER BY fired_at DESC LIMIT 1`, [todayET]),
    query(`SELECT a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed, day_type
           FROM acd_daily_log WHERE trade_date=$1 LIMIT 1`, [todayET]),
  ]);

  const currentPrice = priceQ.rows[0]?.close ?? null;
  const sessionHigh = sessionQ.rows[0]?.h ?? null;
  const sessionLow  = sessionQ.rows[0]?.l ?? null;
  const bars = rthBarsQ.rows;
  const sessionOpen = bars[0]?.close ?? null;
  const sessionRange = sessionHigh && sessionLow ? +(sessionHigh - sessionLow).toFixed(1) : null;
  const ptsFromOpen = currentPrice && sessionOpen ? +(currentPrice - sessionOpen).toFixed(1) : null;

  // Cumulative delta
  const sessionDelta = bars.reduce((s, b) => s + (b.ask_vol - b.bid_vol), 0);
  const sessionVolume = bars.reduce((s, b) => s + (b.volume || 0), 0);

  // Cached daily: range percentiles + delta percentiles + avg volume
  let rangeP25 = null, rangeP50 = null, rangeP75 = null;
  let deltaP25 = null, deltaP75 = null;
  let avgSessionVol = null;

  const cached = getCached(todayET, 'marketPulse');
  if (cached) {
    ({ rangeP25, rangeP50, rangeP75, deltaP25, deltaP75, avgSessionVol } = cached);
  } else {
    const [rangeQ, deltaQ, volQ] = await Promise.all([
      query(`
        WITH daily AS (
          SELECT ts::date as d, MAX(high)-MIN(low) as rng
          FROM price_bars_primary WHERE symbol='NQ'
            AND ts::date < $1
            AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
            AND EXTRACT(DOW FROM ts) BETWEEN 1 AND 5
          GROUP BY 1 HAVING COUNT(*)>200
        )
        SELECT
          PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY rng)::float as p25,
          PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY rng)::float as p50,
          PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY rng)::float as p75
        FROM daily`, [todayET]),
      query(`
        WITH daily AS (
          SELECT ts::date as d,
            ABS(SUM(COALESCE(ask_volume,0)-COALESCE(bid_volume,0)))::float as abs_delta
          FROM price_bars_primary WHERE symbol='NQ'
            AND ts::date < $1
            AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
            AND EXTRACT(DOW FROM ts) BETWEEN 1 AND 5
          GROUP BY 1 HAVING COUNT(*)>200
        )
        SELECT
          PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY abs_delta)::float as p25,
          PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY abs_delta)::float as p75
        FROM daily`, [todayET]),
      query(`
        WITH daily AS (
          SELECT ts::date as d, SUM(volume)::float as total_vol
          FROM price_bars_primary WHERE symbol='NQ'
            AND ts::date < $1
            AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
            AND EXTRACT(DOW FROM ts) BETWEEN 1 AND 5
          GROUP BY 1 HAVING COUNT(*)>200
          ORDER BY d DESC LIMIT 20
        )
        SELECT AVG(total_vol)::float as avg FROM daily`, [todayET]),
    ]);
    rangeP25 = rangeQ.rows[0]?.p25 ?? null;
    rangeP50 = rangeQ.rows[0]?.p50 ?? null;
    rangeP75 = rangeQ.rows[0]?.p75 ?? null;
    deltaP25 = deltaQ.rows[0]?.p25 ?? null;
    deltaP75 = deltaQ.rows[0]?.p75 ?? null;
    avgSessionVol = volQ.rows[0]?.avg ?? null;
    setCached(todayET, 'marketPulse', { rangeP25, rangeP50, rangeP75, deltaP25, deltaP75, avgSessionVol });
  }

  // Derived signals
  const absDelta = Math.abs(sessionDelta);
  const deltaSign = sessionDelta > 0 ? 'BUYING' : sessionDelta < 0 ? 'SELLING' : 'NEUTRAL';
  let deltaClass = 'NORMAL';
  if (deltaP25 != null && absDelta < deltaP25) deltaClass = 'QUIET';
  else if (deltaP75 != null && absDelta > deltaP75) deltaClass = 'HIGH';

  // Range extension: where is today's range relative to historical?
  let rangeClass = 'NORMAL';
  if (rangeP25 != null && sessionRange < rangeP25) rangeClass = 'QUIET';
  else if (rangeP75 != null && sessionRange > rangeP75) rangeClass = 'EXTENDED';

  // RVol: time-of-day adjusted — last bar vs 90-day per-minute baseline (same method as VOLUME_SPIKE alert)
  // This makes the chip consistent with the VOLUME SPIKE banner in TradeAlertBanner.
  let rvol = null, rvolSigma = null;
  const last3 = bars.slice(-3);
  if (last3.length > 0) {
    try {
      const minLo = Math.min(...last3.map(b => b.et_min));
      const minHi = Math.max(...last3.map(b => b.et_min));
      const volBaseQ = await query(`
        SELECT (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min,
               AVG(volume::float) as avg_vol, STDDEV(volume::float) as std_vol
        FROM price_bars_primary WHERE symbol='NQ'
        AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) BETWEEN $1 AND $2
        AND ts::date >= $3::date - 90 AND ts::date < $3
        GROUP BY et_min
      `, [minLo, minHi, todayET]);
      const baseline = {};
      for (const r of volBaseQ.rows) baseline[r.et_min] = { avg: +r.avg_vol, std: +r.std_vol };
      let maxSigma = -Infinity, maxRatio = 1;
      for (const b of last3) {
        const bl = baseline[b.et_min];
        if (!bl || bl.avg <= 0) continue;
        const sig = bl.std > 0 ? (b.volume - bl.avg) / bl.std : 0;
        if (sig > maxSigma) { maxSigma = sig; maxRatio = b.volume / bl.avg; }
      }
      if (maxSigma > -Infinity) {
        rvol = +maxRatio.toFixed(2);
        rvolSigma = +maxSigma.toFixed(2);
      }
    } catch (_) {}
  }

  // Engagement verdict — uses active setup, ACD signals, delta/range, time of day
  const liveSetup = setupQ.rows[0] ?? null;
  const acd       = acdQ.rows[0]  ?? null;

  // Direction from setup_type name (e.g. IB_MID_SCALP_FADE_LONG → LONG)
  const setupDir = liveSetup?.setup_type?.includes('_LONG')  ? 'LONG'
    :              liveSetup?.setup_type?.includes('_SHORT') ? 'SHORT'
    : null;

  // ACD directional read — C-confirmed is strong, A-only is softer
  const aUpStrong   = acd?.a_up_fired   && acd?.c_up_confirmed;
  const aDownStrong = acd?.a_down_fired  && acd?.c_down_confirmed;
  const acdDir = aUpStrong   ? 'LONG'
    :            aDownStrong ? 'SHORT'
    :            acd?.a_up_fired   ? 'LONG'
    :            acd?.a_down_fired ? 'SHORT'
    : null;

  // After 3:30 PM ET with nothing live — wind down
  const isWindDown = etMinTotal >= 930 && !liveSetup;

  let verdict    = 'WAIT';
  let verdictDir = null;

  if (isWindDown) {
    verdict = 'STAND_ASIDE';
  } else if (liveSetup) {
    // Active fired setup is the clearest signal we have — go
    verdict    = 'ENGAGE';
    verdictDir = setupDir;
  } else if ((aUpStrong || aDownStrong) && deltaClass !== 'QUIET') {
    // A+C confirmed with some participation — high conviction directional
    verdict    = 'ENGAGE';
    verdictDir = acdDir;
  } else if (acdDir && rangeClass !== 'QUIET' && deltaClass === 'HIGH') {
    // A-only + strong flow — engage but softer
    verdict    = 'ENGAGE';
    verdictDir = acdDir;
  } else if (deltaClass === 'QUIET' && rangeClass === 'QUIET' && !acdDir) {
    // No flow, no range expansion, no ACD — nothing to trade
    verdict = 'STAND_ASIDE';
  } else if (deltaClass === 'HIGH' && rangeClass !== 'QUIET') {
    // Strong flow even without a named setup — worth watching
    verdict    = 'ENGAGE';
    verdictDir = deltaSign === 'BUYING' ? 'LONG' : 'SHORT';
  }

  return {
    currentPrice,
    sessionOpen,
    sessionHigh,
    sessionLow,
    sessionRange,
    ptsFromOpen,
    sessionDelta,
    deltaSign,
    deltaClass,
    absDelta,
    deltaP25, deltaP75,
    rangeP25, rangeP50, rangeP75,
    rangeClass,
    rvol,
    rvolSigma,
    verdict,
    verdictDir,
    isRTH,
    barsLoaded: bars.length,
    ts: new Date().toISOString(),
  };
}
