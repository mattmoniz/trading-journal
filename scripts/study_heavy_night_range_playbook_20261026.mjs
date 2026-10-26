// Pre-registered in docs/HEAVY_NIGHT_RANGE_PLAYBOOK_PREREG_20261026.md + Amendment 1 (committed before this ran).
// Events from the night's OWN running range: S1 support-hold long / R1 resistance-hold short (tests of the range edge) and B1 break-up long / B2 break-down short (first clean break),
// split by the overnight tripwire flag (HEAVY vs NOT) at the last completed 30-minute checkpoint. Outcome E1a = event ret60 minus range-state- and flag-matched blind controls.
import fs from 'fs';
import { query } from '../server/db.js';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { loadBars, prep, neg, indexBars, fwdRet, clock, mean } from './lib/floorEngine.mjs';
import { MIN_DAYS, f3, qnt, blockBoot, dcount } from './lib/floorStats.mjs';
import { classify, BASELINE_NIGHTS, CHECKPOINT_STEP } from '../server/services/overnightTripwire.js';

const P = 1.0, M = 0.25, W = 50, NEED_MIN = 120, AGE = 60, CTRL_DRAWS = 10;
const elapsedOf = (c) => (c >= 1080 ? c - 1080 : c + 360);
async function main() {
  const endRow = (await query(`SELECT (MAX(ts)::date - 1)::text d FROM price_bars_primary WHERE symbol='NQ' AND ts >= CURRENT_DATE - 7 AND ts < CURRENT_DATE + 1`)).rows[0].d;
  const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2023-03-06', endRow))), NQn = neg(NQ);
  console.log(`NQ bars to ${endRow}: ${NQ.n}`);
  // overnight checkpoint table -> flag(night, checkpoint)
  const rows = (await query(`SELECT trade_date::text d, checkpoint_min c, volume::float v, legs FROM overnight_checkpoint_stats ORDER BY trade_date, checkpoint_min`)).rows;
  const tab = new Map(); for (const r of rows) (tab.get(r.d) || tab.set(r.d, new Map()).get(r.d)).set(r.c, r); const nightsList = [...tab.keys()].sort(), pos = new Map(nightsList.map((d, i) => [d, i]));
  const flagCache = new Map();
  const flagAt = (night, elapsed) => { const cp = Math.min(Math.floor(elapsed / CHECKPOINT_STEP) * CHECKPOINT_STEP, 930); if (cp < NEED_MIN) return null; const k = night + '|' + cp; if (flagCache.has(k)) return flagCache.get(k); const i = pos.get(night); let v = null; if (i !== undefined && i >= BASELINE_NIGHTS) { const t = tab.get(night).get(cp); const prior = nightsList.slice(i - BASELINE_NIGHTS, i).map((d) => tab.get(d).get(cp)).filter(Boolean); if (t) v = classify({ vol: t.v, legs: t.legs, baseVols: prior.map((x) => x.v), baseLegs: prior.map((x) => x.legs) }).level; } flagCache.set(k, v); return v; };
  // group bars by night (Globex only)
  const nights = new Map(); for (let i = 0; i < NQ.n; i++) { const c = clock(NQ.T[i]); if (c >= 570 && c < 1080) continue; (nights.get(NQ.TD[i]) || nights.set(NQ.TD[i], []).get(NQ.TD[i])).push(i); }
  const events = [], elig = { S1: new Map(), B1: new Map() };   // eligible control bars per type per flag class
  const run = (B, side) => {
    for (const [night, idxs] of nights) {
      if (idxs.length < 600 || !pos.has(night)) continue; const a = NQ.A15[night]; if (!a) continue; const zone = P * a, turn = M * a;
      let runLo = Infinity, runHi = -Infinity, iLo = -1, iHi = -1, test = null, brokeUp = false;
      for (let q = 0; q < idxs.length; q++) {
        const i = idxs[q], c = clock(NQ.T[i]), e = elapsedOf(c), established = q > 0 && runHi - runLo >= 2 * a && NQ.EM[i] - NQ.EM[iLo] >= AGE && NQ.EM[i] - NQ.EM[iHi] >= AGE && e >= NEED_MIN;
        const fl = established ? flagAt(night, e) : null, cls = fl === 'HEAVY' ? 'HEAVY' : fl ? 'NOT' : null;
        // eligible blind-control bars: range established and no test / no break active
        if (established && cls) { if (B.L[i] > runLo + zone && !test) (elig.S1.get(side + cls) || elig.S1.set(side + cls, []).get(side + cls)).push({ i, night, c }); if (B.C[i] <= runHi + turn) (elig.B1.get(side + cls) || elig.B1.set(side + cls, []).get(side + cls)).push({ i, night, c }); }
        // S1: test of the range low
        if (test) { test.minL = Math.min(test.minL, B.L[i]); if (B.L[i] < test.fLr - zone || B.L[i] > test.fLr + 2 * zone || NQ.EM[i] - NQ.EM[test.i] > W) test = null; else if (B.C[i] - test.minL >= turn && cls && i + 1 < NQ.n) { events.push({ type: 'S1', side, night, i, e, cls, a, i0: i + 1, clk: clock(NQ.T[i + 1]) }); test = null; } }
        else if (established && B.L[i] <= runLo + zone && q > 0 && B.L[idxs[q - 1]] > runLo + zone) { if (B.L[i] >= runLo - zone) test = { i, fLr: runLo, minL: B.L[i] }; }
        // B1: first clean break of the established high edge
        if (established && !brokeUp && B.C[i] > runHi + turn && cls && i + 1 < NQ.n) { brokeUp = true; events.push({ type: 'B1', side, night, i, e, cls, a, i0: i + 1, clk: clock(NQ.T[i + 1]) }); }
        if (B.L[i] < runLo) { runLo = B.L[i]; iLo = i; } if (B.H[i] > runHi) { runHi = B.H[i]; iHi = i; } if (iLo < 0) { runLo = B.L[i]; runHi = B.H[i]; iLo = iHi = i; }
      }
    }
  };
  run(NQ, 'long'); run(NQn, 'short');
  const rng = mulberry32(hashSeed('playbook'));
  for (const ev of events) {
    const B = ev.side === 'long' ? NQ : NQn; ev.ret60 = fwdRet(B, ev.i0, 60, ev.a); ev.ret240 = fwdRet(B, ev.i0, 240, ev.a); if (ev.ret60 == null) { ev.drop = true; continue; }
    const pool = elig[ev.type].get(ev.side + ev.cls) || [], ctl = []; for (let t = 0; t < 300 && ctl.length < CTRL_DRAWS && pool.length; t++) { const c = pool[Math.floor(rng() * pool.length)]; if (c.night === ev.night || Math.abs(c.c - ev.clk) > 30) continue; const r = fwdRet(B, c.i + 1, 60, NQ.A15[c.night]); if (r != null) ctl.push(r); }
    ev.ctl = ctl.length >= 3 ? mean(ctl) : null; ev.e1a = ev.ctl == null ? null : ev.ret60 - ev.ctl;
  }
  const ok = events.filter((e) => !e.drop);
  // events per night and window overlap
  const per = new Map(); for (const e of ok) per.set(e.night + e.type + e.side, (per.get(e.night + e.type + e.side) || 0) + 1);
  console.log(`events ${ok.length} (S1 ${ok.filter((e) => e.type === 'S1' && e.side === 'long').length}/R1 ${ok.filter((e) => e.type === 'S1' && e.side === 'short').length}, B1 ${ok.filter((e) => e.type === 'B1' && e.side === 'long').length}/B2 ${ok.filter((e) => e.type === 'B1' && e.side === 'short').length}); max events per night per type ${Math.max(...per.values())}; HEAVY ${ok.filter((e) => e.cls === 'HEAVY').length}, NOT ${ok.filter((e) => e.cls === 'NOT').length}`);
  const dayList = [...new Set(ok.map((e) => e.night))].sort(), cut = dayList[Math.floor(dayList.length * 0.6) - 1], names = { 'S1long': 'S1 support-hold LONG', 'S1short': 'R1 resistance-hold SHORT', 'B1long': 'B1 break-up LONG', 'B1short': 'B2 break-down SHORT' };
  const cell = (rs, label) => { const u = rs.filter((e) => e.e1a != null), d = dcount(u.map((e) => ({ day: e.night }))); if (d < MIN_DAYS) return { n: u.length, days: d, under: true }; const st = (z) => mean(z.map((e) => e.e1a)); const items = u.map((e) => ({ ...e, day: e.night, seq: e.night })); return { n: u.length, days: d, est: st(items), ci: blockBoot(items, st, (e) => e.seq, label) }; };
  let tested = 0, cands = 0, surv = 0; const out = {};
  console.log('\n type                         flag  | explore n/nights E1a [CI]            | hold-out n/nights E1a [CI]           | verdict');
  for (const key of ['S1long', 'B1long', 'S1short', 'B1short']) for (const cls of ['HEAVY', 'NOT']) {
    const rs = ok.filter((e) => e.type + e.side === key && e.cls === cls), a = cell(rs.filter((e) => e.night <= cut), key + cls + 'ex'), b = cell(rs.filter((e) => e.night > cut), key + cls + 'ho');
    let v = 'not tested (explore underpowered)'; if (!a.under) { tested++; const cand = a.ci.lo > 0; if (cand) cands++; v = !cand ? 'no' : b.under ? 'CANDIDATE, hold-out UNDERPOWERED' : (b.est > 0 && b.ci.lo > 0 && a.est > 0 ? 'SCREEN-SURVIVOR' : 'candidate, not a survivor'); if (v === 'SCREEN-SURVIVOR') surv++; }
    const fm = (c) => (c.under ? `${c.n}/${c.days}n UNDERPOWERED` : `${c.n}/${c.days}n ${f3(c.est)} [${f3(c.ci.lo)},${f3(c.ci.hi)}]`); console.log(` ${names[key].padEnd(28)} ${cls.padEnd(5)} | ${fm(a).padEnd(36)} | ${fm(b).padEnd(36)} | ${v}`); out[key + cls] = { a, b, v };
    const r60 = rs.map((e) => e.ret60), r240 = rs.filter((e) => e.ret240 != null).map((e) => e.ret240); if (rs.length >= 10) console.log(`     [descriptive base rates, all dates] n=${rs.length}: P(ret60>0) ${(100 * r60.filter((x) => x > 0).length / r60.length).toFixed(0)}%, P(ret240>0) ${(100 * r240.filter((x) => x > 0).length / r240.length).toFixed(0)}%, ret60 quartiles ${[0.25, 0.5, 0.75].map((q) => qnt(r60, q).toFixed(2)).join(' / ')} A15, mean E1a ${f3(mean(rs.filter((e) => e.e1a != null).map((e) => e.e1a)))}`);
  }
  console.log(`\nCELLS TESTED ${tested} (of 8 counted), CANDIDATES ${cands}, expected by chance about ${(tested * 0.025).toFixed(1)}, SCREEN-SURVIVORS ${surv}; explore <= ${cut}`);
  for (const key of ['S1long', 'B1long', 'S1short', 'B1short']) { const h = ok.filter((e) => e.type + e.side === key && e.cls === 'HEAVY' && e.e1a != null), n = ok.filter((e) => e.type + e.side === key && e.cls === 'NOT' && e.e1a != null); if (h.length && n.length) console.log(`  [descriptive] ${names[key]} HEAVY minus NOT E1a: ${f3(mean(h.map((e) => e.e1a)) - mean(n.map((e) => e.e1a)))} (HEAVY n ${h.length}, NOT n ${n.length})`); }
  fs.writeFileSync('scratch/heavy_night_range_playbook_20261026.json', JSON.stringify({ endRow, tested, cands, surv, out }, null, 1));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
