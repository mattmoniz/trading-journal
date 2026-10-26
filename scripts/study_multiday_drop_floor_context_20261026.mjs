// Pre-registered in docs/MULTIDAY_DROP_FLOOR_CONTEXT_PREREG_20261026.md (committed before this ran; read its Amendment if present).
// Our own wide-stop LONG setups (active_setups rows, firing as they fire), split by a fire-time picture: DROP (big fall over the previous 48 hours, top tercile in D20 units) AND FLOOR
// (the 18-hour low is >= 3 hours old and has been retested at least once). Outcomes: the setup's own P&L and the exit-free forward return at 240 / 1440 minutes vs a blind clock-matched long.
import fs from 'fs';
import { query } from '../server/db.js';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { loadBars, prep, indexBars, fwdRet, clock, mean } from './lib/floorEngine.mjs';
import { MIN_DAYS, f3, qnt, blockBoot, strat } from './lib/floorStats.mjs';

const dcount = (x) => new Set(x.map((e) => e.day)).size, f0 = (x) => (x == null || Number.isNaN(x) ? 'n/a' : (x >= 0 ? '+' : '') + x.toFixed(0));
async function main() {
  const rows = (await query(`SELECT id, setup_type st, trade_date::text d, fired_at::text f, origin_status o, entry_zone_low::float en, stop_level::float sl, t1_level::float t1, actual_pnl::float p FROM active_setups
    WHERE is_cluster_primary AND setup_type ~ '_LONG' AND actual_pnl IS NOT NULL AND resolution IS DISTINCT FROM 'NOT_FILLED' AND stop_level IS NOT NULL AND t1_level IS NOT NULL AND entry_zone_low IS NOT NULL
      AND ABS(entry_zone_low - stop_level) >= 70 AND origin_status IN ('BACKFILL','SHADOW','ACTIVE') AND ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE
      AND NOT (fired_at::time >= '16:00' AND fired_at::time < '18:00') AND setup_type NOT LIKE 'POC_ROTATION_JOIN%' AND setup_type NOT LIKE 'OVERNIGHT_ORDERFLOW%' AND trade_date >= '2023-04-15' AND trade_date < CURRENT_DATE ORDER BY fired_at`)).rows;
  const endRow = rows.reduce((m, r) => (r.d > m ? r.d : m), '2023-04-15');
  const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2023-03-06', endRow))), emap = new Map(NQ.T.map((t, i) => [t, i]));
  // D20 per trade date: mean full-session range of the 20 prior trade days
  const rng = new Map(); for (let i = 0; i < NQ.n; i++) { const o = rng.get(NQ.TD[i]) || { h: -Infinity, l: Infinity }; o.h = Math.max(o.h, NQ.H[i]); o.l = Math.min(o.l, NQ.L[i]); rng.set(NQ.TD[i], o); }
  const dl = [...rng.keys()].sort(), d20 = {}; dl.forEach((d, i) => { if (i >= 20) d20[d] = mean(dl.slice(i - 20, i).map((x) => rng.get(x).h - rng.get(x).l)); });
  console.log(`rows ${rows.length} (BACKFILL ${rows.filter((r) => r.o === 'BACKFILL').length}, SHADOW ${rows.filter((r) => r.o === 'SHADOW').length}, ACTIVE ${rows.filter((r) => r.o === 'ACTIVE').length}), bars to ${endRow}`);
  const ev = [];
  for (const r of rows) {
    const j = emap.get(r.f.slice(0, 16) + ':00'); const td = j === undefined ? null : NQ.TD[j]; const a = td && NQ.A15[td], D = td && d20[td]; if (j === undefined || !a || !D || j < 3000) continue;
    let hi48 = -Infinity, k = j - 1; while (k >= 0 && NQ.EM[j] - NQ.EM[k] <= 2880) { hi48 = Math.max(hi48, NQ.H[k]); k--; }
    let lowL = Infinity, iL = -1; k = j - 1; while (k >= 0 && NQ.EM[j] - NQ.EM[k] <= 1080) { if (NQ.L[k] <= lowL) { lowL = NQ.L[k]; iL = k; } k--; }   // oldest occurrence of the 18h low
    // oldest occurrence: the loop goes backwards with <=, so iL ends at the earliest index equal to the minimum
    let floor = false; if (iL >= 0 && NQ.EM[j] - NQ.EM[iL] >= 180) { let away = false, ret = 0, inZone = false; for (k = iL + 1; k < j; k++) { if (NQ.L[k] > lowL + 2 * a) { away = true; inZone = false; } else if (away && NQ.L[k] <= lowL + a && !inZone) { ret++; inZone = true; away = false; } } floor = ret >= 1; }
    const floorIdx = floor ? iL : -1;
    const stop = Math.abs(r.en - r.sl), tgt = Math.abs(r.t1 - r.en);
    ev.push({ ...r, j, day: r.d, a, D, drop: (hi48 - NQ.C[j - 1]) / D, floor, floorIdx, moon: tgt >= 0.8 * stop, stratum: r.st, ret240: fwdRet({ ...NQ }, j, 240, D) == null ? null : (NQ.C[NQ.byEm.get(NQ.EM[j] + 239)] - r.en) / D, ret1440: NQ.byEm.get(NQ.EM[j] + 1439) === undefined ? null : (NQ.C[NQ.byEm.get(NQ.EM[j] + 1439)] - r.en) / D });
  }
  const days = [...new Set(ev.map((e) => e.day))].sort(), cut = days[Math.floor(days.length * 0.6) - 1], dropCut = qnt(ev.filter((e) => e.day <= cut && Number.isFinite(e.drop)).map((e) => e.drop), 2 / 3);
  for (const e of ev) e.ctx = e.drop >= dropCut && e.floor;
  // clock-matched blind long controls
  const bars = []; for (let i = 0; i < NQ.n; i += 15) bars.push(i); const r2 = mulberry32(hashSeed('mdf'));
  const ctlOf = (e, h) => { const out = []; for (let t = 0; t < 400 && out.length < 10; t++) { const b = bars[Math.floor(r2() * bars.length)]; if (NQ.TD[b] === e.day || Math.abs(clock(NQ.T[b]) - clock(NQ.T[e.j])) > 30 || !d20[NQ.TD[b]] || b + 1 >= NQ.n) continue; const x = NQ.byEm.get(NQ.EM[b + 1] + h - 1); if (x !== undefined) out.push((NQ.C[x] - NQ.O[b + 1]) / d20[NQ.TD[b]]); } return out.length >= 3 ? mean(out) : null; };
  const regimeBars = []; for (const b of bars) { const td = NQ.TD[b], a = NQ.A15[td], D = d20[td]; if (!a || !D || b < 3000 || NQ.T[b].slice(0, 10) < '2023-05-01') continue; const c = clock(NQ.T[b]); if (c >= 570 && c < 1080 && false) continue;
    let hi = -Infinity, k = b - 1; while (k >= 0 && NQ.EM[b] - NQ.EM[k] <= 2880) { hi = Math.max(hi, NQ.H[k]); k--; } if ((hi - NQ.C[b - 1]) / D < dropCut) continue;
    let lw = Infinity, iL = -1; k = b - 1; while (k >= 0 && NQ.EM[b] - NQ.EM[k] <= 1080) { if (NQ.L[k] <= lw) { lw = NQ.L[k]; iL = k; } k--; } if (iL < 0 || NQ.EM[b] - NQ.EM[iL] < 180) continue;
    let away = false, ret = 0, inZ = false; for (k = iL + 1; k < b; k++) { if (NQ.L[k] > lw + 2 * a) { away = true; inZ = false; } else if (away && NQ.L[k] <= lw + a && !inZ) { ret++; inZ = true; away = false; } } if (ret >= 1) regimeBars.push(b); }
  console.log(`regime-matched control bars (every 15th bar where DROP and FLOOR hold): ${regimeBars.length}`);
  const regOf = (e, h) => { const out = []; for (let t = 0; t < 600 && out.length < 10 && regimeBars.length; t++) { const b = regimeBars[Math.floor(r2() * regimeBars.length)]; if (NQ.TD[b] === e.day || Math.abs(clock(NQ.T[b]) - clock(NQ.T[e.j])) > 30 || b + 1 >= NQ.n) continue; const x = NQ.byEm.get(NQ.EM[b + 1] + h - 1); if (x !== undefined) out.push((NQ.C[x] - NQ.O[b + 1]) / d20[NQ.TD[b]]); } return out.length >= 3 ? mean(out) : null; };
  for (const e of ev) { const c240 = ctlOf(e, 240), c1440 = ctlOf(e, 1440); if (e.drop >= dropCut && e.floor) { e.reg1440 = regOf(e, 1440); e.reg240 = regOf(e, 240); } e.x240 = e.ret240 != null && c240 != null ? e.ret240 - c240 : null; e.x1440 = e.ret1440 != null && c1440 != null ? e.ret1440 - c1440 : null; }
  console.log(`evaluated ${ev.length} rows on ${days.length} dates; DROP cut (top tercile of explore) = ${dropCut.toFixed(2)} D20; CONTEXT (drop and floor) rows ${ev.filter((e) => e.ctx).length} (${(100 * ev.filter((e) => e.ctx).length / ev.length).toFixed(1)}%) on ${dcount(ev.filter((e) => e.ctx))} dates; DROP only ${ev.filter((e) => e.drop >= dropCut && !e.floor).length}, FLOOR only ${ev.filter((e) => e.drop < dropCut && e.floor).length}; moonshot-like ${ev.filter((e) => e.moon).length}`);
  const cellOf = (rs, val, label) => { const u = rs.filter((e) => val(e) != null && Number.isFinite(e.drop)); const c = u.filter((e) => e.ctx), o = u.filter((e) => !e.ctx); if (dcount(c) < MIN_DAYS || c.length < 30 || !o.length) return { nC: c.length, dC: dcount(c), under: true }; const st = (z) => strat(z, (e) => e.ctx, val); return { nC: c.length, dC: dcount(c), nO: o.length, est: st(u), ci: blockBoot(u, st, (e) => e.day, label) }; };
  let tested = 0, cands = 0, surv = 0; const out = {};
  console.log('\n outcome                         population         | explore  n_ctx/dates est [CI]                | hold-out n_ctx/dates est [CI]       | verdict');
  for (const [pn, pf] of [['all wide-stop longs', () => true], ['moonshot-like (target>=0.8 stop)', (e) => e.moon]]) for (const [on, val, fmt] of [['own P&L (dollars)', (e) => e.p, f0], ['ret1440 excess (D20)', (e) => e.x1440, f3]]) {
    const rs = ev.filter(pf), a = cellOf(rs.filter((e) => e.day <= cut), val, pn + on + 'ex'), b = cellOf(rs.filter((e) => e.day > cut), val, pn + on + 'ho');
    let v = 'not tested (explore underpowered)'; if (!a.under) { tested++; const cand = a.ci.lo > 0; if (cand) cands++; v = !cand ? 'no' : b.under ? 'CANDIDATE, hold-out UNDERPOWERED' : (b.est > 0 && b.ci.lo > 0 && a.est > 0 ? 'SCREEN-SURVIVOR' : 'candidate, not a survivor'); if (v === 'SCREEN-SURVIVOR') surv++; }
    const fm = (c) => (c.under ? `${c.nC}/${c.dC}d UNDERPOWERED` : `${c.nC}/${c.dC}d ${fmt(c.est)} [${fmt(c.ci.lo)},${fmt(c.ci.hi)}]`); console.log(` ${on.padEnd(31)} ${pn.padEnd(34)} | ${fm(a).padEnd(40)} | ${fm(b).padEnd(38)} | ${v}`); out[pn + on] = { a, b, v };
  }
  console.log(`\nCELLS TESTED ${tested} (of 4 counted), CANDIDATES ${cands}, expected by chance about ${(tested * 0.025).toFixed(1)}, SCREEN-SURVIVORS ${surv}; explore <= ${cut}`);
  const c = ev.filter((e) => e.ctx), o = ev.filter((e) => !e.ctx && Number.isFinite(e.drop));
  { const cc = c.filter((e) => e.ret1440 != null && e.x1440 != null && e.reg1440 != null); if (cc.length) console.log(`[regime-matched control, CONTEXT rows with all three] n=${cc.length}: mean ret1440 raw ${f3(mean(cc.map((e) => e.ret1440)))} | minus clock-matched control (excess) ${f3(mean(cc.map((e) => e.x1440)))} | minus REGIME-matched control (what the setup adds on top of being long in that picture) ${f3(mean(cc.map((e) => e.ret1440 - e.reg1440)))}  (mean regime control ${f3(mean(cc.map((e) => e.reg1440)))})`); const eff = new Set(c.map((e) => e.day + '|' + e.floorIdx)).size; console.log(`[overlap] CONTEXT rows ${c.length} correspond to ${eff} distinct (date, floor) events`); }
  console.log(`[descriptive] CONTEXT rows: mean own P&L ${f0(mean(c.map((e) => e.p)))} vs OTHER ${f0(mean(o.map((e) => e.p)))}; mean ret240 excess ${f3(mean(c.filter((e) => e.x240 != null).map((e) => e.x240)))} vs ${f3(mean(o.filter((e) => e.x240 != null).map((e) => e.x240)))}; mean ret1440 excess ${f3(mean(c.filter((e) => e.x1440 != null).map((e) => e.x1440)))} vs ${f3(mean(o.filter((e) => e.x1440 != null).map((e) => e.x1440)))}`);
  const by = new Map(); for (const e of c) by.set(e.st, (by.get(e.st) || 0) + 1); console.log('[descriptive] setup types in CONTEXT (top 8):', [...by].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([t, n]) => `${t} ${n}`).join(', '), '| by origin:', ['BACKFILL', 'SHADOW', 'ACTIVE'].map((g) => `${g} ${c.filter((e) => e.o === g).length}`).join(', '));
  const real = ev.filter((e) => e.o !== 'BACKFILL'); console.log(`[descriptive, real ACTIVE+SHADOW only] n=${real.length}: CONTEXT n=${real.filter((e) => e.ctx).length} mean own P&L ${f0(mean(real.filter((e) => e.ctx).map((e) => e.p)))} vs OTHER n=${real.filter((e) => !e.ctx).length} ${f0(mean(real.filter((e) => !e.ctx).map((e) => e.p)))}`);
  fs.writeFileSync('scratch/multiday_drop_floor_context_20261026.json', JSON.stringify({ endRow, tested, cands, surv, out }, null, 1));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
