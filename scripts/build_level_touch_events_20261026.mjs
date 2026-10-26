// Mechanism-decomposition events builder: docs/MECHANISM_DECOMPOSITION_PREREG_20261026.md (+ any amendment). One row per (level, day) first touch, level identity KEPT
// (build_mtf_touch_events_20261026.mjs drops it). Same touch rule, exclusions and window as that builder (Part B). Features use bars up to and including the event bar t; entry is open[t+1].
//   node scripts/build_level_touch_events_20261026.mjs  -> scratch/level_touch_events_20261026.json   (prints STATE COUNTS ONLY, no outcome statistics)
import fs from 'fs';
import { query } from '../server/db.js';
import { loadBars, sessionIndex } from './lib/pocJoinLoader.mjs';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';

export const FROM = '2023-03-06', TO = '2026-10-23', PROX = 15, SPARSE_FROM = '2025-09-28', SPARSE_TO = '2025-11-19', PPT = 2, COMM = 2, K_CTRL = 20, H = 60;
const GATE = { OR5: 575, OR10: 580, OR15: 585, OR30: 600, IB: 630 }; const formGate = (n) => { for (const k of Object.keys(GATE)) if (n.startsWith(k + '_')) return GATE[k]; return 575; };
export const familyOf = (n) => /^(OR\d+|IB)_/.test(n) ? 'SAME_DAY_OR_IB' : /^PD_/.test(n) ? 'PD' : /^PW_|^W[PRS]|^WEEKLY/.test(n) ? 'WEEKLY' : /^PM_|^M[PRS]|^MONTHLY/.test(n) ? 'MONTHLY' : /^CAM_/.test(n) ? 'CAM' : /^FLOOR_/.test(n) ? 'FLOOR' : 'OTHER';
const bucketOf = (m) => (m < 630 ? 'FIRST_HOUR' : m < 870 ? 'MID' : 'LAST_90');
const hash = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const mulberry = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const D = await loadBars(FROM, TO), S = sessionIndex(D);
const opt = new Set((await query(`SELECT DISTINCT signal_name FROM performance_audit WHERE signal_type='OPTIMAL_STOP'`)).rows.map((r) => r.signal_name));
const LV = new Map();
for (const r of (await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE trade_date BETWEEN $1::date AND $2::date AND price IS NOT NULL AND level_name <> 'RTH_VWAP'`, [FROM, TO])).rows) { if (!LV.has(r.d)) LV.set(r.d, []); LV.get(r.d).push({ n: r.n, p: r.p }); }
const mod = (gi) => +D.TS[gi].slice(11, 13) * 60 + +D.TS[gi].slice(14, 16);

function symPnl(gi, endIdx, f, atr) {            // symmetric +/-0.5 ATR20 stop/target from open[t+1], market fills, stop first (informational only)
  const long = f > 0, entry = D.O[gi + 1], stopP = long ? entry - 0.5 * atr : entry + 0.5 * atr, tgtP = long ? entry + 0.5 * atr : entry - 0.5 * atr;
  for (let k = gi + 1; k <= endIdx; k++) {
    if (long ? D.L[k] <= stopP : D.H[k] >= stopP) { const fill = long ? Math.min(stopP, D.O[k]) : Math.max(stopP, D.O[k]); return (long ? fill - entry : entry - fill) * PPT - COMM; }
    if (long ? D.H[k] >= tgtP : D.L[k] <= tgtP) { const fill = long ? Math.max(tgtP, D.O[k]) : Math.min(tgtP, D.O[k]); return (long ? fill - entry : entry - fill) * PPT - COMM; }
  }
  return (long ? D.C[endIdx] - entry : entry - D.C[endIdx]) * PPT - COMM;
}

const excl = { sparse: 0, roll: 0, rollMismatch: 0, noAtrOrLevels: 0 }; const rows = [];
for (let di = 0; di < S.dates.length; di++) {
  const d = S.dates[di]; if (d < FROM || d > TO) continue;
  if (d >= SPARSE_FROM && d <= SPARSE_TO) { excl.sparse++; continue; }
  const prev = S.dates[di - 1]; if (isInsideNqRollWeek(d) || (prev && isInsideNqRollWeek(prev))) { excl.roll++; continue; }
  const atr = S.atr20(d), L = LV.get(d); if (!atr || !L || !prev) { excl.noAtrOrLevels++; continue; }
  const [a, b] = S.rth.get(d), [pa, pb] = S.rth.get(prev), pdc = L.find((x) => x.n === 'PD_CLOSE');
  if (pdc && Math.abs(pdc.p - D.C[pb - 1]) > 0.1 * atr) { excl.rollMismatch++; continue; }
  let pdH = -Infinity, pdL = Infinity; for (let i = pa; i < pb; i++) { pdH = Math.max(pdH, D.H[i]); pdL = Math.min(pdL, D.L[i]); }
  const hiSo = new Float64Array(b - a), loSo = new Float64Array(b - a); let hh = -Infinity, ll = Infinity; for (let i = a; i < b; i++) { hh = Math.max(hh, D.H[i]); ll = Math.min(ll, D.L[i]); hiSo[i - a] = hh; loSo[i - a] = ll; }
  const cand = { FIRST_HOUR: [], MID: [], LAST_90: [] }; for (let gj = a + 5; gj <= b - H - 1; gj++) cand[bucketOf(mod(gj))].push(gj);   // control A bars whose 60-bar horizon stays inside the session
  const eAt = (j, f) => { const i = j - 1 - a, rg = hiSo[i] - loSo[i]; return rg > 0 ? (f < 0 ? (D.C[j - 1] - loSo[i]) / rg : (hiSo[i] - D.C[j - 1]) / rg) : null; };   // AMENDMENT 1: prior-bar position in the day range through j-1
  const away = new Uint8Array(b - a); for (let gj = a; gj < b; gj++) { let ok = 1; for (const lv of L) if (Math.abs(D.C[gj] - lv.p) <= PROX) { ok = 0; break; } away[gj - a] = ok; }   // control B: >= PROX from EVERY level of the day
  for (const lev of L) {
    if (!opt.has(lev.n + '_FADE_LONG') && !opt.has(lev.n + '_FADE_SHORT')) continue; const g = formGate(lev.n);
    for (let gi = a + 5; gi < b - 1; gi++) {
      if (mod(gi) < Math.max(575, g) || Math.abs(D.C[gi] - lev.p) > PROX) continue;
      const long = !(D.C[gi - 5] < D.C[gi]), f = long ? 1 : -1, type = `${lev.n}_FADE_${long ? 'LONG' : 'SHORT'}`; if (!opt.has(type)) break;
      const m = mod(gi), bk = bucketOf(m), rng = hiSo[gi - a] - loSo[gi - a];
      const e = eAt(gi, f), newExt = f < 0 ? D.H[gi] > hiSo[gi - 1 - a] : D.L[gi] < loSo[gi - 1 - a];
      const beyond = f < 0 ? D.C[gi] > pdH : D.C[gi] < pdL;
      const ret60 = gi + H <= b - 1 ? f * (D.C[gi + H] - D.O[gi + 1]) / atr : null;
      let ctrl = null;
      if (ret60 !== null && cand[bk].length) { const rnd = mulberry(hash(`${d}|${lev.n}|${f}`)); let s = 0; for (let k = 0; k < K_CTRL; k++) { const gj = cand[bk][Math.floor(rnd() * cand[bk].length)]; s += f * (D.C[gj + H] - D.O[gj + 1]) / atr; } ctrl = s / K_CTRL; }
      let ctrlB = null, nB = 0;
      if (ret60 !== null && e !== null) { const cs = cand[bk].filter((gj) => away[gj - a] && eAt(gj, f) !== null).map((gj) => ({ gj, dist: Math.abs(eAt(gj, f) - e) })).sort((x, y) => x.dist - y.dist || x.gj - y.gj).slice(0, K_CTRL); nB = cs.length; if (nB >= 5) ctrlB = cs.reduce((acc, c) => acc + f * (D.C[c.gj + H] - D.O[c.gj + 1]) / atr, 0) / nB; }
      rows.push({ d, gi, ts: D.TS[gi], mod: m, bucket: bk, lvl: lev.n, fam: familyOf(lev.n), f, atr, e, newExt, beyond, ret60, ctrl, excess: ret60 !== null && ctrl !== null ? ret60 - ctrl : null, ctrlB, nB, excessB: ret60 !== null && ctrlB !== null ? ret60 - ctrlB : null, pnlSym: symPnl(gi, b - 1, f, atr) });
      break; // once per level per day
    }
  }
}
const nAt = new Map(); for (const r of rows) nAt.set(`${r.d}|${r.gi}`, (nAt.get(`${r.d}|${r.gi}`) || 0) + 1); for (const r of rows) r.nLevels = nAt.get(`${r.d}|${r.gi}`);
rows.sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : x.gi - y.gi));
fs.writeFileSync(new URL('../scratch/level_touch_events_20261026.json', import.meta.url), JSON.stringify({ rows, excl, from: FROM, to: TO, K_CTRL, H }));
// ---- STATE COUNTS ONLY ----
const by2 = (pred, key) => rows.filter(pred).reduce((o, r) => { o[r[key]] = (o[r[key]] || 0) + 1; return o; }, {});
const days = new Set(rows.map((r) => r.d)), by = (fn) => rows.reduce((o, r) => { const k = fn(r); o[k] = (o[k] || 0) + 1; return o; }, {});
console.log(`window ${FROM}..${TO}: level-touch rows ${rows.length} on ${days.size} dates; excluded days`, excl);
console.log('by f', by((r) => r.f), '| by family', by((r) => r.fam), '| by bucket', by((r) => r.bucket));
console.log('no 60-min horizon (after 15:00) by bucket', by2((r) => r.ret60 === null, 'bucket'), '| with ret60+controlA', rows.filter((r) => r.excess !== null).length, '| with controlB', rows.filter((r) => r.excessB !== null).length, '| e defined', rows.filter((r) => r.e !== null).length);
console.log('beyond true', rows.filter((r) => r.beyond).length, '| newExt true', rows.filter((r) => r.newExt).length, 'by family', Object.fromEntries([...new Set(rows.map((r) => r.fam))].map((fm) => [fm, rows.filter((r) => r.fam === fm && r.newExt).length + '/' + rows.filter((r) => r.fam === fm).length])));
const SEL = '2026-07-09';
for (const [lvl, f] of [['IB_HIGH', -1], ['WS1', 1], ['IB_LOW', 1], ['WR1', -1]]) {
  const x = rows.filter((r) => r.lvl === lvl && r.f === f), pre = x.filter((r) => r.d < SEL), post = x.filter((r) => r.d >= SEL), ok = pre.filter((r) => r.excess !== null);
  console.log(`${lvl} f=${f}: all ${x.length} | before ${SEL}: ${pre.length} rows on ${new Set(pre.map((r) => r.d)).size} days, with outcome+control ${ok.length} on ${new Set(ok.map((r) => r.d)).size} days | from ${SEL}: ${post.length}`);
}
console.log('level names containing IB_/WS/WR:', [...new Set(rows.map((r) => r.lvl))].filter((n) => /^IB_|^W[RS]/.test(n)).join(', '));
process.exit(0);
