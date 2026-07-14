// repair_top8_window_mismatch.mjs
//
// Second wave of the window-mismatch fix (docs/OPEN_THREADS.md 2026-07-14), extending
// scripts/repair_cam_r4_s3_window_mismatch.mjs's methodology to the next set of level
// families verified safe to re-test. Same root cause: scripts/archive/backfill_level_fades.js
// only scans a 10:30am-noon window, but live acd.js (`nearLevels`) fires on the first RTH
// touch, any time from ~9:34 AM.
//
// Scope: 8 base level names, all confirmed PRIOR-PERIOD-DERIVED (verified against
// scripts/compute_levels.js -- safe to re-test from the 9:30 ET session open, no lookahead):
//   PD_OR_MID   (prior day's OR mid, compute_levels.js ~line 261, category 'PRIOR')
//   PD_IB_HIGH  (prior day's IB high, category 'PRIOR_DAY')
//   PD_POC      (prior day POC, category 'PRIOR_DAY')
//   FLOOR_S1    (floor pivot from prior day H/L/C, category 'PIVOT')
//   CAM_R1, CAM_S2, CAM_S4 (Camarilla from prior day H/L/C, category 'CAMARILLA' --
//     same family as CAM_R4/CAM_S3 already fixed)
//   OR_LOW      -- NOT prior-period-derived (forms today, bars 570-574, valid from tod=575 /
//     9:35 ET per acdService.js ~line 359) -- included here with its own correct gate=575,
//     NOT blanket 570 like the others.
//
// Explicitly OUT of scope for this pass: IB_HIGH/IB_LOW/IB_MID_SCALP/OR_MID_AFTER_IB --
// found during verification that acd.js's live IB (bars 570-629, 60min, gated etMinNow>=630,
// acd.js ~line 4404-4419) uses a DIFFERENT IB definition than compute_levels.js's level_prices
// IB_HIGH/IB_LOW (bars 570-599, 30min). This is a deeper, separate bug (which IB definition is
// "correct" needs its own decision) -- see docs/OPEN_THREADS.md, not fixed here to avoid
// conflating two different bugs in one pass.
//
// Verified via scratch/top12_window_check.mjs (2026-07-14) before running this: all 8 level
// families show negative EV deltas under live-matching semantics vs the current (duplicate-
// bar-repaired but still window-restricted) numbers; several flip to outright negative EV.
//
// Run: node scripts/repair_top8_window_mismatch.mjs [--dry-run]

import pg from 'pg';
const pool = new pg.Pool({ host: 'localhost', port: 5432, database: 'trading_journal', user: 'trader', password: 'trader123' });
const q = (t, p) => pool.query(t, p);

const DRY_RUN = process.argv.includes('--dry-run');
const PT = 5, COMM = 5;
const RTH_END = 960, SESSION_END = 960;

const LEVEL_PARAMS = {
  PD_OR_MID:  { stopDist: 77.88, t1Dist: 45.00, setupSuffix: 'PD_OR_MID_FADE',  gate: 570 },
  PD_IB_HIGH: { stopDist: 81.10, t1Dist: 40.10, setupSuffix: 'PD_IB_HIGH_FADE', gate: 570 },
  PD_POC:     { stopDist: 72.88, t1Dist: 43.50, setupSuffix: 'PD_POC_FADE',    gate: 570 },
  FLOOR_S1:   { stopDist: 75.00, t1Dist: 44.50, setupSuffix: 'FLOOR_S1_FADE',  gate: 570 },
  CAM_R1:     { stopDist: 65.88, t1Dist: 37.13, setupSuffix: 'CAM_R1_FADE',    gate: 570 },
  CAM_S2:     { stopDist: 71.50, t1Dist: 41.75, setupSuffix: 'CAM_S2_FADE',    gate: 570 },
  CAM_S4:     { stopDist: 87.25, t1Dist: 40.63, setupSuffix: 'CAM_S4_FADE',    gate: 570 },
  OR_LOW:     { stopDist: 69.63, t1Dist: 36.00, setupSuffix: 'OR_LOW_FADE',    gate: 575 },
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

console.log(`Repair top-8 window mismatch${DRY_RUN ? ' [DRY RUN]' : ''}`);

const targetTypes = Object.values(LEVEL_PARAMS).flatMap(p => [`${p.setupSuffix}_LONG`, `${p.setupSuffix}_SHORT`]);

if (!DRY_RUN) {
  await q(`DROP TABLE IF EXISTS active_setups_top8_window_backup_20260714`);
  await q(`
    CREATE TABLE active_setups_top8_window_backup_20260714 AS
    SELECT * FROM active_setups WHERE setup_type = ANY($1) AND resolution_method = 'BACKFILL'
  `, [targetTypes]);
  const cnt = await q(`SELECT COUNT(*) FROM active_setups_top8_window_backup_20260714`);
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

  const lpR = await q(`SELECT level_name, price::float FROM level_prices WHERE trade_date=$1 AND level_name = ANY($2)`, [date, Object.keys(LEVEL_PARAMS).filter(k => k !== 'OR_LOW')]);
  const levels = {};
  for (const row of lpR.rows) levels[row.level_name] = row.price;
  // OR_LOW is today-forming, not in level_prices for "today" in the same way -- pull from acd_daily_log
  if (LEVEL_PARAMS.OR_LOW) {
    const acdR = await q(`SELECT or_low::float FROM acd_daily_log WHERE trade_date=$1`, [date]);
    if (acdR.rows.length && acdR.rows[0].or_low != null) levels.OR_LOW = acdR.rows[0].or_low;
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
    const t1Label = `T1: ${t1Dist}pt (p50 MFE) | Stop: ${stopDist}pt (p75 MAE) [first-touch-anytime, live-matching]`;

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
