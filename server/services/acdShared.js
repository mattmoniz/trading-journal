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

import { randomUUID } from 'crypto';
import { query } from '../db.js';
import { getVolumeBaseline } from './touchQuality.js';
import { inferDirection, CONDITIONAL_VARIANTS } from '../config/setupTypes.js';
import { etNaiveStringToUtcIso } from '../parsers/sierraParser.js';

// ── Same-poll cluster batch tagging (shared, 2026-09-08) ────────────────────────────
// Extracted out of 2 near-duplicate inline copies (the early-touch-backfill loop and the
// shadowCandidates loop, acd.js) found while checking whether tonight's cluster-tagging fixes
// were done cleanly. The backfill copy had a real bug this extraction also fixes: it generated
// ONE shared touch id for the ENTIRE backfilledTouches array regardless of whether the entries
// actually shared a touch moment -- different keepLevels can each have their own earliest-touch
// bar discovered in the same poll (e.g. Level A's real touch at 9:31am and Level B's at 9:52am,
// both surfacing in the same backfill scan), which the old inline version would have
// incorrectly linked as one cluster. `keyFn` makes the grouping explicit per caller: the
// backfill site groups by each touch's own etMin, shadowCandidates groups by entry price --
// two different real groupings, same underlying "tag a batch" logic.
//
// FIXED same day (code-review self-check, not caught in live data yet -- both loops' own
// gates are async/DB-backed and only rarely reject a group's first member, so today's real
// clusters all happened to survive by luck): the original version of this function assigned
// "primary" by raw ARRAY POSITION before either caller's loop had run its eligibility gates
// (risk check, refire cooldown, isLiveEligible, the backfill loop's own `existing` dedup
// check) -- each of those gates can `continue` before reaching the INSERT, so if position 0
// of a group got gated out, its "primary" designation was never written to any row, and the
// group's real siblings would all land in the DB as is_cluster_primary=false with no primary
// at all. tagClusterBatch() now ONLY returns real (2+ member) group membership + a touchId per
// key -- it deliberately does not decide who's primary, since that can only be known once a
// row has actually been inserted. Primary/sibling status is now resolved by claimClusterRole()
// at the moment each row's own INSERT succeeds, mirroring the already-shipped Globex
// (~line 1482, `globexPrimaryAssigned`) and RTH-winner (~line 9474, `active.clusterTouchId`)
// post-insert-UPDATE pattern instead of reinventing a pre-gate scheme.
export function tagClusterBatch(items, keyFn) {
  const counts = new Map();
  items.forEach(item => {
    if (!item) return;
    const key = keyFn(item);
    if (key == null) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const touchIds = new Map(); // key -> touchId, only for keys with 2+ raw members
  for (const [key, count] of counts) {
    if (count >= 2) touchIds.set(key, randomUUID());
  }
  return touchIds;
}

// Call once per successfully-inserted row, after tagClusterBatch() above has already produced
// its key -> touchId map for the batch. `assignedKeys` is a single `Set` the caller creates
// once per poll and threads through every iteration of its loop -- the first successful
// insert for a given key claims { isPrimary: true }; every insert after that for the same key
// gets { isPrimary: false }. Must only be called AFTER a row's own INSERT has actually
// succeeded (a real `id` came back) -- calling it earlier (e.g. right after computing a
// candidate, before its gates run) would reintroduce the exact bug this whole rework exists
// to fix.
export function claimClusterRole(assignedKeys, key) {
  if (assignedKeys.has(key)) return { isPrimary: false };
  assignedKeys.add(key);
  return { isPrimary: true };
}

// ── OPTIMAL_STOP lookup by resolved type (shared, 2026-09-08) ───────────────────────
// Fix for a real bug found via a user-reported live trade (PD_POC_FADE_LONG_TRAIL, 89pt
// stop vs. the base type's correctly-calibrated 24pt): update_optimal_stops.mjs only ever
// calibrates and stores OPTIMAL_STOP under a setup_type's BASE name (e.g. PD_POC_FADE_LONG)
// -- it has no concept of the _TRAIL-suffixed name resolveSetupType() diverts a touch to.
// 4 call sites in acd.js looked up `liveStats._opt[type]` using the POST-resolution type
// directly, so any candidate diverted to one of the 6 CONDITIONAL_VARIANTS trail types
// silently missed the real calibration and fell through to the much cruder mae_p75/STOP
// fallback -- a wildly wider, uncalibrated stop, every single time. This explains why 5 of
// the 6 trail variants were previously found to have "100% real resolutions via plain
// fixed-stop/target" (docs/CONVENTIONS_DETAIL.md) -- their real trades were never using a
// validated stop at all.
export function getOptStopForType(opt, type) {
  const baseType = CONDITIONAL_VARIANTS[type]?.baseType ?? type;
  return opt?.[baseType];
}

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
// Converts a naive "YYYY-MM-DD HH:MM:SS" ET wall-clock string (e.g. a bar's tsStr, always
// naive-ET in this codebase per the standing convention) into the TRUE UTC epoch ms --
// reuses sierraParser.js's already-validated etNaiveStringToUtcIso() rather than a new
// ad-hoc conversion, per the "share modules" rule. ONLY needed when comparing a bar
// timestamp against a genuinely-UTC anchor like Date.now() -- naive-vs-naive arithmetic
// (e.g. computing an expires_at string by just adding minutes) does NOT need this, since
// the mislabeling cancels out as long as nothing touches a true-UTC value in between.
// Found live 2026-09-10 (DeepSeek code review): both majorPivotDefendedBreakDetector.js and
// stallDefendedLevelDetector.js compared `new Date(tsStr.replace(' ','T')+'Z').getTime()`
// (a naive string mislabeled as UTC, running ~4-5h behind the bar's true epoch) directly
// against `Date.now()` (genuinely UTC) to decide "is this signal recent enough to insert" --
// this made every fresh, real-time signal compute as ~4-5 hours old, which always exceeded
// the 30/60-minute recency windows, so NEITHER detector could ever actually insert a live
// setup. Confirmed via direct calculation before fixing (a bar 5 real minutes old computed
// as 245 minutes old). Fixed at both call sites to use this function instead.
export function etNaiveTimestampToMs(tsStr) {
  const m = tsStr.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(etNaiveStringToUtcIso(y, mo, d, h, mi, s)).getTime();
}

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
// ── First-trading-day-after-a-gap detection (2026-09-14, user request) ──────────────────────
// "Don't trade PD (prior-day) setups on the first trading day after a weekend or long
// weekend" -- a normal weekend already makes the referenced "prior day" level 3 calendar
// days old by the time Monday opens (Friday close -> Monday open); a holiday-extended weekend
// makes it even older. Cached per trade_date (this can only change once a day) -- matches
// this file's/queries.js's own day-stable caching convention, avoids a real query on every
// 15s poll.
//
// Deliberately data-derived (observed price_bars_primary gap), not a fetched/hardcoded
// external calendar -- matches this codebase's own established preference for self-
// maintaining logic (see getNqRollWeekDates() just above: computed programmatically, not a
// static holiday list that goes stale every year). Known risk, mitigated below: price_bars_
// primary has documented gaps from real DATA QUALITY issues (quarterly contract-roll gaps,
// a known thin-data stretch -- see docs/KNOWN_ISSUES.md), not real market closures. Those
// gaps run ~63-70 CALENDAR DAYS -- nowhere near a real weekend/holiday's 2-4 days -- so the
// roll-week guard below only suppresses anomalously LARGE gaps (> MAX_NORMAL_GAP_DAYS),
// never an ordinary weekend that merely happens to fall inside a roll week's calendar span
// (every quarter's roll week spans a real weekend by construction -- verified live 2026-09-14:
// an unguarded roll-week check wrongly suppressed that day's genuine Fri->Mon 3-day gap
// before this fix).
const MAX_NORMAL_GAP_DAYS = 4; // covers a Mon/Fri holiday's 4-day weekend; matches the
// backfill_garch_vol_scale_history.py convention for the same concept.
const _priorTradingDayGapCache = new Map();
export async function isFirstTradingDayAfterGap(dateStr, minGapDays = 2) {
  if (_priorTradingDayGapCache.has(dateStr)) return _priorTradingDayGapCache.get(dateStr);
  const r = await query(`
    SELECT MAX(ts::date)::text as d FROM price_bars_primary
    WHERE symbol='NQ' AND ts::date < $1::date
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
  `, [dateStr]).catch(() => ({ rows: [] }));
  const priorDay = r.rows[0]?.d;
  if (!priorDay) { _priorTradingDayGapCache.set(dateStr, false); return false; }
  const gapDays = Math.round((new Date(dateStr + 'T12:00:00Z') - new Date(priorDay + 'T12:00:00Z')) / 86400000);
  if (gapDays > MAX_NORMAL_GAP_DAYS && (isInsideNqRollWeek(dateStr) || isInsideNqRollWeek(priorDay))) {
    // Anomalously large gap coinciding with a roll-week -- presumptively a data artifact,
    // not a real multi-week market closure. Don't suppress PD setups over it.
    _priorTradingDayGapCache.set(dateStr, false);
    return false;
  }
  const result = gapDays >= minGapDays;
  _priorTradingDayGapCache.set(dateStr, result);
  return result;
}

// Matches any PD_/PD2_ (prior-day / 2-days-prior) setup_type or level name -- shared
// predicate so acd.js's two PD-candidate insert paths (RTH keepLevelsAll, Globex candidates)
// filter identically rather than each hand-rolling the same prefix check.
export function isPdPriorDayType(typeOrName) {
  return typeof typeOrName === 'string' && (typeOrName.startsWith('PD_') || typeOrName.startsWith('PD2_'));
}

export function computeSessionEndCapStr(etNow) {
  const sessionEndET = new Date(etNow);
  sessionEndET.setHours(16, 0, 0, 0);
  if (sessionEndET <= etNow) sessionEndET.setDate(sessionEndET.getDate() + 1);
  return fmtETStr(sessionEndET);
}

// ── NQ quarterly roll-week dates (shared) ────────────────────────────────────
// Extracted 2026-09-14 from 3 independent hand-copies (stallDefendedLevelDetector.js,
// majorPivotDefendedBreakDetector.js, and scripts/backfill_garch_vol_scale_history.py's own
// Python version) after the volatility-regime card needed a 4th consumer -- per this
// codebase's own "share modules instead of reimplementing" convention. Returns the set of
// calendar dates (YYYY-MM-DD strings) inside NQ's quarterly (Mar/Jun/Sep/Dec) roll week: the
// 2nd Thursday of the contract month (where volume typically starts shifting to the next
// contract) through the Monday before the 3rd Friday (CME's own official roll date). Verified
// byte-identical to the Python version's output for 2026 before extracting.
export function getNqRollWeekDates(year) {
  const excluded = new Set();
  for (const month of [2, 5, 8, 11]) {
    const d = new Date(year, month, 1);
    const thursdays = [], fridays = [];
    while (d.getMonth() === month) {
      if (d.getDay() === 4) thursdays.push(new Date(d));
      if (d.getDay() === 5) fridays.push(new Date(d));
      d.setDate(d.getDate() + 1);
    }
    const secondThursday = thursdays[1], thirdFriday = fridays[2];
    const mondayBefore = new Date(thirdFriday); mondayBefore.setDate(mondayBefore.getDate() - 4);
    const curr = new Date(secondThursday);
    while (curr <= mondayBefore) { excluded.add(curr.toISOString().slice(0, 10)); curr.setDate(curr.getDate() + 1); }
  }
  return excluded;
}

// Convenience wrapper: is `dateStr` (YYYY-MM-DD) inside its own year's NQ roll week? Handles
// the December-month case (whose roll week can only ever fall in December itself, so a single
// year's getNqRollWeekDates() call always suffices -- no cross-year boundary to worry about).
export function isInsideNqRollWeek(dateStr) {
  const year = parseInt(dateStr.slice(0, 4), 10);
  return getNqRollWeekDates(year).has(dateStr);
}

// Returns { start, end } (YYYY-MM-DD strings) of the roll week containing or most recently
// covering `dateStr`, or null if `dateStr` isn't in one and none of the current year's 4 roll
// weeks have started yet relative to it. Used to build a human-readable "resumes ~<date>"
// message -- callers needing just a boolean should use isInsideNqRollWeek() instead.
export function getNqRollWeekBounds(dateStr) {
  const year = parseInt(dateStr.slice(0, 4), 10);
  const dates = [...getNqRollWeekDates(year)].sort();
  if (!dates.length) return null;
  // Group into contiguous runs (4 runs/year, one per quarter) and find the one containing
  // dateStr, if any.
  const runs = [];
  let run = [dates[0]];
  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(run[run.length - 1]), cur = new Date(dates[i]);
    if ((cur - prev) / 86400000 === 1) run.push(dates[i]);
    else { runs.push(run); run = [dates[i]]; }
  }
  runs.push(run);
  for (const r of runs) {
    if (dateStr >= r[0] && dateStr <= r[r.length - 1]) return { start: r[0], end: r[r.length - 1] };
  }
  return null;
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
