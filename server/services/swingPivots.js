// Shared fractal swing-high/low detector.
//
// Extracted 2026-09-09 -- this exact N-bars-each-side fractal check already existed as 3
// near-identical inline copies before this file: server/routes/antigravityEdges.js (SW=3,
// 5-min bars, feeds RSI divergence on the live edge card), server/routes/acd.js (SW=2,
// 15-min bars, feeds the live-firing RSI_DIV_BULLISH/SHORT setup), and
// scripts/backtest_unified.js (SW=2). Per CLAUDE.md's "share modules" rule, new callers
// (the cross-session pivot+volume research thread, 2026-09-09) use this instead of adding
// a 4th copy. The 3 existing inline copies are NOT yet rewired to call this -- two of them
// touch live-firing setup logic (acd.js's RSI_DIV_*) and need the same byte-diff-before/after
// verification discipline as any other extraction touching a live path before being switched
// over; left alone for now, tracked as a follow-up, not done blind.
//
// IMPORTANT lag: a bar at index i is only a CONFIRMED swing high/low once `swingWidth` bars
// exist on BOTH sides of it with no higher-high/lower-low. It is NOT knowable in real time
// until swingWidth bars after it prints -- this function does not hide that lag, callers must
// respect it (do not treat bars[bars.length-1] as checkable; the loop already excludes the
// last `swingWidth` bars for exactly this reason).
//
// bars: [{ high, low, ... }] in chronological order, any shape -- only .high/.low are read,
// so this works identically on RTH-only, Globex-only, or a continuous RTH+Globex sequence
// with no session-boundary truncation.
// Returns { highs: [{idx, price}], lows: [{idx, price}] }, sparse over the confirmable range.
export function findSwingPoints(bars, swingWidth) {
  const highs = [], lows = [];
  const fh = bars.map(b => b.high), fl = bars.map(b => b.low);
  for (let i = swingWidth; i < bars.length - swingWidth; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= swingWidth; j++) {
      if (fh[i] <= fh[i - j] || fh[i] <= fh[i + j]) isH = false;
      if (fl[i] >= fl[i - j] || fl[i] >= fl[i + j]) isL = false;
    }
    if (isH) highs.push({ idx: i, price: fh[i] });
    if (isL) lows.push({ idx: i, price: fl[i] });
  }
  return { highs, lows };
}

// Most recent confirmed swing high and low as of `bars`' own end (i.e. as of "now" if bars
// is a live-fetched series) -- convenience wrapper most live/backtest callers actually want,
// rather than the full sparse array.
export function mostRecentSwingPoints(bars, swingWidth) {
  const { highs, lows } = findSwingPoints(bars, swingWidth);
  return {
    lastHigh: highs.length ? highs[highs.length - 1] : null,
    lastLow: lows.length ? lows[lows.length - 1] : null,
  };
}
