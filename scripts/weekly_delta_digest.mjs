// Daily/weekly delta digest — diffs consecutive SETUP_STATUS/OPTIMAL_STOP
// performance_audit rows and persists the real, viability-gated movers as their
// own signal_type='DAILY_DELTA' rows, so there's an actual browsable day-by-day
// history ("what changed Monday, Tuesday, Wednesday...") instead of a one-off
// scratch file. Run this after backtest_setup_status.mjs/update_optimal_stops.mjs
// in the daily calibration chain (run_daily_calibration.sh) so it always compares
// against that day's freshly-written rows.
//
// Viability gating fixed 2026-07-15 (see docs/OPEN_THREADS.md): the first version
// of this script labeled every delta "Real"/"Noise" via rigor.three_way_stable but
// never actually filtered on it, and used a flat "$5 evDelta" cutoff — a static
// threshold, which violates this codebase's own no-static-thresholds hard rule.
// Now: always include on a recommendation change (categorical, self-justifying);
// otherwise require n>=20, not THIN_N, rigor.clean, AND |evDelta| bigger than the
// setup's own recent EV volatility (stdev of computeRigor's 3 chronological
// thirds) — a rolling-distribution-derived bar, not an arbitrary dollar figure.
import { query } from '../server/db.js';

function stdev(nums) {
  const m = nums.reduce((a, b) => a + b, 0) / nums.length;
  return Math.sqrt(nums.reduce((s, x) => s + (x - m) ** 2, 0) / nums.length);
}

async function run() {
  const { rows: [{ today }] } = await query(`SELECT CURRENT_DATE::text as today`);

  const datesRes = await query(`
    SELECT run_date::text as date
    FROM performance_audit
    WHERE signal_type IN ('SETUP_STATUS', 'OPTIMAL_STOP')
    GROUP BY run_date
    ORDER BY run_date DESC
    LIMIT 2
  `);
  if (datesRes.rows.length < 2) {
    console.log('Need at least 2 run dates — skipping');
    process.exit(0);
  }
  const currDate = datesRes.rows[0].date;
  const prevDate = datesRes.rows[1].date;
  console.log(`[weekly_delta_digest] Comparing ${currDate} (curr) vs ${prevDate} (prev)`);

  const rowsRes = await query(`
    SELECT *
    FROM performance_audit
    WHERE run_date IN ($1, $2) AND signal_type IN ('SETUP_STATUS', 'OPTIMAL_STOP')
  `, [currDate, prevDate]);

  const signals = {};
  for (const row of rowsRes.rows) {
    const key = `${row.signal_type}_${row.signal_name}`;
    if (!signals[key]) signals[key] = { signal_type: row.signal_type, signal_name: row.signal_name };
    let rigor = null;
    try { rigor = (JSON.parse(row.notes || '{}')).rigor || null; } catch (_) {}
    const data = {
      sample_size: row.sample_size,
      ev_per_trade: parseFloat(row.ev_per_trade || 0),
      recommendation: row.recommendation,
      optimal_stop: row.optimal_stop,
      optimal_target: row.optimal_target,
      rigor,
    };
    if (row.run_date === currDate) signals[key].curr = data;
    else if (row.run_date === prevDate) signals[key].prev = data;
  }

  const results = [];
  for (const data of Object.values(signals)) {
    if (!data.curr || !data.prev) continue;
    const { curr, prev } = data;

    const nDelta = curr.sample_size - prev.sample_size;
    const evDelta = curr.ev_per_trade - prev.ev_per_trade;
    const recChanged = curr.recommendation !== prev.recommendation;
    const isThinN = curr.recommendation === 'THIN_N';
    const isClean = curr.rigor ? curr.rigor.clean === true : false;

    let stopStr = '', targetStr = '', stopTargetDelta = false;
    if (data.signal_type === 'OPTIMAL_STOP') {
      if (curr.optimal_stop !== prev.optimal_stop)   { stopTargetDelta = true; stopStr   = `${prev.optimal_stop} -> ${curr.optimal_stop}`; }
      if (curr.optimal_target !== prev.optimal_target) { stopTargetDelta = true; targetStr = `${prev.optimal_target} -> ${curr.optimal_target}`; }
    }

    const noiseFloor = curr.rigor?.thirds
      ? stdev([curr.rigor.thirds.ev1, curr.rigor.thirds.ev2, curr.rigor.thirds.ev3]) || 1
      : Infinity; // no rigor thirds available (e.g. OPTIMAL_STOP rows) — can't clear a dynamic bar, only recommendation/stop-target changes qualify

    const viableMagnitudeChange = curr.sample_size >= 20 && !isThinN && isClean && Math.abs(evDelta) > noiseFloor;

    if (recChanged || stopTargetDelta || viableMagnitudeChange) {
      results.push({
        signal_type: data.signal_type, signal_name: data.signal_name,
        nDelta, evDelta, currN: curr.sample_size, currEV: curr.ev_per_trade, prevEV: prev.ev_per_trade,
        recChanged, recStr: recChanged ? `${prev.recommendation} -> ${curr.recommendation}` : curr.recommendation,
        stopStr, targetStr,
        gate: recChanged ? 'REC_CHANGE' : stopTargetDelta ? 'STOP_TGT_CHANGE' : 'EV_VOL_BREAK',
      });
    }
  }

  results.sort((a, b) => Math.abs(b.evDelta) - Math.abs(a.evDelta));
  console.log(`[weekly_delta_digest] ${results.length} viability-gated movers (of ${Object.keys(signals).length} signals compared)`);

  for (const r of results) {
    const notes = JSON.stringify({
      compared_to: prevDate, nDelta: r.nDelta, evDelta: r.evDelta, prevEV: r.prevEV,
      recChanged: r.recChanged, recStr: r.recStr, stopStr: r.stopStr, targetStr: r.targetStr, gate: r.gate,
    });
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, recommendation, notes)
      VALUES ($1, 1, 'DAILY_DELTA', $2, $3, $4, $5, $6)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
        sample_size = EXCLUDED.sample_size, ev_per_trade = EXCLUDED.ev_per_trade,
        recommendation = EXCLUDED.recommendation, notes = EXCLUDED.notes
    `, [today, `${r.signal_type}:${r.signal_name}`, r.currN, r.currEV, r.gate, notes]);
  }

  console.log('[weekly_delta_digest] done');
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
