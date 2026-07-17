// The actual, final close-out of the level that started tonight's entire investigation.
// PD2_VAH/PD2_VAL never got the validated methodology applied -- they only ever went
// through the FIRST fix (bounded 90/40 replay + <=300 filter), which was itself later
// found to still assume entry at the exact level price. This re-runs them with the real
// fix: entry = the touch bar's own open (matching Stage 2's "baseline" convention -- no
// volume trigger, since that thesis was tested and did not hold up against a real
// baseline). 2D_POC is deliberately excluded -- its live price computation has a separate,
// confirmed, unfixed bug (same volume-bucketing flaw as compute_levels.js's
// computeValueArea(), see live_2d_poc_price_computation_bucketing_bug) -- testing it now
// would just remeasure that bug, not the level itself.
import { query } from '../server/db.js';
import { replayBars } from '../server/services/maeMfeReplay.js';
import { sweepOptimalStopAndTarget, DEFAULT_DPP } from './update_optimal_stops.mjs';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import fs from 'fs';

const FALLBACK_STOP = 90, FALLBACK_TARGET = 40;

async function main() {
  const datesRes = await query(`
    SELECT DISTINCT trade_date::text AS td FROM acd_daily_log
    WHERE trade_date <= '2026-07-16' AND trade_date >= '2025-01-01' ORDER BY td ASC
  `);
  const dates = datesRes.rows.map(r => r.td);
  console.log(`Testing PD2_VAH/PD2_VAL across ${dates.length} dates (2D_POC excluded, price bug unfixed)...`);

  const trades = [];
  let dateN = 0;
  for (const date of dates) {
    dateN++;
    if (dateN % 100 === 0) console.log(`  ...${dateN}/${dates.length} dates`);

    // Exact replication of acd.js's own pd2Q query -- unaffected by the compute_levels.js
    // or live 2D_POC bugs, developing_value_log is a separate, correct source.
    const pd2Q = await query(`
      SELECT vah::float, val::float FROM developing_value_log
      WHERE trade_date < (SELECT MAX(trade_date) FROM developing_value_log WHERE trade_date < $1)
      ORDER BY trade_date DESC LIMIT 1
    `, [date]);
    if (!pd2Q.rows[0]) continue;
    const levels = [
      { name: 'PD2_VAH', val: pd2Q.rows[0].vah },
      { name: 'PD2_VAL', val: pd2Q.rows[0].val },
    ].filter(l => l.val != null);
    if (levels.length === 0) continue;

    const barsRes = await query(`
      SELECT ts, open::float, high::float, low::float, close::float
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date = $1 AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
      ORDER BY ts
    `, [date]);
    const bars = barsRes.rows;
    if (bars.length === 0) continue;

    const touched = new Set();
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      for (const lv of levels) {
        if (touched.has(lv.name)) continue;
        if (bar.low <= lv.val + 15 && bar.high >= lv.val - 15) {
          touched.add(lv.name);
          const isLong = bar.open > lv.val;
          const dir = isLong ? 'LONG' : 'SHORT';
          const setup_type = `${lv.name}_FADE_${dir}`;

          // THE FIX: entry = the touch bar's own open (realistic -- what you'd have seen
          // before this bar's outcome was known), not the exact level price.
          const entry = bar.open;
          const replaySlice = bars.slice(i);
          const replay = replayBars(replaySlice, entry, entry - FALLBACK_STOP, entry + FALLBACK_TARGET, dir);
          if (replay && replay.mae <= 300 && replay.mfe <= 300) {
            const endClose = replaySlice[replaySlice.length - 1].close;
            const actual_pnl = (isLong ? endClose - entry : entry - endClose) * 2;
            trades.push({ trade_date: date, setup_type, mae_points: replay.mae, mfe_points: replay.mfe, actual_pnl });
          }
        }
      }
    }
  }

  console.log(`Found ${trades.length} touches.`);

  const results = {};
  for (const type of ['PD2_VAH_FADE_LONG', 'PD2_VAH_FADE_SHORT', 'PD2_VAL_FADE_LONG', 'PD2_VAL_FADE_SHORT']) {
    const rows = trades.filter(t => t.setup_type === type);
    const n = rows.length;
    if (n < 20) { results[type] = { n, error: 'N<20' }; continue; }
    const sortedMae = [...rows].sort((a, b) => a.mae_points - b.mae_points);
    const pct = (arr, p) => arr[Math.floor(arr.length * p)].mae_points;
    const maeCandidates = [0.25, 0.40, 0.50, 0.60, 0.75].map(p => ({ value: pct(sortedMae, p), pct: p })).filter(c => c.value > 0);
    const sortedMfe = [...rows].sort((a, b) => a.mfe_points - b.mfe_points);
    const p75mfe = sortedMfe[Math.floor(n * 0.75)].mfe_points;
    const swept = sweepOptimalStopAndTarget(rows, maeCandidates, Math.round(p75mfe), DEFAULT_DPP, DEFAULT_DPP);
    if (!swept) { results[type] = { n, error: 'sweep failed' }; continue; }
    let wins = 0;
    const rigorEvents = rows.map(r => {
      let pnl = r.actual_pnl;
      if (r.mae_points > swept.stop) pnl = -swept.stop;
      else if (r.mfe_points >= swept.target) pnl = swept.target;
      if (pnl > 0) wins++;
      return { trade_date: r.trade_date, pnl };
    });
    const rigor = computeRigor(rigorEvents, { dateField: 'trade_date', pnlFn: e => e.pnl });
    results[type] = { n, stop: swept.stop, target: swept.target, ev: swept.ev, wr: wins / n, rigor };
  }

  fs.writeFileSync('scratch/pd2_final_results.json', JSON.stringify(results, null, 2));
  console.log('\n=== FINAL PD2_VAH/PD2_VAL RESULTS (validated methodology) ===');
  for (const [type, r] of Object.entries(results)) {
    if (r.error) { console.log(type.padEnd(20), r.error); continue; }
    console.log(type.padEnd(20), 'N='+r.n, 'stop='+r.stop, 'target='+r.target, 'EV=$'+r.ev.toFixed(2), 'WR='+(r.wr*100).toFixed(1)+'%', 'clustered='+r.rigor.clustered, 'stable='+r.rigor.stable);
  }
}

main().catch(console.error).finally(() => process.exit(0));
