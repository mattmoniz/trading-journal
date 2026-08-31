// Shared "has this bar passed the point where a same-day exit mechanism (wider-target,
// breakeven-trail, bank-vs-extend) can still meaningfully benefit from staying open" check.
//
// Found 2026-08-30 (user question: "why didn't the target widen" on a real Overnight/Globex
// PD_POC_FADE_SHORT fire): all three of the mechanisms above had independently hand-rolled
// `bar.ts.slice(11,13) >= '16'` -- an RTH-only assumption that's silently correct for an
// RTH-fired trade (4pm ET or later = no more session time left today) but wrong for a
// Globex-fired trade: a bar fired at 6pm ET already has hour>=16, so the ORIGINAL bar of any
// Globex-hour fire was immediately treated as "session end," blocking every one of these
// mechanisms from ever engaging on an overnight fire, and (for wider-target/breakeven-trail
// specifically) forcing a premature TIME_EXPIRED/MARK_TO_MARKET resolution on the very first bar
// checked instead of letting the trade actually play out.
//
// Verified empirically before fixing: no real (BACKFILL or live) Globex-hour fire has EVER
// armed wider_target_mult, extend_target_level, or runner_trail_width (bool_or(...)=false across
// the whole table for all three) -- this was dormant, not actively misfiring on any observed
// live trade, but would have silently misbehaved the moment any Globex-eligible setup_type
// became eligible for one of these mechanisms (and did visibly misbehave for the RETROACTIVE
// wider-target-counterfactual display, which walks bars for trades regardless of whether the
// live mechanism itself ever armed).
//
// barMod: the CURRENT bar's time-of-day in ET minutes (hour*60+minute) -- every caller already
// has this as the bar row's own `mod` column, no string-parsing needed.
// firedMod: the trade's OWN fired_at time-of-day in ET minutes, computed ONCE per row by the
// caller (not per bar).
//
// FIXED 2026-08-30 (DeepSeek code review round 2, finding R3): the original version treated
// "RTH-origin" as everything NOT in the overnight Globex window (firedMod>=1080 or <570),
// which silently swept the 4:00-6:00pm ET POST_RTH dead zone (firedMod 960-1079) into the
// RTH branch too -- a dead-zone fire's OWN firedMod is already >=960, so `barMod>=960` was
// true on the very first bar checked, instantly marking session-end before the mechanism
// ever got a chance to engage. Same failure shape as the original bug (a real, SHADOW-tracked
// fire denied the mechanism it should have gotten), just a different window. Fixed by making
// "RTH-origin" the NARROW, explicit case (fired strictly during 9:30am-4pm) and routing
// everything else -- overnight Globex AND the dead zone -- through the "next RTH open" rule,
// since neither has any RTH time left today.
// Fired strictly during RTH (9:30am-4pm ET). Exported so callers needing the SAME distinction
// outside this module's own session-end check (e.g. acd.js's wider-target-eligibility upper-
// bound date arithmetic) import this instead of hand-copying the boundary expression again --
// DeepSeek code review round 2, finding R6, caught one such copy already.
//
// firedMod==null defaults to TRUE (RTH-origin) -- self-audit catch, same session: the R3 fix
// below (making RTH-origin the narrow/explicit case) initially broke every pre-existing
// synthetic-walker test, because those tests predate firedMod entirely and never pass it --
// under the old `firedInGlobex = firedMod>=1080||firedMod<570` framing, an undefined firedMod
// fell through to the RTH branch by construction (both Globex comparisons are false against
// undefined). This guard restores that same safe default explicitly, rather than relying on
// undefined's comparison behavior to produce it implicitly.
export function isFiredInRTH(firedMod) {
  if (firedMod == null) return true;
  return firedMod >= 570 && firedMod < 960;
}

export function isPastMechanismSessionEnd(barMod, firedMod) {
  if (isFiredInRTH(firedMod)) {
    // RTH-origin: unchanged from the original (correct-for-RTH) behavior -- 4pm ET (960 min)
    // or later, matching the original `hour>=16` check exactly at the boundary (960min = 16:00).
    return barMod >= 960;
  }
  // Non-RTH origin (overnight Globex OR the 4-6pm dead zone): the natural end, for the
  // purposes of "is there still time left to benefit from staying open," is the next RTH open
  // (9:30am=570). `mod` wraps at midnight (it's an EXTRACT-based time-of-day, not a running day
  // count), so this check is robust to a trade running past midnight with no extra date
  // bookkeeping required. Verified NOT dead code (DeepSeek code review, finding R2): the upper
  // bound (`< 960`) is load-bearing on every evening bar of a Globex-origin trade -- an evening
  // bar's own mod (e.g. 18:01 ET = 1081) is ALSO numerically >=570, so without the upper bound
  // this would incorrectly fire "session end" on the very first evening bar, reintroducing the
  // original bug. Do not simplify to `barMod >= 570`.
  return barMod >= 570 && barMod < 960;
}

// Given a fired_at value in this codebase's standard ET-naive-text convention (matches bar.ts
// elsewhere: HH at [11,13), MM at [14,16)), returns its time-of-day in ET minutes. Callers that
// already have fired_at cast to text (the normal convention -- `fired_at::text as fired_at`)
// should use this instead of re-deriving the slice indices by hand.
//
// GUARD added 2026-08-30 (DeepSeek code review round 2, finding R7): a plain `Date` object used
// to throw here (no `.slice`, acceptable -- loud failure). A UTC ISO string (e.g. an accidental
// `.toISOString()` upstream, "...T22:01:00.000Z") would silently parse the UTC hour as if it
// were ET (4-5h wrong, no error) -- exactly the naive-timestamp footgun CLAUDE.md's own
// "naive timestamp parsing depends on ambient timezone" convention warns about. Both current
// call sites pass this codebase's standard `fired_at::text`/bar-`ts::text` convention (no 'Z'
// suffix, no offset) and are unaffected -- this guard only catches a FUTURE caller passing the
// wrong shape.
export function firedAtToMod(firedAtText) {
  if (typeof firedAtText !== 'string' || /[Zz]|[+-]\d\d:\d\d$/.test(firedAtText)) {
    throw new Error(`firedAtToMod: expected a naive ET wall-clock text value (no timezone suffix), got: ${JSON.stringify(firedAtText)}`);
  }
  const hour = parseInt(firedAtText.slice(11, 13), 10);
  const minute = parseInt(firedAtText.slice(14, 16), 10);
  return hour * 60 + minute;
}
