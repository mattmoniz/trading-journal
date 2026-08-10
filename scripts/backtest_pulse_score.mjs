/**
 * Backtest: Pulse Score × Day_Type conditional matrix.
 *
 * Computes the sizeMultiplier pulse score for each historical resolved setup and
 * cross-tabs by (day_type × score_bucket). Validates whether the day-type conditioning
 * rules wired in acd.js are holding over time as more live data accumulates:
 *   - TURBULENT: score-0 penalty off (N=347, baseline EV +$30.60 — level edge dominates)
 *   - TREND: score-2 boost off (N=158, baseline EV -$5.70 — fades structurally weak)
 *   - BALANCE: full matrix
 *
 * Writes PULSE_SCORE_AUDIT rows to performance_audit (16 rows: 4 day_types × 4 score buckets).
 * Health check: signal_type='PULSE_SCORE_AUDIT' in session-start.sh.
 *
 * Run:  node scripts/backtest_pulse_score.mjs
 * Cron: Sunday 9:15 PM ET (run_weekly_backtests.sh)
 */

import { query } from '../server/db.js';
import pool from '../server/db.js';

const SIGNAL_TYPE = 'PULSE_SCORE_AUDIT';

function getDir(setup_type) {
  if (!setup_type) return null;
  if (setup_type.includes('_LONG')) return 'LONG';
  if (setup_type.includes('_SHORT')) return 'SHORT';
  return null;
}

function computePulseScore(bars, volBaseline, dir) {
  if (!bars || bars.length < 2) return null;

  // 1. Vol sigma: max sigma across last 3 bars vs 90-day same-minute baseline
  const last3 = bars.slice(-3);
  let volSigma = null;
  for (const b of last3) {
    const bl = volBaseline[b.et_min];
    if (!bl || bl.avg <= 0) continue;
    const vol = (b.ask_vol || 0) + (b.bid_vol || 0);
    const sig = (vol - bl.avg) / Math.max(bl.std, 1);
    if (volSigma == null || sig > volSigma) volSigma = sig;
  }
  const highVol = volSigma != null && volSigma >= 2.5;

  // 2. Delta divergence: last 15 bars, direction-aware
  const last15 = bars.slice(-15);
  const delta15 = last15.reduce((s, b) => s + ((b.ask_vol || 0) - (b.bid_vol || 0)), 0);
  const deltaDiv = dir === 'SHORT' ? delta15 > 0 : dir === 'LONG' ? delta15 < 0 : false;

  // 3. Micro structure: last 8 bars strict higher-lows OR lower-highs
  const last8 = bars.slice(-8);
  let struct = false;
  if (last8.length >= 2) {
    const hl = last8.every((b, i) => i === 0 || b.low  >= last8[i-1].low);
    const lh = last8.every((b, i) => i === 0 || b.high <= last8[i-1].high);
    struct = hl || lh;
  }

  // 4. Low rotations: ≤1 sign change in full session closes to signal
  let rots = 0;
  for (let i = 2; i < bars.length; i++) {
    const d1 = Math.sign(bars[i].close   - bars[i-1].close);
    const d0 = Math.sign(bars[i-1].close - bars[i-2].close);
    if (d1 !== 0 && d0 !== 0 && d1 !== d0) rots++;
  }
  const lowRots = rots <= 1;

  return (highVol ? 1 : 0) + (deltaDiv ? 1 : 0) + (struct ? 1 : 0) + (lowRots ? 1 : 0);
}

// Pulse adjustment given score and day_type (mirrors live acd.js logic)
function pulseAdj(score, dayType) {
  if (score >= 3)                             return +0.20;
  if (score >= 2 && dayType !== 'TREND')      return +0.10;
  if (score === 0 && dayType !== 'TURBULENT') return -0.10;
  return 0;
}

function aggregateBucket(setups, dayType, scoreBucket) {
  const n = setups.length;
  if (n === 0) return { n, wr: null, ev: null, totalPnl: null, evLift: 0, pnlLift: 0 };
  const wins = setups.filter(s => s.resolution === 'TARGET_HIT').length;
  let baseTotal = 0, adjTotal = 0;
  for (const s of setups) {
    const pnl     = parseFloat(s.actual_pnl) || 0;
    const baseMult = Math.max(parseFloat(s.size_multiplier) || 1.0, 0.01);
    const adj      = pulseAdj(scoreBucket, dayType);
    const adjMult  = Math.max(0.25, Math.min(1.5, baseMult + adj));
    baseTotal += pnl;
    adjTotal  += pnl * adjMult / baseMult;
  }
  return {
    n, wr: wins / n, ev: baseTotal / n, totalPnl: baseTotal,
    evLift: (adjTotal - baseTotal) / n, pnlLift: adjTotal - baseTotal,
  };
}

async function run() {
  console.log('[backtest_pulse_score] Starting...');

  // Load all qualifying setups with day_type
  const setupsQ = await query(`
    SELECT
      s.id, s.trade_date::text, s.setup_type,
      s.fired_at,
      s.resolution, s.actual_pnl,
      COALESCE(s.size_multiplier, 1.0) AS size_multiplier,
      CASE WHEN s.setup_type LIKE '%_LONG'  THEN 'LONG'
           WHEN s.setup_type LIKE '%_SHORT' THEN 'SHORT' END AS dir,
      COALESCE(d.day_type, 'BALANCE') AS day_type
    FROM active_setups s
    LEFT JOIN acd_daily_log d ON d.trade_date = s.trade_date
    WHERE s.status = 'RESOLVED'
      AND s.resolution IN ('TARGET_HIT','STOP_HIT')
      AND s.fired_at IS NOT NULL
      AND s.actual_pnl IS NOT NULL
      AND s.origin_status IN ('ACTIVE', 'SHADOW')
    ORDER BY s.trade_date, s.fired_at
  `);
  // preflight_backtest_assertions.mjs check [1], roadmap Phase 0 sweep, 2026-08-10: was
  // unfiltered by origin_status -- PULSE_SCORE_AUDIT feeds the live Pulse Score display.

  const setups = setupsQ.rows;
  console.log(`[backtest_pulse_score] ${setups.length} setups loaded`);

  // Group setups by trade_date
  const byDate = {};
  for (const s of setups) {
    (byDate[s.trade_date] = byDate[s.trade_date] || []).push(s);
  }

  const dates = Object.keys(byDate).sort();
  const windowDays = dates.length > 1
    ? Math.round((new Date(dates.at(-1)) - new Date(dates[0])) / 86400000)
    : 1;

  // matrix[dayType][scoreBucket] = array of setups
  const DAY_TYPES = ['BALANCE', 'TREND', 'TURBULENT'];
  const matrix = {};
  for (const dt of [...DAY_TYPES, 'ALL']) matrix[dt] = { 0: [], 1: [], 2: [], 3: [] };

  // Process date by date
  for (let i = 0; i < dates.length; i++) {
    const tradeDate = dates[i];
    if (i % 100 === 0) console.log(`  date ${i+1}/${dates.length}: ${tradeDate}`);

    // RTH bars for this day
    const barsQ = await query(`
      SELECT
        (EXTRACT(hour FROM ts AT TIME ZONE 'America/New_York')*60 +
         EXTRACT(minute FROM ts AT TIME ZONE 'America/New_York'))::int AS et_min,
        high::float, low::float, close::float,
        COALESCE(ask_volume,0)::float AS ask_vol,
        COALESCE(bid_volume,0)::float AS bid_vol,
        ts
      FROM price_bars_primary
      WHERE symbol = 'NQ'
        AND ts::date = $1
        AND (EXTRACT(hour FROM ts AT TIME ZONE 'America/New_York')*60 +
             EXTRACT(minute FROM ts AT TIME ZONE 'America/New_York')) BETWEEN 570 AND 959
      ORDER BY ts
    `, [tradeDate]);
    const allBars = barsQ.rows;
    if (!allBars.length) continue;

    // 90-day vol baseline for this date
    const blQ = await query(`
      SELECT
        (EXTRACT(hour FROM ts AT TIME ZONE 'America/New_York')*60 +
         EXTRACT(minute FROM ts AT TIME ZONE 'America/New_York'))::int AS et_min,
        AVG((COALESCE(ask_volume,0)+COALESCE(bid_volume,0))::float) AS avg_vol,
        STDDEV((COALESCE(ask_volume,0)+COALESCE(bid_volume,0))::float) AS std_vol
      FROM price_bars_primary
      WHERE symbol = 'NQ'
        AND ts::date >= $1::date - 90 AND ts::date < $1
        AND (EXTRACT(hour FROM ts AT TIME ZONE 'America/New_York')*60 +
             EXTRACT(minute FROM ts AT TIME ZONE 'America/New_York')) BETWEEN 570 AND 959
      GROUP BY 1
    `, [tradeDate]);
    const volBaseline = {};
    for (const r of blQ.rows) volBaseline[r.et_min] = { avg: +r.avg_vol, std: +(r.std_vol || 1) };

    // Score each setup
    for (const setup of byDate[tradeDate]) {
      const firedMs  = new Date(setup.fired_at).getTime();
      const bars     = allBars.filter(b => new Date(b.ts).getTime() <= firedMs);
      if (bars.length < 2) continue;

      const score = computePulseScore(bars, volBaseline, setup.dir);
      if (score === null) continue;

      const bucket = score >= 3 ? 3 : score;
      const dt     = setup.day_type;
      if (matrix[dt]) matrix[dt][bucket].push(setup);
      matrix.ALL[bucket].push(setup);
    }
  }

  // Build result rows
  const today = (await query(`SELECT CURRENT_DATE::text as today`)).rows[0].today;
  const rows = [];

  for (const dt of [...DAY_TYPES, 'ALL']) {
    for (const score of [0, 1, 2, 3]) {
      const bucket = matrix[dt][score] || [];
      const agg    = aggregateBucket(bucket, dt === 'ALL' ? null : dt, score);

      let rec = 'NEUTRAL';
      if (agg.n < 20) {
        rec = 'INSUFFICIENT_DATA';
      } else if (score === 0 && dt !== 'TURBULENT' && dt !== 'ALL' && (agg.ev == null || agg.ev < 0)) {
        rec = 'SIZE_DOWN';
      } else if (score >= 3 && dt !== 'TURBULENT' && dt !== 'ALL' && agg.ev != null && agg.ev > 0) {
        rec = 'SIZE_UP_STRONG';
      } else if (score >= 2 && dt !== 'TREND' && dt !== 'ALL' && agg.ev != null && agg.ev > 0) {
        rec = 'SIZE_UP';
      }

      const adjustment = rec === 'SIZE_UP_STRONG' ? 0.20
                       : rec === 'SIZE_UP'        ? 0.10
                       : rec === 'SIZE_DOWN'      ? -0.10
                       : 0;

      rows.push({
        signalName: `${dt}_SCORE_${score}`,
        n: agg.n, wr: agg.wr, ev: agg.ev, totalPnl: agg.totalPnl,
        evLift: agg.evLift, pnlLift: agg.pnlLift,
        rec, adjustment, dt, score,
      });
    }
  }

  // Print summary
  console.log('\n=== PULSE SCORE × DAY_TYPE MATRIX ===');
  for (const r of rows) {
    if (r.dt === 'ALL') continue;
    const thin = r.n < 20 ? ' [THIN]' : '';
    const ev   = r.ev  != null ? `$${r.ev.toFixed(0)}`.padStart(7) : '    N/A';
    const lift = r.evLift != null ? `$${r.evLift.toFixed(2)}` : 'N/A';
    console.log(`${r.signalName.padEnd(22)} N=${String(r.n).padStart(4)}  EV=${ev}  lift/trade=${lift.padStart(7)}  → ${r.rec}${thin}`);
  }
  console.log('\n=== SUMMARY BY DAY_TYPE ===');
  for (const dt of DAY_TYPES) {
    const allForDt = [0,1,2,3].flatMap(s => matrix[dt][s]);
    const totalBase = allForDt.reduce((s, r) => s + (parseFloat(r.actual_pnl)||0), 0);
    const totalAdj  = rows.filter(r => r.dt === dt).reduce((s, r) => s + r.pnlLift, 0) + totalBase;
    console.log(`  ${dt.padEnd(12)} N=${String(allForDt.length).padStart(5)}  baseP&L=$${totalBase.toFixed(0)}  adjP&L=$${totalAdj.toFixed(0)}  lift=$${(totalAdj-totalBase).toFixed(0)}`);
  }

  // Write to performance_audit
  let written = 0;
  for (const r of rows) {
    const notes = JSON.stringify({
      day_type:     r.dt,
      score_bucket: r.score,
      baseline_ev:  r.ev   != null ? +r.ev.toFixed(2) : null,
      ev_lift:      +r.evLift.toFixed(2),
      pnl_lift:     +r.pnlLift.toFixed(2),
      adjustment:   r.adjustment,
    });
    await query(`
      INSERT INTO performance_audit
        (run_date, window_days, signal_type, signal_name,
         sample_size, win_rate, ev_per_trade, total_pnl, recommendation, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (run_date, window_days, signal_type, signal_name)
      DO UPDATE SET
        sample_size  = EXCLUDED.sample_size,
        win_rate     = EXCLUDED.win_rate,
        ev_per_trade = EXCLUDED.ev_per_trade,
        total_pnl    = EXCLUDED.total_pnl,
        recommendation = EXCLUDED.recommendation,
        notes        = EXCLUDED.notes
    `, [today, windowDays, SIGNAL_TYPE, r.signalName,
        r.n, r.wr, r.ev, r.totalPnl, r.rec, notes]);
    written++;
  }

  console.log(`\n[backtest_pulse_score] ${written} rows written → performance_audit PULSE_SCORE_AUDIT`);
  await pool.end();
}

run().catch(e => { console.error('[backtest_pulse_score] ERROR:', e.message); process.exit(1); });
