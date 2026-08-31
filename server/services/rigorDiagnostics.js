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
  if (!events.length) return { distinctDates: 0, top5DayPct: null, stable: null, thirds: null, boundaryStraddle: null, clustered: false, clean: null, zScores: null, zTrend: null };

  const perDay = new Map();
  for (const e of events) {
    const d = e[dateField];
    perDay.set(d, (perDay.get(d) || 0) + 1);
  }
  const counts = [...perDay.values()].sort((a, b) => b - a);
  const top5DayPct = +(100 * counts.slice(0, 5).reduce((a, b) => a + b, 0) / events.length).toFixed(1);
  const clustered = top5DayPct > 50;

  const third = Math.floor(events.length / 3);
  let stable = null, thirds = null, boundaryStraddle = null, zScores = null, zTrend = null;
  if (third >= 5) {
    const g1 = events.slice(0, third), g2 = events.slice(third, 2 * third), g3 = events.slice(2 * third);
    const evOf = g => g.reduce((s, e) => s + pnlFn(e), 0) / g.length;
    const ev1 = evOf(g1), ev2 = evOf(g2), ev3 = evOf(g3);
    const overallSign = Math.sign(events.reduce((s, e) => s + pnlFn(e), 0));
    stable = [ev1, ev2, ev3].every(v => Math.sign(v) === overallSign);
    thirds = { ev1: +ev1.toFixed(2), ev2: +ev2.toFixed(2), ev3: +ev3.toFixed(2) };

    // 2026-08-04 (OPEN_DECISION add_z_score_trend_to_rigor_stability_gate): `stable`
    // collapses each third to a boolean same-sign check, so two setup_types that both pass
    // it identically can still have very different underlying trajectories -- one genuinely
    // strengthening (GLOBEX_VWAP_MAGNET_LONG's real per-third z-score went 1.49->2.84->3.02),
    // the other eroding toward noise (its RTH sibling went 2.46->1.78->0.94) -- both "stable",
    // neither distinguishable from the boolean alone. z-score here is each third's mean
    // divided by its own standard error (mean / (stdDev / sqrt(n))) -- a standard one-sample
    // z/t-stat, capturing both magnitude AND sample confidence, not just EV's raw point value.
    // Informational only, matching this module's own convention -- never feeds `clean`.
    const zOf = g => {
      const vals = g.map(pnlFn);
      const n = vals.length;
      const mean = vals.reduce((a, b) => a + b, 0) / n;
      if (n < 2) return null;
      const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
      const sd = Math.sqrt(variance);
      if (!sd) return null; // zero variance -- z undefined, not zero
      return mean / (sd / Math.sqrt(n));
    };
    const z1 = zOf(g1), z2 = zOf(g2), z3 = zOf(g3);
    zScores = {
      z1: z1 != null ? +z1.toFixed(2) : null,
      z2: z2 != null ? +z2.toFixed(2) : null,
      z3: z3 != null ? +z3.toFixed(2) : null,
    };
    if (z1 != null && z2 != null && z3 != null) {
      zTrend = z3 > z2 && z2 > z1 ? 'STRENGTHENING' : z3 < z2 && z2 < z1 ? 'DECAYING' : 'MIXED';
    }

    // 2026-08-17 (OPEN_DECISION computerigor_stable_clustered_independence_gap): the
    // clustered check (top5DayPct, by DAY) and stable check (sign consistency, by EVENT
    // POSITION) operate at different granularities and aren't independent -- a single
    // dominant dateField entity holding ~33-50% of events is chronologically contiguous
    // enough to straddle a third-boundary, propping up two adjacent thirds' sign at once
    // while staying under the 50% clustering bar (clustered=false). Informational only --
    // does NOT feed `clean` in this pass (see below). Finds the dominant (by count)
    // dateField entity and checks whether its event indices span more than one third.
    // One-entity check: can miss a co-dominant pair where neither is individually dominant
    // but each straddles a different boundary -- acceptable for an informational flag,
    // revisit if this is ever wired into `clean`.
    const idxByDate = new Map();
    events.forEach((e, i) => {
      const d = e[dateField];
      if (!idxByDate.has(d)) idxByDate.set(d, []);
      idxByDate.get(d).push(i);
    });
    let dominantIdxs = null, dominantCount = 0;
    for (const idxs of idxByDate.values()) {
      if (idxs.length > dominantCount) { dominantIdxs = idxs; dominantCount = idxs.length; }
    }
    const bucketsTouched = new Set(dominantIdxs.map(i => (i < third ? 0 : i < 2 * third ? 1 : 2)));
    boundaryStraddle = bucketsTouched.size > 1;
  }

  return {
    distinctDates: perDay.size,
    top5DayPct,
    clustered,
    stable,
    thirds,
    boundaryStraddle,
    zScores,
    zTrend,
    clean: stable === true && !clustered, // the single "trust this" bit — both checks must pass
    // deliberately NOT: clean = stable === true && !clustered && !boundaryStraddle. Not yet
    // wired -- see the OPEN_DECISION above. Tightening `clean` here would ripple into every
    // current consumer (including the SETUP_STATUS_DOW gate fixed 2026-08-17) and needs its
    // own dedicated audit before gating anything. zTrend is even further out from `clean` --
    // purely descriptive (emerging vs. decaying), never a gate input.
  };
}

// Convenience for building the JSONB `context`/`notes` payload consistently across callers.
export function rigorContext(rigor) {
  return {
    distinct_dates: rigor.distinctDates,
    top5_day_pct: rigor.top5DayPct,
    three_way_stable: rigor.stable,
    thirds: rigor.thirds,
    boundary_straddle: rigor.boundaryStraddle,
    z_scores: rigor.zScores,
    z_trend: rigor.zTrend,
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
