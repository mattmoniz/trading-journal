// Shared candlestick reversal-pattern classifier.
//
// Origin: 2026-07-21, user asked whether known candle patterns near a tested MGI
// level can improve entry timing/confirmation for level fades. The touch-quality
// pilot (docs/OPEN_THREADS.md, 2026-07-15) already tried a price-action approach
// to this same question (reaction speed / adverse-excursion-before-reversal) and
// found it did NOT generalize corpus-wide -- real for one setup_type, flat for
// another, inverted for a third. Classic candle patterns are a more specific
// flavor of the same "what does price do right at the touch" question, so this
// module exists to test the same hypothesis with a different, well-established
// feature set -- same expectation of a per-setup_type result, not a blanket rule.
//
// Per CLAUDE.md's no-static-thresholds rule: "small body", "long wick", "strong
// bar" are never fixed point/pixel cutoffs -- they're derived from a rolling
// trailing distribution of THIS instrument's own bar body/wick/range sizes,
// computed fresh per date (same "baseline from trailing history, computed live"
// convention as touchQuality.js's volume z-score).
//
// classifyReversalPattern() takes an ordered window of consecutive bars (the
// same touch-relative reaction window convention used by touchQuality.js) and
// returns the first matching pattern in the FAVORABLE direction for the fade,
// or null. Used only as an exploratory classification dimension -- like
// touchQuality.js, this must never itself gate resolution/pnl/stops.
//
// 8 pattern families (16 directional variants) as of 2026-07-21 -- user asked
// to go past the original 6 if useful, so Harami and Three Soldiers/Crows were
// added as two more standard, well-documented (Nison) patterns that are
// geometrically distinct from the original 6 (avoided adding Inverted Hammer/
// Hanging Man/Belt Hold since those collapse onto the same bar shape as Hammer/
// Shooting Star in this single-direction-per-fade framing without adding a real
// new geometric feature).
//
// 13 pattern families as of 2026-07-21 (later same day): added Spinning Top/High
// Wave (small body, long wicks BOTH sides -- distinct from Hammer's one-sided
// wick and Doji's near-zero body), Marubozu (body dominates the range, tiny
// wicks both sides -- a conviction bar, not a rejection), Belt Hold (opens at
// one extreme with near-zero wick there, closes strongly the other way), and
// Three Inside/Outside Up/Down (Harami/Engulfing extended with a third
// confirming bar -- checked with priority over the plain 2-bar version since
// the confirmed variant is the stronger signal). Skipped gap-dependent classics
// (Abandoned Baby, Kicker) -- barsAdjacent() already treats any >5min gap as
// "not consecutive," and real no-overlap gaps in this continuous-bar dataset
// only occur at exactly the session boundaries that guard excludes, so those
// patterns would essentially never fire here. Deferred Inverted Hammer/Hanging
// Man -- geometrically identical to Hammer/Shooting Star without a prior-trend
// classifier to distinguish them, which doesn't exist in this codebase yet.

function body(b) { return Math.abs(b.close - b.open); }
function upperWick(b) { return b.high - Math.max(b.open, b.close); }
function lowerWick(b) { return Math.min(b.open, b.close) - b.low; }
function range(b) { return b.high - b.low; }
function isBullish(b) { return b.close > b.open; }
function isBearish(b) { return b.close < b.open; }

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Trailing lookbackDays distribution of body/wick/range size, strictly BEFORE
// `date` (no lookahead) -- mirrors touchQuality.js's getVolumeBaseline query shape.
async function getBarShapeBaseline(queryFn, date, symbol = 'NQ', lookbackDays = 90) {
  const res = await queryFn(`
    SELECT open::float, high::float, low::float, close::float
    FROM price_bars_primary
    WHERE symbol = $1 AND ts::date >= $2::date - ($3 || ' days')::interval AND ts::date < $2::date
  `, [symbol, date, lookbackDays]);
  if (res.rows.length === 0) return null;
  const bodies = res.rows.map(body).sort((a, b) => a - b);
  const wicks = res.rows.map(b => Math.max(upperWick(b), lowerWick(b))).sort((a, b) => a - b);
  const ranges = res.rows.map(range).sort((a, b) => a - b);
  return {
    bodyP10: percentile(bodies, 0.10),
    bodyP25: percentile(bodies, 0.25),
    bodyP50: percentile(bodies, 0.50),
    wickP75: percentile(wicks, 0.75),
    rangeP25: percentile(ranges, 0.25),
  };
}

// windowBars: ordered 1-min bars starting at/after the touch (fired_at), same
// slice callers already build for touchQuality.js's classifyTouch(). Slides
// 1/2/3-bar combinations across the window and returns the first match, in a
// fixed priority order (single-bar patterns checked first since they resolve
// fastest -- ties are broken by which pattern's evidence appears earliest).
// Bars are genuinely gap-free 1-min data during RTH and most of Globex (verified
// directly: 1 gap in 15,878 RTH bars, 1 in 41,816 overnight bars over a 60-day
// sample) -- EXCEPT the daily 5-6PM ET CME maintenance halt (~72 real ~60-min
// gaps in that same sample) and the weekend reopen. Array-adjacent bars are not
// automatically time-adjacent across those boundaries. A multi-bar pattern
// (Engulfing/Piercing/Harami/Tweezer/Star/Soldiers-Crows) spanning a halt or
// weekend gap would compare pre-halt and post-halt/post-weekend price as if it
// were one continuous candle sequence -- a reopen jump could misclassify as a
// real reversal. MAX_ADJACENT_GAP_MIN=5 comfortably covers the largest observed
// legitimate quiet-minute gap (2 min) while clearly excluding halt/weekend gaps.
const MAX_ADJACENT_GAP_MIN = 5;
function barsAdjacent(a, b) {
  return (new Date(b.ts) - new Date(a.ts)) <= MAX_ADJACENT_GAP_MIN * 60 * 1000;
}

function classifyReversalPattern({ windowBars, direction, baseline }) {
  if (!baseline || !windowBars || windowBars.length === 0) return null;
  const { bodyP10, bodyP25, bodyP50, wickP75, rangeP25 } = baseline;
  if ([bodyP10, bodyP25, bodyP50, wickP75, rangeP25].some(v => v == null)) return null;
  const wantBullish = direction === 'LONG';

  for (let i = 0; i < windowBars.length; i++) {
    const b1 = windowBars[i];

    // 1. Hammer / Shooting Star (single bar, small body + long opposing wick)
    if (body(b1) <= bodyP25) {
      if (wantBullish && lowerWick(b1) >= wickP75 && upperWick(b1) <= bodyP25) {
        return { pattern: 'HAMMER', barIndex: i };
      }
      if (!wantBullish && upperWick(b1) >= wickP75 && lowerWick(b1) <= bodyP25) {
        return { pattern: 'SHOOTING_STAR', barIndex: i };
      }
    }

    // 2. Doji, confirmed by the NEXT bar in the window closing beyond the doji's
    // high/low in the fade's favor -- avoids calling an undecided bar a signal
    // on its own (confirmation stays inside the window, so still no lookahead).
    if (body(b1) <= bodyP10 && i + 1 < windowBars.length && barsAdjacent(b1, windowBars[i + 1])) {
      const b2 = windowBars[i + 1];
      if (wantBullish && b2.close > b1.high) return { pattern: 'DOJI_CONFIRMED', barIndex: i + 1 };
      if (!wantBullish && b2.close < b1.low) return { pattern: 'DOJI_CONFIRMED', barIndex: i + 1 };
    }

    // 2b. Spinning Top / High Wave, same confirmation convention as Doji -- unlike
    // Doji (near-zero body) this is a small body with LONG wicks on BOTH sides
    // (real intrabar fighting, resolved as indecision rather than a clean
    // rejection), and unlike Hammer/Shooting Star (one dominant wick, one small)
    // neither side dominates here.
    if (body(b1) <= bodyP25 && upperWick(b1) >= wickP75 && lowerWick(b1) >= wickP75
        && i + 1 < windowBars.length && barsAdjacent(b1, windowBars[i + 1])) {
      const b2 = windowBars[i + 1];
      if (wantBullish && b2.close > b1.high) return { pattern: 'SPINNING_TOP_CONFIRMED', barIndex: i + 1 };
      if (!wantBullish && b2.close < b1.low) return { pattern: 'SPINNING_TOP_CONFIRMED', barIndex: i + 1 };
    }

    // 2c. Marubozu (single bar): body dominates the whole range -- open/close sit
    // right at (or almost at) the high/low, both wicks tiny. A conviction/momentum
    // bar rather than a rejection wick.
    if (body(b1) >= bodyP50 && upperWick(b1) <= bodyP10 && lowerWick(b1) <= bodyP10) {
      if (wantBullish && isBullish(b1)) return { pattern: 'BULLISH_MARUBOZU', barIndex: i };
      if (!wantBullish && isBearish(b1)) return { pattern: 'BEARISH_MARUBOZU', barIndex: i };
    }

    // 2d. Belt Hold (single bar): opens right at one extreme (near-zero wick on
    // that side, unlike Marubozu which requires both sides tiny) and closes
    // strongly toward the other extreme -- a single-bar reversal bar distinct
    // from Hammer's small-body-plus-wick shape.
    if (body(b1) >= bodyP50) {
      if (wantBullish && isBullish(b1) && lowerWick(b1) <= bodyP10) return { pattern: 'BULLISH_BELT_HOLD', barIndex: i };
      if (!wantBullish && isBearish(b1) && upperWick(b1) <= bodyP10) return { pattern: 'BEARISH_BELT_HOLD', barIndex: i };
    }

    if (i + 1 >= windowBars.length) continue;
    const b2 = windowBars[i + 1];
    if (!barsAdjacent(b1, b2)) continue; // halt/weekend gap -- not a real consecutive candle pair

    // 3. Engulfing (2-bar), extended to Three Outside Up/Down when a third bar
    // confirms further in the same favorable direction -- checked first since a
    // confirmed 3-bar version is the stronger signal; falls back to plain
    // Engulfing if no adjacent third bar or it doesn't confirm.
    if (wantBullish && isBearish(b1) && isBullish(b2) && b2.open <= b1.close && b2.close >= b1.open && body(b2) > body(b1)) {
      if (i + 2 < windowBars.length && barsAdjacent(b2, windowBars[i + 2])) {
        const b3 = windowBars[i + 2];
        if (isBullish(b3) && b3.close > b2.close) return { pattern: 'THREE_OUTSIDE_UP', barIndex: i + 2 };
      }
      return { pattern: 'BULLISH_ENGULFING', barIndex: i + 1 };
    }
    if (!wantBullish && isBullish(b1) && isBearish(b2) && b2.open >= b1.close && b2.close <= b1.open && body(b2) > body(b1)) {
      if (i + 2 < windowBars.length && barsAdjacent(b2, windowBars[i + 2])) {
        const b3 = windowBars[i + 2];
        if (isBearish(b3) && b3.close < b2.close) return { pattern: 'THREE_OUTSIDE_DOWN', barIndex: i + 2 };
      }
      return { pattern: 'BEARISH_ENGULFING', barIndex: i + 1 };
    }

    // 4. Piercing Line / Dark Cloud Cover (2-bar): strong adverse bar, then a bar
    // opening beyond its close but closing back past the midpoint of its body.
    const mid1 = (b1.open + b1.close) / 2;
    if (wantBullish && isBearish(b1) && body(b1) >= bodyP50 && b2.open <= b1.close && b2.close > mid1 && b2.close < b1.open) {
      return { pattern: 'PIERCING_LINE', barIndex: i + 1 };
    }
    if (!wantBullish && isBullish(b1) && body(b1) >= bodyP50 && b2.open >= b1.close && b2.close < mid1 && b2.close > b1.open) {
      return { pattern: 'DARK_CLOUD_COVER', barIndex: i + 1 };
    }

    // 5. Tweezer Bottom / Top (2+ bar, matching lows/highs within rolling range tolerance)
    if (wantBullish && Math.abs(b1.low - b2.low) <= rangeP25 && b2.close > b1.low) {
      return { pattern: 'TWEEZER_BOTTOM', barIndex: i + 1 };
    }
    if (!wantBullish && Math.abs(b1.high - b2.high) <= rangeP25 && b2.close < b1.high) {
      return { pattern: 'TWEEZER_TOP', barIndex: i + 1 };
    }

    // 6. Morning Star / Evening Star (3-bar)
    if (i + 2 < windowBars.length && barsAdjacent(b2, windowBars[i + 2])) {
      const b3 = windowBars[i + 2];
      if (wantBullish && isBearish(b1) && body(b1) >= bodyP50 && body(b2) <= bodyP25
          && isBullish(b3) && body(b3) >= bodyP50 && b3.close > mid1) {
        return { pattern: 'MORNING_STAR', barIndex: i + 2 };
      }
      if (!wantBullish && isBullish(b1) && body(b1) >= bodyP50 && body(b2) <= bodyP25
          && isBearish(b3) && body(b3) >= bodyP50 && b3.close < mid1) {
        return { pattern: 'EVENING_STAR', barIndex: i + 2 };
      }
    }

    // 7. Harami (2-bar): bar1's entire body contained inside bar0's large,
    // opposite-colored body -- momentum stalling out. Bullish harami wants a
    // large bearish bar0 (the adverse move into the level) followed by a small
    // contained bar; bar1's own color isn't required either way, matching the
    // classical definition (containment is the signal, not bar1's polarity).
    // Extended to Three Inside Up/Down when a third bar closes beyond bar0's own
    // open -- a stronger confirmation than the plain Harami's "momentum stalled"
    // read; checked first for the same reason as the Engulfing extension above.
    const b1BodyHi = Math.max(b1.open, b1.close), b1BodyLo = Math.min(b1.open, b1.close);
    const b2BodyHi = Math.max(b2.open, b2.close), b2BodyLo = Math.min(b2.open, b2.close);
    if (wantBullish && isBearish(b1) && body(b1) >= bodyP50 && b2BodyHi <= b1BodyHi && b2BodyLo >= b1BodyLo) {
      if (i + 2 < windowBars.length && barsAdjacent(b2, windowBars[i + 2])) {
        const b3 = windowBars[i + 2];
        if (b3.close > b1.open) return { pattern: 'THREE_INSIDE_UP', barIndex: i + 2 };
      }
      return { pattern: 'BULLISH_HARAMI', barIndex: i + 1 };
    }
    if (!wantBullish && isBullish(b1) && body(b1) >= bodyP50 && b2BodyHi <= b1BodyHi && b2BodyLo >= b1BodyLo) {
      if (i + 2 < windowBars.length && barsAdjacent(b2, windowBars[i + 2])) {
        const b3 = windowBars[i + 2];
        if (b3.close < b1.open) return { pattern: 'THREE_INSIDE_DOWN', barIndex: i + 2 };
      }
      return { pattern: 'BEARISH_HARAMI', barIndex: i + 1 };
    }

    // 8. Three White Soldiers / Three Black Crows (3-bar): three consecutive
    // substantial same-direction bars, each opening within the prior bar's body
    // (no gap-and-run) and closing progressively further, with a small opposing
    // wick (strong close near the extreme) -- sustained conviction, not a single
    // spike.
    if (i + 2 < windowBars.length && barsAdjacent(b2, windowBars[i + 2])) {
      const b3 = windowBars[i + 2];
      if (wantBullish && isBullish(b1) && isBullish(b2) && isBullish(b3)
          && body(b1) >= bodyP50 && body(b2) >= bodyP50 && body(b3) >= bodyP50
          && b2.open >= b1.open && b2.open <= b1.close && b2.close > b1.close
          && b3.open >= b2.open && b3.open <= b2.close && b3.close > b2.close
          && upperWick(b3) <= bodyP25) {
        return { pattern: 'THREE_WHITE_SOLDIERS', barIndex: i + 2 };
      }
      if (!wantBullish && isBearish(b1) && isBearish(b2) && isBearish(b3)
          && body(b1) >= bodyP50 && body(b2) >= bodyP50 && body(b3) >= bodyP50
          && b2.open <= b1.open && b2.open >= b1.close && b2.close < b1.close
          && b3.open <= b2.open && b3.open >= b2.close && b3.close < b2.close
          && lowerWick(b3) <= bodyP25) {
        return { pattern: 'THREE_BLACK_CROWS', barIndex: i + 2 };
      }
    }
  }
  return null;
}

export { getBarShapeBaseline, classifyReversalPattern, body, upperWick, lowerWick, range };
