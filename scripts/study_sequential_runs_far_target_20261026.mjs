// Pre-registered in docs/SEQUENTIAL_RUN_FAR_TARGET_PREREG_20261026.md + Amendments 1-3 (committed before this ran). Run ONCE; nothing here was tuned on outcomes.
// Arms: SEQ (4+ sequential four-hour bars, scripts/lib/sequentialRuns.mjs, band 0.25 x H4, prior reference required) and REPEATED-DEFENSE (finder events with a non-prior-day line and >= 3 separate approaches).
// Trade: entry = open after the firing bar; stop = 0.5 x H4 beyond the defended extreme; target = 3 x risk; time exit 2,879 minutes (lenient at gaps); realistic fills (walk()); cost 1.5 points.
// EXCESS = net points minus the mean of 30 clock-matched blind same-direction entries (same stop/target distances in points) from the event's own partition; EXCESS-FRESH = minus 30 fresh-extreme births (k1Events).
import fs from 'fs';
import { query } from '../server/db.js';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { loadBars, prep, indexBars, clock, mean, addDay } from './lib/floorEngine.mjs';
import { f3 } from './lib/floorStats.mjs';
import { build4h, k1Events, d20Of, pinnedLimit } from './lib/fourHourLevels.mjs';
import { sequentialRuns } from './lib/sequentialRuns.mjs';
import { COST, PTV, makeSim, blindDraws, poolDraws, median, dc, ci, diffCI, fmt, dropTopDate } from './lib/exitSim.mjs';
const ARM = { hold: 2880, lenient: true }, STOP_MULT = 0.5, R = 3;
async function main() {
  const endRow = (await query(`SELECT (MAX(ts)::date - 3)::text d FROM price_bars_primary WHERE symbol='NQ' AND ts >= CURRENT_DATE - 7 AND ts < CURRENT_DATE + 1`)).rows[0].d;
  const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2023-03-06', endRow))), d20 = d20Of(NQ), { bars, h4 } = build4h(NQ), LIM = pinnedLimit(NQ, endRow), { run, capOf } = makeSim(NQ);
  const k1 = k1Events(NQ, bars, h4, d20, 0.25, LIM), k1By = new Map(); for (const k of k1) { const key = k.side + '|' + k.clk; (k1By.get(key) || k1By.set(key, []).get(key)).push(k); }
  const mkSeq = (bandMult) => sequentialRuns(bars, h4, { bandMult }).filter((e) => bars[e.t].i1 + 1 < LIM - 3000).map((e) => { const b = bars[e.t], s = e.s, sg = e.dir; let ext = null; for (let k = Math.max(0, s - 18); k < s; k++) ext = sg > 0 ? Math.max(ext ?? -Infinity, bars[k].H) : Math.min(ext ?? Infinity, bars[k].L);
    const rv = e.runBars.filter((x) => x.relBase).map((x) => x.V / x.relBase); return { arm: 'SEQ', side: e.side, dir: sg, t: e.t, i0: b.i1 + 1, tdBar: b.td, day: NQ.TD[b.i1 + 1], H4: e.H4, extreme: e.level, len: e.len, relVol: rv.length ? mean(rv) : null, priorMove: ext == null ? null : (sg > 0 ? ext - e.level : e.level - ext) / e.H4 }; });
  const evFile = JSON.parse(fs.readFileSync('scratch/defended_events_band0.25_20261026.json')); if (evFile.endRow !== endRow) throw new Error('finder events were built to ' + evFile.endRow + ', not ' + endRow);
  const mkRep = () => evFile.events.filter((e) => e.lines.some((l) => !l.startsWith('PD_')) && e.A >= 3 && e.i0 < LIM - 3000 && bars[e.t].td === e.td).map((e) => ({ arm: 'REP', side: e.side, dir: e.dir, t: e.t, i0: e.i0, tdBar: e.td, day: NQ.TD[e.i0], H4: e.H4, extreme: e.dir > 0 ? e.level - e.band : e.level + e.band, len: e.K, A: e.A, relVol: e.relVol, priorMove: null, nLines: e.lines.length }));
  const seq = mkSeq(0.25), rep = mkRep();
  const all = [...seq, ...rep]; const days = [...new Set(all.filter((e) => capOf(e.i0, 2880, true) !== undefined).map((e) => e.day))].sort(), cut = days[Math.floor(days.length * 0.6) - 1], cutSafe = addDay(cut, -4);
  console.log(`NQ to ${endRow}; SEQ events ${seq.length} (floors ${seq.filter((e) => e.side === 'floor').length}, tops ${seq.filter((e) => e.side === 'top').length}); REPEATED-DEFENSE events ${rep.length} (floors ${rep.filter((e) => e.side === 'floor').length}, tops ${rep.filter((e) => e.side === 'top').length}); explore/hold-out cut ${cut} (earlier 60 percent of ${days.length} event dates)`);
  const okDay = (p, day) => (p === 'A' ? day <= cutSafe : day > cut), rng = mulberry32(hashSeed('seqrun-farTarget')), samp = []; for (let i = 3100; i < LIM - 3000; i += 15) if (d20[NQ.TD[i]]) samp.push(i);
  function evaluate(events, { stopMult = STOP_MULT, r = R, entryMode = 'next' } = {}) {
    const out = [];
    for (const e0 of events) {
      let e = { ...e0 }; if (entryMode === 'afterBar') { let found = null; for (let q = e.t + 1; q <= e.t + 3 && q < bars.length; q++) if (e.dir > 0 ? bars[q].C > bars[e.t].H : bars[q].C < bars[e.t].L) { found = q; break; } if (found == null) { out.push({ ...e0, skip: 'noConfirm' }); continue; } e.i0 = bars[found].i1 + 1; e.day = NQ.TD[e.i0]; if (e.i0 >= LIM - 3000) { out.push({ ...e0, skip: 'late' }); continue; } }
      const entry = NQ.O[e.i0], stopPrice = e.extreme - e.dir * stopMult * e.H4, stopPts = e.dir > 0 ? entry - stopPrice : stopPrice - entry; if (!(stopPts > 1)) { out.push({ ...e0, skip: 'stopDegenerate' }); continue; }
      const tgtPts = r * stopPts, cap = capOf(e.i0, 2880, true); if (cap === undefined) { out.push({ ...e0, skip: 'noExit' }); continue; }
      e.exitTD = NQ.TD[cap]; e.part = e.day <= cut ? 'A' : 'H'; e.straddle = e.part === 'A' && e.exitTD > cut;
      const real = run(e.i0, e.dir, stopPts, tgtPts, ARM); if (!real) { out.push({ ...e0, skip: 'noRun' }); continue; }
      const mir = run(e.i0, -e.dir, stopPts, tgtPts, ARM), ctl = blindDraws(NQ, samp, rng, e, okDay).map((i) => run(i, e.dir, stopPts, tgtPts, ARM)).filter(Boolean).map((x) => x.pnl);
      const pool = (k1By.get(e.side + '|' + clock(NQ.T[e.i0])) || []).filter((k) => k.day !== e.day && okDay(e.part, k.day)), fr = poolDraws(rng, pool).map((k) => run(k.i0, e.dir, stopPts, tgtPts, ARM)).filter(Boolean).map((x) => x.pnl);
      out.push({ ...e, pnl: real.pnl, res: real.res, mirror: mir ? mir.pnl : null, ctl: ctl.length >= 5 ? mean(ctl) : null, fresh: fr.length >= 5 ? mean(fr) : null, stopPts, stopH4: stopPts / e.H4, tgtPts });
    }
    return out;
  }
  const ex = (z, k = 'ctl') => z.filter((e) => e.pnl != null && e[k] != null).map((e) => ({ day: e.day, v: e.pnl - e[k] }));
  const top5 = (vals) => { const tot = vals.reduce((s, x) => s + x, 0); return tot > 0 ? (vals.slice().sort((a, b) => b - a).slice(0, 5).reduce((s, x) => s + x, 0) / tot).toFixed(2) : 'n/a (total<=0)'; };
  const under = (z) => z.length < 30 || dc(z) < 20;
  let cands = 0, surv = 0, tested = 0;
  const cell = (nm, evs) => {
    const A = evs.filter((e) => e.part === 'A' && !e.straddle && e.ctl != null), H = evs.filter((e) => e.part === 'H' && e.ctl != null), res = evs.map((e) => e.res), shr = (c) => (100 * res.filter((x) => x === c).length / Math.max(1, res.length)).toFixed(0);
    const S = ex(evs), mir = evs.filter((e) => e.mirror != null).map((e) => ({ day: e.day, v: e.pnl - e.mirror }));
    console.log(`\n${nm}: n ${evs.length} on ${dc(evs)} dates. ABSOLUTE net per trade: mean ${f3(mean(evs.map((e) => e.pnl)))} pts (${f3(mean(evs.map((e) => e.pnl)) * PTV)} dollars), median ${f3(median(evs.map((e) => e.pnl)))}; stopped ${shr('S')}%, target ${shr('T')}%, time-exit ${shr('C')}%; worst ${f3(Math.min(...evs.map((e) => e.pnl)))}; top-5-trades share ${top5(evs.map((e) => e.pnl))}; stop distance median ${f3(median(evs.map((e) => e.stopH4)))} H4`);
    console.log(`  all dates: EXCESS vs blind ${evs.length >= 5 ? fmt(mean(S.map((x) => x.v)), ci(S, 0.025, nm + 'all')) : 'n/a'} | EXCESS-FRESH ${(() => { const f = ex(evs, 'fresh'); return f.length >= 5 ? fmt(mean(f.map((x) => x.v)), ci(f, 0.025, nm + 'fr')) : 'n/a'; })()} | real minus MIRROR ${mir.length >= 5 ? fmt(mean(mir.map((x) => x.v)), ci(mir, 0.025, nm + 'mir')) : 'n/a'}`);
    let v = 'UNDERPOWERED (explore)', ea = `n=${A.length}/${dc(A)}d`, ha = `n=${H.length}/${dc(H)}d`;
    if (!under(A)) { tested++; const sa = ex(A), c = ci(sa, 0.00625, nm + 'a'), fa = ex(A, 'fresh'), fmA = mean(fa.map((x) => x.v)); ea = `${fmt(mean(sa.map((x) => x.v)), c)} n=${A.length}/${dc(A)}d, FRESH ${f3(fmA)}, abs ${f3(mean(A.map((e) => e.pnl)))}, without top date ${f3(dropTopDate(sa))}`;
      const cand = c.lo > 0 && fmA > 0; if (cand) cands++; if (!cand) v = 'no'; else if (under(H)) v = 'CANDIDATE, hold-out UNDERPOWERED'; else { const sh = ex(H), ch = ci(sh, 0.05, nm + 'h'), fh = ex(H, 'fresh'); ha = `${fmt(mean(sh.map((x) => x.v)), ch)} n=${H.length}/${dc(H)}d, FRESH ${f3(mean(fh.map((x) => x.v)))}, abs ${f3(mean(H.map((e) => e.pnl)))}, without top date ${f3(dropTopDate(sh))}`;
        const ok = mean(sh.map((x) => x.v)) > 0 && ch.lo > 0 && mean(sa.map((x) => x.v)) > 0 && dropTopDate(sa) > 0 && dropTopDate(sh) > 0; if (!ok) v = 'candidate, not a survivor'; else { surv++; const loc = mean(fh.map((x) => x.v)) > 0; v = !loc ? 'SCREEN-SURVIVOR but level-location artifact' : mean(A.map((e) => e.pnl)) > 0 && mean(H.map((e) => e.pnl)) > 0 ? 'SCREEN-SURVIVOR and absolute net positive in both halves = usable lead' : 'SCREEN-SURVIVOR but absolute net not positive in both halves'; } } }
    console.log(`  explore ${ea}\n  hold-out ${ha}\n  => ${v}`);
  };
  console.log(`\nPRIMARY TRADE: entry next open, stop ${STOP_MULT} x H4 beyond the defended extreme, target ${R} x risk, time exit 2,879 min, cost ${COST} pts. TIER 1 = 4 counted cells (explore CI 98.75 percent, explore EXCESS-FRESH above 0, hold-out one 95 percent test).`);
  const P = { SEQ: evaluate(seq), REP: evaluate(rep) };
  const skips = (arr) => { const c = {}; for (const e of arr) if (e.skip) c[e.skip] = (c[e.skip] || 0) + 1; return JSON.stringify(c); };
  console.log('skipped events: SEQ', skips(P.SEQ), 'REP', skips(P.REP));
  for (const arm of ['SEQ', 'REP']) for (const side of ['floor', 'top']) cell(`${arm === 'SEQ' ? 'SEQUENTIAL RUN' : 'REPEATED DEFENSE'} ${side.toUpperCase()}`, P[arm].filter((e) => e.side === side && e.pnl != null));
  console.log(`\nTIER 1 CELLS TESTED ${tested} (of 4), CANDIDATES ${cands}, expected by chance about ${(tested * 0.0125).toFixed(2)}, SCREEN-SURVIVORS ${surv}`);
  // ---- Tier 2 (pooled floors+tops; own Bonferroni budget of 2): HEAVY-LIGHT (relVol >= 1.0) and LARGE-REST (top tercile of priorMove among explore SEQ events)
  const SQ = P.SEQ.filter((e) => e.pnl != null && e.ctl != null), explorePM = SQ.filter((e) => e.part === 'A' && !e.straddle && e.priorMove != null).map((e) => e.priorMove).sort((a, b) => a - b), cutPM = explorePM[Math.floor(explorePM.length * 2 / 3)];
  console.log(`\nTIER 2 (SEQ, floors and tops pooled; side breakdown below each). LARGE move cut (top tercile of prior 3-day move in H4 units, explore events only) = ${f3(cutPM)} H4; HEAVY = relative volume >= 1.0`);
  const tier2 = [['HEAVY minus LIGHT', (e) => e.relVol != null && e.relVol >= 1.0, (e) => e.relVol != null && e.relVol < 1.0], ['LARGE move minus REST', (e) => e.priorMove != null && e.priorMove >= cutPM, (e) => e.priorMove != null && e.priorMove < cutPM]];
  for (const [nm, fa, fb] of tier2) {
    const pair = (z) => [ex(z.filter(fa)), ex(z.filter(fb))], [aE, bE] = pair(SQ.filter((e) => e.part === 'A' && !e.straddle)), [aH, bH] = pair(SQ.filter((e) => e.part === 'H')), [aAll, bAll] = pair(SQ);
    const dm = (x, y) => mean(x.map((v) => v.v)) - mean(y.map((v) => v.v)), okSize = (x, y) => x.length >= 15 && y.length >= 15 && dc(x) >= 15 && dc(y) >= 15;
    let v = 'UNDERPOWERED (explore arms need 15 events and 15 dates each)'; let ea = `A n=${aE.length}/${dc(aE)}d, B n=${bE.length}/${dc(bE)}d`, ha = `A n=${aH.length}, B n=${bH.length}`;
    if (okSize(aE, bE)) { const c = diffCI(aE, bE, nm + 'e', 4000, 0.0125); ea = `${f3(dm(aE, bE))} [${f3(c.lo)},${f3(c.hi)}] A n=${aE.length}/${dc(aE)}d (mean ${f3(mean(aE.map((x) => x.v)))}) B n=${bE.length}/${dc(bE)}d (mean ${f3(mean(bE.map((x) => x.v)))})`; if (c.lo <= 0) v = 'no'; else if (!okSize(aH, bH)) v = 'CANDIDATE, hold-out UNDERPOWERED'; else { const ch = diffCI(aH, bH, nm + 'h', 4000, 0.05); ha = `${f3(dm(aH, bH))} [${f3(ch.lo)},${f3(ch.hi)}] A n=${aH.length} B n=${bH.length}`; v = dm(aH, bH) > 0 && ch.lo > 0 ? 'SCREEN-SURVIVOR' : 'candidate, not a survivor'; } }
    const sides = ['floor', 'top'].map((sd) => { const a = ex(SQ.filter((e) => e.side === sd).filter(fa)), b = ex(SQ.filter((e) => e.side === sd).filter(fb)); return `${sd}: A n=${a.length} mean ${f3(mean(a.map((x) => x.v)))} | B n=${b.length} mean ${f3(mean(b.map((x) => x.v)))}`; }).join(' ; ');
    console.log(`  ${nm}: all dates ${aAll.length && bAll.length ? f3(dm(aAll, bAll)) : 'n/a'} (A n=${aAll.length}, B n=${bAll.length}) | explore ${ea} | hold-out ${ha} | ${v}\n    side breakdown (all dates): ${sides}`);
  }
  // ---- descriptive sensitivities (never a verdict)
  console.log('\nSENSITIVITY (descriptive, all dates, SEQ then REPEATED-DEFENSE): variant | arm | side | n | mean net pts | mean EXCESS vs blind [95% date-blocked CI] | stopped %');
  const variants = [['stop 1.0 H4', seq, { stopMult: 1.0 }], ['target 2R', seq, { r: 2 }], ['target 4R', seq, { r: 4 }], ['entry after next confirming bar', seq, { entryMode: 'afterBar' }], ['band 0.5 H4', mkSeq(0.5), {}], ['band 0.35 H4', mkSeq(0.35), {}]];
  for (const [nm, evs, o] of variants) { const out = evaluate(evs, o); for (const side of ['floor', 'top']) { const z = out.filter((e) => e.side === side && e.pnl != null && e.ctl != null), s = ex(z); if (z.length < 5) { console.log(`  ${nm.padEnd(32)} SEQ ${side.padEnd(5)} n ${z.length}`); continue; } console.log(`  ${nm.padEnd(32)} SEQ ${side.padEnd(5)} n ${String(z.length).padStart(3)} | ${f3(mean(z.map((e) => e.pnl)))} | ${fmt(mean(s.map((x) => x.v)), ci(s, 0.025, nm + side))} | stopped ${(100 * z.filter((e) => e.res === 'S').length / z.length).toFixed(0)}%${o.entryMode ? ` (dropped for no confirming bar: ${out.filter((e) => e.skip === 'noConfirm' && e.side === side).length})` : ''}`); } }
  for (const side of ['floor', 'top']) { const z = P.SEQ.filter((e) => e.side === side && e.pnl != null && e.ctl != null).sort((a, b) => a.i0 - b.i0); let last = -Infinity, k = 0, pn = []; for (const e of z) if (NQ.EM[e.i0] - last >= 2880) { k++; last = NQ.EM[e.i0]; pn.push(e.pnl); } console.log(`  non-overlapping subset (events >= 2,880 min apart) SEQ ${side}: ${k} of ${z.length} events, mean net ${f3(mean(pn))}`); }
  const ov = (arr, side) => { const e = arr.filter((x) => x.side === side).sort((a, b) => a.i0 - b.i0); let k = 0; for (let i = 1; i < e.length; i++) if (NQ.EM[e[i].i0] - NQ.EM[e[i - 1].i0] < 2880) k++; return (100 * k / Math.max(1, e.length - 1)).toFixed(0); };
  console.log(`  overlap (starts within 2,880 min of the previous same-side event): SEQ floors ${ov(P.SEQ, 'floor')}% tops ${ov(P.SEQ, 'top')}%; REP floors ${ov(P.REP, 'floor')}% tops ${ov(P.REP, 'top')}%`);
  const repSplit = (nm, f) => { for (const side of ['floor', 'top']) { const z = P.REP.filter((e) => e.side === side && e.pnl != null && e.ctl != null), a = ex(z.filter(f)), b = ex(z.filter((e) => !f(e))); console.log(`  REP ${side} ${nm}: yes n=${a.length} mean excess ${f3(mean(a.map((x) => x.v)))} | no n=${b.length} mean ${f3(mean(b.map((x) => x.v)))}`); } };
  repSplit('another period line within the same event (2+ lines merged)', (e) => (e.nLines || 1) >= 2);
  fs.writeFileSync('scratch/sequential_run_far_target_20261026.json', JSON.stringify({ endRow, cut, tested, cands, surv, seq: P.SEQ.length, rep: P.REP.length }));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
