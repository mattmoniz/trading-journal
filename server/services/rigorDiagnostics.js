// Shared rigor diagnostic: day-clustering + 3-way chronological sign-stability.
//
// Written independently three times on 2026-07-14 (backtest_setup_status.mjs,
// mine_minutebar_conditions.mjs, patternScannerService.js's mineLevelFades()) before being
// centralized here — the exact kind of inconsistency this module exists to prevent. Any new
// pattern-mining or setup-calibration script should import this rather than reimplementing it.
//
// What it catches (both found in real discoveries this session, not hypothetical):
//   - Day-clustering: N inflated by a handful of sessions (the CAM_R4/CAM_S3 bug — a "sample"
//     that's really 5-10 sessions sliced many times, not independent instances).
//   - Sign instability: EV/hit-rate flips across chronological thirds of its own history — can
//     mean genuinely degrading OR genuinely improving, this only flags that the average may not
//     be a persistent number, it does not diagnose which direction.
//
// Deliberately informational only — callers should NEVER let this feed an ACTIVE/SUPPRESS or
// promote/demote decision automatically. Surface it (a color dot, a status tag, a notes field),
// let a human or a separate classification step (like backtest_setup_status.mjs's
// classifyTrend()) decide what a flip actually means.
//
// events: array of arbitrary objects, each representing one instance (a trade, a touch, a
// day-level observation — whatever the caller's unit of analysis is).
// options.dateField: property name holding a per-event date string, for the clustering check.
// options.pnlFn: (event) => number. Sign of this value is what the stability check tracks —
// pass real dollar/point PnL where there is one; for a pure hit-rate claim with no $ concept
// (e.g. TOD_PATTERN's "closes up X% of days"), pass a +1/-1 hit/miss proxy instead.
export function computeRigor(events, { dateField = 'date', pnlFn } = {}) {
  if (!events.length) return { distinctDates: 0, top5DayPct: null, stable: null, thirds: null, clustered: false, clean: null };

  const perDay = new Map();
  for (const e of events) {
    const d = e[dateField];
    perDay.set(d, (perDay.get(d) || 0) + 1);
  }
  const counts = [...perDay.values()].sort((a, b) => b - a);
  const top5DayPct = +(100 * counts.slice(0, 5).reduce((a, b) => a + b, 0) / events.length).toFixed(1);
  const clustered = top5DayPct > 50;

  const third = Math.floor(events.length / 3);
  let stable = null, thirds = null;
  if (third >= 5) {
    const g1 = events.slice(0, third), g2 = events.slice(third, 2 * third), g3 = events.slice(2 * third);
    const evOf = g => g.reduce((s, e) => s + pnlFn(e), 0) / g.length;
    const ev1 = evOf(g1), ev2 = evOf(g2), ev3 = evOf(g3);
    const overallSign = Math.sign(events.reduce((s, e) => s + pnlFn(e), 0));
    stable = [ev1, ev2, ev3].every(v => Math.sign(v) === overallSign);
    thirds = { ev1: +ev1.toFixed(2), ev2: +ev2.toFixed(2), ev3: +ev3.toFixed(2) };
  }

  return {
    distinctDates: perDay.size,
    top5DayPct,
    clustered,
    stable,
    thirds,
    clean: stable === true && !clustered, // the single "trust this" bit — both checks must pass
  };
}

// Convenience for building the JSONB `context`/`notes` payload consistently across callers.
export function rigorContext(rigor) {
  return {
    distinct_dates: rigor.distinctDates,
    top5_day_pct: rigor.top5DayPct,
    three_way_stable: rigor.stable,
    thirds: rigor.thirds,
    clean: rigor.clean,
  };
}
