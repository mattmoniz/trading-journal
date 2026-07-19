// Corrected Layer 1 target calibration (see docs/TARGET_CALIBRATION_SPEC.md for the full
// design conversation this came out of). Replaces the two flaws in the LIVE
// sweepOptimalTarget() (scripts/update_optimal_stops.mjs):
//
//   1. It picks from a fixed point grid (TARGET_SWEEP = [10..150]) capped at p75_mfe --
//      and mfe_points is truncated the instant the ORIGINAL target resolves, so the live
//      calibration has never seen genuine post-target continuation (OPEN_DECISION
//      optimal_target_blind_to_post_resolution_continuation, 2026-07-19).
//   2. It's chronologically order-blind: computeEvAtStopTarget checks "did MAE exceed
//      stop" and "did MFE reach target" as two independent facts with no notion of which
//      happened first. Already a documented issue for stops (p90 was found to "rescue"
//      IB_BEARISH trades into fake wins this exact way) -- widening the target range
//      without fixing this would make it worse, since holding a trade open longer to
//      chase a bigger target also exposes it to bigger real adverse risk the old,
//      still-truncated mae_points can't see.
//
// Fix: candidate targets are drawn from PERCENTILES of the real, untruncated MFE
// (walked fresh from ENTRY, not read from the truncated column) -- data-derived, not a
// hardcoded list. Each candidate is scored via genuine bar-by-bar chronological
// resimulation from entry (same method backtest_wider_target_ev.mjs already validated),
// not the order-blind independent-percentile shortcut. Stop is held FIXED at the current
// live OPTIMAL_STOP value -- this script only re-derives the target.
//
// Writes to signal_type='TARGET_SWEEP_V2' -- a NEW signal_type, deliberately NOT
// overwriting live OPTIMAL_STOP. This is a comparison/backtest result pending a promotion
// decision, per this codebase's standing "nothing wired live without a deliberate
// decision" convention -- same caveat as every other finding from this thread.
//
// Run: node scripts/backtest_target_sweep_v2.mjs
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { DEFAULT_DPP } from './update_optimal_stops.mjs';

const WALK_WINDOW_BARS = 390; // ~6.5hr from entry -- bounded like the existing mae/mfe<=300pt convention elsewhere in this codebase, generous enough to capture same-session continuation without spilling unboundedly into future sessions.
const CANDIDATE_PERCENTILES = [0.40, 0.50, 0.60, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95];
const MIN_N = 20;

function percentile(sortedArr, p) {
  const idx = Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p));
  return sortedArr[idx];
}

async function main() {
  console.log('Loading current live OPTIMAL_STOP (stop held fixed, only re-deriving target)...');
  const optRes = await query(`
    SELECT DISTINCT ON (signal_name) signal_name as setup_type, optimal_stop, optimal_target
    FROM performance_audit WHERE signal_type='OPTIMAL_STOP'
    ORDER BY signal_name, run_date DESC
  `);
  const optMap = {};
  for (const r of optRes.rows) optMap[r.setup_type] = { stop: parseFloat(r.optimal_stop), oldTarget: parseFloat(r.optimal_target) };
  console.log(`${Object.keys(optMap).length} setup_types with a live OPTIMAL_STOP row.`);

  console.log('Loading dpp per setup_type...');
  const dppRes = await query(`
    SELECT setup_type,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(actual_pnl) / NULLIF(ABS(entry_zone_low - stop_level), 0))
        FILTER (WHERE resolution = 'STOP_HIT') AS dpp, COUNT(*) FILTER (WHERE resolution IN ('STOP_HIT','TARGET_HIT')) as n
    FROM active_setups WHERE entry_zone_low IS NOT NULL AND stop_level IS NOT NULL
    GROUP BY setup_type
  `);
  const dppMap = {};
  for (const r of dppRes.rows) dppMap[r.setup_type] = (+r.n >= 20 && r.dpp) ? +r.dpp : DEFAULT_DPP;

  console.log('Loading eligible trades (entry+stop+resolution known, clean mae/mfe)...');
  const tradesRes = await query(`
    SELECT setup_type, fired_at, resolved_at, entry_zone_low::float as entry_zone_low,
      entry_zone_high::float as entry_zone_high, stop_level::float as stop_level,
      t1_level::float as t1_level, actual_pnl::float as actual_pnl, resolution
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED') AND mae_points IS NOT NULL AND mfe_points IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300 AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL
    ORDER BY fired_at ASC
  `);
  const allTrades = tradesRes.rows;
  console.log(`${allTrades.length} eligible trades.`);

  const byType = {};
  for (const t of allTrades) (byType[t.setup_type] ||= []).push(t);

  console.log('Loading NQ price bars...');
  const barsRes = await query(`SELECT ts, high::float as high, low::float as low FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low }));
  console.log(`${allBars.length} bars loaded.`);

  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  const results = {};
  const setupTypes = Object.keys(byType).filter(st => optMap[st] && byType[st].length >= MIN_N);
  console.log(`Sweeping ${setupTypes.length} setup_types with N>=${MIN_N} and a live stop...`);

  for (const setupType of setupTypes) {
    const trades = byType[setupType];
    const stop = optMap[setupType].stop;
    const dpp = dppMap[setupType] || DEFAULT_DPP;
    const direction = inferDirection(setupType);
    if (!direction) continue;
    const long = direction === 'LONG';

    // Pass 1: walk from ENTRY (not original resolution) through a bounded window, get
    // the TRUE max favorable excursion per trade -- used both to build the candidate
    // grid and as the ground truth for chronological outcome determination below.
    const walked = [];
    for (const t of trades) {
      const entry = t.entry_zone_high ?? t.entry_zone_low;
      const startIdx = firstIndexAfter(new Date(t.fired_at).getTime());
      const endIdx = Math.min(allBars.length, startIdx + WALK_WINDOW_BARS);
      if (startIdx >= endIdx) continue;
      walked.push({ trade: t, entry, startIdx, endIdx });
    }
    if (walked.length < MIN_N) continue;

    // Candidate targets: percentiles of the real true-MFE distribution for this setup,
    // data-derived -- not a fixed point list.
    const trueMfes = walked.map(w => {
      let maxFav = -Infinity;
      for (let i = w.startIdx; i < w.endIdx; i++) {
        const bar = allBars[i];
        const fav = long ? bar.high - w.entry : w.entry - bar.low;
        if (fav > maxFav) maxFav = fav;
      }
      return maxFav;
    }).filter(v => v > 0).sort((a, b) => a - b);
    const candidates = [...new Set(CANDIDATE_PERCENTILES.map(p => +percentile(trueMfes, p).toFixed(1)))].filter(c => c > 0);

    // Pass 2: for each candidate target, chronologically resimulate every trade from
    // entry -- first-touch of candidate target vs. the FIXED live stop, in true bar order.
    let best = null;
    const candidateResults = [];
    for (const T of candidates) {
      let pnlSum = 0, targetHits = 0, stopHits = 0, unresolved = 0;
      for (const w of walked) {
        const t = w.trade;
        const targetPrice = long ? w.entry + T : w.entry - T;
        const stopPrice = long ? w.entry - stop : w.entry + stop;
        let outcome = null;
        for (let i = w.startIdx; i < w.endIdx; i++) {
          const bar = allBars[i];
          const targetHit = long ? bar.high >= targetPrice : bar.low <= targetPrice;
          const stopHit = long ? bar.low <= stopPrice : bar.high >= stopPrice;
          if (targetHit && stopHit) { outcome = 'STOP'; break; } // conservative same-bar-conflict convention
          if (targetHit) { outcome = 'TARGET'; break; }
          if (stopHit) { outcome = 'STOP'; break; }
        }
        if (outcome === 'TARGET') { pnlSum += T * dpp; targetHits++; }
        else if (outcome === 'STOP') { pnlSum -= stop * dpp; stopHits++; }
        else { pnlSum += t.actual_pnl; unresolved++; } // fell through the window -- fallback to what actually happened, same convention as computeEvAtStopTarget
      }
      const n = walked.length;
      const ev = pnlSum / n;
      candidateResults.push({ target: T, ev: +ev.toFixed(2), n, targetHits, stopHits, unresolved, unresolvedPct: +(100 * unresolved / n).toFixed(1) });
      if (!best || ev > best.ev) best = { target: T, ev };
    }

    const oldEv = candidateResults.length ? null : null; // computed below via old target if present in candidates
    results[setupType] = {
      stop, n: walked.length, oldTarget: optMap[setupType].oldTarget,
      candidates: candidateResults, bestTarget: best.target, bestEv: +best.ev.toFixed(2),
    };
    console.log(`${setupType}: stop=${stop} oldTarget=${optMap[setupType].oldTarget} -> NEW bestTarget=${best.target} EV=$${best.ev.toFixed(2)} (N=${walked.length}, candidates tested: ${candidates.join(',')})`);
  }

  const today = (await query(`SELECT CURRENT_DATE::text as d`)).rows[0].d;
  for (const [setupType, r] of Object.entries(results)) {
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, notes)
      VALUES ($1, 0, 'TARGET_SWEEP_V2', $2, $3, $4, $5)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
        SET sample_size=EXCLUDED.sample_size, ev_per_trade=EXCLUDED.ev_per_trade, notes=EXCLUDED.notes
    `, [today, setupType, r.n, r.bestEv, JSON.stringify(r)]);
  }
  console.log(`\nPersisted ${Object.keys(results).length} rows to performance_audit (signal_type='TARGET_SWEEP_V2').`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
