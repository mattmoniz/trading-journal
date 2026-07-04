// backtest_level_approach.js
// ═══════════════════════════════════════════════════════════════════════
// For each setup type, compute per (day_type, DOW):
//   fire_rate   = P(setup fires today | day_type, DOW) = fires / total_days
//   cond_wr     = P(win | setup fired)                 = wins / fires
//   avg_pnl     = E[P&L | setup fired]
//   expected_ev = fire_rate × avg_pnl — per-session P&L contribution
//
// Answers: "On a BALANCE Wednesday, which setups are most likely to fire,
// and what's their expected per-session contribution?"
//
// Source: active_setups (TARGET_HIT + STOP_HIT only; SHADOW excluded)
// Output: performance_audit signal_type='SETUP_ANTICIPATION'
//         signal_name = 'SETUP_TYPE|DAY_TYPE|DOW' e.g. 'IB_LOW_FADE_LONG|BALANCE|WED'
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const MIN_FIRES = 5;   // minimum resolved setups to report a row
const DOW_LABEL = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

async function run() {
  console.log('Loading data...');

  // 1. Total trading days per (day_type, dow) — denominator for fire_rate
  const daysRes = await query(`
    SELECT day_type,
           EXTRACT(dow FROM trade_date)::int AS dow,
           COUNT(*)::int AS total_days
    FROM acd_daily_log
    WHERE day_type IS NOT NULL
      AND trade_date < CURRENT_DATE
    GROUP BY day_type, dow
    ORDER BY day_type, dow
  `);

  // Also compute rollups: per day_type (all DOWs) and overall
  const totalByDtDow = new Map();   // key: 'BALANCE|TUE'
  const totalByDt    = new Map();   // key: 'BALANCE'
  let totalAll = 0;
  for (const r of daysRes.rows) {
    const dow = DOW_LABEL[r.dow];
    totalByDtDow.set(`${r.day_type}|${dow}`, r.total_days);
    totalByDt.set(r.day_type, (totalByDt.get(r.day_type) || 0) + r.total_days);
    totalAll += r.total_days;
  }
  console.log(`  ${daysRes.rows.length} (day_type, dow) buckets, ${totalAll} total days`);

  // 2. Setup fires per (setup_type, day_type, dow)
  const firesRes = await query(`
    SELECT a.setup_type,
           d.day_type,
           EXTRACT(dow FROM (a.fired_at AT TIME ZONE 'America/New_York'))::int AS dow,
           COUNT(*)::int                                                    AS fires,
           COUNT(CASE WHEN a.resolution = 'TARGET_HIT' THEN 1 END)::int    AS wins,
           ROUND(AVG(a.actual_pnl)::numeric, 2)::float                     AS avg_pnl,
           ROUND(SUM(a.actual_pnl)::numeric, 2)::float                     AS total_pnl
    FROM active_setups a
    JOIN acd_daily_log d
      ON d.trade_date = (a.fired_at AT TIME ZONE 'America/New_York')::date
    WHERE a.status <> 'SHADOW'
      AND a.resolution IN ('TARGET_HIT', 'STOP_HIT')
      AND d.day_type IS NOT NULL
    GROUP BY a.setup_type, d.day_type,
             EXTRACT(dow FROM (a.fired_at AT TIME ZONE 'America/New_York'))::int
  `);
  console.log(`  ${firesRes.rows.length} (setup, day_type, dow) base rows`);

  // 3. Build stats map — one entry per (setupType, contextKey)
  //    contextKey = 'DAY_TYPE|DOW' e.g. 'BALANCE|WED'
  //    rollups: 'BALANCE|ALL', 'ALL|WED', 'ALL|ALL'
  //    stats[setupType][ctxKey] = { fires, wins, avg_pnl, total_pnl, total_days }

  // Also compute total days per DOW across all day_types (for ALL|DOW denominator)
  const totalByDow = new Map();
  for (const r of daysRes.rows) {
    const dow = DOW_LABEL[r.dow];
    totalByDow.set(dow, (totalByDow.get(dow) || 0) + r.total_days);
  }

  const stats = {};

  const add = (setupType, ctxKey, fires, wins, total_pnl) => {
    if (!stats[setupType]) stats[setupType] = {};
    if (!stats[setupType][ctxKey]) {
      stats[setupType][ctxKey] = { fires: 0, wins: 0, total_pnl: 0 };
    }
    const s = stats[setupType][ctxKey];
    s.fires     += fires;
    s.wins      += wins;
    s.total_pnl += total_pnl;
  };

  for (const r of firesRes.rows) {
    const dowLabel = DOW_LABEL[r.dow];
    add(r.setup_type, `${r.day_type}|${dowLabel}`, r.fires, r.wins, r.total_pnl);
    add(r.setup_type, `${r.day_type}|ALL`,          r.fires, r.wins, r.total_pnl);
    add(r.setup_type, `ALL|${dowLabel}`,             r.fires, r.wins, r.total_pnl);
    add(r.setup_type, 'ALL|ALL',                     r.fires, r.wins, r.total_pnl);
  }

  // total_days lookup by ctxKey — set once, not accumulated
  const getTotalDays = (ctxKey) => {
    const [dt, dow] = ctxKey.split('|');
    if (dt === 'ALL' && dow === 'ALL') return totalAll;
    if (dt === 'ALL') return totalByDow.get(dow) || 0;
    if (dow === 'ALL') return totalByDt.get(dt) || 0;
    return totalByDtDow.get(ctxKey) || 0;
  };

  // 4. Compute derived metrics
  const derived = [];
  for (const [setupType, ctxMap] of Object.entries(stats)) {
    for (const [ctxKey, s] of Object.entries(ctxMap)) {
      if (s.fires < MIN_FIRES) continue;
      const total_days = getTotalDays(ctxKey);
      const avg_pnl    = s.fires > 0 ? s.total_pnl / s.fires : null;
      const cond_wr    = s.fires > 0 ? s.wins / s.fires : null;
      const fire_rate  = total_days > 0 ? s.fires / total_days : null;
      const exp_ev     = (fire_rate != null && avg_pnl != null) ? fire_rate * avg_pnl : null;
      derived.push({ setupType, ctxKey, fires: s.fires, wins: s.wins, avg_pnl, cond_wr, fire_rate, exp_ev, total_days });
    }
  }
  console.log(`  ${derived.length} rows above MIN_FIRES=${MIN_FIRES}`);

  // 5. Write to performance_audit
  const runDate = new Date().toISOString().slice(0, 10);
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
      runDate,
      signalName,
      d.fires,
      d.cond_wr,
      d.avg_pnl,
      JSON.stringify({
        setup: d.setupType,
        day_type: d.ctxKey.split('|')[0],
        dow: d.ctxKey.split('|')[1],
        fire_rate: d.fire_rate,
        expected_ev: d.exp_ev,
        total_days: d.total_days,
      }),
    ]);
    rowsWritten++;
  }
  console.log(`\nWrote ${rowsWritten} rows to performance_audit (signal_type=SETUP_ANTICIPATION)`);

  // 6. Print rankings

  const printSection = (label, ctxKey) => {
    const rows = derived
      .filter(d => d.ctxKey === ctxKey && d.exp_ev != null)
      .sort((a, b) => b.exp_ev - a.exp_ev);
    if (!rows.length) { console.log(`\n  ── ${label}: no data ──`); return; }
    console.log(`\n═══════════════════════════════════════════════════════════════════════`);
    console.log(`${label}  (${rows[0].total_days} days)`);
    console.log(`═══════════════════════════════════════════════════════════════════════`);
    console.log(`  ${'Setup'.padEnd(35)} ${'FireRate'.padStart(9)} ${'WR'.padStart(6)} ${'AvgPnl'.padStart(8)} ${'ExpEV'.padStart(8)} ${'N'.padStart(5)}`);
    console.log(`  ${'─'.repeat(35)} ${'─'.repeat(9)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(5)}`);
    for (const r of rows.slice(0, 15)) {
      const fr  = r.fire_rate != null ? (r.fire_rate * 100).toFixed(1) + '%' : '   N/A';
      const wr  = r.cond_wr   != null ? (r.cond_wr * 100).toFixed(0) + '%'  : ' N/A';
      const ap  = r.avg_pnl   != null ? '$' + r.avg_pnl.toFixed(0)          : '    N/A';
      const ev  = r.exp_ev    != null ? '$' + r.exp_ev.toFixed(1)            : '    N/A';
      console.log(`  ${r.setupType.padEnd(35)} ${fr.padStart(9)} ${wr.padStart(6)} ${ap.padStart(8)} ${ev.padStart(8)} ${String(r.fires).padStart(5)}`);
    }
  };

  printSection('ALL DAYS', 'ALL|ALL');
  for (const dt of ['BALANCE', 'TREND', 'TURBULENT']) {
    printSection(`${dt} DAYS`, `${dt}|ALL`);
  }
}

run().then(() => {
  console.log('\nDone.');
  process.exit(0);
}).catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
