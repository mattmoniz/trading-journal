// Breakeven-stop-on-order-flow-rejection shadow tracker, 2026-09-16 (observation-only, same
// guarantee family as step_trail_shadow/pitch_catch_shadow/direction_gate_shadow/
// momentum_against_fade_shadow — never touches a real trade's own status/resolution/
// actual_pnl/stop_level, only writes its own JSONB column after the real trade has already
// resolved through its own unmodified path).
//
// PROMOTED TO LIVE 2026-09-21 for in-scope rows (server/services/breakevenStopWalker.js,
// wired into resolveSetupsByPrice()) -- this file's retrospective classifier now only ever
// runs for rows where `breakeven_stop_eligible IS NOT TRUE` (out-of-scope setup_types, and any
// row inserted before this column existed). For live-eligible rows, the resolution write
// already reflects whatever the live mechanism actually did, so this function's own
// `delta = hypotheticalPnl - actual_pnl` would silently measure breakeven-vs-breakeven (≈0),
// not breakeven-vs-plain -- see breakevenStopWalker.js's own header and
// docs/OPEN_THREADS.md's 2026-09-21 entry (DeepSeek design critique F4) for why the shadow and
// the live mechanism cannot share this same delta semantics once promoted.
//
// RESIDUAL BAR-WINDOW DIVERGENCE (DeepSeek code-review Finding 3, 2026-09-21, deliberately NOT
// unified): this file's own bar fetch below is fire-minute-INCLUSIVE (`ts >= date_trunc('minute',
// fired_at)`); the live resolution loop (resolveSetups.js) and the counterfactual follow-up pass
// (breakevenStopWalker.js's completeBreakevenStopCounterfactuals()) are both fire-minute-EXCLUSIVE
// (`ts > fired_at`). The promotion decision itself was re-validated on the EXCLUSIVE convention
// (N=178, CI [$6.38, $29.49] -- see docs/OPEN_THREADS.md), so this divergence doesn't invalidate
// anything already shipped. But it IS a latent trap for any future cross-comparison of this
// shadow's still-running out-of-scope population against the live mechanism's own results, or for
// the upcoming momentum_against_fade_shadow (MF) promotion work if it ever needs to reconcile
// against this file. Don't assume the two populations are bar-for-bar comparable without
// rechecking which convention each side used.
//
// Backing research: RESEARCH_CLAIM orderflow_named_level_slicethrough_net_negative_20260915
// (the underlying classifier: a trade showing an early adverse order-flow push that SUCCEEDS
// -- "REWARDED" -- averages -$15.02/trade real, vs +$2.27 baseline/+$9.30 when the push fails
// -- "REJECTED") and RESEARCH_CLAIM orderflow_rewarded_breakeven_stop_positive_20260916 (the
// live-actionable follow-up: tightening the stop to BREAKEVEN, not exiting, the moment a
// REWARDED push is confirmed nets +$7,325.81 vs doing nothing on the same 416-trade
// population, independently re-verified before shipping this). A full-exit response was
// separately tested and found net NEGATIVE (-$1,912.29) -- this file implements ONLY the
// breakeven response, never a full exit, per that finding.
//
// SCOPE: restricted to the exact population both findings were tested on -- non-overnight
// named-level fades (`setup_type ~ '_FADE_(LONG|SHORT)$'`, which structurally excludes any
// `_OVERNIGHT`-suffixed variant since those don't end in LONG/SHORT). Do NOT widen this scope
// without a fresh Phase 0 test on the wider population first -- see CLAUDE.md's "a
// backtest/backfill's detection population must match what the live poller actually fires on"
// rule. GLOBEX_VWAP_MAGNET_LONG/SHORT is explicitly NOT in scope (a separate setup family,
// see CLAUDE.md's regex-grouping-naming-trap convention entry from this same investigation).
//
// Z_CUT/D_CUT are NOT re-derived live -- same convention as minorDefendedLevelDetector.js's
// own Z_CUT/D_CUT: plain literals derived once from a real backtest, documented with source
// and date, not a live query (re-deriving would mean rescanning ~24,768 historical adverse-
// push candidates on every completion pass). Fresh 75th-percentile cutoffs computed across
// ALL adverse-push candidates in the real 1,820-trade named-level-fade population,
// 2025-06-01 to 2026-09-15 (scratch/orderflow_real_trade_adverse_push_20260915.mjs /
// scratch/task_ab_20260916.mjs). Recalibrate if this mechanism's real N ever grows large
// enough to re-run the percentile derivation on fresh data.
// Full precision, not rounded -- verified 2026-09-16 that rounding to -0.055/0.221 flips the
// classification of 1 borderline trade out of 1,820 (a push bar whose z-score sits between
// the rounded and true cutoff). Kept at full precision to match the backtest exactly rather
// than accept an avoidable, silent 1-trade divergence.
//
// Re-exported from breakevenStopWalker.js (the new canonical home as of the 2026-09-21
// promotion) rather than redeclared here -- single source of truth for the exact same
// constants the live mechanism now uses.
export { Z_CUT, D_CUT } from './breakevenStopWalker.js';
import { Z_CUT, D_CUT } from './breakevenStopWalker.js';

import { query } from '../db.js';
import { LIVE_INSTRUMENT } from '../config/instruments.js';
import { resolveDirection } from '../config/setupTypes.js';
import { getTouchQualityBaseline } from './acdShared.js';

// Pure classification + breakeven-simulation over a full, already-fetched bar array spanning
// a real trade's OWN life (fired_at through resolved_at -- never further, this mechanism is
// purely retrospective over a trade that has already played out for real, matching the
// backing research's own methodology exactly). `bars` must be chronological 1-min rows with
// { ts, high, low, close, bid_volume, ask_volume, mod }. `baseline` is a Map keyed by
// minute-of-day (touchQuality.js's getVolumeBaseline() shape). Returns:
//   { classification: 'NO_PUSH'|'REJECTED'|'REWARDED', armedAtTs: string|null,
//     hypotheticalResolution: null | { type: 'STOP'|'TARGET', price: number, ts: string } }
// A REJECTED or NO_PUSH classification never produces a hypotheticalResolution -- the
// backing research only ever intervenes on REWARDED trades (see the file header).
export function computeBreakevenStopClassification(bars, { entry, stop, target, long, baseline }) {
  let pushIdx = null, cls = 'NO_PUSH';

  // Matches scratch/task_ab_20260916.mjs's `for (i = startIdx; i < endIdx - 1; i++)` exactly
  // in array-relative terms: with `bars` spanning [startIdx..endIdx] inclusive (length L),
  // that loop's array-relative bound is `arrIdx < L - 2`, NOT `L - 1` -- the original script
  // excludes the last TWO bars from ever starting a push search (the resolution bar itself,
  // and the bar immediately before it), not just the last one. Found and fixed 2026-09-16
  // via a byte-for-byte verification run against the real 1,820-trade population that
  // initially came back with a real, non-trivial mismatch (430 vs 416 REWARDED) before this
  // fix — re-verify after any future change to this loop bound.
  for (let i = 0; i < bars.length - 2; i++) {
    const b = bars[i];
    const tot = (b.bid_volume || 0) + (b.ask_volume || 0);
    const m = baseline.get(Number(b.mod));
    if (!m || !m.std_vol || tot === 0) continue;
    const z = (tot - m.avg_vol) / m.std_vol;
    const delta = (b.ask_volume || 0) - (b.bid_volume || 0);
    const isAdverse = (long && delta < 0) || (!long && delta > 0);
    if (!isAdverse || z < Z_CUT || (Math.abs(delta) / tot) < D_CUT) continue;

    const closePos = (b.close - b.low) / ((b.high - b.low) || 1);
    const failsSameBar = (long && closePos > 0.5) || (!long && closePos < 0.5);
    const nx = bars[i + 1];
    const nTot = (nx.bid_volume || 0) + (nx.ask_volume || 0);
    const ndelta = (nx.ask_volume || 0) - (nx.bid_volume || 0);
    const nm = baseline.get(Number(nx.mod));
    const nz = nm && nm.std_vol > 0 && nTot > 0 ? (nTot - nm.avg_vol) / nm.std_vol : 0;
    const flipsNextBar = (ndelta * delta < 0 && nz > 1.0);

    cls = (failsSameBar || flipsNextBar) ? 'REJECTED' : 'REWARDED';
    pushIdx = i;
    break;
  }

  if (cls !== 'REWARDED') return { classification: cls, armedAtTs: null, hypotheticalResolution: null };

  // Breakeven simulation: stop moves to `entry` the instant the push is confirmed, walking
  // forward through the SAME bars the real trade actually saw. Matches
  // scratch/task_ab_20260916.mjs's simulateTrade('breakeven') exactly -- verified
  // byte-for-byte against that script's own output before this was written.
  const breakevenStop = entry;
  for (let i = pushIdx + 1; i < bars.length; i++) {
    const b = bars[i];
    if (long && b.low <= breakevenStop) return { classification: cls, armedAtTs: bars[pushIdx].ts, hypotheticalResolution: { type: 'STOP', price: breakevenStop, ts: b.ts } };
    if (!long && b.high >= breakevenStop) return { classification: cls, armedAtTs: bars[pushIdx].ts, hypotheticalResolution: { type: 'STOP', price: breakevenStop, ts: b.ts } };
    if (long && b.high >= target) return { classification: cls, armedAtTs: bars[pushIdx].ts, hypotheticalResolution: { type: 'TARGET', price: target, ts: b.ts } };
    if (!long && b.low <= target) return { classification: cls, armedAtTs: bars[pushIdx].ts, hypotheticalResolution: { type: 'TARGET', price: target, ts: b.ts } };
  }
  // Ran out of bars without the breakeven-simulated path resolving (shouldn't happen in
  // practice since this only ever runs on an already-fully-resolved real trade, so `bars`
  // spans all the way to the real resolution -- kept as a defensive null rather than assuming).
  return { classification: cls, armedAtTs: bars[pushIdx].ts, hypotheticalResolution: null };
}

// Completion pass -- mirrors shadowCompletion.js's completeStepTrailShadows()/
// completePitchCatchShadows() convention, but simpler: this mechanism's classification is
// purely retrospective over a trade's OWN already-known real life (fired_at to resolved_at),
// so unlike the wider-target-dependent shadows it never needs bars beyond the real
// resolution, and never needs to be re-attempted inline while the trade is still open --
// one pass, right after the real trade resolves, is sufficient. Never touches the real row's
// status/resolution/actual_pnl/stop_level.
export async function completeBreakevenStopShadows() {
  // FIXED 2026-09-16 (DeepSeek code review, finding #1): the resolution_method exclusion below
  // is a POPULATION restriction, not a data-cleanliness nicety -- it was missing from the first
  // version, meaning the live pass silently tagged a WIDER population than the backing backtest
  // and verifier actually covered. resolveSetups.js force-closes a still-open fade at RTH close
  // as resolution='TIME_EXPIRED'/method='MARK_TO_MARKET' with a real actual_pnl -- these never
  // hit stop or target for real, so simulating a breakeven-stop response against them measures
  // something the research never tested. Confirmed real contamination before this fix: 277 of
  // 2,051 backfilled rows were MTM-resolved, 9 of those carried a non-null hypothetical_pnl
  // that had been silently flowing into the loss-prevention rollup -- those 277 rows' shadow
  // tags were cleared (see scratch/fix_deepseek_findings_20260916.mjs) so this corrected filter
  // re-tags them correctly (i.e., excludes them, matching the real backtest population).
  const pending = await query(`
    SELECT id, setup_type, trade_date::text as trade_date, fired_at::text as fired_at,
           resolved_at::text as resolved_at,
           entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
           stop_level::float as stop_level, t1_level::float as t1_level, actual_pnl::float as actual_pnl
    FROM active_setups
    WHERE status = 'RESOLVED' AND breakeven_stop_shadow IS NULL
      AND setup_type ~ '_FADE_(LONG|SHORT)$'
      AND breakeven_stop_eligible IS NOT TRUE
      AND origin_status IN ('ACTIVE','SHADOW')
      AND (is_cluster_primary IS NULL OR is_cluster_primary = true)
      AND (resolution_method IS NULL OR resolution_method NOT IN ('MARK_TO_MARKET','RECOVERY_MTM'))
      AND fired_at IS NOT NULL AND resolved_at IS NOT NULL AND actual_pnl IS NOT NULL
    LIMIT 200
  `);
  if (!pending.rows.length) return 0;

  const dateCache = new Map();
  let completed = 0;
  for (const row of pending.rows) {
    try {
      const dir = resolveDirection(row);
      if (dir === null) continue;
      const long = dir === 'LONG';
      const entry = row.entry_zone_high ?? row.entry_zone_low;
      const stop = row.stop_level, target = row.t1_level;
      if (entry == null || stop == null || target == null) continue;

      // Floored-to-minute lower bound, matching this codebase's standing "floor timestamps to
      // the minute before matching bars to fired_at" convention (fired_at carries real
      // sub-minute precision; bars are always exactly on-the-minute) -- an exact `>` or `>=`
      // comparison against the raw sub-minute fired_at would silently exclude the bar covering
      // the very minute the trade fired, which is a valid push-search candidate per the
      // backing backtest's own findIdxAtOrAfter() semantics.
      const barsRes = await query(`
        SELECT ts::text as ts, high::float, low::float, close::float,
               COALESCE(bid_volume,0)::int as bid_volume, COALESCE(ask_volume,0)::int as ask_volume,
               (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as mod
        FROM price_bars_primary WHERE symbol='NQ'
          AND ts >= date_trunc('minute', $1::timestamp) AND ts <= $2
        ORDER BY ts ASC
      `, [row.fired_at, row.resolved_at]);
      if (barsRes.rows.length < 2) continue; // needs at least a push bar + a confirm bar

      if (!dateCache.has(row.trade_date)) dateCache.set(row.trade_date, await getTouchQualityBaseline(row.trade_date));
      const baseline = dateCache.get(row.trade_date);

      const result = computeBreakevenStopClassification(barsRes.rows, { entry, stop, target, long, baseline });

      const POINT_VALUE = LIVE_INSTRUMENT.dollarsPerPoint, COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
      let hypotheticalPnl = null;
      if (result.hypotheticalResolution) {
        const pts = long ? result.hypotheticalResolution.price - entry : entry - result.hypotheticalResolution.price;
        hypotheticalPnl = Math.round((pts * POINT_VALUE - COMMISSION) * 100) / 100;
      }
      const payload = JSON.stringify({
        classification: result.classification,
        armed_at: result.armedAtTs,
        hypothetical_resolution_type: result.hypotheticalResolution?.type ?? null,
        hypothetical_exit_price: result.hypotheticalResolution?.price ?? null,
        hypothetical_pnl: hypotheticalPnl,
        real_pnl: row.actual_pnl,
        delta: hypotheticalPnl != null ? Math.round((hypotheticalPnl - row.actual_pnl) * 100) / 100 : null,
        z_cut: Z_CUT, d_cut: D_CUT,
      });
      await query(`UPDATE active_setups SET breakeven_stop_shadow=$2::jsonb, updated_at=NOW() WHERE id=$1 AND breakeven_stop_shadow IS NULL`, [row.id, payload]);
      completed++;
    } catch (e) {
      // Per-row isolation, same convention as shadowCompletion.js -- one bad row never blocks
      // the rest of this poll's batch.
      console.error(`completeBreakevenStopShadows row id=${row.id} error (non-critical, retrying next poll):`, e.message);
    }
  }
  return completed;
}
