// acd.js risk-discipline gate cluster — extracted 2026-09-27 (acd.js file-size reduction,
// opportunistic pass beyond docs/ACDJS_FILE_SIZE_REDUCTION_SPEC.md's original Phase A/B scope).
// This is the "risk-discipline gates" region that was already textually standalone in acd.js
// (module-level functions declared BEFORE createACDRouter() even begins, at lines 137-841 of
// the pre-extraction file) — same shape as buildAllCandidates()/computeLevelFadeFactors()
// (already moved to acdCandidateBuilder.js 2026-09-20): no closure over req/res/io/liveStats/
// acdJob, only module-level imports and its own local consts. Confirmed via exhaustive grep of
// every declared name against the whole file before moving (per CLAUDE.md's standing rule on
// this exact extraction shape) — the ONLY two module-level consts textually adjacent to this
// block that do NOT belong here were left behind in acd.js: STOP_SWEEP_PAUSED and
// _dtaGateLogged, both referenced only deep inside runSetupDetection (~lines 5468/7344 of the
// pre-extraction file), never inside this cluster's own functions.
//
// Covers 4 independent live risk-discipline mechanisms plus their SHADOW-only observation
// twins: the cross-direction fast-flip gate, the post-win opposite-family ("sibling reversal")
// gate, the single-firing directional-conflict gate, the same-setup-type refire gate, the
// direction-loss-alternation SHADOW tag, the plain refire cooldown + shadow-noise-suppression
// dedup, session-bars-since-open, and the momentum-against-fade SHADOW tag. See each function's
// own header comment (preserved verbatim below) for the real backtest/validation history —
// nothing here is summarized or reworded, this is a straight relocation with zero logic change.
//
// Re-exported from acd.js (server/routes/acd.js) for its existing external consumers that
// import these names via `from '../routes/acd.js'` (ibLowPnrDetector.js, detectorLiveGates.js,
// entryOrderFlowShadow.js, sessionVolumeMonitor.js, antigravityEdges.js) — those import paths
// were deliberately left unchanged rather than touching 5 more files in the same pass.

import { query } from '../db.js';
import { getCached, setCached, getGlobalCalib, DAY_CACHE_TTL } from './acdShared.js';
import { resolveDirection } from '../config/setupTypes.js';

// Re-fire cooldown (2026-08-03) — gates a NEW candidate to SHADOW/skip if the SAME
// setup_type resolved within the last N minutes today. IB_BEARISH: 30min is
// backtest-validated (RESEARCH_CLAIM ib_bearish_refire_cooldown_beats_volz_gate,
// PROVISIONAL — rigor-clean, not yet independently replicated) — real finding:
// "re-firing repeatedly in one day is itself the problem" (EV degrades by
// within-day fire number), and a blind cooldown performs at least as well as a
// bespoke volume gate, so the simple fix is the right shape. VWAP_MAGNET family:
// precautionary, not independently backtested for its own EV — historical
// backfill directly showed the same unbounded-rapid-refire pattern on trend days
// (scripts/backtest_vwap_magnet.mjs: 2025-11-20, 107 of 1158 VWAP_MAGNET_LONG
// backfilled fires from repeated ~2-bar-apart stop-outs in one session), same
// shape of problem as the validated IB_BEARISH fix (OPEN_DECISION
// vwap_magnet_repeated_whipsaw_on_trend_days). IB_BULLISH re-added 2026-08-19
// (DeepSeek Phase-0 design review) — its prior exclusion cited "globally
// SUPPRESSed today anyway," which went stale once IB_BULLISH moved under
// CAPITAL_EXPOSURE_OVERRIDE (an explicitly temporary, revisit-gated brake, not a
// permanent suppression). STOP_SWEEP_LONG/C_PAIRED_SHORT added 2026-08-19 (found
// investigating a live "everything says expired" report): confirmed 62/71 real
// fires each over the trailing 7 days, ~93% TIME_EXPIRED — the exact same
// unbounded-rapid-refire shape as the already-validated types, precautionary
// same-family default, not independently backtested for either.
//
// HOISTED to module scope 2026-08-19 (was previously declared inside the request
// handler, only reachable by the single `active`/main-banner candidate's own
// insert path) — found live: the shadowCandidates insert loop (~line 8940, where
// IB_BEARISH/STOP_SWEEP_LONG/C_PAIRED_SHORT actually fire from in practice, not
// the `active` slot) never checked this cooldown at all, so it was structurally
// dead for anything that fires as a shadow candidate rather than winning the
// single `active` pick — which is most of the time for these types. This is why
// IB_BEARISH kept machine-gunning despite already being "covered" by this map.
// EXTENDED 2026-09-01 (user-flagged live dashboard pattern, GLOBEX_VWAP_MAGNET_LONG and
// OR5_MID/LOW_FADE_SHORT refiring repeatedly and losing): added PD_VAH_FADE_SHORT and the OR5
// family after confirming the exact same signature (real refires within 30min of the prior
// resolution lose decisively worse than fresh touches) via direct query against real ACTIVE
// trades -- PD_VAH_FADE_SHORT: refire WR=25.0%/EV=-$16.50 (N=12) vs baseline WR=53.6%/EV=+$8.23
// (N=28), 24 distinct days; OR5 family: refire WR=16.7%/EV=-$46.33 (N=6) vs baseline
// WR=50.0%/EV=+$10.21 (N=48), 18 distinct days. GLOBEX_VWAP_MAGNET_LONG/SHORT were already
// listed here but this map alone was NEVER SUFFICIENT for them -- see the dead-config-gap fix
// where detectGlobexSetup() is wired to actually call isInRefireCooldown() (it previously had its
// own, much narrower re-arm-on-resolution check and never consulted this map at all).
export const REFIRE_COOLDOWN_MINUTES = {
  IB_BEARISH: 30, IB_BULLISH: 30,
  VWAP_MAGNET_LONG: 30, VWAP_MAGNET_SHORT: 30,
  GLOBEX_VWAP_MAGNET_LONG: 30, GLOBEX_VWAP_MAGNET_SHORT: 30,
  STOP_SWEEP_LONG: 30, C_PAIRED_SHORT: 30,
  PD_VAH_FADE_SHORT: 30,
  OR5_MID_FADE_LONG: 30, OR5_MID_FADE_SHORT: 30,
  OR5_LOW_FADE_LONG: 30, OR5_LOW_FADE_SHORT: 30,
  OR5_HIGH_FADE_LONG: 30, OR5_HIGH_FADE_SHORT: 30,
};

// Cross-direction fast-flip gate (2026-09-01/02, user-spotted live whipsaw:
// GLOBEX_VWAP_FADE_LONG hit T1 07:35, GLOBEX_VWAP_FADE_SHORT fired 07:37 -- 2 minutes later,
// 22 minutes before the LONG even resolved -- and stopped out). REFIRE_COOLDOWN_MINUTES above
// only ever gates the SAME setup_type re-firing itself; it does nothing for the OPPOSITE
// direction of the same underlying level firing while the first is still open, which is a
// structurally different failure mode (holding both sides of the same trade idea at once).
//
// GENERALIZED 2026-09-02 (user pushback: a single hardcoded family was exactly the
// hardcoded-list-goes-stale anti-pattern this codebase avoids everywhere else, and "anything
// in live should be in all trades where applicable"). scripts/backtest_cross_direction_fast_
// flip.mjs (weekly) tests EVERY real paired-direction family (derived from live data, not a
// hardcoded list) for the same fast/medium/slow-flip gradient found for GLOBEX_VWAP_FADE
// (RESEARCH_CLAIM globex_vwap_fade_fast_flip_underperforms: <=5min N=22 EV=-$7.55 vs 5-15min
// EV=$0.09 vs >15min EV=+$13.11), and writes a real calibrated cooldown to performance_audit
// (signal_type='CROSS_DIRECTION_FLIP_CALIB') only when a family's own fast bucket clears N>=20
// AND shows the same monotonic shape. EXTENDED same day: a rare/new family can never clear that
// per-family floor on its own (confirmed live: PM_VAL_FADE whipsawed unprotected at only 4 real
// SHORT-side trades; "the monthly setups dont happen often" -- user), so the same script also
// writes one pooled/system-wide default row (signal_name='_POOLED_ALL', every real overlap
// instance across every base pooled together, N=366/fast N=85 on first run, GATE-justified) --
// isCrossDirectionFastFlip() below falls back to this pooled default whenever a family has no
// row of its own, so every family is covered from its first live fire, not just the ones with
// enough individual history. Read live here, cached per day -- fail-open (no gate at all) only
// when even the pooled default isn't GATE-justified, since a false negative (missing a real
// pattern) is far lower-risk than a false positive (blocking a good trade on no evidence) for a
// mechanism that gates live capital. A gated candidate is NOT skipped outright -- see the call
// site below, which forces it to SHADOW instead of continuing past insertion entirely, so real
// outcome data keeps accumulating on exactly the trades this gate holds back (the only way to
// actually verify later whether it's still helping, not silently costing good trades).
async function getCrossDirectionFlipCalib(tradeDate) {
  const cached = getCached(tradeDate, 'crossDirectionFlipCalib', DAY_CACHE_TTL);
  if (cached) return cached;
  const r = await query(`
    SELECT DISTINCT ON (signal_name) signal_name, recommendation, notes
    FROM performance_audit WHERE signal_type='CROSS_DIRECTION_FLIP_CALIB'
    ORDER BY signal_name, run_date DESC
  `);
  const map = {};
  for (const row of r.rows) {
    if (row.recommendation !== 'GATE') continue;
    try { map[row.signal_name] = JSON.parse(row.notes).cooldownMinutes; } catch (_) {}
  }
  return setCached(tradeDate, 'crossDirectionFlipCalib', map);
}

export async function isCrossDirectionFastFlip(tradeDate, levelBase, dir) {
  const calib = await getCrossDirectionFlipCalib(tradeDate);
  // Family-specific GATE row takes precedence; otherwise fall back to the pooled/system-wide
  // default (signal_name='_POOLED_ALL', scripts/backtest_cross_direction_fast_flip.mjs) so a
  // rare or brand-new family (never individually clears the N>=5-per-direction floor to even be
  // assessed on its own -- confirmed live: PM_VAL_FADE whipsawed unprotected, monthly-cadence
  // setups may never accumulate enough of their own history) is still covered from its first
  // live fire. Same blended-default-with-specific-override pattern this codebase already uses
  // for OPTIMAL_STOP. User: "I wanted all setups on there. I can't track 170 setups for
  // something like this."
  const cooldownMin = calib[levelBase] ?? calib['_POOLED_ALL'];
  if (!cooldownMin) return false;
  const oppositeDir = dir === 'LONG' ? 'SHORT' : 'LONG';
  // OR-length families (OR5/OR10/OR15/OR30_{HIGH,LOW,MID}_FADE) structurally nest -- OR10's
  // window always contains OR5's, OR15's always contains OR10's -- so an opposite-direction fire
  // under a DIFFERENT OR-length label can still be the same real level and the same whipsaw this
  // gate exists to catch. CORRECTED 2026-09-02 (DeepSeek review): the "frequently the exact same
  // price" justification is strong for HIGH (69.2% same-price on the full 13-day OR10/15/30
  // history, since 2026-08-12 -- there is no longer window, this IS all the data for those
  // lengths), moderate for LOW (38.5%/61.5%), and WEAK for MID (15.4%/30.8%/7.7% -- MID=(HIGH+LOW)/2
  // needs both extremes unchanged and isn't even monotone across lengths). The nesting/"same
  // underlying idea" argument carries LOW and MID more than literal price equality does; broadening
  // is query-only and SHADOW-only regardless (no capital skipped, real outcome data still
  // accumulates), so this remains a reasonable default even where the same-price rate is weaker.
  // Broadening is gated on the calibration actually coming from the _POOLED_ALL fallback (not a
  // per-family row) -- DeepSeek review found the original unconditional-on-orMatch version would
  // silently misapply a FUTURE per-family GATE row (calibrated by
  // scripts/backtest_cross_direction_fast_flip.mjs on bare-per-length-only overlaps) to a
  // broader cross-length query it was never measured against. Calibration lookup above is
  // otherwise unchanged (still keyed by the bare per-length family) -- a dedicated OR-length-pooled
  // backtest (2026-09-02) found the pooled EV pattern real-but-too-thin (fast bucket N=4, need
  // N>=20) to justify its own calibrated row; this fix only broadens which OPEN candidates count
  // as "the opposite" while on the pooled-fallback path, letting the already GATE-justified
  // _POOLED_ALL default apply to these cross-length pairs instead of missing them entirely.
  const orMatch = levelBase.match(/^OR\d+_(HIGH|LOW|MID)_FADE$/);
  const usingPooledFallback = calib[levelBase] === undefined;
  const oppositePattern = (orMatch && usingPooledFallback)
    ? `^OR[0-9]+_${orMatch[1]}_FADE_${oppositeDir}$`
    : `^${levelBase}_${oppositeDir}$`;
  const q = await query(`
    SELECT 1 FROM active_setups
    WHERE trade_date = $1 AND setup_type ~ $2
      AND status IN ('ACTIVE', 'SHADOW')
      AND fired_at > NOW() - ($3::int * INTERVAL '1 minute')
    LIMIT 1
  `, [tradeDate, oppositePattern, cooldownMin]).catch(() => ({ rows: [] }));
  return q.rows.length > 0 ? cooldownMin : false;
}

// "Sibling reversal" gate (2026-09-02, user-spotted live on quick-check.html + user-designed
// rule, phase-0 design critique by DeepSeek, 2 real bugs found and fixed in the backtest before
// wiring -- see docs/OPEN_THREADS.md's 2026-09-02 entry for the full derivation). Distinct from
// isCrossDirectionFastFlip() above: that gate is a fixed TIME window and fires regardless of
// whether the first trade won or lost; this one is OUTCOME-conditioned (only triggers after a
// real TARGET_HIT) and duration-based on a DIFFERENT FAMILY firing, not a fixed number of
// minutes. User's rule, verbatim: "the very next trade cannot be from the same family in the
// opposite direction" after a win, "until a different family setup fires first" -- the original
// winning direction can keep firing regardless.
//
// SHADOW counts the same as ACTIVE for both arming (a SHADOW win still triggers the block) and
// resetting (a SHADOW-origin different-family fire still clears it) -- explicit user decision,
// since quick-check.html shows both on the same timeline with no visual distinction and the
// user's own words were "I don't want sibling trades to fire," not "I don't want sibling trades
// to fire only when real money was on the line." Non-directional signals (IB_BULLISH,
// ZONE_EDGE_FADE, etc -- no LONG/SHORT pairing) are invisible to this check either way: they
// can't arm it, can't be blocked by it, and don't count as "a different family" for the reset
// (explicit user decision after finding 3 of 30 backtested cases hinged on this exact question --
// "no we're done with ib bullish bearish").
//
// Backtested (scripts/backtest_post_win_opposite_family_reversal.mjs, corrected twice -- fired-
// vs-resolved-order timing per DeepSeek's design critique, then a _TRAIL/_GAP_*/_OVERNIGHT
// suffix population gap per user pushback): N=30 real historical matches, EV -$36.36/trade,
// total -$1,090.75, rigor-clean (18 distinct dates, not clustered, no chronological sign
// reversal). Real-money (ACTIVE-only) slice is thin (N=3, +$95.75) -- user explicitly chose to
// wire this for ALL trades regardless, not just the ACTIVE-only slice, so SHADOW data keeps
// accumulating on exactly what this gate holds back going forward, the same "force SHADOW, don't
// skip" convention as every other gate in this file.
export function postWinFamilyOf(setupType) {
  return setupType.replace(/_(TRAIL|GAP_UP|GAP_DOWN|OVERNIGHT)$/, '').replace(/_(LONG|SHORT)$/, '');
}
export async function isPostWinOppositeFamilyBlocked(tradeDate, family, dir) {
  const oppositeDir = dir === 'LONG' ? 'SHORT' : 'LONG';
  // Most recent real win (ACTIVE or SHADOW) in the OPPOSITE direction of this family --
  // suffix-stripped setup_type must equal exactly `${family}_${oppositeDir}`.
  const winQ = await query(`
    SELECT resolved_at::text AS resolved_at FROM active_setups
    WHERE trade_date = $1 AND origin_status IN ('ACTIVE','SHADOW')
      AND resolution = 'TARGET_HIT' AND resolved_at IS NOT NULL
      AND regexp_replace(setup_type, '_(TRAIL|GAP_UP|GAP_DOWN|OVERNIGHT)$', '') = $2
    ORDER BY resolved_at DESC LIMIT 1
  `, [tradeDate, `${family}_${oppositeDir}`]).catch(() => ({ rows: [] }));
  if (!winQ.rows.length) return false;
  const winResolvedAt = winQ.rows[0].resolved_at;
  // Has any DIFFERENT family's real directional trade (ACTIVE or SHADOW) fired since that win?
  // Non-directional types (no _LONG/_SHORT suffix even after stripping TRAIL/GAP/OVERNIGHT) are
  // invisible here -- they don't count as "a different family firing" (explicit user decision).
  const resetQ = await query(`
    SELECT 1 FROM active_setups
    WHERE trade_date = $1 AND fired_at > $2 AND origin_status IN ('ACTIVE','SHADOW')
      AND regexp_replace(setup_type, '_(TRAIL|GAP_UP|GAP_DOWN|OVERNIGHT)$', '') ~ '_(LONG|SHORT)$'
      AND regexp_replace(regexp_replace(setup_type, '_(TRAIL|GAP_UP|GAP_DOWN|OVERNIGHT)$', ''), '_(LONG|SHORT)$', '') != $3
    LIMIT 1
  `, [tradeDate, winResolvedAt, family]).catch(() => ({ rows: [] }));
  return resetQ.rows.length === 0; // still blocked if nothing else real has fired since the win
}

// Directional-conflict gate (2026-09-03, docs/SINGLE_FIRING_DIRECTIONAL_CONFLICT_SPEC.md).
// Rule (user-confirmed): multiple concurrent REAL positions in the SAME direction are fine (they
// just stack), but a NEW real fire whose direction is OPPOSITE any currently-open REAL position
// should force SHADOW instead -- a real single account can't hold a long and a short on the same
// instrument without them netting against each other. Scoped to origin_status='ACTIVE' only (real
// capital) -- a SHADOW-origin position carries no capital, so it can't structurally conflict with
// anything. No trade_date scoping: a real position can stay open past midnight (verified: a real
// C_PAIRED_LONG held >24hrs, TIME_EXPIRED at $1958), so "currently open" means globally unresolved
// right now, not "opened today." Direction is read via the canonical resolveDirection() (price-
// derived from the row's own stop_level/t1_level, cross-checked against the name) rather than
// inferDirection(setup_type) alone, since a handful of setup_types are name-directionless
// (CONTEXTUAL_DIRECTION_TYPES) and only resolveDirection() handles those correctly.
//
// Tested (RESEARCH_CLAIM opposite_direction_hold_vs_switch_20260903, CONFIRMED, N=1316): when a
// conflict occurs, holding the already-open position beats exiting it to take the new signal, by
// $3.09/case -- this is what justifies "force SHADOW" (hold what's open) over "close the open
// position and let the new one through." Account-level impact of the gate itself is negligible
// (RESEARCH_CLAIM directional_conflict_gate_account_impact_20260903, PROVISIONAL, N=20 real
// conflicts historically, -$41 total) -- this is risk-discipline, not a return-improving change.
//
// WIRED TO 4 REAL INSERT SITES as of 2026-09-03 (Globex, STACK_VOL_BREAK_LIVE,
// the RTH main active-slot path, and the shadowCandidates loop) -- added one site at a time per
// explicit user request to test on a single firing mechanism before extending further, starting
// with the RTH main path (this codebase's highest-volume live insert site).
// CORRECTED 2026-09-29 (DeepSeek code review, wiring the ML VETO gate): this comment previously
// claimed the other 2 raw `INSERT INTO active_setups` sites (suppressed-near-level-audit,
// early-touch-backfill) are "hardcoded always-SHADOW/EXPIRED and structurally can never produce
// a real ACTIVE row" -- that was true when written but went stale on 2026-09-28, one day before
// this correction: both sites gained a real ACTIVE-promotion path under SUPPRESS_ALL_DISABLED
// (`auditCanPromote`/`btCanPromote`, gated on `suppressAllDisabledOverrides()` in
// setupEligibility.js). SUPPRESS_ALL_DISABLED is currently `enabled: false` (disabled
// 2026-09-28), so today these 2 sites are STILL SHADOW-only in practice -- but the "structurally
// can never" wording is no longer accurate, and neither this gate nor isSameSetupRefireBlocked
// nor the ML VETO gate (mlLiveVetoGate.js) are wired to either site. See OPEN_DECISION
// audit_sites_gain_active_path_gate_coverage_gap_20260929 for the real, currently-dormant
// coverage gap this creates if SUPPRESS_ALL_DISABLED is ever re-enabled. See
// docs/SINGLE_FIRING_DIRECTIONAL_CONFLICT_SPEC.md and OPEN_DECISION
// single_firing_directional_conflict_gate_not_built (now just tracking the design/code-review pass
// the full rollout should still get, already reviewed once by DeepSeek 2026-09-03).
export async function isOppositeDirectionOpen(direction) {
  if (!direction) return false; // candidate itself has no resolvable direction -- can't conflict
  const oppositeDir = direction === 'LONG' ? 'SHORT' : 'LONG';
  const { rows } = await query(`
    SELECT setup_type, stop_level, t1_level FROM active_setups
    WHERE origin_status = 'ACTIVE' AND resolved_at IS NULL
  `).catch(() => ({ rows: [] }));
  return rows.some(r => resolveDirection(r) === oppositeDir);
}

// Same-setup-type "refire gate" (2026-09-13, OPEN_DECISION same_type_refire_gate_live_wiring_
// pending). Generalizes isPostWinOppositeFamilyBlocked()'s event-based mechanism (blocked until
// a DIFFERENT setup fires, never a fixed-minute timer) to the SAME exact setup_type re-firing,
// instead of opposite-direction. Calibrated by scripts/backtest_same_setup_refire_gate.mjs
// (daily cron, signal_type='SAME_TYPE_REFIRE_GATE_CALIB'), per (setup_type, RTH/GLOBEX session)
// with a pooled _POOLED_ALL_RTH/_POOLED_ALL_GLOBEX fallback -- same blended-default pattern as
// isCrossDirectionFastFlip()'s _POOLED_ALL. First real GATE row (stable across 9 days of nightly
// recalibration through 2026-09-11, _POOLED_ALL_RTH only): N=335 blocked real trades,
// blockedEv=-$8.54 vs allowedEv=-$0.19, distinctDates=41, NOT day-clustered
// (computeRigor().clustered -- top5DayPct fell from 59% on 2026-09-03 to 49.9% by 2026-09-11 as
// more data accumulated, a genuinely stabilizing signal, not a one-day fluke). No individual
// (setup_type, session) row has cleared GATE yet, and _POOLED_ALL_GLOBEX has not either.
//
// BLOCKING DEFINITION -- deliberately unscoped by trade_date, matching the calibration script's
// own SQL exactly (see that file's header for the full derivation, including the exact-tie-
// boundary bug it corrects): for a live candidate about to fire, blocked iff the most recent
// REAL (same `real_trades` population the calibration script itself uses -- origin_status IN
// ACTIVE/SHADOW, resolution IN TARGET_HIT/STOP_HIT/TIME_EXPIRED, actual_pnl NOT NULL -- not a
// looser filter) SAME-setup_type trade has resolved, AND no real DIFFERENT-setup_type trade
// (same population) has fired since. No explicit upper bound is needed on the "has anything
// fired since" query the way the calibration's `d.fired_at < t.fired_at` needs one -- live,
// "now" already caps it, since nothing can have a fired_at in the future.
//
// Phase-0 DeepSeek design critique (2026-09-13, scratch/deepseek_response.md) confirmed this
// simplification is mathematically equivalent to the calibration's own EXISTS/NOT EXISTS chain-
// walk, found isDirectionLossBlocked() (~line 392) is a direct precedent for an unscoped "most
// recent resolution" query already living in this hot path (so an index on
// (setup_type, resolved_at DESC), not trade_date-scoping, is the right mitigation if this ever
// shows up as slow -- isDirectionLossBlocked's own equivalent query has run unindexed since
// 2026-09-05 with no reported issue), and caught that an earlier draft of this function had
// silently dropped the resolution/actual_pnl filter the calibration script requires -- fixed
// below before this was ever wired live, not caught after the fact.
//
// KNOWN LIMITATION (same DeepSeek pass): at the RTH main active-slot path only
// (skipRedundantShadowInsert, ~line 9381), a candidate this gate forces to SHADOW gets silently
// SKIPPED instead of inserted whenever a same-type trade also resolved within the last
// SHADOW_NOISE_SUPPRESSION_MINUTES (5min) -- and this gate's own trigger condition (a same-type
// trade JUST resolved) is maximally correlated with exactly that window, more so than any of the
// other 3 force-SHADOW gates. So this gate's real-time outcome data will be systematically
// thinner at that one site than the "force SHADOW, don't skip" convention intends. Deliberately
// NOT special-cased around skipRedundantShadowInsert -- that mechanism exists to prevent a real,
// previously-shipped duplicate-row flood (2026-08-20 incident, see its own header comment above),
// and bypassing it just for this gate would reintroduce that bug. The shadowCandidates loop (the
// higher-volume site most level-fade candidates actually fire ACTIVE from) has no such skip and
// is unaffected, so outcome data still accumulates there.
async function getSameTypeRefireGateCalib(tradeDate) {
  const cached = getCached(tradeDate, 'sameTypeRefireGateCalib', DAY_CACHE_TTL);
  if (cached) return cached;
  const r = await query(`
    SELECT DISTINCT ON (signal_name) signal_name, recommendation
    FROM performance_audit WHERE signal_type='SAME_TYPE_REFIRE_GATE_CALIB'
    ORDER BY signal_name, run_date DESC
  `);
  const gated = new Set();
  for (const row of r.rows) if (row.recommendation === 'GATE') gated.add(row.signal_name);
  return setCached(tradeDate, 'sameTypeRefireGateCalib', gated);
}

// Same real_trades population scripts/backtest_same_setup_refire_gate.mjs's CTE requires --
// shared between both queries below so they can never drift apart from each other or from the
// calibration script's own filter.
const SAME_TYPE_REFIRE_REAL_TRADE_FILTER = `
  origin_status IN ('ACTIVE','SHADOW')
  AND resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED')
  AND actual_pnl IS NOT NULL AND resolved_at IS NOT NULL
`;

export async function isSameSetupRefireBlocked(tradeDate, setupType, session) {
  const gated = await getSameTypeRefireGateCalib(tradeDate);
  if (!gated.has(`${setupType}_${session}`) && !gated.has(`_POOLED_ALL_${session}`)) return false;

  const lastQ = await query(`
    SELECT resolved_at::text AS resolved_at FROM active_setups
    WHERE setup_type = $1 AND ${SAME_TYPE_REFIRE_REAL_TRADE_FILTER}
    ORDER BY resolved_at DESC LIMIT 1
  `, [setupType]).catch(() => ({ rows: [] }));
  if (!lastQ.rows.length) return false;

  const resetQ = await query(`
    SELECT 1 FROM active_setups
    WHERE setup_type != $1 AND ${SAME_TYPE_REFIRE_REAL_TRADE_FILTER}
      AND fired_at > $2
    LIMIT 1
  `, [setupType, lastQ.rows[0].resolved_at]).catch(() => ({ rows: [] }));
  return resetQ.rows.length === 0;
}

// Direction-loss-alternation gate (2026-09-05, user-requested and tested before wiring --
// RESEARCH_CLAIM direction_alternation_after_loss_gate_20260905, OPEN_DECISION
// direction_alternation_after_loss_gate_pending). Roster-wide, event-based (no fixed timer):
// whichever direction's most recent real resolution was a LOSS is blocked; a WIN blocks the
// OPPOSITE direction instead. Stays engaged for however long it takes the other side to lose --
// minutes or, per the real 2026-09-03/04 overnight session this was validated against (13 real
// SHORT losses across 6 different setup_types while every real LONG won, net -$657.50 --
// replaying that exact sequence through this rule turns it into +$194.50), several hours --
// SESSION-SCOPED since 2026-09-14 (see currentSessionStartET()'s own comment below for why:
// this validation was itself drawn from within one continuous session, and carrying a signal
// across the RTH->Globex boundary was never specifically tested).
//
// SHADOW-ONLY / OBSERVATION-ONLY (user's explicit final call 2026-09-05, after an initial
// "wire it live" request was walked back once the honest caveat below was in front of them):
// this function and tagDirectionGateShadow() below NEVER change a real candidate's ACTIVE/SHADOW
// eligibility or touch a real trade's resolution/actual_pnl. They only annotate each real row,
// after it's already been inserted, with what this rule WOULD have done -- same risk posture as
// step_trail_shadow/pitch_catch_shadow. Live enforcement is a separate, not-yet-made decision
// (OPEN_DECISION direction_alternation_after_loss_gate_pending).
//
// HONEST CAVEAT this decision was made with in view: full account history is NOT uniformly
// supportive. Excluding the 6 already-suppressed setup_types, the effect is real and stable on a
// 3-way chronological split (N=103, not day-clustered), but a stricter 2-way walk-forward split
// showed it was flat (EV~$0) in the FIRST half of history and only strongly negative (EV-$17.52)
// in the SECOND half -- i.e. this has been true recently, not provably forever. Self-recalibrates
// via scripts/backtest_direction_alternation_after_loss.mjs (daily) -- if the recent effect
// itself decays, that script's next run will show it, which is also the evidence a future
// decision to actually enforce this live should be checked against first.
// SESSION-SCOPED as of 2026-09-14 (user-caught live: the first real Globex trade of the
// evening -- GLOBEX_VWAP_FADE_LONG @ 6:59pm -- showed wouldBeBlocked:true, carried over from
// an RTH trade that had resolved at 6:17pm, before that day's Globex session had even begun).
// Was previously fully unscoped ("most recent resolution, ever, regardless of session" --
// confirmed deliberate at the time: "Roster-wide, event-based (no timer)... no trade_date
// scoping"), but the mechanism's own validation evidence (13 real SHORT losses across 6
// setup_types in the 2026-09-03/04 overnight session, RESEARCH_CLAIM
// direction_alternation_after_loss_gate_20260905) was drawn entirely from WITHIN one
// continuous session -- it never specifically tested or validated that a signal should carry
// ACROSS the RTH->Globex boundary. User's explicit call: the first trade of a new session
// should start fresh, not inherit the prior session's last outcome.
//
// CORRECTED same day, before shipping: an initial version scoped by resolved_at >= today's
// 6pm -- verified DIRECTLY against the exact real case that motivated this fix, and it would
// NOT have worked. The offending row (FLOOR_R1_FADE_SHORT_TRAIL) FIRED at 4:55pm (RTH/dead-
// zone) but didn't RESOLVE until 6:17pm -- 17 minutes into the Globex clock -- so a
// resolved_at-based boundary still included it. The real distinction the user wants is which
// session the ORIGIN TRADE belongs to, not when its outcome happened to become known. Fixed
// by classifying every candidate row's OWN fired_at against the same RTH/Globex boundary used
// for "now" (SQL EXTRACT, matching sessionBoundary.js's isFiredInRTH() 570-960 definition,
// with the 960-1080 dead zone bucketed as RTH-adjacent since no new candidate ever fires
// there -- anything resolving in that window is leftover RTH activity, not a genuine Globex
// event) -- only a same-session prior row can now block a new candidate. Re-verified against
// the exact real case: FLOOR_R1_FADE_SHORT_TRAIL's fired_at (16:55, in [570,1080)) no longer
// matches a Globex-session "now" (>=1080 or <570), so it's correctly excluded.
//
// SHADOW-only/observation-only either way -- never touches a real trade's ACTIVE/SHADOW
// eligibility, so this changes what the DirGate tag SHOWS, not what fires live. Self-
// contained (computes "now" itself) rather than threaded through the 4 call sites' already-
// inconsistent local variable names (sessionDate vs todayET).
// Exported 2026-09-16 (entryOrderFlowShadow.js reuse) -- DeepSeek's design-critique review of
// that mechanism flagged that this codebase already carries 2 different "RTH" boundary
// definitions (this one, 570-1080; sessionBoundary.js's isFiredInRTH, 570-960) and a 3rd,
// narrower one would make it 3 -- re-exporting this exact string rather than letting a new
// consumer re-derive its own copy is the fix, per "export the real function."
export const RTH_SESSION_FIRED_AT_SQL = `(EXTRACT(hour FROM fired_at)*60 + EXTRACT(minute FROM fired_at)) >= 570 AND (EXTRACT(hour FROM fired_at)*60 + EXTRACT(minute FROM fired_at)) < 1080`;
export async function isDirectionLossBlocked(direction) {
  if (!direction) return false;
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const nowEtMin = nowET.getHours() * 60 + nowET.getMinutes();
  const nowIsRTH = nowEtMin >= 570 && nowEtMin < 1080;
  const sessionFilter = nowIsRTH ? RTH_SESSION_FIRED_AT_SQL : `NOT (${RTH_SESSION_FIRED_AT_SQL})`;
  const { rows } = await query(`
    SELECT stop_level, t1_level, actual_pnl::float AS actual_pnl
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW') AND resolved_at IS NOT NULL AND actual_pnl IS NOT NULL
      AND ${sessionFilter}
    ORDER BY resolved_at DESC LIMIT 1
  `).catch(() => ({ rows: [] }));
  const last = rows[0];
  if (!last) return false;
  const lastDir = resolveDirection(last);
  if (!lastDir || last.actual_pnl === 0) return false; // unclassifiable or breakeven -- no state change
  const blockedDirection = last.actual_pnl < 0 ? lastDir : (lastDir === 'LONG' ? 'SHORT' : 'LONG');
  return direction === blockedDirection;
}

// Tags a real (ACTIVE/SHADOW) row, right after insert, with whether the direction-loss gate
// above would have blocked it -- observation-only, see isDirectionLossBlocked()'s header. Called
// with the row's own `id` (from each real INSERT's RETURNING id) rather than threaded through
// the INSERT's own column/parameter list, deliberately -- this codebase's own convention flags
// manually counting positional $N params across a 4-site change as exactly the kind of edit that
// silently miscounts (feedback_sql_param_dryrun_verification). A follow-up UPDATE keyed by id is
// slower by one round-trip but categorically safer, and this never needs to be low-latency since
// nothing live reads it. Wrapped so a failure here can never affect the real row it's tagging.
export async function tagDirectionGateShadow(insertedId, direction) {
  if (!insertedId || !direction) return;
  try {
    const wouldBeBlocked = await isDirectionLossBlocked(direction);
    await query(
      `UPDATE active_setups SET direction_gate_shadow = $1 WHERE id = $2`,
      [JSON.stringify({ wouldBeBlocked, direction, checkedAt: new Date().toISOString() }), insertedId]
    );
  } catch (_) { /* observation-only -- never let a tagging failure surface anywhere */ }
}

export async function isInRefireCooldown(tradeDate, setupType) {
  const cooldownMin = REFIRE_COOLDOWN_MINUTES[setupType];
  if (!cooldownMin) return false;
  const cooldownQ = await query(`
    SELECT 1 FROM active_setups
    WHERE trade_date = $1 AND setup_type = $2
      AND resolution IS NOT NULL
      AND resolved_at > NOW() - ($3::int * INTERVAL '1 minute')
    LIMIT 1
  `, [tradeDate, setupType, cooldownMin]).catch(() => ({ rows: [] }));
  return cooldownQ.rows.length > 0;
}

// Found 2026-08-20 (live dashboard flooding, IB_BEARISH/BRACKET_BREAKOUT_SHORT — 31
// duplicate SHADOW rows in 33 minutes during a POST_RTH_DEAD_ZONE chop period):
// isInRefireCooldown() above only ever changes a fresh row's ACTIVE/SHADOW label via
// forceShadow — it does NOT stop a brand-new row from being inserted on every single
// poll once the prior instance resolves (existingSetup only dedupes against a still-OPEN
// row, by design — see its own comment above). RTH itself wasn't flooding (13 inserts
// over 6.5hrs for IB_BEARISH, matching the 30min cooldown) because the level simply
// wasn't touched that often; nothing was actually gating insert *frequency*. This check
// is the companion fix: it only ever fires when the candidate is ALREADY forceShadow for
// some other reason (dead-zone, calibration, exposure override, or refire-cooldown
// itself) — capital-neutral by construction, since a genuinely ACTIVE-eligible fire never
// reaches this check. SHADOW_NOISE_SUPPRESSION_MINUTES is an operational rate-limit, not
// a trading threshold (no entries/stops/targets/signal-trigger math involved), so the
// no-static-thresholds rule doesn't apply — it exists purely to collapse a 1/min
// duplicate-row flood, short enough that a genuinely later re-touch still gets its own row.
export const SHADOW_NOISE_SUPPRESSION_MINUTES = 5;
export async function recentlyShadowedSameType(tradeDate, setupType) {
  const q = await query(`
    SELECT 1 FROM active_setups
    WHERE trade_date = $1 AND setup_type = $2
      AND resolution IS NOT NULL
      AND resolved_at > NOW() - ($3::int * INTERVAL '1 minute')
    LIMIT 1
  `, [tradeDate, setupType, SHADOW_NOISE_SUPPRESSION_MINUTES]).catch(() => ({ rows: [] }));
  return q.rows.length > 0;
}

// Fire-time regime tagging (getDayTypeAtFire/getVolBucketAtFire/minutesFromSessionOpen/
// computeFireTags/FIRE_TAG_COLS/fireTagValues) moved to server/services/fireTags.js
// 2026-09-05 -- imported/re-exported near the top of this file.


// logGatedCandidate() moved to server/services/acdCandidateBuilder.js 2026-09-20
// (Phase A of docs/ACDJS_FILE_SIZE_REDUCTION_SPEC.md) -- imported below, still called
// directly from many sites in runSetupDetection's own remaining body.

// getTouchQualityCalib/getTouchQualityBaseline moved to server/services/acdShared.js
// 2026-09-05 (Phase 0 of the DeepSeek-planned extraction) -- imported above.


// Bars since the most recent session-open boundary (RTH 9:30am=mod570, Globex 6pm=mod1080)
// through NOW() -- bounded query (ts<=NOW() upper bound per the price_bars_primary convention).
// FIXED 2026-08-28: the RTH candidates loop previously reused allRthBarsRow.rows for this, which
// is scoped to the RTH window and stops growing at 4PM close -- any candidate firing during the
// 4-6PM no-new-entries dead zone (a routine, expected daily event, not rare) was reading the
// SAME frozen last bar for the entire 2-hour window regardless of its own real fired_at time.
// Confirmed live: 17 same-afternoon dead-zone SHADOW fires all showed byte-identical volume
// measures. Querying fresh through NOW() (matching the Globex site's own pattern) fixes both.
export async function getSessionBarsSinceOpen(boundaryMod) {
  // FIXED 2026-08-28 (DeepSeek code QA, independently verified): the inner boundary-bar lookup
  // had no date floor, so a missing session-open bar (a real, if occasional, data gap) would
  // silently match a PRIOR day's boundary bar instead, pulling multiple sessions' worth of bars
  // into what's supposed to be "this session only" -- corrupting the day-relative measures for
  // every fire that session. Bounding to the last 20 hours (a session is at most ~15h) means a
  // missing boundary bar now correctly yields zero rows (caught by the caller's <11-bar guard)
  // instead of silently spanning sessions.
  const res = await query(`
    SELECT COALESCE(bid_volume,0)+COALESCE(ask_volume,0) as volume,
           (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as mod
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= (
      SELECT ts FROM price_bars_primary
      WHERE symbol='NQ' AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int = $1
        AND ts <= NOW() AND ts >= NOW() - INTERVAL '20 hours'
      ORDER BY ts DESC LIMIT 1
    ) AND ts <= NOW()
    ORDER BY ts ASC
  `, [boundaryMod]);
  return res.rows.map(b => ({ mod: b.mod, volume: Number(b.volume) }));
}

// Momentum-against-fade factor (2026-09-05, user-requested). CORRECTED 2026-09-29 (DeepSeek
// design-critique audit of the whole shadow-tag family): this comment used to claim "tested
// against real fade history both RTH and Globex before wiring" -- that claim is FALSE and was
// never itself verified before being written (see CLAUDE.md's "a verified code comment is not
// itself verification" hard rule, 2nd confirmed instance). A real re-derivation
// (docs/CONVENTIONS_DETAIL.md) found RTH held (EV -$7.38 vs -$1.94, rigor-clean) but GLOBEX
// REVERSED (EV +$1.59 vs -$5.77) and wasn't even tercile-stable -- consistent with this
// codebase's own standing rule that a directional-pressure signal validated in RTH should be
// assumed to reverse, not just weaken, in Globex. Computes the signed price move over the last
// `lookbackBars` 1-min bars, oriented relative to a fade's OWN direction -- positive means
// recent price action has been moving AGAINST the fade (e.g. price rising sharply right before
// a SHORT fade), negative means it's been moving WITH it. Bounded query (last 2 hours only), no
// lookahead (ts < NOW() at call time, which is always "now" relative to the candidate being
// evaluated -- never a stored historical timestamp). Real-data finding (RESEARCH_CLAIM
// momentum_against_fade_filter_20260905, N~4150 real ACTIVE+SHADOW fades, already-suppressed
// types excluded, RTH-scoped): top-quartile "against" trades ran ~$7-12/trade worse than
// bottom-quartile across three independent lookback windows (5/15/30 bars), held up (same sign,
// not reversed) across a chronological half-split. Shared by both the RTH sizeMultiplier IIFE
// and detectGlobexSetup() -- computed once here, not reimplemented per session, per this
// codebase's "export the real function" convention -- but the underlying signal is only
// validated for RTH; any future promotion decision (OPEN_DECISION
// momentum_against_fade_sizemultiplier_wiring_pending) must scope to RTH only.
async function getMomentumAgainstFade(dir, lookbackBars = 15) {
  if (dir !== 'LONG' && dir !== 'SHORT') return null;
  const res = await query(`
    SELECT close FROM price_bars_primary
    WHERE symbol='NQ' AND ts < NOW() AND ts > NOW() - INTERVAL '2 hours'
    ORDER BY ts DESC LIMIT $1
  `, [lookbackBars + 1]);
  const bars = res.rows;
  if (bars.length < lookbackBars + 1) return null; // too little session history yet -- don't guess
  const nowClose = Number(bars[0].close);
  const pastClose = Number(bars[lookbackBars].close);
  const signed = nowClose - pastClose;
  return dir === 'SHORT' ? signed : -signed;
}

// Cached (per-day) read of the calibrated "against momentum" cutoff -- uses the shared
// getGlobalCalib() helper (fixed 2026-09-05, see that function's own header). Self-
// recalibrates weekly via scripts/calibrate_momentum_against_fade.mjs; null (tagging
// disabled entirely, fail-closed) if no calibration row exists yet, never a hardcoded
// point value, per CLAUDE.md's no-static-thresholds rule.
async function getMomentumAgainstFadeCalib() {
  return getGlobalCalib('momentumAgainstFadeCalib', async () => {
    const r = await query(`
      SELECT notes FROM performance_audit
      WHERE signal_type='MOMENTUM_AGAINST_FADE_CALIB' AND signal_name='ALL_ROSTER'
      ORDER BY run_date DESC LIMIT 1
    `);
    let val = null;
    try {
      if (r.rows[0]) {
        const notes = JSON.parse(r.rows[0].notes);
        // p25 added 2026-09-29 (was already stored in every calibration row's notes, just
        // never read here) -- needed for the continuous penaltyScore in
        // tagMomentumAgainstFadeShadow() below; p25 == null falls back to p75-only behavior
        // (penaltyScore skipped) rather than failing the whole calibration read.
        if (notes.p75 != null && notes.lookbackBars != null) val = { p75: notes.p75, p25: notes.p25 ?? null, lookbackBars: notes.lookbackBars };
      }
    } catch (_) {}
    return val;
  });
}

// Tags a real (ACTIVE/SHADOW) row, right after insert, with this candidate's own
// momentum-against-fade reading -- SHADOW-ONLY / OBSERVATION-ONLY, exact same posture and
// same reasoning as tagDirectionGateShadow() above (never changes a real candidate's
// ACTIVE/SHADOW eligibility or touches a real trade's resolution/actual_pnl; keyed by the
// row's own `id` via a follow-up UPDATE rather than threaded through the INSERT's own
// positional params, to avoid the manually-counting-$N-params failure mode). RESUMED
// 2026-09-05 (originally paused mid-build the same day pending the loss-cluster
// investigation -- see the direction-loss-alternation gate above, which is what that
// investigation actually produced) -- getMomentumAgainstFade() and its calibration were
// already built and tested (RESEARCH_CLAIM momentum_against_fade_filter_20260905, held up
// across three lookback windows and a chronological split). This wires the SHADOW tag only
// -- it does NOT wire a live sizeMultiplier penalty; that remains a separate, not-yet-made
// decision (OPEN_DECISION momentum_against_fade_sizemultiplier_wiring_pending) to be
// revisited once real momentum_against_fade_shadow data accumulates.
export async function tagMomentumAgainstFadeShadow(insertedId, direction) {
  if (!insertedId || !direction) return;
  try {
    const calib = await getMomentumAgainstFadeCalib();
    if (!calib) return; // no calibration row yet -- fail closed, tag nothing
    const value = await getMomentumAgainstFade(direction, calib.lookbackBars);
    if (value == null) return; // too little session history yet -- don't guess
    const against = value > calib.p75;
    // penaltyScore (added 2026-09-29, DeepSeek design-critique audit): a continuous 0-1+
    // reading of how far into the "against" zone this candidate sits, derived from the SAME
    // p25/p75/value already stored below -- 0 at or below p25 (fully favorable momentum), 1 at
    // or above p75 (the existing binary flag's own cutoff), interpolated linearly between.
    // Not clamped above 1 -- a reading well past p75 legitimately scores >1, which is real
    // information a binary flag throws away. Stored purely as an additional observational
    // field; does not replace `against` (kept for backward-compat with any existing consumer)
    // and does NOT itself feed any live sizeMultiplier -- that promotion decision is still
    // separate and still pending (OPEN_DECISION momentum_against_fade_sizemultiplier_wiring_
    // pending), and per the corrected header comment above, RTH-only if it ever happens.
    const penaltyRange = calib.p25 != null ? calib.p75 - calib.p25 : null;
    const penaltyScore = penaltyRange != null && penaltyRange > 0 ? +((value - calib.p25) / penaltyRange).toFixed(3) : null;
    await query(
      `UPDATE active_setups SET momentum_against_fade_shadow = $1 WHERE id = $2`,
      [JSON.stringify({
        value: +value.toFixed(2), p25Cutoff: calib.p25, p75Cutoff: calib.p75, lookbackBars: calib.lookbackBars,
        against, penaltyScore, direction, checkedAt: new Date().toISOString(),
      }), insertedId]
    );
  } catch (_) { /* observation-only -- never let a tagging failure surface anywhere */ }
}

// ── Helpers for setup lifecycle ───────────────────────────────────────────────

// 2026-08-17 (OPEN_DECISION islongsetup_gap_variant_direction_bug, DeepSeek design-critique
// adjustment A): this used to be a LOCAL, un-suffix-stripped copy of direction inference,
// buggy for _GAP_UP/_GAP_DOWN variants in exactly the same way isLongSetup() below was
// (WPP_FADE_SHORT_GAP_UP matched bare "UP" -> LONG, wrong). Now imports the canonical
// server/config/setupTypes.js version (strips the _GAP_(UP|DOWN) suffix first, matches all
// 112 known types per its own docstring, validated by test_invariants.mjs check [3]).
// Deleting the local shadow here, not just adding the import, is load-bearing -- an import
// alongside a same-named local declaration is a collision either way (parse error or silent
// shadowing), and either would have silently defeated this whole fix.

// dropToTimeline moved to server/services/acdShared.js 2026-09-05 (Phase 0 of the
// DeepSeek-planned extraction) -- imported and re-exported above so the 5 existing
// external consumers (rthFlushDetector.js, pocRotationJoinDetector.js,
// globexFlushDetector.js, ibLowPnrDetector.js, minuteBarSignalDetector.js) keep working.

// resolveDirection() moved to server/config/setupTypes.js 2026-08-17 (OPEN_DECISION
// islongsetup_bug_survives_in_3_other_files) so setupBacktestService.js/maeMfeReplay.js/
// caseEngine.js can share the exact same function instead of each hand-rolling their own
// copy -- the same "silent contract" drift that made this local copy necessary in the
// first place (see OPEN_DECISION islongsetup_gap_variant_direction_bug). Imported above
// alongside inferDirection().

// Fade-against-a-big-move-day exit check — DISABLED 2026-07-27, kept in place (not deleted)
// so the wiring/history is visible rather than silently vanishing. The 2026-07-26 validation
// (RESEARCH_CLAIM bigmove_fade_exit_2yr_robustness_confirmed, N=472, $37-46/trade) was never
// filtered by origin_status -- turned out to be 98.4% BACKFILL/UNKNOWN. Re-run filtered to
// real (ACTIVE/SHADOW) trades only found the fresh-trigger condition has occurred ZERO times
// in the entire 2-year real trade history -- not thin, genuinely never happened once. See
// RESEARCH_CLAIM bigmove_fade_exit_zero_real_occurrences for the full account. Returning
// false unconditionally until real occurrences actually accumulate enough to re-validate --
// do not re-enable by just reverting this line without re-checking origin_status first.
export async function checkFadeAgainstBigMoveExit(_setupRow, _currentSessionDate) {
  return false;
}

// Disabled logic preserved for reference (do not re-enable without re-validating on real
// origin_status='ACTIVE'/'SHADOW' data first -- see the disabled function's own comment above):
//
// if (!setupRow || setupRow.resolution != null || setupRow.entry_zone_low == null) return false;
// try {
//   const bigMoveActiveRow = await query(`
//     SELECT 1 FROM performance_audit WHERE signal_type='BIGMOVE_LIVE_SIGNAL' AND signal_name=$1
//   `, [currentSessionDate]);
//   if (bigMoveActiveRow.rows.length === 0) return false;
//
//   const direction = inferDirection(setupRow.setup_type);
//   if (!direction) return false;
//
//   const elapsedMin = (Date.now() - new Date(setupRow.fired_at).getTime()) / 60000;
//   if (elapsedMin < 13) return false; // matches the validated median fresh-trigger offset
//
//   const sessQ = await query(`
//     WITH recent AS (
//       SELECT ts, close::float, ts - LAG(ts) OVER (ORDER BY ts) AS gap
//       FROM price_bars_primary
//       WHERE symbol='NQ' AND ts >= (SELECT MAX(ts) FROM price_bars_primary WHERE symbol='NQ') - interval '30 hours'
//     ),
//     session_start AS (
//       SELECT COALESCE(MAX(ts), (SELECT MIN(ts) FROM recent)) AS start_ts FROM recent WHERE gap > interval '45 minutes'
//     )
//     SELECT
//       (SELECT start_ts FROM session_start) AS start_ts,
//       (SELECT close FROM recent, session_start WHERE ts >= session_start.start_ts ORDER BY ts ASC LIMIT 1) AS open_close,
//       (SELECT close FROM recent ORDER BY ts DESC LIMIT 1) AS latest_close
//   `);
//   const { start_ts, open_close, latest_close } = sessQ.rows[0] || {};
//   if (!start_ts || open_close == null || latest_close == null) return false;
//
//   const dayDir = Number(latest_close) >= Number(open_close) ? 'UP' : 'DOWN';
//   const isFadingAgainst = (dayDir === 'DOWN' && direction === 'LONG') || (dayDir === 'UP' && direction === 'SHORT');
//   if (!isFadingAgainst) return false;
//
//   const rngAtEntryQ = await query(`
//     SELECT MAX(high::float) - MIN(low::float) AS rng
//     FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1 AND ts <= $2
//   `, [start_ts, setupRow.fired_at]);
//   const rngAtEntry = rngAtEntryQ.rows[0]?.rng;
//   const wasActiveAtEntry = rngAtEntry != null && Number(rngAtEntry) >= 250;
//   return !wasActiveAtEntry;
// } catch (_) {
//   return false;
// }

