// Canonical "did price make a real swing" detector -- extracted 2026-09-16 (user request,
// after asking "how many points per rotation" / "does it match what I see on screen" about
// morningBrief.js's live Session/CHOP chip) so any future feature that needs "how many real
// price swings happened, and how big" has one obvious, shared, already-validated place to
// import from, instead of writing a 5th independent copy.
//
// This is the SAME core reversal rule as pocRotationService.js's detectSignalEvents() --
// running_high/running_low tracked from each bar's own high/low (never close), a reversal
// confirmed the moment price moves >= R points away from the running extreme in the opposite
// direction. R=65 is that file's own "validated construction" (poc_rotation_join_fade_levels_
// med50_fixed) -- the exact threshold that already gates the real, live POC_ROTATION_JOIN_LONG/
// SHORT setup -- reused here rather than guessed, per this codebase's "export the real
// function, never reimplement" rule.
//
// Before this existed, the same "count real swings" idea had been independently reimplemented
// 3 separate times, only one of which (detectSignalEvents(), inside pocRotationService.js)
// used real intrabar highs/lows:
//   1. morningBrief.js's classifySessionChar() (the live Session/CHOP chip + Session Trend
//      History popup) -- 5-min-bucketed CLOSE-only, threshold = ATR20*0.15 (a guessed,
//      volatility-scaled number, 39pt on the day this was found).
//   2. patternScannerService.js's detectRotationProfile() -- ALSO 5-min-bucketed close-only,
//      feeding session_analysis.rotations_65pt (the "65pt" name suggests it once intended to
//      match this file's real threshold, but never adopted the real intrabar-high/low logic).
//      Deliberately NOT repointed at this shared detector yet -- it feeds nightly pattern-
//      mining thresholds (patternScannerService.js's own `rotations_65pt >= 15` cutoff) tuned
//      against its own close-only counting convention; switching methodology would silently
//      change how often those patterns fire. Flag before touching.
//   3. morningBrief.js's getTrailingRotations() (the 90-day mean/std baseline the CHOP/
//      EXTREME_CHOP labels are judged against) used to read session_analysis.rotations_65pt --
//      i.e. copy #2's output -- meaning the live chip (copy #1's close-only, ATR-scaled count)
//      was being compared against a baseline computed by a DIFFERENT method entirely. Fixed
//      the same session: both sides of that comparison now go through THIS function.
// Confirmed live the close-only version undercounts real swings: 29 of 80 five-minute buckets
// on the day this was found had an intrabar high-low range bigger than the close-based
// threshold (several 100pt+), none of which ever registered as a rotation.
//
// `bars` must be ordered chronologically and each carry numeric `high`/`low` fields (NOT
// just `close`) -- this is fully causal (only ever compares up to the current bar, matching
// this codebase's "no lookahead in backtests/replays" rule), so it's safe to call on a
// bars-so-far slice for a live, in-progress session.
import { query } from '../db.js';

export const ROTATION_LEG_THRESHOLD = 65;

// Shared "get tonight's real overnight-session bars" fetch, extracted 2026-09-23 after finding
// this exact query duplicated (byte-identical) in globexRotationBadge.js AND
// overnightOrderflowEntryDetector.js -- both hardcoded `ts::date = $1::date - 1 AND hour>=18`
// for the evening half, which assumes "today's" evening bars are always dated the day BEFORE
// whatever CURRENT_DATE currently is. That's only true once the calendar has actually rolled
// past midnight -- checked any time in the EVENING itself (6pm-midnight, CURRENT_DATE still
// showing today's own date), it silently fetches the WRONG, already-finished PRIOR overnight
// session's bars instead of tonight's live-in-progress one. Found 2026-09-23 (user, checking
// the badge at 9:44pm the night before, saw "6 rotations" that turned out to describe the
// PRECEDING night's session, not the one that had just started) -- confirmed directly: querying
// with todayET='2026-09-22' at that moment returned bars from 2026-09-21 18:00 through
// 2026-09-22 09:29, a completely different, already-closed session.
// overnightOrderflowEntryDetector.js's own entry check happened to be immune in practice (it
// only ever runs this query AFTER its 12am-1am entry window opens, by which point CURRENT_DATE
// has already rolled over and the old arithmetic is coincidentally correct) -- but that's a
// property of ITS OWN gating, not of this query, and the badge has no such gate (a user can
// check it any time). Fixed properly here: derive the evening/morning calendar dates from
// whether `nowET` itself is currently on the evening side (hour>=18) or the early-morning side
// (hour<18) of the overnight window, rather than assuming a fixed date-minus-one relationship.
function addDaysToDateStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export async function getOvernightSessionBars(nowET, todayET) {
  // nowET is built via this codebase's standard Z-mislabeled-naive-timestamp convention
  // (see globexRotationBadge.js's own header) -- read back with getUTCHours(), never local.
  const hh = nowET.getUTCHours();
  const eveningDate = hh >= 18 ? todayET : addDaysToDateStr(todayET, -1);
  const morningDate = hh >= 18 ? addDaysToDateStr(todayET, 1) : todayET;
  const r = await query(`
    SELECT ts::text as ts, high::float, low::float, close::float,
      COALESCE(bid_volume,0)::float as bid_volume, COALESCE(ask_volume,0)::float as ask_volume
    FROM price_bars_primary WHERE symbol='NQ'
      AND ((ts::date = $1::date AND EXTRACT(hour FROM ts) >= 18)
        OR (ts::date = $2::date AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) < 570))
    ORDER BY ts ASC
  `, [eveningDate, morningDate]);
  return r.rows;
}

export function detectRotationLegs(bars, R = ROTATION_LEG_THRESHOLD) {
  if (!bars.length) return [];
  const legs = [];
  let running_high = bars[0].high, running_high_idx = 0;
  let running_low = bars[0].low, running_low_idx = 0;
  let pivot_is_low = null; // null until the first leg confirms, matching detectSignalEvents()

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (bar.high > running_high) { running_high = bar.high; running_high_idx = i; }
    if (bar.low < running_low) { running_low = bar.low; running_low_idx = i; }

    let confirmed = null;
    if (pivot_is_low === null) {
      if (running_high - bar.low >= R) {
        confirmed = { dir: 'DOWN', anchorIdx: running_high_idx, idx: i, size: Math.round(running_high - bar.low) };
        pivot_is_low = false;
      } else if (bar.high - running_low >= R) {
        confirmed = { dir: 'UP', anchorIdx: running_low_idx, idx: i, size: Math.round(bar.high - running_low) };
        pivot_is_low = true;
      }
    } else if (pivot_is_low === true) {
      if (running_high - bar.low >= R) {
        confirmed = { dir: 'DOWN', anchorIdx: running_high_idx, idx: i, size: Math.round(running_high - bar.low) };
        pivot_is_low = false;
      }
    } else {
      if (bar.high - running_low >= R) {
        confirmed = { dir: 'UP', anchorIdx: running_low_idx, idx: i, size: Math.round(bar.high - running_low) };
        pivot_is_low = true;
      }
    }

    if (confirmed) {
      legs.push(confirmed);
      running_high = bar.high; running_low = bar.low;
      running_high_idx = i; running_low_idx = i;
    }
  }
  return legs;
}
