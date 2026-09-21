// Pure, single-bar step function for the LIVE breakeven-stop-on-order-flow-rejection
// mechanism (promoted 2026-09-21 from server/services/breakevenStopShadow.js's SHADOW-only
// retrospective classifier, per RESEARCH_CLAIM orderflow_rewarded_breakeven_stop_positive_20260916
// and a fresh 2026-09-21 promotion-readiness rigor check -- see docs/OPEN_THREADS.md's same-day
// entry for the full derivation). Extracted per this codebase's own "export the real function"
// rule, same shape as widerTargetWalker.js's stepWiderTarget()/breakevenTrailWalker.js's
// stepBreakevenTrail() -- exercised by scripts/test_breakeven_stop_walker_synthetic.mjs and
// verified byte-for-byte against the retrospective breakevenStopShadow.js classifier on real
// historical trades before being trusted (see that verification script's own header).
//
// Z_CUT/D_CUT are the SAME literals breakevenStopShadow.js used (imported from here now --
// this file is the new canonical home since it's the live mechanism; the shadow file re-exports
// them for backward compatibility rather than duplicating). NOT re-derived live -- see this
// constant's original derivation note in breakevenStopShadow.js's git history (2026-09-16,
// 75th-percentile-of-all-adverse-push-candidates, full precision kept to match the backtest
// exactly). Recalibrate only via a fresh percentile derivation over the accumulated real
// population, never by hand-tuning.
export const Z_CUT = -0.0551991443084654;
export const D_CUT = 0.2213130416402452;

import { query } from '../db.js';
import { LIVE_INSTRUMENT } from '../config/instruments.js';
import { resolveDirection } from '../config/setupTypes.js';

// Online (bar-by-bar, poll-to-poll) reproduction of computeBreakevenStopClassification()'s
// push-detection loop. Unlike the offline version (which already knows the trade's full,
// resolved bar array and can look at bar i+1 freely), this walks ONE bar at a time in real
// time and must track a "pending push, awaiting its confirm bar" state across calls --
// DeepSeek's 2026-09-21 design critique (F5 point 2) confirmed this is the correct shape:
// on the CONFIRM bar, both (a) finalize REWARDED/REJECTED using that bar's own order-flow, and
// (b) apply the breakeven-stop/target check to that SAME bar if it just armed -- matching the
// offline simulation's own `pushIdx + 1`-inclusive walk exactly.
//
// A push candidate that `failsSameBar` (closePos on the wrong side) is classified REJECTED
// immediately, with no need to wait for a confirm bar -- only `flipsNextBar` genuinely needs
// the next bar's order-flow. This means a push is only ever "pending" between detection and
// its immediate next bar, never longer.
//
// Per DeepSeek's F7 finding: the offline classifier's `bars.length - 2` bound (never treating
// the last two bars of a trade's FULL resolved history as a push candidate) transfers cleanly
// to the online version without any special-casing -- it falls out naturally from "we can only
// confirm a push once its next bar actually arrives," and a push detected on what turns out to
// be the real resolution bar is moot anyway since resolution (via the plain-path check below,
// since not yet armed) fires in that same call and the caller's loop breaks before the pending
// push would ever be confirmed.
//
// CORRECTED 2026-09-21 (caught by the byte-diff verification against real historical trades,
// scripts/test_breakeven_stop_walker_synthetic.mjs -- 108/1921 real mismatches on the first
// attempt, before this fix): the offline classifier evaluates ONLY the FIRST adverse-push
// candidate found anywhere in the trade's life, via an unconditional `break` right after
// classifying it -- REJECTED or REWARDED, it never looks for a second candidate. An earlier
// draft of this function kept scanning for a NEW push after a REJECTED one, which is not the
// same rule and produced real, materially different classifications (mostly REJECTED-in-
// offline reclassified as REWARDED-online, because a later push in the same trade's history
// got found and confirmed instead). `pushEvaluated` enforces the same "only the first
// candidate ever counts" rule online.
//
// SECOND correction, same verification pass: the offline classifier's loop bound
// (`i < bars.length - 2`) doesn't just prevent looking at the last 2 bars in isolation -- it
// requires a NEW push candidate to have at least 2 MORE bars after it in the array before it's
// even considered a candidate at all (i ≤ L-3 means positions i, i+1, i+2 all exist). This is
// only knowable if the caller tells us how many bars remain -- `resolveSetupsByPrice()`
// re-fetches and re-walks the COMPLETE currently-available bar array from scratch every poll
// (never a true streaming cursor), so `barsRemainingAfter` is cheaply available at every call
// (bars.rows.length - 1 - currentIndex). In live use this means a push within 2 bars of
// whatever's fetched THIS poll simply isn't confirmed yet -- it gets picked up next poll once
// more bars exist, a small (~one poll cycle) added latency, not a correctness gap. Verified
// zero mismatches against the offline classifier's own output on the full real 1,921-trade
// population once this was added (scripts/test_breakeven_stop_walker_synthetic.mjs).
//
// state: { pendingPush: { bar, delta } | null, armed: boolean, armedAtTs: string | null,
//          breakevenStop: number | null, sawRejection: boolean, pushEvaluated: boolean }
// bar: { ts, high, low, close, bid_volume, ask_volume, mod } (one bar, chronological order
//   guaranteed by the caller's own per-bar loop -- same convention as every other walker here)
// params: { entry, stop, t1, long, baseline, barsRemainingAfter } -- baseline is a Map keyed by
//   minute-of-day (touchQuality.js's getVolumeBaseline() shape), fetched ONCE per row before
//   the per-bar loop starts. barsRemainingAfter is the count of bars strictly after THIS one in
//   the currently-fetched array (0 for the last bar, 1 for the second-to-last, etc.).
// Returns { state: <next state>, resolution: null | { resolution, method, priceAtRes } }
export function stepBreakevenStop(state, bar, { entry, stop, t1, long, baseline, barsRemainingAfter }) {
  let armed = state.armed, armedAtTs = state.armedAtTs, breakevenStop = state.breakevenStop;
  let pendingPush = state.pendingPush;
  let sawRejection = state.sawRejection;
  let pushEvaluated = state.pushEvaluated;

  // 1. If a push is pending confirmation, THIS bar is its confirm bar.
  if (pendingPush && !armed) {
    const nTot = (bar.bid_volume || 0) + (bar.ask_volume || 0);
    const nDelta = (bar.ask_volume || 0) - (bar.bid_volume || 0);
    const nm = baseline.get(Number(bar.mod));
    const nz = nm && nm.std_vol > 0 && nTot > 0 ? (nTot - nm.avg_vol) / nm.std_vol : 0;
    const flipsNextBar = (nDelta * pendingPush.delta < 0 && nz > 1.0);
    if (flipsNextBar) {
      pendingPush = null; // REJECTED (next-bar flip) -- never arms, falls through to the plain-path check below
      sawRejection = true;
    } else {
      // REWARDED -- arms starting THIS bar (the confirm bar itself), matching the offline
      // simulation's own pushIdx+1-inclusive walk.
      armed = true;
      armedAtTs = bar.ts;
      breakevenStop = entry;
      pendingPush = null;
    }
    pushEvaluated = true; // the ONE candidate this trade ever gets has now been decided
  }

  // 2. Not (yet) armed, no push currently pending, and no candidate has EVER been evaluated
  //    yet -- check if THIS bar is a NEW push candidate. Only the FIRST adverse-push
  //    candidate found anywhere in the trade's life is ever considered, matching the offline
  //    classifier's own unconditional `break` right after evaluating one -- REJECTED or
  //    REWARDED, it never looks for a second candidate, and neither does this.
  if (!armed && !pendingPush && !pushEvaluated && barsRemainingAfter >= 2) {
    const tot = (bar.bid_volume || 0) + (bar.ask_volume || 0);
    const m = baseline.get(Number(bar.mod));
    if (m && m.std_vol && tot > 0) {
      const z = (tot - m.avg_vol) / m.std_vol;
      const delta = (bar.ask_volume || 0) - (bar.bid_volume || 0);
      const isAdverse = (long && delta < 0) || (!long && delta > 0);
      if (isAdverse && z >= Z_CUT && (Math.abs(delta) / tot) >= D_CUT) {
        const closePos = (bar.close - bar.low) / ((bar.high - bar.low) || 1);
        const failsSameBar = (long && closePos > 0.5) || (!long && closePos < 0.5);
        if (!failsSameBar) {
          pendingPush = { bar, delta };
        } else {
          sawRejection = true; // REJECTED immediately (same-bar fail)
          pushEvaluated = true;
        }
      }
    }
  }

  // 3. Stop/target check -- uses the breakeven stop once armed, otherwise the original stop
  //    (the plain, un-triggered path). Stop wins on a same-bar conflict, matching the plain
  //    branch's own SAME_BAR_STOP_FIRST convention elsewhere in this file.
  const effectiveStop = armed ? breakevenStop : stop;
  const stopHit = long ? bar.low <= effectiveStop : bar.high >= effectiveStop;
  const targetHit = long ? bar.high >= t1 : bar.low <= t1;
  let resolution = null;
  if (stopHit && targetHit) {
    resolution = { resolution: 'STOP_HIT', method: armed ? 'BE_STOP_SAME_BAR' : 'SAME_BAR_STOP_FIRST', priceAtRes: effectiveStop };
  } else if (stopHit) {
    resolution = { resolution: 'STOP_HIT', method: armed ? 'BE_STOP_HIT' : 'PRICE_CLEAN', priceAtRes: effectiveStop };
  } else if (targetHit) {
    resolution = { resolution: 'TARGET_HIT', method: 'PRICE_CLEAN', priceAtRes: t1 };
  }

  return { state: { pendingPush, armed, armedAtTs, breakevenStop, sawRejection, pushEvaluated }, resolution };
}

// Plain-path-counterfactual follow-up pass -- FOUND 2026-09-21 via DeepSeek code review, before
// this mechanism ever fired live for real (real N=0 at the time): resolveSetupsByPrice()'s inline
// `beCounterfactualResolution` computation (see that file's own BE branch) can only ever see bars
// through "now" at the moment the REAL breakeven-stop resolution fires -- and for `BE_STOP_HIT`
// specifically, that's BEFORE the original (wider) stop or target would ever have been touched
// (that's the whole point of arming early), so the inline computation's own `if (resolution)
// break` exits before the plain path ever resolves, leaving `counterfactual_pnl`/`live_active`
// permanently null for exactly the rows this payload most needs to describe. Once `status` flips
// to `RESOLVED` the row leaves resolveSetupsByPrice()'s own query forever, so there is no way for
// that function to keep walking it on a later poll -- this is the deliberate second half, same
// architecture as shadowCompletion.js's completeStepTrailShadows()/completePitchCatchShadows()
// (re-derives the ENTIRE plain-path walk from scratch every poll, fired_at -> a NOW that keeps
// growing on each call, until the plain path also resolves one way or the other). Never touches
// the real trade's own status/resolution/actual_pnl/stop_level -- only ever updates its own
// counterfactual fields inside the already-written breakeven_stop_live JSONB.
//
// Only BE_STOP_HIT rows need this -- every other resolution_method this mechanism can produce
// already gets a correct, non-null counterfactual computed inline (NO_PUSH/REJECTED: cf equals
// the real plain-path outcome by construction since BE never armed; REWARDED-but-target-still-hit:
// cf equals the real TARGET_HIT; BE_STOP_SAME_BAR: the original target was ALSO touched on the
// same bar the breakeven stop was, so cf resolves inline with no gap) -- see the DeepSeek review's
// own Finding 2 for the full case-by-case reasoning.
export async function completeBreakevenStopCounterfactuals() {
  const pending = await query(`
    SELECT id, trade_date::text as trade_date, fired_at::text as fired_at,
           entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
           stop_level::float as stop_level, t1_level::float as t1_level,
           actual_pnl::float as actual_pnl, breakeven_stop_live
    FROM active_setups
    WHERE status='RESOLVED' AND breakeven_stop_eligible = true
      AND resolution_method = 'BE_STOP_HIT'
      AND breakeven_stop_live IS NOT NULL
      AND breakeven_stop_live->>'counterfactual_pnl' IS NULL
    LIMIT 200
  `);
  if (!pending.rows.length) return 0;

  const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint, COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
  let completed = 0;
  for (const row of pending.rows) {
    try {
      const dir = resolveDirection(row);
      if (dir === null) continue;
      const long = dir === 'LONG';
      const entry = row.entry_zone_high ?? row.entry_zone_low;
      const stop = row.stop_level, t1 = row.t1_level;
      if (entry == null || stop == null || t1 == null || row.actual_pnl == null) continue;

      // Same fire-minute-EXCLUSIVE convention as the live resolution loop itself (ts > fired_at)
      // -- this walk is standing in for "what the plain path would have done," so it must use
      // the SAME bar window the plain path itself would have used, not the shadow's own
      // fire-minute-inclusive convention (see Finding 3 / the F1 residual note).
      const barsRes = await query(`
        SELECT ts::text as ts, high::float, low::float, close::float
        FROM price_bars_primary WHERE symbol='NQ' AND ts > $1 ORDER BY ts ASC
      `, [row.fired_at]);
      if (!barsRes.rows.length) continue;

      let cf = null;
      for (const bar of barsRes.rows) {
        const cfStopHit = long ? bar.low <= stop : bar.high >= stop;
        const cfTargetHit = long ? bar.high >= t1 : bar.low <= t1;
        // Same-bar tie-break as the plain path elsewhere in this codebase: stop wins.
        if (cfStopHit) { cf = { resolution: 'STOP_HIT', priceAtRes: stop, ts: bar.ts }; break; }
        if (cfTargetHit) { cf = { resolution: 'TARGET_HIT', priceAtRes: t1, ts: bar.ts }; break; }
      }
      if (!cf) continue; // plain path hasn't resolved either way yet -- retry next poll, more bars will exist by then

      const cfPts = long ? cf.priceAtRes - entry : entry - cf.priceAtRes;
      const counterfactualPnl = Math.round((cfPts * PNL_PER_POINT - COMMISSION) * 100) / 100;
      const updatedPayload = {
        ...row.breakeven_stop_live,
        counterfactual_resolution: cf.resolution,
        counterfactual_pnl: counterfactualPnl,
        delta: Math.round((row.actual_pnl - counterfactualPnl) * 100) / 100,
        // Always true for a BE_STOP_HIT row by definition -- BE genuinely changed the real
        // outcome (that's what BE_STOP_HIT itself means), unlike the inline computation's own
        // `cf.priceAtRes !== priceAtRes` check which this follow-up pass doesn't need to repeat.
        live_active: true,
        completed_inline: false,
      };
      await query(
        `UPDATE active_setups SET breakeven_stop_live=$2::jsonb, updated_at=NOW() WHERE id=$1 AND breakeven_stop_live->>'counterfactual_pnl' IS NULL`,
        [row.id, JSON.stringify(updatedPayload)]
      );
      completed++;
    } catch (e) {
      // Per-row isolation, same convention as shadowCompletion.js -- one bad row never blocks
      // the rest of this poll's batch, and this whole function is already isolated from the
      // real trade path (separate function, separate .catch(() => {}) at its call site).
      console.error(`completeBreakevenStopCounterfactuals row id=${row.id} error (non-critical, retrying next poll):`, e.message);
    }
  }
  return completed;
}
