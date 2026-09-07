// Small, generic technical-indicator helpers with zero dependency on acd.js's own state --
// pure functions over plain bar/price arrays, safe to import from anywhere.
//
// Extracted 2026-09-07 (user-prompted duplication audit) from 2 near-identical inline copies
// in server/routes/acd.js: the bullish-absorption detector (2-min bars) and the RSI-divergence
// detector (15-min bars) each hand-rolled the same bar-resampling loop and the same Wilder's
// RSI(14) computation, differing only in bucket size and variable-name prefixes. Byte-diffed
// against both original call sites before replacing them -- identical output confirmed.

// Buckets an array of 1-min-or-finer bars into `bucketMinutes`-wide OHLC candles, keyed by
// `Math.floor(et_min / bucketMinutes) * bucketMinutes`. `open` is set once, from the first bar
// seen in each bucket (correct OHLC semantics); `high`/`low` aggregate across the bucket;
// `close` is always the most recently seen bar's close. Relies on the input bars already being
// in ascending time order (both original call sites' `allRthBarsRow.rows` already are, per this
// codebase's standing convention) so Object.values() below yields chronologically-ordered
// buckets without an explicit sort.
export function resampleBars(bars, bucketMinutes) {
  const buckets = {};
  for (const b of bars) {
    const bk = Math.floor(b.et_min / bucketMinutes) * bucketMinutes;
    if (!buckets[bk]) buckets[bk] = { open: b.open, high: b.high, low: b.low, close: b.close };
    else {
      buckets[bk].high = Math.max(buckets[bk].high, b.high);
      buckets[bk].low = Math.min(buckets[bk].low, b.low);
      buckets[bk].close = b.close;
    }
  }
  return Object.values(buckets);
}

// Standard Wilder's RSI(14): seed average gain/loss over the first 14 periods, then smooth.
// Returns an array the same length as `closes`, with `null` for every index before the first
// computable value (indices 0-13).
export function computeRSI14(closes) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < 15) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= 14; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain += d > 0 ? d : 0;
    avgLoss += d < 0 ? -d : 0;
  }
  avgGain /= 14; avgLoss /= 14;
  rsi[14] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = 15; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * 13 + (d > 0 ? d : 0)) / 14;
    avgLoss = (avgLoss * 13 + (d < 0 ? -d : 0)) / 14;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}
