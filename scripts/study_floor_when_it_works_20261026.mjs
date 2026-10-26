// Pre-registered in docs/FLOOR_WHEN_IT_WORKS_ANATOMY_PREREG_20261026.md (committed before this ran; read its Amendment if present). Same explore (earlier 60 percent of dates)
// / hold-out screen and CANDIDATE/CONFIRMED rule as the context study. Outcome E1a = ret60 of the NQ-fire entry minus its delay-matched blind control, A15 units.
import fs from 'fs';
import { mean, clock, loadBars, prep, neg, findEvents, loadLevels, FAMS } from './lib/floorEngine.mjs';
import { MIN_DAYS, MIN_DIS, f3, qnt, blockBoot, dcount, ex, strat } from './lib/floorStats.mjs';

const wd = (ts) => new Date(Date.UTC(+ts.slice(0, 4), +ts.slice(5, 7) - 1, +ts.slice(8, 10))).getUTCDay();
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const tod = (ts) => { const c = clock(ts); return c >= 1080 ? '1 Globex evening 18-24' : c < 570 ? '2 Overnight 00-09:30' : c < 660 ? '3 RTH open 9:30-11' : c < 840 ? '4 Midday 11-14' : c < 960 ? '5 Afternoon 14-16' : '6 other'; };
const epoch = (ts) => Date.UTC(+ts.slice(0, 4), +ts.slice(5, 7) - 1, +ts.slice(8, 10), +ts.slice(11, 13), +ts.slice(14, 16)) / 60000;

const rawEx = (e) => (e.ret[60] != null && e.bs && e.bs[60] != null && !Number.isNaN(e.bs[60]) ? e.ret[60] - e.bs[60] : null);
function cell(rows, label) {
  const u = rows.filter((e) => ex(e) !== null), d = dcount(u);
  if (d < MIN_DAYS) return { n: u.length, days: d, under: true };
  const st = (z) => mean(z.map(ex)), rw = rows.filter((e) => rawEx(e) !== null), sr = (z) => mean(z.map(rawEx));
  return { n: u.length, days: d, est: st(u), ci: blockBoot(u, st, (e) => e.seq, label), raw: sr(rw), rawCi: blockBoot(rw, sr, (e) => e.seq, label + 'raw') };
}
// synchrony: correlation of NQ and ES one-minute returns over the 30 minutes ending at the fire bar (>= 24 paired minutes)
function synchrony(NQ, esClose, j) { const a = [], b = []; for (let t = j - 29; t <= j; t++) { if (t < 1) continue; const n1 = NQ.C[t], n0 = NQ.C[t - 1], e1 = esClose.get(NQ.T[t]), e0 = esClose.get(NQ.T[t - 1]); if (e1 === undefined || e0 === undefined) continue; a.push(n1 - n0); b.push(e1 - e0); } if (a.length < 24) return null; const ma = mean(a), mb = mean(b); let sab = 0, saa = 0, sbb = 0; for (let k = 0; k < a.length; k++) { sab += (a[k] - ma) * (b[k] - mb); saa += (a[k] - ma) ** 2; sbb += (b[k] - mb) ** 2; } return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null; }

async function main() {
  const dump = JSON.parse(fs.readFileSync(new URL('../scratch/floor_entry_events_20261026_m0.25.json', import.meta.url)));
  const NQ = prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2023-03-06', dump.endRow)), NQn = neg(NQ), lv = await loadLevels();
  const emap = new Map(NQ.T.map((t, i) => [t, i])); const ESb = await loadBars('price_bars_es_front', '1=1', '2023-03-06', dump.endRow), esClose = new Map(ESb.T.map((t, i) => [t, ESb.C[i]]));
  console.log(`events dump end date ${dump.endRow}`);
  const out = { sides: {} }; let tested = 0, cands = 0, confirmed = 0;
  for (const side of ['long', 'mirror']) {
    const B = side === 'long' ? NQ : NQn, mirror = side === 'mirror';
    const info = new Map(); for (const f of FAMS) for (const e of findEvents(B, f, lv(f, mirror), 1, 1)) info.set(`${f}|${e.i}|${e.arm}`, e);
    const rows = dump[side].filter((e) => e.ret[60] != null).map((e) => ({ ...e }));
    let miss = 0;
    for (const e of rows) {
      const ev = info.get(`${e.fam}|${e.i}|${e.arm}`), j = emap.get(e.fireTs); if (!ev || j === undefined) { miss++; continue; }
      const a = ev.a; let lo = Infinity; for (let k = ev.i; k <= j; k++) lo = Math.min(lo, B.L[k]);
      e.depth = (ev.val - lo) / a; let hi = -Infinity; for (let k = Math.max(0, ev.i - 60); k < ev.i; k++) hi = Math.max(hi, B.H[k]); e.appr = (hi - B.L[ev.i]) / a;
      if (ev.prevLow != null) { e.higherLow = ev.approachLow >= ev.prevLow ? 'higher-or-equal low (held)' : 'undercut'; e.since = epoch(B.T[ev.i]) - epoch(B.T[ev.lastEnd]); }
      e.dow = DOW[wd(e.ts)]; e.tod = tod(e.ts); e.sync = synchrony(NQ, esClose, j);
    }
    { const sv = rows.map((e) => e.sync).filter((x) => x != null); console.log(`  SYNCHRONY (30m NQ-ES return correlation at the fire bar): n=${sv.length} of ${rows.length}, quartiles ${[0.25, 0.5, 0.75].map((q) => qnt(sv, q).toFixed(2)).join(' / ')}, share below 0.5: ${(100 * sv.filter((x) => x < 0.5).length / sv.length).toFixed(0)}%, below 0.3: ${(100 * sv.filter((x) => x < 0.3).length / sv.length).toFixed(0)}%`); }
    const days = [...new Set(rows.map((e) => e.day))].sort(), cutDay = days[Math.floor(days.length * 0.6) - 1], isEx = (e) => e.day <= cutDay;
    const med = (key) => qnt(rows.filter((e) => isEx(e) && e[key] != null).map((e) => e[key]), 0.5), cuts = { depth: med('depth'), appr: med('appr'), since: med('since'), sync: med('sync') };
    console.log(`\n##### ${side.toUpperCase()}: ${rows.length} events (${miss} unmatched), ${days.length} days, explore <= ${cutDay}; median cuts ${JSON.stringify(cuts)}`);
    const cells = [];
    for (const d of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri']) cells.push(['dayOfWeek', d, (e) => e.dow === d, true]);
    for (const t of ['1 Globex evening 18-24', '2 Overnight 00-09:30', '3 RTH open 9:30-11', '4 Midday 11-14', '5 Afternoon 14-16']) cells.push(['timeOfDay', t, (e) => e.tod === t, true]);
    for (const arm of ['K2', 'K3P']) for (const h of ['higher-or-equal low (held)', 'undercut']) cells.push([`retest ${arm}`, h, (e) => e.arm === arm && e.higherLow === h, 'desc']);
    for (const [key, name] of [['depth', 'depth'], ['appr', 'approachDrop'], ['since', 'sinceLastTest (K>=2)'], ['sync', 'SYNCHRONY NQ-ES 30m']]) for (const L of ['low', 'high']) cells.push([name, L, (e) => e[key] != null && (L === 'low' ? e[key] <= cuts[key] : e[key] > cuts[key]), false]);
    console.log('  feature              level                    | explore n/days  E1a est [CI]            | hold-out n/days  est [CI]             | verdict');
    out.sides[side] = [];
    for (const [name, L, f, calendar] of cells) {
      const a = cell(rows.filter((e) => isEx(e) && f(e)), `${side}${name}${L}ex`), b = cell(rows.filter((e) => !isEx(e) && f(e)), `${side}${name}${L}ho`);
      let v = 'not tested (explore underpowered)';
      const descOnly = calendar === true || calendar === 'desc';
      if (!a.under) { if (!descOnly) tested++; const cand = a.ci.lo > 0; if (cand && !descOnly) cands++; v = descOnly ? (calendar === true ? 'descriptive (calendar)' : 'descriptive (retest, by K arm)') : !cand ? 'no' : b.under ? 'CANDIDATE, hold-out UNDERPOWERED' : (b.est > 0 && b.ci.lo > 0 && a.est > 0 ? 'CONFIRMED (screening survivor)' + (b.raw > 0 && b.rawCi.lo > 0 ? ', raw also positive' : ', RELATIVE ONLY (raw not positive)') : 'candidate, NOT confirmed'); if (v.startsWith('CONFIRMED')) confirmed++; }
      const fm = (c) => (c.under ? `${c.n}/${c.days}d UNDERPOWERED` : `${c.n}/${c.days}d ${f3(c.est)} [${f3(c.ci.lo)},${f3(c.ci.hi)}] raw ${f3(c.raw)}`);
      console.log(`  ${name.padEnd(20)} ${L.padEnd(26)} | ${fm(a).padEnd(50)} | ${fm(b).padEnd(50)} | ${v}`);
      out.sides[side].push({ name, L, ex: a, ho: b, v });
    }
    for (const L of ['low', 'high']) { const r = rows.filter((e) => e.sync != null && (L === 'low' ? e.sync <= cuts.sync : e.sync > cuts.sync)); console.log(`  [descriptive] E2 (ES agree minus not, within strata) when synchrony ${L.toUpperCase()}: n=${r.length}/${dcount(r)}d  ${f3(strat(r, (e) => e.agree, (e) => e.ret[60]))}  | mean raw ret60 minus unconditional ${f3(mean(r.filter((e) => rawEx(e) !== null).map(rawEx)))}`); }
    // descriptive anatomy (explore period only): share of each level among the top-quartile ret60 events vs the rest
    const exr = rows.filter((e) => isEx(e)), q75 = qnt(exr.map((e) => e.ret[60]), 0.75), top = exr.filter((e) => e.ret[60] >= q75), rest = exr.filter((e) => e.ret[60] < q75);
    console.log(`  [descriptive anatomy, explore only; top quartile of ret60 (>= ${q75.toFixed(2)} A15) n=${top.length} vs rest n=${rest.length}; no verdict]`);
    for (const key of ['dow', 'tod', 'higherLow']) { const lv0 = [...new Set(exr.map((e) => e[key]).filter(Boolean))].sort(); console.log('   ' + key.padEnd(10) + lv0.map((L) => `${L}: ${(100 * top.filter((e) => e[key] === L).length / top.length).toFixed(0)}% vs ${(100 * rest.filter((e) => e[key] === L).length / rest.length).toFixed(0)}%`).join(' | ')); }
  }
  console.log(`\nCELLS TESTED ${tested} (of 20 counted), CANDIDATES ${cands}, expected by chance about ${(tested * 0.025).toFixed(1)}, CONFIRMED ${confirmed}`);
  out.counts = { tested, candidates: cands, confirmed }; fs.writeFileSync('scratch/floor_when_it_works_20261026.json', JSON.stringify(out, null, 1));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
