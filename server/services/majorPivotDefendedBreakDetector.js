// Major swing-pivot defended-break live detector, 2026-09-10 (SHADOW-only).
//
// Backing research: RESEARCH_CLAIM major_swing_pivot_defended_break_continuation_20260910.
// A "major level" is a genuine PRICE-ACTION swing pivot (findSwingPoints, swingWidth=5,
// ZigZag-ATR-magnitude-filtered at 1.5x ATR20) -- NOT a level_prices indicator confluence
// (the shape every earlier attempt this same day used and which RESOLVED NEGATIVE under
// placebo testing, see volume_confirmed_defended_breakout_continuation_20260910). A pivot
// counts as DEFENDED once it's been tested and denied at least once (streak>=1) before the
// eventual 2-consecutive-close break. Both the pivot definition AND the 1.5x ATR threshold
// were confirmed across 5 nearby thresholds (1.0x-2.0x) with a 10-trial randomized-direction
// placebo control at every one -- not a cherry-picked single-threshold result.
//
// Session-specific exit config (both independently placebo-tested, joint-swept for B, and
// confirmed NOT interchangeable -- applying B's config to Globex trades was directly tested
// and found actively harmful there, WR dropped to 29.2%/EV went negative):
//   RTH-origin ("B"): stop = 1.5x the pivot's own real defended-extreme
//     distance, target = 2.5x ATR20, hold = 720min.
//   Globex-origin ("A"): stop = 1.0x that same real distance, target = 1.5x ATR20, hold = 240min.
// RTH/Globex session split uses the SAME boundary definition as every backtest this detector
// is built from (mod>=1080 or mod<510 => Globex, else => RTH-config) -- deliberately NOT this
// codebase's canonical isFiredInRTH() (570-960 strict), which would silently reclassify the
// 8:30-9:30am pre-market and 4-6pm dead-zone bars differently than what was actually tested
// (those were lumped into the RTH-config bucket in every test today; switching to the
// canonical narrower boundary now would apply an unvalidated combination to those minutes).
//
// IMPORTANT, confirmed live before wiring: both configs' hold times were deliberately tested
// UNCAPPED at the session boundary and found to depend heavily on running past it -- 87.1% of
// RTH-config trades don't resolve until after RTH closes (capping cost roughly half the
// backtested EV), 12.5% of Globex-config trades run into RTH (capping still more than halved
// EV there too). Do NOT add a session-close cap to "clean up" this detector -- that would ship
// a materially different, worse system than what was actually validated. The stop/target are
// FIXED at the values computed at entry and never re-priced once the session changes -- this
// was the only version tested; a dynamically-adjusting target was explicitly considered and
// rejected as an untested, separate idea.
//
// LIVE STATUS: both RTH and Globex arms insert SHADOW unconditionally (hardcoded in the INSERT
// itself, not eligibility-derived -- there is no ACTIVE path anywhere in this file), same as
// momentumChaseDetector.js, per the standing "New setup type checklist" item 3 (N<20 resolved
// trades => SHADOW only). No promotion-check wiring needed for the same reason. The Globex arm
// was a hard `continue` (zero rows at all) from 2026-09-10 (its config failed a strict rigor
// check at N=24) through 2026-09-14, then re-enabled SHADOW-only -- see the inline comment at
// the Globex-vs-RTH branch below for why a full skip was a genuine dead end here (real N could
// never grow past 24) and OPEN_DECISION major_pivot_globex_shadow_reeval_pending_20260914 for
// the re-check this needs once real N clears 20.
//
// Zone-tracking state is NOT incremental/persistent in-process -- each call re-derives the
// full zone set from a bounded recent lookback window (avoids the "stateful tracker silently
// reset by an outer loop" footgun from a different angle: rebuilding fresh each time, bounded
// AND cached, is simpler to get right than hand-maintaining incremental state across restarts,
// and is cheap enough at this data volume to run every few minutes). Cached (cacheGet/cacheSet)
// with a short TTL so the 15s poller doesn't re-walk the whole lookback window on every tick --
// only roughly once per 5-min bar close.

import { query } from '../db.js';
import { getRollingATR } from './levelProximityService.js';
import { findSwingPoints } from './swingPivots.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { getBetClass } from '../config/setupTypes.js';
import { dropToTimeline, etNaiveTimestampToMs, bucketTo5mBars, buildRollWeekDateSet, walkZigZagAcceptance } from './acdShared.js';

const SWING_WIDTH = 5;
const ZIGZAG_THRESHOLD = 1.5; // x ATR20 -- confirmed sweet spot, both configs peak here
// CORRECTED 2026-09-10 (real bug found via a live-vs-backtest verification pass, not
// theoretical): originally 25 days, based on a wrong assumption that a zone's own
// "time to decide" (median well under a day per the backtest's own numbers) bounded how far
// back a pivot's FORMATION could be. It doesn't -- those are different things. Direct check:
// the only real defended break in the last 25 days (2026-08-24, SHORT@29200.75) came from a
// pivot that FORMED on 2026-07-21, 34 days earlier -- a 25-day lookback can never see that
// pivot confirm at all, so the live detector silently found zero breaks where the backtest
// (which scans the same window the pivot actually needs) found one. Widened with real margin
// above the one observed case, not tuned to just barely cover it.
const LOOKBACK_DAYS = 120;
const RECENT_BREAK_WINDOW_MIN = 60; // only attempt inserting breaks from the last hour -- avoids repeatedly re-processing old breaks every poll
const CACHE_KEY = 'majorPivotDefendedBreak:zones';
const CACHE_TTL_MS = 4 * 60 * 1000; // ~once per 5-min bar close, not every 15s poll

// RTH-config ("B"): stop=1.5x real distance, target=2.5x ATR, hold=720min.
// Globex-config ("A"): stop=1.0x real distance, target=1.5x ATR, hold=240min.
const CONFIG = {
  RTH: { stopMult: 1.5, targetMult: 2.5, holdMin: 720 },
  GLOBEX: { stopMult: 1.0, targetMult: 1.5, holdMin: 240 },
};

function etModOf(dateObj) {
  return dateObj.getUTCHours() * 60 + dateObj.getUTCMinutes();
}
// Matches every backtest's own boundary exactly -- see file header for why this is
// deliberately NOT sessionBoundary.js's isFiredInRTH().
function isGlobexMod(mod) {
  return mod >= 1080 || mod < 510;
}

// getNqRollWeekDates/bucketTo5mBars/buildRollWeekDateSet/walkZigZagAcceptance all now imported
// from acdShared.js (2026-09-14/15 dedup, OPEN_DECISION defended_level_plumbing_dedup_20260915
// — see acdShared.js's own header comment for the full plumbing-consolidation account).

// Re-derives the full defended-break zone state from the last LOOKBACK_DAYS of 5-min bars.
// Returns the list of confirmed breaks (streak>=1) found anywhere in that window -- the caller
// filters to "recent" ones before attempting an insert. Exported (not just used internally)
// so this live code path can be directly verified against the backtest's own known-good
// output -- see scratch/verify_live_detector_matches_backtest.mjs.
export async function computeDefendedBreaks() {
  const barsRes = await query(`
    SELECT to_char(ts, 'YYYY-MM-DD HH24:MI:SS') as tc, to_char(ts,'YYYY-MM-DD') as d,
           open::float, high::float, low::float, close::float
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts >= NOW() - INTERVAL '${LOOKBACK_DAYS} days' AND ts <= NOW()
    ORDER BY ts ASC
  `);
  const bars1m = barsRes.rows;
  if (bars1m.length < 50) return [];

  const bars5m = bucketTo5mBars(bars1m, { trackOpen: true });
  if (bars5m.length < SWING_WIDTH * 2 + 5) return [];

  const rollDates = buildRollWeekDateSet(bars5m);

  const { highs, lows } = findSwingPoints(bars5m, SWING_WIDTH);
  const merged = [...highs.map(p => ({ ...p, type: 'HIGH' })), ...lows.map(p => ({ ...p, type: 'LOW' }))].sort((a, b) => a.idx - b.idx);

  const atrCache = new Map();
  async function atrFor(idx) {
    const d = bars5m[idx].dateStr;
    if (!atrCache.has(d)) atrCache.set(d, getRollingATR(d));
    return atrCache.get(d);
  }
  const uniqueDates = Array.from(new Set(merged.map(p => bars5m[p.idx].dateStr)));
  for (const d of uniqueDates) { if (!atrCache.has(d)) atrCache.set(d, getRollingATR(d)); }
  await Promise.all(Array.from(atrCache.values()));

  const accepted = await walkZigZagAcceptance(merged, bars5m, rollDates, ZIGZAG_THRESHOLD, atrFor);

  const completedBreaks = [];
  for (const pivot of accepted) {
    const confirmIdx = pivot.idx + SWING_WIDTH;
    if (confirmIdx >= bars5m.length) continue;
    const atr = await atrFor(pivot.idx);
    if (!atr) continue;
    const band = atr * 0.02;
    const top = pivot.price + band, bot = pivot.price - band;
    const approachSide = pivot.type === 'HIGH' ? 1 : -1;
    let state = 'IDLE', denialStreak = 0, extremePrice = null, barsHeld = 0, side = null;
    for (let i = confirmIdx; i < bars5m.length; i++) {
      // FIXED 2026-09-14 (real, active bug -- DeepSeek code review, independently confirmed:
      // today's own date is inside the live Sep 10-14 2026 NQ roll week). Was `continue`,
      // which skips a roll-week bar without resetting state -- state/extremePrice/denialStreak
      // all survive the gap untouched, so a zone mid-TOUCHING or mid-BREAKING right as a roll
      // week starts would silently resume post-roll as if nothing happened. That's not enough
      // on its own even as a fix: `top`/`bot` (the pivot's own band, set at pivot-acceptance
      // time from that date's ATR) are priced in the FRONT-month contract, so ANY post-roll bar
      // compared against them is comparing back-month prices to a front-month reference for the
      // rest of this pivot's test, not just the gap bar itself -- the contamination doesn't
      // clear once the roll week ends. `break` (not `continue`, not a mid-loop state reset)
      // permanently abandons testing THIS pivot the moment its test window touches a roll week
      // -- a pivot whose confirm-to-break window crosses a roll-week boundary is untestable in
      // a single price epoch and must not fire at all. Matches stallDefendedLevelDetector.js's
      // own (already-correct) roll-week handling, which pre-filters pivots off roll dates and
      // rejects any stall window touching one, rather than trying to skip-and-resume.
      if (rollDates.has(bars5m[i].dateStr)) break;
      const bar = bars5m[i];
      if (state === 'IDLE') {
        const inBand = bar.high >= bot && bar.low <= top;
        if (inBand) {
          const prevClose = i > 0 ? bars5m[i - 1].close : bar.open;
          state = 'TOUCHING';
          if (prevClose > top) { side = 1; extremePrice = bar.high; }
          else if (prevClose < bot) { side = -1; extremePrice = bar.low; }
          else { side = approachSide; extremePrice = side === 1 ? bar.high : bar.low; }
        }
      } else if (state === 'TOUCHING') {
        if (side === 1) extremePrice = Math.max(extremePrice, bar.high); else extremePrice = Math.min(extremePrice, bar.low);
        if (side === 1) {
          if (bar.close > top) { denialStreak++; state = 'IDLE'; }
          else if (bar.close < bot) { state = 'BREAKING'; barsHeld = 0; }
        } else {
          if (bar.close < bot) { denialStreak++; state = 'IDLE'; }
          else if (bar.close > top) { state = 'BREAKING'; barsHeld = 0; }
        }
      } else if (state === 'BREAKING') {
        if (side === 1) {
          if (bar.close < bot) {
            barsHeld++;
            if (barsHeld === 2) {
              completedBreaks.push({ pivotPrice: pivot.price, entryTsStr: bar.tsStr, entryPrice: bar.close, direction: 'SHORT', stopPrice: extremePrice + band, streak: denialStreak, atr });
              break;
            }
          } else if (bar.close > top) { denialStreak++; state = 'IDLE'; }
          else { state = 'TOUCHING'; }
        } else {
          if (bar.close > top) {
            barsHeld++;
            if (barsHeld === 2) {
              completedBreaks.push({ pivotPrice: pivot.price, entryTsStr: bar.tsStr, entryPrice: bar.close, direction: 'LONG', stopPrice: extremePrice - band, streak: denialStreak, atr });
              break;
            }
          } else if (bar.close < bot) { denialStreak++; state = 'IDLE'; }
          else { state = 'TOUCHING'; }
        }
      }
    }
  }
  return completedBreaks.filter(b => b.streak >= 1); // DEFENDED only
}

async function getDefendedBreaksCached() {
  const cached = cacheGet(CACHE_KEY);
  if (cached != null) return cached;
  const breaks = await computeDefendedBreaks();
  return cacheSet(CACHE_KEY, breaks, CACHE_TTL_MS);
}

// Full detect-and-insert, called from acd.js's runSetupDetection as a single line, matching
// momentumChaseDetector.js's convention -- all of this setup's own logic lives here.
export async function computeMajorPivotDefendedBreakSignal(todayET) {
  try {
    const breaks = await getDefendedBreaksCached();
    if (!breaks.length) return null;

    const nowMs = Date.now();
    const recent = breaks.filter(b => {
      // etNaiveTimestampToMs, NOT new Date(str+'Z') -- b.entryTsStr is naive ET, and Date.now()
      // is genuinely UTC; mislabeling ET-as-UTC here made every fresh signal compute as ~4-5h
      // old (the ET/UTC offset), always exceeding RECENT_BREAK_WINDOW_MIN. Found via DeepSeek
      // code review 2026-09-10, confirmed by direct calculation before fixing. entryDate below
      // (used for etModOf/expiresAt) is deliberately left as the naive-mislabeled parse -- that
      // usage is self-consistent naive-ET arithmetic and was never actually wrong.
      const entryMs = etNaiveTimestampToMs(b.entryTsStr);
      return nowMs - entryMs <= RECENT_BREAK_WINDOW_MIN * 60000 && nowMs - entryMs >= 0;
    });
    if (!recent.length) return null;

    const inserted = [];
    for (const b of recent) {
      const entryDate = new Date(b.entryTsStr.replace(' ', 'T') + 'Z');
      const entryMod = etModOf(entryDate);
      const session = isGlobexMod(entryMod) ? 'GLOBEX' : 'RTH';
      // Globex arm (config "A") RE-ENABLED 2026-09-14, SHADOW-ONLY -- was a hard `continue`
      // (zero rows, not even SHADOW) from 2026-09-10 through today, after a strict day-blocked-
      // bootstrap + full-placebo-range standard found 0/64 stop/target/hold cells clear the bar
      // (RESEARCH_CLAIM major_pivot_globex_regrid_0of64_20260910) at real N=24, and extending
      // the backtest window to settle it was found not viable (price_bars_primary's pre-2025 NQ
      // data is almost entirely single daily placeholder rows, RESEARCH_CLAIM
      // major_pivot_globex_extend_history_not_viable_20260910). That `continue` was a genuine
      // dead end, not caution: this insert path ALREADY hardcodes 'SHADOW','SHADOW' (see the
      // INSERT below) with no ACTIVE path anywhere in this file, so skipping outright meant real
      // Globex N could never grow past 24 no matter how long the code sat unchanged -- the
      // opposite of every other thin-N mechanism in this codebase, which keeps accumulating real
      // outcome data via SHADOW while suppressed. Re-enabled specifically to fix that: same
      // (still-disproven) CONFIG.GLOBEX below, still zero live-capital risk (SHADOW is hardcoded,
      // not eligibility-derived), purely to let real N start growing again from today forward.
      // OPEN_DECISION major_pivot_globex_shadow_reeval_pending_20260914 tracks re-running the
      // same rigor standard (major_pivot_globex_regrid_0of64_20260910's method) once real SHADOW
      // N clears 20 -- do NOT treat any pre-20260914 pooled number as still representative once
      // this has accumulated new data, and do NOT let this silently go ACTIVE anywhere else in
      // the codebase without that fresh check (this file itself has no such path, but don't add
      // one elsewhere without it). RTH arm (config "B") is unaffected, was already SHADOW-only.
      const cfg = CONFIG[session];

      const sign = b.direction === 'LONG' ? 1 : -1;
      const stopDist = Math.abs(b.entryPrice - b.stopPrice) * cfg.stopMult;
      const stopPx = b.entryPrice - sign * stopDist;
      const targetPx = b.entryPrice + sign * cfg.targetMult * b.atr;
      const expiresAt = new Date(entryDate.getTime() + cfg.holdMin * 60000);
      const setupType = `MAJOR_PIVOT_DEFENDED_BREAK_${b.direction}`;
      const t1Label = `${session}-config ${cfg.targetMult}x ATR target, ${cfg.holdMin}min hold (uncapped past session boundary -- see file header)`.slice(0, 100);

      const ins = await query(`
        INSERT INTO active_setups (
          trade_date, setup_type, fired_at, expires_at, status, origin_status,
          entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label,
          price_at_detection, structural_level_touched, structural_level_type, bet_class
        ) VALUES ($1,$2,$3,$4,'SHADOW','SHADOW',$5,$5,$6,$7,$8,$5,$9,'MAJOR_SWING_PIVOT',$10)
        ON CONFLICT DO NOTHING
        RETURNING id, trade_date, fired_at::text as fired_at, expires_at::text as expires_at, entry_zone_low, stop_level, t1_level, t1_label
      `, [
        b.entryTsStr.slice(0, 10), setupType, b.entryTsStr, expiresAt.toISOString().slice(0, 19).replace('T', ' '),
        b.entryPrice, stopPx, targetPx, t1Label, b.pivotPrice, getBetClass(setupType),
      ]);
      if (ins.rows[0]) {
        try { await dropToTimeline(ins.rows[0]); } catch (_) {}
        inserted.push(ins.rows[0]);
      }
    }
    return inserted.length ? inserted : null;
  } catch (_) { return null; /* informational-only build, never block the response */ }
}
