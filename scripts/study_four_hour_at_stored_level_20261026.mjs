// Pre-registered in docs/FOUR_HOUR_AT_STORED_LEVEL_PREREG_20261026.md (+ Amendment 1 if present) -- committed before this ran.
// First-K>=3 four-hour defended levels split AT-LEVEL (frozen level within one band of a stored 3M/PM/PW/PY level) vs ELSEWHERE; outcomes (a) exit-free +1440 min in D20 units, (b) moonshot exit M in points; EXCESS over blind clock-matched entries and over fresh K=1 births AT a stored level.
// FORWARD_FROM=<date> analyses only events after that date (no screening), controls from history.
import fs from 'fs';
import { query } from '../server/db.js';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { loadBars, prep, indexBars, clock, mean, addDay } from './lib/floorEngine.mjs';
import { f3 } from './lib/floorStats.mjs';
import { build4h, firstK3Events, k1Events, d20Of, pinnedLimit } from './lib/fourHourLevels.mjs';
import { ARMS, PTV, makeSim, blindDraws, poolDraws, median, dc, ci, fmt, dropTopDate, diffCI } from './lib/exitSim.mjs';

const NAMES = ['3M', 'PM', 'PW', 'PY'].flatMap((f) => ['VAL', 'POC', 'VAH'].map((k) => f + '_' + k)).concat(['PM_HIGH', 'PM_LOW', 'PW_HIGH', 'PW_LOW']);
const SUPPORT = /_(VAL|LOW|POC)$/, RESIST = /_(VAH|HIGH|POC)$/;
const FWD = process.env.FORWARD_FROM || null;

async function main() {
  const endRow = process.env.STUDY_END || (await query(`SELECT (MAX(ts)::date - 3)::text d FROM price_bars_primary WHERE symbol='NQ' AND ts >= CURRENT_DATE - 7 AND ts < CURRENT_DATE + 1`)).rows[0].d;
  const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2023-03-06', endRow))), d20 = d20Of(NQ), { bars, h4 } = build4h(NQ), LIM = pinnedLimit(NQ, endRow), sim = makeSim(NQ);
  const stored = new Map(); for (const r of (await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE level_name = ANY($1) AND trade_date >= '2023-03-01'`, [NAMES])).rows) (stored.get(r.d) || stored.set(r.d, []).get(r.d)).push(r);
  const match = (x) => (stored.get(x.day) || []).filter((r) => Math.abs(r.p - x.level) <= x.band).map((r) => r.n);
  let all3 = firstK3Events(NQ, bars, h4, d20, 0.25, LIM); const k1all = k1Events(NQ, bars, h4, d20, 0.25, LIM);
  if (FWD) all3 = all3.filter((e) => e.day > FWD);
  for (const e of all3) { e.names = match(e); e.at = e.names.length > 0; e.orient = e.at && e.names.some((n) => (e.side === 'floor' ? SUPPORT : RESIST).test(n)); }
  const k1at = k1all.filter((k) => match(k).length > 0), events = all3.filter(sim.strictOK);
  console.log(`${FWD ? 'FORWARD MODE, events after ' + FWD : 'HISTORY'}: NQ bars to ${endRow}; first-K3 events ${all3.length}; strict-exit events ${events.length} (floors ${events.filter((e) => e.side === 'floor').length}, tops ${events.filter((e) => e.side === 'top').length}); AT-LEVEL ${events.filter((e) => e.at).length} (floors ${events.filter((e) => e.at && e.side === 'floor').length}, tops ${events.filter((e) => e.at && e.side === 'top').length}) on ${dc(events.filter((e) => e.at))} dates; orientation-matched ${events.filter((e) => e.orient).length}; K=1 births at a stored level ${k1at.length} of ${k1all.length}`);
  const fam = {}; for (const e of events.filter((x) => x.at)) for (const n of e.names) fam[n.split('_')[0]] = (fam[n.split('_')[0]] || 0) + 1; console.log('  at-level matches by family (an event can match several):', JSON.stringify(fam));
  // partition (fixed by the strict-event dates of the WHOLE history, as in the moonshot study, so the cut is the same)
  let cut, cutSafe; { const base = firstK3Events(NQ, bars, h4, d20, 0.25, LIM).filter(sim.strictOK), days = [...new Set(base.map((e) => e.day))].sort(); cut = days[Math.floor(days.length * 0.6) - 1]; } cutSafe = addDay(cut, -4);
  const okDay = FWD ? (p, day) => day <= FWD : (p, day) => (p === 'A' ? day <= cutSafe : day > cut);
  for (const e of events) { const cap = sim.capOf(e.i0, 1440, true); e.exitTD = NQ.TD[cap]; e.part = FWD ? 'F' : e.day <= cut ? 'A' : 'H'; e.straddle = !FWD && e.part === 'A' && e.exitTD > cut; }
  const rng = mulberry32(hashSeed('storedlevel')), samp = []; for (let i = 3100; i < LIM - 3000; i += 15) if (d20[NQ.TD[i]]) samp.push(i);
  const k1By = new Map(); for (const k of k1at) { const key = k.side + '|' + k.clk; (k1By.get(key) || k1By.set(key, []).get(key)).push(k); }
  for (const e of events) {
    const draws = blindDraws(NQ, samp, rng, e, okDay), pool = (k1By.get(e.side + '|' + clock(NQ.T[e.i0])) || []).filter((k) => k.day !== e.day && okDay(e.part, k.day)), k1d = poolDraws(rng, pool); e.res = {};
    for (const nm of ['FREE', 'M']) { const arm = ARMS[nm], sp = sim.stopOf(e, arm), real = sim.run(e.i0, e.dir, sp, Infinity, arm); if (!real) continue; const cs = draws.map((i) => sim.run(i, e.dir, sp, Infinity, arm)).filter(Boolean).map((x) => x.pnl), ks = k1d.map((k) => sim.run(k.i0, e.dir, sp, Infinity, arm)).filter(Boolean).map((x) => x.pnl); e.res[nm] = { pnl: real.pnl, res: real.res, ctl: cs.length >= 5 ? mean(cs) : null, ctlK1: ks.length >= 5 ? mean(ks) : null }; e.k1n = ks.length; }
  }
  // --- selectivity of the net, dropped-vs-kept, balance (Amendment 1)
  { let hit = 0, n = 0; for (const b of samp) { const td = NQ.TD[b]; if (!h4[td]) continue; n++; const band = 0.25 * h4[td]; if ((stored.get(td) || []).some((r) => Math.abs(r.p - NQ.C[b]) <= band)) hit++; } console.log(`selectivity: ${(100 * hit / n).toFixed(0)} percent of ${n} randomly sampled bars have a close within one band of a stored level, versus ${(100 * events.filter((e) => e.at).length / events.length).toFixed(0)} percent of the strict events`); }
  { const dropped = all3.filter((e) => !sim.strictOK(e)); console.log(`strict-exit drop: AT-LEVEL share among dropped ${(100 * dropped.filter((e) => e.at).length / Math.max(1, dropped.length)).toFixed(0)} percent (n ${dropped.length}) vs kept ${(100 * events.filter((e) => e.at).length / events.length).toFixed(0)} percent (n ${events.length})`); }
  { const grp = (f) => events.filter(f), slotOf = (e) => clock(NQ.T[e.i0]), yr = (e) => e.day.slice(0, 4), AT = grp((e) => e.at), EL = grp((e) => !e.at), share = (G, f) => (100 * G.filter(f).length / Math.max(1, G.length)).toFixed(0);
    console.log(`balance AT-LEVEL (n ${AT.length}) vs ELSEWHERE (n ${EL.length}): mean D20 ${f3(mean(AT.map((e) => e.d20)))} vs ${f3(mean(EL.map((e) => e.d20)))}; mean band ${f3(mean(AT.map((e) => e.band)))} vs ${f3(mean(EL.map((e) => e.band)))}; mean DROP ${f3(mean(AT.map((e) => e.drop)))} vs ${f3(mean(EL.map((e) => e.drop)))}; share in 2023/24/25/26 ${['2023', '2024', '2025', '2026'].map((y) => share(AT, (e) => yr(e) === y)).join('/')} vs ${['2023', '2024', '2025', '2026'].map((y) => share(EL, (e) => yr(e) === y)).join('/')}; share entered at RTH hours ${share(AT, (e) => e.sess === 'RTH')} vs ${share(EL, (e) => e.sess === 'RTH')}`); }
  const OUT = { a: { label: '(a) exit-free +1440 min, D20 units', v: (e, c) => (e.res.FREE && e.res.FREE[c] != null ? (e.res.FREE.pnl - e.res.FREE[c]) / e.d20 : null), abs: null }, b: { label: '(b) moonshot exit M, points', v: (e, c) => (e.res.M && e.res.M[c] != null ? e.res.M.pnl - e.res.M[c] : null), abs: (e) => (e.res.M ? e.res.M.pnl : null) } };
  const items = (evs, o, c = 'ctl') => evs.map((e) => ({ day: e.day, v: o.v(e, c) })).filter((x) => x.v != null && Number.isFinite(x.v));
  console.log(`\nexplore/hold-out cut ${cut}${FWD ? ' (not used in forward mode)' : ''}; explore events dropped for straddling the cut: ${events.filter((e) => e.straddle).length}`);
  let cands = 0, surv = 0, tested = 0; const lo = FWD ? 0.025 : 0.00625;
  for (const side of ['floor', 'top']) for (const [ok, o] of Object.entries(OUT)) {
    const nm = `${side.toUpperCase()}-AT-LEVEL ${o.label}`, evs = events.filter((e) => e.side === side && e.at && o.v(e, 'ctl') != null);
    const A = evs.filter((e) => e.part === 'A' && !e.straddle), Hh = evs.filter((e) => e.part === 'H'), under = (z) => z.length < 30 || dc(z) < 20, ia = items(evs, o);
    const k1m = median(evs.map((e) => e.k1n || 0)), k1ok = k1m >= 10; const absTxt = o.abs ? ` abs mean ${f3(mean(evs.map(o.abs)))} pts (${f3(mean(evs.map(o.abs)) * PTV)} dollars) median ${f3(median(evs.map(o.abs)))}` : '';
    console.log(`\n${nm}: n ${evs.length}, ${dc(evs)} dates; EXCESS vs blind ${fmt(mean(ia.map((x) => x.v)), ci(ia, 0.025, nm + 'all'))}; K=1 controls found per event: median ${k1m}, share with >=10 ${(100 * evs.filter((e) => (e.k1n || 0) >= 10).length / Math.max(1, evs.length)).toFixed(0)}%; EXCESS vs K=1 births at a stored level ${fmt(mean(items(evs, o, 'ctlK1').map((x) => x.v)), ci(items(evs, o, 'ctlK1'), 0.025, nm + 'k1'))} n${items(evs, o, 'ctlK1').length};${absTxt}`);
    if (FWD) { console.log('  forward look: descriptive, no verdict (single pre-registered look)'); continue; }
    let v = 'UNDERPOWERED (explore)', ea = `n=${A.length}/${dc(A)}d`, ha = `n=${Hh.length}/${dc(Hh)}d`;
    if (!under(A)) {
      tested++; const xa = items(A, o), c = ci(xa, lo, nm + 'a'), ka = items(A, o, 'ctlK1'); ea = `${fmt(mean(xa.map((x) => x.v)), c)} n=${A.length}/${dc(A)}d, K1AT-excess ${f3(mean(ka.map((x) => x.v)))}, without top date ${f3(dropTopDate(xa))}`;
      if (!(c.lo > 0)) v = 'no'; else { cands++; if (under(Hh)) v = 'CANDIDATE, hold-out UNDERPOWERED'; else { const xh = items(Hh, o), ch = ci(xh, 0.025, nm + 'h'), kh = items(Hh, o, 'ctlK1'); ha = `${fmt(mean(xh.map((x) => x.v)), ch)} n=${Hh.length}/${dc(Hh)}d, K1AT-excess ${f3(mean(kh.map((x) => x.v)))}, without top date ${f3(dropTopDate(xh))}`;
        const pass = mean(xh.map((x) => x.v)) > 0 && ch.lo > 0 && mean(xa.map((x) => x.v)) > 0 && dropTopDate(xa) > 0 && dropTopDate(xh) > 0;
        if (!pass) v = 'candidate, not a survivor'; else { surv++; const loc = !k1ok || (mean(ka.map((x) => x.v)) > 0 && mean(kh.map((x) => x.v)) > 0); v = !k1ok ? 'SCREEN-SURVIVOR, K1AT control uninformative (median controls < 10)' : !loc ? 'SCREEN-SURVIVOR but stored-level artifact (the level alone does as well)' : o.abs ? (mean(A.map(o.abs)) > 0 && mean(Hh.map(o.abs)) > 0 ? 'SCREEN-SURVIVOR, absolute net positive in both halves = usable lead' : 'SCREEN-SURVIVOR, absolute net not positive in both halves = not usable') : 'SCREEN-SURVIVOR'; } } }
    } else if (Hh.length) ha += '';
    console.log(`  explore ${ea}\n  hold-out ${ha}\n  smallest detectable effect (explore CI half-width) ${items(A, o).length >= 5 ? f3((ci(items(A, o), lo, nm + 'hw').hi - ci(items(A, o), lo, nm + 'hw').lo) / 2) : 'n/a'}\n  => ${v}`);
  }
  if (!FWD) console.log(`CELLS TESTED ${tested} (of 4), CANDIDATES ${cands}, expected by chance about ${(tested * 0.0125).toFixed(2)}, SCREEN-SURVIVORS ${surv}`);
  console.log('\nDESCRIPTIVE (all dates, no verdict)');
  for (const side of ['floor', 'top']) for (const [ok, o] of Object.entries(OUT)) {
    const S = events.filter((e) => e.side === side && o.v(e, 'ctl') != null), at = items(S.filter((e) => e.at), o), el = items(S.filter((e) => !e.at), o);
    if (at.length >= 5 && el.length >= 5) { const d = diffCI(at, el, side + ok + 'ate'); console.log(`  ${side} ${o.label}: AT-LEVEL n${at.length} mean ${f3(mean(at.map((x) => x.v)))} | ELSEWHERE n${el.length} ${f3(mean(el.map((x) => x.v)))} | difference ${f3(mean(at.map((x) => x.v)) - mean(el.map((x) => x.v)))} [95% ${f3(d.lo)}, ${f3(d.hi)}]`); }
    const om = items(S.filter((e) => e.orient), o), ot = items(S.filter((e) => e.at && !e.orient), o); console.log(`     orientation-matched n${om.length} ${f3(mean(om.map((x) => x.v)))} | at a level of the other orientation n${ot.length} ${f3(mean(ot.map((x) => x.v)))}`);
    const atE = S.filter((e) => e.at && e.relVol != null); if (atE.length >= 10) { const med = median(atE.filter((e) => e.part === 'A').map((e) => e.relVol)) || median(atE.map((e) => e.relVol)), hv = items(atE.filter((e) => e.relVol > med), o), lt = items(atE.filter((e) => e.relVol <= med), o); console.log(`     volume vs normal at the defended bars (median ${f3(med)}x): HEAVY n${hv.length} ${f3(mean(hv.map((x) => x.v)))} vs LIGHT n${lt.length} ${f3(mean(lt.map((x) => x.v)))}`); }
  }
  fs.writeFileSync(`scratch/four_hour_stored_level_20261026${FWD ? '_forward' : ''}.json`, JSON.stringify({ endRow, cut, FWD, tested, cands, surv }));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
