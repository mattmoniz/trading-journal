// Pre-registered in docs/FOUR_HOUR_VOLUME_CUT_PREREG_20261026.md (committed before this ran; see its amendment for DeepSeek review changes).
// One cut: HEAVY = relative volume at the defended bars strictly above the explore-period median of that side. Contrast = mean excess HEAVY minus LIGHT, date-blocked,
// for X (exit-free +1,439 min, D20 units) and M (moonshot exit, points), floors and tops separately. Excess = outcome minus the mean of up to 30 clock-matched blind entries from the event's own partition.
import fs from 'fs';
import { query } from '../server/db.js';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { loadBars, prep, indexBars, clock, mean, addDay } from './lib/floorEngine.mjs';
import { f3 } from './lib/floorStats.mjs';
import { build4h, firstK3Events, d20Of, pinnedLimit } from './lib/fourHourLevels.mjs';
import { ARMS, makeSim, blindDraws, median, dc, diffCI, dropTopDate } from './lib/exitSim.mjs';

const FROZEN_CUT = process.env.FROZEN_CUT ? JSON.parse(process.env.FROZEN_CUT) : null; // forward look: {"floor":x,"top":y}, from this study's printed explore medians
const FROM = process.env.FORWARD_FROM || null; // forward look: only events dated on or after this
async function main() {
  const endRow = (await query(`SELECT (MAX(ts)::date - 3)::text d FROM price_bars_primary WHERE symbol='NQ' AND ts >= CURRENT_DATE - 7 AND ts < CURRENT_DATE + 1`)).rows[0].d;
  const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2023-03-06', endRow))), d20 = d20Of(NQ), { bars, h4 } = build4h(NQ), LIM = pinnedLimit(NQ, endRow);
  const { capOf, run, stopOf, strictOK } = makeSim(NQ);
  let events = firstK3Events(NQ, bars, h4, d20, 0.25, LIM).filter(strictOK); const noVol = events.filter((e) => e.relVol == null).length; events = events.filter((e) => e.relVol != null);
  console.log(`NQ bars to ${endRow} (pinned limit ${LIM}); first-K3 events with exit bar and relVol ${events.length} (floors ${events.filter((e) => e.side === 'floor').length}, tops ${events.filter((e) => e.side === 'top').length}); dropped for missing relVol ${noVol}`);
  const allDays = [...new Set(events.map((e) => e.day))].sort(), cut = FROM ? addDay(FROM, -1) : allDays[Math.floor(allDays.length * 0.6) - 1], cutSafe = addDay(cut, -4);
  for (const e of events) { const cap = capOf(e.i0, 1440, true); e.exitTD = NQ.TD[cap]; e.part = FROM ? (e.day >= FROM ? 'H' : 'A') : e.day <= cut ? 'A' : 'H'; e.straddle = e.part === 'A' && e.exitTD > cut; }
  const okDay = (p, day) => (p === 'A' ? day <= cutSafe : day > cut);
  const cutOf = {}; for (const side of ['floor', 'top']) { const a = events.filter((e) => e.side === side && e.part === 'A' && !e.straddle).map((e) => e.relVol); cutOf[side] = FROZEN_CUT ? FROZEN_CUT[side] : median(a); console.log(`  ${side} cut (${FROZEN_CUT ? 'FROZEN' : 'explore median'} of relVol, n=${a.length}): ${f3(cutOf[side])}`); }
  const rng = mulberry32(hashSeed('volcut')), samp = []; for (let i = 3100; i < LIM - 3000; i += 15) if (d20[NQ.TD[i]]) samp.push(i);
  const xRet = (i0, dir, day) => { const x = NQ.byEm.get(NQ.EM[i0] + 1439); return x === undefined ? null : dir * (NQ.C[x] - NQ.O[i0]) / d20[day]; };
  for (const e of events) {
    e.heavy = e.relVol > cutOf[e.side]; const draws = blindDraws(NQ, samp, rng, e, okDay), sp = stopOf(e, ARMS.M);
    const cx = draws.map((i) => xRet(i, e.dir, NQ.TD[i])).filter((v) => v != null), real = run(e.i0, e.dir, sp, Infinity, ARMS.M), cm = draws.map((i) => run(i, e.dir, sp, Infinity, ARMS.M)).filter(Boolean).map((r) => r.pnl);
    const xr = xRet(e.i0, e.dir, e.day); e.X = xr != null && cx.length >= 5 ? xr - mean(cx) : null; e.M = real && cm.length >= 5 ? real.pnl - mean(cm) : null; e.Mabs = real ? real.pnl : null;
  }
  console.log(`partition cut ${cut}; explore events dropped for straddling: ${events.filter((e) => e.straddle).length}`);
  const under = (a, b) => a.length < 15 || b.length < 15 || dc(a) < 15 || dc(b) < 15;
  let cands = 0, surv = 0, tested = 0; const rows = [];
  for (const side of ['floor', 'top']) for (const key of ['X', 'M']) {
    const S = events.filter((e) => e.side === side && e[key] != null), nm = `${side.toUpperCase()} ${key}`, pt = (z, h) => z.filter((e) => e.heavy === h).map((e) => ({ day: e.day, v: e[key] }));
    const A = S.filter((e) => e.part === 'A' && !e.straddle), H = S.filter((e) => e.part === 'H'), ah = pt(A, true), al = pt(A, false), hh = pt(H, true), hl = pt(H, false), dmean = (x, y) => mean(x.map((v) => v.v)) - mean(y.map((v) => v.v));
    const allH = pt(S, true), allL = pt(S, false), dAll = allH.length >= 5 && allL.length >= 5 ? diffCI(allH, allL, nm + 'all') : { lo: NaN, hi: NaN };
    let v = 'UNDERPOWERED (explore)', ea = `heavy n=${ah.length}/${dc(ah)}d light n=${al.length}/${dc(al)}d`, ha = `heavy n=${hh.length}/${dc(hh)}d light n=${hl.length}/${dc(hl)}d`;
    if (!under(ah, al)) {
      tested++; const c = diffCI(ah, al, nm + 'a', 4000, 0.0125), d = dmean(ah, al); ea = `${f3(d)} [${f3(c.lo)},${f3(c.hi)}] (heavy ${f3(mean(ah.map((x) => x.v)))}, light ${f3(mean(al.map((x) => x.v)))}) ${ea}`;
      const topless = (() => { const g = new Map(); for (const x of [...ah, ...al]) g.set(x.day, (g.get(x.day) || 0) + x.v); let bd = null, bv = -Infinity; for (const [dd, vv] of g) if (Math.abs(vv) > bv) { bv = Math.abs(vv); bd = dd; } return dmean(ah.filter((x) => x.day !== bd), al.filter((x) => x.day !== bd)); })();
      const cand = c.lo > 0; if (cand) cands++; if (!cand) v = 'no'; else if (under(hh, hl)) v = 'CANDIDATE, hold-out UNDERPOWERED'; else { const ch = diffCI(hh, hl, nm + 'h'), dh = dmean(hh, hl); ha = `${f3(dh)} [${f3(ch.lo)},${f3(ch.hi)}] ${ha}`; const ok = dh > 0 && ch.lo > 0 && d > 0 && topless > 0; v = ok ? 'SCREEN-SURVIVOR' : 'candidate, not a survivor'; if (ok) surv++; }
    }
    console.log(`\n${nm}: all dates HEAVY-LIGHT ${f3(dmean(allH, allL))} [${f3(dAll.lo)},${f3(dAll.hi)}] (heavy n ${allH.length}/${dc(allH)}d mean ${f3(mean(allH.map((x) => x.v)))} median ${f3(median(allH.map((x) => x.v)))}; light n ${allL.length}/${dc(allL)}d mean ${f3(mean(allL.map((x) => x.v)))} median ${f3(median(allL.map((x) => x.v))) })\n  explore ${ea}\n  hold-out ${ha}\n  => ${v}`);
    rows.push({ cell: nm, v });
  }
  console.log(`\nCELLS TESTED ${tested} (of 4), CANDIDATES ${cands}, expected by chance about ${(tested * 0.0125).toFixed(2)}, SCREEN-SURVIVORS ${surv}`);
  console.log('\nARM MIX (descriptive): side | arm | n | share RTH | mean relVol');
  for (const side of ['floor', 'top']) for (const h of [true, false]) { const z = events.filter((e) => e.side === side && e.heavy === h); console.log(`  ${side.padEnd(5)} ${h ? 'HEAVY' : 'LIGHT'} n ${String(z.length).padStart(3)} | RTH ${(100 * z.filter((e) => e.sess === 'RTH').length / z.length).toFixed(0)}% | mean relVol ${f3(mean(z.map((e) => e.relVol)))}`); }
  console.log('\nDESCRIPTIVE: slope / rank correlation of excess on relVol, all dates, by side and session');
  const rank = (a) => { const o = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]), r = new Array(a.length); o.forEach(([, i], k) => { r[i] = k; }); return r; };
  for (const side of ['floor', 'top']) for (const sess of ['ALL', 'RTH', 'GLOBEX']) for (const key of ['X', 'M']) { const z = events.filter((e) => e.side === side && e[key] != null && (sess === 'ALL' || e.sess === sess)); if (z.length < 10) { console.log(`  ${side} ${sess} ${key}: n ${z.length} (too few)`); continue; } const a = rank(z.map((e) => e.relVol)), b = rank(z.map((e) => e[key])), ma = mean(a), mb = mean(b); const rho = a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0) / Math.sqrt(a.reduce((s, x) => s + (x - ma) ** 2, 0) * b.reduce((s, x) => s + (x - mb) ** 2, 0)); const mx = mean(z.map((e) => e.relVol)), my = mean(z.map((e) => e[key])), sl = z.reduce((s, e) => s + (e.relVol - mx) * (e[key] - my), 0) / z.reduce((s, e) => s + (e.relVol - mx) ** 2, 0); console.log(`  ${side} ${sess} ${key}: n ${z.length} Spearman ${f3(rho)} slope ${f3(sl)} per 1.0x`); }
  const over = (side) => { const e = events.filter((x) => x.side === side).sort((a, b) => a.i0 - b.i0); let k = 0; for (let i = 1; i < e.length; i++) if (NQ.EM[e[i].i0] - NQ.EM[e[i - 1].i0] < 1440) k++; return (100 * k / Math.max(1, e.length - 1)).toFixed(0); };
  console.log(`\noverlap: events starting within 1,440 minutes of the previous same-side event: floors ${over('floor')}%, tops ${over('top')}%`);
  fs.writeFileSync(`scratch/four_hour_volume_cut_${FROM ? 'forward' : '20261026'}.json`, JSON.stringify({ endRow, cut, cutOf, tested, cands, surv, rows }, null, 1));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
