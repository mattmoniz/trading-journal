// Pre-registered in docs/MULTISCALE_RUN_POC_LVN_TARGETS_PREREG_20261026.md (committed before this ran). Run ONCE; nothing here was tuned on outcomes.
// Events: scripts/lib/multiScaleRuns.mjs (sequential defended runs at 60/120/240-minute bars, one per episode). Trade: entry next open, stop 0.5 x H4 beyond the run extreme, 2,879-minute cap, realistic fills, cost 1.5.
// Targets: POC (nearest POC period line >= 1R away), DEEPEST LVN and NEXT LVN (valleys of the 20-day composite all-session volume-at-price, 1R..6R away). EXCESS vs blind same-clock entries and vs fresh-extreme births.
import fs from 'fs';
import { query } from '../server/db.js';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { loadBars, prep, indexBars, clock, mean, addDay } from './lib/floorEngine.mjs';
import { f3 } from './lib/floorStats.mjs';
import { build4h, k1Events, d20Of, pinnedLimit } from './lib/fourHourLevels.mjs';
import { multiScaleEvents } from './lib/multiScaleRuns.mjs';
import { COST, PTV, makeSim, blindDraws, poolDraws, median, dc, ci, diffCI, fmt, dropTopDate } from './lib/exitSim.mjs';
const ARM = { hold: 2880, lenient: true }, STOP_MULT = 0.5, ALPHA6 = 0.05 / 6 / 2, LVN_N = 3;
async function main() {
  const endRow = (await query(`SELECT (MAX(ts)::date - 3)::text d FROM price_bars_primary WHERE symbol='NQ' AND ts >= CURRENT_DATE - 7 AND ts < CURRENT_DATE + 1`)).rows[0].d;
  const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2023-03-06', endRow))), d20 = d20Of(NQ), { bars, h4 } = build4h(NQ), LIM = pinnedLimit(NQ, endRow), { run, capOf } = makeSim(NQ);
  const events = multiScaleEvents(NQ, h4, { limit: LIM }), linesBy = JSON.parse(fs.readFileSync('scratch/defended_lines_by_date_20261026.json'));
  const rthDays = (await query(`SELECT DISTINCT ts::date::text d FROM price_bars_primary WHERE symbol='NQ' AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959 ORDER BY 1`)).rows.map((r) => r.d);
  const vap = new Map(); for (const r of (await query(`SELECT trade_date::text d, (price*4)::int k, vol_all v FROM volume_at_price_daily WHERE vol_all > 0`)).rows) { let m = vap.get(r.d); if (!m) vap.set(r.d, (m = new Map())); m.set(r.k, r.v); }
  const k1 = k1Events(NQ, bars, h4, d20, 0.25, LIM), k1By = new Map(); for (const k of k1) (k1By.get(k.side) || k1By.set(k.side, []).get(k.side)).push(k);
  // ---- LVN valleys of the 20-day composite (causal: the 20 trade dates before the event's trade date)
  const compCache = new Map();
  const valleys = (day, H4) => {
    const key = day + '|' + H4; if (compCache.has(key)) return compCache.get(key);
    let lo = 0, hi = rthDays.length; while (lo < hi) { const m = (lo + hi) >> 1; if (rthDays[m] < day) lo = m + 1; else hi = m; } const prior = rthDays.slice(Math.max(0, lo - 20), lo), have = prior.filter((d) => vap.has(d));
    let res = null;
    if (prior.length === 20 && have.length >= 17) {
      const bw = Math.max(0.25, Math.round((0.1 * H4) / 0.25) * 0.25), acc = new Map(); let mn = Infinity, mx = -Infinity;
      for (const d of have) for (const [k, v] of vap.get(d)) { const p = k / 4, b = Math.floor(p / bw); acc.set(b, (acc.get(b) || 0) + v); mn = Math.min(mn, b); mx = Math.max(mx, b); }
      const n = mx - mn + 1, raw = new Array(n).fill(0); for (const [b, v] of acc) raw[b - mn] = v; const out = [], outD = [], N = LVN_N;
      // Sierra Chart's own Volume by Price definition (docs: "A peak or valley is defined when a given volume bar has bars above that are ... greater than it (Valley) ... and volume bars below that are ... greater than or equal to it (Valley)", searched N bars above and below; profile edges excluded = "Include High/Low in Peaks and Valleys: No")
      for (let i = N; i < n - N; i++) { let ok = true; for (let k = 1; k <= N && ok; k++) if (!(raw[i + k] > raw[i]) || !(raw[i - k] >= raw[i])) ok = false; if (ok) { out.push({ price: (mn + i + 0.5) * bw, vol: raw[i] }); let lm = 0, rm = 0; for (let k = 1; k <= 2 * N; k++) { if (i - k >= 0) lm = Math.max(lm, raw[i - k]); if (i + k < n) rm = Math.max(rm, raw[i + k]); } if (raw[i] <= 0.7 * Math.min(lm, rm)) outD.push({ price: (mn + i + 0.5) * bw, vol: raw[i] }); } }
      res = { valleys: out, valleysD: outD, bw, days: have.length };
    }
    compCache.set(key, res); return res;
  };
  const pocNames = (day) => (linesBy[day] || []).filter(([n]) => n.endsWith('_POC'));
  // ---- targets
  const targets = {
    POC: (e, entry, R) => { const c = pocNames(e.day).map(([n, p]) => ({ n, p })).filter((x) => (x.p - entry) * e.dir >= R); if (!c.length) return null; c.sort((a, b) => Math.abs(a.p - entry) - Math.abs(b.p - entry)); return { price: c[0].p, tag: c[0].n.replace('_POC', '') }; },
    DEEP: (e, entry, R) => { const v = valleys(e.day, e.H4); if (!v) return null; const un = v.valleys.filter((x) => (x.price - entry) * e.dir >= R).sort((a, b) => a.vol - b.vol)[0]; e.deepUncappedR = un ? (un.price - entry) * e.dir / R : null; const c = v.valleys.filter((x) => (x.price - entry) * e.dir >= R && (x.price - entry) * e.dir <= 6 * R); if (!c.length) return null; c.sort((a, b) => a.vol - b.vol); return { price: c[0].price }; },
    NEXT: (e, entry, R) => { const v = valleys(e.day, e.H4); if (!v) return null; const c = v.valleys.filter((x) => (x.price - entry) * e.dir >= R && (x.price - entry) * e.dir <= 6 * R); if (!c.length) return null; c.sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry)); return { price: c[0].price }; },
    DEEPD: (e, entry, R) => { const v = valleys(e.day, e.H4); if (!v) return null; const c = v.valleysD.filter((x) => (x.price - entry) * e.dir >= R && (x.price - entry) * e.dir <= 6 * R); if (!c.length) return null; c.sort((a, b) => a.vol - b.vol); return { price: c[0].price }; },
    NEXTD: (e, entry, R) => { const v = valleys(e.day, e.H4); if (!v) return null; const c = v.valleysD.filter((x) => (x.price - entry) * e.dir >= R && (x.price - entry) * e.dir <= 6 * R); if (!c.length) return null; c.sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry)); return { price: c[0].price }; },
    R3: (e, entry, R) => ({ price: entry + e.dir * 3 * R }),
  };
  const allDays = [...new Set(events.filter((e) => capOf(e.i0, 2880, true) !== undefined).map((e) => e.day))].sort(), cut = allDays[Math.floor(allDays.length * 0.6) - 1], cutSafe = addDay(cut, -4);
  console.log(`NQ to ${endRow}; merged events ${events.length} (floors ${events.filter((e) => e.side === 'floor').length}, tops ${events.filter((e) => e.side === 'top').length}); explore/hold-out cut ${cut} (earlier 60 percent of ${allDays.length} event dates)`);
  const okDay = (p, day) => (p === 'A' ? day <= cutSafe : day > cut), rng = mulberry32(hashSeed('multiscale-poc-lvn')), samp = []; for (let i = 3100; i < LIM - 3000; i += 15) if (d20[NQ.TD[i]]) samp.push(i);
  const priorMove = (e) => { let ext = null, k = e.runStartI - 1; const t0 = NQ.EM[e.runStartI]; while (k >= 0 && t0 - NQ.EM[k] <= 4140) { ext = e.dir > 0 ? Math.max(ext ?? -Infinity, NQ.H[k]) : Math.min(ext ?? Infinity, NQ.L[k]); k--; } return ext == null ? null : (e.dir > 0 ? ext - e.extreme : e.extreme - ext) / e.H4; };
  function evaluate(tkey) {
    const out = [], skip = {};
    for (const e0 of events) {
      const e = { ...e0 }; const entry = NQ.O[e.i0], stopPrice = e.extreme - e.dir * STOP_MULT * e.H4, R = e.dir > 0 ? entry - stopPrice : stopPrice - entry; if (!(R > 1)) { skip.stopDegenerate = (skip.stopDegenerate || 0) + 1; continue; }
      const cap = capOf(e.i0, 2880, true); if (cap === undefined) { skip.noExit = (skip.noExit || 0) + 1; continue; }
      const tg = targets[tkey](e, entry, R); if (!tg) { skip.noTarget = (skip.noTarget || 0) + 1; continue; } const tgtPts = Math.abs(tg.price - entry); if (!(tgtPts > 1)) { skip.degenerate = (skip.degenerate || 0) + 1; continue; }
      e.part = e.day <= cut ? 'A' : 'H'; e.exitTD = NQ.TD[cap]; e.straddle = e.part === 'A' && e.exitTD > cut; e.R = R; e.tgtPts = tgtPts; e.tgtR = tgtPts / R; e.tag = tg.tag;
      const real = run(e.i0, e.dir, R, tgtPts, ARM); if (!real) { skip.noRun = (skip.noRun || 0) + 1; continue; }
      const mir = run(e.i0, -e.dir, R, tgtPts, ARM), ctl = blindDraws(NQ, samp, rng, e, okDay).map((i) => run(i, e.dir, R, tgtPts, ARM)).filter(Boolean).map((x) => x.pnl);
      const ecl = clock(NQ.T[e.i0]), pool = (k1By.get(e.side) || []).filter((k) => k.day !== e.day && okDay(e.part, k.day) && Math.abs(k.clk - ecl) <= 30), fr = poolDraws(rng, pool).map((k) => run(k.i0, e.dir, R, tgtPts, ARM)).filter(Boolean).map((x) => x.pnl);
      Object.assign(e, { pnl: real.pnl, res: real.res, mirror: mir ? mir.pnl : null, ctl: ctl.length >= 5 ? mean(ctl) : null, fresh: fr.length >= 5 ? mean(fr) : null, priorMove: priorMove(e), deepUncappedR: e.deepUncappedR ?? null, tag: tg.tag ?? null, coincide: tkey === 'DEEP' || tkey === 'NEXT' || tkey === 'DEEPD' || tkey === 'NEXTD' ? pocNames(e.day).some(([, p]) => Math.abs(p - tg.price) <= 0.5 * e.H4) : null }); out.push(e);
    }
    return { out, skip };
  }
  const ex = (z, k = 'ctl') => z.filter((e) => e.pnl != null && e[k] != null).map((e) => ({ day: e.day, v: e.pnl - e[k] }));
  const top5 = (vals) => { const tot = vals.reduce((s, x) => s + x, 0); return tot > 0 ? (vals.slice().sort((a, b) => b - a).slice(0, 5).reduce((s, x) => s + x, 0) / tot).toFixed(2) : 'n/a (total<=0)'; };
  const under = (z) => z.length < 30 || dc(z) < 20; let cands = 0, surv = 0, tested = 0;
  const cell = (nm, evs) => {
    const A = evs.filter((e) => e.part === 'A' && !e.straddle && e.ctl != null && e.fresh != null), H = evs.filter((e) => e.part === 'H' && e.ctl != null && e.fresh != null), res = evs.map((e) => e.res), shr = (c) => (100 * res.filter((x) => x === c).length / Math.max(1, res.length)).toFixed(0), S = ex(evs), mir = evs.filter((e) => e.mirror != null).map((e) => ({ day: e.day, v: e.pnl - e.mirror }));
    console.log(`\n${nm}: events with both controls ${evs.filter((e) => e.ctl != null && e.fresh != null).length} of ${evs.length}. n ${evs.length} on ${dc(evs)} dates. ABSOLUTE net per trade: mean ${f3(mean(evs.map((e) => e.pnl)))} pts (${f3(mean(evs.map((e) => e.pnl)) * PTV)} dollars), median ${f3(median(evs.map((e) => e.pnl)))}; stopped ${shr('S')}%, target ${shr('T')}%, time-exit ${shr('C')}%; worst ${f3(Math.min(...evs.map((e) => e.pnl)))}; top-5-trades share ${top5(evs.map((e) => e.pnl))}; target distance median ${f3(median(evs.map((e) => e.tgtR)))} R`);
    console.log(`  all dates: EXCESS vs blind ${S.length >= 5 ? fmt(mean(S.map((x) => x.v)), ci(S, 0.025, nm + 'all')) : 'n/a'} | EXCESS-FRESH ${(() => { const f = ex(evs, 'fresh'); return f.length >= 5 ? fmt(mean(f.map((x) => x.v)), ci(f, 0.025, nm + 'fr')) : 'n/a'; })()} | real minus MIRROR ${mir.length >= 5 ? fmt(mean(mir.map((x) => x.v)), ci(mir, 0.025, nm + 'mir')) : 'n/a'}`);
    let v = 'UNDERPOWERED (explore)', ea = `n=${A.length}/${dc(A)}d`, ha = `n=${H.length}/${dc(H)}d`;
    if (!under(A)) { tested++; const sa = ex(A), c = ci(sa, ALPHA6, nm + 'a'), fa = ex(A, 'fresh'), fmA = mean(fa.map((x) => x.v)); ea = `${fmt(mean(sa.map((x) => x.v)), c)} n=${A.length}/${dc(A)}d, FRESH ${f3(fmA)}, abs ${f3(mean(A.map((e) => e.pnl)))}, without top date ${f3(dropTopDate(sa))}`;
      const cand = c.lo > 0 && fmA > 0; if (cand) cands++; if (!cand) v = 'no'; else if (under(H)) v = 'CANDIDATE, hold-out UNDERPOWERED'; else { const sh = ex(H), ch = ci(sh, 0.05, nm + 'h'), fh = ex(H, 'fresh'); ha = `${fmt(mean(sh.map((x) => x.v)), ch)} n=${H.length}/${dc(H)}d, FRESH ${f3(mean(fh.map((x) => x.v)))}, abs ${f3(mean(H.map((e) => e.pnl)))}, without top date ${f3(dropTopDate(sh))}`;
        const ok = mean(sh.map((x) => x.v)) > 0 && ch.lo > 0 && mean(sa.map((x) => x.v)) > 0 && dropTopDate(sa) > 0 && dropTopDate(sh) > 0; if (!ok) v = 'candidate, not a survivor'; else { surv++; const loc = mean(fh.map((x) => x.v)) > 0; v = !loc ? 'SCREEN-SURVIVOR but level-location artifact' : mean(A.map((e) => e.pnl)) > 0 && mean(H.map((e) => e.pnl)) > 0 ? 'SCREEN-SURVIVOR and absolute net positive in both halves = usable lead' : 'SCREEN-SURVIVOR but absolute net not positive in both halves'; } } }
    console.log(`  explore ${ea}\n  hold-out ${ha}\n  => ${v}`);
  };
  console.log(`\nTRADE: entry next open, stop ${STOP_MULT} x H4 beyond the run extreme, time exit 2,879 min, cost ${COST} pts. 6 COUNTED CELLS (explore CI ${(100 * (1 - 2 * ALPHA6)).toFixed(2)} percent, explore EXCESS-FRESH above 0, hold-out one 95 percent test).`);
  const R = {}; for (const t of ['POC', 'DEEP', 'NEXT', 'DEEPD', 'NEXTD', 'R3']) R[t] = evaluate(t);
  for (const t of ['POC', 'DEEP', 'NEXT', 'DEEPD', 'NEXTD', 'R3']) console.log(`target ${t}: events used ${R[t].out.length} of ${events.length}; skipped ${JSON.stringify(R[t].skip)}`);
  const label = { POC: 'POC TARGET', DEEP: 'DEEPEST LVN TARGET', NEXT: 'NEXT LVN TARGET' };
  for (const t of ['POC', 'DEEP', 'NEXT']) for (const side of ['floor', 'top']) cell(`${label[t]} ${side.toUpperCase()}`, R[t].out.filter((e) => e.side === side));
  console.log(`\nTIER 1 CELLS TESTED ${tested} (of 6), CANDIDATES ${cands}, expected by chance about ${(tested * ALPHA6).toFixed(2)}, SCREEN-SURVIVORS ${surv}`);
  console.log('\nREFERENCE (descriptive): the SAME events with a fixed 3R target');
  for (const side of ['floor', 'top']) { const z = R.R3.out.filter((e) => e.side === side); if (z.length) console.log(`  3R ${side}: n ${z.length} mean net ${f3(mean(z.map((e) => e.pnl)))} EXCESS ${(() => { const s = ex(z); return s.length >= 5 ? fmt(mean(s.map((x) => x.v)), ci(s, 0.025, '3R' + side)) : 'n/a'; })()}`); }
  // tier 2
  const P = R.POC.out.filter((e) => e.ctl != null), explorePM = P.filter((e) => e.part === 'A' && !e.straddle && e.priorMove != null).map((e) => e.priorMove).sort((a, b) => a - b), cutPM = explorePM[Math.floor(explorePM.length * 2 / 3)];
  console.log(`\nTIER 2 (POC-target trade, floors and tops pooled; own budget of 2): LARGE prior move cut (top tercile, explore only) = ${f3(cutPM)} H4; HEAVY = relative volume >= 1.0`);
  for (const [nm, fa, fb] of [['HEAVY minus LIGHT', (e) => e.relVol != null && e.relVol >= 1.0, (e) => e.relVol != null && e.relVol < 1.0], ['LARGE move minus REST', (e) => e.priorMove != null && e.priorMove >= cutPM, (e) => e.priorMove != null && e.priorMove < cutPM]]) {
    const pair = (z) => [ex(z.filter(fa)), ex(z.filter(fb))], [aE, bE] = pair(P.filter((e) => e.part === 'A' && !e.straddle)), [aH, bH] = pair(P.filter((e) => e.part === 'H')), [aAll, bAll] = pair(P), dm = (x, y) => mean(x.map((v) => v.v)) - mean(y.map((v) => v.v)), okSize = (x, y) => x.length >= 15 && y.length >= 15 && dc(x) >= 15 && dc(y) >= 15;
    let v = 'UNDERPOWERED', ea = `A n=${aE.length}/${dc(aE)}d, B n=${bE.length}/${dc(bE)}d`, ha = `A n=${aH.length}, B n=${bH.length}`;
    if (okSize(aE, bE)) { const c = diffCI(aE, bE, nm + 'e', 4000, 0.0125); ea = `${f3(dm(aE, bE))} [${f3(c.lo)},${f3(c.hi)}] A n=${aE.length} B n=${bE.length}`; if (c.lo <= 0) v = 'no'; else if (!okSize(aH, bH)) v = 'CANDIDATE, hold-out UNDERPOWERED'; else { const ch = diffCI(aH, bH, nm + 'h', 4000, 0.05); ha = `${f3(dm(aH, bH))} [${f3(ch.lo)},${f3(ch.hi)}] A n=${aH.length} B n=${bH.length}`; v = dm(aH, bH) > 0 && ch.lo > 0 ? 'SCREEN-SURVIVOR' : 'candidate, not a survivor'; } }
    const sides = ['floor', 'top'].map((sd) => { const a = ex(P.filter((e) => e.side === sd).filter(fa)), b = ex(P.filter((e) => e.side === sd).filter(fb)); return `${sd}: A n=${a.length} mean ${f3(mean(a.map((x) => x.v)))} | B n=${b.length} mean ${f3(mean(b.map((x) => x.v)))}`; }).join(' ; ');
    console.log(`  ${nm}: all dates ${aAll.length && bAll.length ? f3(dm(aAll, bAll)) : 'n/a'} | explore ${ea} | hold-out ${ha} | ${v}\n    side breakdown: ${sides}`);
  }
  // descriptive
  console.log('\nDESCRIPTIVE');
  for (const t of ['POC', 'DEEP', 'NEXT']) for (const sc of [60, 120, 240]) { const z = R[t].out.filter((e) => e.scale === sc && e.ctl != null), s = ex(z); if (z.length >= 5) console.log(`  ${t} scale ${sc}m (first firing): n ${z.length} mean net ${f3(mean(z.map((e) => e.pnl)))} EXCESS ${fmt(mean(s.map((x) => x.v)), ci(s, 0.025, t + sc))}`); }
  const fam = {}; for (const e of R.POC.out) fam[e.tag] = (fam[e.tag] || 0) + 1; console.log('  POC target family chosen:', JSON.stringify(fam));
  for (const t of ['DEEP', 'NEXT']) { const z = R[t].out; console.log(`  ${t} LVN lies within 0.5 H4 of a named POC line: ${(100 * z.filter((e) => e.coincide).length / Math.max(1, z.length)).toFixed(0)}% of ${z.length} events`); }
  const ov = (arr, side) => { const e = arr.filter((x) => x.side === side).sort((a, b) => a.i0 - b.i0); let k = 0; for (let i = 1; i < e.length; i++) if (NQ.EM[e[i].i0] - NQ.EM[e[i - 1].i0] < 2880) k++; return (100 * k / Math.max(1, e.length - 1)).toFixed(0); };
  console.log(`  overlap (start within 2,880 min of the previous same-side event): floors ${ov(events, 'floor')}% tops ${ov(events, 'top')}%`);
  for (const t of ['DEEPD', 'NEXTD']) for (const side of ['floor', 'top']) { const z = R[t].out.filter((e) => e.side === side && e.ctl != null), s = ex(z); if (z.length >= 5) console.log(`  DEPTH-FILTERED ${t} ${side}: n ${z.length} mean net ${f3(mean(z.map((e) => e.pnl)))} EXCESS ${fmt(mean(s.map((x) => x.v)), ci(s, 0.025, t + side))}`); }
  { const z = R.DEEP.out.filter((e) => e.deepUncappedR != null); console.log(`  DEEPEST LVN: the lowest-volume valley beyond 1R lies beyond the 6R cap for ${(100 * z.filter((e) => e.deepUncappedR > 6).length / Math.max(1, z.length)).toFixed(0)}% of ${z.length} events (it is replaced by the deepest within 6R)`); }
  for (const t of ['POC', 'DEEP', 'NEXT']) for (const side of ['floor', 'top']) { const z = R[t].out.filter((e) => e.side === side && e.ctl != null).sort((a, b) => a.i0 - b.i0); let last = -Infinity; const sub = []; for (const e of z) if (NQ.EM[e.i0] - last >= 2880) { sub.push(e); last = NQ.EM[e.i0]; } const s = ex(sub); if (sub.length >= 5) console.log(`  NON-OVERLAPPING (>= 2,880 min apart) ${t} ${side}: ${sub.length} of ${z.length} events, mean net ${f3(mean(sub.map((e) => e.pnl)))}, EXCESS ${fmt(mean(s.map((x) => x.v)), ci(s, 0.025, 'no' + t + side))}`); }
  console.log('  NOT RUN in this pass (listed as optional in the prereg): near/far-edge LVN variants, Globex-only composite, stop 1.0 H4, band 0.35.');
  fs.writeFileSync('scratch/multiscale_poc_lvn_20261026.json', JSON.stringify({ endRow, cut, tested, cands, surv, events: events.length }));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
