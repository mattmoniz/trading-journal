// Pure, single-bar step function for POC_ROTATION_JOIN's breakeven-hold exit (2026-10-11,
// wired LIVE per explicit user direction -- replaces the original Time60_Stop20 exit, not a
// SHADOW-parallel addition to it). Same "export the real function" convention as
// t1FloorRunnerWalker.js's stepT1FloorRunner() / stepTrailWalker.js's stepStepTrail().
//
// WHAT THIS DOES: instead of a flat 20pt stop / 60-minute mark-to-market, use a WIDER 100pt
// stop; once the trade survives ARM_AT_MINUTES (60) without stopping, snap the stop to
// breakeven and keep holding -- past the old 60-minute cutoff -- until either the breakeven
// stop is hit, or the walk reaches its outer boundary (the caller determines this: the next
// real POC_ROTATION_JOIN event of EITHER direction, or a 24h cap, whichever comes first).
//
// Backing research: RESEARCH_CLAIM poc_rotation_breakeven_hold_100pt_stop_20261008 (16-month
// paired replay, n=1,629 matched pairs/285 distinct days, real exported detectSignalEvents()
// not reimplemented). Paired delta (breakeven-hold vs fixed, both at 100pt stop) mean=+$39.13
// /trade, day-blocked 95% CI=[$16.88,$69.28], excludes zero. Top5-trade share of total delta
// = 40.5% (broad-based, not a handful of outliers -- contrast the rejected 20pt-stop version
// of this same idea, poc_rotation_breakeven_hold_past_60min_20261008, where top5 share was
// 202%, i.e. the rest of the population was net negative).
//
// Honest risk, NOT yet independently addressed as of shipping: this is a single-pass backtest
// result, not independently re-reviewed (DeepSeek) or chronologically train/test split. The
// standing precedent in this codebase (t1FloorRunnerWalker.js, stepTrailWalker.js) is to ship
// mechanisms of this shape SHADOW-only first and promote only once real forward data confirms
// the backtest. This one was wired LIVE instead on explicit user direction after being told
// that risk directly (2026-10-11) -- see docs/OPEN_THREADS.md's entry the same day for the
// full exchange. Real consequence if the backtest doesn't hold up going forward: a real
// position's stop sits 100pt away (5x the old 20pt) for its first 60 minutes, and can be held
// open far longer (up to 24h) than the old design -- genuinely larger risk per trade than the
// mechanism it replaced, not a free refinement.
//
// state: { barsElapsed: number, armed: boolean } -- starts { barsElapsed: 0, armed: false }
// bar: { ts, high, low, close }
// params: { entry, long, stop (100, from STOP_POINTS), armAtBars (60) }
// Returns { state, resolution: null | { resolution, method, priceAtRes } }
export function stepPocBreakevenHold(state, bar, { entry, long, stop, armAtBars }) {
  // Arm BEFORE checking this bar's hit, matching the validated backtest's own ordering
  // (simBEHold: `if(!armed&&k>=armAt){sp=entry;armed=true;}` happens before the hit check on
  // the same iteration) -- so the bar at exactly armAtBars already uses the breakeven stop.
  const armed = state.armed || state.barsElapsed >= armAtBars;
  const sp = armed ? entry : (long ? entry - stop : entry + stop);
  const hit = long ? bar.low <= sp : bar.high >= sp;
  if (hit) {
    // Method strings kept <=20 chars -- resolution_method is VARCHAR(20) (standing hard
    // rule: check every literal against the real column width before shipping, a raw
    // uncaught Postgres error here would crash resolution for every OTHER row in the same
    // poll too, not just this one).
    return {
      state: { ...state, armed },
      resolution: {
        resolution: 'STOP_HIT',
        method: armed ? 'POC_BEHOLD_BE_STOP' : 'POC_BEHOLD_WIDE_STOP',
        priceAtRes: sp,
      },
    };
  }
  return { state: { barsElapsed: state.barsElapsed + 1, armed }, resolution: null };
}
