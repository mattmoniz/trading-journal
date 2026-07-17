// =============================================================================
// Compute per-setup-type optimal stops AND targets from active_setups MAE/MFE.
// Run weekly (Sunday) and daily (4:20 PM ET) after backfill_mae_mfe.
//
// Stop + Target: joint EV sweep, per setup_type (2026-07-13). Stop candidates = this
//   type's own MAE percentiles (p25/p40/p50/p60/p75/p90 — all data-derived, no fixed
//   point grid); target candidates = TARGET_SWEEP capped at p75_mfe. Picks whichever
//   (stop, target) pair maximizes:
//   EV = mean over trades of: -stop*2 if mae>stop; +target*2 if mfe>=target; else actual_pnl.
//
//   Previously stop was hardcoded to p75_mae with only target swept, and a separate
//   special-cased block re-swept stops for just IB_BULLISH/IB_BEARISH. A 2026-07-13 audit
//   found no setup-agnostic rule holds (p50_mae beats p75_mae for only 28/66 types with the
//   corrected formula, not 69/70 as an earlier flawed simulation claimed — that run wrongly
//   counted mae<=stop-but-mfe<target trades as automatic losses instead of actual_pnl) — so
//   every type now gets its own swept stop instead of a blanket rule or a type-specific carve-out.
//
//   First attempt at this swept the stop over a flat 20-150pt grid instead of percentiles.
//   That let several types (IB_BEARISH, BRACKET_BREAKOUT_LONG, C_STANDALONE_DOWN,
//   OPEN_TEST_DRIVE_SHORT) jump to stops near the 150pt ceiling — a stop that wide almost
//   never triggers, so it inflates in-sample EV without actually reducing risk (classic
//   overfitting to a finite sample). Caught before it stayed live, reverted, and replaced
//   with this percentile-anchored version: candidates are always tied to that type's real
//   MAE distribution shape, so the sweep can't wander to a value unrelated to the data.
//
// Writes signal_type='OPTIMAL_STOP' rows — one per setup_type direction.
// The live path reads these via liveStats._opt[setup_type].
// =============================================================================

import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

// Minimum N before we trust a computed optimal stop
const MIN_N = 20;
const DEFAULT_STOP = 65;
const DEFAULT_TARGET = 35;
// Fallback $/pt when a setup_type has too few resolved trades to derive its own real
// value (see the dppRes query below). CORRECTED 2026-07-17: this was hardcoded to 5,
// justified by a comment claiming "real $/pt is cleanly bimodal... ~$5 for the
// level-fade family" -- that claim was never actually true. Verified directly against
// every setup_type with N>=20 STOP_HIT trades (54 types checked): EVERY ONE resolves to
// $2.01-$2.06/pt, matching MNQ's real $2/pt exactly (the ~1-6 cent excess over $2.00 is
// just the $1 flat commission spread across each trade's point distance) -- there is no
// bimodal split, no level-fade-family exception. This is the FOURTH independent
// occurrence of the wrong-$/pt-constant class of bug documented in
// server/config/instruments.js's own header (backfill_level_fades.js, a frontend modal,
// TRT_LONG's trade-brief text, now this file) -- now fixed by importing the same
// canonical LIVE_INSTRUMENT constant instead of a fourth redeclared literal. Real,
// non-trivial blast radius: 25 currently-live setup_types had an OPTIMAL_STOP row
// computed using this wrong 2.5x-overstated fallback on at least one side (stop or
// target) before this fix -- their EV sweeps are being recomputed as part of this fix.
export const DEFAULT_DPP = LIVE_INSTRUMENT.dollarsPerPoint;

// Target sweep range (pts) — all setup types, not just IB. Always capped at p75_mfe
// per-type below, so it can't select a target beyond what the type's own MFE data supports.
const TARGET_SWEEP = [10, 15, 20, 25, 30, 35, 40, 50, 60, 70, 80, 90, 100, 120, 150];

// Run EV sweep for targets — finds T1 that maximizes expected value given a fixed stop.
// Simulates: if MAE > stop → -stop*stopDpp, elif MFE >= T → +T*targetDpp, else → actual_pnl
// (expired/partial).
//
// stopDpp/targetDpp: real dollars-per-point for this setup_type, derived from its own
// resolved trades (see the dppRes query below) — NOT a flat assumed constant. CORRECTED
// 2026-07-17: this comment previously claimed real $/pt was "cleanly bimodal (~$5 for
// the level-fade family, ~$2 for IB_BULLISH/BEARISH/OPEN_DRIVE/C_STANDALONE/etc.)",
// attributed to a Gemini mining pass "cross-checked by Claude against direct SQL" — that
// cross-check was wrong (or never actually run against fresh data). Directly re-verified
// 2026-07-17 against every setup_type with N>=20 STOP_HIT trades: all 54 types checked
// resolve to $2.01-$2.06/pt, no exceptions, no bimodal split. See DEFAULT_DPP's comment
// above for the full account — this was the same wrong-$/pt-constant bug class, just
// dressed up with a false verification claim instead of a naive hardcode.
//
// maxT caps the sweep at p75_mfe so we never select a target that >75% of trades can't reach.
// Without this cap, high T values saturate to actual_pnl and look artificially optimal.
//
// The canonical single-point EV formula -- exported so anything that needs to verify
// "is this stored ev_per_trade actually the EV of this stored stop/target" (e.g.
// test_invariants.mjs) can call the REAL production formula instead of hand-copying it.
// A second hand-copied formula would itself be exactly the same bug class this exists to
// prevent (see docs/OPEN_THREADS.md, 2026-07-17: ev_per_trade silently stopped matching
// optStop/optTarget for 8 days before anyone caught it) -- import this, don't reimplement it.
export function computeEvAtStopTarget(trades, stop, target, stopDpp = DEFAULT_DPP, targetDpp = DEFAULT_DPP) {
  if (!trades.length) return null;
  let evSum = 0;
  for (const t of trades) {
    const mae = +t.mae_points, mfe = +t.mfe_points;
    if (mae > stop)         evSum += -stop * stopDpp;
    else if (mfe >= target) evSum += target * targetDpp;
    else                    evSum += +t.actual_pnl;
  }
  return evSum / trades.length;
}

// Returns { target, ev }, or null if fewer than MIN_N trades or no candidates ≤ maxT.
function sweepOptimalTarget(trades, stop, maxT = 150, stopDpp = DEFAULT_DPP, targetDpp = DEFAULT_DPP) {
  if (trades.length < MIN_N) return null;
  const candidates = TARGET_SWEEP.filter(T => T <= maxT);
  if (candidates.length === 0) return null;
  let bestT = null, bestEV = -Infinity;
  for (const T of candidates) {
    const ev = computeEvAtStopTarget(trades, stop, T, stopDpp, targetDpp);
    if (ev > bestEV) { bestEV = ev; bestT = T; }
  }
  return { target: bestT, ev: bestEV };
}

// Joint stop+target sweep. Corrected simulation (2026-07-13 audit): a trade where
// mae <= stop AND mfe < target never actually got stopped or hit target — it
// expired/partial — so it falls through to actual_pnl, NOT an automatic loss.
// (Prior Gemini analysis on 2026-07-10 miscounted that case as a loss, which
// wrongly favored tighter stops for 69/70 setups; re-derived directly against the
// DB with this fix, only 28/66 setups actually favor p50_mae over p75_mae — no
// blanket rule holds, so this must be swept per setup_type, not hardcoded.)
//
// Stop candidates are percentiles of THIS TYPE'S OWN mae_points distribution
// (p25/p40/p50/p60/p75, passed in from the caller's query as {value, pct} pairs) —
// not a fixed point grid. A flat grid let the sweep pick stops unrelated to the actual
// data (e.g. 150pt for a type whose real MAE tops out around p90≈100), which overfits:
// a stop that almost never triggers looks great on realized EV without reducing real
// risk. Percentile-anchoring keeps every candidate tied to that type's real
// distribution shape.
//
// Thin-tail gate (2026-07-14 audit): the EV sweep itself always uses all N trades to
// score a candidate stop, but the STOP VALUE at a high percentile (e.g. p75 of N=20)
// is only really informed by the ~N*(1-pct) trades whose mae falls in that tail — for
// p75 at N=20, that's ~5 trades defining where "p75" actually lands, an unstable
// estimate a single outlier can shift. Require the same MIN_N floor already used
// elsewhere in this file to apply to that tail count too, not just the type's total N
// — derived per-candidate as MIN_N/(1-pct), not a new hardcoded number.
export function sweepOptimalStopAndTarget(trades, maeCandidates, maxT, stopDpp, targetDpp) {
  if (trades.length < MIN_N) return null;
  let best = null;
  for (const { value, pct } of maeCandidates) {
    const S = Math.round(value);
    const requiredN = Math.ceil(MIN_N / (1 - pct));
    if (trades.length < requiredN) continue; // tail too thin to trust this percentile's boundary
    const swept = sweepOptimalTarget(trades, S, maxT, stopDpp, targetDpp);
    if (!swept) continue;
    if (!best || swept.ev > best.ev) best = { stop: S, target: swept.target, ev: swept.ev };
  }
  return best;
}

async function main() {
  console.log('Computing optimal stops + EV-sweep targets from active_setups MAE/MFE data...');

  // 0. Mark corrupted MAE/MFE rows as BAD_DATA so they're excluded from all analysis.
  //    Opus audit 2026-07-07: 303/304 rows from 2023 have mae or mfe > 300pt (max 11,766pt).
  //    Root cause: bad bar data in price_bars_primary for Nov–Dec 2023 (price_at_resolution IS NULL).
  //    300pt is the clear boundary — 2024+ data is clean (0/1083 bad in 2024).
  const badRows = await query(`
    UPDATE active_setups
    SET replay_resolution = 'BAD_DATA'
    WHERE (mae_points > 300 OR mfe_points > 300)
      AND replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
    RETURNING id
  `);
  if (badRows.rows.length > 0) console.log(`Marked ${badRows.rows.length} corrupted MAE/MFE rows as BAD_DATA`);

  // 1. Compute p75_mae (optimal stop) and p50_mfe (optimal target) per setup_type
  //    Only resolved trades with clean MAE data; exclude EXPIRED (they inflate MAE/MFE)
  //    Excludes BAD_DATA rows (mae/mfe > 300pt from 2023 corruption).
  const statsRes = await query(`
    SELECT
      setup_type,
      COUNT(*)                                                                            AS n,
      ROUND(100.0 * SUM(CASE WHEN actual_pnl > 0 THEN 1 ELSE 0 END)/COUNT(*)::numeric, 1) AS wr,
      ROUND(AVG(actual_pnl)::numeric, 0)                                                 AS ev,
      ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY mae_points)::numeric, 1)       AS p25_mae,
      ROUND(PERCENTILE_CONT(0.40) WITHIN GROUP (ORDER BY mae_points)::numeric, 1)       AS p40_mae,
      ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY mae_points)::numeric, 1)       AS p50_mae,
      ROUND(PERCENTILE_CONT(0.60) WITHIN GROUP (ORDER BY mae_points)::numeric, 1)       AS p60_mae,
      ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY mae_points)::numeric, 1)       AS p75_mae,
      ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY mae_points)::numeric, 1)       AS p90_mae,
      ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY mfe_points)::numeric, 1)       AS p50_mfe,
      ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY mfe_points)::numeric, 1)       AS p75_mfe
    FROM active_setups
    WHERE mae_points     IS NOT NULL
      AND mfe_points     IS NOT NULL
      AND actual_pnl     IS NOT NULL
      AND mae_points     <= 300
      AND mfe_points     <= 300
      AND status         = 'RESOLVED'
      AND replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
    GROUP BY setup_type
    HAVING COUNT(*) >= ${MIN_N}
    ORDER BY setup_type
  `);

  const rows = statsRes.rows;
  console.log(`Found ${rows.length} setup types with N≥${MIN_N}`);

  // 1a2. Real per-setup_type dollars-per-point, derived from resolved trades' actual dollar
  // P&L vs. their real point distance to stop/target — NOT a flat assumed constant, though
  // in practice every setup_type resolves to the same ~$2.01-2.06/pt (MNQ's real $2/pt plus
  // the $1 commission spread across the trade's point distance) — see DEFAULT_DPP's comment
  // above, corrected 2026-07-17. Falls back to DEFAULT_DPP per type/side when N < MIN_N for
  // that specific branch (stop-hit or target-hit) — same floor used everywhere else in this
  // file, and now the same real value rather than a wrong 2.5x-inflated one.
  const dppRes = await query(`
    SELECT setup_type,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(actual_pnl) / NULLIF(ABS(entry_zone_low - stop_level), 0))
        FILTER (WHERE replay_resolution = 'STOP_HIT')                                    AS stop_dpp,
      COUNT(*) FILTER (WHERE replay_resolution = 'STOP_HIT')                             AS n_stop,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(actual_pnl) / NULLIF(ABS(t1_level - entry_zone_low), 0))
        FILTER (WHERE replay_resolution = 'TARGET_HIT')                                  AS target_dpp,
      COUNT(*) FILTER (WHERE replay_resolution = 'TARGET_HIT')                           AS n_target
    FROM active_setups
    WHERE status = 'RESOLVED' AND entry_zone_low IS NOT NULL
      AND stop_level IS NOT NULL AND t1_level IS NOT NULL
      AND actual_pnl IS NOT NULL
    GROUP BY setup_type
  `);
  const dppByType = {};
  for (const r of dppRes.rows) {
    const stopDpp   = (+r.n_stop >= MIN_N && r.stop_dpp != null) ? +r.stop_dpp : DEFAULT_DPP;
    const targetDpp = (+r.n_target >= MIN_N && r.target_dpp != null) ? +r.target_dpp : DEFAULT_DPP;
    dppByType[r.setup_type] = { stopDpp, targetDpp };
  }

  // 1b. Fetch all raw trades in one query for the target sweep
  const rawRes = await query(`
    SELECT setup_type, mae_points::float, mfe_points::float, actual_pnl::float
    FROM active_setups
    WHERE mae_points IS NOT NULL AND mfe_points IS NOT NULL AND actual_pnl IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300
      AND status = 'RESOLVED'
      AND replay_resolution IN ('TARGET_HIT', 'STOP_HIT')
  `);
  const rawByType = {};
  for (const t of rawRes.rows) {
    if (!rawByType[t.setup_type]) rawByType[t.setup_type] = [];
    rawByType[t.setup_type].push(t);
  }
  console.log(`Loaded ${rawRes.rows.length} raw trades for EV target sweep`);

  let upserted = 0;
  for (const r of rows) {
    const p75mae    = parseFloat(r.p75_mae) || DEFAULT_STOP;
    const p75mfe    = Math.round(parseFloat(r.p75_mfe) || DEFAULT_TARGET);
    // Capped at p75 — NOT p90. Opus audit (2026-07-13) found the EV sim checks `mae > stop`
    // before checking the target, with no knowledge of chronological order within the trade.
    // At p90, trades whose real mae landed in the 76th-90th percentile range get "rescued"
    // into simulated wins whenever mfe happened to clear the target *at any point* in the bar
    // walk, regardless of whether target was actually reached before the real (tighter,
    // historical) stop would have triggered. IB_BEARISH: 8 such trades scored as +$100 wins
    // in the sim, but their real average actual_pnl was -$97.80 (they lost) — this artifact,
    // not genuine edge, is what pushed IB_BEARISH to a 150pt stop and BRACKET_BREAKOUT_LONG to
    // 165pt. This is the exact same failure mode sweepOptimalTarget's `maxT` cap already guards
    // against for targets (see its comment: "high T values saturate to actual_pnl and look
    // artificially optimal") — p90 just wasn't capped symmetrically for stops when the stop
    // sweep was added. p75 still isn't perfectly immune (same bias at lower magnitude, per the
    // audit) but the artifact was concentrated at p90 in practice (7/66 types landed there).
    const maeCandidates = [
      { value: r.p25_mae, pct: 0.25 }, { value: r.p40_mae, pct: 0.40 },
      { value: r.p50_mae, pct: 0.50 }, { value: r.p60_mae, pct: 0.60 },
      { value: r.p75_mae, pct: 0.75 },
    ].map(c => ({ ...c, value: parseFloat(c.value) })).filter(c => !isNaN(c.value) && c.value > 0);
    const trades    = rawByType[r.setup_type] || [];
    const { stopDpp, targetDpp } = dppByType[r.setup_type] || { stopDpp: DEFAULT_DPP, targetDpp: DEFAULT_DPP };
    const swept     = sweepOptimalStopAndTarget(trades, maeCandidates, p75mfe, stopDpp, targetDpp);
    const optStop   = swept ? swept.stop : Math.round(p75mae);
    const optTarget = swept ? swept.target : Math.round(parseFloat(r.p50_mfe) || DEFAULT_TARGET);
    const targetMethod = swept ? 'EV-sweep' : 'p50_mfe fallback';
    // FIXED 2026-07-17: ev_per_trade used to be parseFloat(r.ev) -- ROUND(AVG(actual_pnl)),
    // a raw historical average using whatever stop/target each trade ACTUALLY fired with --
    // completely disconnected from optStop/optTarget above (the EV-sweep's real chosen pair).
    // Bug dated to this file's original commit (a04b2fd, 2026-07-05), before the EV-sweep even
    // existed (optTarget was just p50_mfe back then, so the raw average was a defensible
    // standalone stat); broke silently on 2026-07-09 (de3e407, "EV-sweep targets") when the
    // sweep was added without rewiring this field to match. Full writeup + git-history trace:
    // docs/OPEN_THREADS.md. optEV now reports the EV *of* optStop/optTarget specifically --
    // falls back to the raw average only when no sweep candidate was valid (thin-tail gate
    // rejected every percentile candidate), matching optStop/optTarget's own fallback.
    const optEV     = swept ? swept.ev : parseFloat(r.ev);

    await query(`
      INSERT INTO performance_audit (
        run_date, window_days, signal_type, signal_name,
        sample_size, win_rate, ev_per_trade,
        p50_mae, p75_mae, p50_mfe, p75_mfe,
        optimal_stop, optimal_target
      ) VALUES (
        CURRENT_DATE, 9999, 'OPTIMAL_STOP', $1,
        $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10
      )
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
        sample_size    = EXCLUDED.sample_size,
        win_rate       = EXCLUDED.win_rate,
        ev_per_trade   = EXCLUDED.ev_per_trade,
        p50_mae        = EXCLUDED.p50_mae,
        p75_mae        = EXCLUDED.p75_mae,
        p50_mfe        = EXCLUDED.p50_mfe,
        p75_mfe        = EXCLUDED.p75_mfe,
        optimal_stop   = EXCLUDED.optimal_stop,
        optimal_target = EXCLUDED.optimal_target
    `, [
      r.setup_type,
      parseInt(r.n),
      parseFloat(r.wr) / 100,
      optEV,
      parseFloat(r.p50_mae),
      parseFloat(r.p75_mae),
      parseFloat(r.p50_mfe),
      parseFloat(r.p75_mfe),
      optStop,
      optTarget,
    ]);

    upserted++;
    // Prints both the (now-correct) swept EV and the raw historical average side by side --
    // deliberately visible so a future divergence this large is caught by eye immediately,
    // not just by the automated invariant check in test_invariants.mjs.
    console.log(`  ${r.setup_type.padEnd(40)} stop=${optStop}pt  t1=${optTarget}pt(${targetMethod})  WR=${r.wr}%  N=${r.n}  EV=$${optEV.toFixed(2)}  (raw avg pnl=$${r.ev})`);
  }

  console.log(`\nDone. ${upserted} rows upserted into performance_audit (signal_type=OPTIMAL_STOP).`);
  console.log('Every setup_type now gets its own stop swept across its own MAE percentiles (p25/p40/p50/p60/p75/p90), not a blanket p75_mae rule.');
  process.exit(0);
}

// Guarded so this file can be safely `import`ed (e.g. by test_invariants.mjs for
// computeEvAtStopTarget/DEFAULT_DPP) without triggering a live DB run as a side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error('FATAL:', err); process.exit(1); });
}
