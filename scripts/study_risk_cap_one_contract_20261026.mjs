// Pre-registered in docs/RISK_CAP_ONE_CONTRACT_PREREG_20261026.md (committed before this ran; see its Amendment if present).
import fs from 'fs';
import { query } from '../server/db.js';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { mean, pct } from './lib/floorEngine.mjs';
import { f3, blockBoot, strat } from './lib/floorStats.mjs';

const PRIOR = 60, PLAC = 10000, f1 = (x) => (x == null || Number.isNaN(x) ? '  n/a' : (x >= 0 ? '+' : '') + x.toFixed(1));
const sumTo = (a) => a.reduce((s, x) => s + x, 0);
function dayStats(daysArr) { // daysArr: array of arrays of pnl (kept trades) -> total, worst day, max drawdown on the cumulative daily series
  let cum = 0, peak = 0, dd = 0, worst = Infinity, tot = 0; for (const d of daysArr) { const p = sumTo(d); tot += p; cum += p; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); worst = Math.min(worst, p); } return { tot, worst, dd };
}
// generalized S2: improvements in worst day and max drawdown (and total change) from the real skip set, a random-skip placebo with the same per-day counts, and a deterministic
// magnitude ceiling (skip the same number of the largest-|value| trades per day). val(e) = dollars or R.
function s2g(pool, val, seed, trials = PLAC) {
  const daysU = [...new Set(pool.map((e) => e.d))].sort(), byD = daysU.map((d) => pool.filter((e) => e.d === d)), V = (a) => a.map(val);
  const all = dayStats(byD.map(V)), real = dayStats(byD.map((a) => V(a.filter((e) => !e.skip))));
  const ceil = dayStats(byD.map((a) => { const m = a.filter((e) => e.skip).length; return V([...a].sort((x, y) => Math.abs(val(y)) - Math.abs(val(x))).slice(m)); }));
  const rng = mulberry32(hashSeed(seed)), dW = [], dD = [], dT = [];
  for (let t = 0; t < trials; t++) { const arr = byD.map((a) => { const m = a.filter((e) => e.skip).length; if (!m) return V(a); const idx = a.map((_, i) => i); for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; } const drop = new Set(idx.slice(0, m)); return V(a.filter((_, i) => !drop.has(i))); }); const x = dayStats(arr); dW.push(x.worst - all.worst); dD.push(all.dd - x.dd); dT.push(x.tot - all.tot); }
  dW.sort((a, b) => a - b); dD.sort((a, b) => a - b); dT.sort((a, b) => a - b);
  return { days: daysU.length, nSkip: pool.filter((e) => e.skip).length, all, real, dWorst: real.worst - all.worst, dDD: all.dd - real.dd, dTot: real.tot - all.tot, pW: dW[Math.floor(0.975 * trials)], pD: dD[Math.floor(0.975 * trials)], pT: dT[Math.floor(0.5 * trials)], ceilWorst: ceil.worst - all.worst, ceilDD: all.dd - ceil.dd };
}
async function main() {
  const rows = (await query(`SELECT setup_type st, trade_date::text d, origin_status o, fired_at::text f, ABS(entry_zone_low - stop_level)::float risk, actual_pnl::float p, (actual_pnl IS NULL OR resolution = 'NOT_FILLED') AS unres FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW') AND is_cluster_primary AND stop_level IS NOT NULL AND entry_zone_low IS NOT NULL
      AND ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE
      AND NOT (fired_at::time >= '16:00' AND fired_at::time < '18:00') AND setup_type NOT LIKE 'POC_ROTATION_JOIN%' AND trade_date >= '2026-07-09' AND trade_date < CURRENT_DATE AND ABS(entry_zone_low - stop_level) > 0 ORDER BY trade_date`)).rows;
  const days = [...new Set(rows.map((r) => r.d))].sort(), byDay = new Map(days.map((d) => [d, []])); for (const r of rows) byDay.get(r.d).push(r);
  console.log(`rows ${rows.length} on ${days.length} days (${days[0]}..${days[days.length - 1]}); structural cap (risk > 500 pts = 1000 USD): ${rows.filter((r) => r.risk * 2 > 1000).length} trades, mean pnl ${f1(mean(rows.filter((r) => r.risk * 2 > 1000).map((r) => r.p)))}`);
  const out = {};
  for (const q of [90, 95]) {
    const ev = []; // evaluated trades with the skip decision
    for (let k = PRIOR; k < days.length; k++) { const prior = []; for (let j = k - PRIOR; j < k; j++) for (const r of byDay.get(days[j])) prior.push(r.risk); const cut = pct(prior, q / 100);
      // per-type prior median (expanding, >=10 prior trades of that type)
      for (const r of byDay.get(days[k]).filter((x) => !x.unres)) { const tp = []; for (let j = 0; j < k; j++) for (const x of byDay.get(days[j])) if (x.st === r.st && !x.unres) tp.push(x.risk); ev.push({ ...r, skip: r.risk > cut, typeMed: tp.length >= 10 ? pct(tp, 0.5) : null, day: r.d, cut, rnd: 0 }); } }
    const kept = ev.filter((e) => !e.skip), skipped = ev.filter((e) => e.skip), evDays = [...new Set(ev.map((e) => e.d))].sort(), cutDay = evDays[Math.floor(evDays.length * 0.6) - 1];
    console.log(`\n=== q=${q}: evaluated ${ev.length} trades on ${evDays.length} days; skipped ${skipped.length} (${(100 * skipped.length / ev.length).toFixed(0)}%); explore <= ${cutDay}`);
    const Rm = (e) => e.p / (2 * e.risk), s1R = (z) => mean(z.filter((e) => !e.skip).map(Rm)) - mean(z.filter((e) => e.skip).map(Rm)); const s1d = (z) => mean(z.filter((e) => !e.skip).map((e) => e.p)) - mean(z.filter((e) => e.skip).map((e) => e.p));
    const ci1 = blockBoot(ev, s1d, (e) => e.day, 'rc1' + q), est1 = s1d(ev);
    const wt = ev.filter((e) => e.typeMed != null).map((e) => ({ ...e, stratum: e.st, wide: e.risk > e.typeMed })), cnt = new Map(); for (const e of wt) cnt.set(e.st, (cnt.get(e.st) || 0) + 1);
    const priorN = (e) => rows.filter((x) => x.st === e.st && !x.unres && x.d < e.d).length; const gateCache = new Map(); const gate = (e) => { const k = e.st + '|' + e.d; if (!gateCache.has(k)) gateCache.set(k, priorN(e) >= 40); return gateCache.get(k); };
    const wtt = wt.filter((e) => gate(e)), s1w = (z) => -strat(z, (e) => e.wide, (e) => e.p), ci1w = blockBoot(wtt, (z) => -strat(z, (e) => e.wide, (e) => e.p), (e) => e.day, 'rc1w' + q), est1w = s1w(wtt);   // narrow minus wide within type (positive = wide is worse)
    const h = (f) => ({ a: f(ev.filter((e) => e.d <= cutDay)), b: f(ev.filter((e) => e.d > cutDay)) }), h1 = h(s1d), h1w = { a: s1w(wtt.filter((e) => e.d <= cutDay)), b: s1w(wtt.filter((e) => e.d > cutDay)) };
    console.log(`S1 pooled KEPT minus SKIPPED per-trade mean: ${f1(est1)} CI [${f1(ci1.lo)},${f1(ci1.hi)}], halves ${f1(h1.a)} / ${f1(h1.b)} (kept mean ${f1(mean(kept.map((e) => e.p)))}, skipped mean ${f1(mean(skipped.map((e) => e.p)))})`);
    { const ciR = blockBoot(ev, s1R, (e) => e.day, 'rcR' + q); console.log(`S1 pooled in R terms (pnl per dollar of risk) KEPT minus SKIPPED: ${s1R(ev).toFixed(3)} CI [${ciR.lo.toFixed(3)},${ciR.hi.toFixed(3)}]`); out['R' + q] = { est: s1R(ev), ci: ciR }; }
    console.log(`S1 within-type NARROW minus WIDE (types with >=40 trades: ${cnt.size ? [...cnt].filter(([, c]) => c >= 40).length : 0}, ${wtt.length} trades): ${f1(est1w)} CI [${f1(ci1w.lo)},${f1(ci1w.hi)}], halves ${f1(h1w.a)} / ${f1(h1w.b)}`);
    // S2 account-level
    const s2 = (subsetDays) => { const dayArr = subsetDays.map((d) => ev.filter((e) => e.d === d)); const all = dayStats(dayArr.map((a) => a.map((e) => e.p))), real = dayStats(dayArr.map((a) => a.filter((e) => !e.skip).map((e) => e.p))); const rng = mulberry32(hashSeed('plc' + q + subsetDays[0])), dW = [], dD = [], dT = [];
      for (let t = 0; t < PLAC; t++) { const arr = dayArr.map((a) => { const m = a.filter((e) => e.skip).length; if (!m) return a.map((e) => e.p); const idx = a.map((_, i) => i); for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; } const drop = new Set(idx.slice(0, m)); return a.filter((_, i) => !drop.has(i)).map((e) => e.p); }); const s = dayStats(arr); dW.push(s.worst - all.worst); dD.push(all.dd - s.dd); dT.push(s.tot - all.tot); }
      dW.sort((a, b) => a - b); dD.sort((a, b) => a - b); dT.sort((a, b) => a - b); return { all, real, dWorst: real.worst - all.worst, dDD: all.dd - real.dd, dTot: real.tot - all.tot, pW: dW[Math.floor(0.975 * PLAC)], pD: dD[Math.floor(0.975 * PLAC)], pT: dT[Math.floor(0.5 * PLAC)] }; };
    const S2 = { all: s2(evDays), a: s2(evDays.filter((d) => d <= cutDay)), b: s2(evDays.filter((d) => d > cutDay)) };
    for (const [nm, r] of [['pooled', S2.all], ['explore', S2.a], ['hold-out', S2.b]]) console.log(`S2 ${nm.padEnd(8)}: total ${f1(r.all.tot)} -> ${f1(r.real.tot)} (change ${f1(r.dTot)}; placebo median ${f1(r.pT)}) | worst day ${f1(r.all.worst)} -> ${f1(r.real.worst)} (improvement ${f1(r.dWorst)}; placebo p97.5 ${f1(r.pW)}) | max drawdown ${f1(r.all.dd)} -> ${f1(r.real.dd)} (improvement ${f1(r.dDD)}; placebo p97.5 ${f1(r.pD)})`);
    const fr = (x, nd = 1) => (x == null || Number.isNaN(x) ? 'n/a' : (x >= 0 ? '+' : '') + x.toFixed(nd));
    const S2R = s2g(ev, (e) => e.p / (2 * e.risk), 'plcR' + q), S2A = s2g(ev.filter((e) => e.o === 'ACTIVE'), (e) => e.p, 'plcA' + q, 4000);
    console.log(`S2 in R terms (pooled): worst R-day improvement ${fr(S2R.dWorst, 2)} (placebo p97.5 ${fr(S2R.pW, 2)}, magnitude ceiling ${fr(S2R.ceilWorst, 2)}) | max R-drawdown improvement ${fr(S2R.dDD, 2)} (placebo p97.5 ${fr(S2R.pD, 2)}, ceiling ${fr(S2R.ceilDD, 2)}) | total R change ${fr(S2R.dTot, 2)} (placebo median ${fr(S2R.pT, 2)})`);
    console.log(`S2 dollars, ACTIVE-origin series only (${S2A.days} days, ${S2A.nSkip} skipped): worst day ${fr(S2A.dWorst)} (placebo p97.5 ${fr(S2A.pW)}) | max drawdown ${fr(S2A.dDD)} (placebo p97.5 ${fr(S2A.pD)}) | total ${fr(S2A.dTot)} (placebo median ${fr(S2A.pT)})`);
    { const dd = S2.all; const dolCeil = s2g(ev, (e) => e.p, 'plcC' + q, 1); console.log(`   [dollar magnitude ceiling, skipping the same number of the largest-|P&L| trades per day: worst day ${fr(dolCeil.ceilWorst)}, drawdown ${fr(dolCeil.ceilDD)}; real is ${fr(dd.dWorst)} / ${fr(dd.dDD)}]`); }
    const s1ok = ci1.lo > 0 && ci1w.lo > 0 && h1.a > 0 && h1.b > 0 && h1w.a > 0 && h1w.b > 0, s2ok = S2.all.dWorst > S2.all.pW && S2.all.dDD > S2.all.pD && S2.all.dTot >= S2.all.pT && S2.a.dWorst > 0 && S2.b.dWorst > 0 && S2.a.dDD > 0 && S2.b.dDD > 0 && S2R.dWorst > S2R.pW && S2R.dDD > S2R.pD;
    console.log(`VERDICT q=${q}${q === 90 ? ' (PRIMARY)' : ' (descriptive)'}: S1 ${s1ok ? 'SHOWN' : 'NOT SHOWN'} | S2 ${s2ok ? 'SHOWN' : 'NOT SHOWN'} (read the CI half-widths: S1 pooled +/-${((ci1.hi - ci1.lo) / 2).toFixed(1)}, within-type +/-${((ci1w.hi - ci1w.lo) / 2).toFixed(1)} dollars per trade)`);
    const bt = new Map(); for (const e of skipped) bt.set(e.st, (bt.get(e.st) || 0) + 1); console.log('  skipped by setup type (top 8):', [...bt].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, c]) => `${t} ${c}`).join(', '));
    const act = ev.filter((e) => e.o === 'ACTIVE'); console.log(`  [descriptive, ACTIVE-origin only] n=${act.length}, skipped ${act.filter((e) => e.skip).length}, kept mean ${f1(mean(act.filter((e) => !e.skip).map((e) => e.p)))}, skipped mean ${f1(mean(act.filter((e) => e.skip).map((e) => e.p)))}; R-multiple (pnl per dollar of risk) kept ${(mean(kept.map((e) => e.p / (2 * e.risk)))).toFixed(3)} skipped ${(mean(skipped.map((e) => e.p / (2 * e.risk)))).toFixed(3)}`);
    out['q' + q] = { skipped: skipped.length, n: ev.length, est1, ci1, est1w, ci1w, S2, s1ok, s2ok };
  }
  fs.writeFileSync('scratch/risk_cap_one_contract_20261026.json', JSON.stringify(out, null, 1));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
