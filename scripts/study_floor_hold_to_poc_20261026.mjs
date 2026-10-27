// Pre-registered in docs/FLOOR_HOLD_TO_POC_PREREG_20261026.md (committed before this ran; read Amendments there too).
// H1: a value-area-low edge that was tested repeatedly and held is followed by price reaching that period's POC more often than a first test.
// H2: ES made a relatively higher low than NQ at the repeat test (canary). Raw NQ 1-minute bars first; nothing here touches live behaviour.
import fs from 'fs';
import { query } from '../server/db.js';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';

const FAMS = ['PW', '3M', 'PM', 'PD', 'PY'], START = process.env.FH_START || '2023-03-06', ITERS = 2000, PLACEBO_TRIALS = 200;
const SPARSE = (d) => d >= '2025-09-28' && d <= '2025-11-19';
const addDay = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const tradeDateOf = (ts) => (+ts.slice(11, 13) >= 18 ? addDay(ts.slice(0, 10), 1) : ts.slice(0, 10));
const clock = (ts) => +ts.slice(11, 13) * 60 + +ts.slice(14, 16);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN; };

async function loadBars(table, where, startDate, endDate, cols) {
  const T = [], O = [], H = [], L = [], C = [];
  let m = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  while (m <= end) {
    const a = m.toISOString().slice(0, 10), nx = new Date(m); nx.setUTCMonth(nx.getUTCMonth() + 1); const b = nx.toISOString().slice(0, 10);
    const r = await query(`SELECT ts::text t, open::float o, high::float h, low::float l, close::float c FROM ${table} WHERE ${where} AND ts >= $1 AND ts < $2 ORDER BY ts`, [a, b]);
    for (const x of r.rows) { T.push(x.t.slice(0, 19)); O.push(x.o); H.push(x.h); L.push(x.l); C.push(x.c); }
    m = nx;
  }
  return { T, O, H, L, C, n: T.length };
}
function prep(B) {
  B.TD = B.T.map(tradeDateOf);
  const q = new Map(); // 15-minute ranges per trade date
  for (let i = 0; i < B.n; i++) { const key = B.T[i].slice(0, 14) + String(Math.floor(+B.T[i].slice(14, 16) / 15) * 15).padStart(2, '0'); let o = q.get(key); if (!o) q.set(key, (o = { td: B.TD[i], h: -Infinity, l: Infinity })); o.h = Math.max(o.h, B.H[i]); o.l = Math.min(o.l, B.L[i]); }
  const byDay = new Map(); for (const o of q.values()) { const d = byDay.get(o.td) || { s: 0, n: 0 }; d.s += o.h - o.l; d.n++; byDay.set(o.td, d); }
  const days = [...byDay.keys()].sort(); B.days = days; B.A15 = {};
  days.forEach((d, i) => { if (i >= 20) { let s = 0; for (let j = i - 20; j < i; j++) s += byDay.get(days[j]).s / byDay.get(days[j]).n; B.A15[d] = s / 20; } });
  const rthEnd = new Map(), lastOf = new Map(); // last bar of each trade date: RTH close (<16:00 on the calendar date itself) else the last bar of the date
  for (let i = 0; i < B.n; i++) { lastOf.set(B.TD[i], i); if (B.T[i].slice(0, 10) === B.TD[i] && clock(B.T[i]) < 960) rthEnd.set(B.TD[i], i); }
  B.capIdx = (d) => (rthEnd.get(d) ?? lastOf.get(d));
  return B;
}
function neg(B) { return { ...B, O: B.O.map((x) => -x), H: B.L.map((x) => -x), L: B.H.map((x) => -x), C: B.C.map((x) => -x) }; }

function walk(B, i0, dir, entry, stopDist, tgtDist, cap) {
  const stop = entry - dir * stopDist, tgt = entry + dir * tgtDist; let mfe = 0;
  for (let i = i0; i <= cap; i++) {
    if (dir > 0) {
      if (B.L[i] <= stop) return { res: 'S', pts: Math.min(stop, B.O[i]) - entry, mfe, t: i - i0 };   // gap-through fills at the open; stop checked before target in the same bar (conservative)
      if (B.H[i] >= tgt) return { res: 'T', pts: tgtDist, mfe: tgtDist, t: i - i0 };
      mfe = Math.max(mfe, B.H[i] - entry);
    } else {
      if (B.H[i] >= stop) return { res: 'S', pts: entry - Math.max(stop, B.O[i]), mfe, t: i - i0 };
      if (B.L[i] <= tgt) return { res: 'T', pts: tgtDist, mfe: tgtDist, t: i - i0 };
      mfe = Math.max(mfe, entry - B.L[i]);
    }
  }
  return { res: 'C', pts: dir * (B.C[cap] - entry), mfe, t: cap - i0 };
}

// episodes/sequences per the pre-registration; lv(td) -> {val, poc} (already mirrored when B is negated)
function findEvents(B, fam, lv, pm, sm) {
  const out = []; let seq = null, seqId = 0;
  for (let i = 0; i < B.n - 1; i++) {
    const td = B.TD[i], a = B.A15[td], row = lv(td);
    if (!row || !a || isInsideNqRollWeek(td) || SPARSE(td) || !(row.val < row.poc)) { seq = null; continue; }
    if (seq && Math.abs(row.val - seq.val) > pm * a) seq = null;
    if (!seq) seq = { id: ++seqId, val: row.val, k: 0, inEp: false, armed: false, epLow: Infinity, epStart: 0, prevLow: null, prevStart: 0, prevEnd: 0, approachLow: Infinity, lastEnd: 0, k3: false };
    seq.val = row.val;
    if (B.C[i] <= seq.val - sm * a || B.H[i] >= row.poc) { seq = null; continue; }   // decisive break, or POC reached: sequence resolved
    const zoneHi = seq.val + pm * a, esc = seq.val + 2 * pm * a;
    if (!seq.inEp) {
      seq.approachLow = Math.min(seq.approachLow, B.L[i]);
      if (B.L[i] > esc) seq.armed = true;
      if (seq.armed && B.L[i] <= zoneHi) {
        seq.k++; if (seq.k >= 3 && seq.k3) out.dropK3 = (out.dropK3 || 0) + 1; seq.inEp = true; seq.epLow = B.L[i]; seq.epStart = i;
        const arm = seq.k === 1 ? 'K1' : seq.k === 2 ? 'K2' : (!seq.k3 ? 'K3P' : null); if (seq.k >= 3) seq.k3 = true;
        if (arm && clock(B.T[i + 1]) !== undefined) out.push({ fam, arm, k: seq.k, seq: seq.id, i, val: seq.val, poc: row.poc, a, prevLow: seq.prevLow, prevStart: seq.prevStart, prevEnd: seq.prevEnd, approachLow: seq.approachLow, lastEnd: seq.lastEnd });
      }
    } else {
      seq.epLow = Math.min(seq.epLow, B.L[i]);
      if (B.L[i] > esc) { seq.inEp = false; seq.prevLow = seq.epLow; seq.prevStart = seq.epStart; seq.prevEnd = i; seq.approachLow = Infinity; seq.lastEnd = i; }
    }
  }
  return out;
}
function simulate(B, evs, sm, rng, trials = 0) {
  const res = []; res.censored = 0;
  for (const e of evs) {
    const i0 = e.i + 1, entry = B.O[i0], td0 = B.TD[i0], di = B.days.indexOf(td0);
    if (di < 0 || di + 2 >= B.days.length) { res.censored++; continue; }                          // censored near the end of data
    if (B.T.length && (Date.parse(B.T[i0].replace(' ', 'T') + 'Z') - Date.parse(B.T[e.i].replace(' ', 'T') + 'Z')) > 300000) { res.censored++; continue; }   // next bar more than 5 min later: no clean fill
    const cap = B.capIdx(B.days[di + 2]), a = e.a, stopDist = entry - (e.val - sm * a), tgtDist = e.poc - entry;
    if (!(stopDist > 0) || !(tgtDist > 0) || cap == null || cap < i0) continue;
    const real = walk(B, i0, 1, entry, stopDist, tgtDist, cap), mir = walk(B, i0, -1, entry, stopDist, tgtDist, cap);
    const rnd = []; for (let k = 0; k < trials; k++) rnd.push(walk(B, i0, rng() < 0.5 ? 1 : -1, entry, stopDist, tgtDist, cap));
    res.push({ ...e, day: td0, sess: B.T[i0].slice(0, 10) === td0 && clock(B.T[i0]) >= 570 && clock(B.T[i0]) < 960 ? 'RTH' : 'GLOBEX', entry, stopDist, tgtDist, atrDist: tgtDist / a, real, mir, rnd, base: stopDist / (stopDist + tgtDist) });
  }
  return res;
}

// ---------- statistics (Amendment 1: within-sequence PAIRED primary, sequence-block + day-block CIs, 200-trial placebo of the paired difference) ----------
const hit = (evs, g = (e) => e.real) => (evs.length ? evs.filter((e) => g(e).res === 'T').length / evs.length : NaN);
const pts = (evs, g = (e) => e.real) => mean(evs.map((e) => g(e).pts));
const hit1 = (e, g) => (g(e).res === 'T' ? 1 : 0);
const pairsOf = (res) => { const k1 = new Map(), k3 = new Map(); for (const e of res) { const k = e.fam + '|' + e.seq; if (e.arm === 'K1') k1.set(k, e); if (e.arm === 'K3P') k3.set(k, e); } return [...k3].filter(([k]) => k1.has(k)).map(([k, e3]) => ({ key: k, e3, e1: k1.get(k), day: e3.day })); };
const real = (e) => e.real;
const dHit = (ps, g3 = real, g1 = real) => mean(ps.map((p) => hit1(p.e3, g3) - hit1(p.e1, g1)));
const dPts = (ps) => mean(ps.map((p) => p.e3.real.pts - p.e1.real.pts));
const k3Hit = (ps, g = real) => mean(ps.map((p) => hit1(p.e3, g)));
function boot(ps, f, keyFn, seed) { const grp = new Map(); for (const p of ps) (grp.get(keyFn(p)) || grp.set(keyFn(p), []).get(keyFn(p))).push(p); const keys = [...grp.keys()], rng = mulberry32(hashSeed(seed)), d = []; for (let it = 0; it < ITERS; it++) { const pool = []; for (let k = 0; k < keys.length; k++) pool.push(...grp.get(keys[Math.floor(rng() * keys.length)])); const v = f(pool); if (Number.isFinite(v)) d.push(v); } return { lo: pct(d, 0.025), hi: pct(d, 0.975) }; }
const dayCount = (evs) => new Set(evs.map((e) => e.day)).size;
const f3 = (x) => (x == null || Number.isNaN(x) ? 'n/a' : x.toFixed(3));
const f1 = (x) => (x == null || Number.isNaN(x) ? 'n/a' : x.toFixed(1));
function contrast(label, res) {
  const ps = pairsOf(res), k1all = res.filter((e) => e.arm === 'K1'), k3all = res.filter((e) => e.arm === 'K3P');
  const o = { label, pairs: ps.length, pairDays: new Set(ps.map((p) => p.day)).size, k3n: k3all.length, k1n: k1all.length, unpairedHitK3: hit(k3all), unpairedHitK1: hit(k1all), hitK3: k3Hit(ps), hitK1: ps.length ? mean(ps.map((p) => hit1(p.e1, real))) : NaN, ptsK3: ps.length ? mean(ps.map((p) => p.e3.real.pts)) : NaN, ptsK1: ps.length ? mean(ps.map((p) => p.e1.real.pts)) : NaN };
  if (ps.length >= 20 && o.pairDays >= 20) { o.hitDiff = dHit(ps); o.hitCIseq = boot(ps, (x) => dHit(x), (p) => p.key, label + ':hs'); o.hitCIday = boot(ps, (x) => dHit(x), (p) => p.day, label + ':hd'); o.ptsDiff = dPts(ps); o.ptsCIseq = boot(ps, dPts, (p) => p.key, label + ':ps'); o.ptsCIday = boot(ps, dPts, (p) => p.day, label + ':pd'); } else o.underpowered = true;
  return o;
}
const show = (c) => console.log(`${c.label.padEnd(24)} paired n=${c.pairs}/${c.pairDays}d | K3P hit ${f3(c.hitK3)} pts ${f1(c.ptsK3)} vs its own K1 hit ${f3(c.hitK1)} pts ${f1(c.ptsK1)} | ` + (c.underpowered ? 'UNDERPOWERED' : `hitDiff ${f3(c.hitDiff)} seqCI [${f3(c.hitCIseq.lo)},${f3(c.hitCIseq.hi)}] dayCI [${f3(c.hitCIday.lo)},${f3(c.hitCIday.hi)}] | ptsDiff ${f1(c.ptsDiff)} seqCI [${f1(c.ptsCIseq.lo)},${f1(c.ptsCIseq.hi)}] dayCI [${f1(c.ptsCIday.lo)},${f1(c.ptsCIday.hi)}]`) + ` | (descriptive unpaired: K3P ${f3(c.unpairedHitK3)} n${c.k3n} vs K1 ${f3(c.unpairedHitK1)} n${c.k1n})`);

async function main() {
  const endRow = process.env.STUDY_END || (await query(`SELECT (MAX(ts)::date - 1)::text d FROM price_bars_primary WHERE symbol='NQ' AND ts >= CURRENT_DATE - 7 AND ts < CURRENT_DATE + 1`)).rows[0].d; // STUDY_END (2026-10-27) pins the end for before/after repair comparisons; inert unless set
  console.log(`NQ bars ${START}..${endRow} (last complete date, reused verbatim)`);
  const NQ = prep(await loadBars('price_bars_primary', `symbol='NQ'`, START, endRow));
  console.log(`bars ${NQ.n}, trade dates ${NQ.days.length}`);
  const lvRows = (await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE level_name ~ '^(PW|3M|PM|PD|PY)_(VAL|POC|VAH)$' AND trade_date >= '2023-02-01' ORDER BY trade_date`)).rows;
  const tab = {}; for (const r of lvRows) { const [f, k] = r.n.split('_'); ((tab[f] ||= new Map()).get(r.d) || tab[f].set(r.d, {}).get(r.d))[k] = r.p; }
  const mkLv = (f, mirror) => { const ds = [...tab[f].keys()].sort(), cache = new Map(); return (td) => { if (cache.has(td)) return cache.get(td); let lo = 0, hi = ds.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ds[m] >= td) hi = m; else lo = m + 1; } const r = lo < ds.length ? tab[f].get(ds[lo]) : null; const v = r && r.VAL != null && r.POC != null && r.VAH != null ? (mirror ? { val: -r.VAH, poc: -r.POC } : { val: r.VAL, poc: r.POC }) : null; cache.set(td, v); return v; }; };
  const NQn = neg(NQ), meta = { censored: 0, dropK3: 0 };
  const runCell = (pm, sm, mirror, label, trials = 0) => { const B = mirror ? NQn : NQ, rng = mulberry32(hashSeed(label)); let all = []; for (const f of FAMS) { const evs = findEvents(B, f, mkLv(f, mirror), pm, sm), r = simulate(B, evs, sm, rng, trials); meta.dropK3 += evs.dropK3 || 0; meta.censored += r.censored; all = all.concat(r); } return all; };
  const base = runCell(1, 1, false, 'base', PLACEBO_TRIALS);
  console.log(`\nDROPPED/CENSORED (all cells so far): k>=3 episodes beyond the first K3P per sequence ${meta.dropK3}; entries censored by the 2-day cap or a >5-minute fill gap ${meta.censored}`);
  console.log('STATE COUNTS (primary p=1,s=1): events / distinct days per arm per family, and paired sequences');
  for (const f of FAMS) { const x = base.filter((e) => e.fam === f); console.log('  ' + f.padEnd(3), ['K1', 'K2', 'K3P'].map((a) => { const y = x.filter((e) => e.arm === a); return `${a} ${y.length}/${dayCount(y)}d`; }).join('  '), `paired ${pairsOf(x).length}`, ' median target distance (A15 units)', f1(pct(x.map((e) => e.atrDist), 0.5))); }
  const out = { endRow, meta, primary: null, secondary: {} };
  const primary = contrast('PRIMARY pooled p1 s1', base); out.primary = primary; console.log('\n'); show(primary);
  const ps = pairsOf(base);
  if (ps.length >= 20) {
    const rd = [], rh = []; for (let t = 0; t < PLACEBO_TRIALS; t++) { const g = (e) => e.rnd[t]; rd.push(dHit(ps, g, g)); rh.push(k3Hit(ps, g)); }
    out.placebo = { realDiff: dHit(ps), diffP975: pct(rd, 0.975), diffMedian: pct(rd, 0.5), realHit: k3Hit(ps), hitP975: pct(rh, 0.975), hitMedian: pct(rh, 0.5), mirroredHit: k3Hit(ps, (e) => e.mir), mirroredDiff: dHit(ps, (e) => e.mir, (e) => e.mir), analyticStopShare: mean(ps.map((p) => p.e3.base)) };
    console.log(`PLACEBO (${PLACEBO_TRIALS} random-direction trials): paired diff real ${f3(out.placebo.realDiff)} vs placebo median ${f3(out.placebo.diffMedian)} p97.5 ${f3(out.placebo.diffP975)} | K3P hit real ${f3(out.placebo.realHit)} vs placebo median ${f3(out.placebo.hitMedian)} p97.5 ${f3(out.placebo.hitP975)} | all-short mirror hit ${f3(out.placebo.mirroredHit)} diff ${f3(out.placebo.mirroredDiff)} | mean stop/(stop+target) ${f3(out.placebo.analyticStopShare)}`);
    const days = [...new Set(ps.map((p) => p.day))].sort(), mid = days[Math.floor(days.length / 2)], A = ps.filter((p) => p.day < mid), Bq = ps.filter((p) => p.day >= mid);
    out.halves = { split: mid, first: { n: A.length, d: dHit(A) }, second: { n: Bq.length, d: dHit(Bq) } };
    console.log(`HALVES (split ${mid}): paired hit diff first ${f3(dHit(A))} (n ${A.length}), second ${f3(dHit(Bq))} (n ${Bq.length})`);
    const k3 = base.filter((e) => e.arm === 'K3P'); for (const sess of ['RTH', 'GLOBEX']) { const x = k3.filter((e) => e.sess === sess); console.log(`SESSION ${sess}: K3P n=${x.length}/${dayCount(x)}d hit ${f3(hit(x))} pts ${f1(pts(x))}`); }
    const c = primary, v = { seqCI: c.hitCIseq && c.hitCIseq.lo > 0, dayCI: c.hitCIday && c.hitCIday.lo > 0, placeboDiff: out.placebo.realDiff > out.placebo.diffP975, placeboHit: out.placebo.realHit > out.placebo.hitP975, ptsPos: c.ptsK3 > 0, ptsDiffCI: c.ptsCIseq && c.ptsCIseq.lo > 0, halves: out.halves.first.d > 0 && out.halves.second.d > 0 };
    out.verdict = { conditions: v, shown: Object.values(v).every(Boolean) }; console.log('VERDICT conditions', JSON.stringify(v), '=>', out.verdict.shown ? 'SHOWN' : 'NOT SHOWN (fails at least one pre-registered condition)');
  }
  console.log('\nPER-FAMILY (robustness only, p1 s1)'); for (const f of FAMS) { const c = contrast(f, base.filter((e) => e.fam === f)); out.secondary['fam_' + f] = c; show(c); }
  console.log('\nSENSITIVITY (robustness only)'); for (const [pm, sm] of [[0.5, 1], [2, 1], [1, 0.5], [1, 2]]) { const c = contrast(`p${pm} s${sm}`, runCell(pm, sm, false, `sens${pm}_${sm}`)); out.secondary[`p${pm}s${sm}`] = c; show(c); }
  console.log('\nMIRROR: VAH ceiling -> POC down (same code on negated bars)'); const mir = contrast('VAH mirror p1 s1', runCell(1, 1, true, 'mirror')); out.secondary.mirror = mir; show(mir);
  fs.writeFileSync('scratch/floor_hold_to_poc_20261026.json', JSON.stringify(out, null, 1));
  // ---------- H2: ES canary (descriptive unless >= 20 distinct days each side) ----------
  const ES = prep(await loadBars('price_bars_es_front', '1=1', START, endRow)); const esLow = new Map(ES.T.map((t, i) => [t, ES.L[i]]));
  const lowOver = (i1, i2) => { let m = Infinity, got = 0, tot = 0; for (let j = i1; j <= i2; j++) { tot++; const v = esLow.get(NQ.T[j]); if (v !== undefined) { got++; if (v < m) m = v; } } return tot > 0 && got / tot >= 0.8 ? m : null; };
  const h2 = []; for (const e of base.filter((x) => (x.arm === 'K2' || x.arm === 'K3P') && x.prevLow != null)) {
    const esA = ES.A15[NQ.TD[e.i]], esNow = lowOver(e.lastEnd + 1, e.i), esPrev = lowOver(e.prevStart, e.prevEnd); if (!esA || esNow == null || esPrev == null) continue;
    h2.push({ ...e, D: (esNow - esPrev) / esA - (e.approachLow - e.prevLow) / e.a });
  }
  const pos = h2.filter((e) => e.D > 0), ng = h2.filter((e) => e.D <= 0);
  const c2 = { n: h2.length, nPos: pos.length, dPos: dayCount(pos), nNeg: ng.length, dNeg: dayCount(ng), hitPos: hit(pos), hitNeg: hit(ng), ptsPos: pts(pos), ptsNeg: pts(ng) };
  if (dayCount(pos) >= 20 && dayCount(ng) >= 20) { c2.diff = c2.hitPos - c2.hitNeg; const days = new Map(); for (const e of h2) (days.get(e.day) || days.set(e.day, []).get(e.day)).push(e); const keys = [...days.keys()], rng = mulberry32(hashSeed('h2')), d = []; for (let it = 0; it < ITERS; it++) { let a = [], b = []; for (let k = 0; k < keys.length; k++) for (const e of days.get(keys[Math.floor(rng() * keys.length)])) (e.D > 0 ? a : b).push(e); const v = hit(a) - hit(b); if (Number.isFinite(v)) d.push(v); } c2.ci = { lo: pct(d, 0.025), hi: pct(d, 0.975) }; } else c2.descriptiveOnly = true;
  out.h2 = c2; console.log(`\nH2 ES CANARY (K2+K3P with a previous episode): n ${c2.n}; canary+ (ES higher low) n=${c2.nPos}/${c2.dPos}d hit ${f3(c2.hitPos)} pts ${f1(c2.ptsPos)} | canary- n=${c2.nNeg}/${c2.dNeg}d hit ${f3(c2.hitNeg)} pts ${f1(c2.ptsNeg)} | ` + (c2.descriptiveOnly ? 'DESCRIPTIVE ONLY (<20 days a side)' : `diff ${f3(c2.diff)} CI [${f3(c2.ci.lo)},${f3(c2.ci.hi)}]`));
  fs.writeFileSync('scratch/floor_hold_to_poc_20261026.json', JSON.stringify(out, null, 1));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
