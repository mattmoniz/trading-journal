// backtest_poc_magnet.js
// ═══════════════════════════════════════════════════════════════════════
// Verifies the "64% WR, 20pt target, 25pt stop" claim for the POC_MAGNET
// alert in morningBrief.js trade-alerts endpoint.
//
// Signal: fires when any RTH bar's close is within 10pt of prior-day POC.
// Trade: fade toward POC (above → SHORT, below → LONG), T1=20pt, stop=25pt.
// Entry: first qualifying bar in the session (no re-entries same day).
// No lookahead: entry at bar close, forward scan only.
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';

const PROXIMITY = 10;   // pt from PD POC
const TARGET    = 20;   // pt target from entry
const STOP      = 25;   // pt stop from entry
const PNL_WIN   = TARGET * 2; // NQ $2/pt
const PNL_LOSS  = STOP  * 2;

async function run() {
  console.log('Loading bars for POC Magnet backtest...');

  const barsRes = await query(`
    SELECT ts::date::text as td,
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
      open::float, high::float, low::float, close::float
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts::date >= '2022-01-01'
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ORDER BY ts
  `);
  const pocRes = await query(`
    SELECT trade_date::text as td, poc::float
    FROM developing_value_log WHERE poc IS NOT NULL
    ORDER BY trade_date
  `);

  const bars = barsRes.rows;
  console.log(`  Loaded ${bars.length} RTH bars`);

  const pocMap = new Map(pocRes.rows.map(r => [r.td, r.poc]));

  // Group bars by day
  const dayMap = new Map();
  for (const b of bars) {
    if (!dayMap.has(b.td)) dayMap.set(b.td, []);
    dayMap.get(b.td).push(b);
  }
  const days = [...dayMap.keys()].sort();

  const signals = [];
  const controlSignals = [];

  for (const day of days) {
    const dayBars = dayMap.get(day);
    const pdPoc = pocMap.get(day); // prior day poc — developing_value_log.trade_date = trade date
    if (!pdPoc) continue;

    // Scan for first bar within proximity
    let signalFired = false;
    for (let i = 0; i < dayBars.length; i++) {
      const b = dayBars[i];
      const dist = Math.abs(b.close - pdPoc);
      if (dist > PROXIMITY) continue;
      if (signalFired) break; // one per day

      signalFired = true;
      const isShort = b.close >= pdPoc;
      const entry = b.close;
      const t1 = isShort ? entry - TARGET : entry + TARGET;
      const stop = isShort ? entry + STOP : entry - STOP;

      // Forward scan
      let result = 'TIMEOUT';
      for (let j = i + 1; j < dayBars.length; j++) {
        const fwd = dayBars[j];
        if (isShort) {
          if (fwd.low <= t1)  { result = 'WIN';  break; }
          if (fwd.high >= stop) { result = 'LOSS'; break; }
        } else {
          if (fwd.high >= t1)  { result = 'WIN';  break; }
          if (fwd.low <= stop)  { result = 'LOSS'; break; }
        }
      }

      const pnl = result === 'WIN' ? PNL_WIN : result === 'LOSS' ? -PNL_LOSS : 0;
      signals.push({ day, dir: isShort ? 'SHORT' : 'LONG', entry, pdPoc, dist, result, pnl });
    }

    // Control: fire at a random non-POC bar (bar 60 if available, middle of session)
    if (dayBars.length >= 60) {
      const ci = Math.floor(dayBars.length * 0.4);
      const cb = dayBars[ci];
      // Only control if it's NOT a POC signal
      if (Math.abs(cb.close - pdPoc) > PROXIMITY * 3) {
        // Simulate a random SHORT for control
        const ce = cb.close;
        let cResult = 'TIMEOUT';
        for (let j = ci + 1; j < dayBars.length; j++) {
          const fwd = dayBars[j];
          if (fwd.low <= ce - TARGET)  { cResult = 'WIN';  break; }
          if (fwd.high >= ce + STOP) { cResult = 'LOSS'; break; }
        }
        controlSignals.push({ result: cResult });
      }
    }
  }

  // Results by direction
  const longs  = signals.filter(s => s.dir === 'LONG');
  const shorts = signals.filter(s => s.dir === 'SHORT');
  const wins   = signals.filter(s => s.result === 'WIN');
  const losses = signals.filter(s => s.result === 'LOSS');

  const pct = (n, d) => d > 0 ? (n / d * 100).toFixed(1) + '%' : 'N/A';
  const mean = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

  console.log('\n════════════════════════════════════════════════════');
  console.log('  POC MAGNET BACKTEST RESULTS');
  console.log(`  Entry: within ${PROXIMITY}pt of PD POC | T=${TARGET}pt | S=${STOP}pt`);
  console.log('════════════════════════════════════════════════════\n');
  console.log(`  ALL  N=${signals.length} | WR=${pct(wins.length, signals.length)} | EV=$${mean(signals.map(s=>s.pnl)).toFixed(2)}/trade`);
  console.log(`  (Win claim: "64% WR")`);
  console.log(`  LONG N=${longs.length}  | WR=${pct(longs.filter(s=>s.result==='WIN').length, longs.length)}`);
  console.log(`  SHORT N=${shorts.length} | WR=${pct(shorts.filter(s=>s.result==='WIN').length, shorts.length)}`);
  console.log(`  WIN=${wins.length} LOSS=${losses.length} TIMEOUT=${signals.filter(s=>s.result==='TIMEOUT').length}`);

  const cWins = controlSignals.filter(s => s.result === 'WIN');
  console.log(`\n  CONTROL (random bar, N=${controlSignals.length}): ${pct(cWins.length, controlSignals.length)} WR`);

  // Persist
  const today = new Date().toISOString().slice(0, 10);
  if (signals.length >= 20) {
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl)
      VALUES ($1, $2, 'POC_MAGNET_BT', 'POC_MAGNET', $3, $4, $5, $6)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
        sample_size=EXCLUDED.sample_size, win_rate=EXCLUDED.win_rate,
        ev_per_trade=EXCLUDED.ev_per_trade, total_pnl=EXCLUDED.total_pnl
    `, [today, 365 * 4, signals.length, wins.length / signals.length,
        mean(signals.map(s => s.pnl)),
        signals.reduce((s, x) => s + x.pnl, 0)]);

    // Control row
    if (controlSignals.length >= 20) {
      await query(`
        INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl)
        VALUES ($1, $2, 'POC_MAGNET_BT', 'POC_MAGNET_CONTROL', $3, $4, $5, 0)
        ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
          sample_size=EXCLUDED.sample_size, win_rate=EXCLUDED.win_rate, ev_per_trade=EXCLUDED.ev_per_trade
      `, [today, 365 * 4, controlSignals.length, cWins.length / controlSignals.length,
          mean(controlSignals.map(s => s.result === 'WIN' ? PNL_WIN : s.result === 'LOSS' ? -PNL_LOSS : 0))]);
    }
    console.log(`\n  Written to performance_audit (signal_type='POC_MAGNET_BT')`);
  } else {
    console.log(`\n  N=${signals.length} below N=20 floor — not written to performance_audit`);
  }

  console.log('════════════════════════════════════════════════════\n');
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
