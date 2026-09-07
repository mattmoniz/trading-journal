// Shared computation for the wide-IB + LIVE-TURBULENT-reassessment hold-longer exit-timing
// test (RESEARCH_CLAIM wide_ib_turbulent_hold_longer_exit_timing_20260906). Extracted 2026-09-07
// out of scripts/task2_wide_ib_turbulent_exit_timing.mjs so scripts/verify_wide_ib_turbulent_
// exit_timing_recheck.mjs can reuse the exact same logic for its periodic recheck instead of
// copy-pasting it a second time (this file existing IS the fix for that — see
// scripts/lib/selfCheckingClaim.mjs's header for the "we should probably make a class/shared
// module" request this pattern started from).
//
// Reuses the real live mechanisms, never reimplements: getLiveDayTypeRead() (the actual live
// day-type reassessment engine) and stepWiderTarget() (the actual live hold-longer walker).
import { getLiveDayTypeRead } from '../../server/services/caseEngine.js';
import { LIVE_INSTRUMENT } from '../../server/config/instruments.js';
import { stepWiderTarget } from '../../server/services/widerTargetWalker.js';

const IB_TERCILE_FLOOR = 0.666;
const IB_START_MIN = 570, IB_END_MIN = 629;
const ROLLING_WINDOW = 180;

// query: an async (sql, params) => { rows } function -- caller supplies either server/db.js's
// query() or a raw pg.Client's .query bound the same way, so this works from both a live-DB
// context and a gemini_readonly-credentialed standalone script.
export async function computeWideIbTurbulentExitDeltas(query) {
  const setupsRes = await query(`
    SELECT
      a.id, a.trade_date, a.setup_type, a.actual_pnl, a.resolution, a.entry_zone_high, a.entry_zone_low, a.stop_level, a.t1_level, a.origin_status,
      (EXTRACT(hour FROM a.fired_at AT TIME ZONE 'America/New_York')*60 + EXTRACT(minute FROM a.fired_at AT TIME ZONE 'America/New_York'))::int as fired_et_min,
      (EXTRACT(hour FROM a.resolved_at AT TIME ZONE 'America/New_York')*60 + EXTRACT(minute FROM a.resolved_at AT TIME ZONE 'America/New_York'))::int as resolved_et_min
    FROM active_setups a
    WHERE a.origin_status IN ('ACTIVE', 'SHADOW')
      AND a.actual_pnl IS NOT NULL AND a.fired_at IS NOT NULL AND a.resolved_at IS NOT NULL
  `);
  const setups = setupsRes.rows;
  setups.forEach(s => s.actual_pnl = parseFloat(s.actual_pnl));

  const tradeDates = [...new Set(setups.map(s => new Date(s.trade_date).toISOString().split('T')[0]))];

  const barsRes = await query(`
    SELECT DATE(ts) as trade_date,
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
      ts, open, high, low, close
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND DATE(ts) = ANY($1)
    ORDER BY ts ASC
  `, [tradeDates]);

  const barsByDate = {};
  barsRes.rows.forEach(b => {
    const d = new Date(b.trade_date).toISOString().split('T')[0];
    if (!barsByDate[d]) barsByDate[d] = [];
    b.open = parseFloat(b.open); b.high = parseFloat(b.high); b.low = parseFloat(b.low); b.close = parseFloat(b.close);
    b.mod = b.et_min;
    barsByDate[d].push(b);
  });

  const allDaysRes = await query(`
    SELECT DATE(ts) as trade_date, MAX(high) - MIN(low) as ib_range
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN ${IB_START_MIN} AND ${IB_END_MIN}
    GROUP BY DATE(ts) ORDER BY DATE(ts)
  `);
  const allDays = allDaysRes.rows;

  const dayIbPct = {};
  for (let i = 0; i < allDays.length; i++) {
    const r = allDays[i];
    r.ib_range = parseFloat(r.ib_range);
    const window = allDays.slice(Math.max(0, i - ROLLING_WINDOW), i).map(x => x.ib_range).sort((a, b) => a - b);
    let pct = 0;
    if (window.length > 0) pct = window.filter(w => w <= r.ib_range).length / window.length;
    dayIbPct[new Date(r.trade_date).toISOString().split('T')[0]] = pct;
  }

  const results = [];
  for (const t of setups) {
    const d = new Date(t.trade_date).toISOString().split('T')[0];
    if ((dayIbPct[d] || 0) < IB_TERCILE_FLOOR) continue;

    const dayBars = barsByDate[d];
    if (!dayBars) continue;
    const barsUpToRes = dayBars.filter(b => b.et_min <= t.resolved_et_min);
    if (barsUpToRes.length === 0) continue;

    const ibBars = dayBars.filter(b => b.et_min >= IB_START_MIN && b.et_min <= IB_END_MIN);
    if (ibBars.length === 0) continue;
    const ibHigh = Math.max(...ibBars.map(b => b.high));
    const ibLow = Math.min(...ibBars.map(b => b.low));
    const orWidth = ibHigh - ibLow;
    const sessOpen = dayBars[0].open;

    let liveRead;
    try {
      liveRead = await getLiveDayTypeRead({ tradeDate: d, asOfMinutes: t.resolved_et_min, bars: barsUpToRes, sessOpen, ibHigh, ibLow, nl30: 0, orWidth });
    } catch (e) { continue; }

    if (!liveRead.reassessed || liveRead.finalRead !== 'TURBULENT') continue;

    const isLong = !t.setup_type.includes('SHORT') && !t.setup_type.includes('BEARISH');
    const entry = isLong ? parseFloat(t.entry_zone_high) : parseFloat(t.entry_zone_low);
    const stop = parseFloat(t.stop_level);
    const t1 = parseFloat(t.t1_level);
    const effectiveBase = Math.abs(t1 - entry);
    const widerTarget = isLong ? entry + effectiveBase * 1.5 : entry - effectiveBase * 1.5;

    let state = { widening: false };
    let res = null;
    let barCount = 1;
    const walkBars = dayBars.filter(b => b.et_min >= t.fired_et_min);
    for (const bar of walkBars) {
      const r = stepWiderTarget(state, bar, { entry, stop, t1, widerTarget, long: isLong, barCount, maxBarsToT1: 4, firedMod: t.fired_et_min });
      state = r.state;
      if (r.resolution) { res = r.resolution; break; }
      barCount++;
    }
    if (!res && walkBars.length > 0) res = { priceAtRes: walkBars[walkBars.length - 1].close };
    if (!res) continue;

    const pts = isLong ? res.priceAtRes - entry : entry - res.priceAtRes;
    const proposedPnl = pts * LIVE_INSTRUMENT.dollarsPerPoint - LIVE_INSTRUMENT.commissionPerRoundTrip;
    results.push({ trade_date: d, delta: proposedPnl - t.actual_pnl });
  }

  return results;
}
