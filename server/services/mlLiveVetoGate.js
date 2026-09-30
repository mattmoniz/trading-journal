// Live ML VETO gate for the pre-10am window -- RESEARCH_CLAIM
// ml_verdict_discriminates_pre10am_window_20260929 + a true frozen-model walk-forward
// (both confirmed real, checked 2026-09-29), design-critiqued by DeepSeek before any code
// was written (see docs/OPEN_THREADS.md's same-day entry for the full critique).
//
// Scope: 6:00pm ET (Globex open) through 10:00am ET. A real Globex candidate that clears
// every existing risk-discipline gate (cross-direction, sibling-reversal, opposite-
// direction-open, same-type-refire) still gets scored by the ML meta-labeling model; a
// VETO verdict forces SHADOW, same "force-SHADOW, never skip" convention as every other
// gate in this chain, so the population keeps generating real outcome data that can keep
// validating (or invalidating) this gate going forward. A TAKE verdict changes nothing.
//
// Wired to BOTH sides of the window as of 2026-09-29: detectGlobexSetup() (6pm-9:30am)
// and 4 separate RTH insert sites for the 9:30-10am portion (STACK_VOL_BREAK_LIVE,
// cluster-sibling-touch-credit, the main active-slot path, shadowCandidates) -- these are
// structurally different insert paths in acd.js, not one shared "insert a candidate"
// function, so each needed its own call site (matching how isOppositeDirectionOpen()/
// isSameSetupRefireBlocked() are already wired at all 5 of these sites). The
// isInRthOpenDeadZone() full-skip already covers 9:30-9:35 ET, so this gate's RTH-side
// effect is really 9:35-10:00 ET.
//
// Architecture (per DeepSeek's critique): a persistent Python scoring service
// (mlScoringServiceManager.js/scripts/ml_meta_labeling/scoring_service.py) eliminates the
// ~3.3s-per-call cost of spawning a fresh Python process (score_one.py) for every live
// check -- that cost is almost entirely interpreter/pandas/lightgbm import overhead, not
// inference. Features are computed INLINE here, synchronously, reusing
// computePriorDayLevelFeatures()/computeDevelopingValueFeatures() from
// mlFeatureSnapshot.js -- the exact same functions mlFireTimeScoring.js's retrospective
// 60s-later pass uses, never a second hand-rolled copy (this codebase's "export the real
// function" rule). The three EXISTING_FEATURE_COLS this model also reads
// (nl30_at_detection, confluence_score_at_detection, minutes_from_open) are NORMALLY read
// off an already-inserted row -- pre-insert there is no row, so they're passed as inputs
// here instead. `nl30_at_detection` is correctly null for every Globex candidate (that
// column genuinely isn't in the Globex INSERT's column list). `minutes_from_open` is NOT
// null for Globex rows -- CORRECTED 2026-09-29 (DeepSeek code review, real BLOCKER): the
// Globex INSERT writes it via FIRE_TAG_COLS (minutesFromSessionOpen(etMin, 'GLOBEX')), so
// hardcoding null here made the gate's feature vector genuinely disagree with what the
// retrospective 60s scorer computes for the exact same row, and because persistGateVerdict()
// makes the gate's verdict canonical, the wrong-feature verdict would have silently won.
// Now passed in as a required param, computed by the caller the same way the real INSERT does.
//
// Fail-closed (force-SHADOW) on any error/timeout talking to the scoring service --
// DeepSeek's reasoning, grounded in this gate's own real numbers: a false-suppressed TAKE
// costs ~$1.50/trade forgone; a false-allowed VETO costs ~-$10.63/trade realized -- a
// ~7:1 asymmetry that makes "don't fire live when unsure" the cheap side to be wrong on.
// Every fail-closed event is logged loudly (console.error, a distinctive prefix) so a
// scorer outage reads as "the gate is down" rather than a silently quiet overnight
// session being mistaken for "nothing fired."
import { query } from '../db.js';
import { computePriorDayLevelFeatures, computeDevelopingValueFeatures } from './mlFeatureSnapshot.js';
import { ML_SCORING_SERVICE_URL } from './mlScoringServiceManager.js';

const GATE_WINDOW_START_MOD = 1080; // 6:00pm ET
const GATE_WINDOW_END_MOD = 600;    // 10:00am ET (window wraps past midnight)
// Session-open boundaries for the intraday bar query -- matches mlFireTimeScoring.js's
// own RTH_OPEN_MOD/GLOBEX_OPEN_MOD constants exactly (never a second, possibly-drifting
// copy of these two numbers).
const RTH_OPEN_MOD = 570;
const GLOBEX_OPEN_MOD = 1080;
const SCORE_TIMEOUT_MS = 500;       // DeepSeek's recommended budget -- local IPC inference
// is microseconds; anything slower than this indicates a genuinely unhealthy service, not
// real work, and the 15s Globex poll cannot afford to wait longer to find out.

// Simple in-process kill switch -- can be flipped without a code change/redeploy if the
// live forward data ever decays (DeepSeek's explicit recommendation, section 6 of the
// critique: "land the gate behind a kill-switch/config flag... the difference between a
// real finding wired with evidence and a provisional finding wired on enthusiasm").
export const ML_VETO_GATE = { enabled: true };

export function isInMlVetoGateWindow(etMin) {
  return etMin >= GATE_WINDOW_START_MOD || etMin < GATE_WINDOW_END_MOD;
}

async function computeInlineFeatures({ entry, tradeDate, boundaryMod }) {
  const pdQ = await query(`
    SELECT trade_date::text AS trade_date, poc, vah, val, session_high, session_low,
      session_close, poc_delta_vs_prior, migration_dir_vs_prior, va_overlap_pct_vs_prior
    FROM developing_value_log
    WHERE trade_date < $1::date
    ORDER BY trade_date DESC LIMIT 1
  `, [tradeDate]);
  const pdFeatures = computePriorDayLevelFeatures(entry, pdQ.rows[0] ?? null);

  // Bar boundary uses NOW() as the upper bound (matching computeMissingFeatures()'s own
  // `ts < $1::timestamp` where $1=fired_at) -- there is no fired_at yet pre-insert, and
  // the real INSERT sets fired_at=NOW() a few ms later, so using NOW() here is exactly
  // consistent with what the retrospective 60s scorer will compute for this same row.
  const barsQ = await query(`
    SELECT high::float AS high, low::float AS low, close::float AS close,
      bid_volume::float AS bid_volume, ask_volume::float AS ask_volume
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= (
      SELECT ts FROM price_bars_primary
      WHERE symbol='NQ' AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int = $1
        AND ts < NOW() AND ts >= NOW() - INTERVAL '20 hours'
      ORDER BY ts DESC LIMIT 1
    ) AND ts < NOW()
    ORDER BY ts ASC
  `, [boundaryMod]);
  const intradayFeatures = computeDevelopingValueFeatures(barsQ.rows, entry);

  return { pdFeatures, intradayFeatures };
}

/**
 * Scores a not-yet-inserted candidate (Globex OR the 9:30-10am RTH portion of the same
 * approved window -- `isRth` selects the session boundary for the intraday bar query and
 * which approval_threshold the scoring service applies, matching score_one.py's own
 * within-session threshold selection exactly). Returns:
 *   { shadow: boolean, reason: string|null, verdict, probability, modelVersion }
 * `shadow=true` means the caller should force SHADOW. `verdict`/`probability`/
 * `modelVersion` are non-null only on a real successful score (never on a fail-closed
 * path) -- the caller uses these to persist ml_verdicts AFTER the real INSERT succeeds
 * (there's no active_setup_id to attach a verdict to before that), so a re-score by the
 * retrospective 60s pass doesn't have to happen for gated candidates.
 *
 * `nl30AtDetection` defaults to null (correct for every insert site except the RTH main
 * active-slot path, the only one that actually computes and stores a real nl30 value --
 * pass it explicitly there). This mirrors the exact `minutes_from_open` bug DeepSeek's
 * code review caught for the Globex site: hardcoding null here would be silently WRONG
 * wherever a real value exists, for the same reason.
 */
export async function scoreMlVetoGate({ entry, tradeDate, confluenceScore, minutesFromOpen, nl30AtDetection = null, isRth }) {
  if (!ML_VETO_GATE.enabled) return { shadow: false, reason: null, verdict: null, probability: null, modelVersion: null };

  let pdFeatures, intradayFeatures;
  try {
    ({ pdFeatures, intradayFeatures } = await computeInlineFeatures({ entry, tradeDate, boundaryMod: isRth ? RTH_OPEN_MOD : GLOBEX_OPEN_MOD }));
  } catch (e) {
    console.error('[mlLiveVetoGate] feature computation failed -- failing closed (force-SHADOW):', e.message);
    return { shadow: true, reason: 'ML_VETO_GATE_FEATURE_ERROR', verdict: null, probability: null, modelVersion: null };
  }

  const existing = { nl30_at_detection: nl30AtDetection, confluence_score_at_detection: confluenceScore, minutes_from_open: minutesFromOpen };
  const features = {};
  for (const [k, v] of Object.entries(pdFeatures || {})) features[`pd_${k}`] = v;
  for (const [k, v] of Object.entries(intradayFeatures || {})) features[`intraday_${k}`] = v;
  const migration = pdFeatures?.migrationDirVsPrior;
  for (const cat of ['HOLDING', 'HIGHER', 'LOWER']) features[`pd_migration_${cat}`] = migration === cat ? 1 : 0;
  Object.assign(features, existing);

  let res;
  try {
    res = await fetch(`${ML_SCORING_SERVICE_URL}/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ features, is_rth: !!isRth }),
      signal: AbortSignal.timeout(SCORE_TIMEOUT_MS),
    });
  } catch (e) {
    console.error('[mlLiveVetoGate] scoring service unreachable/timed out -- failing closed (force-SHADOW):', e.message);
    return { shadow: true, reason: 'ML_VETO_GATE_SERVICE_UNREACHABLE', verdict: null, probability: null, modelVersion: null };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[mlLiveVetoGate] scoring service returned ${res.status} -- failing closed (force-SHADOW):`, body);
    return { shadow: true, reason: 'ML_VETO_GATE_SERVICE_ERROR', verdict: null, probability: null, modelVersion: null };
  }

  // Both gaps below found by DeepSeek's code review (2026-09-29): a 200 response is not
  // automatically a trustworthy one. `res.json()` itself can throw on a malformed/empty
  // body (a proxy hiccup, a truncated response) -- unhandled, that would bubble all the
  // way out of detectGlobexSetup()'s per-candidate loop and abort scoring for every OTHER
  // candidate in this same poll, not just this one (a one-poll detection gap, not a wrong
  // live order, but still a real fail-closed violation: it doesn't force-SHADOW this
  // specific candidate, it drops the whole iteration). And even a well-formed body isn't
  // automatically a valid one -- `verdict === 'VETO'` on a body missing `verdict` entirely
  // (e.g. `{}`) silently evaluates to `false`, i.e. fail-OPEN, with no error logged at all.
  let body;
  try {
    body = await res.json();
  } catch (e) {
    console.error('[mlLiveVetoGate] scoring service returned a non-JSON/malformed body -- failing closed (force-SHADOW):', e.message);
    return { shadow: true, reason: 'ML_VETO_GATE_MALFORMED_RESPONSE', verdict: null, probability: null, modelVersion: null };
  }
  const { probability, verdict, model_version: modelVersion } = body;
  if (verdict !== 'TAKE' && verdict !== 'VETO') {
    console.error('[mlLiveVetoGate] scoring service returned an unrecognized verdict shape -- failing closed (force-SHADOW):', JSON.stringify(body));
    return { shadow: true, reason: 'ML_VETO_GATE_UNRECOGNIZED_VERDICT', verdict: null, probability: null, modelVersion: null };
  }
  return {
    shadow: verdict === 'VETO',
    reason: verdict === 'VETO' ? 'ML_VETO_PRE10AM' : null,
    verdict, probability, modelVersion,
  };
}

/**
 * Persists a verdict already computed by the gate above (never re-scores) once the real
 * active_setups row exists. Same table/idempotency as run_silo_scoring.py/score_one.py --
 * ON CONFLICT DO NOTHING means if the 60s retrospective pass somehow beats this to it
 * (a real race is very unlikely given this runs synchronously right after INSERT, but
 * not impossible), neither write fails, and whichever landed first wins.
 */
export async function persistGateVerdict(activeSetupId, gateResult) {
  if (gateResult.verdict == null || gateResult.modelVersion == null) return; // fail-closed path never has a real verdict to persist
  await query(`
    INSERT INTO ml_verdicts (active_setup_id, model_version, probability, verdict)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (active_setup_id, model_version) DO NOTHING
  `, [activeSetupId, gateResult.modelVersion, gateResult.probability, gateResult.verdict]);
}
