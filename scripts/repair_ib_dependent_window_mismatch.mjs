// repair_ib_dependent_window_mismatch.mjs
//
// Final wave of the window-mismatch fix (docs/OPEN_THREADS.md 2026-07-14), for the 4 setup
// families deliberately deferred from earlier waves because of the IB definitional mismatch
// (docs/KNOWN_ISSUES.md item 11): live acd.js computed a 60-minute Initial Balance while
// scripts/compute_levels.js computed a 30-minute one. Fixed at the source (compute_levels.js
// now uses 570-629 like acd.js; level_prices re-backfilled for all historical dates,
// 2026-07-14, confirmed by the user as the correct definition to standardize on).
//
// This script applies the SAME window-mismatch fix as the earlier 3 waves (first touch
// anywhere in RTH instead of the archived backfill's 10:30am-noon restriction) to:
//   IB_HIGH, IB_LOW, IB_MID (IB_MID_SCALP_FADE) -- gate 630 (10:30 ET, matches acd.js's
//     etMinNow>=630 and the now-corrected 60min IB formation time)
//   OR_MID (OR_MID_AFTER_IB_FADE) -- also gated 630, since acd.js explicitly gates this one
//     on IB close too (server/routes/acd.js ~line 4738), not on OR's own 9:35 formation
//   PD_IB_HIGH, PD_IB_LOW, PD_IB_MID -- gate 570 (prior-day derived, safe from session open),
//     RE-DONE here even though wave 2/3 already fixed their window-timing, because those
//     waves used the stale (30min) level_prices values -- this pass reads the corrected
//     (60min, backfilled) values instead. Superset of the earlier PD_IB_HIGH/PD_IB_LOW fix.
//
// Run: node scripts/repair_ib_dependent_window_mismatch.mjs [--dry-run]

import pg from 'pg';
const pool = new pg.Pool({ host: 'localhost', port: 5432, database: 'trading_journal', user: 'trader', password: 'trader123' });
const q = (t, p) => pool.query(t, p);

const DRY_RUN = process.argv.includes('--dry-run');
const PT = 5, COMM = 5;
const RTH_END = 960, SESSION_END = 960;

const LEVEL_PARAMS = {
  IB_HIGH:    { stopDist: 52.44, t1Dist: 30.38, setupSuffix: 'IB_HIGH_FADE',        gate: 630, source: 'live' },
  IB_LOW:     { stopDist: 67.63, t1Dist: 34.00, setupSuffix: 'IB_LOW_FADE',         gate: 630, source: 'live' },
  IB_MID:     { stopDist: 56.25, t1Dist: 29.00, setupSuffix: 'IB_MID_SCALP_FADE',   gate: 630, source: 'live' },
  OR_MID:     { stopDist: 62.00, t1Dist: 30.25, setupSuffix: 'OR_MID_AFTER_IB_FADE',gate: 630, source: 'live' },
  PD_IB_HIGH: { stopDist: 81.10, t1Dist: 40.10, setupSuffix: 'PD_IB_HIGH_FADE',     gate: 570, source: 'level_prices' },
  PD_IB_LOW:  { stopDist: 67.30, t1Dist: 41.30, setupSuffix: 'PD_IB_LOW_FADE',      gate: 570, source: 'level_prices' },
};

function detectFirstTouch(bars, levels) {
  const fires = [];
  const fired = new Set();
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], prev = bars[i - 1];
    for (const [levelName, lvl] of Object.entries(levels)) {
      if (lvl == null || fired.has(levelName)) continue;
      const gate = LEVEL_PARAMS[levelName].gate;
      if (b.tod < gate || b.tod >= RTH_END) continue;
      if (Math.abs(b.close - lvl) > 15) continue;
      const fromAbove = prev.close > lvl;
      const dir = fromAbove ? 'LONG' : 'SHORT';
      fires.push({ levelName, dir, barIdx: i, barTs: b.ts, entryPx: b.close, levelPx: lvl });
      fired.add(levelName);
    }
  }
  for (const f of fires) f.confluenceCount = fires.filter(o => o.barIdx === f.barIdx && o !== f).length;
  return fires;
}
function resolve(bars, fromIdx, isLong, stop, t1) {
  for (let i = fromIdx + 1; i < bars.length; i++) {
    const b = bars[i];
    if (b.tod > SESSION_END) break;
    const stopHit = isLong ? b.low <= stop : b.high >= stop;
    const targetHit = isLong ? b.high >= t1 : b.low <= t1;
    if (stopHit && targetHit) {
      const towardT1 = isLong ? b.open > stop : b.open < stop;
      return towardT1 ? { resolution: 'TARGET_HIT', resolvedAt: b.ts } : { resolution: 'STOP_HIT', resolvedAt: b.ts };
    }
    if (targetHit) return { resolution: 'TARGET_HIT', resolvedAt: b.ts };
    if (stopHit) return { resolution: 'STOP_HIT', resolvedAt: b.ts };
  }
  return { resolution: 'TIME_EXPIRED', resolvedAt: null };
}

console.log(`Repair IB-dependent window mismatch${DRY_RUN ? ' [DRY RUN]' : ''}`);

const targetTypes = Object.values(LEVEL_PARAMS).flatMap(p => [`${p.setupSuffix}_LONG`, `${p.setupSuffix}_SHORT`]);

if (!DRY_RUN) {
  await q(`DROP TABLE IF EXISTS active_setups_ib_window_backup_20260714`);
  await q(`
    CREATE TABLE active_setups_ib_window_backup_20260714 AS
    SELECT * FROM active_setups WHERE setup_type = ANY($1) AND resolution_method = 'BACKFILL'
  `, [targetTypes]);
  const cnt = await q(`SELECT COUNT(*) FROM active_setups_ib_window_backup_20260714`);
  console.log(`Backed up ${cnt.rows[0].count} rows`);
  const del = await q(`DELETE FROM active_setups WHERE setup_type = ANY($1) AND resolution_method = 'BACKFILL'`, [targetTypes]);
  console.log(`Deleted ${del.rowCount} rows`);
}

const paRows = await q(`SELECT signal_name, win_rate::float, sample_size::int FROM performance_audit WHERE signal_type IN ('LEVEL_FADE_AUDIT','MIDPOINT_FADE_AUDIT')`);
const perfParams = {};
for (const row of paRows.rows) perfParams[row.signal_name] = { winRate: row.win_rate, sessions: row.sample_size };

const datesR = await q(`SELECT DISTINCT trade_date::text as d FROM level_prices WHERE trade_date < CURRENT_DATE ORDER BY d`);
const dates = datesR.rows.map(r => r.d);
console.log(`Processing ${dates.length} dates`);

let inserted = 0;
const statsByType = {};

for (const date of dates) {
  const barsR = await q(`
    SELECT ts::text as ts, open::float, high::float, low::float, close::float,
           EXTRACT(hour FROM ts)::int * 60 + EXTRACT(minute FROM ts)::int as tod
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 569 AND 961
    ORDER BY tod
  `, [date]);
  const bars = barsR.rows;
  if (bars.length < 30) continue;

  const levels = {};
  // PD_IB_HIGH/PD_IB_LOW read from level_prices (now backfilled with the corrected 60min IB)
  const lpR = await q(`SELECT level_name, price::float FROM level_prices WHERE trade_date=$1 AND level_name = ANY($2)`, [date, ['PD_IB_HIGH', 'PD_IB_LOW']]);
  for (const row of lpR.rows) levels[row.level_name] = row.price;
  // IB_HIGH/IB_LOW/IB_MID/OR_MID: today's own IB/OR, computed fresh the same way acd.js does
  // (60min window, bars 570-629) -- matches live exactly, not level_prices (which reflects
  // whatever was true as of the backfill run, fine either way since both now agree, but this
  // keeps the source-of-truth explicit and matches the "live" tag above).
  const ibR = await q(`
    SELECT MAX(high)::float AS h, MIN(low)::float AS l
    FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 629
  `, [date]);
  if (ibR.rows[0]?.h != null) {
    levels.IB_HIGH = ibR.rows[0].h;
    levels.IB_LOW = ibR.rows[0].l;
    levels.IB_MID = (ibR.rows[0].h + ibR.rows[0].l) / 2;
  }
  const orR = await q(`SELECT or_high::float oh, or_low::float ol FROM acd_daily_log WHERE trade_date=$1`, [date]);
  if (orR.rows[0]?.oh != null && levels.IB_HIGH != null) {
    levels.OR_MID = (orR.rows[0].oh + orR.rows[0].ol) / 2;
  }
  if (!Object.keys(levels).length) continue;

  const fires = detectFirstTouch(bars, levels);
  for (const fire of fires) {
    const params = LEVEL_PARAMS[fire.levelName];
    if (!params) continue;
    const isLong = fire.dir === 'LONG';
    const entry = Math.round(fire.entryPx * 4) / 4;
    const stopDist = params.stopDist, t1Dist = params.t1Dist;
    const stop = isLong ? entry - stopDist : entry + stopDist;
    const t1 = isLong ? entry + t1Dist : entry - t1Dist;
    if (isLong && (stop >= entry || t1 <= entry)) continue;
    if (!isLong && (stop <= entry || t1 >= entry)) continue;

    const setupType = `${params.setupSuffix}_${fire.dir}`;
    const { resolution, resolvedAt } = resolve(bars, fire.barIdx, isLong, stop, t1);
    let pnl = null;
    if (resolution === 'TARGET_HIT') pnl = Math.round((t1Dist * PT - COMM) * 100) / 100;
    if (resolution === 'STOP_HIT') pnl = Math.round((-stopDist * PT - COMM) * 100) / 100;
    if (resolution === 'TIME_EXPIRED') pnl = 0;
    const status = resolution === 'TIME_EXPIRED' ? 'EXPIRED' : 'RESOLVED';
    const pa = perfParams[fire.levelName] || {};
    const expiresAt = `${date} 16:00:00`;
    const t1Label = `T1: ${t1Dist}pt (p50 MFE) | Stop: ${stopDist}pt (p75 MAE) [first-touch-anytime, live-matching, 60min IB]`;

    if (!statsByType[setupType]) statsByType[setupType] = { total: 0, wins: 0, losses: 0, pnl: 0 };
    statsByType[setupType].total++;
    if (resolution === 'TARGET_HIT') statsByType[setupType].wins++;
    if (resolution === 'STOP_HIT') statsByType[setupType].losses++;
    statsByType[setupType].pnl += pnl || 0;

    if (!DRY_RUN) {
      await q(`
        INSERT INTO active_setups (
          trade_date, setup_type, fired_at, expires_at, resolved_at, status, resolution,
          entry_zone_low, stop_level, t1_level, t1_label,
          structural_level_touched, structural_level_type, price_at_detection,
          historical_win_rate, historical_sessions, historical_source,
          confluence_score_at_detection, actual_pnl, resolution_method
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        ON CONFLICT DO NOTHING
      `, [
        date, setupType, fire.barTs, expiresAt, resolvedAt, status, resolution,
        entry, stop, t1, t1Label, fire.levelPx, fire.levelName, entry,
        pa.winRate ?? null, pa.sessions ?? null, 'LEVEL_FADE_AUDIT',
        fire.confluenceCount, pnl, 'BACKFILL',
      ]);
    }
    inserted++;
  }
}

console.log(`\n${DRY_RUN ? 'Would insert' : 'Inserted'}: ${inserted}`);
for (const [type, s] of Object.entries(statsByType).sort((a,b)=>b[1].total-a[1].total)) {
  const resolved = s.wins + s.losses;
  const wr = resolved > 0 ? (s.wins / resolved * 100).toFixed(1) : 'n/a';
  const ev = resolved > 0 ? (s.pnl / resolved).toFixed(2) : 'n/a';
  console.log(`  ${type.padEnd(26)} total=${s.total} resolved=${resolved} WR=${wr}% EV=$${ev}/trade pnl=$${Math.round(s.pnl)}`);
}
await pool.end();
