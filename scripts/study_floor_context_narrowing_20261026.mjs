// Pre-registered in docs/FLOOR_CONTEXT_NARROWING_PREREG_20261026.md (committed before this ran). Reads the parent study's event rows
// (scratch/floor_entry_events_20261026_m0.25.json) and splits E2 (ES agreement) and E1a (entry vs delay-matched control) by pre-listed contexts,
// picking on the earlier 60 percent of dates and confirming on the later 40 percent.
import fs from 'fs';
import { query } from '../server/db.js';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { mean, clock, loadBars, prep } from './lib/floorEngine.mjs';

const ITERS = 2000, MIN_DAYS = 20, MIN_DIS = 30;
const f3 = (x) => (x == null || Number.isNaN(x) ? '  n/a ' : (x >= 0 ? '+' : '') + x.toFixed(3));
const qnt = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))] : NaN; };
// copied verbatim from study_floor_entry_es_agreement_20261026.mjs (checked below: the ALL cell reproduces the parent's printed E2/E1a)
function strat(items, flag, val) { const S = new Map(); for (const x of items) { (S.get(x.stratum) || S.set(x.stratum, { a: [], d: [] }).get(x.stratum))[flag(x) ? 'a' : 'd'].push(val(x)); } let num = 0, den = 0; for (const s of S.values()) if (s.a.length >= 2 && s.d.length >= 2) { num += s.d.length * (mean(s.a) - mean(s.d)); den += s.d.length; } return den ? num / den : NaN; }
function blockBoot(items, stat, keyFn, seed) { const grp = new Map(); for (const x of items) { const k = keyFn(x); (grp.get(k) || grp.set(k, []).get(k)).push(x); } const keys = [...grp.keys()], rng = mulberry32(hashSeed(seed)), d = []; for (let it = 0; it < ITERS; it++) { const pool = []; for (let k = 0; k < keys.length; k++) pool.push(...grp.get(keys[Math.floor(rng() * keys.length)])); const v = stat(pool); if (Number.isFinite(v)) d.push(v); } return { lo: qnt(d, 0.025), hi: qnt(d, 0.975) }; }
const dcount = (x) => new Set(x.map((e) => e.day)).size;
const ex = (e) => (e.ret[60] != null && e.ctl && e.ctl[60] != null ? e.ret[60] - e.ctl[60] : null);

// ---- volume features (strictly before the entry bar) ----
function volumeIndex(B) {
  const days = [...new Set(B.TD)].sort(), idx = new Map(days.map((d, i) => [d, i])), P = days.map(() => new Float64Array(1441));
  const off = (ts) => (clock(ts) - 1080 + 1440) % 1440, raw = days.map(() => new Float64Array(1440));
  for (let i = 0; i < B.n; i++) raw[idx.get(B.TD[i])][off(B.T[i])] += B.V[i] || 0;
  raw.forEach((r, k) => { for (let m = 0; m < 1440; m++) P[k][m + 1] = P[k][m] + r[m]; });
  const win = (k, a, b) => P[k][b + 1] - P[k][Math.max(0, a)];
  return { days, idx, off, win };
}
function relVol(VI, day, a, b) { const k = VI.idx.get(day); if (k === undefined || k < 20) return null; const base = []; for (let j = k - 20; j < k; j++) { const v = VI.win(j, a, b); if (v > 0) base.push(v); } const m = mean(base); return base.length >= 10 && m > 0 ? VI.win(k, a, b) / m : null; }
function volRank(B, day) { const ds = B.days, i = ds.indexOf(day); if (i < 250) return null; const cur = B.A15[day]; const prior = ds.slice(i - 250, i).map((d) => B.A15[d]).filter((x) => x != null); return prior.length >= 200 && cur != null ? prior.filter((x) => x < cur).length / prior.length : null; }

function cellStats(rows, outcome, label) {
  const days = dcount(rows);
  if (outcome === 'E2') {
    const S = new Map(); for (const e of rows) (S.get(e.stratum) || S.set(e.stratum, { a: 0, d: 0 }).get(e.stratum))[e.agree ? 'a' : 'd']++;
    const u = rows.filter((e) => { const s = S.get(e.stratum); return s.a >= 2 && s.d >= 2; }), dis = u.filter((e) => !e.agree).length, ud = dcount(u);
    if (ud < MIN_DAYS || dis < MIN_DIS) return { n: u.length, days: ud, dis, under: true };
    const st = (z) => strat(z, (e) => e.agree, (e) => e.ret[60]); return { n: u.length, days: ud, dis, est: st(u), ci: blockBoot(u, st, (e) => e.seq, label) };
  }
  const u = rows.filter((e) => ex(e) !== null), ud = dcount(u);
  if (ud < MIN_DAYS) return { n: u.length, days: ud, under: true };
  const st = (z) => mean(z.map(ex)); return { n: u.length, days: ud, est: st(u), ci: blockBoot(u, st, (e) => e.seq, label) };
}

async function main() {
  const dump = JSON.parse(fs.readFileSync(new URL('../scratch/floor_entry_events_20261026_m0.25.json', import.meta.url)));
  const NQ = prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2023-03-06', dump.endRow)), VI = volumeIndex(NQ), emap = new Map(NQ.T.map((t, i) => [t, i]));
  console.log(`events dump end date ${dump.endRow}; NQ bars ${NQ.n}`);
  const out = { endRow: dump.endRow, sides: {} };
  let tested = 0, cands = 0, confirmed = 0, underpoweredHold = 0;
  for (const side of ['long', 'mirror']) {
    const rows = dump[side].filter((e) => e.ret[60] != null);
    for (const e of rows) { const jf = emap.get(e.fireTs); const off = VI.off(e.fireTs); e.rvol = jf === undefined ? null : relVol(VI, e.day, off - 14, off); e.svol = relVol(VI, e.day, e.sess === 'RTH' ? 930 : 0, off); e.volr = volRank(NQ, e.day); e.onvol = e.sess === 'RTH' ? relVol(VI, e.day, 0, 929) : null; }
    const days = [...new Set(rows.map((e) => e.day))].sort(), cut = days[Math.floor(days.length * 0.6) - 1], isEx = (e) => e.day <= cut;
    const terc = (key) => { const v = rows.filter((e) => isEx(e) && e[key] != null).map((e) => e[key]); return [qnt(v, 0.5)]; };   // Amendment 1: median split (low/high)
    const cuts = { rvol: terc('rvol'), svol: terc('svol'), volr: terc('volr'), onvol: terc('onvol') };
    const lvl = (e, key) => (e[key] == null ? null : e[key] <= cuts[key][0] ? 'low' : 'high');
    console.log(`\n##### ${side.toUpperCase()}: ${rows.length} events on ${days.length} days, explore <= ${cut}; tercile cuts ${JSON.stringify(cuts)}`);
    const chk = { E2: cellStats(rows, 'E2', side + 'chkE2'), E1a: cellStats(rows, 'E1a', side + 'chkE1a') };
    console.log(`  CHECK all events: E2 ${f3(chk.E2.est)} [${f3(chk.E2.ci?.lo)},${f3(chk.E2.ci?.hi)}]  E1a ${f3(chk.E1a.est)} [${f3(chk.E1a.ci?.lo)},${f3(chk.E1a.ci?.hi)}]  (parent printed long: E2 +0.507 / E1a -0.022; mirror: E2 +0.257 / E1a -0.052; this pooled-period CI uses the same blocks)`);
    const cells = [['session', 'RTH', (e) => e.sess === 'RTH'], ['session', 'GLOBEX', (e) => e.sess === 'GLOBEX']];   // session is DESCRIPTIVE (Amendment 1): printed, never counted or confirmed
    for (const [key, name] of [['rvol', 'relVol15'], ['svol', 'sessionVol'], ['volr', 'volRegime']]) for (const L of ['low', 'high']) cells.push([name, L, (e) => lvl(e, key) === L]);
    out.sides[side] = { cuts, cells: [] };
    console.log('  context        level   outcome | explore n/days (dis)  est [CI]             | hold-out n/days (dis) est [CI]            | verdict');
    for (const [cname, L, f] of cells) for (const oc of ['E2', 'E1a']) {
      const ex0 = cellStats(rows.filter((e) => isEx(e) && f(e)), oc, `${side}${cname}${L}${oc}ex`), ho = cellStats(rows.filter((e) => !isEx(e) && f(e)), oc, `${side}${cname}${L}${oc}ho`);
      let verdict = 'not tested (explore underpowered)';
      const desc = cname === 'session'; if (!ex0.under) { if (!desc) tested++; const cand = ex0.ci.lo > 0; if (cand && !desc) cands++; verdict = desc ? `descriptive only (session)` : !cand ? 'no' : ho.under ? 'CANDIDATE, hold-out UNDERPOWERED' : (ho.est > 0 && ho.ci.lo > 0 && ex0.est > 0 ? 'CONFIRMED' + (oc === 'E1a' ? ' (E1a: entry-worthwhile question, NOT an ES claim)' : '') : 'candidate, NOT confirmed'); if (verdict.startsWith('CONFIRMED') && !desc) confirmed++; if (verdict.includes('UNDERPOWERED') && !desc) underpoweredHold++; }
      const fm = (c) => (c.under ? `${c.n}/${c.days}d${c.dis != null ? ` (${c.dis})` : ''} UNDERPOWERED` : `${c.n}/${c.days}d${c.dis != null ? ` (${c.dis})` : ''} ${f3(c.est)} [${f3(c.ci.lo)},${f3(c.ci.hi)}]`);
      console.log(`  ${cname.padEnd(13)} ${L.padEnd(7)} ${oc.padEnd(4)} | ${fm(ex0).padEnd(44)} | ${fm(ho).padEnd(44)} | ${verdict}`);
      out.sides[side].cells.push({ cname, L, oc, ex: ex0, ho, verdict });
    }
    // descriptive only (not in the 44): the user's overnight-volume idea for RTH entries
    for (const L of ['low', 'high']) { const r = rows.filter((e) => e.sess === 'RTH' && lvl(e, 'onvol') === L); console.log(`  [descriptive, not counted] prior-Globex volume ${L} (RTH entries): n=${r.length}/${dcount(r)}d mean ret60 ${f3(mean(r.map((e) => e.ret[60])))} E2 ${f3(strat(r, (e) => e.agree, (e) => e.ret[60]))}`); }
  }
  out.counts = { tested, candidates: cands, expectedByChance: +(tested * 0.025).toFixed(1), confirmed, candidatesWithUnderpoweredHoldout: underpoweredHold };
  console.log(`\nCELLS TESTED ${tested} (of 24 counted), CANDIDATES ${cands}, expected candidates by chance about ${(tested * 0.025).toFixed(1)}, CONFIRMED ${confirmed}, candidates whose hold-out was underpowered ${underpoweredHold}`);
  fs.writeFileSync('scratch/floor_context_narrowing_20261026.json', JSON.stringify(out, null, 1));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
