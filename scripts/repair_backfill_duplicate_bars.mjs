// repair_backfill_duplicate_bars.mjs
//
// One-time data repair (2026-07-14): scripts/archive/backfill_level_fades.js populated
// ~3,764 active_setups rows (resolution_method='BACKFILL', 72 setup_types) by querying
// price_bars directly. price_bars has ~14.6% duplicate-minute rows with no deterministic
// tiebreak (root cause not found, documented in docs/KNOWN_ISSUES.md item 8) — fixed at the
// read layer on 2026-07-13 via price_bars_primary (GROUP BY date_trunc('minute', ts), first/
// last tick via array_agg ORDER BY ts), but that view fix only corrects future reads, not
// historical active_setups rows already written from the dirty table.
//
// Verified 2026-07-14 (docs/OPEN_THREADS.md has the full writeup): re-running the identical
// detection/resolution logic against price_bars_primary instead of price_bars, for every
// setup_type in scope, shows near-universal WR/EV overstatement in the current BACKFILL
// rows — often -20% to -700%+ EV delta, including most of the live top-8-by-EV setups
// (CAM_R4_FADE_SHORT $84.6->$51.7, CAM_S3_FADE_LONG $87.3->$48.8, FLOOR_S1_FADE_LONG
// $98.0->$65.2, etc.) A handful move the other way (thin-N noise, e.g. CAM_S4_FADE_SHORT
// N=22-23) — expected variance, not evidence against the fix.
//
// This script: (1) backs up every BACKFILL row to active_setups_backfill_backup_20260714,
// (2) deletes them, (3) re-detects/re-resolves against price_bars_primary using the EXACT
// same detection logic and the EXACT same frozen stop/target params as the archived script
// (LEVEL_PARAMS below, unchanged) — deliberately not re-deriving new stop/targets in the same
// pass, so this fix isolates the bar-cleanliness bug alone; the existing weekly pipeline
// (update_optimal_stops.mjs / backtest_setup_status.mjs) picks up the corrected active_setups
// data on its next run and recalibrates stop/target from there, same as the 2026-07-13
// price_bars_primary fix did for the other 22 consumers.
//
// Run: node scripts/repair_backfill_duplicate_bars.mjs [--dry-run]

import pg from 'pg';
const pool = new pg.Pool({ host: 'localhost', port: 5432, database: 'trading_journal', user: 'trader', password: 'trader123' });
const q = (t, p) => pool.query(t, p);

const DRY_RUN = process.argv.includes('--dry-run');

// $2/pt, $1 commission -- matches acd.js's live PNL_PER_POINT/COMMISSION (real MNQ contract
// value). Was PT=5/COMM=5 (copied from the archived script), corrected 2026-07-14 -- see
// scripts/repair_dollars_per_point.mjs and docs/KNOWN_ISSUES.md.
const PT = 2, COMM = 1;
const IB_CLOSE = 630, AM_CUT = 720, SESSION_END = 780;

// Copied verbatim from scripts/archive/backfill_level_fades.js — unchanged, see header note above.
const LEVEL_PARAMS = {
  OR_HIGH:        { stopDist: 76.25, t1Dist: 41.00, setupSuffix: 'OR_HIGH_FADE' },
  OR_LOW:         { stopDist: 69.63, t1Dist: 36.00, setupSuffix: 'OR_LOW_FADE' },
  IB_HIGH:        { stopDist: 52.44, t1Dist: 30.38, setupSuffix: 'IB_HIGH_FADE' },
  IB_LOW:         { stopDist: 67.63, t1Dist: 34.00, setupSuffix: 'IB_LOW_FADE' },
  IB_MID:         { stopDist: 56.25, t1Dist: 29.00, setupSuffix: 'IB_MID_SCALP_FADE' },
  PD_VAH:         { stopDist: 66.75, t1Dist: 39.00, setupSuffix: 'PD_VAH_FADE' },
  PD_VAL:         { stopDist: 83.25, t1Dist: 46.25, setupSuffix: 'PD_VAL_FADE' },
  PD_POC:         { stopDist: 72.88, t1Dist: 43.50, setupSuffix: 'PD_POC_FADE' },
  FLOOR_PIVOT:    { stopDist: 77.94, t1Dist: 50.25, setupSuffix: 'FLOOR_PIVOT_FADE' },
  FLOOR_R1:       { stopDist: 68.25, t1Dist: 33.38, setupSuffix: 'FLOOR_R1_FADE' },
  FLOOR_S1:       { stopDist: 75.00, t1Dist: 44.50, setupSuffix: 'FLOOR_S1_FADE' },
  OR_MID:         { stopDist: 62.00, t1Dist: 30.25, setupSuffix: 'OR_MID_AFTER_IB_FADE' },
  PD_IB_MID:      { stopDist: 56.25, t1Dist: 29.00, setupSuffix: 'PD_IB_MID_FADE' },
  PD_OR_MID:      { stopDist: 77.88, t1Dist: 45.00, setupSuffix: 'PD_OR_MID_FADE' },
  PD_IB_HIGH:     { stopDist: 81.10, t1Dist: 40.10, setupSuffix: 'PD_IB_HIGH_FADE' },
  PD_IB_LOW:      { stopDist: 67.30, t1Dist: 41.30, setupSuffix: 'PD_IB_LOW_FADE' },
  WEEKLY_VWAP:    { stopDist: 67.30, t1Dist: 41.00, setupSuffix: 'WEEKLY_VWAP_FADE' },
  '5D_OR_MID':    { stopDist: 62.00, t1Dist: 30.25, setupSuffix: '5D_OR_MID_FADE' },
  PD_SESSION_MID: { stopDist: 82.25, t1Dist: 48.50, setupSuffix: 'PD_SESSION_MID_FADE' },
  WS1: { stopDist: 62.81, t1Dist: 41.88, setupSuffix: 'WS1_FADE' },
  WS2: { stopDist: 76.50, t1Dist: 44.25, setupSuffix: 'WS2_FADE' },
  WR1: { stopDist: 61.63, t1Dist: 38.50, setupSuffix: 'WR1_FADE' },
  WR2: { stopDist: 80.50, t1Dist: 41.00, setupSuffix: 'WR2_FADE' },
  WPP: { stopDist: 78.63, t1Dist: 33.25, setupSuffix: 'WPP_FADE' },
  MPP: { stopDist: 74.25, t1Dist: 41.00, setupSuffix: 'MPP_FADE' },
  MR1: { stopDist: 56.13, t1Dist: 40.63, setupSuffix: 'MR1_FADE' },
  MR2: { stopDist: 63.50, t1Dist: 17.00, setupSuffix: 'MR2_FADE' },
  MS1: { stopDist: 87.31, t1Dist: 41.00, setupSuffix: 'MS1_FADE' },
  MS2: { stopDist: 47.69, t1Dist: 47.13, setupSuffix: 'MS2_FADE' },
  CAM_R1: { stopDist: 65.88, t1Dist: 37.13, setupSuffix: 'CAM_R1_FADE' },
  CAM_R2: { stopDist: 69.50, t1Dist: 37.50, setupSuffix: 'CAM_R2_FADE' },
  CAM_R3: { stopDist: 78.13, t1Dist: 39.25, setupSuffix: 'CAM_R3_FADE' },
  CAM_R4: { stopDist: 85.44, t1Dist: 40.38, setupSuffix: 'CAM_R4_FADE' },
  CAM_S1: { stopDist: 76.44, t1Dist: 40.63, setupSuffix: 'CAM_S1_FADE' },
  CAM_S2: { stopDist: 71.50, t1Dist: 41.75, setupSuffix: 'CAM_S2_FADE' },
  CAM_S3: { stopDist: 92.44, t1Dist: 40.25, setupSuffix: 'CAM_S3_FADE' },
  CAM_S4: { stopDist: 87.25, t1Dist: 40.63, setupSuffix: 'CAM_S4_FADE' },
};

function detectLevelFades(bars, levels) {
  const fires = [];
  const fired = new Set();
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], prev = bars[i - 1];
    if (b.tod < IB_CLOSE) continue;
    if (b.tod >= AM_CUT) break;
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

console.log(`Repair BACKFILL rows via price_bars_primary${DRY_RUN ? ' [DRY RUN]' : ''}`);

// ── Step 1: backup ──────────────────────────────────────────────────────────
if (!DRY_RUN) {
  await q(`DROP TABLE IF EXISTS active_setups_backfill_backup_20260714`);
  await q(`
    CREATE TABLE active_setups_backfill_backup_20260714 AS
    SELECT * FROM active_setups WHERE resolution_method = 'BACKFILL'
  `);
  const cnt = await q(`SELECT COUNT(*) FROM active_setups_backfill_backup_20260714`);
  console.log(`Backed up ${cnt.rows[0].count} rows to active_setups_backfill_backup_20260714`);
}

// Load performance_audit win_rate/sessions used for historical_win_rate/historical_sessions display fields
const paRows = await q(`
  SELECT signal_name, win_rate::float, sample_size::int
  FROM performance_audit WHERE signal_type IN ('LEVEL_FADE_AUDIT', 'MIDPOINT_FADE_AUDIT')
`);
const perfParams = {};
for (const row of paRows.rows) perfParams[row.signal_name] = { winRate: row.win_rate, sessions: row.sample_size };

// ── Step 2: delete existing BACKFILL rows ───────────────────────────────────
if (!DRY_RUN) {
  const del = await q(`DELETE FROM active_setups WHERE resolution_method = 'BACKFILL'`);
  console.log(`Deleted ${del.rowCount} BACKFILL rows`);
}

// ── Step 3: re-detect + re-resolve against price_bars_primary ──────────────
const datesR = await q(`SELECT DISTINCT trade_date::text as d FROM level_prices WHERE trade_date < CURRENT_DATE ORDER BY d`);
const dates = datesR.rows.map(r => r.d);
console.log(`Processing ${dates.length} trading dates (${dates[0]} -> ${dates[dates.length - 1]})`);

let inserted = 0, noFire = 0;
const statsByType = {};

for (const date of dates) {
  const barsR = await q(`
    SELECT ts::text as ts, open::float, high::float, low::float, close::float,
           EXTRACT(hour FROM ts)::int * 60 + EXTRACT(minute FROM ts)::int as tod
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts::date = $1
      AND EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 795
    ORDER BY tod
  `, [date]);
  const bars = barsR.rows;
  if (bars.length < 30) { noFire++; continue; }

  const lpR = await q(`SELECT level_name, price::float FROM level_prices WHERE trade_date = $1`, [date]);
  if (!lpR.rows.length) { noFire++; continue; }
  const lp = {};
  for (const row of lpR.rows) lp[row.level_name] = row.price;
  const levels = {};
  for (const levelName of Object.keys(LEVEL_PARAMS)) if (lp[levelName] != null) levels[levelName] = lp[levelName];

  const fires = detectLevelFades(bars, levels);
  if (!fires.length) { noFire++; continue; }

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
    const firedAt = fire.barTs;
    const expiresAt = `${date} 13:00:00`;
    const t1Label = `T1: ${t1Dist}pt (p50 MFE) | Stop: ${stopDist}pt (p75 MAE)`;

    if (!statsByType[setupType]) statsByType[setupType] = { total: 0, wins: 0, losses: 0, pnl: 0 };
    statsByType[setupType].total++;
    if (resolution === 'TARGET_HIT') statsByType[setupType].wins++;
    if (resolution === 'STOP_HIT') statsByType[setupType].losses++;
    statsByType[setupType].pnl += pnl || 0;

    if (!DRY_RUN) {
      await q(`
        INSERT INTO active_setups (
          trade_date, setup_type, fired_at, expires_at, resolved_at,
          status, resolution,
          entry_zone_low, stop_level, t1_level, t1_label,
          structural_level_touched, structural_level_type,
          price_at_detection,
          historical_win_rate, historical_sessions, historical_source,
          confluence_score_at_detection,
          actual_pnl, resolution_method
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        ON CONFLICT DO NOTHING
      `, [
        date, setupType, firedAt, expiresAt, resolvedAt,
        status, resolution,
        entry, stop, t1, t1Label,
        fire.levelPx, fire.levelName,
        entry,
        pa.winRate ?? null, pa.sessions ?? null, 'LEVEL_FADE_AUDIT',
        fire.confluenceCount,
        pnl, 'BACKFILL',
      ]);
    }
    inserted++;
  }
  if (inserted % 200 === 0 && inserted > 0) process.stdout.write(`  ${inserted} inserted...\r`);
}

console.log(`\n${'-'.repeat(70)}`);
console.log(`Dates processed: ${dates.length} | No-fire: ${noFire}`);
console.log(`${DRY_RUN ? 'Would insert' : 'Inserted'}: ${inserted} level fade entries`);
console.log(`\nBy setup type:`);
for (const [type, s] of Object.entries(statsByType).sort((a, b) => b[1].total - a[1].total)) {
  const wr = s.wins + s.losses > 0 ? (s.wins / (s.wins + s.losses) * 100).toFixed(1) : 'n/a';
  console.log(`  ${type.padEnd(30)} n=${String(s.total).padEnd(4)} WR=${wr.padEnd(5)}% PnL=$${Math.round(s.pnl).toLocaleString()}`);
}

await pool.end();
