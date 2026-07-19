// Follow-up to scripts/backtest_post_stop_recovery.mjs: that script only tracked
// FAVORABLE excursion after a stop was hit, answering "does price eventually reach the
// original target." It could not tell you whether a WIDER stop would have actually
// survived to see that recovery, or whether price would have dug an even deeper hole
// (breaching the wider stop too, just at a bigger loss) before turning around.
//
// This script re-simulates each STOP_HIT trade from ENTRY with a wider stop, using the
// exact same bar-walk convention as the live resolution path (server/routes/acd.js
// resolveSetupsByPrice, ~line 299-332) -- same entry-price definition, same
// favorable/adverse formulas, same same-bar-conflict rule (stop wins if both trigger on
// the same bar) -- just with a different stop distance and a longer bar window so a
// slower-to-resolve wider-stop trade has room to actually resolve.
//
// Scoped to the setup_types that scripts/backtest_post_stop_recovery.mjs found with
// genuine (N>=20, >50%) recovery rates -- the ones actually worth testing. Low-recovery
// setups (C_STANDALONE_DOWN, BRACKET_BREAKOUT_LONG, etc.) are skipped deliberately;
// already confirmed those are structurally wrong trades, not stop-tightness issues.
//
// Candidate wider stops: 1.5x and 2x the CURRENT live optimal_stop for that setup_type
// -- disclosed, chosen multiples, not data-derived (same "state the assumption" spirit
// as the prior script's RECOVERY_WINDOW_BARS choice).
//
// Run: node scripts/backtest_wider_stop_ev.mjs
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { computeEvAtStopTarget, DEFAULT_DPP } from './update_optimal_stops.mjs';

const TARGET_SETUPS = [
  'CAM_S2_FADE_LONG', 'PD_IB_MID_FADE_LONG', 'PD_IB_MID_FADE_SHORT',
  'IB_MID_SCALP_FADE_LONG', 'OR_MID_AFTER_IB_FADE_LONG', 'PD_OR_MID_FADE_LONG',
  'PD_POC_FADE_LONG',
];
const WIDER_MULTIPLIERS = [1.5, 2.0];
const EXTRA_WINDOW_BARS = 240; // matches backtest_post_stop_recovery.mjs's RECOVERY_WINDOW_BARS

async function main() {
  console.log('Loading current OPTIMAL_STOP for target setups...');
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

  console.log('Loading STOP_HIT trades to re-simulate...');
  const stopHitRes = await query(`
    SELECT setup_type, fired_at, resolved_at, entry_zone_low::float as entry_zone_low,
      entry_zone_high::float as entry_zone_high, stop_level::float as stop_level, t1_level::float as t1_level,
      actual_pnl::float as actual_pnl
    FROM active_setups
    WHERE setup_type = ANY($1) AND resolution = 'STOP_HIT' AND mae_points IS NOT NULL AND mfe_points IS NOT NULL
      AND mae_points<=300 AND mfe_points<=300 AND resolved_at IS NOT NULL AND entry_zone_low IS NOT NULL AND t1_level IS NOT NULL
    ORDER BY fired_at ASC
  `, [TARGET_SETUPS]);
  const stopHitTrades = stopHitRes.rows;
  console.log(`${stopHitTrades.length} STOP_HIT trades across target setups.`);

  console.log('Loading NQ price bars...');
  const barsRes = await query(`SELECT ts, high::float as high, low::float as low FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low }));
  console.log(`${allBars.length} bars loaded.`);

  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }
  // Re-simulate one trade with a candidate wider stop, using the exact live formula/
  // same-bar-conflict convention (server/routes/acd.js ~line 305-330), extended window.
  function resimulate(trade, direction, widerStop) {
    const long = direction === 'LONG';
    const entry = trade.entry_zone_high ?? trade.entry_zone_low;
    const target = trade.t1_level;
    const startIdx = firstIndexAfter(new Date(trade.fired_at).getTime()); // strictly after, matches acd.js's `b.ts > row.fired_at`
    const origResolvedIdx = firstIndexAfter(new Date(trade.resolved_at).getTime());
    const endIdx = Math.min(allBars.length, origResolvedIdx + EXTRA_WINDOW_BARS);

    for (let i = startIdx; i < endIdx; i++) {
      const bar = allBars[i];
      const t1Hit = long ? bar.high >= target : bar.low <= target;
      const stopPrice = long ? entry - widerStop : entry + widerStop;
      const stopHit = long ? bar.low <= stopPrice : bar.high >= stopPrice;
      if (t1Hit && stopHit) return { resolution: 'STOP_HIT', distance: widerStop };
      if (t1Hit) return { resolution: 'TARGET_HIT', distance: Math.abs(target - entry) };
      if (stopHit) return { resolution: 'STOP_HIT', distance: widerStop };
    }
    return { resolution: 'UNRESOLVED', distance: null }; // ran out of extended window
  }

  const results = {};
  for (const setupType of TARGET_SETUPS) {
    const opt = optMap[setupType];
    const dpp = dppMap[setupType] || { stopDpp: DEFAULT_DPP, targetDpp: DEFAULT_DPP };
    if (!opt) { console.log(`Skipping ${setupType}, no OPTIMAL_STOP row.`); continue; }

    const allTrades = allByType[setupType] || [];
    const currentEv = computeEvAtStopTarget(allTrades, opt.stop, opt.target, dpp.stopDpp, dpp.targetDpp);

    const setupStopHits = stopHitTrades.filter(t => t.setup_type === setupType);
    results[setupType] = { currentStop: opt.stop, currentTarget: opt.target, currentEv: +currentEv.toFixed(2), n: allTrades.length, nStopHit: setupStopHits.length, wider: {} };

    for (const mult of WIDER_MULTIPLIERS) {
      const widerStop = +(opt.stop * mult).toFixed(1);
      let unresolvedCount = 0;
      let pnlSum = 0;
      // Trades whose mae_points never reached the OLD (tighter) stop can't reach the
      // wider one either -- unaffected by widening. Same boundary convention as
      // computeEvAtStopTarget (mae > stop, not >=) and same fallback formula (target
      // hit -> target*dpp, else actual_pnl) so this stays a true apples-to-apples
      // comparison against currentEv, not a shortcut that quietly changes the baseline.
      const unaffected = allTrades.filter(t => !(t.mae_points > opt.stop));
      for (const t of unaffected) {
        if (t.mfe_points >= opt.target) pnlSum += opt.target * dpp.targetDpp;
        else pnlSum += t.actual_pnl;
      }

      for (const t of setupStopHits) {
        const direction = inferDirection(t.setup_type);
        if (!direction) { unresolvedCount++; continue; }
        const sim = resimulate(t, direction, widerStop);
        if (sim.resolution === 'TARGET_HIT') pnlSum += opt.target * dpp.targetDpp;
        else if (sim.resolution === 'STOP_HIT') pnlSum -= widerStop * dpp.stopDpp;
        else { unresolvedCount++; pnlSum += t.actual_pnl; } // fallback: keep original outcome if we can't tell
      }

      const totalN = unaffected.length + setupStopHits.length;
      const widerEv = totalN ? pnlSum / totalN : null;
      results[setupType].wider[`${mult}x`] = {
        widerStopPts: widerStop, ev: widerEv ? +widerEv.toFixed(2) : null,
        evDiff: widerEv ? +(widerEv - currentEv).toFixed(2) : null, unresolvedCount,
      };
    }
    console.log(`${setupType}: current EV=$${currentEv.toFixed(2)} (stop=${opt.stop}) | ` +
      WIDER_MULTIPLIERS.map(m => `${m}x (stop=${(opt.stop*m).toFixed(1)}): EV=$${results[setupType].wider[`${m}x`].ev} (${results[setupType].wider[`${m}x`].evDiff >= 0 ? '+' : ''}${results[setupType].wider[`${m}x`].evDiff})`).join(' | '));
  }

  console.log('\nFull results:', JSON.stringify(results, null, 2));

  const today = (await query(`SELECT CURRENT_DATE::text as d`)).rows[0].d;
  for (const [setupType, r] of Object.entries(results)) {
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, notes)
      VALUES ($1, 0, 'WIDER_STOP_EV_TEST', $2, $3, $4, $5)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
        SET sample_size=EXCLUDED.sample_size, ev_per_trade=EXCLUDED.ev_per_trade, notes=EXCLUDED.notes
    `, [today, setupType, r.n, r.currentEv, JSON.stringify(r)]);
  }
  console.log(`Persisted ${Object.keys(results).length} rows to performance_audit (signal_type='WIDER_STOP_EV_TEST').`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
