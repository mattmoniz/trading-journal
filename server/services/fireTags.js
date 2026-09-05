// Fire-time regime tagging, extracted from server/routes/acd.js 2026-09-05 (further
// acd.js-shrink cleanup following the DeepSeek-planned extraction earlier the same day --
// see docs/OPEN_THREADS.md's 2026-09-05 entries). Pure relocation, behavior-identical --
// verified line-for-line via diff before removing the original. DeepSeek's original audit
// flagged this as a real "route file acting as a shared module" layering smell: 5 services
// (rthFlushDetector.js, globexFlushDetector.js, minuteBarSignalDetector.js,
// ibLowPnrDetector.js, pocRotationJoinDetector.js) already import computeFireTags/
// FIRE_TAG_COLS/fireTagValues directly from acd.js — a route file, not a service.
// acd.js now re-exports these for those 5 consumers; the "fully right" fix (repointing
// their imports here directly) is a separate, optional follow-up, not done in this pass.

import { query } from '../db.js';
import { getCached, setCached, DAY_CACHE_TTL } from './acdShared.js';

// ── Fire-time regime tagging (roster-rebuild roadmap Phase 1, I1, 2026-08-10) ──────
// Tags every live INSERT with day_type_at_fire/vol_bucket_at_fire/session/
// minutes_from_open — the regime that was true AT FIRE TIME, populated at insert,
// never backfilled. Purely additive/informational, same posture as the value-area
// regime stamp above — nothing reads these columns to gate/size anything yet. Point
// of this: no census/analysis of the roster today can condition on regime at all; this
// is what lets a future bet_class-level calibration (I3) or correlation monitor (I5)
// group by "what was actually true when this fired" instead of pooling blind.
//
// day_type_at_fire is deliberately the SLOW, ground-truth acd_daily_log.day_type — NOT
// the live dayTypeReassessmentService.js estimate. That engine was tested as a live
// gate input and rejected (2026-08-03, OPEN_DECISION dtclass_null_all_day_neuters_
// multiple_live_gates / RESEARCH_CLAIM trend_gate_suppression): it's specifically
// UNRELIABLE at the exact moment a fade fires (70.6% FPR on that subpopulation, since a
// fade-touch moment by construction looks like a trend in progress). Tagging a column
// literally named "day_type_at_fire" with a known-unreliable live guess would silently
// misdirect any future bet_class analysis that assumes it's ground truth. The honest
// consequence: acd_daily_log.day_type isn't written until run_daily_calibration.sh's
// 20:20 ET derive_day_types.js run, so for the RTH majority of the roster this will
// read UNKNOWN nearly always — that itself is a real, useful finding (how much of the
// roster can't be regime-conditioned on ground-truth day-type at all), not a bug to
// paper over with a worse number. vol_bucket_at_fire/session/minutes_from_open are the
// three fields expected to carry the real weight for regime conditioning until/unless a
// future session deliberately re-opens the live-estimate question (tracked below).
const RTH_OPEN_MIN = 570;    // 9:30 ET
const GLOBEX_OPEN_MIN = 1080; // 18:00 ET

export async function getDayTypeAtFire(tradeDate) {
  const cached = getCached(tradeDate, 'dayTypeAtFire');
  if (cached) return cached;
  const r = await query(`SELECT day_type FROM acd_daily_log WHERE trade_date=$1`, [tradeDate]).catch(() => ({ rows: [] }));
  return setCached(tradeDate, 'dayTypeAtFire', r.rows[0]?.day_type || 'UNKNOWN');
}

// Trailing-30-trading-day median 1-min NQ bar range, strictly excluding tradeDate
// itself (every input row satisfies ts::date < $1 — the preflight guard this field's
// own spec item calls for). Excluding the WHOLE trade_date, not just bars before
// fired_at's own time-of-day, means this is safe for both RTH and Globex fires on that
// date with a single query, and is immune to any same-day reclassification. Bucketed
// into quintiles against its own trailing 250-trading-day distribution of the SAME
// rolling statistic — self-calibrating, no static threshold (matches the noise-floor/
// circuit-breaker convention in update_optimal_stops.mjs, not reimplemented from it
// since that one is a run-time script stat, not a per-tradeDate live lookup).
export async function getVolBucketAtFire(tradeDate) {
  // getCached/setCached can't distinguish "not cached" from "cached as a legitimate
  // null" (both return null) — use a sentinel so the insufficient-history case (below)
  // is actually cached instead of re-querying on every call.
  const cached = getCached(tradeDate, 'volBucketAtFire', DAY_CACHE_TTL);
  if (cached !== null) return cached === 'NONE' ? null : cached;
  const rows = await query(`
    WITH daily AS (
      SELECT ts::date AS d, AVG(high - low) AS rng
      FROM price_bars_primary
      WHERE symbol = 'NQ' AND ts::date < $1
      GROUP BY ts::date
    ), rolled AS (
      SELECT d,
        AVG(rng) OVER (ORDER BY d ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS roll30,
        COUNT(*) OVER (ORDER BY d ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS n_in_window
      FROM daily
    )
    SELECT d, roll30::float FROM rolled WHERE n_in_window >= 30 ORDER BY d DESC LIMIT 251
  `, [tradeDate]).catch(() => ({ rows: [] }));
  if (rows.rows.length < 51) { setCached(tradeDate, 'volBucketAtFire', 'NONE'); return null; } // too little history to bucket meaningfully
  const [today, ...hist] = rows.rows;
  const histVals = hist.map(r => r.roll30).sort((a, b) => a - b);
  const rank = histVals.filter(v => v <= today.roll30).length / histVals.length;
  const bucket = rank >= 0.8 ? 'HIGH' : rank >= 0.6 ? 'ABOVE_AVG' : rank >= 0.4 ? 'AVG' : rank >= 0.2 ? 'BELOW_AVG' : 'LOW';
  return setCached(tradeDate, 'volBucketAtFire', bucket);
}

// etMin: minutes-since-midnight ET at fire time. Session opens: RTH 9:30 ET (570),
// Globex 18:00 ET (1080), wrapping past midnight through the 8:30 ET Globex detector
// cutoff. Every call site derives etMin from "now" at insert time, never a stored/
// stale value — satisfies the strict-upper-time-bound guard by construction (there is
// no query here at all, just wall-clock arithmetic on the same instant fired_at=NOW()
// uses).
export function minutesFromSessionOpen(etMin, session) {
  if (etMin == null) return null;
  if (session === 'RTH') return etMin - RTH_OPEN_MIN;
  if (etMin >= GLOBEX_OPEN_MIN) return etMin - GLOBEX_OPEN_MIN;
  return etMin + (1440 - GLOBEX_OPEN_MIN);
}

export async function computeFireTags(tradeDate, session, etMin) {
  const [dayType, volBucket] = await Promise.all([
    getDayTypeAtFire(tradeDate),
    getVolBucketAtFire(tradeDate),
  ]);
  return {
    day_type_at_fire: dayType,
    vol_bucket_at_fire: volBucket,
    session,
    minutes_from_open: minutesFromSessionOpen(etMin, session),
  };
}
export const FIRE_TAG_COLS = ['day_type_at_fire', 'vol_bucket_at_fire', 'session', 'minutes_from_open'];
export function fireTagValues(tags) { return FIRE_TAG_COLS.map(c => tags[c] ?? null); }
