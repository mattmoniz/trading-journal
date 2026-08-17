// Real-data runner/trailing-exit simulation arms for docs/RUNNER_TRAIL_REALDATA_SPEC.md.
// Research-only (scripts/backtest_runner_trail_realdata.mjs) — NOT wired into
// resolveSetupsByPrice() or any live path. Reuses directionFromType()/the bars shape from
// maeMfeReplay.js's replayBars() so all three arms (baseline + these two) share the exact
// same entry/stop/direction and walk the exact same real bars — the confound checklist's
// "same entry, only exit differs" control is structural here, not something to re-derive
// per trade.
//
// computeStructuralStopAnchors() ports compute_structural_stop_anchors() from
// docs/structural_runner_optimization_20260814.py (Gemini's causal zigzag, 2026-08-14) —
// direction-mirrored for SHORT (tracks swing highs instead of swing lows), never run
// against real data before this. Per "export the real function, don't reimplement" — this
// is the same pivot logic, translated to JS, not a redesign.

// Causal, no-lookahead: anchors[t] depends only on bars[0..t].
// direction === 'LONG'  -> tracks the confirmed swing LOW  (a rising stop-anchor)
// direction === 'SHORT' -> tracks the confirmed swing HIGH (a falling stop-anchor), mirror
// image of the LONG case with high/low and the comparison directions flipped.
function computeStructuralStopAnchors(bars, pivotThreshold, direction) {
  const n = bars.length;
  const anchors = new Array(n).fill(null);
  if (n < 3) return anchors;

  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);

  if (direction === 'LONG') {
    let currentAnchor = lows[0];
    let trend = 'downtrend'; // mirrors the Python original's initial state exactly
    let lastPeak = highs[0];
    let lastTrough = lows[0];

    for (let t = 1; t < n; t++) {
      const hi = highs[t], lo = lows[t];
      if (trend === 'downtrend') {
        if (lo < lastTrough) {
          lastTrough = lo;
          currentAnchor = lastTrough;
        } else if (hi > lastPeak * (1 + pivotThreshold)) {
          trend = 'uptrend';
          lastPeak = hi;
        }
      } else {
        if (hi > lastPeak) {
          lastPeak = hi;
        } else if (lo < lastTrough * (1 - pivotThreshold)) {
          trend = 'downtrend';
          lastTrough = lo;
          currentAnchor = lastTrough;
        }
      }
      anchors[t] = currentAnchor;
    }
    anchors[0] = n > 1 ? anchors[1] : lows[0];
  } else {
    // SHORT: mirror image — tracks swing HIGHS as the (falling) stop anchor.
    let currentAnchor = highs[0];
    let trend = 'uptrend';
    let lastTrough = lows[0];
    let lastPeak = highs[0];

    for (let t = 1; t < n; t++) {
      const hi = highs[t], lo = lows[t];
      if (trend === 'uptrend') {
        if (hi > lastPeak) {
          lastPeak = hi;
          currentAnchor = lastPeak;
        } else if (lo < lastTrough * (1 - pivotThreshold)) {
          trend = 'downtrend';
          lastTrough = lo;
        }
      } else {
        if (lo < lastTrough) {
          lastTrough = lo;
        } else if (hi > lastPeak * (1 + pivotThreshold)) {
          trend = 'uptrend';
          lastPeak = hi;
          currentAnchor = lastPeak;
        }
      }
      anchors[t] = currentAnchor;
    }
    anchors[0] = n > 1 ? anchors[1] : highs[0];
  }

  // ffill (matches the Python `.ffill()` — only null at genuine leading gaps, none expected here)
  for (let t = 1; t < n; t++) if (anchors[t] == null) anchors[t] = anchors[t - 1];
  return anchors;
}

// Causal ATR (simple rolling mean of true range over `lookback` bars ending at t, using
// only bars[0..t]) — Wilder's smoothing not used here to keep this auditable/simple,
// matching the spec's explicit "fixed atrLookback, not swept" simplification.
function computeCausalAtr(bars, lookback) {
  const n = bars.length;
  const tr = new Array(n).fill(0);
  for (let t = 0; t < n; t++) {
    const b = bars[t];
    const prevClose = t > 0 ? bars[t - 1].close : b.close;
    tr[t] = Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
  }
  const atr = new Array(n).fill(null);
  let sum = 0;
  for (let t = 0; t < n; t++) {
    sum += tr[t];
    if (t >= lookback) sum -= tr[t - lookback];
    const count = Math.min(t + 1, lookback);
    atr[t] = sum / count;
  }
  return atr;
}

// Shared post-activation walk: given a pre-computed per-bar trail-stop candidate function,
// walks bars from the activation bar forward, ratcheting only in the favorable direction.
// Running off the end of `bars` returns TIME_EXPIRED at the last close -- callers must pass
// an already RTH-bounded bar array (matching computeMaeMfe()'s <=960 ET-minute filter), same
// convention as replayBars(); this function doesn't re-check session-end itself.
function walkWithTrail(bars, entry, initialStop, direction, activationR, entryRisk, trailStopAt) {
  let armed = false;
  let trailStop = initialStop;
  let mfe = 0, mae = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const favorable = direction === 'LONG' ? bar.high - entry : entry - bar.low;
    const adverse = direction === 'LONG' ? entry - bar.low : bar.high - entry;
    mfe = Math.max(mfe, favorable);
    mae = Math.max(mae, adverse);

    if (!armed) {
      const stopHit = direction === 'LONG' ? bar.low <= initialStop : bar.high >= initialStop;
      if (stopHit) {
        return { mfe, mae, barsToResolution: i + 1, resolutionBarTime: bar.ts, replayResolution: 'STOP_HIT', exitPrice: initialStop, method: 'FIXED_STOP_PRE_ACTIVATION' };
      }
      const runR = direction === 'LONG' ? (bar.high - entry) / entryRisk : (entry - bar.low) / entryRisk;
      if (runR >= activationR) armed = true;
    }

    if (armed) {
      const candidate = trailStopAt(i);
      if (candidate != null) {
        trailStop = direction === 'LONG' ? Math.max(trailStop, candidate) : Math.min(trailStop, candidate);
      }
      const trailHit = direction === 'LONG' ? bar.low <= trailStop : bar.high >= trailStop;
      if (trailHit) {
        return { mfe, mae, barsToResolution: i + 1, resolutionBarTime: bar.ts, replayResolution: trailStop === initialStop ? 'STOP_HIT' : 'TRAIL_EXIT', exitPrice: trailStop, method: 'TRAIL_HIT' };
      }
    }
  }

  const last = bars[bars.length - 1];
  return { mfe, mae, barsToResolution: bars.length, resolutionBarTime: last?.ts ?? null, replayResolution: 'TIME_EXPIRED', exitPrice: last?.close ?? entry, method: 'TRAIL_TIME_EXPIRED' };
}

// Arm 2: ATR-band trail. Activates at activationR * initial risk, then trails at
// rolling_high/low(atrLookback) -/+ atrMult*ATR(atrLookback), ratchet-only.
function replayBarsWithAtrTrail(bars, entry, stop, t1, direction, { activationR, atrMult, atrLookback = 14 }) {
  const entryRisk = direction === 'LONG' ? entry - stop : stop - entry;
  if (entryRisk <= 0 || !bars || bars.length === 0) return null;

  const atr = computeCausalAtr(bars, atrLookback);
  let rollingExtreme = direction === 'LONG' ? -Infinity : Infinity;

  const trailStopAt = (i) => {
    const bar = bars[i];
    rollingExtreme = direction === 'LONG' ? Math.max(rollingExtreme, bar.high) : Math.min(rollingExtreme, bar.low);
    const a = atr[i];
    if (a == null) return null;
    return direction === 'LONG' ? rollingExtreme - atrMult * a : rollingExtreme + atrMult * a;
  };

  return walkWithTrail(bars, entry, stop, direction, activationR, entryRisk, trailStopAt);
}

// Arm 3: structural zigzag trail. Activates at activationR * initial risk, then trails at
// the most recent confirmed swing anchor (as of the PRIOR bar, matching the Python
// original's `anchor_idx = max(0, t - 1)` — the anchor used to evaluate bar t must not
// include bar t's own extreme, or activation and stop-check on the same bar would leak).
function replayBarsWithStructuralTrail(bars, entry, stop, t1, direction, { activationR, pivotThreshold, tickOffset }) {
  const entryRisk = direction === 'LONG' ? entry - stop : stop - entry;
  if (entryRisk <= 0 || !bars || bars.length === 0) return null;

  const anchors = computeStructuralStopAnchors(bars, pivotThreshold, direction);

  const trailStopAt = (i) => {
    const anchorIdx = Math.max(0, i - 1);
    const anchor = anchors[anchorIdx];
    if (anchor == null) return null;
    return direction === 'LONG' ? anchor - tickOffset : anchor + tickOffset;
  };

  return walkWithTrail(bars, entry, stop, direction, activationR, entryRisk, trailStopAt);
}

export { computeStructuralStopAnchors, computeCausalAtr, replayBarsWithAtrTrail, replayBarsWithStructuralTrail };
