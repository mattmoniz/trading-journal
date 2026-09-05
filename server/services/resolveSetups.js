// The real trade-resolution write path: walks price bars for every ACTIVE/SHADOW
// active_setups row and resolves TARGET_HIT/STOP_HIT/TIME_EXPIRED/wider-target outcomes.
// Extracted from server/routes/acd.js 2026-09-05 (DeepSeek-planned extraction, Candidate A --
// see docs/OPEN_THREADS.md's 2026-09-05 entry and OPEN_DECISION
// acdjs_deferred_cleanup_from_deepseek_audit_20260905). Pure relocation, behavior-identical --
// verified line-for-line via diff before removing the original from acd.js. Deliberately its
// own dedicated extraction pass, not bundled with the other candidates -- this is the single
// biggest function in the file (1003 lines), the real write path (resolution/pnl/
// price_at_resolution), and was the epicenter of the getCached() null-vs-undefined bug fixed
// earlier the same day. Called from acd.js's own poll loop, first among the 3 lifecycle
// passes (resolveSetupsByPrice -> completeStepTrailShadows -> completePitchCatchShadows).

import { query } from '../db.js';
import { LIVE_INSTRUMENT } from '../config/instruments.js';
import { resolveDirection, CONDITIONAL_VARIANTS, getBetClass } from '../config/setupTypes.js';
import { firedAtToMod, isPastMechanismSessionEnd } from './sessionBoundary.js';
import { computeBar6Checkpoint, computeSlowDeepEarlyExit } from './maeMfeReplay.js';
import { getDeltaConfirmationCategory, classifyDeltaConfirmation } from './deltaConfirmation.js';
import { classifyTouch } from './touchQuality.js';
import { stepBreakevenTrail } from './breakevenTrailWalker.js';
import { stepWiderTarget, MAX_BARS_TO_T1_FOR_WIDER } from './widerTargetWalker.js';
import { stepStepTrail } from './stepTrailWalker.js';
import { stepPitchCatch } from './pitchCatchWalker.js';
import { computeADXSeries } from './adxService.js';
import { detectPostEntryExitSignals } from '../../scripts/pilot_exits_extended.mjs';
import { getCached, setCached, getGlobalCalib, DAY_CACHE_TTL, getTouchQualityCalib, getTouchQualityBaseline, dropToTimeline } from './acdShared.js';

// Price-based resolution: for each ACTIVE setup with defined entry/stop/T1, walk price
// bars since fired_at and resolve TARGET_HIT/STOP_HIT the moment either level is touched
// (whichever is touched first, chronologically — same logic as setupBacktestService.js
// and the historical backfill). Runs BEFORE expireStaleSetups/structurallyInvalidateSetups
// so a real T1/stop touch is never preempted by a timer or OR-break invalidation.
export async function resolveSetupsByPrice(io) {
  // fired_at is selected as ::text, not as a Date object: node-postgres serializes
  // JS Date params for "timestamp without time zone" columns using the server
  // process's LOCAL timezone, while these columns actually store raw ET wall-clock
  // values (per db.js's 'Z'-suffix parser convention). Rebinding a Date object as
  // the $1 param below silently shifted the bar-walk window by the ET/UTC offset
  // (4hrs in EDT), pulling in pre-market bars and causing false STOP_HIT resolutions.
  // Passing the raw text avoids the round-trip entirely. Found 2026-06-30.
  // runner_trail_width is the ONLY new column read as input here — it doubles as the
  // trail-eligibility flag (non-null = breakeven-then-trail mechanism applies) and the
  // trail distance itself. breakeven_armed_at/runner_peak_price/runner_trail_price are
  // NOT read here because this function already re-walks every bar from fired_at on
  // every single poll (same as the existing MAE/MFE computation below) rather than
  // resuming from a saved cursor — so the armed/peak/trail state is fully re-derived
  // from scratch each poll, deterministically, and only needs to be WRITTEN (for the
  // frontend card to display "armed, trailing" — see docs/SCALEOUT_RUNNER_SPEC.md §7),
  // never read back in as input.
  // entry_zone_low/entry_zone_high/stop_level/t1_level cast to ::float (2026-08-17,
  // DeepSeek code-review of the wider-target counterfactual endpoint): node-postgres
  // returns NUMERIC columns as JS strings, and this loop's `entry`/`stop`/`t1` locals
  // (derived from these 4 columns below) were left uncast. The widerTarget branch's
  // `entry + t1Distance * widerTargetMult` (long side) silently STRING-CONCATENATED
  // instead of adding on any LONG SHADOW row that armed the mechanism -- confirmed real
  // and live, the exact bug found and fixed in the read-only counterfactual endpoint
  // earlier the same session, except this is the actual WRITE path. Checked directly
  // against every LONG-direction wider_target_mult-tagged row's real price bars before
  // this fix: none had actually touched T1 within the 4-bar arming window yet, so this
  // was a live, armed bug with zero realized corruption -- forward-looking fix, no
  // backfill needed. Also fixes the fragile (currently-coincidentally-correct) string
  // comparisons at BOTH `t1 <= entry`/`t1 >= entry` sites below -- the needsBars filter
  // a few lines down AND the main loop's own copy further down -- which only agreed with
  // numeric order because this codebase's index levels are all uniform 5-digit numbers
  // (DeepSeek confirmation-pass, 2026-08-17: flagged the original comment as under-scoped,
  // naming only the first site).
  const active = await query(`
    SELECT id, setup_type, trade_date::text as trade_date, fired_at::text as fired_at, expires_at::text as expires_at,
           entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
           stop_level::float as stop_level, t1_level::float as t1_level, status, touch_quality,
           runner_trail_width::float as runner_trail_width, extend_target_level::float as extend_target_level,
           wider_target_mult::float as wider_target_mult, origin_status, post_entry_exit_signals
    FROM active_setups WHERE status IN ('ACTIVE', 'SHADOW')
  `);
  // Naive ET wall-clock text, same convention as fired_at/expires_at above (see the
  // comment atop this function) -- lets expiry be compared via plain string comparison,
  // avoiding the ET/UTC Date-parsing landmine already found twice in this file.
  const nowEtRow = await query(`SELECT (NOW() AT TIME ZONE 'America/New_York')::text as now_et`);
  const nowEt = nowEtRow.rows[0].now_et;

  // Was a real N+1: one "bars since fired_at" query per unresolved setup (up to ~20
  // on a normal day), each independently re-scanning price_bars_primary's full
  // partition set (its ts column is a date_trunc() expression, not the raw
  // partition key, so partition pruning doesn't trigger even though the row-level
  // filter does) — measured 2026-07-15 as the dominant cost of /api/acd/setup-detection
  // (13-24s). Every setup's needed bars are a suffix of the earliest setup's own
  // range (all queries run "from fired_at through now"), so fetching once from the
  // single earliest fired_at and filtering per-setup in JS is both correct (same
  // exact rows each setup would have gotten) and eliminates the redundant re-scans.
  // ts is fetched as ::text (not a Date object) to match fired_at's own ::text
  // convention above — avoids the exact ET/UTC Date-parsing landmine documented
  // where this function reads fired_at, since string comparison here needs to match
  // Postgres's own timestamp-text ordering, not JS's local-timezone Date parsing.
  const needsBars = active.rows.filter(row => {
    if (row.setup_type === 'ABSORPTION_LONG' || row.setup_type.startsWith('COIL_SURGE') || row.setup_type.startsWith('POC_ROTATION_JOIN') || row.setup_type.startsWith('IB_LOW_PNR')) return false;
    const entry = row.entry_zone_high ?? row.entry_zone_low;
    const { stop_level: stop, t1_level: t1 } = row;
    if (entry == null || stop == null || t1 == null) return false;
    const direction = resolveDirection(row);
    // A null direction here can only mean a name/price disagreement (missing entry/stop/t1
    // already returned false above, so resolveDirection's own null-guard never triggers this
    // far down) -- NOT dropped here, since this filter only decides whether to fetch bars /
    // widens the shared bar-fetch window, it doesn't gate the row's fate. The main loop
    // below (which iterates active.rows directly, not needsBars) is what actually decides a
    // null-direction row's outcome (continue + logged reason) regardless of this filter's
    // return value -- returning true just means bars get fetched for a row that may end up
    // skipped anyway, which is harmless. (DeepSeek code-review, 2026-08-17: corrected from an
    // earlier, inaccurate comment that claimed returning false here would silently exclude
    // the row from the main loop -- it wouldn't, since the main loop doesn't consult this
    // filter's result at all.)
    if (direction === null) return true;
    const long = direction === 'LONG';
    if (long && t1 <= entry) return false;
    if (!long && t1 >= entry) return false;
    return true;
  });
  let sharedBarsRows = [];
  if (needsBars.length) {
    const earliestFiredAt = needsBars.reduce((min, r) => (r.fired_at < min ? r.fired_at : min), needsBars[0].fired_at);
    const sharedBars = await query(`
      SELECT ts::text as ts, open::float, high::float, low::float, close::float,
             COALESCE(bid_volume,0)::int AS bid_volume, COALESCE(ask_volume,0)::int AS ask_volume,
             (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int AS mod
      FROM price_bars_primary WHERE symbol='NQ' AND ts > $1 ORDER BY ts
    `, [earliestFiredAt]);
    sharedBarsRows = sharedBars.rows;
  }

  // Cumulative-delta-confirmation calibrated thresholds — read once per poll (cached,
  // matching the sharedBarsRows fetch-once-per-poll pattern above), never hardcoded.
  // Written weekly by scripts/calibrate_delta_confirmation.mjs (server/services/
  // deltaConfirmation.js's classifyDeltaConfirmation() is the shared classifier both
  // sides use). RESEARCH_CLAIM cumulative_delta_confirms_breakout_beyond_price_alone /
  // cumulative_delta_confirms_fades_stronger_than_breakout.
  const deltaCalibCached = getCached('_global', 'deltaConfirmationCalib', DAY_CACHE_TTL);
  const deltaCalib = deltaCalibCached ?? await (async () => {
    const r = await query(`
      SELECT DISTINCT ON (signal_name) signal_name, notes
      FROM performance_audit WHERE signal_type='DELTA_CONFIRMATION_CALIB'
      ORDER BY signal_name, run_date DESC
    `);
    const map = {};
    for (const row of r.rows) {
      try { map[row.signal_name] = JSON.parse(row.notes).threshold; } catch (_) {}
    }
    return setCached('_global', 'deltaConfirmationCalib', map, DAY_CACHE_TTL);
  })();

  // Wider-target pressure gate (2026-08-24, RESEARCH_CLAIM
  // wider_target_pressure_gate_vs_always_extend) — same read-once-per-poll-then-cache
  // convention as deltaCalib just above. Recomputed weekly by
  // scripts/calibrate_wider_target_pressure_gate.mjs; null (gate disabled, always-extend
  // behavior) if the calibration row is somehow missing, never a hardcoded fallback number.
  const widerTargetPressureThreshold = await getGlobalCalib('widerTargetPressureThreshold', async () => {
    const r = await query(`
      SELECT notes FROM performance_audit
      WHERE signal_type='WIDER_TARGET_PRESSURE_GATE' AND signal_name='THRESHOLD'
      ORDER BY run_date DESC LIMIT 1
    `);
    let val = null;
    try { val = r.rows[0] ? JSON.parse(r.rows[0].notes).threshold : null; } catch (_) {}
    return val;
  });

  // Step-trail runner extension shadow calibration (Opus Audit #12, 2026-09-04,
  // scratch/opus_audit_12_results.md) — same read-once-per-poll-then-cache convention as
  // widerTargetPressureThreshold just above. Recomputed weekly by
  // scripts/calibrate_step_trail_fraction.mjs; null (shadow logging disabled entirely,
  // fail-closed) if no calibration row exists yet or the last one didn't pass its own
  // rigor+subgroup-symmetry bar — never a hardcoded fallback fraction, per CLAUDE.md's
  // no-static-thresholds rule. Observation-only: never gates/sizes a real trade, only
  // populates active_setups.step_trail_shadow (see the widerTargetMult branch below and
  // completeStepTrailShadows()).
  const stepTrailCalib = await getGlobalCalib('stepTrailCalib', async () => {
    const r = await query(`
      SELECT notes FROM performance_audit
      WHERE signal_type='STEP_TRAIL_FRACTION' AND signal_name='FRACTION'
      ORDER BY run_date DESC LIMIT 1
    `);
    let val = null;
    try {
      if (r.rows[0]) {
        const notes = JSON.parse(r.rows[0].notes);
        if (notes.frac != null && notes.p10BaseFloor != null) val = { frac: notes.frac, p10BaseFloor: notes.p10BaseFloor };
      }
    } catch (_) {}
    return val;
  });

  // Pitch and Catch shadow calibration (user idea, 2026-09-04, UNVALIDATED -- see
  // server/services/pitchCatchWalker.js's header for the full negative evidence trail;
  // tracked at the user's explicit request, observation-only, never gates/sizes a real
  // trade). Same read-once-per-poll-then-cache convention as stepTrailCalib just above.
  const pitchCatchCalib = await getGlobalCalib('pitchCatchCalib', async () => {
    const r = await query(`
      SELECT notes FROM performance_audit
      WHERE signal_type='PITCH_CATCH_FILTER' AND signal_name='FILTER'
      ORDER BY run_date DESC LIMIT 1
    `);
    let val = null;
    try {
      if (r.rows[0]) {
        const n = JSON.parse(r.rows[0].notes);
        if (n.rvolLo != null && n.rvolHi != null && n.minBarsToConfirm != null && n.adxThreshold != null) {
          val = { rvolLo: n.rvolLo, rvolHi: n.rvolHi, minBarsToConfirm: n.minBarsToConfirm, adxThreshold: n.adxThreshold };
        }
      }
    } catch (_) {}
    return val;
  });

  // Daily ADX-by-date map (Sierra-Chart-verified formula, server/services/adxService.js) --
  // computed once and cached with a day-long TTL, not recomputed per-row/per-poll (a fresh
  // 14+14-bar daily-ADX series needs a real historical daily-bars query, too expensive to
  // repeat every 15s). Indexed by trade_date -> PRIOR day's close-of-day ADX (the [i-1] shift
  // below), matching every other daily-ADX use in this codebase's no-lookahead convention.
  const dailyAdxByDate = await getGlobalCalib('dailyAdxByDate', async () => {
    const map = {};
    if (pitchCatchCalib != null) {
      try {
        const r = await query(`
          SELECT ts::date::text as d, high::float as high, low::float as low, close::float as close
          FROM price_bars_primary WHERE symbol='NQ'
            AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int BETWEEN 570 AND 959
          ORDER BY ts ASC
        `);
        const byDate = new Map();
        for (const b of r.rows) {
          if (!byDate.has(b.d)) byDate.set(b.d, { high: b.high, low: b.low, close: b.close });
          else { const c = byDate.get(b.d); c.high = Math.max(c.high, b.high); c.low = Math.min(c.low, b.low); c.close = b.close; }
        }
        const dates = [...byDate.keys()].sort();
        const dBars = dates.map(d => ({ d, ...byDate.get(d) }));
        const series = computeADXSeries(dBars, 14, 14);
        for (let i = 1; i < dBars.length; i++) map[dBars[i].d] = series[i - 1];
      } catch (e) { console.error('dailyAdxByDate computation error (non-critical):', e.message); }
    }
    return map;
  });

  let count = 0;
  for (const row of active.rows) {
    const entry = row.entry_zone_high ?? row.entry_zone_low;
    const statusMatch = row.status; // 'ACTIVE' or 'SHADOW'

    // server/config/instruments.js is the single source of truth for this — found
    // 2026-07-16 that a wrong $/pt constant had independently drifted into 3 separate
    // places in this codebase (a backend script, a frontend modal, and this file's own
    // TRT_LONG trade-brief text), so this is deliberately imported, not redeclared.
    const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
    const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;

  // Custom resolution for POC_ROTATION_JOIN_LONG/SHORT — Time60_Stop20 exit (see
  // server/services/pocRotationJoinDetector.js header): 20pt stop, checked bar-by-bar
  // since fired_at (unlike ABSORPTION_LONG/COIL_SURGE below, which only check a current-
  // price snapshot — this construction's validated backtest exit is a real bar-walk, so
  // a snapshot-only check could miss an intrabar stop touch), OR a 60-minute time limit
  // with mark-to-market at the last available bar's close. t1_level is an unreachable
  // informational placeholder (never checked) — this is a genuinely target-less exit
  // shape, deliberately NOT routed through the shared generic bar-walk further below
  // (WIDER_TARGET/trail/extend logic) per this session's standing caution about editing
  // resolveSetupsByPrice()'s complex shared path without its own review.
    if (row.setup_type.startsWith('POC_ROTATION_JOIN')) {
      const stop = row.stop_level;
      if (entry == null || stop == null) continue;
      const long = row.setup_type.endsWith('_LONG');
      const barsSinceFired = await query(`
        SELECT ts::text as ts, high::float, low::float, close::float
        FROM price_bars_primary WHERE symbol='NQ' AND ts > $1 AND ts <= $2 ORDER BY ts ASC
      `, [row.fired_at, nowEt]);
      let resolution = null, priceAtRes = null, resolvedAt = null, method = null;
      for (const bar of barsSinceFired.rows) {
        const stopHit = long ? bar.low <= stop : bar.high >= stop;
        if (stopHit) { resolution = 'STOP_HIT'; method = 'PRICE_CLEAN'; priceAtRes = stop; resolvedAt = bar.ts; break; }
      }
      if (!resolution && row.expires_at && nowEt >= row.expires_at && barsSinceFired.rows.length > 0) {
        const lastBar = barsSinceFired.rows[barsSinceFired.rows.length - 1];
        resolution = 'TIME_EXPIRED'; method = 'MARK_TO_MARKET'; priceAtRes = lastBar.close; resolvedAt = lastBar.ts;
      }
      if (resolution) {
        const pnl = long ? (priceAtRes - entry) * PNL_PER_POINT - COMMISSION : (entry - priceAtRes) * PNL_PER_POINT - COMMISSION;
        await query(`UPDATE active_setups SET status='RESOLVED', resolution=$2, resolution_method=$3, actual_pnl=$4, price_at_resolution=$5, resolved_at=$6, updated_at=NOW() WHERE id=$1 AND status=$7`,
          [row.id, resolution, method, Math.round(pnl * 100) / 100, priceAtRes, resolvedAt, statusMatch]);
        if (statusMatch === 'ACTIVE' && io) io.emit('setup-resolved', { setupId: row.id, setupType: row.setup_type, resolution });
        count++;
      }
      continue;
    }

  // Custom resolution for IB_LOW_PNR_SHORT -- see server/services/ibLowPnrDetector.js
  // header. Real bar-walk stop check (150pt, same reasoning as POC_ROTATION_JOIN above --
  // a snapshot-only check could miss an intrabar stop touch), then hold-to-close
  // mark-to-market at expires_at (the session's own close, early-close-aware -- NOT a
  // fixed time limit like POC_ROTATION_JOIN's 60min, since this setup's validated exit
  // is "hold the position for the rest of the session," per the trade-simulation
  // finding that no-target/hold-to-close beat every tested fixed target). t1_level is
  // an unreachable informational placeholder, never checked.
    if (row.setup_type.startsWith('IB_LOW_PNR')) {
      const stop = row.stop_level;
      if (entry == null || stop == null) continue;
      const long = row.setup_type.endsWith('_LONG'); // always false today -- SHORT only, see spec
      const barsSinceFired = await query(`
        SELECT ts::text as ts, high::float, low::float, close::float
        FROM price_bars_primary WHERE symbol='NQ' AND ts > $1 AND ts <= $2 ORDER BY ts ASC
      `, [row.fired_at, nowEt]);
      let resolution = null, priceAtRes = null, resolvedAt = null, method = null;
      for (const bar of barsSinceFired.rows) {
        const stopHit = long ? bar.low <= stop : bar.high >= stop;
        if (stopHit) { resolution = 'STOP_HIT'; method = 'PRICE_CLEAN'; priceAtRes = stop; resolvedAt = bar.ts; break; }
      }
      if (!resolution && row.expires_at && nowEt >= row.expires_at && barsSinceFired.rows.length > 0) {
        const lastBar = barsSinceFired.rows[barsSinceFired.rows.length - 1];
        resolution = 'TIME_EXPIRED'; method = 'MARK_TO_MARKET'; priceAtRes = lastBar.close; resolvedAt = lastBar.ts;
      }
      if (resolution) {
        const pnl = long ? (priceAtRes - entry) * PNL_PER_POINT - COMMISSION : (entry - priceAtRes) * PNL_PER_POINT - COMMISSION;
        await query(`UPDATE active_setups SET status='RESOLVED', resolution=$2, resolution_method=$3, actual_pnl=$4, price_at_resolution=$5, resolved_at=$6, updated_at=NOW() WHERE id=$1 AND status=$7`,
          [row.id, resolution, method, Math.round(pnl * 100) / 100, priceAtRes, resolvedAt, statusMatch]);
        if (statusMatch === 'ACTIVE' && io) io.emit('setup-resolved', { setupId: row.id, setupType: row.setup_type, resolution });
        count++;
      }
      continue;
    }

  // Custom resolution for ABSORPTION_LONG: "did price move up meaningfully?"
    if (row.setup_type === 'ABSORPTION_LONG') {
      const stop = row.stop_level;
      const t1 = row.t1_level;
      if (entry == null || stop == null) continue;
      const currentPxQ = await query(`SELECT close::float FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= CURRENT_DATE - 5 ORDER BY ts DESC LIMIT 1`);
      const px = currentPxQ.rows[0]?.close;
      if (!px) continue;
      const stopHit = px <= stop;
      const targetHit = t1 && px >= t1;
      if (stopHit) {
        const pnl = (stop - entry) * PNL_PER_POINT - COMMISSION;
        await query(`UPDATE active_setups SET status='RESOLVED', resolution='STOP_HIT', resolution_method='PRICE_CLEAN', actual_pnl=$2, resolved_at=NOW(), updated_at=NOW() WHERE id=$1 AND status=$3`, [row.id, Math.round(pnl * 100) / 100, statusMatch]);
        if (statusMatch === 'ACTIVE' && io) io.emit('setup-resolved', { setupId: row.id, setupType: row.setup_type, resolution: 'STOP_HIT' });
        count++;
      } else if (targetHit) {
        const pnl = (t1 - entry) * PNL_PER_POINT - COMMISSION;
        await query(`UPDATE active_setups SET status='RESOLVED', resolution='TARGET_HIT', resolution_method='PRICE_CLEAN', actual_pnl=$2, price_at_resolution=$3, resolved_at=NOW(), updated_at=NOW() WHERE id=$1 AND status=$4`, [row.id, Math.round(pnl * 100) / 100, px, statusMatch]);
        if (statusMatch === 'ACTIVE' && io) io.emit('setup-resolved', { setupId: row.id, setupType: row.setup_type, resolution: 'TARGET_HIT' });
        count++;
      }
      continue;
    }

    // Direction resolution (all remaining branches below need it; ABSORPTION_LONG above
    // doesn't and always `continue`s before reaching here). A null result means the row's
    // name and its own stop/t1 levels disagree, or a price level is missing -- exclude
    // rather than silently guess (see resolveDirection()'s own header comment). This is a
    // real anomaly, not expected noise, so it's logged loudly, not just skipped quietly --
    // a systematic inversion (a future setup type inserted with flipped levels) must stay
    // visible, not become a permanent silent gap (CLAUDE.md no-dead-ends rule).
    const direction = resolveDirection(row);
    if (direction === null) {
      console.warn(`[resolveSetupsByPrice] DIRECTION_UNRESOLVABLE id=${row.id} ${row.setup_type} stop=${row.stop_level} t1=${row.t1_level} -- name/price direction disagreement or missing price levels. Skipping this poll, will retry next poll.`);
      continue;
    }
    const long = direction === 'LONG';

    // Custom resolution for COIL_SURGE: "did price move toward VWAP?"
    if (row.setup_type.startsWith('COIL_SURGE')) {
      const stop = row.stop_level;
      const t1 = row.t1_level;
      if (entry == null || stop == null || t1 == null) continue;
      const targetDist = Math.abs(t1 - entry);
      const currentPxQ = await query(`SELECT close::float FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= CURRENT_DATE - 5 ORDER BY ts DESC LIMIT 1`);
      const px = currentPxQ.rows[0]?.close;
      if (!px) continue;
      const currentDist = Math.abs(px - t1);
      const reverted = currentDist < targetDist * 0.5;
      const stopHit = long ? px <= stop : px >= stop;
      if (stopHit) {
        const pnl = (long ? (stop - entry) : (entry - stop)) * PNL_PER_POINT - COMMISSION;
        await query(`UPDATE active_setups SET status='RESOLVED', resolution='STOP_HIT', resolution_method='PRICE_CLEAN', actual_pnl=$2, resolved_at=NOW(), updated_at=NOW() WHERE id=$1 AND status=$3`, [row.id, Math.round(pnl * 100) / 100, statusMatch]);
        if (statusMatch === 'ACTIVE' && io) io.emit('setup-resolved', { setupId: row.id, setupType: row.setup_type, resolution: 'STOP_HIT' });
        count++;
      } else if (reverted) {
        const revertPts = Math.abs(px - entry);
        const pnl = revertPts * PNL_PER_POINT - COMMISSION;
        await query(`UPDATE active_setups SET status='RESOLVED', resolution='TARGET_HIT', resolution_method='VWAP_REVERT', actual_pnl=$2, price_at_resolution=$3, resolved_at=NOW(), updated_at=NOW() WHERE id=$1 AND status=$4`, [row.id, Math.round(pnl * 100) / 100, px, statusMatch]);
        if (statusMatch === 'ACTIVE' && io) io.emit('setup-resolved', { setupId: row.id, setupType: row.setup_type, resolution: 'TARGET_HIT' });
        count++;
      }
      continue;
    }

    // Level scalps and VWAP magnet resolve via standard target/stop logic below
    const stop = row.stop_level;
    const t1 = row.t1_level;
    if (entry == null || stop == null || t1 == null) continue;
    if (long && t1 <= entry) continue;
    if (!long && t1 >= entry) continue;

    const bars = { rows: sharedBarsRows.filter(b => b.ts > row.fired_at) };

    // Post-entry exit-signal tracking for open GLOBEX_FLUSH_* positions (part 1 of
    // OPEN_DECISION wire_flush_post_entry_exit_signals_globex, 2026-09-02): persists the
    // HYPOTHETICAL $ if range-expansion-slope / volume-rollover had been followed instead of
    // the real target, independent per mechanism, never touching this row's real actual_pnl/
    // resolution below. Real (ACTIVE/SHADOW) origin only -- BACKFILL/UNKNOWN rows never fire
    // live so tracking them would just be noise. Reuses detectPostEntryExitSignals()
    // (scripts/pilot_exits_extended.mjs) unchanged -- the exact function this session's
    // RESEARCH_CLAIM findings were derived from, not a re-coded copy. `WHERE id=$1 AND
    // post_entry_exit_signals->'<mechanism>' IS NULL`-equivalent gate (checked in JS below via
    // `existingSignals`) means each mechanism is recorded at most once per trade.
    if (row.setup_type.startsWith('GLOBEX_FLUSH') && (row.origin_status === 'ACTIVE' || row.origin_status === 'SHADOW')) {
      const existingSignals = row.post_entry_exit_signals || {};
      if (!existingSignals.range_slope || !existingSignals.vol_rollover) {
        const mode = row.setup_type.includes('REVERSAL') ? 'REVERSAL' : 'CONTINUATION';
        const postBars = bars.rows.map(b => ({ ...b, volume: (b.bid_volume || 0) + (b.ask_volume || 0) }));
        const volBaseline = await getTouchQualityBaseline(row.trade_date);
        const fires = detectPostEntryExitSignals({ postBars, isLong: long, entryPrice: entry, mode }, volBaseline);
        const toPersist = {};
        if (fires.range_slope && !existingSignals.range_slope) toPersist.range_slope = fires.range_slope;
        if (fires.vol_rollover && !existingSignals.vol_rollover) toPersist.vol_rollover = fires.vol_rollover;
        if (Object.keys(toPersist).length) {
          await query(
            `UPDATE active_setups SET post_entry_exit_signals = COALESCE(post_entry_exit_signals, '{}'::jsonb) || $2::jsonb, updated_at=NOW() WHERE id=$1`,
            [row.id, JSON.stringify(toPersist)]
          ).catch(() => {});
        }
      }
    }

    // Breakeven-then-trail (docs/SCALEOUT_RUNNER_SPEC.md): a non-null runner_trail_width
    // marks this row as using the dynamic path-dependent exit instead of the plain
    // fixed-stop/fixed-target logic below. All 6 wired _TRAIL variants attempt to set
    // this (CONDITIONAL_VARIANTS, server/config/setupTypes.js) -- comment corrected
    // 2026-08-24, was stale since the other 5 were wired 2026-07-21.
    const trailWidth = row.runner_trail_width;
    // FIXED 2026-08-24 (user-flagged: 3 of 6 wired trail variants showing
    // runner_trail_width IS NULL on every real fire, session-start invariant alert).
    // Root cause confirmed via a fresh run of scripts/backtest_breakeven_trail.mjs:
    // 5 of 6 wired variants genuinely fail its statistical guardrails today (OOS/
    // plateau-robustness checks), not a stale-schedule or code bug -- the calibration
    // script is working correctly, the trail width just isn't validated for these yet.
    // Until (if ever) one clears that bar, a null trailWidth here silently falls
    // through to the shared plain-bank branch below and resolves identically to a
    // trade that was never trail-eligible at all -- indistinguishable in the data.
    // This flag makes that visible (see the two PRICE_CLEAN sites below) instead of
    // leaving it a silent, undetectable dead mechanism.
    const trailCalibrationMissing = trailWidth == null && CONDITIONAL_VARIANTS[row.setup_type]?.trailSignalName != null;
    // Bank-vs-extend (promote_stackvol_to_tracked_setup, 2026-07-27): a non-null
    // extend_target_level marks this row (STACK_VOL_BREAK_LIVE_LONG/SHORT only, as of
    // 2026-07-27) as using the dynamic bars-to-target exit below instead of the plain
    // fixed-stop/fixed-target logic. Mutually exclusive with trailWidth -- no setup_type
    // sets both columns.
    const extendTarget = row.extend_target_level;
    // Wider-target-on-fast-resolving-trades (docs/OPEN_THREADS.md 2026-08-17,
    // OPEN_DECISION runner_wider_target_mechanism_build_spec): a non-null wider_target_mult
    // marks this row as using the dynamic wider-target exit below instead of the plain
    // fixed-stop/fixed-target logic. WIRED TO ACTIVE 2026-08-24 (explicit user decision,
    // real 19-day SHADOW track record: 53 armed trades, net +$1,071.75 vs plain-bank-at-T1)
    // -- set at insert time regardless of origin_status now (see the INSERT sites). This IS
    // where real capital exposure begins for this mechanism -- it changes the actual
    // stop/target of a real, user-visible trade, not just a size hint. Mutually exclusive
    // with trailWidth/extendTarget -- no setup_type row sets more than one of the three.
    const widerTargetMult = row.wider_target_mult;

    let resolution = null, resolvedAt = null, priceAtRes = null, method = null;
    let runMfe = 0, runMae = 0, barCount = 0;
    // Bar-6 checkpoint (RESEARCH_CLAIM engagement_bar6_worst_point_passed,
    // docs/OPEN_THREADS.md 2026-07-23): among touches still undecided (not stopped or
    // targeted) 6 bars after entry, whether the worst adverse excursion already happened
    // (bars 0-2, "recovering") vs is still fresh (bars 3-6, "deteriorating") cleanly
    // separates real outcomes on every payoff dimension. Informational only, same
    // convention as touch_quality just below — never affects resolution/pnl/entry. Does
    // NOT delay or gate the original entry alert (user explicitly did not want to risk
    // missing the fast, clean winners that make up most of the touch population).
    // Trail-mechanism state — recomputed from scratch on every poll (this function
    // already re-walks the full bar range from fired_at every call, same as MAE/MFE
    // above), never resumed from a saved cursor. Written back at the end regardless of
    // whether the row terminally resolves this poll, purely so the frontend card can
    // show "armed, trailing" (docs/SCALEOUT_RUNNER_SPEC.md §7) — never read as input.
    let armedAt = null, peakPrice = null, trailStopPrice = null;
    // Bank-vs-extend state -- same re-derive-from-scratch-every-poll convention as the
    // trail state above. `extending` flips true once the original t1 is reached in a
    // "grinding" 10-25 bar window (RESEARCH_CLAIM path_quality_bars_to_target_predicts_
    // continuation); false the whole way through for a fast (<=9 bar) bank or a slow
    // (>25 bar, unvalidated-to-extend) arrival, both of which just take t1 normally.
    let extending = false;
    // Wider-target state -- same re-derive-from-scratch-every-poll convention as the trail
    // and bank-vs-extend state above. `widening` flips true once T1 is reached within
    // MAX_BARS_TO_T1_FOR_WIDER bars of fired_at (matches the bars_to_resolution<=4 backtest
    // population exactly, see server/services/widerTargetWalker.js's own header); false the
    // whole way through for a slower arrival, which just takes t1 normally.
    let widerTargetState = { widening: false };
    // Step-trail shadow state — same re-derive-from-scratch-every-poll convention as every
    // other state above. Independent of widerTargetState (its own composed inner copy, see
    // server/services/stepTrailWalker.js) so tracking it can NEVER influence the REAL
    // resolution/method/priceAtRes this loop computes — purely observational. Only ever
    // updated inside the widerTargetMult branch below.
    let stepTrailShadowState = { inner: { widening: false }, ratcheting: false, currentStop: null, highestMfe: null };
    let stepTrailShadowResolution = null;
    let stepTrailShadowArmedAt = null;
    let stepTrailShadowDisabled = false;
    // Pitch and Catch shadow state — same independence/observational guarantees as
    // stepTrailShadowState above (server/services/pitchCatchWalker.js). UNVALIDATED
    // mechanism, tracked at the user's explicit request specifically because it's
    // unproven — never gates/sizes a real trade.
    let pitchCatchShadowState = {
      inner: { widening: false }, phase: 'ARMING', firstLegVolSum: 0, firstLegVolCount: 0,
      runningPeak: null, belowCount: 0, pullbackExtreme: null, settleBarVols: [], firstLegAvgVol: null, reentry: null,
    };
    let pitchCatchShadowResolution = null;
    let pitchCatchShadowDisabled = false;
    // FIXED 2026-08-30 (user-flagged, real Overnight/Globex PD_POC_FADE_SHORT fire): computed
    // once per row (not per bar) and fed into every session-end check below. row.fired_at is
    // already ::text-cast (this file's standard convention). See
    // server/services/sessionBoundary.js's isPastMechanismSessionEnd() for the incident this
    // closes -- all three exit mechanisms below independently hand-rolled an RTH-only
    // `hour>=16` check that silently misjudged session-end for any Globex-fired trade.
    const firedMod = firedAtToMod(row.fired_at);

    for (const bar of bars.rows) {
      barCount++;
      const favorable = long ? bar.high - entry : entry - bar.low;
      const adverse   = long ? entry - bar.low  : bar.high - entry;
      runMfe = Math.max(runMfe, favorable);
      runMae = Math.max(runMae, adverse);

      if (extendTarget != null) {
        // FIXED 2026-08-30 (see the firedMod comment above the bar loop) -- was
        // `bar.ts.slice(11,13) >= '16'`, RTH-only.
        const isSessionEnd = isPastMechanismSessionEnd(bar.mod, firedMod);
        const stopHit = long ? bar.low <= stop : bar.high >= stop;

        if (!extending) {
          const t1Hit = long ? bar.high >= t1 : bar.low <= t1;
          if (t1Hit && stopHit) {
            // Conservative: assume stop hit first (worst case), same convention as the
            // plain branch below.
            resolution = 'STOP_HIT'; method = 'SAME_BAR_STOP_FIRST';
            resolvedAt = bar.ts; priceAtRes = stop;
          } else if (stopHit) {
            resolution = 'STOP_HIT'; method = 'PRICE_CLEAN';
            resolvedAt = bar.ts; priceAtRes = stop;
          } else if (t1Hit) {
            const barsToTarget = barCount - 1; // 0 = reached on the very first bar, matches
                                                // pilot_path_quality_at_target.mjs's own convention
            if (barsToTarget <= 9) {
              // Fast arrival = climax spike -- bank now, extending destroyed value on backtest
              // (median -$135/trade on the fastest quartile).
              resolution = 'TARGET_HIT'; method = 'BANKED_FAST_ARRIVAL';
              resolvedAt = bar.ts; priceAtRes = t1;
            } else if (barsToTarget <= 25 && !isSessionEnd) {
              // Grinding arrival = real trend, rigor-clean +$34.75/trade median to extend.
              // Original stop_level is NEVER moved once extending -- the validated
              // FLAT_WIDE_150 design keeps the same stop throughout, it does not ratchet
              // to breakeven (unlike the trailWidth mechanism above, which is a different
              // exit design entirely).
              //
              // !isSessionEnd guard added 2026-08-18 (same bug class as widerTargetWalker.js's
              // B2 fix, docs/OPEN_THREADS.md 2026-08-18): without it, a t1Hit that qualifies
              // for extending AND lands on/after the 16:00 RTH-close bar would set
              // extending=true here and then ALSO get overwritten below by the
              // `if (!resolution && isSessionEnd)` MARK_TO_MARKET branch -- not a
              // contradictory return like the walker (this is a single mutable `resolution`
              // var, not a `{state, resolution}` pair), but the same underlying "arming with
              // zero session time left to benefit" mistake. Falls through to the BANKED_SLOW_
              // ARRIVAL branch below instead -- there's no time left to extend into, so bank
              // normally, same as the >25-bar case.
              extending = true;
            } else {
              // Two distinct paths land here, both banking the same way (DeepSeek code
              // review, 2026-08-18): (1) >25 bars -- only thinly positive on backtest, not
              // independently rigor-clean (see RESEARCH_CLAIM
              // path_quality_bars_to_target_predicts_continuation) -- the OPEN_DECISION this
              // mechanism implements only validated the 10-25 bar window as worth extending;
              // (2) a 10-25 bar arrival that lands on/after session end (!isSessionEnd guard
              // above) -- there's no session time left to benefit from extending, so it banks
              // here too rather than arming with nothing left to gain. BANKED_SLOW_ARRIVAL is
              // reused for both (no downstream consumer buckets by this string; the outcome
              // and actual_pnl are identical to any other bank-at-t1) rather than adding a
              // distinct method string with nothing to justify it.
              resolution = 'TARGET_HIT'; method = 'BANKED_SLOW_ARRIVAL';
              resolvedAt = bar.ts; priceAtRes = t1;
            }
          }
          if (!resolution && isSessionEnd) {
            resolution = 'TIME_EXPIRED'; method = 'MARK_TO_MARKET';
            resolvedAt = bar.ts; priceAtRes = bar.close;
          }
        } else {
          const extHit = long ? bar.high >= extendTarget : bar.low <= extendTarget;
          if (stopHit) {
            resolution = 'STOP_HIT'; method = 'EXTEND_STOP_HIT';
            resolvedAt = bar.ts; priceAtRes = stop;
          } else if (extHit) {
            resolution = 'TARGET_HIT'; method = 'EXTENDED_TARGET_HIT';
            resolvedAt = bar.ts; priceAtRes = extendTarget;
          } else if (isSessionEnd) {
            resolution = 'TIME_EXPIRED'; method = 'EXTEND_TIME_EXPIRED';
            resolvedAt = bar.ts; priceAtRes = bar.close;
          }
        }
        if (resolution) break;
        continue;
      }

      if (trailWidth != null) {
        // bar.ts is ET wall-clock TEXT (see the fired_at comment atop this function).
        // Delegates to the shared step function (server/services/breakevenTrailWalker.js,
        // extracted 2026-08-10, roadmap Phase 3 I4) instead of an inline reimplementation
        // — the exact same function is exercised by
        // scripts/test_breakeven_trail_walker_synthetic.mjs's synthetic price paths, so
        // "the trail mechanism works" is now a provable, re-runnable claim about this
        // live code path itself, not just about scripts/backtest_breakeven_trail.mjs's
        // separate simulation. Byte-behavior-identical to the prior inline version
        // (matches backtest_breakeven_trail.mjs's own simulation exactly, including the
        // same-bar-arm-and-breach scratch case — resolution_method strings kept <=20
        // chars, see the shared module's own header for the VARCHAR(20) history).
        const step = stepBreakevenTrail(
          { armedAt, peakPrice, trailStopPrice },
          bar,
          { entry, stop, t1, trailWidth, long, firedMod }
        );
        armedAt = step.state.armedAt;
        peakPrice = step.state.peakPrice;
        trailStopPrice = step.state.trailStopPrice;
        if (step.resolution) {
          resolution = step.resolution.resolution;
          method = step.resolution.method;
          resolvedAt = bar.ts;
          priceAtRes = step.resolution.priceAtRes;
        }
        if (resolution) break;
        continue;
      }

      if (widerTargetMult != null) {
        // bar.ts is ET wall-clock TEXT (see the fired_at comment atop this function).
        // Delegates to the shared step function (server/services/widerTargetWalker.js),
        // same "exercised by its own synthetic test, not a separate simulation" convention
        // as the trailWidth branch above. widerTarget is computed from THIS row's own
        // t1_level distance (not a shared per-setup_type constant) — matches
        // scratch/velocity_fast_wider_target_bounded_live_gate.mjs's backtested convention
        // exactly. 4-bar eligibility window matches bars_to_resolution<=4 (the population
        // RESEARCH_CLAIM velocity_fast_wider_target_positive_provisional was tested and
        // cross-family-validated against) — same class of backtest-derived bar-count
        // literal as the extendTarget branch's own 9/25 cutoffs above, not a fresh guess.
        const t1Distance = Math.abs(t1 - entry);
        const widerTarget = long ? entry + t1Distance * widerTargetMult : entry - t1Distance * widerTargetMult;
        // Pressure gate (2026-08-24, RESEARCH_CLAIM wider_target_pressure_gate_vs_always_extend):
        // buying/selling imbalance on THIS bar — only actually consulted by stepWiderTarget()
        // on the bar where T1 first hits, harmless to compute every bar since it's just a
        // ratio of two already-selected columns (sharedBarsRows includes bid_volume/ask_volume).
        const barTotalVol = (bar.bid_volume || 0) + (bar.ask_volume || 0);
        const pressureReading = barTotalVol > 0
          ? ((long ? bar.ask_volume : bar.bid_volume) - (long ? bar.bid_volume : bar.ask_volume)) / barTotalVol
          : null;
        const step = stepWiderTarget(
          widerTargetState,
          bar,
          {
            entry, stop, t1, widerTarget, long, barCount, maxBarsToT1: MAX_BARS_TO_T1_FOR_WIDER, firedMod,
            pressureReading, pressureThreshold: widerTargetPressureThreshold,
          }
        );
        widerTargetState = step.state;
        if (step.resolution) {
          resolution = step.resolution.resolution;
          method = step.resolution.method;
          resolvedAt = bar.ts;
          priceAtRes = step.resolution.priceAtRes;
        }

        // Step-trail shadow (Opus Audit #12, 2026-09-04) — observation-only, computed on
        // the SAME bar this real branch already fetched, using a fully independent state
        // object (never feeds back into resolution/method/priceAtRes above). Deliberately
        // NOT gated on `if (resolution) break` below — this call must still run on the
        // exact bar the real path resolves, since that's the bar the ratchet crossing (if
        // any) actually happens on. Fails closed: if no calibration exists yet, stepSize is
        // never computed and this whole block is skipped, matching stepWiderTarget()'s own
        // null-pressureThreshold no-op convention.
        // Wrapped defensively (matches the touch-quality side-effect block's own convention
        // elsewhere in this function) -- this is non-critical, observation-only, and must
        // NEVER be able to throw its way into blocking the REAL resolution logic below for
        // this row or any other row in this same poll.
        if (stepTrailCalib != null && !stepTrailShadowResolution && !stepTrailShadowDisabled) {
          try {
            const riskDist = Math.abs(widerTarget - entry);
            const effectiveBase = Math.max(riskDist, stepTrailCalib.p10BaseFloor);
            const stepSize = stepTrailCalib.frac * effectiveBase;
            const shadowStep = stepStepTrail(
              stepTrailShadowState,
              bar,
              {
                entry, stop, t1, widerTarget, long, barCount, maxBarsToT1: MAX_BARS_TO_T1_FOR_WIDER, firedMod,
                pressureReading, pressureThreshold: widerTargetPressureThreshold, stepSize,
              }
            );
            stepTrailShadowState = shadowStep.state;
            if (stepTrailShadowState.ratcheting && stepTrailShadowArmedAt == null) stepTrailShadowArmedAt = bar.ts;
            if (shadowStep.resolution) stepTrailShadowResolution = { ...shadowStep.resolution, resolvedAt: bar.ts };
          } catch (e) {
            // Leave stepTrailShadowResolution null (never written inline) and stop retrying
            // for THIS row only -- the follow-up completeStepTrailShadows() pass re-derives
            // the whole shadow from scratch independently anyway, so nothing is lost by
            // giving up here rather than risking a state-corrupted retry on the next bar.
            console.error('step-trail shadow computation error (non-critical, skipping shadow for this row):', e.message);
            stepTrailShadowDisabled = true;
          }
        }

        // Pitch and Catch shadow (user idea, 2026-09-04, UNVALIDATED -- see
        // server/services/pitchCatchWalker.js's header). Same non-critical, try/catch-
        // isolated, observation-only convention as the step-trail shadow block just above --
        // must never be able to block the REAL resolution logic below.
        if (pitchCatchCalib != null && !pitchCatchShadowResolution && !pitchCatchShadowDisabled) {
          try {
            const pcStep = stepPitchCatch(
              pitchCatchShadowState,
              bar,
              {
                entry, stop, t1, widerTarget, long, barCount, maxBarsToT1: MAX_BARS_TO_T1_FOR_WIDER, firedMod,
                pressureReading, pressureThreshold: widerTargetPressureThreshold,
                filterCalib: pitchCatchCalib, dailyAdx: dailyAdxByDate[row.trade_date] ?? null, origStop: stop,
              }
            );
            pitchCatchShadowState = pcStep.state;
            if (pcStep.resolution) pitchCatchShadowResolution = { ...pcStep.resolution, resolvedAt: bar.ts };
          } catch (e) {
            console.error('pitch-catch shadow computation error (non-critical, skipping shadow for this row):', e.message);
            pitchCatchShadowDisabled = true;
          }
        }

        if (resolution) break;
        continue;
      }

      const t1Hit = long ? bar.high >= t1 : bar.low <= t1;
      const stopHit = long ? bar.low <= stop : bar.high >= stop;
      if (t1Hit && stopHit) {
        // Conservative: assume stop hit first (worst case for the trader)
        resolution = 'STOP_HIT';
        method = 'SAME_BAR_STOP_FIRST';
        resolvedAt = bar.ts;
        priceAtRes = stop;
        break;
      } else if (t1Hit) {
        resolution = 'TARGET_HIT';
        // TRAIL_UNCALIBRATED (2026-08-24): this row was designated a _TRAIL variant but
        // has no working runner_trail_width -- see trailCalibrationMissing above. Fits
        // resolution_method's VARCHAR(20) (19 chars) -- checked, not assumed, per this
        // codebase's own VARCHAR-overflow history.
        method = trailCalibrationMissing ? 'TRAIL_UNCALIBRATED' : 'PRICE_CLEAN';
        resolvedAt = bar.ts;
        priceAtRes = t1;
        break;
      } else if (stopHit) {
        resolution = 'STOP_HIT';
        method = trailCalibrationMissing ? 'TRAIL_UNCALIBRATED' : 'PRICE_CLEAN';
        resolvedAt = bar.ts;
        priceAtRes = stop;
        break;
      }
    }

    // Persist the bar-6 checkpoint once bars 0-6 have actually been observed (the loop
    // above only reaches barCount>=7 for a touch that's genuinely still undecided at that
    // point — a fast STOP_HIT/TARGET_HIT breaks the loop earlier, which correctly means no
    // checkpoint is written, matching the research population exactly). Never overwritten
    // once set (WHERE bar6_checkpoint IS NULL), same convention as touch_quality below.
    //
    // Consolidated 2026-07-27 (formalize_trade_management_as_first_class_system): this used
    // to track worstAdverse6/worstAdverseBarIdx6/bar6Close inline, a second, independent
    // reimplementation of the exact same worst-bar-index-of-adverse-excursion logic already
    // in computeBar6Checkpoint() (maeMfeReplay.js, used by every backtest/verification
    // script). Both are mathematically equivalent (same argmax, same tie-break), but two
    // copies of one calculation is exactly the reimplementation-drift risk this codebase has
    // been burned by before — and in fact WAS the root cause of the persisted-vs-recomputed
    // mismatch found 2026-07-26 (bar6_checkpoint_persisted_vs_recomputed_mismatch, 3/121
    // rows, ~2.5%). `bars.rows` (the full bar array from fired_at) is already available
    // before this loop starts, so calling the shared function directly needs no restructure
    // of the main STOP_HIT/TARGET_HIT walk above — just one call after it, gated the same way
    // (barCount>=7 means the walk reached bar 7 without an early resolution breaking it).
    //
    // bar6_exit_recommended (added 2026-07-26) — RESEARCH_CLAIM
    // target_distance_predictor_real_data_validation_cleared: the frozen exit rule
    // (targetDistFraction < 0.873, computeExitRuleAtBar6 in maeMfeReplay.js) cleared its
    // N>=20 real-data validation bar (N=57, +$1,260 live-confirmed) — user asked for this to
    // become a distinct, more assertive "EXIT NOW" recommendation, not folded into the
    // existing passive RECOVERING/DETERIORATING badge. Still purely informational: this
    // system has no order/broker execution capability at all, so it can never auto-close a
    // position — only ever a stronger-worded recommendation than the existing checkpoint.
    if (barCount >= 7) {
      const bar6 = computeBar6Checkpoint(bars.rows, entry, stop, t1, long ? 'LONG' : 'SHORT', PNL_PER_POINT, COMMISSION);
      if (bar6) {
        await query(
          `UPDATE active_setups SET bar6_checkpoint=$2, bar6_exit_recommended=$3, updated_at=NOW() WHERE id=$1 AND bar6_checkpoint IS NULL`,
          [row.id, bar6.status, bar6.ruleSaysExit]
        ).catch(() => {});
      }
    }

    // Slow+deep adverse-grind early exit (RESEARCH_CLAIM slow_deep_adverse_grind_early_exit,
    // docs/SLOW_DEEP_EARLY_EXIT_SPEC.md, CONFIRMED 2026-08-30) -- same compute-once,
    // never-overwrite convention as bar6_checkpoint above, same `bars.rows` array. Unlike
    // bar6 (fixed bar-7 gate), this can trigger as early as bar 1 -- computeSlowDeepEarlyExit()
    // itself returns null until the trade genuinely crosses 75% of its own original stop
    // distance, so no extra barCount gate is needed here. Purely informational, same as
    // every other checkpoint in this loop -- this system has no order/broker execution
    // capability, so `slow_deep_exit_recommended` can never auto-close a position.
    {
      const slowDeep = computeSlowDeepEarlyExit(bars.rows, entry, stop, long ? 'LONG' : 'SHORT', getBetClass(row.setup_type));
      if (slowDeep) {
        await query(
          `UPDATE active_setups SET slow_deep_exit_speed=$2, slow_deep_exit_recommended=$3, updated_at=NOW() WHERE id=$1 AND slow_deep_exit_speed IS NULL`,
          [row.id, slowDeep.speed, slowDeep.ruleSaysExit]
        ).catch(() => {});
      }
    }

    // Cumulative-delta-confirmation badge (added 2026-07-28) — purely informational,
    // same "compute once, never overwrite" convention as bar6_checkpoint above. Scoped
    // exactly to what's been validated (RESEARCH_CLAIM cumulative_delta_confirms_
    // breakout_beyond_price_alone / cumulative_delta_confirms_fades_stronger_than_
    // breakout) — getDeltaConfirmationCategory() returns null for every setup_type NOT
    // covered (the "OTHER" session-structure family, Globex/overnight variants), so this
    // is a silent no-op for those until they have their own validated category. Does NOT
    // gate entry or adjust the target — both tested separately and failed
    // (pre_entry_cumulative_delta_no_entry_edge, target_extension_on_confirmation_not_actionable).
    {
      const deltaCategory = getDeltaConfirmationCategory(row.setup_type);
      const deltaThreshold = deltaCategory ? deltaCalib[deltaCategory] : null;
      if (deltaCategory && deltaThreshold != null) {
        const dc = classifyDeltaConfirmation(bars.rows, long ? 'LONG' : 'SHORT', entry, deltaThreshold);
        if (dc) {
          await query(
            `UPDATE active_setups SET delta_confirmation_state=$2, updated_at=NOW() WHERE id=$1 AND delta_confirmation_state IS NULL`,
            [row.id, dc.state]
          ).catch(() => {});
        }
      }
    }

    // Mark-to-market TIME_EXPIRED for the plain (non-trail) case: the trail branch
    // above already handles its own timeout via isSessionEnd, but this general branch
    // had no equivalent -- a setup that never hit stop/target just fell through to
    // expireStaleSetups() (a separate, later call in the same poll cycle), which force-
    // closes it with resolution='TIME_EXPIRED' and NEVER sets actual_pnl, leaving a
    // permanent null. Found 2026-07-20 while recovering 341 historical rows with this
    // exact shape (TRT_LONG/SHORT and 16 other setup_types) -- confirmed still live via
    // 42 more null rows, some fired as recently as 2026-07-17, proving this wasn't a
    // one-off from a deleted script but an ongoing structural gap. Fixed at the source:
    // once expires_at has passed and at least one real bar was seen, mark-to-market at
    // the last available bar's close instead of leaving the row for expireStaleSetups()
    // to null out. Genuinely bar-data-less rows (fired but price_bars_primary never got
    // a bar after) are left for expireStaleSetups() -- there's no price to mark against.
    if (!resolution && trailWidth == null && bars.rows.length > 0 && row.expires_at && nowEt >= row.expires_at) {
      const lastBar = bars.rows[bars.rows.length - 1];
      resolution = 'TIME_EXPIRED';
      // Same TRAIL_UNCALIBRATED tagging as the plain t1Hit/stopHit sites above -- this
      // row never got a working trail either, it just happened to time out instead of
      // hitting a level first.
      method = trailCalibrationMissing ? 'TRAIL_UNCALIBRATED' : 'MARK_TO_MARKET';
      resolvedAt = lastBar.ts;
      priceAtRes = lastBar.close;
    }

    // Touch-quality (order-flow) — informational only, side-effect UPDATE, never
    // influences resolution/pnl above or below. Fires once per setup, once its
    // calibrated reaction window has elapsed (or the setup resolves first,
    // whichever comes first). See server/services/touchQuality.js and
    // docs/OPEN_THREADS.md "Touch-quality" thread. Wrapped defensively — this is
    // non-critical, must never block real setup resolution if it throws.
    if (!row.touch_quality) {
      try {
        const calib = (await getTouchQualityCalib())[row.setup_type];
        const availableBars = resolution ? barCount : bars.rows.length;
        // Classify once the full calibrated window has elapsed, OR once the setup
        // resolves early (using whatever bars it actually got) — matches
        // scripts/calibrate_touch_quality.mjs's own windowing exactly. Previously
        // required availableBars >= calib.windowBars even when resolution had
        // already happened, so any trade resolving faster than its own type's
        // calibrated window (~25% of trades by construction, since the window is
        // that type's own p25 bars-to-resolution) got skipped this cycle, then
        // flipped to status='RESOLVED' and dropped out of the `active` query
        // forever — touch_quality stayed permanently NULL. Found in code review
        // 2026-07-15.
        if (calib && (resolution || availableBars >= calib.windowBars)) {
          const win = bars.rows.slice(0, Math.min(calib.windowBars, availableBars));
          let mae = 0, maeAtBar1 = null, maeAtWindowEnd = 0;
          win.forEach((bar, i) => {
            const adverse = long ? entry - bar.low : bar.high - entry;
            mae = Math.max(mae, adverse);
            if (i === 0) maeAtBar1 = mae;
            maeAtWindowEnd = mae;
          });
          const gaveFurtherGround = maeAtWindowEnd > (maeAtBar1 ?? 0) + 0.01;
          const baseline = await getTouchQualityBaseline(row.trade_date);
          const tq = classifyTouch({
            windowBars: win, direction: long ? 'LONG' : 'SHORT', baseline,
            highVolZCutoff: calib.highVolZCutoff, gaveFurtherGround,
          });
          if (tq) {
            await query(
              `UPDATE active_setups SET touch_quality=$2, touch_quality_vol_z=$3, updated_at=NOW() WHERE id=$1 AND touch_quality IS NULL`,
              [row.id, tq.bucket, Math.round(tq.maxVolZ * 100) / 100]
            );
          }
        }
      } catch (e) {
        console.error('touch-quality classification error (non-critical):', e.message);
      }
    }

    if (!resolution) {
      // Trail-eligible and armed but not yet resolved this poll: persist the in-progress
      // state purely for display (docs/SCALEOUT_RUNNER_SPEC.md §7 — the card should show
      // "armed, trailing Npt" once armedAt is set). Never read back as input — see the
      // comment on the `active` SELECT above.
      if (trailWidth != null && armedAt != null) {
        const newPeak = Math.round(peakPrice * 100) / 100;
        const newTrail = Math.round(trailStopPrice * 100) / 100;
        // Found 2026-07-27 (answering "how do I tell if a setup was modified"): this used
        // to fire unconditionally every ~15s poll while a trail is armed, regardless of
        // whether peak/trail actually moved -- if updated_at were added blindly here (as
        // it should be, to make updated_at a real "has this row changed" signal) it would
        // just track "last polled," not "actually ratcheted." Guarded so it's a no-op
        // (and updated_at stays put) when nothing has genuinely moved.
        await query(
          `UPDATE active_setups SET breakeven_armed_at=$2, runner_peak_price=$3, runner_trail_price=$4, updated_at=NOW()
           WHERE id=$1 AND (runner_peak_price IS DISTINCT FROM $3 OR runner_trail_price IS DISTINCT FROM $4 OR breakeven_armed_at IS DISTINCT FROM $2)`,
          [row.id, armedAt, newPeak, newTrail]
        ).catch(() => {});
      }
      // Bank-vs-extend eligible and now extending but not yet resolved this poll: persist
      // purely for display (so a future card can show "extending toward the wider target"),
      // same never-read-back-as-input convention as the trail state just above.
      if (extendTarget != null && extending) {
        await query(
          `UPDATE active_setups SET extend_decision='EXTENDING', updated_at=NOW() WHERE id=$1 AND extend_decision IS DISTINCT FROM 'EXTENDING'`,
          [row.id]
        ).catch(() => {});
      }
      continue;
    }

    // priceAtRes already holds the correct exit price for every resolution type above
    // (t1 for TARGET_HIT, stop for STOP_HIT, the ratcheted trail/breakeven price for
    // TRAIL_EXIT, the session-close price for TIME_EXPIRED) — one formula covers all of
    // them; this is not a behavior change for the pre-existing TARGET_HIT/STOP_HIT cases,
    // just a generalization to also cover the new trail-mechanism outcomes.
    const pnl = (long ? (priceAtRes - entry) : (entry - priceAtRes)) * PNL_PER_POINT - COMMISSION;

    // Step-trail shadow payload — only ever set when the real wider-target mechanism
    // actually armed (widerTargetState.widening===true at some point) AND the shadow ALSO
    // resolved within the same bars this poll already fetched. The far more common case
    // (armed but shadow still open when the real trade resolves) is deliberately left NULL
    // here and picked up by completeStepTrailShadows()'s follow-up pass on a later poll —
    // this row is about to leave the `active` WHERE status IN ('ACTIVE','SHADOW') query the
    // moment status flips to RESOLVED below, so there is no other chance to keep walking it
    // inline. Never touches resolution/method/actual_pnl/stop_level — observation-only.
    let stepTrailShadowPayload = null;
    try {
    if (widerTargetState.widening === true && stepTrailShadowResolution) {
      const shadowPts = long ? stepTrailShadowResolution.priceAtRes - entry : entry - stepTrailShadowResolution.priceAtRes;
      const shadowPnl = shadowPts * PNL_PER_POINT - COMMISSION;
      stepTrailShadowPayload = JSON.stringify({
        frac: stepTrailCalib.frac, armed_at: stepTrailShadowArmedAt,
        hypothetical_resolution: stepTrailShadowResolution.resolution, hypothetical_method: stepTrailShadowResolution.method,
        hypothetical_exit_price: stepTrailShadowResolution.priceAtRes, hypothetical_pnl: Math.round(shadowPnl * 100) / 100,
        real_pnl: Math.round(pnl * 100) / 100, delta: Math.round((shadowPnl - pnl) * 100) / 100,
        resolved_at: stepTrailShadowResolution.resolvedAt, completed_inline: true,
      });
    }
    } catch (e) {
      console.error('step-trail shadow payload error (non-critical, writing without it):', e.message);
      stepTrailShadowPayload = null;
    }

    // Pitch and Catch shadow payload -- same widening-armed gate as step-trail (never write
    // for a trade that never even reached the wider target). Written for BOTH a real
    // re-entry (qualified=true, real hypothetical_pnl) and a confirmed-but-filtered-out
    // pullback (qualified=false, hypothetical_pnl null) -- the unqualified case is still
    // useful monitoring signal (how often does a confirmed pullback pass the filter at all).
    let pitchCatchShadowPayload = null;
    try {
      if (widerTargetState.widening === true && pitchCatchShadowResolution) {
        let hypotheticalPnl = null;
        if (pitchCatchShadowResolution.qualified) {
          const pcPts = long ? pitchCatchShadowResolution.priceAtRes - pitchCatchShadowResolution.entryPrice
            : pitchCatchShadowResolution.entryPrice - pitchCatchShadowResolution.priceAtRes;
          hypotheticalPnl = Math.round((pcPts * PNL_PER_POINT - COMMISSION) * 100) / 100;
        }
        pitchCatchShadowPayload = JSON.stringify({
          qualified: pitchCatchShadowResolution.qualified,
          hypothetical_resolution: pitchCatchShadowResolution.resolution, hypothetical_method: pitchCatchShadowResolution.method,
          hypothetical_exit_price: pitchCatchShadowResolution.priceAtRes, hypothetical_entry_price: pitchCatchShadowResolution.entryPrice ?? null,
          hypothetical_pnl: hypotheticalPnl, real_pnl: Math.round(pnl * 100) / 100,
          delta: hypotheticalPnl != null ? Math.round((hypotheticalPnl - pnl) * 100) / 100 : null,
          resolved_at: pitchCatchShadowResolution.resolvedAt, direction: long ? 'LONG' : 'SHORT', completed_inline: true,
        });
      }
    } catch (e) {
      console.error('pitch-catch shadow payload error (non-critical, writing without it):', e.message);
      pitchCatchShadowPayload = null;
    }

    const updated = await query(`
      UPDATE active_setups
      SET status='RESOLVED', resolution=$2, resolution_method=$3, actual_outcome=$2,
          actual_pnl=$4, price_at_resolution=$5, resolved_at=$6, updated_at=NOW(),
          mae_points=$8, mfe_points=$9, bars_to_resolution=$10,
          resolution_bar_time=$6, replay_resolution=$2,
          breakeven_armed_at=COALESCE($11, breakeven_armed_at),
          runner_peak_price=COALESCE($12, runner_peak_price),
          runner_trail_price=COALESCE($13, runner_trail_price),
          step_trail_shadow=COALESCE($14::jsonb, step_trail_shadow),
          pitch_catch_shadow=COALESCE($15::jsonb, pitch_catch_shadow)
      WHERE id=$1 AND status=$7
      RETURNING *
    `, [row.id, resolution, method, Math.round(pnl * 100) / 100, priceAtRes, resolvedAt, statusMatch,
        Math.round(runMae * 100) / 100, Math.round(runMfe * 100) / 100, barCount,
        armedAt, peakPrice != null ? Math.round(peakPrice * 100) / 100 : null,
        trailStopPrice != null ? Math.round(trailStopPrice * 100) / 100 : null,
        stepTrailShadowPayload, pitchCatchShadowPayload]);

    if (updated.rows.length) {
      try { await dropToTimeline(updated.rows[0]); } catch (_) {}
      if (io) io.emit('setup-resolved', {
        setupId: row.id, setupType: row.setup_type, tradeDate: row.trade_date,
        resolution, resolutionMethod: method, actualPnl: updated.rows[0].actual_pnl,
      });
      count++;
    }
  }
  return count;
}
