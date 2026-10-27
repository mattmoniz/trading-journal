// Defended-level finder, v1 (docs/DEFENDED_LEVEL_FINDER_SPEC_20261026.md). NO outcomes are computed or printed here: the output is events plus chart data for the user's review.
// Levels = the Sierra-style period lines from real tick volume (all sessions): current 3-month block (calendar quarter to the prior close), previous block, prior month, prior week, prior day
// (VAH/VAL/POC) plus period high/low. Causal: each line uses data through the prior trade date. A level is a PRICE (its value on the evaluation date); defenses are counted on four-hour bars
// over the last 90 trade days since the level last broke. Hold = first bar after the last defense that closes at least 0.5 x H4 away on the defended side (within 6 bars). Floors and tops.
import fs from 'fs';
import { query } from '../server/db.js';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { loadBars, prep, indexBars, clock, mean } from './lib/floorEngine.mjs';
import { build4h } from './lib/fourHourLevels.mjs';
import { loadTick, add } from './lib/tickLevelFamilies.mjs';
const BAND_MULT = Number(process.env.BAND_MULT || 0.25), HOLD_MULT = 0.5, LOOKBACK_BARS = Number(process.env.LOOKBACK_BARS || 780), MIN_K = 3, MIN_A = 2, SEP = 6, MAX_AFTER = 6;
const quarterStart = (d) => { const y = +d.slice(0, 4), m = +d.slice(5, 7); const q = Math.floor((m - 1) / 3) * 3 + 1; return `${y}-${String(q).padStart(2, '0')}-01`; };
const prevQuarter = (qs) => { const y = +qs.slice(0, 4), m = +qs.slice(5, 7); return m === 1 ? [`${y - 1}-10-01`, `${y - 1}-12-31`] : [`${y}-${String(m - 3).padStart(2, '0')}-01`, add(qs, -1)]; };
async function main() {
  const endRow = (await query(`SELECT (MAX(ts)::date - 3)::text d FROM price_bars_primary WHERE symbol='NQ' AND ts >= CURRENT_DATE - 7 AND ts < CURRENT_DATE + 1`)).rows[0].d;
  const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2023-03-06', endRow))), { bars, h4 } = build4h(NQ);
  const T = await loadTick({ session: 'all' }), { profile, prior } = T;
  const memo = new Map();
  const linesFor = (D) => {
    if (memo.has(D)) return memo.get(D);
    const out = [], put = (nm, p, key, kind) => { if (p) out.push({ name: nm, price: p[key], kind }); }, qs = quarterStart(D), [ps, pe] = prevQuarter(qs);
    const g = (nm, p) => { if (!p) return; put(nm + '_VAH', p, 'vah', 'VA'); put(nm + '_VAL', p, 'val', 'VA'); put(nm + '_POC', p, 'poc', 'POC'); };
    const pd = prior(D); g('PD', pd && profile(pd, pd)); g('PW', T.families.PW(D)); g('PM', T.families.PM(D));
    g('3M', D > qs ? profile(qs, add(D, -1)) : null); g('P3M', profile(ps, pe));
    const pw = T.families.PW(D), pm = T.families.PM(D); if (pw) { put('PW_HI', pw, 'high', 'HL'); put('PW_LO', pw, 'low', 'HL'); } if (pm) { put('PM_HI', pm, 'high', 'HL'); put('PM_LO', pm, 'low', 'HL'); }
    memo.set(D, out); return out;
  };
  const events = [], cover = { bars: 0, withLines: 0 };
  for (let t = 60; t < bars.length; t++) {
    const b = bars[t], H4 = h4[b.td]; if (!H4) continue; cover.bars++;
    const lines = linesFor(b.td); if (!lines.length) continue; cover.withLines++;
    const band = BAND_MULT * H4, lo0 = Math.max(0, t - LOOKBACK_BARS);
    for (const side of ['floor', 'top']) {
      const dir = side === 'floor' ? 1 : -1, found = [];
      for (const ln of lines) {
        const L = ln.price; // defense/break logic on the defended side
        let lastBreak = lo0 - 1; const def = [];
        for (let k = lo0; k < t; k++) { const x = bars[k]; const brk = side === 'floor' ? x.C <= L - band : x.C >= L + band; if (brk) { lastBreak = k; def.length = 0; continue; }
          const touch = side === 'floor' ? x.L >= L - band && x.L <= L + band && x.C > L - band : x.H >= L - band && x.H <= L + band && x.C < L + band; if (touch) def.push(k); }
        if (!def.length) continue; const j = def[def.length - 1]; if (t - j > MAX_AFTER) continue;
        let A = 1; for (let q = 1; q < def.length; q++) if (def[q] - def[q - 1] >= SEP) A++;
        if (!(def.length >= MIN_K || A >= MIN_A)) continue;
        const thr = side === 'floor' ? (c) => c >= L + band + HOLD_MULT * H4 : (c) => c <= L - band - HOLD_MULT * H4;
        if (!thr(b.C)) continue; let first = true; for (let m = j + 1; m < t; m++) if (thr(bars[m].C)) { first = false; break; } if (!first) continue;
        const rv = def.map((k) => bars[k]).filter((x) => x.relBase).map((x) => x.V / x.relBase);
        found.push({ line: ln.name, price: L, K: def.length, A, firstDefense: def[0], lastDefense: j, defBars: def.slice(-12), relVol: rv.length ? mean(rv) : null });
      }
      if (!found.length) continue;
      // merge lines whose prices sit within one band into ONE event (confluence of period lines)
      found.sort((a, c) => a.price - c.price); const groups = []; for (const f of found) { const g = groups[groups.length - 1]; if (g && f.price - g[g.length - 1].price <= band) g.push(f); else groups.push([f]); }
      for (const g of groups) { const ref = g.reduce((a, c) => (c.K > a.K ? c : a), g[0]); events.push({ key: `${side}|${t}|${Math.round(ref.price)}`, side, dir, t, td: b.td, ts: NQ.T[b.i0], H4, band, level: mean(g.map((x) => x.price)), lines: g.map((x) => x.line), K: ref.K, A: ref.A, relVol: ref.relVol, defBars: ref.defBars, firstDefense: ref.firstDefense, lastDefense: ref.lastDefense, i0: b.i1 + 1, ctx: lines.map((x) => [x.name, +x.price.toFixed(2)]) }); }
    }
  }
  console.log(`NQ to ${endRow}; four-hour bars ${bars.length}; bars with a usable H4 ${cover.bars}, of which with at least one tick-based line ${cover.withLines}`);
  console.log(`events at band ${BAND_MULT} x H4: ${events.length} (floors ${events.filter((e) => e.side === 'floor').length}, tops ${events.filter((e) => e.side === 'top').length}); distinct dates ${new Set(events.map((e) => e.td)).size}`);
  const kdist = {}; for (const e of events) { const k = Math.min(e.K, 8) + '+'; kdist[k] = (kdist[k] || 0) + 1; } console.log('K distribution (defense bars since last break):', JSON.stringify(kdist));
  const adist = {}; for (const e of events) { const k = Math.min(e.A, 5) + '+'; adist[k] = (adist[k] || 0) + 1; } console.log('A distribution (separate approaches):', JSON.stringify(adist));
  const conf = {}; for (const e of events) { const k = Math.min(e.lines.length, 4) + ' lines'; conf[k] = (conf[k] || 0) + 1; } console.log('period lines per event:', JSON.stringify(conf));
  const byLine = {}; for (const e of events) for (const l of e.lines) byLine[l] = (byLine[l] || 0) + 1; console.log('events by line:', JSON.stringify(byLine));
  const byYear = {}; for (const e of events) byYear[e.td.slice(0, 7)] = (byYear[e.td.slice(0, 7)] || 0) + 1; console.log('events by month:', JSON.stringify(byYear));
  fs.writeFileSync('scratch/defended_lines_by_date_20261026.json', JSON.stringify(Object.fromEntries([...memo].map(([d, ls]) => [d, ls.map((x) => [x.name, +x.price.toFixed(2)])]))));
  fs.writeFileSync(`scratch/defended_events_band${BAND_MULT}_20261026.json`, JSON.stringify({ endRow, band: BAND_MULT, events }));
  fs.writeFileSync('scratch/defended_bars_20261026.json', JSON.stringify(bars.map((b) => [b.td, NQ.T[b.i0], b.O, b.H, b.L, b.C, b.V, b.relBase ? +(b.V / b.relBase).toFixed(2) : null])));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
