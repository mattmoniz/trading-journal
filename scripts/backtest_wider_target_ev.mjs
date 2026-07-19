// Mirror of scripts/backtest_wider_stop_ev.mjs, for targets: backtest_post_target_runup.mjs
// found some TARGET_HIT setups show a genuinely clean "favorable extends BEFORE any
// comparable give-back" pattern (up to 65% favorable-first) -- unlike the stop side,
// where digging deeper first was the dominant pattern. This tests whether a WIDER
// target on those specific setups is actually a net EV win, not just a "run further"
// observation -- re-simulating from entry with a wider target and the SAME original
// stop, so a trade that currently wins can also flip to a LOSS if price reverses hard
// before reaching the new, further target. That's the real risk of widening targets,
// same as the real risk of widening stops was "dig deeper before recovering."
//
// Scoped to the TARGET_HIT setups with the highest favorable-first rates from
// backtest_post_resolution_sequence.mjs (N>=20, need real signal, not the OR_LOW_FADE_SHORT
// N=20 edge case -- kept the 7 with the most robust samples).
//
// Candidate wider targets: 1.5x and 2x current optimal_target, same disclosed-multiple
// convention as the stop-side test.
//
// Run: node scripts/backtest_wider_target_ev.mjs
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { computeEvAtStopTarget, DEFAULT_DPP } from './update_optimal_stops.mjs';

const TARGET_SETUPS = [
  'PD_SESSION_MID_FADE_SHORT', 'CAM_R1_FADE_SHORT', 'WEEKLY_VWAP_FADE_SHORT',
  'WPP_FADE_LONG', 'FLOOR_PIVOT_FADE_SHORT', 'PD_OR_MID_FADE_SHORT', 'CAM_R2_FADE_SHORT',
];
const WIDER_MULTIPLIERS = [1.5, 2.0];
const EXTRA_WINDOW_BARS = 240;

async function main() {
  console.log('Loading current OPTIMAL_STOP/TARGET...');
  const optRes = await query(`
    SELECT DISTINCT ON (signal_name) signal_name as setup_type, optimal_stop, optimal_target
    FROM performance_audit WHERE signal_type='OPTIMAL_STOP' AND signal_name = ANY($1)
    ORDER BY signal_name, run_date DESC
  `, [TARGET_SETUPS]);
  const optMap = {};
  for (const r of optRes.rows) optMap[r.setup_type] = { stop: parseFloat(r.optimal_stop), target: parseFloat(r.optimal_target) };
  console.log(optMap);

  console.log('Loading dpp per setup_type...');
  const dppRes = await query(`
    SELECT setup_type,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(actual_pnl) / NULLIF(ABS(entry_zone_low - stop_level), 0))
        FILTER (WHERE resolution = 'STOP_HIT') AS stop_dpp, COUNT(*) FILTER (WHERE resolution='STOP_HIT') as n_stop,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(actual_pnl) / NULLIF(ABS(t1_level - entry_zone_low), 0))
        FILTER (WHERE resolution = 'TARGET_HIT') AS target_dpp, COUNT(*) FILTER (WHERE resolution='TARGET_HIT') as n_target
    FROM active_setups WHERE setup_type = ANY($1) AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
    GROUP BY setup_type
  `, [TARGET_SETUPS]);
  const dppMap = {};
  for (const r of dppRes.rows) {
    dppMap[r.setup_type] = {
      stopDpp: (+r.n_stop >= 20 && r.stop_dpp) ? +r.stop_dpp : DEFAULT_DPP,
      targetDpp: (+r.n_target >= 20 && r.target_dpp) ? +r.target_dpp : DEFAULT_DPP,
    };
  }

  console.log('Loading ALL trades (target setups, clean MAE/MFE) for baseline EV...');
  const allTradesRes = await query(`
    SELECT setup_type, mae_points::float as mae_points, mfe_points::float as mfe_points, actual_pnl::float as actual_pnl
    FROM active_setups WHERE setup_type = ANY($1) AND resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED')
      AND mae_points IS NOT NULL AND mfe_points IS NOT NULL AND mae_points<=300 AND mfe_points<=300
  `, [TARGET_SETUPS]);
  const allByType = {};
  for (const t of allTradesRes.rows) (allByType[t.setup_type] ||= []).push(t);

  console.log('Loading TARGET_HIT trades to re-simulate...');
  const targetHitRes = await query(`
    SELECT setup_type, fired_at, resolved_at, entry_zone_low::float as entry_zone_low,
      entry_zone_high::float as entry_zone_high, stop_level::float as stop_level, t1_level::float as t1_level,
      actual_pnl::float as actual_pnl
    FROM active_setups
    WHERE setup_type = ANY($1) AND resolution = 'TARGET_HIT' AND mae_points IS NOT NULL AND mfe_points IS NOT NULL
      AND mae_points<=300 AND mfe_points<=300 AND resolved_at IS NOT NULL AND entry_zone_low IS NOT NULL AND t1_level IS NOT NULL
    ORDER BY fired_at ASC
  `, [TARGET_SETUPS]);
  const targetHitTrades = targetHitRes.rows;
  console.log(`${targetHitTrades.length} TARGET_HIT trades across target setups.`);

  console.log('Loading NQ price bars...');
  const barsRes = await query(`SELECT ts, high::float as high, low::float as low FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low }));
  console.log(`${allBars.length} bars loaded.`);

  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  // Re-simulate a currently-TARGET_HIT trade with a WIDER target, SAME original stop --
  // does it reach the further target, or reverse and hit the original stop first
  // (a win flipping to a loss), or run out of window.
  function resimulate(trade, direction, widerTarget) {
    const long = direction === 'LONG';
    const entry = trade.entry_zone_high ?? trade.entry_zone_low;
    const originalStop = trade.stop_level;
    const widerTargetPrice = long ? entry + widerTarget : entry - widerTarget;
    const startIdx = firstIndexAfter(new Date(trade.fired_at).getTime());
    const origResolvedIdx = firstIndexAfter(new Date(trade.resolved_at).getTime());
    const endIdx = Math.min(allBars.length, origResolvedIdx + EXTRA_WINDOW_BARS);

    for (let i = startIdx; i < endIdx; i++) {
      const bar = allBars[i];
      const widerTargetHit = long ? bar.high >= widerTargetPrice : bar.low <= widerTargetPrice;
      const stopHit = long ? bar.low <= originalStop : bar.high >= originalStop;
      if (widerTargetHit && stopHit) return { resolution: 'STOP_HIT' }; // conservative, same-bar-conflict convention
      if (widerTargetHit) return { resolution: 'TARGET_HIT' };
      if (stopHit) return { resolution: 'STOP_HIT' };
    }
    return { resolution: 'UNRESOLVED' };
  }

  const results = {};
  for (const setupType of TARGET_SETUPS) {
    const opt = optMap[setupType];
    const dpp = dppMap[setupType] || { stopDpp: DEFAULT_DPP, targetDpp: DEFAULT_DPP };
    if (!opt) { console.log(`Skipping ${setupType}, no OPTIMAL_STOP row.`); continue; }

    const allTrades = allByType[setupType] || [];
    const currentEv = computeEvAtStopTarget(allTrades, opt.stop, opt.target, dpp.stopDpp, dpp.targetDpp);

    const setupTargetHits = targetHitTrades.filter(t => t.setup_type === setupType);
    results[setupType] = { currentStop: opt.stop, currentTarget: opt.target, currentEv: +currentEv.toFixed(2), n: allTrades.length, nTargetHit: setupTargetHits.length, wider: {} };

    for (const mult of WIDER_MULTIPLIERS) {
      const widerTarget = +(opt.target * mult).toFixed(1);
      let flippedToLoss = 0, stillWon = 0, unresolvedCount = 0;
      let pnlSum = 0;
      // Trades whose mfe_points never reached the OLD target can't reach a wider one
      // either -- unaffected, same treatment as computeEvAtStopTarget's own fallback.
      const unaffected = allTrades.filter(t => (t.mfe_points < opt.target));
      for (const t of unaffected) {
        if (t.mae_points > opt.stop) pnlSum -= opt.stop * dpp.stopDpp;
        else pnlSum += t.actual_pnl;
      }

      for (const t of setupTargetHits) {
        const direction = inferDirection(t.setup_type);
        if (!direction) { unresolvedCount++; continue; }
        const sim = resimulate(t, direction, widerTarget);
        if (sim.resolution === 'TARGET_HIT') { pnlSum += widerTarget * dpp.targetDpp; stillWon++; }
        else if (sim.resolution === 'STOP_HIT') { pnlSum -= opt.stop * dpp.stopDpp; flippedToLoss++; }
        else { unresolvedCount++; pnlSum += t.actual_pnl; }
      }

      const totalN = unaffected.length + setupTargetHits.length;
      const widerEv = totalN ? pnlSum / totalN : null;
      results[setupType].wider[`${mult}x`] = {
        widerTargetPts: widerTarget, ev: widerEv ? +widerEv.toFixed(2) : null,
        evDiff: widerEv ? +(widerEv - currentEv).toFixed(2) : null,
        flippedToLoss, stillWon, unresolvedCount,
      };
    }
    console.log(`${setupType}: current EV=$${currentEv.toFixed(2)} (target=${opt.target}) | ` +
      WIDER_MULTIPLIERS.map(m => `${m}x (target=${(opt.target*m).toFixed(1)}): EV=$${results[setupType].wider[`${m}x`].ev} (${results[setupType].wider[`${m}x`].evDiff >= 0 ? '+' : ''}${results[setupType].wider[`${m}x`].evDiff}, flipped-to-loss=${results[setupType].wider[`${m}x`].flippedToLoss})`).join(' | '));
  }

  console.log('\nFull results:', JSON.stringify(results, null, 2));

  const today = (await query(`SELECT CURRENT_DATE::text as d`)).rows[0].d;
  for (const [setupType, r] of Object.entries(results)) {
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, notes)
      VALUES ($1, 0, 'WIDER_TARGET_EV_TEST', $2, $3, $4, $5)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
        SET sample_size=EXCLUDED.sample_size, ev_per_trade=EXCLUDED.ev_per_trade, notes=EXCLUDED.notes
    `, [today, setupType, r.n, r.currentEv, JSON.stringify(r)]);
  }
  console.log(`Persisted ${Object.keys(results).length} rows to performance_audit (signal_type='WIDER_TARGET_EV_TEST').`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
