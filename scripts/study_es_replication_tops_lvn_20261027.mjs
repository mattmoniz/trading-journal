// Pre-registered in docs/ES_REPLICATION_TOPS_LVN_PREREG_20261027.md + Amendment 1 (committed before this ran). Run ONCE. The NQ rule is frozen; only the instrument changes.
import fs from 'fs';
import { query } from '../server/db.js';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { loadBars, prep, indexBars, clock, mean } from './lib/floorEngine.mjs';
import { f3 } from './lib/floorStats.mjs';
import { build4h, k1Events, d20Of, pinnedLimit } from './lib/fourHourLevels.mjs';
import { multiScaleEvents } from './lib/multiScaleRuns.mjs';
import { PTV, makeSim, blindDraws, poolDraws, median, dc, ci, fmt } from './lib/exitSim.mjs';
const ES_COST = 0.4, ARM = { hold: 2880, lenient: true }, STOP_MULT = 0.5, LVN_N = 3, ALPHA2 = 0.05 / 2 / 2, meta = JSON.parse(fs.readFileSync('scratch/es_meta_20261027.json'));
async function main() {
  const endRow = process.env.STUDY_END || (await query(`SELECT (MAX(ts)::date - 3)::text d FROM price_bars_es_front`)).rows[0].d;
  const ES = indexBars(prep(await loadBars('price_bars_es_front', `1=1`, '2023-02-24', endRow))), d20 = d20Of(ES), { bars, h4 } = build4h(ES), LIM = pinnedLimit(ES, endRow), { run, capOf } = makeSim(ES, ES_COST);
  // ---- data-quality exclusion (prereg Amendment 1): session volume < 20 percent of the median of the preceding 60 dates
  const dates = Object.keys(meta.vol).sort(), excluded = new Set(); const vols = dates.map((d) => meta.vol[d].v);
  dates.forEach((d, i) => { const prev = vols.slice(Math.max(0, i - 60), i); if (prev.length < 20) { if (vols[i] < 0.2 * median(vols.slice(0, Math.max(20, i + 1)))) excluded.add(d); return; } if (vols[i] < 0.2 * median(prev)) excluded.add(d); });
  const rollNear = (day) => meta.roll.some((r) => Math.abs((new Date(day) - new Date(r)) / 864e5) <= 7);
  const vap = new Map(); for (const f of fs.readdirSync('scratch/vap_daily_es').filter((x) => x.endsWith('.tsv'))) { const m = new Map(); for (const l of fs.readFileSync('scratch/vap_daily_es/' + f, 'utf8').split('\n')) { if (!l) continue; const [p, v] = l.split('\t'); m.set(Math.round(+p * 4), +v); } vap.set(f.slice(0, 10), m); }
  const valleyCache = new Map(), validDates = dates.filter((d) => !excluded.has(d));
  const valleys = (day, H4) => { const key = day + '|' + H4; if (valleyCache.has(key)) return valleyCache.get(key); let lo = 0, hi = validDates.length; while (lo < hi) { const m = (lo + hi) >> 1; if (validDates[m] < day) lo = m + 1; else hi = m; } const prior = validDates.slice(Math.max(0, lo - 20), lo), have = prior.filter((d) => vap.has(d)); let res = null;
    if (prior.length === 20 && have.length >= 17 && new Set(prior.map((d) => meta.contract[d])).size === 1) { const bw = Math.max(0.25, Math.round((0.1 * H4) / 0.25) * 0.25), acc = new Map(); let mn = Infinity, mx = -Infinity; for (const d of have) for (const [k, v] of vap.get(d)) { const b = Math.floor(k / 4 / bw); acc.set(b, (acc.get(b) || 0) + v); mn = Math.min(mn, b); mx = Math.max(mx, b); }
      const n = mx - mn + 1, raw = new Array(n).fill(0); for (const [b, v] of acc) raw[b - mn] = v; const out = []; for (let i = LVN_N; i < n - LVN_N; i++) { let ok = true; for (let k = 1; k <= LVN_N && ok; k++) if (!(raw[i + k] > raw[i]) || !(raw[i - k] >= raw[i])) ok = false; if (ok) out.push({ price: (mn + i + 0.5) * bw, vol: raw[i] }); } res = { valleys: out }; }
    valleyCache.set(key, res); return res; };
  const targets = {
    DEEP: (e, entry, R) => { const v = valleys(e.day, e.H4); if (!v) return null; const c = v.valleys.filter((x) => (x.price - entry) * e.dir >= R && (x.price - entry) * e.dir <= 6 * R); if (!c.length) return null; c.sort((a, b) => a.vol - b.vol); return { price: c[0].price }; },
    NEXT: (e, entry, R) => { const v = valleys(e.day, e.H4); if (!v) return null; const c = v.valleys.filter((x) => (x.price - entry) * e.dir >= R && (x.price - entry) * e.dir <= 6 * R); if (!c.length) return null; c.sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry)); return { price: c[0].price }; },
    R3: (e, entry, R) => ({ price: entry + e.dir * 3 * R }) };
  let events = multiScaleEvents(ES, h4, { limit: LIM }); const before = events.length; events = events.filter((e) => !excluded.has(e.day) && !rollNear(e.day));
  console.log(`ES to ${endRow}; dates excluded for thin volume ${excluded.size} (${[...excluded].slice(0, 6).join(', ')}...); merged events ${before}, after dropping thin-volume dates and +/-7 days around ${meta.roll.length} contract rolls ${events.length} (floors ${events.filter((e) => e.side === 'floor').length}, tops ${events.filter((e) => e.side === 'top').length})`);
  const rng = mulberry32(hashSeed('es-replication')), samp = []; for (let i = 3100; i < LIM - 3000; i += 15) if (d20[ES.TD[i]] && !excluded.has(ES.TD[i]) && !rollNear(ES.TD[i])) samp.push(i);
  const okDay = (p, day) => !excluded.has(day) && !rollNear(day);
  const k1 = k1Events(ES, bars, h4, d20, 0.25, LIM).filter((k) => okDay(0, k.day)), k1By = new Map(); for (const k of k1) (k1By.get(k.side) || k1By.set(k.side, []).get(k.side)).push(k);
  function evaluate(tkey) {
    const out = [], skip = {};
    for (const e0 of events) { const e = { ...e0, part: 'A' }; const entry = ES.O[e.i0], stopPrice = e.extreme - e.dir * STOP_MULT * e.H4, R = e.dir > 0 ? entry - stopPrice : stopPrice - entry; if (!(R > 0.5)) { skip.stopDegenerate = (skip.stopDegenerate || 0) + 1; continue; }
      if (capOf(e.i0, 2880, true) === undefined) { skip.noExit = (skip.noExit || 0) + 1; continue; } const tg = targets[tkey](e, entry, R); if (!tg) { skip.noTarget = (skip.noTarget || 0) + 1; continue; } const tgtPts = Math.abs(tg.price - entry); if (!(tgtPts > 0.5)) { skip.degenerate = (skip.degenerate || 0) + 1; continue; }
      const real = run(e.i0, e.dir, R, tgtPts, ARM); if (!real) { skip.noRun = (skip.noRun || 0) + 1; continue; } const mir = run(e.i0, -e.dir, R, tgtPts, ARM), ctl = blindDraws(ES, samp, rng, e, okDay).map((i) => run(i, e.dir, R, tgtPts, ARM)).filter(Boolean).map((x) => x.pnl);
      const ecl = clock(ES.T[e.i0]), pool = (k1By.get(e.side) || []).filter((k) => k.day !== e.day && Math.abs(k.clk - ecl) <= 30), fr = poolDraws(rng, pool).map((k) => run(k.i0, e.dir, R, tgtPts, ARM)).filter(Boolean).map((x) => x.pnl);
      out.push({ ...e, pnl: real.pnl, res: real.res, mirror: mir ? mir.pnl : null, ctl: ctl.length >= 5 ? mean(ctl) : null, fresh: fr.length >= 5 ? mean(fr) : null, R, tgtR: tgtPts / R }); }
    return { out, skip };
  }
  const ex = (z, k = 'ctl') => z.filter((e) => e.pnl != null && e[k] != null).map((e) => ({ day: e.day, v: e.pnl - e[k] }));
  const top5 = (vals) => { const tot = vals.reduce((s, x) => s + x, 0); return tot > 0 ? (vals.slice().sort((a, b) => b - a).slice(0, 5).reduce((s, x) => s + x, 0) / tot).toFixed(2) : 'n/a (total<=0)'; };
  const R = {}; for (const t of ['DEEP', 'NEXT', 'R3']) R[t] = evaluate(t); for (const t of ['DEEP', 'NEXT', 'R3']) console.log(`target ${t}: events used ${R[t].out.length} of ${events.length}; skipped ${JSON.stringify(R[t].skip)}`);
  const NQRES = { DEEP: 'NQ non-overlapping subset +32.7 [+8.0,+57.8]; NQ all-dates tops +15.8 [-2.4,+33.7]', NEXT: 'NQ non-overlapping subset +20.0 [+1.3,+40.0]; NQ all-dates tops +8.7 [-5.3,+23.2]' };
  console.log(`\nCOUNTED CELLS (ES tops, frozen NQ rule; 2 cells, 97.5 percent CI): REPLICATES = EXCESS vs blind CI lower bound above 0 AND absolute net above 0 AND EXCESS-FRESH point above 0`);
  const verdicts = [];
  for (const t of ['DEEP', 'NEXT']) { const evs = R[t].out.filter((e) => e.side === 'top'), S = ex(evs), F = ex(evs, 'fresh'), res = evs.map((e) => e.res), shr = (c) => (100 * res.filter((x) => x === c).length / Math.max(1, res.length)).toFixed(0), c = S.length >= 5 ? ci(S, ALPHA2, 'es' + t) : { lo: NaN, hi: NaN }, absMean = mean(evs.map((e) => e.pnl)), fMean = F.length ? mean(F.map((x) => x.v)) : NaN;
    const rep = c.lo > 0 && absMean > 0 && fMean > 0; verdicts.push(rep);
    console.log(`\nES TOPS ${t} LVN: n ${evs.length} on ${dc(evs)} dates; net per trade mean ${f3(absMean)} pts (${f3(absMean * 50)} dollars per ES contract before commission), median ${f3(median(evs.map((e) => e.pnl)))}; stopped ${shr('S')}%, target ${shr('T')}%, time ${shr('C')}%; top-5-trade share ${top5(evs.map((e) => e.pnl))}`);
    console.log(`  EXCESS vs blind ${fmt(mean(S.map((x) => x.v)), c)} (97.5% CI; half-width ${f3((c.hi - c.lo) / 2)}) | EXCESS-FRESH ${F.length >= 5 ? fmt(mean(F.map((x) => x.v)), ci(F, 0.025, 'esf' + t)) : 'n/a'} (n ${F.length}) | real minus MIRROR ${(() => { const m = evs.filter((e) => e.mirror != null).map((e) => ({ day: e.day, v: e.pnl - e.mirror })); return m.length >= 5 ? fmt(mean(m.map((x) => x.v)), ci(m, 0.025, 'esm' + t)) : 'n/a'; })()}`);
    const sorted = evs.filter((e) => e.ctl != null).sort((a, b) => a.i0 - b.i0); let last = -Infinity; const sub = []; for (const e of sorted) if (ES.EM[e.i0] - last >= 2880) { sub.push(e); last = ES.EM[e.i0]; } const s2 = ex(sub); console.log(`  non-overlapping subset: ${sub.length} of ${sorted.length}, mean net ${f3(mean(sub.map((e) => e.pnl)))}, EXCESS ${s2.length >= 5 ? fmt(mean(s2.map((x) => x.v)), ci(s2, 0.025, 'esn' + t)) : 'n/a'}`);
    console.log(`  context: ${NQRES[t]}\n  => ${rep ? 'REPLICATES' : 'DOES NOT REPLICATE'}`); }
  console.log(`\nDESCRIPTIVE`);
  for (const t of ['DEEP', 'NEXT', 'R3']) for (const side of ['floor', 'top']) { const z = R[t].out.filter((e) => e.side === side && e.ctl != null), s = ex(z); if (z.length >= 5) console.log(`  ${t} ${side}: n ${z.length} mean net ${f3(mean(z.map((e) => e.pnl)))} EXCESS ${fmt(mean(s.map((x) => x.v)), ci(s, 0.025, 'd' + t + side))}`); }
  for (const sc of [60, 120, 240]) { const z = R.DEEP.out.filter((e) => e.side === 'top' && e.scale === sc && e.ctl != null), s = ex(z); if (z.length >= 5) console.log(`  DEEP tops first fired at ${sc}m: n ${z.length} mean net ${f3(mean(z.map((e) => e.pnl)))} EXCESS ${fmt(mean(s.map((x) => x.v)), ci(s, 0.025, 'sc' + sc))}`); }
  // overlap with NQ top-event dates (independence context)
  const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2023-03-06', endRow))), nq = build4h(NQ), nqEv = multiScaleEvents(NQ, nq.h4, { limit: pinnedLimit(NQ, endRow) }).filter((e) => e.side === 'top'), nqDays = new Set(nqEv.map((e) => e.day)), esTop = R.DEEP.out.filter((e) => e.side === 'top');
  console.log(`  ES top events (DEEP arm) on a trade date that also has an NQ top event: ${(100 * esTop.filter((e) => nqDays.has(e.day)).length / Math.max(1, esTop.length)).toFixed(0)}% of ${esTop.length}; NQ top event dates ${nqDays.size}`);
  console.log(`\nVERDICT: ${verdicts.every(Boolean) ? 'BOTH CELLS REPLICATE' : verdicts.some(Boolean) ? 'ONE CELL REPLICATES' : 'NEITHER CELL REPLICATES'}`);
  fs.writeFileSync('scratch/es_replication_20261027.json', JSON.stringify({ endRow, verdicts, events: events.length }));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
