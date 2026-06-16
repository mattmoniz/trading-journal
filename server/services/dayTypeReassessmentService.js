// Live day-type REASSESSMENT engine (additive — read-only, no detection/resolution changes).
//
// The static classifier (classifyDayType, called once at ~10:05 ET) is 52.8%
// accurate and structurally blind to TREND days early (0% detectable at
// 10:00, 36.5% by 11:30 per scripts/daytype_reassessment_backtest.js Part 2).
// This engine takes that static initial read and, at intervals through the
// session, checks whether the day's character has changed using the SAME
// no-lookahead, backtest-validated triggers:
//
//   PRIMARY:   fresh range expansion (since the last reassessment reference
//              point) >= 30% of avg_range_20.  Backtest: 72.6% TPR / 20.4% FPR.
//   CONFIRMING: volatility jump — 5-min log-return stdev (post-anchor vs
//              pre-anchor) >= 1.5x.  Reported as supporting evidence, NOT
//              required to fire (6.2% TPR alone — too rare to gate on).
//   EXCLUDED:  break-and-hold outside IB — backtest proved this is noise
//              (38.9% TPR vs 43.3% FPR, fires MORE on no-change days).
//
// When the range-expansion trigger fires, the engine recomputes the
// ground-truth-style label (trend_str / close-location / range_ratio vs
// IB) using only data available so far, and reassesses toward that label —
// primarily catching BALANCE -> TREND/TURBULENT (72.6% of all real
// character changes in the backtest).
//
// ANTI-FLIP-FLOP:
//   - A reassessment resets the reference range/anchor, so the NEXT change
//     requires a FRESH 30% expansion from the new reference — not the
//     original IB.
//   - Once reassessed AWAY from BALANCE, the engine will never reassess
//     back TO BALANCE (BALANCE is the "default/no-signal" state; flipping
//     back to it on a transient pullback is exactly the oscillation this
//     guards against). This deliberately forgoes the rare TREND->BALANCE /
//     TURBULENT->BALANCE transitions (7/113 character changes in the
//     backtest) in exchange for stability.

const IB_END = 630; // 10:30 ET, in minutes from midnight

export function classifyGroundTruth({ range_ratio, close_pct, trend_str, close_outside_ib }) {
  const isOutside = close_outside_ib === true;
  if (
    (close_pct >= 0.80 || close_pct <= 0.20) &&
    trend_str >= 0.50 &&
    range_ratio >= 0.75 &&
    isOutside
  ) return 'TREND';
  if (range_ratio >= 1.25) return 'TURBULENT';
  return 'BALANCE';
}

function stdevLogReturns(closes) {
  if (closes.length < 3) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    const c0 = closes[i - 1], c1 = closes[i];
    if (c0 > 0 && c1 > 0) rets.push(Math.log(c1 / c0));
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance);
}

function fiveMinCloses(bars) {
  const buckets = {};
  for (const b of bars) {
    const k = Math.floor(b.et_min / 5) * 5;
    buckets[k] = b.close;
  }
  return Object.keys(buckets).sort((a, b) => a - b).map(k => buckets[k]);
}

const fmtT = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * Run the reassessment engine over a session, no-lookahead.
 *
 * @param {object} params
 * @param {string} params.initialRead    - the static classifier's call (TREND/BALANCE/TURBULENT)
 * @param {Array}  params.bars           - 1-min RTH bars, sorted ascending by et_min, each {et_min, open, high, low, close}
 * @param {number} params.sessOpen       - session open price (first bar's open)
 * @param {number} params.avgRange20     - trailing-20-session avg session range
 * @param {number} params.ibHigh         - Initial Balance high (9:30-10:30)
 * @param {number} params.ibLow          - Initial Balance low (9:30-10:30)
 * @param {number[]} params.checkpoints  - et_min values to evaluate at (ascending, all > IB_END)
 * @returns {{ finalRead: string, events: Array, readAtCheckpoint: Record<number,string> }}
 */
export function runReassessment({ initialRead, bars, sessOpen, avgRange20, ibHigh, ibLow, checkpoints }) {
  let currentRead = initialRead;
  let refHigh = ibHigh;
  let refLow = ibLow;
  let refAnchorT = IB_END; // anchor for the pre/post vol-jump split

  const events = [];
  const readAtCheckpoint = {};

  for (const T of checkpoints) {
    const upTo = bars.filter(b => b.et_min <= T);
    if (upTo.length < 5 || !avgRange20) { readAtCheckpoint[T] = currentRead; continue; }

    const currentHigh = Math.max(...upTo.map(b => b.high));
    const currentLow = Math.min(...upTo.map(b => b.low));
    const currentClose = upTo[upTo.length - 1].close;
    const partialRange = currentHigh - currentLow;
    if (partialRange <= 0) { readAtCheckpoint[T] = currentRead; continue; }

    // PRIMARY TRIGGER: fresh range expansion since the last reference point
    const freshExpansion = Math.max(0, currentHigh - refHigh) + Math.max(0, refLow - currentLow);
    const expansionPct = freshExpansion / avgRange20;
    const rangeTrigger = expansionPct >= 0.30;

    if (rangeTrigger) {
      // CONFIRMING: volatility jump (post-anchor vs pre-anchor 5-min log-return stdev)
      const preBars = bars.filter(b => b.et_min <= refAnchorT);
      const postBars = bars.filter(b => b.et_min > refAnchorT && b.et_min <= T);
      const preVol = stdevLogReturns(fiveMinCloses(preBars));
      const postVol = stdevLogReturns(fiveMinCloses(postBars));
      const volJump = (preVol != null && postVol != null && preVol > 0) ? (postVol / preVol >= 1.5) : false;
      const volRatio = (preVol != null && postVol != null && preVol > 0) ? (postVol / preVol) : null;

      // Recompute ground-truth-style label from data available so far
      const range_ratio = partialRange / avgRange20;
      const close_pct = (currentClose - currentLow) / partialRange;
      const trend_str = Math.abs(currentClose - sessOpen) / partialRange;
      const close_outside_ib = currentClose > ibHigh || currentClose < ibLow;
      const newLabel = classifyGroundTruth({ range_ratio, close_pct, trend_str, close_outside_ib });

      // Anti-flip-flop: only act if the label actually changes, and never
      // reassess BACK to BALANCE once we've moved away from it.
      const wouldRevertToBalance = newLabel === 'BALANCE' && currentRead !== 'BALANCE';
      if (newLabel !== currentRead && !wouldRevertToBalance) {
        events.push({
          time: T,
          timeLabel: fmtT(T),
          from: currentRead,
          to: newLabel,
          expansionPct: Math.round(expansionPct * 1000) / 10, // e.g. 40.0 (%)
          volJump,
          volRatio: volRatio != null ? Math.round(volRatio * 100) / 100 : null,
          range_ratio: Math.round(range_ratio * 1000) / 1000,
          close_pct: Math.round(close_pct * 1000) / 1000,
          trend_str: Math.round(trend_str * 1000) / 1000,
          close_outside_ib,
          message: buildMessage({ T, from: currentRead, to: newLabel, expansionPct, volJump, close_pct, trend_str }),
        });
        currentRead = newLabel;
        // Reset reference: next change needs a FRESH expansion from here
        refHigh = currentHigh;
        refLow = currentLow;
        refAnchorT = T;
      }
    }

    readAtCheckpoint[T] = currentRead;
  }

  return { finalRead: currentRead, events, readAtCheckpoint };
}

function buildMessage({ T, from, to, expansionPct, volJump, close_pct, trend_str }) {
  const pct = (expansionPct * 100).toFixed(0);
  let directional = '';
  if (to === 'TREND') {
    const side = close_pct >= 0.80 ? 'highs' : 'lows';
    directional = `, price holding near session ${side} (trend strength ${(trend_str*100).toFixed(0)}%)`;
  } else if (to === 'TURBULENT') {
    directional = ', range expanding without a clear directional resolution';
  }
  const volNote = volJump ? ' — confirmed by a volatility jump (vol regime shift)' : '';
  return `Reassessed ${fmtT(T)} — ${from} -> ${to}: range expanded ${pct}% beyond the prior reference range${directional}${volNote}.`;
}

/**
 * LIVE wrapper: produces a provisional/live-labeled result for display.
 * Does not mutate any state — callers (e.g. an API route) should persist
 * `events`/`finalRead` themselves if/when this is wired live.
 */
export function describeLiveReassessment(result, asOfMinutes) {
  const isProvisional = asOfMinutes < 945; // before 15:45 ET, day can still change
  return {
    read: result.finalRead,
    provisional: isProvisional,
    label: isProvisional
      ? `${result.finalRead} (LIVE — provisional, can still change)`
      : `${result.finalRead} (final)`,
    reassessments: result.events.map(e => ({
      time: e.timeLabel,
      from: e.from,
      to: e.to,
      message: e.message,
    })),
  };
}
