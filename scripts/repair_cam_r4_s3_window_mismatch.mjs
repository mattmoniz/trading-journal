// repair_cam_r4_s3_window_mismatch.mjs
//
// One-time data repair (2026-07-14), second pass on top of repair_backfill_duplicate_bars.mjs.
//
// scripts/archive/backfill_level_fades.js (the source of every BACKFILL-tagged active_setups
// row) only scans for a level touch between 10:30am-noon ET (IB_CLOSE=630, AM_CUT=720) — see
// its own header comment. But the LIVE level-fade engine (server/routes/acd.js ~line 4757,
// `nearLevels = keepLevels.filter(lv => Math.abs(currentPrice - lv.level) <= 15)`) has no such
// window restriction — it checks on every 60s poll all session, gated only by
// `allRthBarsRow.rows.length >= 3` (~9:34 AM). So the historical WR/EV backing every
// BACKFILL-sourced setup type describes a narrower, more selective strategy than what
// actually fires live.
//
// Verified for CAM_R4_FADE_SHORT / CAM_S3_FADE_LONG (docs/OPEN_THREADS.md has the full
// writeup) by re-simulating "first touch anywhere in the 9:30-16:00 RTH session" (matching
// live firing behavior — safe to test from the open since Camarilla pivots are computed from
// the PRIOR session's H/L/C, no lookahead) against the clean price_bars_primary data:
//   CAM_R4_FADE_SHORT: window-restricted $51.72 EV (N=52) -> first-touch-anytime -$34.87 EV
//     (N=114) -- FLIPS from winner to loser under the methodology that actually matches live
//     firing behavior.
//   CAM_S3_FADE_LONG: window-restricted $48.82 EV (N=63) -> first-touch-anytime +$17.45 EV
//     (N=141) -- stays positive, roughly 1/3 the claimed edge.
//
// This script supersedes just these 2 setup_types' BACKFILL rows with the first-touch-anytime
// (live-matching) simulation. NOT applied to the other ~70 BACKFILL-sourced setup_types in this
// pass -- they share the same window-restriction risk but haven't been individually verified
// yet; see docs/OPEN_THREADS.md for the flagged follow-up. Scoping this narrowly (2 verified
// types, not a blind blanket change) rather than assuming the same direction/magnitude holds
// for the rest.
//
// Run: node scripts/repair_cam_r4_s3_window_mismatch.mjs [--dry-run]

import pg from 'pg';
const pool = new pg.Pool({ host: 'localhost', port: 5432, database: 'trading_journal', user: 'trader', password: 'trader123' });
const q = (t, p) => pool.query(t, p);

const DRY_RUN = process.argv.includes('--dry-run');
// $2/pt, $1 commission -- matches acd.js's live PNL_PER_POINT/COMMISSION (real MNQ contract
// value). Was PT=5/COMM=5 (copied from the archived script), corrected 2026-07-14 -- see
// scripts/repair_dollars_per_point.mjs and docs/KNOWN_ISSUES.md.
const PT = 2, COMM = 1;
const RTH_START = 570, RTH_END = 960, SESSION_END = 960; // 9:30-16:00 ET, matches live acd.js's all-session detection

const TARGETS = {
  CAM_R4: { stopDist: 85.44, t1Dist: 40.38, setupSuffix: 'CAM_R4_FADE', wantDir: 'SHORT' },
  CAM_S3: { stopDist: 92.44, t1Dist: 40.25, setupSuffix: 'CAM_S3_FADE', wantDir: 'LONG' },
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

console.log(`Repair CAM_R4/CAM_S3 window mismatch${DRY_RUN ? ' [DRY RUN]' : ''}`);

const targetTypes = Object.values(TARGETS).map(t => `${t.setupSuffix}_${t.wantDir}`);

if (!DRY_RUN) {
  await q(`DROP TABLE IF EXISTS active_setups_cam_window_backup_20260714`);
  await q(`
    CREATE TABLE active_setups_cam_window_backup_20260714 AS
    SELECT * FROM active_setups WHERE setup_type = ANY($1) AND resolution_method = 'BACKFILL'
  `, [targetTypes]);
  const cnt = await q(`SELECT COUNT(*) FROM active_setups_cam_window_backup_20260714`);
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

  const lpR = await q(`SELECT level_name, price::float FROM level_prices WHERE trade_date=$1 AND level_name IN ('CAM_R4','CAM_S3')`, [date]);
  if (!lpR.rows.length) continue;
  const levels = {};
  for (const row of lpR.rows) levels[row.level_name] = row.price;

  const fires = detectFirstTouch(bars, levels);
  for (const fire of fires) {
    const params = TARGETS[fire.levelName];
    if (!params || fire.dir !== params.wantDir) continue; // only the direction that matches the target setup_type
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
