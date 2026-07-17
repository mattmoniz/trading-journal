// Combines both threads from tonight's "review the other levels" investigation into one
// backtest, research-only, nothing live touched:
// 1. Per-level entry tolerance zone (from scratch/study_level_approach_tolerance.mjs's real
//    barOpenDist_p75 per level) instead of the blanket 15pt window or the naive
//    exact-level-price assumption that caused the entry-price bug found earlier tonight.
// 2. An INCREMENTAL, bar-by-bar version of server/services/touchQuality.js's real
//    ABSORBED/OVERRUN classification as the entry TRIGGER, not the full-window hindsight
//    label. Replicates acd.js's own live gaveFurtherGround formula exactly
//    (`maeAtWindowEnd > maeAtBar1 + 0.01`, acd.js ~line 358) evaluated bar-by-bar as each
//    bar arrives, firing the trigger the FIRST moment (a) a volume z-score spike has
//    occurred AND (b) price has not yet given further ground -- using only bars that would
//    actually exist at that point, never the full window's hindsight.
// 3. Entry price on trigger = the FOLLOWING bar's open (conservative -- you act on a bar
//    after it's closed, not mid-bar), not the trigger bar's own price.
// 4. Baseline for comparison: same tolerance zone, but entering immediately on zone entry
//    (that bar's own open) with NO volume-trigger wait -- isolates whether the volume step
//    itself adds anything beyond just having a saner entry zone.
//
// Reuses real shared modules, does not reimplement: getVolumeBaseline (touchQuality.js),
// sweepOptimalStopAndTarget/DEFAULT_DPP (update_optimal_stops.mjs), computeRigor
// (rigorDiagnostics.js).
import { query } from '../server/db.js';
import { getVolumeBaseline } from '../server/services/touchQuality.js';
import { sweepOptimalStopAndTarget, DEFAULT_DPP } from './update_optimal_stops.mjs';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import fs from 'fs';

const FALLBACK_STOP = 90, FALLBACK_TARGET = 40; // same bounded-replay fallback as tonight's other fixed backtests

async function main() {
  // 1. Load TOUCH_QUALITY calibration for the 18 covered variants.
  const tqRes = await query(`
    SELECT signal_name, notes FROM performance_audit WHERE signal_type='TOUCH_QUALITY'
  `);
  const calibByType = {};
  for (const r of tqRes.rows) {
    const n = JSON.parse(r.notes);
    if (n.window_bars && n.high_vol_z_cutoff != null) {
      calibByType[r.signal_name] = { windowBars: n.window_bars, highVolZCutoff: n.high_vol_z_cutoff, pattern: n.pattern };
    }
  }
  const coveredTypes = Object.keys(calibByType);
  console.log(`${coveredTypes.length} setup_types have real TOUCH_QUALITY calibration to reuse.`);

  // 2. Load Stage 1 per-level tolerance (p75 of barOpenDist).
  const toleranceByLevel = JSON.parse(fs.readFileSync('scratch/level_approach_tolerance_results.json', 'utf8'));

  const datesRes = await query(`
    SELECT DISTINCT trade_date::text AS td FROM acd_daily_log
    WHERE trade_date <= '2026-07-16' AND trade_date >= '2025-01-01' ORDER BY td ASC
  `);
  const dates = datesRes.rows.map(r => r.td);

  const levelsNeeded = [...new Set(coveredTypes.map(t => t.replace(/_FADE_(LONG|SHORT)$/, '')))];
  const lpRes = await query(`SELECT trade_date::text as td, level_name, price::float as price FROM level_prices WHERE level_name = ANY($1)`, [levelsNeeded]);
  const lpByDate = {};
  for (const row of lpRes.rows) (lpByDate[row.td] ||= {})[row.level_name] = row.price;

  const triggeredTrades = [];   // volume-trigger regime
  const baselineTrades = [];    // baseline: enter immediately on zone entry
  let dateN = 0;

  for (const date of dates) {
    dateN++;
    if (dateN % 100 === 0) console.log(`  ...${dateN}/${dates.length} dates`);

    const levelsToday = levelsNeeded.filter(n => lpByDate[date]?.[n] != null).map(n => ({ name: n, val: lpByDate[date][n] }));
    if (levelsToday.length === 0) continue;

    const barsRes = await query(`
      SELECT ts, open::float, high::float, low::float, close::float,
        COALESCE(bid_volume,0)::int as bid_volume, COALESCE(ask_volume,0)::int as ask_volume,
        (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as mod
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date = $1 AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
      ORDER BY ts
    `, [date]);
    const bars = barsRes.rows;
    if (bars.length === 0) continue;

    const baseline = await getVolumeBaseline(query, date);
    const touched = new Set();

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      for (const lv of levelsToday) {
        const isLong = bar.open > lv.val;
        const dir = isLong ? 'LONG' : 'SHORT';
        const setup_type = `${lv.name}_FADE_${dir}`;
        if (!calibByType[setup_type]) continue; // only test variants with real calibration
        if (touched.has(setup_type)) continue;

        const tolerance = toleranceByLevel[lv.name]?.barOpenDist_p75;
        if (!tolerance) continue;

        if (bar.low <= lv.val + tolerance && bar.high >= lv.val - tolerance) {
          touched.add(setup_type);
          const { windowBars, highVolZCutoff } = calibByType[setup_type];
          const reactionBars = bars.slice(i + 1, i + 1 + windowBars); // bars AFTER the zone-entry bar
          if (reactionBars.length === 0) continue;

          // --- Baseline: enter immediately at zone-entry bar's own open ---
          const baseEntry = bar.open;
          const baseReplay = bars.slice(i);
          simulateAndPush(baselineTrades, setup_type, date, baseEntry, baseReplay, isLong);

          // --- Volume-trigger regime: incremental bar-by-bar check ---
          let mae = 0, maeAtBar1 = null, triggerIdx = -1;
          for (let k = 0; k < reactionBars.length; k++) {
            const rb = reactionBars[k];
            const adverse = isLong ? (lv.val - rb.low) : (rb.high - lv.val);
            mae = Math.max(mae, adverse);
            if (k === 0) maeAtBar1 = mae;
            const gaveFurtherGroundSoFar = mae > (maeAtBar1 ?? 0) + 0.01;

            const bl = baseline.get(rb.mod);
            const totalVol = (rb.bid_volume || 0) + (rb.ask_volume || 0);
            const z = (bl && bl.std_vol > 0) ? (totalVol - bl.avg_vol) / bl.std_vol : -Infinity;

            if (z > highVolZCutoff && !gaveFurtherGroundSoFar) { triggerIdx = k; break; }
            if (gaveFurtherGroundSoFar) break; // disqualified -- can never become ABSORBED now (monotonic), stop watching
          }

          if (triggerIdx >= 0 && triggerIdx + 1 < reactionBars.length) {
            // Conservative fill: the bar AFTER the confirming bar's own open, not the
            // confirming bar's own price (which wouldn't be known/actionable yet).
            const fillBar = reactionBars[triggerIdx + 1];
            const entry = fillBar.open;
            const replaySlice = bars.slice(i + 1 + triggerIdx + 1);
            simulateAndPush(triggeredTrades, setup_type, date, entry, replaySlice, isLong);
          }
        }
      }
    }
  }

  function simulateAndPush(arr, setup_type, date, entry, replaySlice, isLong) {
    if (replaySlice.length === 0) return;
    let mae = 0, mfe = 0;
    for (const b of replaySlice) {
      const adverse = isLong ? entry - b.low : b.high - entry;
      const favorable = isLong ? b.high - entry : entry - b.low;
      mae = Math.max(mae, adverse);
      mfe = Math.max(mfe, favorable);
      const stopHit = isLong ? b.low <= entry - FALLBACK_STOP : b.high >= entry + FALLBACK_STOP;
      const targetHit = isLong ? b.high >= entry + FALLBACK_TARGET : b.low <= entry - FALLBACK_TARGET;
      if (stopHit || targetHit) break;
    }
    if (mae > 300 || mfe > 300) return; // standard corruption/outlier filter
    const endClose = replaySlice[replaySlice.length - 1].close;
    const actual_pnl = (isLong ? endClose - entry : entry - endClose) * 2;
    arr.push({ trade_date: date, setup_type, mae_points: mae, mfe_points: mfe, actual_pnl });
  }

  console.log(`\nBaseline touches: ${baselineTrades.length}. Volume-triggered entries: ${triggeredTrades.length}.`);

  function summarize(trades, label) {
    const byType = {};
    for (const t of trades) (byType[t.setup_type] ||= []).push(t);
    const results = {};
    for (const [type, rows] of Object.entries(byType)) {
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
    console.log(`\n=== ${label} ===`);
    for (const [type, r] of Object.entries(results).sort((a, b) => (b[1].ev || -999) - (a[1].ev || -999))) {
      if (r.error) { console.log(type.padEnd(20), r.error); continue; }
      console.log(type.padEnd(20), 'N='+r.n, 'stop='+r.stop, 'target='+r.target, 'EV=$'+r.ev.toFixed(2), 'WR='+(r.wr*100).toFixed(1)+'%', 'clustered='+r.rigor.clustered, 'stable='+r.rigor.stable);
    }
    return results;
  }

  const baselineResults = summarize(baselineTrades, 'BASELINE (zone entry, no volume trigger)');
  const triggeredResults = summarize(triggeredTrades, 'VOLUME-TRIGGERED (incremental ABSORBED confirmation)');

  fs.writeFileSync('scratch/tolerance_volume_trigger_results.json', JSON.stringify({ baselineResults, triggeredResults }, null, 2));
  console.log('\nWrote scratch/tolerance_volume_trigger_results.json');
}

main().catch(console.error).finally(() => process.exit(0));
