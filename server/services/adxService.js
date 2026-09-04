// Sierra Chart ADX/DMI implementation, source-verified against sierrachart.com's own
// TechnicalStudiesReference.php on 2026-09-03/04 (WebFetch, not derived from memory) —
// exported per this codebase's own "export the real function, never reimplement" rule after
// this exact formula was independently pasted inline into 3+ scratch/backtest scripts the
// same session it was first verified (/tmp/breakout_adx_clean.mjs, /tmp/second_leg_test3.mjs,
// scratch/daily_adx_*.mjs) — see OPEN_THREADS.md 2026-09-04 / Opus Audit #12 sec "Phase 0.3".
//
// Formula, in order:
//   +DM_t = deltaHigh_t  if deltaHigh_t > -deltaLow_t and deltaHigh_t > 0, else 0
//   -DM_t = -deltaLow_t  if -deltaLow_t > deltaHigh_t and -deltaLow_t > 0, else 0
//   TR_t  = max(H-L, |H-C_prev|, |L-C_prev|)
//   Welles Sum smoothing (separate from, and applied before, the later Wilder's Moving
//   Average step): WS_0 = X_0; WS_t = WS_{t-1} + X_t for 0<t<n; WS_t = WS_{t-1} - WS_{t-1}/n + X_t
//   for t>=n. Applied independently to +DM, -DM, and TR with the same n (nDX).
//   DI+ = 100 * WS(+DM) / WS(TR), DI- mirrors. DX = 100*|DI+-DI-|/(DI++DI-), carrying
//   forward the previous DX when the denominator is 0.
//   ADX seed = simple average of the first nADX DX values; thereafter Wilder's Moving
//   Average: ADX_t = ADX_{t-1} + (1/nADX)*(DX_t - ADX_{t-1}).
//
// Callers pass whatever bar granularity they need (daily OHLC for a regime read, 5-min bars
// for an intraday read, etc.) — this function has no opinion on granularity or on how the
// caller avoids lookahead (e.g. using yesterday's close-of-day value to condition on today's
// trades is the caller's responsibility, not this function's, matching the existing
// daily_adx_bigpop.mjs / breakout_adx_clean.mjs convention of indexing adx[i-1]).
//
// bars: array of { high, low, close } in chronological order. Returns an array the same
// length as bars, with null for indices before the ADX seed is available
// (index < nDX + nADX - 1).
export function computeADXSeries(bars, nDX, nADX) {
  const n = bars.length;
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  const tr = new Array(n).fill(0);

  for (let t = 0; t < n; t++) {
    if (t === 0) {
      tr[t] = bars[0].high - bars[0].low;
      continue;
    }
    const dH = bars[t].high - bars[t - 1].high;
    const dL = bars[t - 1].low - bars[t].low;
    plusDM[t] = (dH > dL && dH > 0) ? dH : 0;
    minusDM[t] = (dL > dH && dL > 0) ? dL : 0;
    tr[t] = Math.max(
      bars[t].high - bars[t].low,
      Math.abs(bars[t].high - bars[t - 1].close),
      Math.abs(bars[t].low - bars[t - 1].close)
    );
  }

  function wellesSum(X, nn) {
    const ws = new Array(n).fill(0);
    for (let t = 0; t < n; t++) {
      if (t === 0) ws[t] = X[0];
      else if (t < nn) ws[t] = ws[t - 1] + X[t];
      else ws[t] = ws[t - 1] - ws[t - 1] / nn + X[t];
    }
    return ws;
  }

  const wsPlusDM = wellesSum(plusDM, nDX);
  const wsMinusDM = wellesSum(minusDM, nDX);
  const wsTR = wellesSum(tr, nDX);

  const dx = new Array(n).fill(null);
  for (let t = 0; t < n; t++) {
    const dp = wsTR[t] > 0 ? 100 * wsPlusDM[t] / wsTR[t] : 0;
    const dm = wsTR[t] > 0 ? 100 * wsMinusDM[t] / wsTR[t] : 0;
    const denom = dp + dm;
    dx[t] = denom > 0 ? 100 * Math.abs(dp - dm) / denom : (t > 0 ? dx[t - 1] : 0);
  }

  const adx = new Array(n).fill(null);
  for (let t = nDX + nADX - 1; t < n; t++) {
    if (t === nDX + nADX - 1) {
      let sum = 0;
      for (let i = t - nADX + 1; i <= t; i++) sum += dx[i];
      adx[t] = sum / nADX;
    } else {
      adx[t] = adx[t - 1] + (1 / nADX) * (dx[t] - adx[t - 1]);
    }
  }
  return adx;
}
