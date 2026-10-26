// Pre-registered in docs/FOUR_HOUR_MOONSHOT_EXIT_PREREG_20261026.md + Amendment 1 (committed before this ran).
// Entry = first K>=3 four-hour defended level (floor long / top short), open of the next 1-minute bar. Exit simulated bar by bar with the shared realistic-fill walker (gap-through fills at the open).
// EXCESS = event P&L minus the mean of up to 30 clock-matched blind same-direction entries run through the IDENTICAL exit; EXCESS-K1 = minus up to 30 fresh K=1 birth events of the same side at the SAME clock. Mirror placebo = same event traded the other way.
// Explore/hold-out: explore events whose exit window crosses the cut are dropped from both screens; controls come only from the event's own partition.
import fs from 'fs';
import { query } from '../server/db.js';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { loadBars, prep, indexBars, clock, mean, walk, addDay } from './lib/floorEngine.mjs';
import { f3 } from './lib/floorStats.mjs';
import { build4h, firstK3Events, k1Events, d20Of, pinnedLimit } from './lib/fourHourLevels.mjs';
import { COST, PTV, ARMS, makeSim, blindDraws, poolDraws, median, dc, boot, ci, fmt, dropTopDate } from './lib/exitSim.mjs';

async function main() {
  const endRow = (await query(`SELECT (MAX(ts)::date - 3)::text d FROM price_bars_primary WHERE symbol='NQ' AND ts >= CURRENT_DATE - 7 AND ts < CURRENT_DATE + 1`)).rows[0].d;
  const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2023-03-06', endRow))), d20 = d20Of(NQ), { bars, h4 } = build4h(NQ), LIM = pinnedLimit(NQ, endRow);
  const { capOf, run, stopOf, strictOK } = makeSim(NQ), all3 = firstK3Events(NQ, bars, h4, d20, 0.25, LIM), k1 = k1Events(NQ, bars, h4, d20, 0.25, LIM);
  const events = all3, dropped = all3.filter((e) => !strictOK(e)).length;
  console.log(`NQ bars to ${endRow} (pinned limit ${LIM}); 4-hour bars ${bars.length}; first-K3 events ${all3.length} (floors ${all3.filter((e) => e.side === 'floor').length}, tops ${all3.filter((e) => e.side === 'top').length}); without a +1,439-minute exit bar ${dropped}; K=1 birth events ${k1.length}`);
  const allDays = [...new Set(events.filter(strictOK).map((e) => e.day))].sort(), cut = allDays[Math.floor(allDays.length * 0.6) - 1], cutSafe = addDay(cut, -4), partOf = (day) => (day <= cut ? 'A' : 'H');
  for (const e of events) { const cap = capOf(e.i0, 1440, true); e.exitTD = NQ.TD[cap]; e.part = partOf(e.day); e.straddle = e.part === 'A' && e.exitTD > cut; }
  const okDay = (p, day) => (p === 'A' ? day <= cutSafe : day > cut);
  const rng = mulberry32(hashSeed('moonshot')), samp = []; for (let i = 3100; i < LIM - 3000; i += 15) if (d20[NQ.TD[i]]) samp.push(i);
  const k1By = new Map(); for (const k of k1) { const key = k.side + '|' + k.clk; (k1By.get(key) || k1By.set(key, []).get(key)).push(k); }
  for (const e of events) {
    const draws = blindDraws(NQ, samp, rng, e, okDay), pool = (k1By.get(e.side + '|' + clock(NQ.T[e.i0])) || []).filter((k) => k.day !== e.day && okDay(e.part, k.day)), k1d = poolDraws(rng, pool);
    e.res = {};
    for (const [nm, arm] of Object.entries(ARMS)) {
      const sp = stopOf(e, arm), tp = arm.tgt != null ? arm.tgt * e.d20 : Infinity, real = run(e.i0, e.dir, sp, tp, arm); if (!real) { e.res[nm] = null; continue; }
      const mir = run(e.i0, -e.dir, sp, tp, arm), cs = draws.map((i) => run(i, e.dir, sp, tp, arm)).filter(Boolean).map((x) => x.pnl), ks = k1d.map((k) => run(k.i0, e.dir, sp, tp, arm)).filter(Boolean).map((x) => x.pnl);
      e.res[nm] = { pnl: real.pnl, res: real.res, mirror: mir ? mir.pnl : null, ctl: cs.length >= 5 ? mean(cs) : null, ctlK1: ks.length >= 5 ? mean(ks) : null, stopPts: sp };
    }
  }
  console.log(`explore/hold-out cut ${cut} (earlier 60 percent of ${allDays.length} event dates); explore events dropped for straddling the cut: ${events.filter((e) => e.straddle).length}`);
  const cellAll = (side) => events.filter((e) => e.side === side && e.res.M && e.res.M.ctl != null), cells = [['FLOOR long', cellAll('floor')], ['TOP short', cellAll('top')]];
  const stat = (evs, key, ck = 'ctl') => ({ n: evs.length, pts: evs.map((e) => e.res[key].pnl), exc: evs.filter((e) => e.res[key][ck] != null).map((e) => ({ day: e.day, v: e.res[key].pnl - e.res[key][ck] })) });
  const top5 = (vals) => { const tot = vals.reduce((s, x) => s + x, 0); return tot > 0 ? (vals.slice().sort((a, b) => b - a).slice(0, 5).reduce((s, x) => s + x, 0) / tot).toFixed(2) : 'n/a (total<=0)'; };
  const top5d = (evs) => { const g = new Map(); for (const e of evs) g.set(e.day, (g.get(e.day) || 0) + e.res.M.pnl); return top5([...g.values()]); };
  let cands = 0, surv = 0, tested = 0;
  console.log(`\nPRIMARY EXIT M (stop 0.5 x D20, no target, hold 1440 min, gap-through at the open, cost ${COST} pts). Explore CI 97.5 percent (Bonferroni over 2), hold-out one 95 percent test.`);
  for (const [nm, evs] of cells) {
    const A = evs.filter((e) => e.part === 'A' && !e.straddle), Hh = evs.filter((e) => e.part === 'H'), under = (z) => z.length < 30 || dc(z) < 20, S = stat(evs, 'M');
    const res = evs.map((e) => e.res.M.res), shr = (c) => (100 * res.filter((x) => x === c).length / res.length).toFixed(0);
    console.log(`\n${nm}: n ${evs.length}, ${dc(evs)} dates. ABSOLUTE P&L per trade: mean ${f3(mean(S.pts))} pts (${f3(mean(S.pts) * PTV)} dollars), median ${f3(median(S.pts))} pts; stopped ${shr('S')}%, time-exit ${shr('C')}%, TARGET ${shr('T')}% (must be 0); worst ${f3(Math.min(...S.pts))} pts; top-5-trades share of total ${top5(S.pts)}, top-5-dates share ${top5d(evs)}; mean stop ${f3(mean(evs.map((e) => e.res.M.stopPts)))} pts`);
    const mir = evs.filter((e) => e.res.M.mirror != null).map((e) => ({ day: e.day, v: e.res.M.pnl - e.res.M.mirror })), fr = evs.filter((e) => e.res.FREE).map((e) => ({ day: e.day, v: e.res.M.pnl - e.res.FREE.pnl })), x1 = stat(evs, 'M', 'ctlK1');
    console.log(`  all dates: blind-entry mean ${f3(mean(evs.map((e) => e.res.M.ctl)))} | EXCESS ${fmt(mean(S.exc.map((x) => x.v)), ci(S.exc, 0.025, nm + 'all'))} pts | EXCESS-K1 (vs fresh K=1 births, same clock) ${fmt(mean(x1.exc.map((x) => x.v)), ci(x1.exc, 0.025, nm + 'k1'))} n${x1.exc.length} | real minus MIRROR ${fmt(mean(mir.map((x) => x.v)), ci(mir, 0.025, nm + 'mir'))} | M minus exit-free (effect of the stop) ${fmt(mean(fr.map((x) => x.v)), ci(fr, 0.025, nm + 'free'))}`);
    let v = 'UNDERPOWERED (explore)', ea = `n=${A.length}/${dc(A)}d`, ha = `n=${Hh.length}/${dc(Hh)}d`;
    if (!under(A)) {
      tested++; const sa = stat(A, 'M'), c = ci(sa.exc, 0.0125, nm + 'a'), ka = stat(A, 'M', 'ctlK1'); ea = `${fmt(mean(sa.exc.map((x) => x.v)), c)} n=${A.length}/${dc(A)}d, abs ${f3(mean(sa.pts))}, K1-excess ${f3(mean(ka.exc.map((x) => x.v)))}, without top date ${f3(dropTopDate(sa.exc))}`;
      const cand = c.lo > 0; if (cand) cands++; if (!cand) v = 'no'; else if (under(Hh)) v = 'CANDIDATE, hold-out UNDERPOWERED';
      else { const sh = stat(Hh, 'M'), ch = ci(sh.exc, 0.025, nm + 'h'), kh = stat(Hh, 'M', 'ctlK1'); ha = `${fmt(mean(sh.exc.map((x) => x.v)), ch)} n=${Hh.length}/${dc(Hh)}d, abs ${f3(mean(sh.pts))}, K1-excess ${f3(mean(kh.exc.map((x) => x.v)))}, without top date ${f3(dropTopDate(sh.exc))}`;
        const ok = mean(sh.exc.map((x) => x.v)) > 0 && ch.lo > 0 && mean(sa.exc.map((x) => x.v)) > 0 && dropTopDate(sa.exc) > 0 && dropTopDate(sh.exc) > 0;
        if (!ok) v = 'candidate, not a survivor'; else { surv++; const loc = mean(ka.exc.map((x) => x.v)) > 0 && mean(kh.exc.map((x) => x.v)) > 0; v = !loc ? 'SCREEN-SURVIVOR but level-location artifact (K1 excess not positive in both halves)' : mean(sa.pts) > 0 && mean(sh.pts) > 0 ? 'SCREEN-SURVIVOR and absolute net positive in both halves = usable lead' : 'SCREEN-SURVIVOR but absolute net not positive in both halves = not usable'; } }
    } else if (Hh.length) { const sh = stat(Hh, 'M'); ha += `, abs ${f3(mean(sh.pts))}`; }
    console.log(`  explore ${ea}\n  hold-out ${ha}\n  => ${v}`);
  }
  console.log(`CELLS TESTED ${tested} (of 2), CANDIDATES ${cands}, expected by chance about ${(tested * 0.025).toFixed(2)}, SCREEN-SURVIVORS ${surv}`);
  console.log('\nSENSITIVITY (descriptive, all dates, no verdict): arm | side | n | mean P&L pts | blind-entry mean pts | EXCESS mean [95% date-blocked CI] | stopped %');
  for (const nm of Object.keys(ARMS)) for (const side of ['floor', 'top']) { const evs = events.filter((e) => e.side === side && e.res[nm] && e.res[nm].ctl != null); if (!evs.length) continue; const exc = evs.map((e) => ({ day: e.day, v: e.res[nm].pnl - e.res[nm].ctl })); console.log(`  ${nm.padEnd(7)} ${side.padEnd(5)} n ${String(evs.length).padStart(3)} | ${f3(mean(evs.map((e) => e.res[nm].pnl)))} | ${f3(mean(evs.map((e) => e.res[nm].ctl)))} | ${fmt(mean(exc.map((x) => x.v)), ci(exc, 0.025, nm + side))} | stopped ${(100 * evs.filter((e) => e.res[nm].res === 'S').length / evs.length).toFixed(0)}%`); }
  const over = (side) => { const e = events.filter((x) => x.side === side).sort((a, b) => a.i0 - b.i0); let k = 0; for (let i = 1; i < e.length; i++) if (NQ.EM[e[i].i0] - NQ.EM[e[i - 1].i0] < 1440) k++; return (100 * k / Math.max(1, e.length - 1)).toFixed(0); };
  console.log(`\noverlap: events starting within 1,440 minutes of the previous same-side event: floors ${over('floor')}%, tops ${over('top')}%`);
  fs.writeFileSync('scratch/four_hour_events_20261026.json', JSON.stringify({ endRow, cut, tested, cands, surv, events: all3.map((e) => { const x = events.find((y) => y.key === e.key); const r = x && x.res; return { key: e.key, side: e.side, day: e.day, t: e.t, t0: e.t0, i0: e.i0, level: e.level, drop: e.drop, relVol: e.relVol, band: e.band, H4: e.H4, d20: e.d20, sess: e.sess, pnlM: r?.M?.pnl ?? null, excM: r?.M && r.M.ctl != null ? r.M.pnl - r.M.ctl : null, pnlFree: r?.FREE?.pnl ?? null, excFree: r?.FREE && r.FREE.ctl != null ? r.FREE.pnl - r.FREE.ctl : null }; }) }));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
