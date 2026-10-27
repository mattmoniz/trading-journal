// Sequential defended runs on four-hour bars (user definition, 2026-10-26: "4 or more sequential 4 hour bars that are pretty obviously being defended").
// FLOOR run: consecutive four-hour bars whose LOWS all sit within `band` of each other (they terminate at the same price) and whose closes all stay above the run's lowest low;
// the bar before the run came from above (its low is more than `band` above the run low). TOP is the mirror. An event fires at the close of the bar where the run first reaches `minLen`.
// band = bandMult x H4 (mean four-hour range of the 20 prior trade days), never a fixed point value. Pure function of the bars, causal (uses only bars up to the firing bar).
export function sequentialRuns(bars, h4, { bandMult = 0.25, minLen = 4, maxLookback = 40 } = {}) {
  const out = [];
  for (const side of ['floor', 'top']) {
    const sg = side === 'floor' ? 1 : -1, lo = (b) => (sg > 0 ? b.L : -b.H), cl = (b) => (sg > 0 ? b.C : -b.C); // mirror tops onto floors
    const len = new Array(bars.length).fill(0), start = new Array(bars.length).fill(-1);
    for (let t = 0; t < bars.length; t++) {
      const H4 = h4[bars[t].td]; if (!H4) continue; const band = bandMult * H4; let best = 0, bs = -1;
      for (let s = t; s >= Math.max(0, t - maxLookback); s--) {
        let mn = Infinity, mx = -Infinity, ok = true;
        for (let k = s; k <= t; k++) { const l = lo(bars[k]); mn = Math.min(mn, l); mx = Math.max(mx, l); }
        if (mx - mn > band) break; // lows spread too wide; starting earlier only widens it
        for (let k = s; k <= t; k++) if (!(cl(bars[k]) > mn)) { ok = false; break; }
        if (!ok) break; if (s > 0 && !(lo(bars[s - 1]) > mn + band)) { /* previous bar is also at the level: the run extends further back, keep scanning */ best = t - s + 1; bs = s; continue; }
        best = t - s + 1; bs = s; // came from above: a clean start
      }
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
