// Pre-registered in docs/ONH_HOLD_PLUS_DEFENDED_ZONE_PREREG_20261026.md (+ Amendment 1 if present) -- committed before any outcome was computed.
// Day level, causal at 15:55 ET: ONH-HELD (broke above the overnight high by 12:00 on a 5-minute close, never closed below ONH - 0.02 D20 after, closes above it), ZONE-DEFENDED (the RTH low is within a band of at least N prior approach days in the previous 90 trade days that then held),
// CONJUNCTION = both. Outcome: long from the 15:56 open to the next trade date's 15:55 close in D20 units, EXCESS over the same-weekday mean of all valid days.
import fs from 'fs';
import { query } from '../server/db.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { loadBars, prep, indexBars, clock, mean, SPARSE } from './lib/floorEngine.mjs';
import { d20Of } from './lib/fourHourLevels.mjs';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { f3 } from './lib/floorStats.mjs';

const CONFIGS = process.env.CONFIG ? [JSON.parse(process.env.CONFIG)] : [{ n: 3, band: 0.15 }, { n: 2, band: 0.15 }, { n: 2, band: 0.25 }];
async function main() {
  const endRow = (await query(`SELECT (MAX(ts)::date - 3)::text d FROM price_bars_primary WHERE symbol='NQ' AND ts >= CURRENT_DATE - 7 AND ts < CURRENT_DATE + 1`)).rows[0].d;
  const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2023-03-06', await (async () => (await query(`SELECT CURRENT_DATE::text d`)).rows[0].d)()))), d20 = d20Of(NQ);
  const day = new Map(); // trade date -> {rs, re (RTH first/last idx), lo, hi (full session), first, last}
  for (let i = 0; i < NQ.n; i++) { const td = NQ.TD[i], c = clock(NQ.T[i]), o = day.get(td) || day.set(td, { rs: -1, re: -1, lo: Infinity, hi: -Infinity, first: i, last: i }).get(td); o.last = i; o.lo = Math.min(o.lo, NQ.L[i]); o.hi = Math.max(o.hi, NQ.H[i]); if (NQ.T[i].slice(0, 10) === td && c >= 570 && c < 960) { if (o.rs < 0) o.rs = i; o.re = i; } }
  const dates = [...day.keys()].sort().filter((d) => day.get(d).rs >= 0 && day.get(d).re - day.get(d).rs >= 300), pos = new Map(dates.map((d, k) => [d, k]));
  const rows = [];
  for (let k = 20; k < dates.length - 1 + 1; k++) {
    const td = dates[k], D = day.get(td), sc = d20[td]; if (!sc || isInsideNqRollWeek(td) || SPARSE(td)) continue;
    let onh = -Infinity; for (let i = D.first; i < D.rs; i++) onh = Math.max(onh, NQ.H[i]); if (!Number.isFinite(onh)) continue;
    // RTH 5-minute closes up to the bar ending 15:55
    const five = []; for (let i = D.rs; i <= D.re; i++) { const c = clock(NQ.T[i]), j = Math.floor((c - 570) / 5); if (c >= 955) break; (five[j] ||= { start: 570 + 5 * j }).close = NQ.C[i]; }
    let tb = -1; for (let j = 1; j < five.length; j++) if (five[j] && five[j].start >= 575 && five[j].close > onh) { tb = j; break; }
    const band = 0.02 * sc; let held = tb >= 0 && five[tb].start <= 720; if (held) for (let j = tb + 1; j < five.length; j++) if (five[j] && five[j].close < onh - band && (!process.env.RECLAIM || five[j].start > 720)) { held = false; break; } if (held && !(five[five.length - 1].close > onh)) held = false; // RECLAIM=1: a retest below the ONH is allowed until 12:00 (post-hoc sensitivity, descriptive only)
    let rthLow = Infinity; for (let i = D.rs; i <= D.re; i++) rthLow = Math.min(rthLow, NQ.L[i]);
    let e0 = -1; for (let i = D.re; i >= D.rs && i > D.re - 12; i--) if (clock(NQ.T[i]) === 956) e0 = i; if (e0 < 0) { for (let i = D.re; i >= D.rs; i--) { if (clock(NQ.T[i]) >= 956) e0 = i; else break; } }
    // forward exit: next trade date's 15:55 bar
    const nd = dates[k + 1], N = nd ? day.get(nd) : null; let x1 = -1; if (N && (new Date(nd) - new Date(td)) / 86400000 <= 5) for (let i = N.re; i >= N.rs; i--) if (clock(NQ.T[i]) === 955) { x1 = i; break; }
    // approach counts per config
    const cnt = {}; for (const cf of CONFIGS) { let c = 0, lastPos = -99; for (let q = Math.max(0, k - 90); q <= k - 4; q++) { const p = dates[q], P = day.get(p); if (Math.abs(P.lo - rthLow) > cf.band * sc) continue; let hi = -Infinity; for (let m = 1; m <= 3 && q + m < dates.length; m++) hi = Math.max(hi, day.get(dates[q + m]).hi); if (hi - P.lo < 0.5 * d20[p] || !d20[p]) continue; if (q - lastPos >= 2) { c++; lastPos = q; } } cnt[`${cf.n}|${cf.band}`] = c; }
    rows.push({ td, k, held, rthLow, cnt, e0, x1, sc, entry: e0 >= 0 ? NQ.O[e0] : null, r: e0 >= 0 && x1 >= 0 ? (NQ.C[x1] - NQ.O[e0]) / sc : null, mfe: e0 >= 0 && x1 >= 0 ? (Math.max(...NQ.H.slice(N.first > e0 ? e0 : e0, x1 + 1)) - NQ.O[e0]) / sc : null, wd: new Date(td + 'T12:00:00Z').getUTCDay() });
  }
  const valid = rows.filter((r) => r.r != null && r.td <= endRow); console.log(`trade days with RTH ${dates.length}; analysable days ${valid.length} (${valid[0]?.td}..${valid[valid.length - 1]?.td}); ONH-HELD days ${valid.filter((r) => r.held).length}`);
  for (const cf of CONFIGS) { const key = `${cf.n}|${cf.band}`; console.log(`  config approaches>=${cf.n} band ${cf.band} D20: ZONE-DEFENDED days ${valid.filter((r) => r.cnt[key] >= cf.n).length}, CONJUNCTION days ${valid.filter((r) => r.held && r.cnt[key] >= cf.n).length}`); }
  let cfg = CONFIGS[CONFIGS.length - 1]; for (const cf of CONFIGS) if (valid.filter((r) => r.held && r.cnt[`${cf.n}|${cf.band}`] >= cf.n).length >= 30) { cfg = cf; break; }
  const key = `${cfg.n}|${cfg.band}`; console.log(`SELECTED (from counts only, before any outcome): approaches>=${cfg.n}, band ${cfg.band} x D20`);
  if (process.env.COUNT_ONLY) return;
  // shape features at 15:55 (Amendment 1): return from the RTH open to 15:55 and the 15:55 close's place in the day's RTH range, terciles from all valid days
  for (const r of valid) { const D = day.get(r.td); let lo = Infinity, hi = -Infinity, last = null; for (let i = D.rs; i <= D.re; i++) { if (clock(NQ.T[i]) >= 955) break; lo = Math.min(lo, NQ.L[i]); hi = Math.max(hi, NQ.H[i]); last = NQ.C[i]; } r.ret = (last - NQ.O[D.rs]) / r.sc; r.loc = hi > lo ? (last - lo) / (hi - lo) : 0.5; r.fri = r.wd === 5 ? 1 : 0; const d0 = new Date(r.td + 'T12:00:00Z'); d0.setUTCDate(d0.getUTCDate() - ((d0.getUTCDay() + 6) % 7)); r.wk = d0.toISOString().slice(0, 10); }
  const tcut = (arr) => { const q = [...arr].sort((x, y) => x - y); return [q[Math.floor(q.length / 3)], q[Math.floor(2 * q.length / 3)]]; }, rc = tcut(valid.map((r) => r.ret)), lc = tcut(valid.map((r) => r.loc)), bin = (x, c) => (x < c[0] ? 0 : x < c[1] ? 1 : 2);
  for (const r of valid) r.cell = `${bin(r.ret, rc)}|${bin(r.loc, lc)}|${r.fri}`;
  const cut = valid[Math.floor(valid.length * 0.6)].td, ev = { ONH: (r) => r.held, ZONE: (r) => r.cnt[key] >= cfg.n, CONJ: (r) => r.held && r.cnt[key] >= cfg.n };
  const spec = { 'ONH-HELD vs shape-matched non-held days': [ev.ONH, (r) => !ev.ONH(r)], 'ZONE-DEFENDED vs shape-matched non-zone days': [ev.ZONE, (r) => !ev.ZONE(r)], 'CONJUNCTION vs ONH-HELD days without the zone': [ev.CONJ, (r) => ev.ONH(r) && !ev.ZONE(r)] };
  const matched = (T, C) => { const t = new Map(); for (const r of T) { const c = t.get(r.cell) || t.set(r.cell, [0, 0, 0, 0]).get(r.cell); c[0]++; c[1] += r.r; } for (const r of C) { const c = t.get(r.cell) || t.set(r.cell, [0, 0, 0, 0]).get(r.cell); c[2]++; c[3] += r.r; } let w = 0, d = 0; for (const c of t.values()) if (c[0] && c[2] >= 5) { w += c[0]; d += c[0] * (c[1] / c[0] - c[3] / c[2]); } return w ? d / w : NaN; };
  const rng = mulberry32(hashSeed('onhzone')), bootM = (T, C, lo) => { const g = new Map(); for (const r of [...T.map((x) => ({ x, t: 1 })), ...C.map((x) => ({ x, t: 0 }))]) (g.get(r.x.wk) || g.set(r.x.wk, []).get(r.x.wk)).push(r); const ws = [...g.values()], o = []; for (let b = 0; b < 3000; b++) { const T2 = [], C2 = []; for (let k = 0; k < ws.length; k++) for (const r of ws[Math.floor(rng() * ws.length)]) (r.t ? T2 : C2).push(r.x); const v = matched(T2, C2); if (Number.isFinite(v)) o.push(v); } o.sort((p, q) => p - q); return [o[Math.floor(lo * o.length)], o[Math.floor((1 - lo) * o.length) - 1]]; };
  console.log(`\nshape-matched control (return-so-far tercile x close-location tercile x Friday); explore <= ${cut}; explore CI 98.33 percent (Bonferroni over 3), hold-out one-sided 95 percent; bootstrap resamples whole weeks (${new Set(valid.map((r) => r.wk)).size} weeks)`);
  let cands = 0, surv = 0;
  for (const [nm, [fe, fc]] of Object.entries(spec)) {
    const T = valid.filter(fe), C = valid.filter(fc), TA = T.filter((r) => r.td <= cut), TH = T.filter((r) => r.td > cut), CA = C.filter((r) => r.td <= cut), CH = C.filter((r) => r.td > cut), under = (z) => z.length < 30 || new Set(z.map((r) => r.wk)).size < 20;
    const d = matched(T, C), ci0 = bootM(T, C, 0.025); console.log(`\n${nm}: events ${T.length} (${new Set(T.map((r) => r.wk)).size} weeks), controls ${C.length}; mean next-day return events ${f3(mean(T.map((r) => r.r)))} vs controls ${f3(mean(C.map((r) => r.r)))} D20; matched excess ${f3(d)} [${f3(ci0[0])},${f3(ci0[1])}] (95%, all dates); mean max favourable move ${f3(mean(T.map((r) => r.mfe)))}; share up ${(100 * T.filter((r) => r.r > 0).length / Math.max(1, T.length)).toFixed(0)}%`);
    let v = 'UNDERPOWERED', ea = `n=${TA.length}`, ha = `n=${TH.length}`;
    if (!under(TA)) { const da = matched(TA, CA), c = bootM(TA, CA, 0.0083); ea = `${f3(da)} [${f3(c[0])},${f3(c[1])}] n=${TA.length}`; if (!(c[0] > 0)) v = 'no'; else { cands++; if (under(TH)) v = 'CANDIDATE, hold-out UNDERPOWERED'; else { const dh = matched(TH, CH), ch = bootM(TH, CH, 0.05); ha = `${f3(dh)} [${f3(ch[0])},${f3(ch[1])}] n=${TH.length}`; const ok = dh > 0 && ch[0] > 0 && da > 0; v = ok ? 'SCREEN-SURVIVOR' : 'candidate, not a survivor'; if (ok) surv++; } } }
    else if (TH.length) ha = `n=${TH.length}, matched ${f3(matched(TH, CH))}`;
    console.log(`  explore ${ea}\n  hold-out ${ha}\n  => ${v}${under(TA) ? ' (explore half has fewer than 30 events or 20 weeks)' : ''}`);
  }
  console.log(`CELLS 3, CANDIDATES ${cands}, SCREEN-SURVIVORS ${surv}, expected by chance about ${(3 * 0.0083).toFixed(2)}`);
  const pend = rows.filter((r) => r.r == null && r.entry != null && r.k >= dates.length - 3); for (const r of pend) console.log(`  forward / pending day ${r.td}: ONH-HELD ${r.held}, approaches counted ${r.cnt[key]} (zone-defended ${r.cnt[key] >= cfg.n}), entry ${r.entry}, low ${r.rthLow}`);
  fs.writeFileSync('scratch/onh_hold_zone_20261026.json', JSON.stringify({ cfg, cands, surv, n: valid.length }));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
