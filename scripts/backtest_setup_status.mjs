/**
 * Auto-shadow / auto-promote setup types based on accumulated performance.
 *
 * SUPPRESS: all-time N≥50, WR<48%, EV<-$5 → setup fires as SHADOW going forward
 * PROMOTE:  currently suppressed AND recent 90-day N≥15, WR≥52%, EV>$0 → restore to ACTIVE
 *
 * Shadow setups still resolve (TARGET_HIT/STOP_HIT) so data keeps accumulating.
 * When a suppressed setup recovers statistically it automatically comes back live.
 *
 * Writes signal_type='SETUP_STATUS' rows to performance_audit.
 * acd.js reads _suppressedSetups at startup — new setups of suppressed types
 * insert as status='SHADOW' with suppression_reason='PERFORMANCE_BELOW_THRESHOLD'.
 *
 * Run:  node scripts/backtest_setup_status.mjs
 * Cron: Sunday 9:20 PM ET (run_weekly_backtests.sh)
 */

import { query } from '../server/db.js';
import pool from '../server/db.js';

const SIGNAL_TYPE = 'SETUP_STATUS';

// Thresholds — conservative to avoid suppressing setups on thin data
const SUPPRESS_MIN_N   = 50;   // need at least 50 resolved trades all-time
const SUPPRESS_MAX_WR  = 0.48; // WR below 48%
const SUPPRESS_MAX_EV  = -5;   // EV below -$5/trade

const PROMOTE_WINDOW_DAYS = 90;
const PROMOTE_MIN_N    = 15;   // 15 trades in last 90 days is enough to signal recovery
const PROMOTE_MIN_WR   = 0.52;
const PROMOTE_MIN_EV   = 0;    // any positive EV

async function run() {
  console.log('[backtest_setup_status] Starting...');
  const today = new Date().toISOString().slice(0, 10);

  // All-time stats per setup_type (includes SHADOW rows — they still resolve)
  const allTimeQ = await query(`
    SELECT
      setup_type,
      COUNT(*) AS n,
      AVG((resolution='TARGET_HIT')::int)::float AS wr,
      AVG(actual_pnl)::float AS ev,
      SUM(actual_pnl)::float AS total_pnl
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT','STOP_HIT')
      AND actual_pnl IS NOT NULL
    GROUP BY setup_type
    ORDER BY setup_type
  `);

  // Recent 90-day stats (to detect recovery)
  const recentQ = await query(`
    SELECT
      setup_type,
      COUNT(*) AS n,
      AVG((resolution='TARGET_HIT')::int)::float AS wr,
      AVG(actual_pnl)::float AS ev
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT','STOP_HIT')
      AND actual_pnl IS NOT NULL
      AND trade_date >= CURRENT_DATE - 90
    GROUP BY setup_type
  `);
  const recent = {};
  for (const r of recentQ.rows) recent[r.setup_type] = r;

  // Current SETUP_STATUS rows — what's already suppressed
  const currentStatusQ = await query(`
    SELECT DISTINCT ON (signal_name) signal_name, recommendation
    FROM performance_audit
    WHERE signal_type = $1
    ORDER BY signal_name, run_date DESC
  `, [SIGNAL_TYPE]);
  const currentStatus = {};
  for (const r of currentStatusQ.rows) currentStatus[r.signal_name] = r.recommendation;

  const results = [];
  let suppressed = 0, promoted = 0, unchanged = 0;

  for (const r of allTimeQ.rows) {
    const type   = r.setup_type;
    const n      = +r.n;
    const wr     = +r.wr;
    const ev     = +r.ev;
    const rec90  = recent[type];
    const wasSuppressed = currentStatus[type] === 'SUPPRESS';

    let recommendation = 'ACTIVE';

    if (wasSuppressed && rec90 && +rec90.n >= PROMOTE_MIN_N && +rec90.wr >= PROMOTE_MIN_WR && +rec90.ev > PROMOTE_MIN_EV) {
      // Recovery detected — promote back to live
      recommendation = 'PROMOTE';
      promoted++;
      console.log(`  PROMOTE  ${type.padEnd(38)} all: N=${n} WR=${(wr*100).toFixed(1)}% EV=$${ev.toFixed(0)}  recent90: N=${rec90.n} WR=${(+rec90.wr*100).toFixed(1)}% EV=$${(+rec90.ev).toFixed(0)}`);
    } else if (n >= SUPPRESS_MIN_N && wr < SUPPRESS_MAX_WR && ev < SUPPRESS_MAX_EV) {
      recommendation = 'SUPPRESS';
      suppressed++;
      const tag = wasSuppressed ? '(already suppressed)' : '← NEW';
      console.log(`  SUPPRESS ${type.padEnd(38)} N=${n} WR=${(wr*100).toFixed(1)}% EV=$${ev.toFixed(0)} total=$${r.total_pnl.toFixed(0)} ${tag}`);
    } else {
      unchanged++;
    }

    results.push({ type, n, wr, ev, totalPnl: +r.total_pnl, recommendation, rec90 });
  }

  console.log(`\n  ${suppressed} suppressed, ${promoted} promoted, ${unchanged} active/unchanged`);

  // Write to performance_audit
  let written = 0;
  for (const r of results) {
    if (r.recommendation === 'ACTIVE' && !currentStatus[r.type]) continue; // no change, skip write
    const notes = JSON.stringify({
      all_time_n:  r.n,
      all_time_wr: +(r.wr * 100).toFixed(1),
      all_time_ev: +r.ev.toFixed(2),
      total_pnl:   +r.totalPnl.toFixed(2),
      recent_90d:  r.rec90 ? { n: +r.rec90.n, wr: +(+r.rec90.wr * 100).toFixed(1), ev: +(+r.rec90.ev).toFixed(2) } : null,
    });
    await query(`
      INSERT INTO performance_audit
        (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl, recommendation, notes)
      VALUES ($1, 0, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
        sample_size    = EXCLUDED.sample_size,
        win_rate       = EXCLUDED.win_rate,
        ev_per_trade   = EXCLUDED.ev_per_trade,
        total_pnl      = EXCLUDED.total_pnl,
        recommendation = EXCLUDED.recommendation,
        notes          = EXCLUDED.notes
    `, [today, SIGNAL_TYPE, r.type, r.n, r.wr, r.ev, r.totalPnl, r.recommendation, notes]);
    written++;
  }

  // Apply directly to active_setups: flip unresolved rows
  // SUPPRESS: flip ACTIVE unresolved → SHADOW
  const suppressList = results.filter(r => r.recommendation === 'SUPPRESS').map(r => r.type);
  if (suppressList.length) {
    const res = await query(`
      UPDATE active_setups
      SET status = 'SHADOW', suppression_reason = 'PERFORMANCE_BELOW_THRESHOLD'
      WHERE setup_type = ANY($1)
        AND status = 'ACTIVE'
        AND resolution IS NULL
    `, [suppressList]);
    if (res.rowCount) console.log(`  Applied SHADOW to ${res.rowCount} open ACTIVE rows`);
  }

  // PROMOTE: flip SHADOW (performance-reason only) unresolved → ACTIVE
  const promoteList = results.filter(r => r.recommendation === 'PROMOTE').map(r => r.type);
  if (promoteList.length) {
    const res = await query(`
      UPDATE active_setups
      SET status = 'ACTIVE', suppression_reason = NULL
      WHERE setup_type = ANY($1)
        AND status = 'SHADOW'
        AND suppression_reason = 'PERFORMANCE_BELOW_THRESHOLD'
        AND resolution IS NULL
    `, [promoteList]);
    if (res.rowCount) console.log(`  Promoted ${res.rowCount} open SHADOW rows back to ACTIVE`);
  }

  console.log(`\n[backtest_setup_status] ${written} rows written → performance_audit SETUP_STATUS`);
  await pool.end();
}

run().catch(e => { console.error('[backtest_setup_status] ERROR:', e.message); process.exit(1); });
