// backtest_anticipation_validation.js
// ═══════════════════════════════════════════════════════════════════════
// Calibration check for setup anticipation: for each of the last 30
// trading days, compare what the anticipation model predicted (top setups
// by fire_rate × avg_pnl for that day_type/DOW) against what actually
// fired in active_setups.
//
// Outputs:
//   - Day-by-day: top-3 predicted vs actual fires (✓/✗)
//   - Calibration buckets: predicted fire% vs actual fire%
//   - Coverage: % of days where ≥1 top-N anticipated setup fired
//   - Expected vs actual EV over the window
//
// NOTE: last 30 days are ~8% of the 375-day training set, so results
// are slightly optimistic (mild in-sample). Still useful for calibration.
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const WINDOW   = 30;   // trading days to validate
const TOP_N    = 5;    // "anticipated" = top N by expected_ev
const DOW_LABEL = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

async function run() {
  // 1. Last WINDOW trading days with day_type
  const daysRes = await query(`
    SELECT trade_date::text, day_type,
           EXTRACT(dow FROM trade_date)::int AS dow
    FROM acd_daily_log
    WHERE day_type IS NOT NULL AND trade_date < CURRENT_DATE
    ORDER BY trade_date DESC
    LIMIT $1
  `, [WINDOW]);

  const days = daysRes.rows.reverse(); // oldest first
  if (!days.length) { console.error('No days found'); process.exit(1); }
  console.log(`Validating ${days.length} days: ${days[0].trade_date} → ${days[days.length-1].trade_date}\n`);

  // 2. Load all SETUP_ANTICIPATION rows (full model)
  const paRes = await query(`
    SELECT signal_name, win_rate::float AS cond_wr, ev_per_trade::float AS avg_pnl, notes
    FROM performance_audit
    WHERE signal_type = 'SETUP_ANTICIPATION' AND window_days = 0
      AND run_date = (SELECT MAX(run_date) FROM performance_audit WHERE signal_type='SETUP_ANTICIPATION' AND window_days=0)
  `);

  // Index: anticipation[ctxKey][setupType] = { fire_rate, cond_wr, avg_pnl, exp_ev }
  const anticipation = {};
  for (const r of paRes.rows) {
    const parts = r.signal_name.split('|');
    if (parts.length !== 3) continue;
    const [setupType, dt, dow] = parts;
    const ctxKey = `${dt}|${dow}`;
    const notes  = r.notes ? JSON.parse(r.notes) : {};
    if (!anticipation[ctxKey]) anticipation[ctxKey] = {};
    anticipation[ctxKey][setupType] = {
      fire_rate: notes.fire_rate  ?? null,
      cond_wr:   r.cond_wr,
      avg_pnl:   r.avg_pnl,
      exp_ev:    notes.expected_ev ?? null,
    };
  }

  // 3. Load actual fires in the window
  const dateList = days.map(d => d.trade_date);
  const firesRes = await query(`
    SELECT (fired_at AT TIME ZONE 'America/New_York')::date::text AS fire_date,
           setup_type,
           resolution,
           actual_pnl::float
    FROM active_setups
    WHERE (fired_at AT TIME ZONE 'America/New_York')::date = ANY($1::date[])
      AND status <> 'SHADOW'
      AND resolution IN ('TARGET_HIT','STOP_HIT')
    ORDER BY fire_date, fired_at
  `, [dateList]);

  // Index: actualFires[date] = Set of setup_types
  const actualFires   = {};
  const actualPnl     = {};
  const actualResults = {};
  for (const r of firesRes.rows) {
    if (!actualFires[r.fire_date])   actualFires[r.fire_date]   = new Set();
    if (!actualPnl[r.fire_date])     actualPnl[r.fire_date]     = 0;
    if (!actualResults[r.fire_date]) actualResults[r.fire_date] = {};
    actualFires[r.fire_date].add(r.setup_type);
    actualPnl[r.fire_date] += r.actual_pnl ?? 0;
    actualResults[r.fire_date][r.setup_type] = r.resolution;
  }

  // Helper: get ranked predictions for a given day
  const getPredictions = (day_type, dowLabel) => {
    const specific = anticipation[`${day_type}|${dowLabel}`] || {};
    const dtAll    = anticipation[`${day_type}|ALL`]         || {};
    const allAll   = anticipation['ALL|ALL']                  || {};

    const merged = {};
    // Most specific context wins
    for (const [s, v] of Object.entries(allAll))   merged[s] = { ...v, ctx: 'ALL|ALL'       };
    for (const [s, v] of Object.entries(dtAll))    merged[s] = { ...v, ctx: `${day_type}|ALL` };
    for (const [s, v] of Object.entries(specific)) merged[s] = { ...v, ctx: `${day_type}|${dowLabel}` };

    return Object.entries(merged)
      .filter(([, v]) => v.exp_ev != null)
      .sort(([, a], [, b]) => b.exp_ev - a.exp_ev)
      .map(([setup, v]) => ({ setup, ...v }));
  };

  // 4. Day-by-day table
  console.log('DAY-BY-DAY VALIDATION');
  console.log('═'.repeat(100));
  console.log(`${'Date'.padEnd(12)} ${'DT'.padEnd(10)} ${'Top 3 Anticipated'.padEnd(50)} Actual fires`);
  console.log('─'.repeat(100));

  let totalExpEV   = 0;
  let totalActPnl  = 0;
  let coverageHits = { 1: 0, 3: 0, 5: 0 }; // days where top-1/3/5 had ≥1 fire
  const calibBuckets = {}; // '0-10'→{predicted:0, fired:0}

  for (const day of days) {
    const dowLabel   = DOW_LABEL[day.dow];
    const preds      = getPredictions(day.day_type, dowLabel);
    const topN       = preds.slice(0, TOP_N);
    const fired      = actualFires[day.trade_date] || new Set();
    const dayPnl     = actualPnl[day.trade_date]   || 0;

    // Sum expected EV for top-N predictions on this day
    const dayExpEV = topN.reduce((s, p) => s + (p.exp_ev ?? 0), 0);
    totalExpEV  += dayExpEV;
    totalActPnl += dayPnl;

    // Coverage
    for (const n of [1, 3, 5]) {
      if (topN.slice(0, n).some(p => fired.has(p.setup))) coverageHits[n]++;
    }

    // Calibration buckets — for each top-N prediction, record predicted bucket and whether it fired
    for (const p of topN) {
      if (p.fire_rate == null) continue;
      const bucket = Math.floor(p.fire_rate * 10) * 10; // 0, 10, 20, 30...
      const key = `${bucket}-${bucket+10}%`;
      if (!calibBuckets[key]) calibBuckets[key] = { predicted: 0, fired: 0, total: 0 };
      calibBuckets[key].total++;
      if (fired.has(p.setup)) calibBuckets[key].fired++;
    }

    // Format top-3 for display
    const top3 = preds.slice(0, 3).map(p => {
      const hit = fired.has(p.setup);
      const marker = hit ? '✓' : '✗';
      return `${marker}${p.setup.replace(/_FADE_?(LONG|SHORT)?$/,'').replace(/_/g,' ')}(${(p.fire_rate*100).toFixed(0)}%)`;
    }).join('  ');

    // Actual fires not in top-3
    const extraFires = [...fired]
      .filter(s => !preds.slice(0,3).map(p=>p.setup).includes(s))
      .map(s => s.replace(/_FADE_?(LONG|SHORT)?$/,'').replace(/_/g,' '))
      .join(', ');

    const pnlStr = dayPnl !== 0 ? (dayPnl > 0 ? `+$${dayPnl.toFixed(0)}` : `-$${Math.abs(dayPnl).toFixed(0)}`) : '';

    console.log(
      `${day.trade_date.padEnd(12)} ${(day.day_type+' '+dowLabel).padEnd(10)} ${top3.padEnd(50)} ${extraFires.slice(0,30)} ${pnlStr}`
    );
  }

  // 5. Summary
  console.log('\n' + '═'.repeat(100));
  console.log('SUMMARY');
  console.log('─'.repeat(50));
  console.log(`Days validated:       ${days.length}`);
  console.log(`Total expected EV:    $${totalExpEV.toFixed(0)} ($${(totalExpEV/days.length).toFixed(1)}/day avg)`);
  console.log(`Total actual P&L:     $${totalActPnl.toFixed(0)} ($${(totalActPnl/days.length).toFixed(1)}/day avg)`);
  console.log(`Coverage (top-1 fires on ≥1 day): ${coverageHits[1]}/${days.length} = ${(coverageHits[1]/days.length*100).toFixed(0)}%`);
  console.log(`Coverage (top-3 fires on ≥1 day): ${coverageHits[3]}/${days.length} = ${(coverageHits[3]/days.length*100).toFixed(0)}%`);
  console.log(`Coverage (top-5 fires on ≥1 day): ${coverageHits[5]}/${days.length} = ${(coverageHits[5]/days.length*100).toFixed(0)}%`);

  // 6. Calibration table
  console.log('\nCALIBRATION (predicted fire-rate bucket vs actual fire rate)');
  console.log('─'.repeat(50));
  console.log(`${'Predicted bucket'.padEnd(20)} ${'Actual fired'.padStart(14)} ${'Total slots'.padStart(13)} ${'Actual rate'.padStart(13)}`);
  for (const [key, b] of Object.entries(calibBuckets).sort()) {
    const actualRate = b.total > 0 ? (b.fired / b.total * 100).toFixed(0) + '%' : 'N/A';
    const bar = '█'.repeat(Math.round(b.fired / b.total * 20));
    console.log(`  ${key.padEnd(18)} ${String(b.fired).padStart(14)} ${String(b.total).padStart(13)} ${actualRate.padStart(13)}  ${bar}`);
  }

  // 7. Best/worst anticipated setups over the window
  const setupStats = {};
  for (const day of days) {
    const dowLabel = DOW_LABEL[day.dow];
    const preds    = getPredictions(day.day_type, dowLabel).slice(0, TOP_N);
    const fired    = actualFires[day.trade_date] || new Set();
    for (const p of preds) {
      if (!setupStats[p.setup]) setupStats[p.setup] = { predicted: 0, fired: 0, exp_ev_sum: 0 };
      setupStats[p.setup].predicted++;
      setupStats[p.setup].exp_ev_sum += p.exp_ev ?? 0;
      if (fired.has(p.setup)) setupStats[p.setup].fired++;
    }
  }

  const setupRows = Object.entries(setupStats)
    .filter(([, s]) => s.predicted >= 3)
    .map(([setup, s]) => ({
      setup,
      predicted: s.predicted,
      fired: s.fired,
      actual_rate: s.fired / s.predicted,
      avg_exp_ev: s.exp_ev_sum / s.predicted,
    }))
    .sort((a, b) => b.fired - a.fired);

  console.log('\nSETUP HIT RATE IN VALIDATION WINDOW (appeared in top-5 ≥3 times)');
  console.log('─'.repeat(70));
  console.log(`${'Setup'.padEnd(38)} ${'Pred days'.padStart(10)} ${'Fired'.padStart(7)} ${'Actual%'.padStart(9)} ${'AvgExpEV'.padStart(10)}`);
  for (const r of setupRows.slice(0, 20)) {
    const pct = (r.actual_rate * 100).toFixed(0) + '%';
    console.log(`  ${r.setup.padEnd(36)} ${String(r.predicted).padStart(10)} ${String(r.fired).padStart(7)} ${pct.padStart(9)} $${r.avg_exp_ev.toFixed(1).padStart(9)}`);
  }
}

run().then(() => {
  console.log('\nDone.');
  process.exit(0);
}).catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
