// backtest_level_approach.js
// ═══════════════════════════════════════════════════════════════════════
// Thin wrapper — the real computation lives in server/services/levelApproach.js
// (rebuilt 2026-09-27 after a real-data audit found the prior inline version had a
// disqualifying suppression-blindness bug plus no rigor/day-clustering check at all —
// see that file's own header for the full incident and RESEARCH_CLAIM
// setup_anticipation_zero_decisive_picks_20260927 for the numbers).
//
// For each (setup_type, day_type, dow): fire_rate x avg_pnl = expected per-session $
// contribution, now gated on the setup_type's CURRENT (un-overridden) SETUP_STATUS
// verdict and a real computeRigor() day-clustering/stability check — a row only carries
// `decisive: true` once it clears N>=20 trades, distinctDates>=20, and rigor.clean.
//
// Output: performance_audit signal_type='SETUP_ANTICIPATION'
//         signal_name = 'SETUP_TYPE|DAY_TYPE|DOW' e.g. 'IB_LOW_FADE_LONG|BALANCE|WED'
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';
import { computeSetupAnticipation } from '../server/services/levelApproach.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

async function run() {
  console.log('Loading data...');
  const derived = await computeSetupAnticipation();
  console.log(`  ${derived.length} rows above the N>=20 floor (suppression/rigor computed per row)`);

  const runDate = (await query(`SELECT CURRENT_DATE::text as today`)).rows[0].today;
  await query(`DELETE FROM performance_audit WHERE signal_type='SETUP_ANTICIPATION' AND run_date=$1 AND window_days=0`, [runDate]);

  let rowsWritten = 0;
  for (const d of derived) {
    const signalName = `${d.setupType}|${d.ctxKey}`;
    await query(`
      INSERT INTO performance_audit
        (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, notes)
      VALUES ($1, 0, 'SETUP_ANTICIPATION', $2, $3, $4, $5, $6)
      ON CONFLICT (run_date, window_days, signal_type, signal_name)
      DO UPDATE SET sample_size=$3, win_rate=$4, ev_per_trade=$5, notes=$6
    `, [
      runDate, signalName, d.fires, d.cond_wr, d.avg_pnl,
      JSON.stringify({
        setup: d.setupType, day_type: d.ctxKey.split('|')[0], dow: d.ctxKey.split('|')[1],
        fire_rate: d.fire_rate, expected_ev: d.exp_ev, total_days: d.total_days,
        suppressed: d.suppressed, distinctDates: d.distinctDates, top5DayPct: d.top5DayPct,
        clustered: d.clustered, stable: d.stable, decisive: d.decisive,
      }),
    ]);
    rowsWritten++;
  }
  console.log(`\nWrote ${rowsWritten} rows to performance_audit (signal_type=SETUP_ANTICIPATION)`);

  const printSection = (label, ctxKey) => {
    const rows = derived.filter(d => d.ctxKey === ctxKey && d.exp_ev != null).sort((a, b) => b.exp_ev - a.exp_ev);
    if (!rows.length) { console.log(`\n  ── ${label}: no data ──`); return; }
    console.log(`\n${'═'.repeat(90)}\n${label}  (${rows[0].total_days} days)\n${'═'.repeat(90)}`);
    console.log(`  ${'Setup'.padEnd(30)} ${'FireRate'.padStart(9)} ${'WR'.padStart(6)} ${'AvgPnl'.padStart(8)} ${'ExpEV'.padStart(8)} ${'N'.padStart(5)} ${'Days'.padStart(5)} Flag`);
    for (const r of rows.slice(0, 15)) {
      const fr = r.fire_rate != null ? (r.fire_rate * 100).toFixed(1) + '%' : '   N/A';
      const wr = r.cond_wr != null ? (r.cond_wr * 100).toFixed(0) + '%' : ' N/A';
      const ap = r.avg_pnl != null ? '$' + r.avg_pnl.toFixed(0) : '    N/A';
      const ev = r.exp_ev != null ? '$' + r.exp_ev.toFixed(1) : '    N/A';
      const flag = r.suppressed ? 'SUPPRESSED' : r.decisive ? 'DECISIVE' : 'thin/clustered';
      console.log(`  ${r.setupType.padEnd(30)} ${fr.padStart(9)} ${wr.padStart(6)} ${ap.padStart(8)} ${ev.padStart(8)} ${String(r.fires).padStart(5)} ${String(r.distinctDates).padStart(5)} ${flag}`);
    }
  };
  printSection('ALL DAYS', 'ALL|ALL');
  for (const dt of ['BALANCE', 'TREND', 'TURBULENT']) printSection(`${dt} DAYS`, `${dt}|ALL`);
}

run().then(() => { console.log('\nDone.'); process.exit(0); })
  .catch(err => { console.error('Fatal:', err); process.exit(1); });
