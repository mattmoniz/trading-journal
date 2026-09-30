// Touch-time order-flow-pressure shadow tracker, 2026-09-27 (observation-only, same
// guarantee family as step_trail_shadow/pitch_catch_shadow/direction_gate_shadow/
// momentum_against_fade_shadow/breakeven_stop_shadow/entry_orderflow_shadow -- never
// touches a real trade's own origin_status/status/resolution/actual_pnl/stop_level, only
// writes its own JSONB column, right after the real INSERT, wrapped so a failure here can
// never affect the real row it's tagging).
//
// Distinct from entryOrderFlowShadow.js's LONG_REPEAT_ADVERSE_FLOW/SHORT_MORNING_ADVERSE_
// FLOW rules (a single 1-min bar's net delta, RTH-only, two hand-designed rules) -- this
// measures a rolling 8-bar APPROACH window using touchQuality.js's own getVolumeBaseline()
// z-score convention (the same baseline the live post-touch classifyTouch() uses), applied
// to bars strictly BEFORE the touch instead of after it. Genuinely new signal, not a
// duplicate -- see the backing research below.
//
// Backing research: scratch/orderflow_touch_time_entry_selection_phase0_20260927.mjs
// (OPEN_DECISION orderflow_rejection_entry_selection_untested_20260916 -- "no code, no
// query, nothing run" until this session). Real decisive touches (active_setups,
// ACTIVE/SHADOW origin, is_cluster_primary, TARGET_HIT/STOP_HIT), N=3,375, 58 distinct
// real dates: heavy adverse order-flow pressure (aggressive volume fighting AGAINST the
// fade direction) in the 8 bars approaching a touch predicts a real, materially worse
// outcome. Top netAdverseDelta tercile: EV=-$11.58/trade vs -$2.38 for the bottom tercile.
// Rigor-clean (distinctDates=56/58, top5DayPct=22.2%, not clustered, stable across all 3
// chronological thirds), broad across 172 distinct setup_types (no single type
// dominates), survives a 10-trial randomized-direction placebo (real effect more extreme
// than all 10 trials). Walk-forward validated (scratch/orderflow_touch_time_walkforward_
// sim_20260927.mjs): cutoff derived from the FIRST half of real dates (Jul 9-Aug 18),
// applied blind to the SECOND half (Aug 19-Sep 25, never used to pick the threshold) --
// skipping flagged touches saved $10,254 over that month-plus vs taking everything;
// half-sizing them saved $5,127. See RESEARCH_CLAIM
// orderflow_touch_time_adverse_pressure_worse_outcome_20260927 for the full account.
//
// SHIPPED AS OBSERVATION-ONLY (matching every other mechanism in this family) -- real
// forward data needs to accumulate under the CALIBRATED (not the one-off backtest) cutoff
// before this is anywhere close to a live-gating decision. Records BOTH a hard-skip and a
// soft-half-size hypothetical per row so a future promotion decision can compare which
// shape actually holds up (the mid-trade sibling mechanisms in this same signal family
// found soft beats hard once -- breakeven-tighten over full-exit -- worth checking here
// too, not assuming it transfers).

import { query } from '../db.js';
import { getVolumeBaseline } from './touchQuality.js';
import { getGlobalCalib } from './acdShared.js';

const APPROACH_BARS = 8;

// Pure computation -- reused by both the calibration script and the live tagger, per
// this codebase's "export the real function" convention. beforeTs: touch instant (fired_at
// for a real row, "now" for a live pre-check). Returns null if insufficient bar history.
export async function computeApproachOrderflow({ direction, beforeTs }) {
  const barsRes = await query(`
    SELECT (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as mod,
           COALESCE(bid_volume,0)::float as bid_volume, COALESCE(ask_volume,0)::float as ask_volume
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts < $1::timestamp
      AND ts >= $1::timestamp - INTERVAL '${APPROACH_BARS + 2} minutes'
    ORDER BY ts DESC LIMIT ${APPROACH_BARS}
  `, [beforeTs]);
  if (barsRes.rows.length < APPROACH_BARS) return null;

  const date = await query(`SELECT $1::timestamp::date::text as d`, [beforeTs]).then(r => r.rows[0].d);
  const baseline = await getVolumeBaseline(query, date);

  let maxZ = -Infinity, adverseVol = 0, favorableVol = 0;
  for (const b of barsRes.rows) {
    const bl = baseline.get(b.mod);
    const totalVol = b.bid_volume + b.ask_volume;
    if (bl && bl.std_vol > 0) {
      const z = (totalVol - bl.avg_vol) / bl.std_vol;
      if (z > maxZ) maxZ = z;
    }
    const adverse   = direction === 'LONG' ? b.bid_volume : b.ask_volume;
    const favorable = direction === 'LONG' ? b.ask_volume : b.bid_volume;
    adverseVol += adverse;
    favorableVol += favorable;
  }
  if (maxZ === -Infinity) return null;
  return { maxZ, netAdverseDelta: adverseVol - favorableVol };
}

// Cached (per-day) read of the calibrated netAdverseDelta cutoff(s). Self-recalibrates via
// scripts/calibrate_touch_orderflow_pressure.mjs (weekly). null (tagging disabled, fail-
// closed) if no GATE-worthy calibration row exists yet -- per this codebase's no-static-
// thresholds rule, never a hardcoded point value. `softCutoff`/`softGateActive` added
// 2026-09-29 (DeepSeek design-critique audit) -- see tagTouchOrderflowPressureShadow()'s own
// header for why `wouldHalfSize` used to just duplicate `wouldSkip` and what replaced it.
export async function getTouchOrderflowPressureCalib() {
  return getGlobalCalib('touchOrderflowPressureCalib', async () => {
    const r = await query(`
      SELECT recommendation, notes FROM performance_audit
      WHERE signal_type='TOUCH_ORDERFLOW_PRESSURE_CALIB' AND signal_name='_GLOBAL'
      ORDER BY run_date DESC LIMIT 1
    `);
    const row = r.rows[0];
    if (!row || row.recommendation !== 'GATE') return null;
    try {
      const notes = JSON.parse(row.notes);
      if (notes.cutoff != null) {
        return {
          cutoff: notes.cutoff,
          softCutoff: notes.softCutoff ?? null,
          softGateActive: notes.softRecommendation === 'SOFT_GATE',
        };
      }
    } catch (_) {}
    return null;
  });
}

// Tags a real (ACTIVE/SHADOW) row, right after insert, with this touch's own approach-
// window order-flow reading -- SHADOW-ONLY / OBSERVATION-ONLY, exact same posture as
// tagMomentumAgainstFadeShadow()/tagEntryOrderFlowShadow(). Keyed by the row's own `id`
// via a follow-up UPDATE, not threaded through the INSERT's own positional params.
//
// wouldHalfSize FIXED 2026-09-29 (DeepSeek design-critique audit): used to just copy
// wouldSkip, which meant the $5,127-vs-$10,254 hard-vs-soft shape mentioned in this file's own
// header could never actually be checked forward. Since "half size" is a PRE-ENTRY sizing
// penalty (enter at half contract size), not an exit-style hypothesis, its counterfactual is
// trivially 0.5x the real trade's own actual_pnl -- no separate re-entry simulation needed,
// unlike StepTrail/PitchCatch's mid-trade exit-choice shape. wouldHalfSize is now its OWN
// independent condition (netAdverseDelta in the calibrated soft band, below the hard skip
// cutoff), gated on softGateActive so it can never fire "true" while the calibration script's
// own walk-forward check hasn't found real support for a soft tier -- the 2026-09-29 run found
// NO monotonic degradation across a naive tercile split (mid tercile EV was actually BETTER
// than the low tercile's, not between low and high), so softGateActive is currently false and
// wouldHalfSize will correctly never be true until a future recalibration finds real evidence
// for it.
export async function tagTouchOrderflowPressureShadow(insertedId, { direction, firedAt }) {
  if (!insertedId || !direction || !firedAt) return;
  try {
    const calib = await getTouchOrderflowPressureCalib();
    if (!calib) return; // no calibration row yet -- fail closed, tag nothing
    const measure = await computeApproachOrderflow({ direction, beforeTs: firedAt });
    if (!measure) return; // insufficient bar history -- don't guess
    const wouldSkip = measure.netAdverseDelta >= calib.cutoff;
    const wouldHalfSize = !wouldSkip && calib.softGateActive && calib.softCutoff != null
      && measure.netAdverseDelta >= calib.softCutoff;
    await query(
      `UPDATE active_setups SET touch_orderflow_pressure_shadow = $1 WHERE id = $2`,
      [JSON.stringify({
        maxZ: +measure.maxZ.toFixed(2), netAdverseDelta: +measure.netAdverseDelta.toFixed(1),
        cutoff: calib.cutoff, softCutoff: calib.softCutoff, wouldSkip, wouldHalfSize,
        checkedAt: new Date().toISOString(),
      }), insertedId]
    );
  } catch (_) { /* observation-only -- never let a tagging failure surface anywhere */ }
}
