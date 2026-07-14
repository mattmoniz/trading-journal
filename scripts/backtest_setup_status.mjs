/**
 * Auto-shadow / auto-promote setup types based on accumulated performance.
 * UNIFIED suppression system — the ONLY suppression source. acd.js hardcoded
 * suppressedFades set was removed 2026-07-09; all suppression flows through here.
 *
 * SUPPRESS: N≥20, EV<-$5/trade (no WR gate — catches high-WR structural losers)
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

// Thresholds — EV-only gate catches high-WR structural losers that a WR threshold misses
const SUPPRESS_MIN_N   = 20;   // N≥20 satisfies the hard floor from CLAUDE.md
const SUPPRESS_MAX_EV  = -5;   // EV below -$5/trade (sole condition — no WR gate)

const PROMOTE_WINDOW_DAYS = 90;
const PROMOTE_MIN_N    = 15;   // 15 trades in last 90 days is enough to signal recovery
const PROMOTE_MIN_WR   = 0.52;
const PROMOTE_MIN_EV   = 0;    // any positive EV

// Setup types that are day-type conditional — their overall EV blends good and bad day types
// and therefore can't be evaluated as a single suppress/promote decision. These are managed
// by DAY_TYPE_ALPHA in acd.js, which applies per-(setup_type × day_type) sizing adjustments.
const DAY_TYPE_CONDITIONAL = new Set([
  'IB_BULLISH',  // TREND=76%+WR, BALANCE=51% → overall EV dragged by BALANCE (which self-gates)
  'IB_BEARISH',  // same pattern — TURBULENT elite, BALANCE marginal
]);

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

  // Rigor diagnostics added 2026-07-14 (same checks applied to the minute-bar scanner):
  // day-clustering (catches N inflated by a handful of sessions — this is exactly the bug
  // found in the CAM_R4/CAM_S3 investigation) and 3-way chronological EV-sign stability.
  // Informational only — does NOT feed into SUPPRESS/PROMOTE logic below, so this doesn't
  // silently change which setups are live. Surfaces as new fields in `notes` for review.
  const perTradeQ = await query(`
    SELECT setup_type, trade_date::text AS trade_date, actual_pnl::float AS pnl, fired_at
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT','STOP_HIT') AND actual_pnl IS NOT NULL
    ORDER BY setup_type, fired_at ASC
  `);
  const tradesByType = new Map();
  for (const r of perTradeQ.rows) {
    if (!tradesByType.has(r.setup_type)) tradesByType.set(r.setup_type, []);
    tradesByType.get(r.setup_type).push(r);
  }
  function rigorDiagnostics(type) {
    const trades = tradesByType.get(type) || [];
    if (!trades.length) return { distinctDates: 0, top5DayPct: null, stable: null, thirds: null };
    const perDay = new Map();
    for (const t of trades) perDay.set(t.trade_date, (perDay.get(t.trade_date) || 0) + 1);
    const counts = [...perDay.values()].sort((a, b) => b - a);
    const top5DayPct = +(100 * counts.slice(0, 5).reduce((a, b) => a + b, 0) / trades.length).toFixed(1);
    const third = Math.floor(trades.length / 3);
    let stable = null, thirds = null;
    if (third >= 3) { // need at least a handful per third for the check to mean anything
      const g1 = trades.slice(0, third), g2 = trades.slice(third, 2 * third), g3 = trades.slice(2 * third);
      const evOf = g => g.reduce((s, t) => s + t.pnl, 0) / g.length;
      const ev1 = evOf(g1), ev2 = evOf(g2), ev3 = evOf(g3);
      const overallSign = Math.sign(trades.reduce((s, t) => s + t.pnl, 0));
      stable = [ev1, ev2, ev3].every(v => Math.sign(v) === overallSign);
      thirds = { n1: g1.length, n2: g2.length, n3: g3.length, ev1: +ev1.toFixed(2), ev2: +ev2.toFixed(2), ev3: +ev3.toFixed(2) };
    }
    return { distinctDates: perDay.size, top5DayPct, stable, thirds };
  }

  const results = [];
  let suppressed = 0, promoted = 0, unchanged = 0;

  for (const r of allTimeQ.rows) {
    const type   = r.setup_type;
    const n      = +r.n;
    const wr     = +r.wr;
    const ev     = +r.ev;
    const rec90  = recent[type];
    const wasSuppressed = currentStatus[type] === 'SUPPRESS';

    // Day-type conditional setups: skip global suppress/promote — managed by DAY_TYPE_ALPHA.
    // Still write a row so the session-start coverage check knows these types are assessed.
    if (DAY_TYPE_CONDITIONAL.has(type)) {
      const rec = wasSuppressed ? 'ACTIVE' : 'DAY_TYPE_MANAGED'; // clear stale SUPPRESS if any
      results.push({ type, n, wr, ev, totalPnl: +r.total_pnl, recommendation: rec, rec90 });
      unchanged++;
      continue;
    }

    let recommendation = 'ACTIVE';

    if (wasSuppressed && rec90 && +rec90.n >= PROMOTE_MIN_N && +rec90.wr >= PROMOTE_MIN_WR && +rec90.ev > PROMOTE_MIN_EV) {
      // Recovery detected — promote back to live
      recommendation = 'PROMOTE';
      promoted++;
      console.log(`  PROMOTE  ${type.padEnd(38)} all: N=${n} WR=${(wr*100).toFixed(1)}% EV=$${ev.toFixed(0)}  recent90: N=${rec90.n} WR=${(+rec90.wr*100).toFixed(1)}% EV=$${(+rec90.ev).toFixed(0)}`);
    } else if (n >= SUPPRESS_MIN_N && ev < SUPPRESS_MAX_EV) {
      recommendation = 'SUPPRESS';
      suppressed++;
      const tag = wasSuppressed ? '(already suppressed)' : '← NEW';
      console.log(`  SUPPRESS ${type.padEnd(38)} N=${n} WR=${(wr*100).toFixed(1)}% EV=$${ev.toFixed(0)} total=$${r.total_pnl.toFixed(0)} ${tag}`);
    } else if (n < SUPPRESS_MIN_N) {
      // CLAUDE.md hard rule: N<20 → SHADOW until enough data to evaluate.
      // acd.js reads THIN_N the same as SUPPRESS — inserts new setups as SHADOW.
      // Auto-clears when N reaches 20 and EV qualifies (next weekly run).
      recommendation = 'THIN_N';
      console.log(`  THIN_N   ${type.padEnd(38)} N=${n} EV=$${ev.toFixed(0)} — shadow until N≥20`);
    } else {
      unchanged++;
    }

    results.push({ type, n, wr, ev, totalPnl: +r.total_pnl, recommendation, rec90 });
  }

  console.log(`\n  ${suppressed} suppressed, ${promoted} promoted, ${unchanged} active/unchanged`);

  // Write to performance_audit — always write every evaluated type so the session-start
  // coverage check can verify all active setup_types have been assessed this week.
  let written = 0, flaggedClustered = 0, flaggedUnstable = 0;
  for (const r of results) {
    const rigor = rigorDiagnostics(r.type);
    if (rigor.top5DayPct != null && rigor.top5DayPct > 50) flaggedClustered++;
    if (rigor.stable === false) flaggedUnstable++;
    const notes = JSON.stringify({
      all_time_n:  r.n,
      all_time_wr: +(r.wr * 100).toFixed(1),
      all_time_ev: +r.ev.toFixed(2),
      total_pnl:   +r.totalPnl.toFixed(2),
      recent_90d:  r.rec90 ? { n: +r.rec90.n, wr: +(+r.rec90.wr * 100).toFixed(1), ev: +(+r.rec90.ev).toFixed(2) } : null,
      rigor: { distinct_dates: rigor.distinctDates, top5_day_pct: rigor.top5DayPct, three_way_stable: rigor.stable, thirds: rigor.thirds },
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
  console.log(`[rigor diagnostics] ${flaggedClustered} setup_types have >50% of N from their top-5 trade dates (day-clustering risk) | ${flaggedUnstable} setup_types fail the 3-way chronological sign-stability check (informational only, not auto-suppressed)`);

  // ── Per-DOW suppression (SETUP_STATUS_DOW) ────────────────────────────────
  // For each (DOW, setup_type) with N≥20 and EV<-$5 that isn't ALREADY globally suppressed,
  // write a SETUP_STATUS_DOW row. acd.js loads today's DOW rows into _dowSuppressToday.
  // DOW_TYPE_CONDITIONAL setups (IB_BULLISH/IB_BEARISH) are excluded — they use the
  // candidates path and aren't gated by _dowSuppressToday in the level-fade engine.
  console.log('\n[backtest_setup_status] Computing per-DOW suppression...');
  const DOW_SIGNAL_TYPE = 'SETUP_STATUS_DOW';
  const DOW_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  const globalSuppress = new Set(results.filter(r => r.recommendation === 'SUPPRESS').map(r => r.type));

  const dowQ = await query(`
    SELECT
      EXTRACT(DOW FROM trade_date)::int AS dow,
      setup_type,
      COUNT(*) AS n,
      AVG((resolution='TARGET_HIT')::int)::float AS wr,
      AVG(actual_pnl)::float AS ev,
      SUM(actual_pnl)::float AS total_pnl
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT','STOP_HIT')
      AND actual_pnl IS NOT NULL
    GROUP BY 1, 2
    HAVING COUNT(*) >= ${SUPPRESS_MIN_N}
    ORDER BY 1, 2
  `);

  let dowSuppressed = 0, dowWritten = 0;
  for (const r of dowQ.rows) {
    const dow = +r.dow;
    const type = r.setup_type;
    const n = +r.n, ev = +r.ev, wr = +r.wr;

    // Skip globally suppressed (already handled) and Sun/Sat.
    // DAY_TYPE_CONDITIONAL (IB_BULLISH/IB_BEARISH) are NOT skipped here — they are excluded from
    // global suppression, but per-DOW suppression is valid and needed for them.
    // acd.js checks _dowSuppressToday for IB types when building the candidates array.
    if (globalSuppress.has(type) || dow === 0 || dow === 6) continue;

    const shouldSuppress = ev < SUPPRESS_MAX_EV;
    if (!shouldSuppress) continue;

    const signalName = `${type}_DOW_${dow}`;
    const notes = JSON.stringify({ dow, dow_name: DOW_NAMES[dow], setup_type: type, n, wr: +(wr*100).toFixed(1), ev: +ev.toFixed(2) });

    await query(`
      INSERT INTO performance_audit
        (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl, recommendation, notes)
      VALUES ($1, 0, $2, $3, $4, $5, $6, $7, 'SUPPRESS', $8)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
        sample_size    = EXCLUDED.sample_size,
        win_rate       = EXCLUDED.win_rate,
        ev_per_trade   = EXCLUDED.ev_per_trade,
        total_pnl      = EXCLUDED.total_pnl,
        recommendation = EXCLUDED.recommendation,
        notes          = EXCLUDED.notes
    `, [today, DOW_SIGNAL_TYPE, signalName, n, wr, ev, +r.total_pnl, notes]);

    console.log(`  DOW_SUPPRESS ${DOW_NAMES[dow].padEnd(4)} ${type.padEnd(38)} N=${n} WR=${(wr*100).toFixed(1)}% EV=$${ev.toFixed(0)}`);
    dowSuppressed++;
    dowWritten++;
  }

  // Clear any stale DOW suppression rows that no longer qualify (set to ACTIVE)
  // Any signal_name matching DOW pattern that ISN'T in this run's suppress set → write ACTIVE
  const currentDowQ = await query(`
    SELECT DISTINCT ON (signal_name) signal_name, recommendation
    FROM performance_audit
    WHERE signal_type = $1
    ORDER BY signal_name, run_date DESC
  `, [DOW_SIGNAL_TYPE]);

  const newDowSuppress = new Set();
  for (const r of dowQ.rows) {
    const dow = +r.dow;
    if (globalSuppress.has(r.setup_type) || dow === 0 || dow === 6) continue;
    if (+r.ev < SUPPRESS_MAX_EV && +r.n >= SUPPRESS_MIN_N) newDowSuppress.add(`${r.setup_type}_DOW_${dow}`);
  }

  for (const row of currentDowQ.rows) {
    if (row.recommendation === 'SUPPRESS' && !newDowSuppress.has(row.signal_name)) {
      // Was suppressed, no longer qualifies — write ACTIVE to clear it
      await query(`
        INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl, recommendation, notes)
        VALUES ($1, 0, $2, $3, 0, 0, 0, 0, 'ACTIVE', '{"cleared":"no_longer_qualifies"}')
        ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET recommendation='ACTIVE', notes='{"cleared":"no_longer_qualifies"}'
      `, [today, DOW_SIGNAL_TYPE, row.signal_name]);
      console.log(`  DOW_CLEARED ${row.signal_name} (no longer qualifies)`);
      dowWritten++;
    }
  }

  console.log(`\n[backtest_setup_status] ${dowSuppressed} DOW-specific suppressions | ${dowWritten} rows written → SETUP_STATUS_DOW`);
  await pool.end();
}

run().catch(e => { console.error('[backtest_setup_status] ERROR:', e.message); process.exit(1); });
