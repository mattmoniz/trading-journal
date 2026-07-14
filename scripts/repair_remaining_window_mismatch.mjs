// repair_remaining_window_mismatch.mjs
//
// Third and final wave of the window-mismatch fix (docs/OPEN_THREADS.md 2026-07-14) for this
// session, covering every remaining prior-period-derived level family from
// scripts/archive/backfill_level_fades.js's LEVEL_PARAMS not already handled by
// repair_cam_r4_s3_window_mismatch.mjs (wave 1) or repair_top8_window_mismatch.mjs (wave 2).
//
// Formation-timing classification cross-verified two ways before this run: (1) Claude read
// scripts/compute_levels.js directly line-by-line, (2) independently dispatched to Gemini
// (scratch/antigravity_response.md, 2026-07-14) which produced matching results including two
// non-obvious findings Claude had also found independently (IB forms at et_min 600 not 630;
// WEEKLY_VWAP has a genuine lookahead bug in its own formula). Both sources agree on every row
// used here.
//
// Explicitly OUT of scope (excluded deliberately, not overlooked):
//   - IB_HIGH, IB_LOW, IB_MID, OR_MID (OR_MID_AFTER_IB) -- all depend on the Initial Balance,
//     which has a definitional mismatch between compute_levels.js (30min, valid at et_min 600)
//     and live acd.js (60min, gated at etMinNow>=630, server/routes/acd.js ~line 4404-4419).
//     Needs its own dedicated fix deciding which IB definition is correct -- not folded in here.
//   - WEEKLY_VWAP -- compute_levels.js ~line 304-311 computes it via `ts::date BETWEEN
//     wb.mon AND wb.fri`, i.e. through the WEEK'S Friday close, not just through the query
//     date -- a real lookahead bug for any date before that week's Friday. Already suppressed
//     live from the wave-1 duplicate-bar fix; needs its own investigation before re-testing.
//
// Included (all confirmed prior-period-derived, safe from RTH open, except OR_HIGH):
//   OR_HIGH (forms 9:30-9:34, valid from et_min 575 -- same as OR_LOW, already fixed in wave 2)
//   PD_VAH, PD_VAL, FLOOR_PIVOT, FLOOR_R1, PD_IB_MID, PD_IB_LOW, PD_SESSION_MID,
//   WS1, WS2, WR1, WR2, WPP, MPP, MR1, MR2, MS1, MS2, CAM_R2, CAM_R3, CAM_S1, 5D_OR_MID
//   (5D_OR_MID uses MAX/MIN over the prior 5 sessions' OR, `trade_date < $1` -- confirmed
//   strictly backward-looking despite being labeled 'CURRENT' category in compute_levels.js;
//   category label describes the OR-family grouping, not data recency -- verified by reading
//   the actual WHERE clause, not trusting the label).
//
// Run: node scripts/repair_remaining_window_mismatch.mjs [--dry-run]

import pg from 'pg';
const pool = new pg.Pool({ host: 'localhost', port: 5432, database: 'trading_journal', user: 'trader', password: 'trader123' });
const q = (t, p) => pool.query(t, p);

const DRY_RUN = process.argv.includes('--dry-run');
// $2/pt, $1 commission -- matches acd.js's live PNL_PER_POINT/COMMISSION (real MNQ contract
// value). Was PT=5/COMM=5 (copied from the archived script), corrected 2026-07-14 -- see
// scripts/repair_dollars_per_point.mjs and docs/KNOWN_ISSUES.md.
const PT = 2, COMM = 1;
const RTH_END = 960, SESSION_END = 960;

const LEVEL_PARAMS = {
  OR_HIGH:        { stopDist: 76.25, t1Dist: 41.00, setupSuffix: 'OR_HIGH_FADE',        gate: 575 },
  PD_VAH:         { stopDist: 66.75, t1Dist: 39.00, setupSuffix: 'PD_VAH_FADE',         gate: 570 },
  PD_VAL:         { stopDist: 83.25, t1Dist: 46.25, setupSuffix: 'PD_VAL_FADE',         gate: 570 },
  FLOOR_PIVOT:    { stopDist: 77.94, t1Dist: 50.25, setupSuffix: 'FLOOR_PIVOT_FADE',    gate: 570 },
  FLOOR_R1:       { stopDist: 68.25, t1Dist: 33.38, setupSuffix: 'FLOOR_R1_FADE',       gate: 570 },
  PD_IB_MID:      { stopDist: 56.25, t1Dist: 29.00, setupSuffix: 'PD_IB_MID_FADE',      gate: 570 },
  PD_IB_LOW:      { stopDist: 67.30, t1Dist: 41.30, setupSuffix: 'PD_IB_LOW_FADE',      gate: 570 },
  PD_SESSION_MID: { stopDist: 82.25, t1Dist: 48.50, setupSuffix: 'PD_SESSION_MID_FADE', gate: 570 },
  '5D_OR_MID':    { stopDist: 62.00, t1Dist: 30.25, setupSuffix: '5D_OR_MID_FADE',      gate: 570 },
  WS1: { stopDist: 62.81, t1Dist: 41.88, setupSuffix: 'WS1_FADE', gate: 570 },
  WS2: { stopDist: 76.50, t1Dist: 44.25, setupSuffix: 'WS2_FADE', gate: 570 },
  WR1: { stopDist: 61.63, t1Dist: 38.50, setupSuffix: 'WR1_FADE', gate: 570 },
  WR2: { stopDist: 80.50, t1Dist: 41.00, setupSuffix: 'WR2_FADE', gate: 570 },
  WPP: { stopDist: 78.63, t1Dist: 33.25, setupSuffix: 'WPP_FADE', gate: 570 },
  MPP: { stopDist: 74.25, t1Dist: 41.00, setupSuffix: 'MPP_FADE', gate: 570 },
  MR1: { stopDist: 56.13, t1Dist: 40.63, setupSuffix: 'MR1_FADE', gate: 570 },
  MR2: { stopDist: 63.50, t1Dist: 17.00, setupSuffix: 'MR2_FADE', gate: 570 },
  MS1: { stopDist: 87.31, t1Dist: 41.00, setupSuffix: 'MS1_FADE', gate: 570 },
  MS2: { stopDist: 47.69, t1Dist: 47.13, setupSuffix: 'MS2_FADE', gate: 570 },
  CAM_R2: { stopDist: 69.50, t1Dist: 37.50, setupSuffix: 'CAM_R2_FADE', gate: 570 },
  CAM_R3: { stopDist: 78.13, t1Dist: 39.25, setupSuffix: 'CAM_R3_FADE', gate: 570 },
  CAM_S1: { stopDist: 76.44, t1Dist: 40.63, setupSuffix: 'CAM_S1_FADE', gate: 570 },
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

console.log(`Repair remaining window mismatch${DRY_RUN ? ' [DRY RUN]' : ''}`);

const targetTypes = Object.values(LEVEL_PARAMS).flatMap(p => [`${p.setupSuffix}_LONG`, `${p.setupSuffix}_SHORT`]);

if (!DRY_RUN) {
  await q(`DROP TABLE IF EXISTS active_setups_remaining_window_backup_20260714`);
  await q(`
    CREATE TABLE active_setups_remaining_window_backup_20260714 AS
    SELECT * FROM active_setups WHERE setup_type = ANY($1) AND resolution_method = 'BACKFILL'
  `, [targetTypes]);
  const cnt = await q(`SELECT COUNT(*) FROM active_setups_remaining_window_backup_20260714`);
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

  const lpR = await q(`SELECT level_name, price::float FROM level_prices WHERE trade_date=$1 AND level_name = ANY($2)`, [date, Object.keys(LEVEL_PARAMS)]);
  const levels = {};
  for (const row of lpR.rows) levels[row.level_name] = row.price;
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
for (const [type, s] of Object.entries(statsByType).sort((a,b)=>b[1].total-a[1].total)) {
  const resolved = s.wins + s.losses;
  const wr = resolved > 0 ? (s.wins / resolved * 100).toFixed(1) : 'n/a';
  const ev = resolved > 0 ? (s.pnl / resolved).toFixed(2) : 'n/a';
  console.log(`  ${type.padEnd(26)} total=${s.total} resolved=${resolved} WR=${wr}% EV=$${ev}/trade pnl=$${Math.round(s.pnl)}`);
}
await pool.end();
