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

// Breakeven-stop-on-order-flow-rejection live-wiring scope check (2026-09-21). Single shared
// source for the exact population this mechanism applies to -- MUST match
// breakevenStopShadow.js's own retrospective classification scope exactly (non-overnight named-
// level fades only; `_OVERNIGHT`-suffixed variants structurally don't match since they don't end
// in `_LONG`/`_SHORT`; GLOBEX_VWAP_MAGNET is a separate setup family, not a fade, and doesn't
// match either). Computed once at every real INSERT site (matching wider_target_mult/
// runner_trail_width/extend_target_level's own "set once at entry, never re-derived mid-life"
// convention, per DeepSeek's 2026-09-21 design critique) and persisted to
// active_setups.breakeven_stop_eligible -- never re-derive this inline at resolution time, or a
// future scope-regex change would silently apply retroactively to already-open trades instead of
// only new ones. Do NOT widen this scope without a fresh Phase 0 test on the wider population
// first, per this codebase's own standing "backtest population must match what fires live" rule.
export function isBreakevenStopEligible(setupType) {
  return typeof setupType === 'string' && /_FADE_(LONG|SHORT)$/.test(setupType);
}

// No-new-entries dead zone: 4:00-6:00 PM ET (user directive, 2026-07-31 -- "seems to be noise
// and bad trades"; full-skip behavior since 2026-09-16, see acd.js's own `inNewEntryDeadZone`
// comment). Extracted 2026-09-16 after the same `etMin >= 16*60 && etMin < 18*60` boundary got
// duplicated a second time (computeStackVolSignal() needed its own copy, keyed off a bar's own
// `tod` field rather than the outer handler's `etMin`, since it's a standalone function that
// can't reach the RTH handler's own const) -- one shared boundary check for both, rather than
// two copies of the same magic numbers drifting apart the next time this window ever changes.
// Takes a plain ET-minute-of-day number (works for either `etMin` or a bar's own `tod`/`et_min`
// field -- both are the same "minutes since midnight ET" unit), not a Date, so every call site
// can pass whatever minute-of-day value it already has in scope.
export function isInNewEntryDeadZone(etMinuteOfDay) {
  return etMinuteOfDay >= 16 * 60 && etMinuteOfDay < 18 * 60;
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

// ── Defended-level detector plumbing (shared) ────────────────────────────────
// Extracted 2026-09-15 (OPEN_DECISION defended_level_plumbing_dedup_20260915, scoped by a
// DeepSeek design critique after rejecting a full merge of majorPivotDefendedBreakDetector.js/
// stallDefendedLevelDetector.js/minorDefendedLevelDetector.js). Deliberately narrow — this is
// bug-class hygiene on plumbing that is NOT trade-shape logic, not a performance change. The
// touch/deny/break state machines (semantically inverse between MAJOR and MINOR), the
// roll-week POLICY (continue-vs-break genuinely differs per detector and is correct as-is),
// and every exit config (stop/target/hold) all stay exactly where they were, per the critique's
// explicit scope. Verified byte-for-byte against each detector's own prior inline version
// before switching over (same discipline as every other extraction in this codebase).

// Buckets 1-minute bars into 5-minute OHLC bars. All 4 prior inline copies (major, minor, and
// stall's two — computeStallDefendedLevelSignals and getRollingQuietThreshold) shared this
// exact bucket-boundary/dateStr math and differed only in which extra fields they carried:
// `tsField` picks the input timestamp column name (major/minor/stall's signal path use `tc`,
// stall's getRollingQuietThreshold uses `t`); `trackOpen` carries `open` (needed by major/minor
// for their touch state machine's `bar.open` fallback on the very first bar); `trackVol` sums a
// per-bar `vol` field (stall's signal path only); `trackEndIdx` also returns a parallel
// map5mEnd1mIdx array pointing each 5m bar at its last constituent 1m bar's index (minor's own
// order-flow walk-back, the only caller that needs 1m granularity after bucketing). `close` is
// always tracked — used by 3 of 4 callers, a harmless unused property on the 4th
// (getRollingQuietThreshold never selects a close column, so it lands as undefined there,
// exactly as it was simply absent before this extraction).
export function bucketTo5mBars(bars1m, { tsField = 'tc', trackOpen = false, trackVol = false, trackEndIdx = false } = {}) {
  const bars5m = [];
  const map5mEnd1mIdx = trackEndIdx ? [] : null;
  let cur = null;
  for (let i = 0; i < bars1m.length; i++) {
    const row = bars1m[i];
    const tsStr = row[tsField];
    const minPart = parseInt(tsStr.substring(14, 16), 10);
    const bucketMin = Math.floor(minPart / 5) * 5;
    const bucketStr = tsStr.substring(0, 14) + bucketMin.toString().padStart(2, '0') + ':00';
    if (!cur || cur.tsStr !== bucketStr) {
      if (cur) { bars5m.push(cur); if (trackEndIdx) map5mEnd1mIdx.push(i - 1); }
      cur = { tsStr: bucketStr, dateStr: tsStr.slice(0, 10), high: row.high, low: row.low, close: row.close };
      if (trackOpen) cur.open = row.open;
      if (trackVol) cur.vol = row.vol;
    } else {
      cur.high = Math.max(cur.high, row.high);
      cur.low = Math.min(cur.low, row.low);
      cur.close = row.close;
      if (trackVol) cur.vol += row.vol;
    }
  }
  if (cur) { bars5m.push(cur); if (trackEndIdx) map5mEnd1mIdx.push(bars1m.length - 1); }
  return trackEndIdx ? { bars5m, map5mEnd1mIdx } : bars5m;
}

// Builds the Set of roll-week date strings (YYYY-MM-DD) spanning every calendar year present
// in `bars5m` — identical 2-line loop previously duplicated in major/minor/stall's
// computeStallDefendedLevelSignals. Requires each bar to carry a `.dateStr`, which
// bucketTo5mBars() above always sets.
export function buildRollWeekDateSet(bars5m) {
  const rollDates = new Set();
  const years = new Set(bars5m.map(b => parseInt(b.dateStr.slice(0, 4), 10)));
  for (const y of years) for (const d of getNqRollWeekDates(y)) rollDates.add(d);
  return rollDates;
}

// ZigZag pivot-acceptance walk shared by majorPivotDefendedBreakDetector.js and
// minorDefendedLevelDetector.js (each at its own ZIGZAG_THRESHOLD). Takes `atrFor(idx)` as an
// injected async resolver rather than hardcoding an ATR source — MAJOR uses RTH-only
// getRollingATR, MINOR uses full-day getFullDayATR, deliberately NOT interchangeable (a shared
// function that assumed one would silently break the other). `merged` is the combined,
// idx-sorted swing-point list (findSwingPoints output, HIGH+LOW merged); `bars5m` supplies each
// point's dateStr for the roll-week check; `rollDates` is buildRollWeekDateSet()'s output.
// Accepts the first non-roll-week point unconditionally, extends the run when a same-type point
// makes a new extreme, and accepts an opposite-type point once it clears `threshold * atr` from
// the last accepted point.
export async function walkZigZagAcceptance(merged, bars5m, rollDates, threshold, atrFor) {
  const accepted = [];
  let last = null;
  for (const p of merged) {
    if (rollDates.has(bars5m[p.idx].dateStr)) continue;
    if (!last) { last = p; accepted.push(p); continue; }
    const atr = await atrFor(p.idx);
    if (atr == null) continue;
    if (p.type === last.type) {
      if ((p.type === 'HIGH' && p.price > last.price) || (p.type === 'LOW' && p.price < last.price)) { last = p; accepted[accepted.length - 1] = p; }
      continue;
    }
    if (Math.abs(p.price - last.price) >= threshold * atr) { accepted.push(p); last = p; }
  }
  return accepted;
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

// Moved here from server/routes/acd.js 2026-09-21 (mlSiloService.js needed it too, and
// acd.js already imports FROM acdShared.js -- acdShared.js importing back from acd.js
// would be a real circular import, exactly what this file's own header says it exists to
// avoid). acd.js now imports this instead of defining its own copy -- behavior-identical,
// not reimplemented. Rolls Fri/Sat forward to Monday; used anywhere a post-6PM-ET "today"
// needs to roll to the next real trading session.
export function nextTradingDay(etDate) {
  const d = new Date(etDate);
  d.setDate(d.getDate() + 1);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1); // Sun → Mon
  if (d.getDay() === 6) d.setDate(d.getDate() + 2); // Sat → Mon
  return d.toLocaleDateString('en-CA');
}

// Shared today/week/month/year/all date-range resolution, extracted 2026-09-21 from
// /api/setups/range-summary's own inline logic (server/routes/acd.js) so a second consumer
// (the ML silo's own range-filterable view, per user request) doesn't reimplement this same
// session-boundary-aware date math a second time -- per this codebase's own "share modules
// instead of reimplementing" convention. Verified byte-identical to the original inline
// logic before this extraction replaced it there. Returns a shape describing HOW to filter
// by trade_date, not a finished SQL clause -- callers use their own column alias (`s.` in
// range-summary, `a.` in the ML silo), so this stays alias-agnostic.
//   mode='dates': filter via `<alias>.trade_date = ANY(dates)`
//   mode='since': filter via `<alias>.trade_date >= sinceStr::date`
//   mode='all':   no filter (every row)
export function resolveRangeDates(range, nowET) {
  const todayET = nowET.toLocaleDateString('en-CA');
  if (range === 'today') {
    // Post-6PM ET: the new Globex session (tomorrow's trade_date) has already opened --
    // roll forward rather than showing the just-closed RTH session. Matches
    // currentSessionDateET()'s own convention elsewhere in this codebase.
    const sessionDate = nowET.getHours() >= 18 ? nextTradingDay(nowET) : todayET;
    return { mode: 'dates', dates: [sessionDate], rangeLabel: sessionDate };
  }
  if (range === 'week') {
    const dow = nowET.getDay(); // 0=Sun...6=Sat
    // Sunday: the week opening tonight starts TOMORROW (Monday) -- post-6PM Sunday
    // activity is already tagged trade_date=Monday under this app's own rollover
    // convention, so Sunday shows the upcoming week, not the one that already closed
    // out last Friday.
    const daysSinceMonday = dow === 0 ? 1 : 1 - dow;
    const monday = new Date(nowET);
    monday.setDate(monday.getDate() + daysSinceMonday);
    const weekDates = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(monday);
      d.setDate(d.getDate() + i);
      weekDates.push(d.toLocaleDateString('en-CA'));
    }
    return { mode: 'dates', dates: weekDates, rangeLabel: weekDates[0] + ' → ' + weekDates[4] };
  }
  if (range === 'month' || range === 'year') {
    const days = range === 'month' ? 30 : 365;
    const since = new Date(nowET);
    since.setDate(since.getDate() - days);
    const sinceStr = since.toLocaleDateString('en-CA');
    return { mode: 'since', sinceStr, rangeLabel: 'trailing ' + days + 'd (since ' + sinceStr + ')' };
  }
  return { mode: 'all', rangeLabel: 'all time' };
}

// Real, currently-OPEN position from any of the 4 standalone detectors (MOMENTUM_CHASE,
// MAJOR_PIVOT_DEFENDED_BREAK, STALL_DEFENDED_LEVEL, MINOR_DEFENDED_LEVEL) -- added
// 2026-09-21 (user-caught live gap: "Why didnt this other live trade fire like this on my
// screen"). These detectors' own `compute*Signal()` functions only ever answer "is a NEW
// entry available right now" -- once a candidate fires, a one-per-session guard makes that
// signal go silent (null) on every later poll, even though the position stays genuinely
// open in the DB. Unlike the main level-fade engine's own "active" card (which re-displays
// via a real existence lookup, `existingSetup` in acd.js), these 4 detectors had NO
// equivalent "show my currently-open position" mechanism at all -- this function is that
// mechanism, deliberately separate from and read-only against each detector's own signal
// logic (never touches their trigger conditions). Plain DB lookup, not a live re-evaluation
// -- matches the same "read what was actually persisted, don't re-derive" principle as the
// origin_status fix shipped the same session.
// FIXED 2026-09-22 (found live: card stayed empty for a real, still-open MAJOR_PIVOT_
// DEFENDED_BREAK_LONG position all evening): two bugs. (1) this used to require an exact
// `trade_date = $1` match against the CALLER's own calendar-date todayET -- these 4
// detectors' rows carry the RTH session's trade_date, which stops matching "today" the
// moment the calendar rolls to a new date while the position is still open overnight (a
// real gap, not just theoretical -- these positions can and do stay open into and through
// Globex hours). Dropped the trade_date filter entirely; `status NOT IN (...)` plus each
// row's own bounded `expires_at` (enforced by expireStaleSetups(), runs every poll) already
// guarantees at most a small, genuinely-open set, so a plain recency bound on fired_at is
// enough to keep the query cheap without reintroducing the day-boundary bug. (2) the RTH
// route only ever called this from its own branch -- the Globex branch (`inGlobex`, this
// same file ~line 3885) returns its own response shape before reaching this call at all,
// so the card silently had nothing to show for the entire Globex/overnight session even
// when a real position was genuinely open. Now called from both branches.
const STANDALONE_DETECTOR_PREFIXES = ['MOMENTUM_CHASE', 'MAJOR_PIVOT_DEFENDED_BREAK', 'STALL_DEFENDED_LEVEL', 'MINOR_DEFENDED_LEVEL'];
export async function getOpenStandalonePosition() {
  const likeClauses = STANDALONE_DETECTOR_PREFIXES.map((_, i) => `setup_type LIKE $${i + 1}`).join(' OR ');
  const params = STANDALONE_DETECTOR_PREFIXES.map(p => `${p}%`);
  const r = await query(`
    SELECT id, setup_type, origin_status, fired_at::text AS fired_at,
      entry_zone_low::float AS entry, entry_zone_high::float AS entry_high,
      stop_level::float AS stop, t1_level::float AS target, t1_label
    FROM active_setups
    WHERE (${likeClauses})
      AND status NOT IN ('RESOLVED', 'EXPIRED')
      AND fired_at >= NOW() - INTERVAL '3 days'
    ORDER BY fired_at DESC LIMIT 1
  `, params).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}
