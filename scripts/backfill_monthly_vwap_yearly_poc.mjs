// backfill_monthly_vwap_yearly_poc.mjs
//
// Historical touch-detection backfill for two brand-new level families added
// 2026-07-19 (scripts/compute_levels.js): MONTHLY_VWAP and PY_VAH/PY_VAL/PY_POC
// (prior complete calendar year value area). Neither has ever fired live or been
// touched historically before today, so there is zero active_setups history and
// zero SETUP_STATUS calibration for them -- this script bootstraps both.
//
// Modeled directly on scripts/repair_weekly_vwap_window_mismatch.mjs (the
// established, already-correct template for this exact kind of backfill):
// first touch anywhere in RTH (matching live acd.js's nearLevels, no window
// restriction -- the window-mismatch bug class documented in CLAUDE.md), exact
// $2/pt + $1 commission (MNQ, matching LIVE_INSTRUMENT), TIME_EXPIRED handling
// for touches that never resolve by session end.
//
// ONE deliberate difference from the template: these levels have no prior
// LEVEL_FADE_AUDIT calibration to seed a realistic stop/target from (they've
// literally never been measured before), so a per-level precomputed stopDist/
// t1Dist would just be a guess -- exactly the kind of static-threshold literal
// CLAUDE.md's hard rule prohibits. Instead this uses one wide, symmetric
// placeholder box (100pt/100pt -- wider than every other calibrated level's
// real stop in this dataset, which top out around 90-95pt) purely so the walk
// isn't artificially cut short before capturing a genuine mae_points/mfe_points
// read. scripts/update_optimal_stops.mjs (already scheduled) re-derives the
// REAL EV-optimal stop/target from that honest excursion data on its next run
// -- this script's placeholder box never needs to be the right number, only
// wide enough not to truncate the real one.
//
// Run: node scripts/backfill_monthly_vwap_yearly_poc.mjs [--dry-run]

import pg from 'pg';
const pool = new pg.Pool({ host: 'localhost', port: 5432, database: 'trading_journal', user: 'trader', password: 'trader123' });
const q = (t, p) => pool.query(t, p);

const DRY_RUN = process.argv.includes('--dry-run');
const PT = 2, COMM = 1; // MNQ: $2/pt, $1 round-trip commission -- matches acd.js's live PNL_PER_POINT/COMMISSION
const RTH_START = 570, RTH_END = 960, SESSION_END = 960;
// Widened 300 (from an initial 100) after directly checking the resulting mae_points/
// mfe_points distributions post-backfill: 100pt visibly truncated both sides for these
// longer-period (month/year-scale) magnet levels -- p75/p90 clustered right at the ~100pt
// ceiling on both MAE and MFE, true max already reached 159pt even bounded by the box.
// 300pt gives ~2x headroom above that observed (still-truncated) max.
const PLACEHOLDER_DIST = 300; // wide bootstrap box -- see header comment, not a live threshold

const LEVEL_NAMES = ['MONTHLY_VWAP', 'PY_VAH', 'PY_VAL', 'PY_POC'];
const SETUP_SUFFIX = { MONTHLY_VWAP: 'MONTHLY_VWAP_FADE', PY_VAH: 'PY_VAH_FADE', PY_VAL: 'PY_VAL_FADE', PY_POC: 'PY_POC_FADE' };

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

function resolve(bars, fromIdx, entry, isLong, stop, t1) {
  let runMae = 0, runMfe = 0;
  for (let i = fromIdx + 1; i < bars.length; i++) {
    const b = bars[i];
    if (b.tod > SESSION_END) break;
    const favorable = isLong ? b.high - entry : entry - b.low;
    const adverse = isLong ? entry - b.low : b.high - entry;
    runMfe = Math.max(runMfe, favorable);
    runMae = Math.max(runMae, adverse);
    const stopHit = isLong ? b.low <= stop : b.high >= stop;
    const targetHit = isLong ? b.high >= t1 : b.low <= t1;
    if (stopHit && targetHit) {
      const towardT1 = isLong ? b.open > stop : b.open < stop;
      return { resolution: towardT1 ? 'TARGET_HIT' : 'STOP_HIT', resolvedAt: b.ts, runMae, runMfe };
    }
    if (targetHit) return { resolution: 'TARGET_HIT', resolvedAt: b.ts, runMae, runMfe };
    if (stopHit) return { resolution: 'STOP_HIT', resolvedAt: b.ts, runMae, runMfe };
  }
  return { resolution: 'TIME_EXPIRED', resolvedAt: null, runMae, runMfe };
}

console.log(`Backfill MONTHLY_VWAP + PY_VAH/PY_VAL/PY_POC touches${DRY_RUN ? ' [DRY RUN]' : ''}`);

const targetTypes = Object.values(SETUP_SUFFIX).flatMap(s => [`${s}_LONG`, `${s}_SHORT`]);

if (!DRY_RUN) {
  await q(`DROP TABLE IF EXISTS active_setups_monthlyvwap_yearlypoc_backup_20260719`);
  await q(`
    CREATE TABLE active_setups_monthlyvwap_yearlypoc_backup_20260719 AS
    SELECT * FROM active_setups WHERE setup_type = ANY($1) AND resolution_method = 'BACKFILL'
  `, [targetTypes]);
  const cnt = await q(`SELECT COUNT(*) FROM active_setups_monthlyvwap_yearlypoc_backup_20260719`);
  console.log(`Backed up ${cnt.rows[0].count} rows (expect 0 -- these levels never existed before today)`);
  const del = await q(`DELETE FROM active_setups WHERE setup_type = ANY($1) AND resolution_method = 'BACKFILL'`, [targetTypes]);
  console.log(`Deleted ${del.rowCount} rows`);
}

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

  const lpR = await q(`SELECT level_name, price::float FROM level_prices WHERE trade_date=$1 AND level_name = ANY($2)`, [date, LEVEL_NAMES]);
  if (!lpR.rows.length) continue;
  const levels = {};
  for (const r of lpR.rows) if (r.price != null) levels[r.level_name] = r.price;
  if (!Object.keys(levels).length) continue;

  const fires = detectFirstTouch(bars, levels);
  for (const fire of fires) {
    const isLong = fire.dir === 'LONG';
    const entry = Math.round(fire.entryPx * 4) / 4;
    const stop = isLong ? entry - PLACEHOLDER_DIST : entry + PLACEHOLDER_DIST;
    const t1 = isLong ? entry + PLACEHOLDER_DIST : entry - PLACEHOLDER_DIST;

    const setupType = `${SETUP_SUFFIX[fire.levelName]}_${fire.dir}`;
    const { resolution, resolvedAt, runMae, runMfe } = resolve(bars, fire.barIdx, entry, isLong, stop, t1);
    let pnl = null;
    if (resolution === 'TARGET_HIT') pnl = Math.round((PLACEHOLDER_DIST * PT - COMM) * 100) / 100;
    if (resolution === 'STOP_HIT') pnl = Math.round((-PLACEHOLDER_DIST * PT - COMM) * 100) / 100;
    if (resolution === 'TIME_EXPIRED') pnl = 0;
    const status = resolution === 'TIME_EXPIRED' ? 'EXPIRED' : 'RESOLVED';
    const expiresAt = `${date} 16:00:00`;
    const t1Label = `T1: ${PLACEHOLDER_DIST}pt (bootstrap placeholder, not yet calibrated)`;

    if (!statsByType[setupType]) statsByType[setupType] = { total: 0, wins: 0, losses: 0, expired: 0, pnl: 0 };
    statsByType[setupType].total++;
    if (resolution === 'TARGET_HIT') statsByType[setupType].wins++;
    if (resolution === 'STOP_HIT') statsByType[setupType].losses++;
    if (resolution === 'TIME_EXPIRED') statsByType[setupType].expired++;
    statsByType[setupType].pnl += pnl || 0;

    if (!DRY_RUN) {
      await q(`
        INSERT INTO active_setups (
          trade_date, setup_type, fired_at, expires_at, resolved_at, status, resolution,
          entry_zone_low, stop_level, t1_level, t1_label,
          structural_level_touched, structural_level_type, price_at_detection,
          confluence_score_at_detection, actual_pnl, resolution_method, origin_status,
          mae_points, mfe_points, replay_resolution
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
        ON CONFLICT DO NOTHING
      `, [
        date, setupType, fire.barTs, expiresAt, resolvedAt, status, resolution,
        entry, stop, t1, t1Label, fire.levelPx, fire.levelName, entry,
        fire.confluenceCount, pnl, 'BACKFILL', 'BACKFILL',
        Math.round(runMae * 100) / 100, Math.round(runMfe * 100) / 100, resolution,
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
  console.log(`  ${type.padEnd(24)} total=${s.total} resolved=${resolved} expired=${s.expired} WR=${wr}% EV=$${ev}/trade (placeholder box) pnl=$${Math.round(s.pnl)}`);
}
await pool.end();
