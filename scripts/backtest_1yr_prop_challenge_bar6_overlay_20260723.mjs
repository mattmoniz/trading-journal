// Answers the user's direct question (2026-07-23): "where is our walkthrough with these new
// findings" -- applies the confirmed bar-6 findings (RECOVERING/DETERIORATING split,
// bar6_early_exit_deteriorating_confirmed_recovering_partial's full-exit rule for RECOVERING,
// recovering_exit_predictor_target_distance_confirmatory_pass's frozen targetDistFraction<0.873
// exit rule) as a SIMULATED OVERLAY on top of the flagship 1-year Globex-inclusive prop-challenge
// walkthrough (backtest_1yr_globex_inclusive_prop_challenge_20260720.mjs), CURRENT_VALIDATED_ROSTER
// scenario, Globex included, DLL=$400 -- the single number that script calls out as its headline row.
//
// Deliberately does NOT change roster/eligibility (which setup_types trade at all) -- that's a
// separate question from "how would the bar-6 rule change the outcome of trades already being
// taken." Isolating one variable at a time, matching this session's own confound-checklist
// discipline (CLAUDE.md's "Confound checklist for any new comparison-style backtest").
//
// This is a BACKTEST OVERLAY, not a live-wiring decision or a claim the number is achievable going
// forward -- both underlying rules are still explicitly gated behind OPEN_DECISION
// validate_target_distance_predictor_on_live_data / identify_recovering_early_exit_setup_types,
// each waiting on real (non-BACKFILL) forward data (only 2 real touches exist as of 2026-07-23).
// This script answers "what would the walkthrough's bottom line have looked like IF these rules had
// been live all year" -- a projection onto real historical data, same caveat class as the flagship
// script's own RTH leg (mostly BACKFILL-origin).

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import fs from 'fs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const FROZEN_CUTOFF = 0.873; // recovering_exit_predictor_target_distance_confirmatory_pass
const DLL = 400;

const EXCLUDED = new Set(['OR_HIGH', 'OR_LOW', 'IB_HIGH', 'IB_LOW', 'IB_MID_SCALP', 'IB_MID', 'OR_MID',
  'OR_MID_AFTER_IB', 'ONH', 'ONL', '3M_VAH', '3M_VAL', '3M_POC', 'RTH_VWAP', 'WEEKLY_VWAP', 'MONTHLY_VWAP',
  'DAILY_OPEN', 'WEEKLY_OPEN', 'MONTHLY_OPEN']);

async function main() {
  const maxDateRow = await query(`SELECT MAX(trade_date)::text as max_date FROM active_setups`);
  const maxDate = maxDateRow.rows[0].max_date;

  const daysQ = await query(`
    SELECT DISTINCT trade_date::text as trade_date FROM active_setups
    WHERE trade_date >= $1::date - interval '365 days' AND trade_date <= $1::date
    ORDER BY trade_date ASC
  `, [maxDate]);
  const tradingDays = daysQ.rows.map(r => r.trade_date);
  const startDateStr = tradingDays[0];
  console.log(`Window: ${startDateStr} to ${maxDate} (${tradingDays.length} days)`);

  console.log('Loading CURRENT_VALIDATED_ROSTER...');
  const rosterQ = await query(`
    SELECT DISTINCT ON (signal_name) signal_name as setup_type, recommendation
    FROM performance_audit WHERE signal_type = 'SETUP_STATUS'
    ORDER BY signal_name, run_date DESC
  `);
  const currentRoster = new Set();
  for (const r of rosterQ.rows) {
    if (r.recommendation !== 'SUPPRESS' && r.recommendation !== 'THIN_N') currentRoster.add(r.setup_type);
  }

  console.log('Loading RTH trades with bar-level fields...');
  const tradesQ = await query(`
    SELECT trade_date::text as trade_date, fired_at, setup_type, actual_pnl::float as actual_pnl,
           size_multiplier::float as size_multiplier, resolution,
           entry_zone_low::float, entry_zone_high::float, stop_level::float, t1_level::float,
           mae_points::float as mae_points, mfe_points::float as mfe_points
    FROM active_setups
    WHERE trade_date >= $1::date - interval '365 days' AND trade_date <= $1::date
      AND actual_pnl IS NOT NULL AND resolution IN ('TARGET_HIT', 'STOP_HIT', 'TIME_EXPIRED')
      AND (mae_points IS NULL OR mae_points <= 300) AND (mfe_points IS NULL OR mfe_points <= 300)
      AND setup_type = ANY($2::text[])
    ORDER BY trade_date ASC, fired_at ASC
  `, [maxDate, [...currentRoster]]);
  const trades = tradesQ.rows;
  console.log(`${trades.length} roster-eligible RTH trades in window.`);

  console.log('Loading bars for bar-6 recomputation...');
  const barsRes = await query(`
    SELECT ts, ts::date::text as d, high::float as high, low::float as low, close::float as close
    FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date - interval '366 days'
    ORDER BY ts ASC
  `, [maxDate]);
  const allBars = barsRes.rows.map(b => ({ ...b, ts: new Date(b.ts).getTime() }));
  const barsByDate = new Map();
  for (const b of allBars) {
    if (!barsByDate.has(b.d)) barsByDate.set(b.d, []);
    barsByDate.get(b.d).push(b);
  }

  let recomputed = 0, tooShort = 0, resolvedEarly = 0;
  for (const t of trades) {
    t.gatedPnl = t.actual_pnl; // default: unchanged unless a bar-6 rule actually applies
    if (t.entry_zone_low == null || t.stop_level == null || t.t1_level == null) continue;
    const direction = directionFromType(t.setup_type);
    if (!direction) continue;
    const dayBars = barsByDate.get(t.trade_date);
    if (!dayBars || dayBars.length < 25) { tooShort++; continue; }

    const firedAtMs = new Date(t.fired_at).getTime();
    let entryIdx = -1;
    for (let i = dayBars.length - 1; i >= 0; i--) { if (dayBars[i].ts <= firedAtMs) { entryIdx = i; break; } }
    if (entryIdx < 0) continue;

    const forwardBars = dayBars.slice(entryIdx);
    let resolutionBarIdx = -1;
    for (let i = 0; i < forwardBars.length; i++) {
      const bar = forwardBars[i];
      const stopHit = direction === 'LONG' ? bar.low <= t.stop_level : bar.high >= t.stop_level;
      const targetHit = direction === 'LONG' ? bar.high >= t.t1_level : bar.low <= t.t1_level;
      if (stopHit || targetHit) { resolutionBarIdx = i; break; }
    }
    if (resolutionBarIdx === -1) resolutionBarIdx = forwardBars.length - 1;
    if (resolutionBarIdx < 6 || forwardBars.length < 7) { resolvedEarly++; continue; } // rule never triggers before bar 6

    const b0_6 = forwardBars.slice(0, 7);
    let worstPrice = direction === 'LONG' ? b0_6[0].low : b0_6[0].high;
    let worstBarIdx = 0;
    for (let i = 0; i <= 6; i++) {
      if (direction === 'LONG' && b0_6[i].low < worstPrice) { worstPrice = b0_6[i].low; worstBarIdx = i; }
      if (direction === 'SHORT' && b0_6[i].high > worstPrice) { worstPrice = b0_6[i].high; worstBarIdx = i; }
    }
    const status = worstBarIdx <= 2 ? 'RECOVERING' : 'DETERIORATING';
    if (status !== 'RECOVERING') continue; // confirmed rule only applies to RECOVERING touches

    const hi = t.entry_zone_high != null ? t.entry_zone_high : t.entry_zone_low;
    const entry = (t.entry_zone_low + hi) / 2;
    const bar6Close = b0_6[6].close;
    const pointsAtBar6 = direction === 'LONG' ? (bar6Close - entry) : (entry - bar6Close);
    const pnlAtBar6 = pointsAtBar6 * PNL_PER_POINT - COMMISSION;

    const distToTarget = direction === 'LONG' ? (t.t1_level - bar6Close) : (bar6Close - t.t1_level);
    const distEntryToTarget = direction === 'LONG' ? (t.t1_level - entry) : (entry - t.t1_level);
    const targetDistFraction = distEntryToTarget !== 0 ? (distToTarget / distEntryToTarget) : 0;

    if (targetDistFraction < FROZEN_CUTOFF) {
      t.gatedPnl = pnlAtBar6;
      recomputed++;
    }
  }
  console.log(`Rule changed outcome on ${recomputed} trades (${resolvedEarly} resolved before bar 6, unaffected; ${tooShort} skipped for thin bar data).`);

  // Re-run the exact same day-loop DLL simulation twice: baseline (actual_pnl) vs overlay (gatedPnl).
  function simulate(pnlField) {
    const stats = { totalPnl: 0, totalTrades: 0, wins: 0, lockoutDays: 0, maxDrawdown: 0, peakPnl: 0 };
    const tradesByDate = new Map();
    for (const t of trades) {
      if (!tradesByDate.has(t.trade_date)) tradesByDate.set(t.trade_date, []);
      tradesByDate.get(t.trade_date).push(t);
    }
    for (const d of tradingDays) {
      const dayTrades = tradesByDate.get(d) || [];
      let dayPnl = 0, isLocked = false;
      for (const t of dayTrades) {
        if (isLocked) continue;
        const sizedPnl = t[pnlField] * (t.size_multiplier || 1.0);
        dayPnl += sizedPnl;
        stats.totalPnl += sizedPnl;
        stats.totalTrades++;
        if (sizedPnl > 0) stats.wins++;
        if (stats.totalPnl > stats.peakPnl) stats.peakPnl = stats.totalPnl;
        const dd = stats.peakPnl - stats.totalPnl;
        if (dd > stats.maxDrawdown) stats.maxDrawdown = dd;
        if (dayPnl <= -DLL) { isLocked = true; stats.lockoutDays++; }
      }
    }
    return stats;
  }

  const baseline = simulate('actual_pnl');
  const overlay = simulate('gatedPnl');

  let report = `# 1-Year Prop Challenge -- Bar-6 Exit Rule Overlay\n`;
  report += `**Window:** ${startDateStr} to ${maxDate} (${tradingDays.length} trading days) | CURRENT_VALIDATED_ROSTER | DLL=$${DLL} | RTH leg only (Globex leg unaffected, no bar-6 mechanism applies there)\n\n`;
  report += `> [!WARNING]\n> This is a projection onto historical (mostly BACKFILL-origin) data using a rule confirmed via train/test/replication but NOT YET validated on live forward data (only 2 real bar6_checkpoint touches exist as of 2026-07-23). Treat as "what this would have looked like if the rule had been live," not a validated forward expectation.\n\n`;
  report += `Rule changed the outcome of **${recomputed} of ${trades.length}** roster-eligible RTH trades (${(recomputed / trades.length * 100).toFixed(1)}%) -- exactly the RECOVERING touches with targetDistFraction<${FROZEN_CUTOFF} at bar 6.\n\n`;
  report += `| Run | Total P&L | Trades | Win Rate | Max Drawdown | Lockout Days |\n|---|---|---|---|---|---|\n`;
  report += `| Baseline (actual outcomes) | $${baseline.totalPnl.toFixed(2)} | ${baseline.totalTrades} | ${(baseline.wins / baseline.totalTrades * 100).toFixed(1)}% | $${baseline.maxDrawdown.toFixed(2)} | ${baseline.lockoutDays} |\n`;
  report += `| + Bar-6 exit rule overlay | $${overlay.totalPnl.toFixed(2)} | ${overlay.totalTrades} | ${(overlay.wins / overlay.totalTrades * 100).toFixed(1)}% | $${overlay.maxDrawdown.toFixed(2)} | ${overlay.lockoutDays} |\n`;
  report += `\n**Net effect: $${(overlay.totalPnl - baseline.totalPnl).toFixed(2)} over the window (${((overlay.totalPnl - baseline.totalPnl) / recomputed).toFixed(2)}/affected trade).**\n`;

  fs.writeFileSync('scratch/bar6_overlay_prop_challenge_RESULTS.md', report);
  console.log(report);
  console.log('Written to scratch/bar6_overlay_prop_challenge_RESULTS.md');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
