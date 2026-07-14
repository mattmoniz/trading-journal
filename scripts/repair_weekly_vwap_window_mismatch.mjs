// repair_weekly_vwap_window_mismatch.mjs
//
// Final wave of the window-mismatch fix (docs/OPEN_THREADS.md 2026-07-14) for
// WEEKLY_VWAP_FADE, deliberately excluded from every earlier wave because its underlying
// level_prices.WEEKLY_VWAP value had a genuine lookahead bug (spanned through that week's
// Friday regardless of the query date -- see docs/KNOWN_ISSUES.md). That's now fixed at the
// source (scripts/compute_levels.js, `wb.fri` -> `date`) and fully re-backfilled across all
// 415 historical dates (including a targeted re-run for ~41 dates that silently failed during
// the first --backfill pass under concurrent DB load and were missed).
//
// Applies the same fix as every other wave: first touch anywhere in RTH (matching live
// acd.js's `nearLevels`, no window restriction) instead of the archived backfill's
// 10:30am-noon window. Gate 570 (9:30 ET open) -- WEEKLY_VWAP is now a legitimate
// week-to-date value as of each date, and live acd.js reads lp.WEEKLY_VWAP with no time gate,
// so this matches live firing behavior exactly.
//
// Run: node scripts/repair_weekly_vwap_window_mismatch.mjs [--dry-run]

import pg from 'pg';
const pool = new pg.Pool({ host: 'localhost', port: 5432, database: 'trading_journal', user: 'trader', password: 'trader123' });
const q = (t, p) => pool.query(t, p);

const DRY_RUN = process.argv.includes('--dry-run');
// $2/pt, $1 commission -- matches acd.js's live PNL_PER_POINT/COMMISSION (real MNQ contract
// value). Was PT=5/COMM=5 (copied from the archived script), corrected 2026-07-14 -- see
// scripts/repair_dollars_per_point.mjs and docs/KNOWN_ISSUES.md.
const PT = 2, COMM = 1;
const RTH_START = 570, RTH_END = 960, SESSION_END = 960;

const LEVEL_PARAMS = {
  WEEKLY_VWAP: { stopDist: 67.30, t1Dist: 41.00, setupSuffix: 'WEEKLY_VWAP_FADE' },
};

function detectFirstTouch(bars, levels) {
  const fires = [];
  const fired = new Set();
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], prev = bars[i - 1];
    if (b.tod < RTH_START || b.tod >= RTH_END) continue;
    for (const [levelName, lvl] of Object.entries(levels)) {
      if (lvl == null || fired.has(levelName)) continue;
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

console.log(`Repair WEEKLY_VWAP window mismatch${DRY_RUN ? ' [DRY RUN]' : ''}`);

const targetTypes = ['WEEKLY_VWAP_FADE_LONG', 'WEEKLY_VWAP_FADE_SHORT'];

if (!DRY_RUN) {
  await q(`DROP TABLE IF EXISTS active_setups_weeklyvwap_window_backup_20260714`);
  await q(`
    CREATE TABLE active_setups_weeklyvwap_window_backup_20260714 AS
    SELECT * FROM active_setups WHERE setup_type = ANY($1) AND resolution_method = 'BACKFILL'
  `, [targetTypes]);
  const cnt = await q(`SELECT COUNT(*) FROM active_setups_weeklyvwap_window_backup_20260714`);
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

  const lpR = await q(`SELECT price::float FROM level_prices WHERE trade_date=$1 AND level_name='WEEKLY_VWAP'`, [date]);
  if (!lpR.rows.length || lpR.rows[0].price == null) continue;
  const levels = { WEEKLY_VWAP: lpR.rows[0].price };

  const fires = detectFirstTouch(bars, levels);
  for (const fire of fires) {
    const params = LEVEL_PARAMS[fire.levelName];
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
    const t1Label = `T1: ${t1Dist}pt (p50 MFE) | Stop: ${stopDist}pt (p75 MAE) [live-matching, LA-safe]`;

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
for (const [type, s] of Object.entries(statsByType)) {
  const resolved = s.wins + s.losses;
  const wr = resolved > 0 ? (s.wins / resolved * 100).toFixed(1) : 'n/a';
  const ev = resolved > 0 ? (s.pnl / resolved).toFixed(2) : 'n/a';
  console.log(`  ${type.padEnd(24)} total=${s.total} resolved=${resolved} WR=${wr}% EV=$${ev}/trade pnl=$${Math.round(s.pnl)}`);
}
await pool.end();
