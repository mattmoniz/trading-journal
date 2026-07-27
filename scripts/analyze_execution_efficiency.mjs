// analyze_execution_efficiency.mjs
//
// Built 2026-07-27 per direct user request: a durable, re-runnable capability to check
// how real fired setups actually performed vs their own MAE/MFE, and vs what's already
// calibrated as achievable (OPTIMAL_STOP's sweepOptimalStopAndTarget()) -- and to surface
// anything actionable about setup/exit design. This is NOT a one-off report: every run
// persists to performance_audit (signal_type='EXECUTION_EFFICIENCY_AUDIT') so the finding
// is queryable, re-checkable, and its own trend visible over time as real N grows (per
// CLAUDE.md's "no dead ends" rule -- a computed finding that only ever lived in a Gemini
// scratch file would be exactly the failure mode that rule exists to prevent).
//
// Scoping (deliberate, matches CLAUDE.md's standing rules): origin_status IN
// ('ACTIVE','SHADOW') only -- excludes BACKFILL (synthetic)/UNKNOWN (unrecoverable
// provenance). N>=20 floor before any setup_type-specific number is reported as decisive.
// Reuses the shared computeRigor() (server/services/rigorDiagnostics.js) for chronological-
// stability/day-clustering, rather than hand-rolling a 4th copy of that check.
//
// Run: node scripts/analyze_execution_efficiency.mjs

import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const MIN_N = 20;

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function main() {
  console.log('=== Execution Efficiency Audit ===\n');

  const rowsRes = await query(`
    SELECT setup_type, trade_date::text, resolution, actual_pnl::float, mae_points::float,
           mfe_points::float, t1_level::float, entry_zone_low::float, bar6_checkpoint
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW') AND resolution IS NOT NULL
  `);
  const all = rowsRes.rows;
  console.log(`Loaded ${all.length} real (ACTIVE/SHADOW-origin) resolved rows.\n`);

  const bySetup = new Map();
  for (const r of all) {
    if (!bySetup.has(r.setup_type)) bySetup.set(r.setup_type, []);
    bySetup.get(r.setup_type).push(r);
  }

  // Latest OPTIMAL_STOP per setup_type -- DISTINCT ON (signal_name) ordered by run_date
  // DESC FIRST, filtered after (the "take latest, then filter" convention this codebase
  // has been burned for getting backwards more than once -- see CLAUDE.md).
  const optRes = await query(`
    SELECT DISTINCT ON (signal_name) signal_name, ev_per_trade::float as ev, optimal_stop, optimal_target
    FROM performance_audit WHERE signal_type='OPTIMAL_STOP'
    ORDER BY signal_name, run_date DESC
  `);
  const optMap = {};
  for (const r of optRes.rows) optMap[r.signal_name] = r;

  const results = [];

  console.log('--- Task 1: Realized vs Calibrated Gap (N>=20) ---');
  for (const [setupType, rows] of bySetup) {
    if (rows.length < MIN_N) continue;
    const n = rows.length;
    const wins = rows.filter(r => r.resolution === 'TARGET_HIT').length;
    const wr = +(100 * wins / n).toFixed(1);
    const realizedEv = +mean(rows.map(r => r.actual_pnl)).toFixed(2);
    const cal = optMap[setupType];
    const calEv = cal ? +parseFloat(cal.ev).toFixed(2) : null;
    const gap = calEv != null ? +(realizedEv - calEv).toFixed(2) : null;
    console.log(`  ${setupType.padEnd(35)} N=${String(n).padStart(4)} WR=${wr}% realizedEV=$${realizedEv} calibratedEV=${calEv != null ? '$' + calEv : '—'} gap=${gap != null ? '$' + gap : '—'}`);

    // Task 2: MFE left on the table (winners only)
    const winners = rows.filter(r => r.resolution === 'TARGET_HIT' && r.mfe_points != null && r.t1_level != null && r.entry_zone_low != null);
    let mfeLeft = null;
    if (winners.length >= MIN_N) {
      const leftPts = winners.map(r => r.mfe_points - Math.abs(r.t1_level - r.entry_zone_low));
      const rigor = computeRigor(winners.map((r, i) => ({ date: r.trade_date, v: leftPts[i] })), { dateField: 'date', pnlFn: e => e.v });
      mfeLeft = {
        n: winners.length,
        medianPts: +median(leftPts).toFixed(2),
        meanPts: +mean(leftPts).toFixed(2),
        meanDollars: +(mean(leftPts) * PNL_PER_POINT).toFixed(2),
        rigor,
      };
      console.log(`      MFE-left-on-table: N=${mfeLeft.n} median=${mfeLeft.medianPts}pt mean=${mfeLeft.meanPts}pt ($${mfeLeft.meanDollars}) top5DayPct=${rigor.top5DayPct}% stable=${rigor.stable} clean=${rigor.clean}`);
    }

    // Task 3: losers that almost made it
    const losers = rows.filter(r => r.resolution === 'STOP_HIT' && r.mfe_points != null && r.t1_level != null && r.entry_zone_low != null);
    let almostMadeIt = null;
    if (losers.length >= MIN_N) {
      const fracs = losers.map(r => r.mfe_points / Math.abs(r.t1_level - r.entry_zone_low));
      const at50 = +(100 * fracs.filter(f => f >= 0.5).length / losers.length).toFixed(1);
      const at90 = +(100 * fracs.filter(f => f >= 0.9).length / losers.length).toFixed(1);
      almostMadeIt = { n: losers.length, at50, at90 };
      console.log(`      Losers-almost-made-it: N=${losers.length} >=0.5xTD=${at50}% >=0.9xTD=${at90}%`);
    }

    results.push({ setupType, n, wr, realizedEv, calEv, gap, mfeLeft, almostMadeIt });
  }
  if (!results.length) console.log('  (none — no setup_type has N>=20 real resolved rows yet)');

  // Task 4: bar6 checkpoint sanity check (existing mechanism, not new discovery)
  console.log('\n--- Task 4: bar6_checkpoint sanity check ---');
  const bar6Res = await query(`
    SELECT bar6_checkpoint, actual_pnl::float, resolution
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW') AND bar6_checkpoint IS NOT NULL AND resolution IS NOT NULL
  `);
  for (const cp of ['RECOVERING', 'DETERIORATING']) {
    const rows = bar6Res.rows.filter(r => r.bar6_checkpoint === cp);
    if (!rows.length) continue;
    const ev = +mean(rows.map(r => r.actual_pnl)).toFixed(2);
    const wr = +(100 * rows.filter(r => r.resolution === 'TARGET_HIT').length / rows.length).toFixed(1);
    console.log(`  ${cp.padEnd(14)} N=${rows.length} EV=$${ev} WR=${wr}%`);
  }

  // Persist — one row per setup_type that cleared MIN_N on Task 1, notes carry everything else.
  console.log('\nPersisting to performance_audit (signal_type=EXECUTION_EFFICIENCY_AUDIT)...');
  for (const r of results) {
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, notes)
      VALUES (CURRENT_DATE, 9999, 'EXECUTION_EFFICIENCY_AUDIT', $1, $2, $3, $4, $5)
    `, [
      r.setupType, r.n, r.wr / 100, r.realizedEv,
      JSON.stringify({ calibratedEv: r.calEv, gap: r.gap, mfeLeft: r.mfeLeft, almostMadeIt: r.almostMadeIt }),
    ]);
  }
  console.log(`Done. ${results.length} setup_type row(s) written.`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
