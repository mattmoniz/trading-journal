// RTH stall-defended-level live detector, 2026-09-10 (SHADOW-only).
//
// Backing research: scratch/stall_defended_level_phase1.mjs / _phase2.mjs (not yet a formally
// recorded RESEARCH_CLAIM as of this build -- see the record_claim call this same commit adds).
// Different sequencing from majorPivotDefendedBreakDetector.js: the live TRIGGER is a price
// STALL (4 consecutive 5-min bars, combined high-low range <= a data-derived "quiet" cutoff --
// see getRollingQuietThreshold() below, NOT the arbitrary 0.08x literal an earlier version of this
// research used), THEN checked against two confirming conditions: (1) an earlier-confirmed RAW
// fractal pivot (findSwingPoints, any magnitude, NOT ZigZag-magnitude-filtered) sitting within
// a confluence band of the stall's midpoint, confirmed within the last MAX_LOOKBACK_HOURS, and
// (2) a known level_prices level within that same band. Direction bets on repeating whichever
// prior pivot's own behavior (LOW-type prior = zone acted as support = bet LONG; HIGH-type =
// resistance = bet SHORT).
//
// The "quiet" cutoff is NOT a fixed literal -- getRollingQuietThreshold() computes RTH's own
// live p10 (calmer than 90% of all real RTH 4-bar windows) from a rolling 90-day window,
// cached ~24h (QUIET_THRESHOLD_CACHE_TTL_MS). STALL_RANGE_ATR_FRAC_FALLBACK=0.0702 (RTH's p10
// as measured 2026-09-10) is ONLY used if that live computation can't get enough real data --
// see scratch/quiet_period_distribution.mjs for the original measurement. An earlier flat
// 0.08x guess (never data-derived) tested materially worse: EV roughly halved and the
// population's own real-stop/target delta-vs-placebo margin was smaller (see
// scratch/stall_defended_level_phase2.mjs's git history / this session's own transcript for
// the before/after comparison). Globex was tested too (own p10=0.0447x ATR, SWING_WIDTH=50)
// but showed a much smaller real-stop EV once a real stop was applied (~$2-4/trade vs RTH's
// ~$28/trade) -- NOT wired here, RTH-only by design.
//
// CLEAN vs COILED volume gate: TESTED AND REMOVED 2026-09-10, do not reintroduce without new
// evidence. A stall window with any bar's volZ (vs a 90-day trailing 5-min-bucket baseline --
// NOT touchQuality.js's getVolumeBaseline(), which is built for 1-min bars; a scale mismatch
// was caught and fixed the same session, see quiet_period_volume_check.mjs's header) elevated
// despite a tight price range ("coiled") looked worse than a genuinely quiet ("clean") stall
// on the ORIGINAL, uncorrected quiet-threshold population using raw forward-return only. Once
// the quiet threshold was fixed to the real, live-derived value above AND a real stop/target
// was applied, a proper sweep (0.5/0.75/1.0/1.25/1.5x volZ) showed COILED actually BEATING
// CLEAN at every threshold except 1.5x (N=4 there, too thin to mean anything) -- the original
// finding did not survive being re-checked properly. This detector fires on EVERY qualifying
// stall regardless of volume; `maxVolZ` is still computed and returned on each signal (see
// computeStallDefendedLevelSignals()'s return value) so real forward data can revisit this
// question once enough volume accumulates -- it is NOT currently persisted onto the inserted
// active_setups row itself (no schema column exists for it yet; a future revisit could add
// one if this turns out to matter).
//
// Entry: real stop = the stall's own tight-range extreme (just beyond the confluence band, on
// the adverse side of the direction taken) -- NOT a level_prices-derived distance. Target =
// 0.5x ATR20 (the strongest, most placebo-consistent cell across the whole grid, not just the
// biggest raw number). Hold = 210min, UNCAPPED at the RTH session boundary -- this was NOT
// tested capped (the backtest itself never truncated at session close), so capping now would
// ship an unvalidated variant; if a trade is still open past 4pm ET it keeps running exactly
// like the major-pivot detector's own uncapped design.
//
// LIVE STATUS: real N=0 as of this build -- inserts as SHADOW unconditionally, matching
// majorPivotDefendedBreakDetector.js and momentumChaseDetector.js, per the standing "New setup
// type checklist" item 3 (N<20 resolved trades => SHADOW only).
//
// Does NOT catch the motivating 9/8-9/9 flush example -- confirmed directly (both via a fresh
// run of the research script against live data, and via computeStallDefendedLevelSignal()
// itself). That zone was actively, repeatedly re-tested for ~32h and essentially never went
// quiet, so the STALL trigger (which requires stillness) structurally cannot recognize it,
// regardless of hold time, SWING_WIDTH, or any other parameter tuned here. Catching that shape
// of event needs a separate denial-streak/touch-count-based trigger (closer to
// majorPivotDefendedBreakDetector.js's own design), not this one -- tracked as a still-open,
// explicitly separate idea, not attempted in this build.

import { query } from '../db.js';
import { getRollingATR } from './levelProximityService.js';
import { findSwingPoints } from './swingPivots.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { getBetClass } from '../config/setupTypes.js';
import { dropToTimeline, etNaiveTimestampToMs, getNqRollWeekDates } from './acdShared.js';

// EARNED literals below -- each was chosen from a real parameter sweep tested against
// real-stop/target EV (not guessed), same category as majorPivotDefendedBreakDetector.js's
// own ZIGZAG_THRESHOLD=1.5. Listed with what was actually tried and why this value won.

// Confirmation lag for the "was this defended before" pivot. Swept 5/10/15/20/25/30/40/50/
// 75/100 (bars, each = 5min) against real-stop/target EV, RTH-only: EV climbed steadily with
// width up to 40-50, then the mean/median gap widened badly past ~75 (an outlier-driven-mean
// red flag) and day-clustering rose. 40 is the RTH sweet spot -- N stays workable (98 after
// the quiet-threshold fix) and mean/median track together (not a tail-driven artifact). NOTE:
// Globex's own sweet spot is 50, not 40 -- session-specific, not interchangeable (same
// precedent as the major-pivot detector's RTH-vs-Globex config split).
const SWING_WIDTH = 40;

// How many consecutive 5-min bars must stay tight to count as a "stall" (4 bars = 20min).
// Swept 4/5/10/15/20/25/30: EV keeps climbing as this rises, but N collapses catastrophically
// past ~15 (down to single digits by 25-30, with day-concentration hitting 85-100% -- a
// handful of anecdotes, not a real sample). 4 is the largest STALL_BARS value that still
// clears a workable, trustworthy N.
const STALL_BARS = 4;

// How tight (as an ATR fraction) those STALL_BARS must stay to count as genuinely quiet.
// NOT a fixed literal -- computed LIVE from a rolling real distribution (see
// getRollingQuietThreshold() below) rather than the flat 0.08x guess an earlier version of
// this file used (that guess turned out to be only the ~p30 of real 4-bar windows -- not
// rare/special at all, and roughly HALVED real EV compared to the corrected, data-derived
// version). Recomputed daily (cached ~24h, not every poll) so this can't go stale the way
// sizeMultiplier's hand-calibrated factors did.
const QUIET_TARGET_PERCENTILE = 0.10; // p10 -- calmer than 90% of all real RTH 4-bar windows
const STALL_RANGE_ATR_FRAC_FALLBACK = 0.0702; // RTH's own p10 as measured 2026-09-10 -- only used if the live rolling computation can't get enough real data (fresh install, a data gap), never as the normal path

const CONFLUENCE_ATR_FRAC = 0.02; // shared constant, NOT re-derived here -- matches pivotConfluenceAnalysis.js / levelProximityService.js's AT_LEVEL_ATR_FRAC

// How far back a prior pivot can still count as "defended previously." Tested unbounded/24h/
// 8h against real-stop/target EV: 24h gave the strongest SHORT-side result and didn't hurt
// LONG; unbounded let very old, arguably-stale pivots count, 8h cut real signal without a
// clear benefit. 24h (one full session) is also the most defensible choice on its face --
// "defended in the last trading day" is a real, interpretable claim.
const MAX_LOOKBACK_HOURS = 24;

// CLEAN-vs-COILED volume gate (a tight price range that still hides elevated volume
// underneath) was tested and REMOVED 2026-09-10 -- after correcting the quiet-threshold bug
// above, a proper sweep (0.5/0.75/1.0/1.25/1.5x volZ) showed COILED actually beating CLEAN at
// every threshold except 1.5x (where N drops to 4, too thin to mean anything). The original
// "CLEAN beats COILED" finding was measured on the OLD, uncorrected quiet population with raw
// forward-return only (no real stop/target) -- it didn't survive being re-checked properly.
// Not reintroducing this filter without new, real live data to justify a specific cutoff.

// Target size, as an ATR fraction. Swept 0.25/0.5/0.75/1.0/1.5x against real-stop/target EV
// AND against a 10-trial randomized-direction placebo per cell -- 0.5x had the single best
// real-vs-placebo delta ($23.91) even though 1.0x/1.5x showed a slightly bigger raw EV
// number; the placebo gap is what actually distinguishes a genuine edge from geometry, so
// the delta-winner was picked over the raw-EV-winner.
const TARGET_ATR_MULT = 0.5;

// Hold time after entry, in minutes. Tested 15/30/60/120/240, then specifically 180/210/240
// side-by-side -- all three landed within normal placebo-trial noise of each other ($13.75-
// $15.92 at the pre-quiet-threshold-fix population), so there's no strong data-driven reason
// to prefer any one of them; 210 was the user's own chosen value from that indifferent range.
// UNCAPPED at the RTH session close -- untested capped, so capping now would ship an
// unvalidated variant (same reasoning as the major-pivot detector's own uncapped design).
const HOLD_MIN = 210;

const LOOKBACK_DAYS = 10; // only needs to cover MAX_LOOKBACK_HOURS + SWING_WIDTH confirmation lag + a buffer, not majors' 120-day requirement (no ZigZag-magnitude pivot formation lag to look back through)
const RECENT_STALL_WINDOW_MIN = 30; // only attempt inserting stalls confirmed in the last 30min -- avoids reprocessing old ones every poll
const CACHE_KEY = 'stallDefendedLevel:signals';
const CACHE_TTL_MS = 4 * 60 * 1000; // ~once per 5-min bar close
const QUIET_THRESHOLD_CACHE_KEY = 'stallDefendedLevel:quietThreshold';
const QUIET_THRESHOLD_CACHE_TTL_MS = 20 * 60 * 60 * 1000; // ~daily -- this is a distribution property of the market, not something that needs 15s freshness

function isGlobexMod(mod) { return mod >= 1080 || mod < 510; } // matches every other detector's boundary this session

// getNqRollWeekDates now imported from acdShared.js (2026-09-14 dedup -- was a local copy,
// identical to majorPivotDefendedBreakDetector.js's own former local copy).

// Same corrected 5-min-bucket volume baseline built and validated the same session (a scale
// mismatch against touchQuality.js's 1-min-bar getVolumeBaseline() was caught and fixed) --
// see scratch/quiet_period_volume_check.mjs.
async function getVolumeBaseline5m(date) {
  const res = await query(`
    SELECT mod5, AVG(vol5m)::float AS avg_vol, STDDEV(vol5m)::float AS std_vol
    FROM (
      SELECT (FLOOR((EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))/5)*5)::int AS mod5,
             ts::date AS d, FLOOR(EXTRACT(epoch FROM ts) / 300)::bigint AS bucket5,
             SUM(COALESCE(bid_volume,0)+COALESCE(ask_volume,0))::float AS vol5m
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date >= $1::date - INTERVAL '90 days' AND ts::date < $1::date
      GROUP BY 1, 2, 3
    ) sub GROUP BY mod5
  `, [date]);
  return new Map(res.rows.map(r => [r.mod5, r]));
}

// Live, rolling "quiet" cutoff -- p10 of the REAL distribution of RTH 4-bar combined
// high-low range vs ATR20, computed fresh from the last 90 days rather than a hardcoded
// literal (see the QUIET_TARGET_PERCENTILE comment above for why). Cached ~daily
// (QUIET_THRESHOLD_CACHE_TTL_MS) -- this is a property of the market's own recent behavior,
// not something that needs 15s freshness, and recomputing it from 90 days of bars on every
// poll would be wasteful.
export async function getRollingQuietThreshold() {
  const cached = cacheGet(QUIET_THRESHOLD_CACHE_KEY);
  if (cached != null) return cached;

  const res = await query(`
    SELECT to_char(ts,'YYYY-MM-DD HH24:MI:SS') as t, high::float, low::float
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts >= NOW() - INTERVAL '90 days' AND ts <= NOW()
    ORDER BY ts ASC
  `);
  const rows1m = res.rows;
  if (rows1m.length < 50) return cacheSet(QUIET_THRESHOLD_CACHE_KEY, STALL_RANGE_ATR_FRAC_FALLBACK, QUIET_THRESHOLD_CACHE_TTL_MS);

  const bars5m = [];
  let cur = null;
  for (const row of rows1m) {
    const minPart = parseInt(row.t.substring(14, 16), 10);
    const bucketMin = Math.floor(minPart / 5) * 5;
    const bucketStr = row.t.substring(0, 14) + bucketMin.toString().padStart(2, '0') + ':00';
    if (!cur || cur.tsStr !== bucketStr) { if (cur) bars5m.push(cur); cur = { tsStr: bucketStr, dateStr: row.t.slice(0, 10), high: row.high, low: row.low }; }
    else { cur.high = Math.max(cur.high, row.high); cur.low = Math.min(cur.low, row.low); }
  }
  if (cur) bars5m.push(cur);

  const atrCache = new Map();
  async function atrFor(dateStr) { if (!atrCache.has(dateStr)) atrCache.set(dateStr, getRollingATR(dateStr)); return atrCache.get(dateStr); }
  const uniqueDates = Array.from(new Set(bars5m.map(b => b.dateStr)));
  for (let i = 0; i < uniqueDates.length; i += 20) await Promise.all(uniqueDates.slice(i, i + 20).map(d => atrFor(d)));

  const ratios = [];
  for (let i = STALL_BARS - 1; i < bars5m.length; i++) {
    const hh = parseInt(bars5m[i].tsStr.substring(11, 13), 10);
    const mm = parseInt(bars5m[i].tsStr.substring(14, 16), 10);
    if (isGlobexMod(hh * 60 + mm)) continue; // RTH distribution only -- matches what this detector fires on
    const window = bars5m.slice(i - STALL_BARS + 1, i + 1);
    const atr = await atrFor(bars5m[i].dateStr);
    if (!atr) continue;
    const wHigh = Math.max(...window.map(b => b.high));
    const wLow = Math.min(...window.map(b => b.low));
    ratios.push((wHigh - wLow) / atr);
  }
  if (ratios.length < 100) return cacheSet(QUIET_THRESHOLD_CACHE_KEY, STALL_RANGE_ATR_FRAC_FALLBACK, QUIET_THRESHOLD_CACHE_TTL_MS);

  ratios.sort((a, b) => a - b);
  // Linear-interpolation percentile, matching pandas' Series.quantile() default exactly --
  // the same method volatilityRegime.js's getCurrentGarchRegime() uses, and what
  // scratch/quiet_period_distribution.mjs's original one-time measurement used. A nearest-
  // rank index (found via DeepSeek code review 2026-09-10) would silently diverge from the
  // validated p10=0.0702 this detector's own fallback documents.
  const pos = QUIET_TARGET_PERCENTILE * (ratios.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  const threshold = lo === hi ? ratios[lo] : ratios[lo] + (ratios[hi] - ratios[lo]) * (pos - lo);
  return cacheSet(QUIET_THRESHOLD_CACHE_KEY, threshold, QUIET_THRESHOLD_CACHE_TTL_MS);
}

// Re-derives the full stall+defended+confluence signal set from the last LOOKBACK_DAYS of
// bars. Exported for direct verification, matching majorPivotDefendedBreakDetector.js's
// computeDefendedBreaks() convention.
export async function computeStallDefendedLevelSignals() {
  const quietThreshold = await getRollingQuietThreshold();
  const barsRes = await query(`
    SELECT to_char(ts, 'YYYY-MM-DD HH24:MI:SS') as tc, to_char(ts,'YYYY-MM-DD') as d,
           high::float, low::float, close::float,
           COALESCE(bid_volume,0)::float + COALESCE(ask_volume,0)::float as vol
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts >= NOW() - INTERVAL '${LOOKBACK_DAYS} days' AND ts <= NOW()
    ORDER BY ts ASC
  `);
  const bars1m = barsRes.rows;
  if (bars1m.length < 50) return [];

  const bars5m = [];
  let cur = null;
  for (const row of bars1m) {
    const tsStr = row.tc;
    const minPart = parseInt(tsStr.substring(14, 16), 10);
    const bucketMin = Math.floor(minPart / 5) * 5;
    const bucketStr = tsStr.substring(0, 14) + bucketMin.toString().padStart(2, '0') + ':00';
    if (!cur || cur.tsStr !== bucketStr) { if (cur) bars5m.push(cur); cur = { tsStr: bucketStr, dateStr: row.d, high: row.high, low: row.low, close: row.close, vol: row.vol }; }
    else { cur.high = Math.max(cur.high, row.high); cur.low = Math.min(cur.low, row.low); cur.close = row.close; cur.vol += row.vol; }
  }
  if (cur) bars5m.push(cur);
  if (bars5m.length < SWING_WIDTH * 2 + STALL_BARS) return [];

  const rollDates = new Set();
  const years = new Set(bars5m.map(b => parseInt(b.dateStr.slice(0, 4), 10)));
  for (const y of years) for (const d of getNqRollWeekDates(y)) rollDates.add(d);

  const { highs, lows } = findSwingPoints(bars5m, SWING_WIDTH);
  const highPivots = highs.filter(p => !rollDates.has(bars5m[p.idx].dateStr)).sort((a, b) => a.idx - b.idx);
  const lowPivots = lows.filter(p => !rollDates.has(bars5m[p.idx].dateStr)).sort((a, b) => a.idx - b.idx);

  const atrCache = new Map(), volBaselineCache = new Map(), levelsCache = new Map();
  async function atrFor(dateStr) { if (!atrCache.has(dateStr)) atrCache.set(dateStr, getRollingATR(dateStr)); return atrCache.get(dateStr); }
  async function volBaselineFor(dateStr) { if (!volBaselineCache.has(dateStr)) volBaselineCache.set(dateStr, getVolumeBaseline5m(dateStr)); return volBaselineCache.get(dateStr); }
  async function levelsFor(dateStr) {
    if (!levelsCache.has(dateStr)) levelsCache.set(dateStr, query(`SELECT price::float FROM level_prices WHERE trade_date=$1 AND price IS NOT NULL`, [dateStr]).then(r => r.rows));
    return levelsCache.get(dateStr);
  }
  const uniqueDates = Array.from(new Set(bars5m.map(b => b.dateStr)));
  for (let i = 0; i < uniqueDates.length; i += 20) {
    await Promise.all(uniqueDates.slice(i, i + 20).map(d => Promise.all([atrFor(d), volBaselineFor(d)])));
  }

  const signals = [];
  let lastSignalEndIdx = -Infinity;

  for (let i = STALL_BARS - 1; i < bars5m.length; i++) {
    if (rollDates.has(bars5m[i].dateStr)) continue;
    if (i - lastSignalEndIdx < STALL_BARS) continue; // debounce

    const hh = parseInt(bars5m[i].tsStr.substring(11, 13), 10);
    const mm = parseInt(bars5m[i].tsStr.substring(14, 16), 10);
    if (isGlobexMod(hh * 60 + mm)) continue; // RTH-only by design (see file header)

    const window = bars5m.slice(i - STALL_BARS + 1, i + 1);
    if (window.some(b => rollDates.has(b.dateStr))) continue;
    const wHigh = Math.max(...window.map(b => b.high));
    const wLow = Math.min(...window.map(b => b.low));
    const atr = await atrFor(bars5m[i].dateStr);
    if (atr == null) continue;
    if (wHigh - wLow > quietThreshold * atr) continue; // not quiet enough

    // maxVolZ is computed and stored (not gated on) -- a CLEAN-vs-COILED volume filter was
    // tested and REMOVED (see the const block above): after fixing the quiet-threshold bug,
    // a proper sweep showed COILED beating CLEAN at every threshold except an N=4 one, too
    // thin to justify a cutoff. Kept on the signal record per the no-dead-ends rule -- real
    // forward data can revisit this once enough volume accumulates, rather than the value
    // being silently discarded.
    const volBaseline = await volBaselineFor(bars5m[i].dateStr);
    let maxVolZ = -Infinity;
    for (const b of window) {
      const rawMod = parseInt(b.tsStr.substring(11, 13), 10) * 60 + parseInt(b.tsStr.substring(14, 16), 10);
      const mod = Math.floor(rawMod / 5) * 5;
      const bl = volBaseline.get(mod);
      if (bl && bl.std_vol) { const z = (b.vol - bl.avg_vol) / bl.std_vol; if (z > maxVolZ) maxVolZ = z; }
    }

    const stallMid = (wHigh + wLow) / 2;
    const band = atr * CONFLUENCE_ATR_FRAC;
    const stallStartIdx = i - STALL_BARS + 1;
    const minPriorIdx = stallStartIdx - MAX_LOOKBACK_HOURS * 12; // 12 5-min bars/hour
    const priorHigh = highPivots.filter(p => (p.idx + SWING_WIDTH) < stallStartIdx && (p.idx + SWING_WIDTH) >= minPriorIdx && Math.abs(p.price - stallMid) <= band).pop();
    const priorLow = lowPivots.filter(p => (p.idx + SWING_WIDTH) < stallStartIdx && (p.idx + SWING_WIDTH) >= minPriorIdx && Math.abs(p.price - stallMid) <= band).pop();
    if (!priorHigh && !priorLow) continue;

    const levelRows = await levelsFor(bars5m[i].dateStr);
    const nearbyLevels = levelRows.filter(r => Math.abs(r.price - stallMid) <= band);
    if (nearbyLevels.length === 0) continue;

    let direction;
    if (priorHigh && priorLow) direction = Math.abs(priorHigh.price - stallMid) <= Math.abs(priorLow.price - stallMid) ? 'SHORT' : 'LONG';
    else if (priorHigh) direction = 'SHORT';
    else direction = 'LONG';

    const entryPrice = bars5m[i].close;
    const stopPrice = direction === 'LONG' ? wLow - band : wHigh + band;

    signals.push({
      entryTsStr: bars5m[i].tsStr,
      entryPrice, stopPrice, atr, direction,
      pivotPrice: priorHigh && priorLow ? (direction === 'SHORT' ? priorHigh.price : priorLow.price) : (priorHigh ? priorHigh.price : priorLow.price),
      maxVolZ: maxVolZ === -Infinity ? null : maxVolZ,
    });
    lastSignalEndIdx = i;
  }
  return signals;
}

async function getSignalsCached() {
  const cached = cacheGet(CACHE_KEY);
  if (cached != null) return cached;
  const signals = await computeStallDefendedLevelSignals();
  return cacheSet(CACHE_KEY, signals, CACHE_TTL_MS);
}

// Full detect-and-insert, called from acd.js's runSetupDetection as a single line, matching
// majorPivotDefendedBreakDetector.js's / momentumChaseDetector.js's convention.
export async function computeStallDefendedLevelSignal(todayET) {
  try {
    const signals = await getSignalsCached();
    if (!signals.length) return null;

    const nowMs = Date.now();
    const recent = signals.filter(s => {
      // etNaiveTimestampToMs, NOT new Date(str+'Z') -- same fix as
      // majorPivotDefendedBreakDetector.js, found by DeepSeek code review 2026-09-10. s.entryTsStr
      // is naive ET; Date.now() is genuinely UTC. entryDate below (used for expiresAt) stays as
      // the naive-mislabeled parse -- self-consistent naive-ET arithmetic, never actually wrong.
      const entryMs = etNaiveTimestampToMs(s.entryTsStr);
      return nowMs - entryMs <= RECENT_STALL_WINDOW_MIN * 60000 && nowMs - entryMs >= 0;
    });
    if (!recent.length) return null;

    const inserted = [];
    for (const s of recent) {
      const sign = s.direction === 'LONG' ? 1 : -1;
      const stopDist = Math.abs(s.entryPrice - s.stopPrice);
      const stopPx = s.entryPrice - sign * stopDist;
      const targetPx = s.entryPrice + sign * TARGET_ATR_MULT * s.atr;
      const entryDate = new Date(s.entryTsStr.replace(' ', 'T') + 'Z');
      const expiresAt = new Date(entryDate.getTime() + HOLD_MIN * 60000);
      const setupType = `STALL_DEFENDED_LEVEL_${s.direction}`;
      const t1Label = `RTH stall, ${TARGET_ATR_MULT}x ATR target, ${HOLD_MIN}min hold (uncapped past session boundary)`.slice(0, 100);

      const ins = await query(`
        INSERT INTO active_setups (
          trade_date, setup_type, fired_at, expires_at, status, origin_status,
          entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label,
          price_at_detection, structural_level_touched, structural_level_type, bet_class
        ) VALUES ($1,$2,$3,$4,'SHADOW','SHADOW',$5,$5,$6,$7,$8,$5,$9,'STALL_DEFENDED_LEVEL',$10)
        ON CONFLICT DO NOTHING
        RETURNING id, trade_date, fired_at::text as fired_at, expires_at::text as expires_at, entry_zone_low, stop_level, t1_level, t1_label
      `, [
        s.entryTsStr.slice(0, 10), setupType, s.entryTsStr, expiresAt.toISOString().slice(0, 19).replace('T', ' '),
        s.entryPrice, stopPx, targetPx, t1Label, s.pivotPrice, getBetClass(setupType),
      ]);
      if (ins.rows[0]) {
        try { await dropToTimeline(ins.rows[0]); } catch (_) {}
        inserted.push(ins.rows[0]);
      }
    }
    return inserted.length ? inserted : null;
  } catch (_) { return null; /* informational-only build, never block the response */ }
}
