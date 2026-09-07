// Shared foundation for acd.js and the functions being extracted out of it into their own
// server/services/*.js files (2026-09-05 DeepSeek-planned extraction — see
// docs/OPEN_THREADS.md's 2026-09-05 entry and OPEN_DECISION
// acdjs_deferred_cleanup_from_deepseek_audit_20260905). Exists specifically to break a real
// circular-import risk: every extraction candidate references these acd.js-internal helpers,
// so without this file, the new service files would import back from acd.js while acd.js
// imports from them — a true cycle. This file imports only leaf modules (db.js,
// touchQuality.js, setupTypes.js), so nothing that imports from here can cycle back into it.
//
// Pure relocation from server/routes/acd.js, behavior-identical — verified line-for-line
// before moving. acd.js re-exports dropToTimeline (and imports the rest) so the 5 existing
// external consumers of `dropToTimeline` from acd.js (rthFlushDetector.js,
// pocRotationJoinDetector.js, globexFlushDetector.js, ibLowPnrDetector.js,
// minuteBarSignalDetector.js) keep working unchanged.

import { query } from '../db.js';
import { getVolumeBaseline } from './touchQuality.js';
import { inferDirection } from '../config/setupTypes.js';

// ── Runner-trail-width lookup (shared, 2026-09-07) ──────────────────────────────────
// Extracted from 4 near-identical inline copies in acd.js (Globex level insert, suppressed-
// audit insert, early-touch-backfill insert, main RTH active-slot insert) -- each queried
// performance_audit's BREAKEVEN_TRAIL_TEST rows and parsed `.trail` out of the JSON notes with
// byte-for-byte identical logic, only variable-name prefixes differing. Found while
// investigating the file's overall duplication (user-prompted, 2026-09-07): the code's own
// comments self-described one copy as "the third copy" without realizing a genuine 4th copy
// existed at the main RTH insert site -- and that 4th copy was MISSING the `.catch(() =>
// ({rows: []}))` safety net the other 3 have, meaning a transient DB hiccup on this specific
// query could throw uncaught on the highest-traffic of the 4 sites (the real active-slot
// insert path) instead of gracefully falling back to null like the other 3. This extraction
// both deduplicates AND fixes that inconsistency -- every call site now gets the same safe
// fallback behavior.
//
// Deliberately takes the ALREADY-RESOLVED CONDITIONAL_VARIANTS[...] entry as its argument,
// not a setup_type string -- the 4 original sites don't all resolve the same key (the Globex
// site pre-resolves via resolveUnconditionalTrailVariant() first; the other 3 look up the raw
// setup_type directly), so this helper only extracts the shared TAIL (query + parse), leaving
// each call site's own "which variant to look up" logic untouched and exactly as before.
export async function lookupRunnerTrailWidth(trailVariant) {
  if (!trailVariant?.trailSignalName) return null;
  const row = await query(
    `SELECT DISTINCT ON (signal_name) notes FROM performance_audit
     WHERE signal_type='BREAKEVEN_TRAIL_TEST' AND signal_name=$1
     ORDER BY signal_name, run_date DESC`,
    [trailVariant.trailSignalName]
  ).catch(() => ({ rows: [] }));
  const notes = row.rows[0]?.notes;
  const parsed = typeof notes === 'string' ? JSON.parse(notes) : notes;
  return parsed?.trail ?? null;
}

// ── Setup-detection level cache (structural data that changes at most daily) ──
// Keyed by trade date + cache key. Default TTL = 60 seconds for intraday stability;
// callers with a naturally-daily-scoped value (already keyed by date, so a stale-day
// read is impossible) can pass a longer ttl instead of reinventing a second cache.
const _levelCache = {};
const LEVEL_CACHE_TTL = 60000;
export const DAY_CACHE_TTL = 12 * 60 * 60 * 1000; // half a trading day+ — safe since the cache key already includes the date
function cacheKey(tradeDate, key) { return `${tradeDate}:${key}`; }
export function getCached(tradeDate, key, ttl = LEVEL_CACHE_TTL) {
  const e = _levelCache[cacheKey(tradeDate, key)];
  if (e && Date.now() - e.ts < ttl) return e.val;
  return null;
}
export function setCached(tradeDate, key, val) {
  _levelCache[cacheKey(tradeDate, key)] = { val, ts: Date.now() };
  return val;
}

// Fixed 2026-09-05 (found by a DeepSeek-dispatched audit, independently verified against
// git blame and live performance_audit rows before trusting it): `getCached()` above returns
// `null` on a genuine miss, NEVER `undefined` -- but at least 7 distinct `_global`-scoped
// calibration readers across acd.js (in ~12 hand-copied inline blocks, 4 of them exact
// duplicates) checked `cached !== undefined` instead of checking for `null`. Since
// `null !== undefined` is always true, every one of them treated a real miss as a hit and
// returned the stored `null` forever -- the real `await query(...)` fallback was
// unreachable dead code. Confirmed real live impact, not theoretical: ENTRY_PRESSURE_SHORT
// (a validated, positive-EV live sizeMultiplier boost, real calibration data in
// performance_audit since 2026-08-24) and WIDER_TARGET_PRESSURE_GATE (same) had never
// actually read their own calibration since being wired -- both silently ran in their
// null/fail-safe state the entire time. Consolidated into one correct, shared helper so the
// null-vs-undefined contract only has to be gotten right once. Do NOT use
// `cached !== undefined` against getCached's return value anywhere -- always
// `cached != null` (or `??`).
export async function getGlobalCalib(key, fetchFn) {
  const cached = getCached('_global', key, DAY_CACHE_TTL);
  if (cached != null) return cached;
  const val = await fetchFn();
  return setCached('_global', key, val);
}

// Touch-quality (order-flow) calibration + volume-baseline lookups — informational
// only; see server/services/touchQuality.js and scripts/calibrate_touch_quality.mjs.
export async function getTouchQualityCalib() {
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const cached = getCached(todayET, 'touchQualityCalib', DAY_CACHE_TTL);
  if (cached) return cached;
  const res = await query(`
    SELECT signal_name, notes FROM performance_audit
    WHERE signal_type='TOUCH_QUALITY' AND run_date=(SELECT MAX(run_date) FROM performance_audit WHERE signal_type='TOUCH_QUALITY')
  `).catch(() => ({ rows: [] }));
  const map = {};
  for (const row of res.rows) {
    try {
      const n = JSON.parse(row.notes);
      map[row.signal_name] = { windowBars: n.window_bars, highVolZCutoff: n.high_vol_z_cutoff };
    } catch (_) {}
  }
  return setCached(todayET, 'touchQualityCalib', map);
}

// tradeDate: the SETUP's own trade_date (not "today") — a SHADOW/overnight setup
// classified after midnight ET must exclude its own trade date from the 90-day
// trailing baseline the same way scripts/calibrate_touch_quality.mjs does, not
// silently fold that date's own volume into its baseline average. Previously this
// always used wall-clock "today", which only happened to be correct for the common
// same-day case. Found in code review 2026-07-15.
export async function getTouchQualityBaseline(tradeDate) {
  const cached = getCached(tradeDate, 'touchQualityBaseline', DAY_CACHE_TTL);
  if (cached) return cached;
  const baseline = await getVolumeBaseline(query, tradeDate);
  return setCached(tradeDate, 'touchQualityBaseline', baseline);
}

// ── ET expiry-string formatting (shared, 2026-09-07) ────────────────────────────────
// Formats a Date as "YYYY-MM-DD HH:MM:00" using its LOCAL time fields -- callers must
// have already computed `d` in ET wall-clock terms (this file's/acd.js's standing
// convention), NOT UTC, so PostgreSQL interprets the stored TIMESTAMP WITHOUT TZ
// column correctly in its own session timezone.
export function fmtETStr(d) {
  const y = d.getFullYear(), mo = String(d.getMonth() + 1).padStart(2, '0'),
        day = String(d.getDate()).padStart(2, '0'),
        h = String(d.getHours()).padStart(2, '0'), m = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${day} ${h}:${m}:00`;
}

// The hard RTH-close (4:00 PM ET) expiry cap, rolled forward a day if already past.
// Extracted from 3 near-identical inline copies in acd.js (cluster-sibling-touch-credit
// insert, suppressed-audit insert, early-touch-backfill insert) -- each built this via its
// own `const`-scoped copy because the real fmtETStr/computeExpiry closure in the main RTH
// insert path is defined too late in runSetupDetection() (temporal dead zone) for these
// earlier sites to reach. The main RTH path's own computeExpiry() still needs its
// `sessionEndET` as a live Date (for a `<` comparison against a per-type expiry window), so
// it keeps its own local copy of that comparison logic -- this helper covers only the
// callers that need the final formatted cap string directly, not a Date to compare against.
export function computeSessionEndCapStr(etNow) {
  const sessionEndET = new Date(etNow);
  sessionEndET.setHours(16, 0, 0, 0);
  if (sessionEndET <= etNow) sessionEndET.setDate(sessionEndET.getDate() + 1);
  return fmtETStr(sessionEndET);
}

// Drops an active_setups row into trade_timeline_events (idempotent via ON CONFLICT).
// event_time = fired_at (never current timestamp — per spec).
export async function dropToTimeline(setup) {
  await query(`
    INSERT INTO trade_timeline_events (
      trade_date, event_time, event_type, setup_type, setup_id,
      direction, entry_zone, stop_level, t1_level, t1_label,
      resolution, historical_win_rate, historical_sessions,
      window_duration_minutes
    ) VALUES ($1,$2,'SETUP',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (setup_id) DO NOTHING
  `, [
    setup.trade_date,
    setup.fired_at,
    setup.setup_type,
    setup.id,
    inferDirection(setup.setup_type),
    setup.entry_zone_low,
    setup.stop_level,
    setup.t1_level,
    setup.t1_label,
    setup.resolution || null,
    setup.historical_win_rate,
    setup.historical_sessions,
    setup.expires_at
      ? Math.round((new Date(setup.expires_at) - new Date(setup.fired_at)) / 60000)
      : null,
  ]);
}
