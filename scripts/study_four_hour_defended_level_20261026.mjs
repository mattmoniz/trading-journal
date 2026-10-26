// Pre-registered in docs/FOUR_HOUR_DEFENDED_LEVEL_PREREG_20261026.md + Amendment 1 (committed before this ran).
// Levels built from 4-hour bars, frozen at birth, K = number of separate 4-hour bars that ended at the level (birth bar + retests). Floors and (mirrored) tops. Outcome = exit-free forward return from the
// next 1-minute open, in D20 units, minus a clock-matched blind same-direction entry.
import fs from 'fs';
import { query } from '../server/db.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { loadBars, prep, neg, indexBars, clock, mean, SPARSE } from './lib/floorEngine.mjs';
import { f3, qnt } from './lib/floorStats.mjs';

const WIN = 6, LIFE = 12, HS = [240, 1440, 2880], PRIMARY = 1440;
const elapsed = (c) => (c >= 1080 ? c - 1080 : c + 360);
function build4h(NQ) {
  const by = new Map(); for (let i = 0; i < NQ.n; i++) { const c = clock(NQ.T[i]); if (c >= 1020 && c < 1080) continue; const key = NQ.TD[i] + '|' + Math.min(5, Math.floor(elapsed(c) / 240)); let o = by.get(key); if (!o) by.set(key, (o = { td: NQ.TD[i], slot: +key.split('|')[1], i0: i, i1: i, H: -Infinity, L: Infinity, V: 0, n: 0 })); o.i1 = i; o.H = Math.max(o.H, NQ.H[i]); o.L = Math.min(o.L, NQ.L[i]); o.V += NQ.V[i] || 0; o.n++; o.O ??= NQ.O[i]; o.C = NQ.C[i]; }
  const bars = [...by.values()].filter((b) => b.n >= 60).sort((a, b) => NQ.EM[a.i0] - NQ.EM[b.i0]);
  const perTd = new Map(); for (const b of bars) (perTd.get(b.td) || perTd.set(b.td, []).get(b.td)).push(b.H - b.L); const tds = [...perTd.keys()].sort(), h4 = {}, volSlot = new Map();
  tds.forEach((d, k) => { if (k >= 20) h4[d] = mean(tds.slice(k - 20, k).flatMap((x) => perTd.get(x))); });
  const slotV = new Map(); for (const b of bars) { const k = b.slot; (slotV.get(k) || slotV.set(k, []).get(k)).push({ td: b.td, v: b.V }); }
  for (const b of bars) { const prior = slotV.get(b.slot).filter((x) => x.td < b.td).slice(-20); b.relBase = prior.length >= 10 ? mean(prior.map((x) => x.v)) : null; }
  return { bars, h4 };
}
const negBars = (bars) => bars.map((b) => ({ ...b, H: -b.L, L: -b.H, O: -b.O, C: -b.C }));
function runLevels(bars, h4, bandMult) {
  const ev = [], funnel = { born: 0, k2: 0, k3: 0, k4: 0, k5: 0, brokeBeforeK3: 0, expired: 0 }; let active = [], id = 0;
  for (let t = 0; t < bars.length; t++) {
    const b = bars[t], H4 = h4[b.td]; if (!H4 || isInsideNqRollWeek(b.td) || SPARSE(b.td)) { active = []; continue; } const band = bandMult * H4;
    const keep = [];
    for (const lv of active) {
      if (t - lv.t0 > LIFE) { funnel.expired++; continue; }
      if (b.C <= lv.L - band) { if (lv.K >= 3) ev.push({ kind: 'BRK', K: lv.K, id: lv.id, t, td: b.td, level: lv.L, brk: (lv.L - b.C) / H4 }); else { funnel.brokeBeforeK3++; ev.push({ kind: 'BRK1', K: lv.K, id: lv.id, t, td: b.td, level: lv.L, brk: (lv.L - b.C) / H4 }); } continue; }
      if (b.L >= lv.L - band && b.L <= lv.L + band && b.C > lv.L - band) { lv.K++; lv.vols.push(b); if (lv.K === 2) funnel.k2++; if (lv.K >= 3) { const kk = Math.min(lv.K, 5); if (lv.K === 3) funnel.k3++; if (lv.K === 4) funnel.k4++; if (lv.K === 5) funnel.k5++; if (lv.K <= 5) ev.push({ kind: 'K' + kk, K: lv.K, id: lv.id, t, td: b.td, level: lv.L, bars: lv.vols.slice() }); } }
      keep.push(lv);
    }
    active = keep;
    if (t >= WIN - 1) { let lo = Infinity; for (let k = t - WIN + 1; k <= t; k++) lo = Math.min(lo, bars[k].L); if (b.L <= lo && !active.some((lv) => Math.abs(lv.L - b.L) <= band)) { const lv = { id: ++id, L: b.L, t0: t, K: 1, vols: [b] }; active.push(lv); funnel.born++; ev.push({ kind: 'K1', K: 1, id: lv.id, t, td: b.td, level: lv.L }); } }
  }
  return { ev, funnel };
}
async function main() {
  const endRow = (await query(`SELECT (MAX(ts)::date - 3)::text d FROM price_bars_primary WHERE symbol='NQ' AND ts >= CURRENT_DATE - 7 AND ts < CURRENT_DATE + 1`)).rows[0].d;
  const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2023-03-06', endRow))), NQn = neg(NQ);
  const rng0 = new Map(); for (let i = 0; i < NQ.n; i++) { const o = rng0.get(NQ.TD[i]) || { h: -Infinity, l: Infinity }; o.h = Math.max(o.h, NQ.H[i]); o.l = Math.min(o.l, NQ.L[i]); rng0.set(NQ.TD[i], o); }
  const dl = [...rng0.keys()].sort(), d20 = {}; dl.forEach((d, k) => { if (k >= 20) d20[d] = mean(dl.slice(k - 20, k).map((x) => rng0.get(x).h - rng0.get(x).l)); });
  const { bars, h4 } = build4h(NQ); console.log(`NQ bars to ${endRow}: ${NQ.n}; 4-hour bars ${bars.length}`);
  const rng = mulberry32(hashSeed('fourhour')), samp = []; for (let i = 3100; i < NQ.n - 3000; i += 15) if (d20[NQ.TD[i]]) samp.push(i);
  const out = {};
  for (const bandMult of [0.25, 0.5]) {
    const sides = { floor: { bars, B: NQ }, top: { bars: negBars(bars), B: NQn } }, res = {};
    for (const [name, S] of Object.entries(sides)) {
      const { ev, funnel } = runLevels(S.bars, h4, bandMult), B = S.B;
      const retOf = (i0, h, dir) => { const x = NQ.byEm.get(NQ.EM[i0] + h - 1); return x === undefined ? null : dir * (B.C[x] - B.O[i0]) / d20[NQ.TD[i0]]; };
      const ctl = (e, h, dir) => { const outc = []; for (let t = 0; t < 400 && outc.length < 10; t++) { const b = samp[Math.floor(rng() * samp.length)]; if (NQ.TD[b] === e.td || Math.abs(clock(NQ.T[b]) - clock(NQ.T[e.i0])) > 30) continue; const r = retOf(b + 1, h, dir); if (r != null) outc.push(r); } return outc.length >= 3 ? mean(outc) : null; };
      for (const e of ev) { const b4 = S.bars[e.t]; e.i0 = b4.i1 + 1; if (e.i0 >= NQ.n - 3000) { e.drop = true; continue; } e.day = NQ.TD[e.i0]; e.dir = e.kind.startsWith('BRK') ? -1 : 1; e.sess = clock(NQ.T[e.i0]) >= 570 && clock(NQ.T[e.i0]) < 960 ? 'RTH' : 'GLOBEX';
        for (const h of HS) { e['r' + h] = retOf(e.i0, h, e.dir); const c = ctl(e, h, e.dir); e['x' + h] = e['r' + h] != null && c != null ? e['r' + h] - c : null; }
        if (e.bars) { const rv = e.bars.filter((x) => x.relBase).map((x) => x.V / x.relBase); e.relVol = rv.length ? mean(rv) : null; } }
      const good = ev.filter((e) => !e.drop), firstPer = new Map(); for (const e of good) if (e.kind.startsWith('K') && e.K >= 3 && !firstPer.has(e.id)) firstPer.set(e.id, e);
      res[name] = { good, funnel, firstK3: [...firstPer.values()], brk: good.filter((e) => e.kind === 'BRK'), brk1: good.filter((e) => e.kind === 'BRK1'), k1: good.filter((e) => e.kind === 'K1') };
    }
    out[bandMult] = res;
  }
  const report = (bandMult, primary) => {
    const R = out[bandMult]; console.log(`\n######## band = ${bandMult} x H4 ${primary ? '(PRIMARY)' : '(sensitivity, descriptive)'}`);
    for (const nm of ['floor', 'top']) { const r = R[nm], f = r.funnel, cnt = (k) => r.good.filter((e) => e.kind === k).length; console.log(`  ${nm.toUpperCase()}S: levels born ${f.born}; reached K=2 ${f.k2}, K=3 ${f.k3}, K=4 ${f.k4}, K=5 ${f.k5}; broke before K=3 ${f.brokeBeforeK3}; expired ${f.expired}; events K3 ${cnt('K3')} K4 ${cnt('K4')} K5+ ${cnt('K5')}, BRK(K>=3) ${r.brk.length}, BRK(K=1) ${r.brk1.length}`); }
  };
  report(0.25, true); report(0.5, false);
  // verdict cells at the primary band
  const R = out[0.25], boot = (items, key, lo, seed) => { const g = new Map(); for (const x of items) (g.get(x.day) || g.set(x.day, []).get(x.day)).push(x[key]); const keys = [...g.keys()], r = mulberry32(hashSeed(seed)), d = []; for (let it = 0; it < 4000; it++) { let s = 0, n = 0; for (let k = 0; k < keys.length; k++) for (const v of g.get(keys[Math.floor(r() * keys.length)])) { s += v; n++; } d.push(s / n); } d.sort((a, b) => a - b); return { lo: d[Math.floor(lo * d.length)], hi: d[Math.floor((1 - lo) * d.length) - 1] }; };
  const cells = [['FADE-F (long off floor)', R.floor.firstK3], ['FADE-T (short off top)', R.top.firstK3], ['BREAK-F (short after floor breaks)', R.floor.brk], ['BREAK-T (long after top breaks)', R.top.brk]];
  const allDays = [...new Set(cells.flatMap(([, e]) => e.map((x) => x.day)))].sort(), cut = allDays[Math.floor(allDays.length * 0.6) - 1]; let cands = 0, surv = 0, tested = 0;
  console.log(`\nVERDICT CELLS (exit-free, +${PRIMARY} min, D20 units, excess over clock-matched blind entry; explore <= ${cut}; explore CI 98.75 percent (Bonferroni over 4), hold-out one 95 percent test)`);
  for (const [nm, evs] of cells) {
    const u = evs.filter((e) => e['x' + PRIMARY] != null).map((e) => ({ day: e.day, v: e['x' + PRIMARY] })), a = u.filter((e) => e.day <= cut), h = u.filter((e) => e.day > cut), dc = (z) => new Set(z.map((e) => e.day)).size;
    const under = (z) => z.length < 30 || dc(z) < 20; let v = 'UNDERPOWERED (explore)', ea = '', ha = '';
    if (!under(a)) { tested++; const c = boot(a.map((x) => ({ day: x.day, v: x.v })), 'v', 0.00625, nm + 'a'); ea = `${f3(mean(a.map((x) => x.v)))} [${f3(c.lo)},${f3(c.hi)}] n=${a.length}/${dc(a)}d`; const cand = c.lo > 0; if (cand) cands++; if (!cand) v = 'no'; else if (under(h)) v = 'CANDIDATE, hold-out UNDERPOWERED'; else { const ch = boot(h, 'v', 0.025, nm + 'h'); ha = `${f3(mean(h.map((x) => x.v)))} [${f3(ch.lo)},${f3(ch.hi)}] n=${h.length}/${dc(h)}d`; v = mean(h.map((x) => x.v)) > 0 && ch.lo > 0 && mean(a.map((x) => x.v)) > 0 ? 'SCREEN-SURVIVOR' : 'candidate, not a survivor'; if (v === 'SCREEN-SURVIVOR') surv++; } }
    else ea = `n=${a.length}/${dc(a)}d`; if (!ha) ha = `n=${h.length}/${dc(h)}d`;
    const all = u.length ? `${f3(mean(u.map((x) => x.v)))} (n=${u.length}, ${dc(u)} dates)` : 'n/a'; console.log(`  ${nm.padEnd(36)} all dates ${all} | explore ${ea} | hold-out ${ha} | ${v}`);
  }
  console.log(`CELLS TESTED ${tested} (of 4), CANDIDATES ${cands}, expected by chance about ${(tested * 0.0125).toFixed(2)}, SCREEN-SURVIVORS ${surv}`);
  // descriptive: horizons, K split, vs K=1 events, session, volume
  console.log('\nDESCRIPTIVE (primary band)');
  for (const [nm, key] of [['floor', 'firstK3'], ['top', 'firstK3']]) { const r = R[nm]; for (const h of HS) { const x = r[key].map((e) => e['x' + h]).filter((v) => v != null), k1 = r.k1.map((e) => e['r' + h]).filter((v) => v != null), k3r = r[key].map((e) => e['r' + h]).filter((v) => v != null); console.log(`  ${nm} fade +${h}: excess over clock control ${f3(mean(x))} (n ${x.length}) | raw ${f3(mean(k3r))} vs ALL fresh K=1 birth events raw ${f3(mean(k1))} (n ${k1.length}) | share up ${(100 * k3r.filter((v) => v > 0).length / k3r.length).toFixed(0)}%`); } for (const K of ['K4', 'K5']) { const e = r.good.filter((x) => x.kind === K).map((x) => x['x' + PRIMARY]).filter((v) => v != null); console.log(`  ${nm} ${K} events excess +${PRIMARY}: ${f3(mean(e))} (n ${e.length})`); } for (const s of ['RTH', 'GLOBEX']) { const e = r.firstK3.filter((x) => x.sess === s).map((x) => x['x' + PRIMARY]).filter((v) => v != null); console.log(`  ${nm} first-K3 ${s}: excess ${f3(mean(e))} (n ${e.length})`); }
    const v = r.firstK3.filter((e) => e.relVol != null && e['x' + PRIMARY] != null), m = qnt(v.map((e) => e.relVol), 0.5), hv = v.filter((e) => e.relVol > m).map((e) => e['x' + PRIMARY]), lt = v.filter((e) => e.relVol <= m).map((e) => e['x' + PRIMARY]); const mx = mean(v.map((e) => e.relVol)), my = mean(v.map((e) => e['x' + PRIMARY])), sl = v.reduce((s, e) => s + (e.relVol - mx) * (e['x' + PRIMARY] - my), 0) / v.reduce((s, e) => s + (e.relVol - mx) ** 2, 0); console.log(`  ${nm} volume at the defended bars (relative to the same slot): HEAVY excess ${f3(mean(hv))} (n ${hv.length}) vs LIGHT ${f3(mean(lt))} (n ${lt.length}), slope of excess on relative volume ${f3(sl)} per 1.0x`); }
  for (const [nm, r] of [['floor', R.floor], ['top', R.top]]) { const b3 = r.brk.map((e) => e['x' + PRIMARY]).filter((v) => v != null), b1 = r.brk1.map((e) => e['x' + PRIMARY]).filter((v) => v != null); console.log(`  ${nm} break +${PRIMARY}: after K>=3 levels ${f3(mean(b3))} (n ${b3.length}, mean break distance ${f3(mean(r.brk.map((e) => e.brk)))} H4) vs after K=1 levels ${f3(mean(b1))} (n ${b1.length}, ${f3(mean(r.brk1.map((e) => e.brk)))} H4)`); }
  fs.writeFileSync('scratch/four_hour_defended_level_20261026.json', JSON.stringify({ endRow, tested, cands, surv }, null, 1));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
