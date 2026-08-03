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
// options.filterFn: optional (event) => boolean. If provided, only events passing the filter
// are evaluated (e.g. for regime-conditioned chronological stability).
export function computeRigor(rawEvents, { dateField = 'date', pnlFn, filterFn } = {}) {
  const events = filterFn ? rawEvents.filter(filterFn) : rawEvents;
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

// Held-out replication check for "top-K selected from a sweep, then rigor-checked"
// findings -- a DIFFERENT failure mode from computeRigor()'s day-clustering/chronological
// checks, which only look INSIDE the selected bucket and cannot see that the bucket
// itself was cherry-picked from a wider surface. computeRigor() checking a selected
// bucket's own internal stability says nothing about whether picking the biggest mover
// out of 48 candidates was itself the whole "effect."
//
// Origin: Opus Audit #4 (2026-07-21, docs/OPUS_AUDIT_PROMPT_4.md /
// scratch/opus_audit_4_results.md), built after the exact failure it's meant to catch
// happened for real the same day -- `volume_confirmed_candle_pattern_low_vol_trap`
// selected the 6 largest-effect-size setup_types out of 48, found a clean +$25/trade
// signal, and it reversed under held-out replication (-$10.26 on the remaining 42).
// That manual check (scratch/fair_test_volconf.mjs) is the pattern this generalizes --
// this is the second time that exact check was hand-written (also done ad hoc for
// regime_c_persistence_debunked_placebo_test and globex_large_moves_start_near_pit_safe_levels)
// before being centralized here, same "written 3x, then shared" precedent as computeRigor()
// itself.
//
// units: the FULL population a selection was drawn from (e.g. all 64 setup_types), one
// entry per unit. Each unit needs a stable identifying key.
// options.idFn: (unit) => id. Must match the ids in `selectedIds`.
// options.metricFn: (unit) => { n, value } | null. `value`'s SIGN is what's being tested
// for replication (an EV delta, a WR difference -- whatever the original finding's
// headline number was); `n` is that unit's sample size for pooling weight. Return null
// for a unit that can't be scored (e.g. N too thin) -- it's excluded from both pools.
// selectedIds: the ids that were selected for the original finding (e.g. the top-K by
// effect size) -- NOT recomputed here, pass in exactly what was actually used.
//
// Returns pooled (N-weighted) selected vs. held-out stats, the held-out favorable
// fraction (what share of the NON-selected units still point the claimed direction),
// and a single `replicates` boolean (same sign pooled AND held-out favorable
// fraction >= 50%) -- deliberately a stricter bar than computeRigor()'s `clean`, since
// this is checking for a coincidence of selection, not measurement noise.
export function computeReplication(units, { idFn, metricFn, selectedIds }) {
  const selectedSet = new Set(selectedIds);
  const scored = units.map(u => ({ id: idFn(u), metric: metricFn(u) })).filter(x => x.metric && Number.isFinite(x.metric.value) && x.metric.n > 0);
  const selected = scored.filter(x => selectedSet.has(x.id));
  const heldOut = scored.filter(x => !selectedSet.has(x.id));

  function pool(list) {
    const totalN = list.reduce((s, x) => s + x.metric.n, 0);
    if (totalN === 0) return { n: 0, value: null };
    const weighted = list.reduce((s, x) => s + x.metric.n * x.metric.value, 0) / totalN;
    return { n: totalN, value: +weighted.toFixed(2) };
  }

  const selectedPooled = pool(selected);
  const heldOutPooled = pool(heldOut);
  const heldOutFavorable = heldOut.filter(x => x.metric.value > 0).length;
  const heldOutFavorableFrac = heldOut.length ? +(heldOutFavorable / heldOut.length).toFixed(2) : null;

  const sameSign = selectedPooled.value != null && heldOutPooled.value != null
    && Math.sign(selectedPooled.value) === Math.sign(heldOutPooled.value) && selectedPooled.value !== 0;

  return {
    selectedPooled,
    heldOutPooled,
    heldOutN: heldOut.length,
    heldOutFavorableCount: heldOutFavorable,
    heldOutFavorableFrac,
    replicates: sameSign && heldOutFavorableFrac !== null && heldOutFavorableFrac >= 0.5,
  };
}
