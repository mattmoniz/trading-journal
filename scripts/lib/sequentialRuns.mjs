// Sequential defended runs on four-hour bars (user definition, 2026-10-26: "4 or more sequential 4 hour bars that are pretty obviously being defended").
// FLOOR run: consecutive four-hour bars whose LOWS all sit within `band` of each other (they terminate at the same price) and whose closes all stay above the run's lowest low;
// the bar before the run came from above (its low is more than `band` above the run low). TOP is the mirror. An event fires at the close of the bar where the run first reaches `minLen`.
// A PRIOR REFERENCE is required (price traded in the zone before; excludes a run at an all-time extreme). band = bandMult x H4 (mean four-hour range of the 20 prior trade days), never a fixed point value. Pure function of the bars, causal (uses only bars up to the firing bar).
export function sequentialRuns(bars, h4, { bandMult = 0.25, minLen = 4, maxLookback = 40, refLookback = 780, requireReference = true } = {}) {
  const out = [];
  for (const side of ['floor', 'top']) {
    const sg = side === 'floor' ? 1 : -1, lo = (b) => (sg > 0 ? b.L : -b.H), cl = (b) => (sg > 0 ? b.C : -b.C); // mirror tops onto floors
    const len = new Array(bars.length).fill(0), start = new Array(bars.length).fill(-1);
    for (let t = 0; t < bars.length; t++) {
      const H4 = h4[bars[t].td]; if (!H4) continue; const band = bandMult * H4; let best = 0, bs = -1, mnBest = 0;
      let mn = Infinity, mx = -Infinity;
      for (let s = t; s >= Math.max(0, t - maxLookback); s--) {
        const l = lo(bars[s]); mn = Math.min(mn, l); mx = Math.max(mx, l);
        if (mx - mn > band) break; // lows spread too wide; starting earlier only widens it
        let ok = true; for (let k = s; k <= t; k++) if (!(cl(bars[k]) > mn)) { ok = false; break; }
        if (ok) { best = t - s + 1; bs = s; mnBest = mn; } // a failing start is NOT final: an earlier, lower low can make every close clear the run low (fixed 2026-10-26 after the DeepSeek review)
      }
      // "came from above" is REQUIRED: the bar before the run must sit more than one band above the run low; otherwise the run is not a clean floor (or is longer than the lookback) and is rejected
      if (best > 0 && !(bs > 0 && lo(bars[bs - 1]) > mnBest + band)) { best = 0; bs = -1; }
      // PRIOR REFERENCE (user, 2026-10-26, on tops at all-time highs: "defended would have a previous instance where that level was defended"): price must have traded in the zone before the run,
      // i.e. some four-hour bar at least two bars before the run's start (so not the approach bar) whose high-low range overlaps [run low - band, run low + band], within `refLookback` bars.
      if (best > 0 && requireReference) { const Lz = mnBest, band2 = band; let ref = false; for (let k = bs - 2; k >= Math.max(0, bs - refLookback); k--) { const bl = lo(bars[k]), bh = sg > 0 ? bars[k].H : -bars[k].L; if (bl <= Lz + band2 && bh >= Lz - band2) { ref = true; break; } } if (!ref) { best = 0; bs = -1; } }
      len[t] = best; start[t] = bs;
    }
    for (let t = 1; t < bars.length; t++) {
      if (len[t] >= minLen && len[t - 1] < minLen) {
        const s = start[t], run = bars.slice(s, t + 1), H4 = h4[bars[t].td]; const lvl = sg * Math.min(...run.map(lo));
        out.push({ side, dir: sg, t, s, len: len[t], level: sg > 0 ? Math.min(...run.map((b) => b.L)) : Math.max(...run.map((b) => b.H)), band: bandMult * H4, H4, td: bars[t].td, runBars: run });
      }
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
