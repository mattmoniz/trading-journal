// Pre-registered in docs/FLOOR_ENTRY_ES_AGREEMENT_PREREG_20261026.md (+ Amendment 1), committed before this ran.
// Arm at a value-area-low floor test; FIRE when NQ turns up m*A15 off the episode low; read ES at the fire bar. Exit-free forward returns in A15 units.
import fs from 'fs';
import { query } from '../server/db.js';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { FAMS, START, mean, pct, clock, loadBars, prep, neg, findEvents, loadLevels } from './lib/floorEngine.mjs';

const ITERS = 2000, PERM = 5000, HS = [15, 30, 60, 120, 240], M = Number(process.env.FE_M || 0.25);
const lo = 0.0125, hi = 0.9875;   // Bonferroni two-primary intervals (Amendment 1 item 4)
const f3 = (x) => (x == null || Number.isNaN(x) ? 'n/a' : (x >= 0 ? '+' : '') + x.toFixed(3));
const em = (ts) => Date.UTC(+ts.slice(0, 4), +ts.slice(5, 7) - 1, +ts.slice(8, 10), +ts.slice(11, 13), +ts.slice(14, 16)) / 60000;
const qnt = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))] : NaN; };

function index(B) { B.EM = B.T.map(em); B.byEm = new Map(B.EM.map((m, i) => [m, i])); return B; }
// forward return of an entry at open of bar i0 measured at the close of the bar h-1 minutes later, in A15 units; null if bars are missing
function fwd(B, i0, h, a) { const j = B.byEm.get(B.EM[i0] + h - 1); return j === undefined ? null : (B.C[j] - B.O[i0]) / a; }
function mfeMae(B, i0, h, a) { let hi2 = -Infinity, lo2 = Infinity, got = 0; for (let m = 0; m < h; m++) { const j = B.byEm.get(B.EM[i0] + m); if (j === undefined) continue; got++; hi2 = Math.max(hi2, B.H[j]); lo2 = Math.min(lo2, B.L[j]); } return got >= 0.8 * h ? { mfe: (hi2 - B.O[i0]) / a, mae: (B.O[i0] - lo2) / a } : null; }

// unconditional: mean forward return at the same clock minute over all bars of all sample days, A15 units (one pass)
function baselines(B) {
  const acc = HS.map(() => new Map());
  for (let i = 0; i < B.n - 1; i++) { const a = B.A15[B.TD[i]]; if (!a) continue; const c = clock(B.T[i]); HS.forEach((h, k) => { const v = fwd(B, i, h, a); if (v === null) return; const o = acc[k].get(c) || { s: 0, n: 0 }; o.s += v; o.n++; acc[k].set(c, o); }); }
  return (k, c) => { const o = acc[k].get(c); return o ? o.s / o.n : NaN; };
}

function episodeEnd(B, e, pm, limit = 720) { for (let j = e.i; j < Math.min(B.n, e.i + limit); j++) if (B.L[j] > e.val + 2 * pm * e.a) return j - e.i; return limit; }

// fire search for one side (B bars, X = the other instrument's bars with its own maps); returns null if never turned inside W
function fire(B, X, e, W, m) {
  let minL = Infinity, xMin = Infinity, xTurnBar = null; const stopLvl = e.val - 1 * e.a;
  for (let j = e.i; j < B.n - 1 && B.EM[j] - B.EM[e.i] <= W; j++) {
    if (B.L[j] > e.val + 2 * e.a) return null;      // episode ended without a turn
    if (B.C[j] <= stopLvl) return null;               // decisive break: sequence reset
    minL = Math.min(minL, B.L[j]);
    const xi = X.byEm.get(B.EM[j]); if (xi !== undefined) { xMin = Math.min(xMin, X.L[xi]); if (xTurnBar === null && (X.C[xi] - xMin) >= m * X.A15[X.TD[xi]]) xTurnBar = j; }
    if (B.C[j] - minL >= m * e.a) {
      const xi2 = X.byEm.get(B.EM[j]); if (xi2 === undefined || !X.A15[X.TD[xi2]]) return { miss: true };
      const agree = (X.C[xi2] - xMin) >= m * X.A15[X.TD[xi2]], lead = xTurnBar !== null && xTurnBar < j;
      return { j, i0: j + 1, turnSize: (B.C[j] - minL) / e.a, bars: B.EM[j] - B.EM[e.i], agree, lead };
    }
  }
  return null;
}

function blockBoot(items, stat, keyFn, seed) {
  const grp = new Map(); for (const x of items) { const k = keyFn(x); (grp.get(k) || grp.set(k, []).get(k)).push(x); }
  const keys = [...grp.keys()], rng = mulberry32(hashSeed(seed)), d = [];
  for (let it = 0; it < ITERS; it++) { const pool = []; for (let k = 0; k < keys.length; k++) pool.push(...grp.get(keys[Math.floor(rng() * keys.length)])); const v = stat(pool); if (Number.isFinite(v)) d.push(v); }
  return { lo: qnt(d, lo), hi: qnt(d, hi) };
}
// strata-weighted (by DISAGREE count) mean difference between flagged and unflagged within strata
function strat(items, flag, val) {
  const S = new Map(); for (const x of items) { (S.get(x.stratum) || S.set(x.stratum, { a: [], d: [] }).get(x.stratum))[flag(x) ? 'a' : 'd'].push(val(x)); }
  let num = 0, den = 0; for (const s of S.values()) if (s.a.length >= 2 && s.d.length >= 2) { num += s.d.length * (mean(s.a) - mean(s.d)); den += s.d.length; } return den ? num / den : NaN;
}

function buildEvents(B, X, base, lv, W, rng) {
  const rows = [], counts = { episodes: 0, neverTurned: 0, esMissing: 0, noCleanFill: 0 }, pool = new Map();
  for (const f of FAMS) {
    const evs = findEvents(B, f, lv(f), 1, 1); counts.episodes += evs.length;
    const fired = [];
    for (const e of evs) { const r = fire(B, X, e, W, M); if (r === null) { counts.neverTurned++; continue; } if (r.miss) { counts.esMissing++; continue; } if (B.EM[r.i0] - B.EM[r.j] > 5) { counts.noCleanFill++; continue; } fired.push({ e, r }); }
    for (const { e, r } of fired) { const k = `${f}|${e.arm}|${B.TD[e.i].slice(0, 4)}`; (pool.get(k) || pool.set(k, []).get(k)).push(B.EM[r.j] - B.EM[e.i]); }
    for (const { e, r } of fired) {
      const a = e.a, td = B.TD[r.i0], ret = {}, ctl = {}, bs = {};
      HS.forEach((h, k) => { ret[h] = fwd(B, r.i0, h, a); bs[h] = base(k, clock(B.T[r.i0])); });
      const mm = mfeMae(B, r.i0, 60, a), mm4 = mfeMae(B, r.i0, 240, a);
      // delay-matched control (E3a): same family/arm/year delay, episode still active then, clock within 30 min, up to 10 tries
      const cand = pool.get(`${f}|${e.arm}|${B.TD[e.i].slice(0, 4)}`) || []; let got = false;
      for (let t = 0; t < 10 && cand.length > 1 && !got; t++) {
        const d = cand[Math.floor(rng() * cand.length)], jm = B.byEm.get(B.EM[e.i] + d); if (jm === undefined || jm + 1 >= B.n) continue;
        let ok = true; for (let j = e.i; j <= jm; j++) if (B.L[j] > e.val + 2 * e.a || B.C[j] <= e.val - e.a) { ok = false; break; }
        if (!ok || Math.abs(clock(B.T[jm + 1]) - clock(B.T[r.i0])) > 30) continue;
        HS.forEach((h) => { ctl[h] = fwd(B, jm + 1, h, a); }); got = true;
      }
      rows.push({ fam: f, arm: e.arm, seq: `${f}|${e.seq}`, day: td, i: e.i, turn: r.turnSize, bars: r.bars, agree: r.agree, lead: r.lead, sess: B.T[r.i0].slice(0, 10) === td && clock(B.T[r.i0]) >= 570 && clock(B.T[r.i0]) < 960 ? 'RTH' : 'GLOBEX', ret, bs, ctl: got ? ctl : null, mfe60: mm && mm.mfe, mae60: mm && mm.mae, mfe240: mm4 && mm4.mfe, mae240: mm4 && mm4.mae });
    }
  }
  const t1 = rows.map((x) => x.turn), t2 = rows.map((x) => x.bars), q = (a) => [qnt(a, 1 / 3), qnt(a, 2 / 3)], b = (v, c) => (v <= c[0] ? 0 : v <= c[1] ? 1 : 2), c1 = q(t1), c2 = q(t2);
  for (const x of rows) x.stratum = `${x.fam}|${b(x.turn, c1)}|${b(x.bars, c2)}`;
  return { rows, counts };
}
const dcount = (x) => new Set(x.map((e) => e.day)).size;
function summarizeSide(label, rows, counts) {
  const out = { label, counts }, fired = rows;
  console.log(`\n=== ${label}: episodes ${counts.episodes}, never turned inside W ${counts.neverTurned}, ES minutes missing ${counts.esMissing}, no clean next-bar fill ${counts.noCleanFill}, FIRED ${fired.length} on ${dcount(fired)} days`);
  for (const a of ['K1', 'K2', 'K3P']) { const x = fired.filter((e) => e.arm === a); console.log(`  ${a}: ${x.length} fired/${dcount(x)}d, AGREE ${x.filter((e) => e.agree).length}, LEAD ${x.filter((e) => e.lead).length}, DISAGREE ${x.filter((e) => !e.agree).length}, with matched control ${x.filter((e) => e.ctl).length}`); }
  // E1a per arm: excess of fire entry over its delay-matched control, ret60 in A15 units
  const ex = (e, h = 60) => (e.ret[h] != null && e.ctl && e.ctl[h] != null ? e.ret[h] - e.ctl[h] : null);
  out.E1a = {}; for (const a of ['K1', 'K2', 'K3P', 'ALL']) {
    const x = fired.filter((e) => (a === 'ALL' || e.arm === a) && ex(e) !== null); if (x.length < 20 || dcount(x) < 20) { out.E1a[a] = { n: x.length, underpowered: true }; console.log(`  E1a ${a}: n=${x.length} UNDERPOWERED`); continue; }
    const st = (z) => mean(z.map((e) => ex(e))), r = { n: x.length, days: dcount(x), mean: st(x), seq: blockBoot(x, st, (e) => e.seq, label + a + 'seq'), day: blockBoot(x, st, (e) => e.day, label + a + 'day'), uncond: mean(x.map((e) => e.ret[60] - e.bs[60])) };
    out.E1a[a] = r; console.log(`  E1a ${a} (fire minus delay-matched control, ret60 A15): n=${r.n}/${r.days}d ${f3(r.mean)} seqCI [${f3(r.seq.lo)},${f3(r.seq.hi)}] dayCI [${f3(r.day.lo)},${f3(r.day.hi)}] | descriptive fire minus all-clock unconditional ${f3(r.uncond)}`);
  }
  // E1 gated: within-sequence paired K3P excess minus K1 excess
  const k1 = new Map(), k3 = new Map(); for (const e of fired) { if (ex(e) === null) continue; if (e.arm === 'K1') k1.set(e.seq, e); if (e.arm === 'K3P') k3.set(e.seq, e); }
  const pairs = [...k3].filter(([k]) => k1.has(k)).map(([k, e3]) => ({ seq: k, day: e3.day, d: ex(e3) - ex(k1.get(k)) })), pst = (z) => mean(z.map((p) => p.d));
  if (pairs.length >= 20 && dcount(pairs) >= 20) { out.E1 = { n: pairs.length, days: dcount(pairs), mean: pst(pairs), seq: blockBoot(pairs, pst, (p) => p.seq, label + 'E1seq'), day: blockBoot(pairs, pst, (p) => p.day, label + 'E1day') }; console.log(`  E1 GATED paired K3P-minus-K1 excess (same sequence): n=${out.E1.n}/${out.E1.days}d ${f3(out.E1.mean)} seqCI [${f3(out.E1.seq.lo)},${f3(out.E1.seq.hi)}] dayCI [${f3(out.E1.day.lo)},${f3(out.E1.day.hi)}]`); } else { out.E1 = { n: pairs.length, underpowered: true }; console.log(`  E1 GATED paired: n=${pairs.length} UNDERPOWERED`); }
  // E2 / strict lead
  const e2 = fired.filter((e) => e.ret[60] != null); out.E2 = {};
  for (const [name, flag] of [['AGREE', (e) => e.agree], ['LEAD', (e) => e.lead]]) {
    const S = new Map(); for (const e of e2) (S.get(e.stratum) || S.set(e.stratum, { a: 0, d: 0 }).get(e.stratum))[flag(e) ? 'a' : 'd']++;
    const usable = e2.filter((e) => { const s = S.get(e.stratum); return s.a >= 2 && s.d >= 2; }), nD = usable.filter((e) => !flag(e)).length, days = dcount(usable);
    const st = (z) => strat(z, flag, (e) => e.ret[60]), obs = st(usable);
    const r = { n: usable.length, flagged: usable.filter(flag).length, notFlagged: nD, days, obs };
    if (days >= 20 && nD >= 30) {
      r.seq = blockBoot(usable, st, (e) => e.seq, label + name + 'seq'); r.day = blockBoot(usable, st, (e) => e.day, label + name + 'day');
      const rng = mulberry32(hashSeed(label + name + 'perm')), byS = new Map(); for (const e of usable) (byS.get(e.stratum) || byS.set(e.stratum, []).get(e.stratum)).push(e);
      const nulls = []; for (let p = 0; p < PERM; p++) { const sh = []; for (const g of byS.values()) { const flags = g.map(flag); for (let i = flags.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [flags[i], flags[j]] = [flags[j], flags[i]]; } g.forEach((e, i) => sh.push({ stratum: e.stratum, f: flags[i], v: e.ret[60] })); } nulls.push(strat(sh, (x) => x.f, (x) => x.v)); }
      r.perm975 = qnt(nulls, 0.975); r.permMedian = qnt(nulls, 0.5);
      const half = [...new Set(usable.map((e) => e.day))].sort(); const mid = half[Math.floor(half.length / 2)]; r.halves = [strat(usable.filter((e) => e.day < mid), flag, (e) => e.ret[60]), strat(usable.filter((e) => e.day >= mid), flag, (e) => e.ret[60])]; r.halfN = [usable.filter((e) => e.day < mid).length, usable.filter((e) => e.day >= mid).length];
      console.log(`  E2 ${name} (within strata, same NQ fire bar; ret60 A15): usable ${r.n} (flagged ${r.flagged}, not ${nD}) /${days}d  ${f3(obs)} seqCI [${f3(r.seq.lo)},${f3(r.seq.hi)}] dayCI [${f3(r.day.lo)},${f3(r.day.hi)}] permutation p97.5 ${f3(r.perm975)} halves ${r.halves.map(f3)} (n ${r.halfN})`);
    } else { r.underpowered = true; console.log(`  E2 ${name}: usable ${r.n} (flagged ${r.flagged}, not ${nD}) /${days}d ${f3(obs)} UNDERPOWERED (need >=20 days and >=30 not-flagged)`); }
    out.E2[name] = r;
  }
  out.overlapAgreeShare = fired.length ? fired.filter((e) => e.agree).length / fired.length : null; console.log(`  overlap: AGREE is ${(100 * out.overlapAgreeShare).toFixed(0)} percent of fired events`);
  for (const sess of ['RTH', 'GLOBEX']) { const x = fired.filter((e) => e.sess === sess); console.log(`  session ${sess}: n=${x.length}/${dcount(x)}d mean ret60 ${f3(mean(x.filter((e) => e.ret[60] != null).map((e) => e.ret[60])))} AGREE ${f3(mean(x.filter((e) => e.agree && e.ret[60] != null).map((e) => e.ret[60])))} DISAGREE ${f3(mean(x.filter((e) => !e.agree && e.ret[60] != null).map((e) => e.ret[60])))}`); }
  const sum = (h) => mean(fired.filter((e) => e.ret[h] != null).map((e) => e.ret[h])); console.log('  descriptive mean fwd return A15 by horizon:', HS.map((h) => `${h}m ${f3(sum(h))}`).join('  '), '| MFE60/MAE60', f3(mean(fired.filter((e) => e.mfe60 != null).map((e) => e.mfe60))), f3(mean(fired.filter((e) => e.mae60 != null).map((e) => e.mae60))));
  return out;
}

async function main() {
  const endRow = (await query(`SELECT (MAX(ts)::date - 1)::text d FROM price_bars_primary WHERE symbol='NQ' AND ts >= CURRENT_DATE - 7 AND ts < CURRENT_DATE + 1`)).rows[0].d;
  console.log(`NQ/ES bars ${START}..${endRow} (last complete date, reused verbatim); turn fraction m=${M}`);
  const NQ = index(prep(await loadBars('price_bars_primary', `symbol='NQ'`, START, endRow))), ES = index(prep(await loadBars('price_bars_es_front', '1=1', START, endRow)));
  const NQn = index(neg(NQ)), ESn = index(neg(ES)); NQn.A15 = NQ.A15; NQn.TD = NQ.TD; ESn.A15 = ES.A15; ESn.TD = ES.TD; NQn.days = NQ.days; NQn.capIdx = NQ.capIdx;
  const lv = await loadLevels(), base = baselines(NQ), baseN = baselines(NQn);
  // W: longer of 30 minutes and the median episode duration among explore-period events (first 60 percent of event dates)
  const probe = FAMS.flatMap((f) => findEvents(NQ, f, lv(f, false), 1, 1)), dates = [...new Set(probe.map((e) => NQ.TD[e.i]))].sort(), cut = dates[Math.floor(dates.length * 0.6) - 1];
  const W = Math.max(30, qnt(probe.filter((e) => NQ.TD[e.i] <= cut).map((e) => episodeEnd(NQ, e, 1)), 0.5)); console.log(`W = ${W} minutes (explore cut ${cut}, ${probe.length} episodes)`);
  const rng = mulberry32(hashSeed('ctl' + M));
  const A = buildEvents(NQ, ES, base, (f) => lv(f, false), W, rng), Bm = buildEvents(NQn, ESn, baseN, (f) => lv(f, true), W, rng);
  const outA = summarizeSide('LONG floors (VAL)', A.rows, A.counts), outB = summarizeSide('MIRROR short ceilings (VAH)', Bm.rows, Bm.counts);
  const g = outA, v = { E1: g.E1 && !g.E1.underpowered && g.E1.seq.lo > 0 && g.E1.day.lo > 0, E2: g.E2.AGREE && !g.E2.AGREE.underpowered && g.E2.AGREE.seq.lo > 0 && g.E2.AGREE.day.lo > 0 && g.E2.AGREE.obs > g.E2.AGREE.perm975 && g.E2.AGREE.halves.every((x) => x > 0) };
  console.log('\nVERDICT (Amendment 1 gates; rule constants fixed in advance):', JSON.stringify(v), '=> E1', v.E1 ? 'SHOWN' : 'NOT SHOWN', '| E2', v.E2 ? 'SHOWN' : 'NOT SHOWN / UNDERPOWERED (read the counts above)');
  fs.writeFileSync(`scratch/floor_entry_es_agreement_20261026_m${M}.json`, JSON.stringify({ endRow, M, W, long: outA, mirror: outB, verdict: v }, null, 1));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
