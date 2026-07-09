// backtest_fisher_divergence.js
// ═══════════════════════════════════════════════════════════════════════
// Verifies the "97% bullish / 74% bearish" 4hr Fisher Divergence claims
// displayed in morningBrief.js /divergence-4hr endpoint.
//
// Algorithm matches the live endpoint exactly (same Fisher params, same
// divergence conditions). Also measures a control group (no signal) to
// check baseline NQ movement, since "price moves 100pt in 14 hours" may
// be trivially common regardless of signal.
//
// No lookahead: divergence is detected at bar close i; forward window
// starts at bar i+1.
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';

const FISHER_PERIOD = 10;
const BULL_WINDOW_BARS = 14; // 14 four-hour bars = ~56 hours (live claim: "within 14hr")
const BEAR_WINDOW_BARS = 22; // 22 four-hour bars (live claim: "within 22hr")
const TARGET_MOVE = 100;     // 100pt move claimed
const MIN_RANGE = 50;        // skip if 20-bar range < 50pt

async function run() {
  console.log('Loading price bars for 4hr Fisher Divergence backtest...');

  // Load all RTH + Globex bars (need overnight for forward-window measurement)
  const barsRes = await query(`
    SELECT ts::text as ts, ts::date::text as td,
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
      open::float, high::float, low::float, close::float
    FROM price_bars_primary
    WHERE symbol = 'NQ'
      AND ts::date >= '2022-01-01'
    ORDER BY ts
  `);

  if (barsRes.rows.length < 1000) {
    console.error('Insufficient bar data.');
    process.exit(1);
  }

  console.log(`  Loaded ${barsRes.rows.length} 1-min bars`);

  // ── Build 4hr bars (same bucket logic as morningBrief.js) ──────────────
  const dates = [...new Set(barsRes.rows.map(r => r.td))].sort();
  const fourHourBars = [];

  for (const d of dates) {
    const dayBars = barsRes.rows.filter(r => r.td === d);
    for (const bucket of [0, 240, 480, 720, 960, 1200]) {
      const inBucket = dayBars.filter(b => b.et_min >= bucket && b.et_min < bucket + 240);
      if (inBucket.length < 5) continue;
      fourHourBars.push({
        date: d, bucket,
        ts: inBucket[inBucket.length - 1].ts,
        open: inBucket[0].open,
        high: Math.max(...inBucket.map(b => b.high)),
        low: Math.min(...inBucket.map(b => b.low)),
        close: inBucket[inBucket.length - 1].close,
      });
    }
  }

  console.log(`  Built ${fourHourBars.length} 4hr bars across ${dates.length} sessions`);

  // ── Compute Fisher Transform (same as live endpoint) ───────────────────
  const fisher = [];
  let pF = 0, pV = 0;
  for (let i = 0; i < fourHourBars.length; i++) {
    const hl = (fourHourBars[i].high + fourHourBars[i].low) / 2;
    const s = Math.max(0, i - FISHER_PERIOD + 1);
    let hi = -Infinity, lo = Infinity;
    for (let j = s; j <= i; j++) {
      const m = (fourHourBars[j].high + fourHourBars[j].low) / 2;
      hi = Math.max(hi, m); lo = Math.min(lo, m);
    }
    const r = hi - lo;
    let v = r > 0 ? 0.33 * 2 * ((hl - lo) / r - 0.5) + 0.67 * pV : 0;
    v = Math.max(-0.999, Math.min(0.999, v));
    const ft = 0.5 * Math.log((1 + v) / (1 - v)) + 0.5 * pF;
    fisher.push(ft);
    pF = ft; pV = v;
  }

  // ── Detect divergences and measure outcomes ────────────────────────────
  const bullSignals = [], bearSignals = [];
  const controlBars = []; // bars with no signal (for baseline)

  for (let i = FISHER_PERIOD + 12; i < fourHourBars.length - Math.max(BULL_WINDOW_BARS, BEAR_WINDOW_BARS); i++) {
    const recent = fourHourBars.slice(i - 19, i + 1).map(b => b.close);
    if (recent.length < 20) continue;
    const rHi = Math.max(...recent), rLo = Math.min(...recent), rR = rHi - rLo;
    if (rR < MIN_RANGE) continue;

    const price = fourHourBars[i].close;
    const pct = (price - rLo) / rR;
    const ft = fisher[i];

    let signalFired = false;

    // ── Bullish divergence ──
    if (pct < 0.30 && ft < 0) {
      const priorPrices = recent.slice(0, 12);
      const priorLow = Math.min(...priorPrices);
      const priorIdx = priorPrices.indexOf(priorLow);
      const priorFt = fisher.slice(i - 12, i)[priorIdx];
      if (price <= priorLow * 1.01 && ft > (priorFt || 0) + 0.15) {
        // Measure forward: did price reach entry + 100pt within BULL_WINDOW_BARS?
        const fwdBars = fourHourBars.slice(i + 1, i + 1 + BULL_WINDOW_BARS);
        const fwdHigh = fwdBars.length ? Math.max(...fwdBars.map(b => b.high)) : price;
        const fwdLow  = fwdBars.length ? Math.min(...fwdBars.map(b => b.low))  : price;
        const hit = fwdHigh >= price + TARGET_MOVE;
        const maxMFE = fwdHigh - price;
        const maxMAE = price - fwdLow;
        bullSignals.push({ date: fourHourBars[i].date, bucket: fourHourBars[i].bucket, price, ft, hit, maxMFE, maxMAE });
        signalFired = true;
      }
    }

    // ── Bearish divergence ──
    if (!signalFired && pct > 0.70 && ft > 0) {
      const priorPrices = recent.slice(0, 12);
      const priorHigh = Math.max(...priorPrices);
      const priorIdx = priorPrices.indexOf(priorHigh);
      const priorFt = fisher.slice(i - 12, i)[priorIdx];
      if (price >= priorHigh * 0.99 && ft < (priorFt || 0) - 0.15) {
        const fwdBars = fourHourBars.slice(i + 1, i + 1 + BEAR_WINDOW_BARS);
        const fwdLow  = fwdBars.length ? Math.min(...fwdBars.map(b => b.low))  : price;
        const fwdHigh = fwdBars.length ? Math.max(...fwdBars.map(b => b.high)) : price;
        const hit = fwdLow <= price - TARGET_MOVE;
        const maxMFE = price - fwdLow;
        const maxMAE = fwdHigh - price;
        bearSignals.push({ date: fourHourBars[i].date, bucket: fourHourBars[i].bucket, price, ft, hit, maxMFE, maxMAE });
        signalFired = true;
      }
    }

    // ── Control: random bars not near either signal condition ──
    if (!signalFired && pct >= 0.30 && pct <= 0.70) {
      const fwdBars = fourHourBars.slice(i + 1, i + 1 + BULL_WINDOW_BARS);
      const fwdHigh = fwdBars.length ? Math.max(...fwdBars.map(b => b.high)) : price;
      const fwdLow  = fwdBars.length ? Math.min(...fwdBars.map(b => b.low))  : price;
      controlBars.push({
        upHit: fwdHigh >= price + TARGET_MOVE,
        dnHit: fwdLow <= price - TARGET_MOVE,
      });
    }
  }

  // ── Results ────────────────────────────────────────────────────────────
  const bullHits = bullSignals.filter(s => s.hit).length;
  const bearHits = bearSignals.filter(s => s.hit).length;
  const ctrlUp   = controlBars.filter(b => b.upHit).length;
  const ctrlDn   = controlBars.filter(b => b.dnHit).length;

  const mean = (arr) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  const pct  = (n, d) => d > 0 ? (n / d * 100).toFixed(1) + '%' : 'N/A';

  console.log('\n════════════════════════════════════════════════════');
  console.log('  4HR FISHER DIVERGENCE BACKTEST RESULTS');
  console.log('════════════════════════════════════════════════════\n');

  console.log(`  BULLISH DIVERGENCE (price in bottom 30%, Fisher higher low)`);
  console.log(`  N = ${bullSignals.length} signals`);
  if (bullSignals.length >= 20) {
    console.log(`  Bounce 100pt+ within ${BULL_WINDOW_BARS} 4hr bars: ${bullHits}/${bullSignals.length} = ${pct(bullHits, bullSignals.length)}`);
    console.log(`  (Live claim: "97% bounce 100pt+ within 14hr")`);
    console.log(`  Avg MFE: ${mean(bullSignals.map(s => s.maxMFE)).toFixed(0)}pt | Avg MAE: ${mean(bullSignals.map(s => s.maxMAE)).toFixed(0)}pt`);
  } else {
    console.log(`  BELOW N=20 FLOOR — results not reportable as decisive (N=${bullSignals.length})`);
  }

  console.log(`\n  BEARISH DIVERGENCE (price in top 30%, Fisher lower high)`);
  console.log(`  N = ${bearSignals.length} signals`);
  if (bearSignals.length >= 20) {
    console.log(`  Drop 100pt+ within ${BEAR_WINDOW_BARS} 4hr bars: ${bearHits}/${bearSignals.length} = ${pct(bearHits, bearSignals.length)}`);
    console.log(`  (Live claim: "74% drop 100pt+ within 22hr")`);
    console.log(`  Avg MFE: ${mean(bearSignals.map(s => s.maxMFE)).toFixed(0)}pt | Avg MAE: ${mean(bearSignals.map(s => s.maxMAE)).toFixed(0)}pt`);
  } else {
    console.log(`  BELOW N=20 FLOOR — results not reportable as decisive (N=${bearSignals.length})`);
  }

  console.log(`\n  CONTROL GROUP (no signal, same time window)`);
  console.log(`  N = ${controlBars.length} bars`);
  console.log(`  Up 100pt+ in ${BULL_WINDOW_BARS} bars (no signal): ${pct(ctrlUp, controlBars.length)}`);
  console.log(`  Dn 100pt+ in ${BULL_WINDOW_BARS} bars (no signal): ${pct(ctrlDn, controlBars.length)}`);
  console.log(`  (If bullish/bearish WR ≈ control WR, signal adds no edge)`);

  // ── Persist to performance_audit ──────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const inserts = [];

  if (bullSignals.length > 0) {
    inserts.push(query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl)
      VALUES ($1, $2, 'FISHER_4HR_BT', 'FISHER_BULLISH', $3, $4, $5, $6)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
        sample_size=EXCLUDED.sample_size, win_rate=EXCLUDED.win_rate,
        ev_per_trade=EXCLUDED.ev_per_trade, total_pnl=EXCLUDED.total_pnl
    `, [today, 365 * 3, bullSignals.length,
      bullSignals.length ? bullHits / bullSignals.length : null,
      mean(bullSignals.map(s => s.hit ? s.maxMFE : -s.maxMAE)),
      bullSignals.reduce((s, sig) => s + (sig.hit ? sig.maxMFE : -sig.maxMAE), 0)]));
  }

  if (bearSignals.length > 0) {
    inserts.push(query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl)
      VALUES ($1, $2, 'FISHER_4HR_BT', 'FISHER_BEARISH', $3, $4, $5, $6)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
        sample_size=EXCLUDED.sample_size, win_rate=EXCLUDED.win_rate,
        ev_per_trade=EXCLUDED.ev_per_trade, total_pnl=EXCLUDED.total_pnl
    `, [today, 365 * 3, bearSignals.length,
      bearSignals.length ? bearHits / bearSignals.length : null,
      mean(bearSignals.map(s => s.hit ? s.maxMFE : -s.maxMAE)),
      bearSignals.reduce((s, sig) => s + (sig.hit ? sig.maxMFE : -sig.maxMAE), 0)]));
  }

  await Promise.all(inserts);
  console.log(`\n  Written to performance_audit (signal_type='FISHER_4HR_BT')`);
  console.log('════════════════════════════════════════════════════\n');

  process.exit(0);
}

run().catch(err => {
  console.error('Fisher divergence backtest failed:', err);
  process.exit(1);
});
