// backtest_weekly_vwap.js
// ═══════════════════════════════════════════════════════════════════════
// Verifies the "91% next-day reversion at 2σ" claim for the WEEKLY_VWAP
// alert in morningBrief.js trade-alerts endpoint.
//
// Signal: fires when session close is ≥2σ from weekly VWAP.
// σ = rolling std of trailing 12 weeks of (weekly Friday close - weekly VWAP).
// Weekly VWAP = volume-weighted average from Monday through today.
//
// "Reversion" = next session's close is closer to the weekly VWAP than
// today's close (primary metric). Secondary: % that reach within 1σ.
//
// Control group: sessions where |sigma| < 1 — what % show reversion anyway?
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';

const SIGMA_TRIGGER = 2.0;   // fire when |sigma| >= 2
const CONTROL_SIGMA_MAX = 1.0; // control = sessions with |sigma| < 1

function rollingStd(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
}

// Given a Monday date string, find the week's VWAP using bar array
function computeWeekVwap(weekBars) {
  let pv = 0, v = 0;
  for (const b of weekBars) {
    const vol = Number(b.vol) || 1;
    pv += (b.high + b.low + b.close) / 3 * vol;
    v += vol;
  }
  return v > 0 ? pv / v : 0;
}

async function run() {
  console.log('Loading bars for Weekly VWAP backtest...');

  const barsRes = await query(`
    SELECT ts::date::text as td, ts::date as trade_date,
      EXTRACT(dow FROM ts::date)::int as dow,
      high::float, low::float, close::float,
      volume::bigint as vol
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts::date >= '2021-06-01'
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ORDER BY ts
  `);

  const allBars = barsRes.rows;
  console.log(`  Loaded ${allBars.length} RTH bars`);

  // Group bars by day
  const dayBars = new Map();
  for (const b of allBars) {
    if (!dayBars.has(b.td)) dayBars.set(b.td, []);
    dayBars.get(b.td).push(b);
  }
  const days = [...dayBars.keys()].sort();
  console.log(`  ${days.length} trading days`);

  // Build weekly groups: find the Monday for each day
  function getMondayStr(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    const dow = d.getDay();
    const offset = dow === 0 ? 6 : dow - 1; // Mon=0 offset
    const mon = new Date(d.getTime() - offset * 86400000);
    return mon.toISOString().slice(0, 10);
  }

  // Build per-week VWAP map: weekKey (monday) → final VWAP (using Friday bars)
  const weekBarsMap = new Map(); // monday → all bars
  for (const [td, bars] of dayBars) {
    const mon = getMondayStr(td);
    if (!weekBarsMap.has(mon)) weekBarsMap.set(mon, []);
    weekBarsMap.get(mon).push(...bars);
  }

  // For each week (monday), compute week-end VWAP and last close
  const weekData = []; // { monday, vwap, lastClose, dist }
  for (const [mon, wBars] of weekBarsMap) {
    if (wBars.length < 50) continue;
    // Sort by date, get last close
    wBars.sort((a, b) => a.td < b.td ? -1 : 1);
    const lastClose = wBars[wBars.length - 1].close;
    const vwap = computeWeekVwap(wBars);
    const dist = lastClose - vwap;
    weekData.push({ monday: mon, vwap, lastClose, dist });
  }
  weekData.sort((a, b) => a.monday < b.monday ? -1 : 1);

  // Build lookup: for date d, get trailing 12-week dist distribution
  const weekDataByMon = new Map(weekData.map(w => [w.monday, w]));
  const allMondays = weekData.map(w => w.monday);

  function getTrailing12Std(mondayStr) {
    const idx = allMondays.indexOf(mondayStr);
    if (idx < 4) return null; // need at least 8 prior weeks
    const prior = weekData.slice(Math.max(0, idx - 12), idx); // exclude current week
    if (prior.length < 8) return null;
    return rollingStd(prior.map(w => w.dist));
  }

  // For each trading day (start from 2022), compute daily sigma
  const signals = []; // days where |sigma| >= SIGMA_TRIGGER
  const controlDays = []; // days where |sigma| < CONTROL_SIGMA_MAX

  const startDate = '2022-01-01';
  const qualDays = days.filter(d => d >= startDate);

  for (const day of qualDays) {
    const mon = getMondayStr(day);
    const std = getTrailing12Std(mon);
    if (!std || std <= 0) continue;

    // Compute today's weekly VWAP (Mon through today)
    const todayWeekBars = [];
    for (const d of days) {
      if (getMondayStr(d) === mon && d <= day) {
        todayWeekBars.push(...(dayBars.get(d) || []));
      }
    }
    if (todayWeekBars.length < 30) continue;

    const weeklyVwap = computeWeekVwap(todayWeekBars);
    const todayClose = dayBars.get(day)[dayBars.get(day).length - 1].close;
    const dist = todayClose - weeklyVwap;
    const sigma = dist / std;

    if (Math.abs(sigma) >= SIGMA_TRIGGER) {
      signals.push({ day, sigma, todayClose, weeklyVwap, std, dist });
    } else if (Math.abs(sigma) < CONTROL_SIGMA_MAX) {
      controlDays.push({ day, sigma, todayClose, weeklyVwap, std, dist });
    }
  }

  console.log(`  Signal (|σ|≥${SIGMA_TRIGGER}): ${signals.length} days`);
  console.log(`  Control (|σ|<${CONTROL_SIGMA_MAX}): ${controlDays.length} days`);

  // For each signal, check next trading day
  function checkReversion(sig) {
    const dayIdx = qualDays.indexOf(sig.day);
    if (dayIdx === -1 || dayIdx === qualDays.length - 1) return null;
    const nextDay = qualDays[dayIdx + 1];
    const nextBars = dayBars.get(nextDay);
    if (!nextBars || nextBars.length < 5) return null;

    const nextMon = getMondayStr(nextDay);
    // Recompute weekly VWAP for next day (may start new week)
    const nextWeekBars = [];
    for (const d of days) {
      if (getMondayStr(d) === nextMon && d <= nextDay) {
        nextWeekBars.push(...(dayBars.get(d) || []));
      }
    }
    const nextWeekVwap = nextWeekBars.length >= 20 ? computeWeekVwap(nextWeekBars) : sig.weeklyVwap;
    const nextClose = nextBars[nextBars.length - 1].close;
    const todayDistToVwap = Math.abs(sig.todayClose - sig.weeklyVwap);
    const nextDistToVwap = Math.abs(nextClose - sig.weeklyVwap);
    const reverted = nextDistToVwap < todayDistToVwap;

    // Secondary: did next day at any point reach within 1σ?
    const within1Sigma = nextBars.some(b =>
      Math.abs(b.close - sig.weeklyVwap) < sig.std * 1.0
    );

    // Trade outcome: fade toward VWAP next day at open
    // "Win" if next session ends closer to weekly VWAP
    return { nextDay, nextClose, nextDistToVwap, todayDistToVwap, reverted, within1Sigma };
  }

  const sigResults = signals.map(s => ({ ...s, outcome: checkReversion(s) }))
    .filter(s => s.outcome !== null);
  const ctrlResults = controlDays.slice(0, 300).map(s => ({ ...s, outcome: checkReversion(s) }))
    .filter(s => s.outcome !== null);

  const sigReverted = sigResults.filter(s => s.outcome.reverted).length;
  const sigWithin1S = sigResults.filter(s => s.outcome.within1Sigma).length;
  const ctrlReverted = ctrlResults.filter(s => s.outcome.reverted).length;
  const ctrlWithin1S = ctrlResults.filter(s => s.outcome.within1Sigma).length;

  const pct = (n, d) => d > 0 ? (n / d * 100).toFixed(1) + '%' : 'N/A';

  console.log('\n════════════════════════════════════════════════════');
  console.log('  WEEKLY VWAP REVERSION BACKTEST RESULTS');
  console.log(`  Trigger: |σ| ≥ ${SIGMA_TRIGGER} from weekly VWAP at session close`);
  console.log('════════════════════════════════════════════════════\n');
  console.log(`  SIGNAL: N=${sigResults.length}`);
  console.log(`  Next-close closer to weekly VWAP: ${pct(sigReverted, sigResults.length)}`);
  console.log(`  (Live claim: "91% next-day reversion at 2σ")`);
  console.log(`  Next session reaches within 1σ: ${pct(sigWithin1S, sigResults.length)}`);
  console.log(`\n  CONTROL (|σ|<${CONTROL_SIGMA_MAX}): N=${ctrlResults.length}`);
  console.log(`  Next-close closer to VWAP (no signal): ${pct(ctrlReverted, ctrlResults.length)}`);
  console.log(`  Next session reaches within 1σ (no signal): ${pct(ctrlWithin1S, ctrlResults.length)}`);
  console.log(`\n  Edge above baseline: ${sigResults.length >= 20 ? ((sigReverted/sigResults.length - ctrlReverted/ctrlResults.length)*100).toFixed(1) + ' pct pts' : 'N/A'}`);

  // Sample signals
  if (sigResults.length > 0) {
    console.log('\n  Sample signals:');
    sigResults.slice(0, 10).forEach(s => {
      const o = s.outcome;
      console.log(`    ${s.day} σ=${s.sigma.toFixed(1)} close=${Math.round(s.todayClose)} wvwap=${Math.round(s.weeklyVwap)} → next: ${o.reverted ? 'REVERTED' : 'no reversion'} (${o.within1Sigma ? 'reached 1σ' : 'stayed extended'})`);
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  if (sigResults.length >= 20) {
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl)
      VALUES ($1, $2, 'WKLY_VWAP_BT', 'WEEKLY_VWAP_2SIG', $3, $4, $5, 0)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
        sample_size=EXCLUDED.sample_size, win_rate=EXCLUDED.win_rate, ev_per_trade=EXCLUDED.ev_per_trade
    `, [today, 365 * 4, sigResults.length, sigReverted / sigResults.length, 0]);

    if (ctrlResults.length >= 20) {
      await query(`
        INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl)
        VALUES ($1, $2, 'WKLY_VWAP_BT', 'WEEKLY_VWAP_CONTROL', $3, $4, 0, 0)
        ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
          sample_size=EXCLUDED.sample_size, win_rate=EXCLUDED.win_rate
      `, [today, 365 * 4, ctrlResults.length, ctrlReverted / ctrlResults.length]);
    }
    console.log(`\n  Written to performance_audit (signal_type='WKLY_VWAP_BT')`);
  } else {
    console.log(`\n  N=${sigResults.length} — below N=20 floor, not written to performance_audit`);
  }

  console.log('════════════════════════════════════════════════════\n');
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
