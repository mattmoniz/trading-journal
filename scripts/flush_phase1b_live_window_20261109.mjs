// FLUSH TEST PHASE 1b: OUTCOME-BLIND counts, geometry and Argon's five diagnostics on the LIVE-FAITHFUL Globex population (workplan item E, docs/WORKPLAN_20261109.md).
// Why: the backtest (and phase 1) only takes Globex departures in 15:59-16:29 ET on RTH dates; the live detector takes the first departure anywhere from 15:59 to 09:29 incl.
// Sundays. The enumerator findGlobexEventsLive() in scripts/lib/flushStudyLib.mjs mirrors the live detector and was validated against the 44 live rows (39 same type, 35 same
// fire time; every row since 2026-10-16 matches). No outcome is read here (no P&L/MFE/MAE/hits): only counts, geometry at the entry bar, calendar facts. Windows: explore <= 2025-05-16
// (detailed); 2025-05-17..2025-11-19 inflated (hr-070); >= 2025-11-20 sealed (counts only), except the skip-rate drift check (Metric 4) which uses geometry only.
import { loadLevels, loadBarsWithVolZ, groupBarsByDate, groupRthByDate, findGlobexDepartures, globexSequenceFor, loadFollowingLevels, makeAdrBefore, buildRthBlindEvents, buildGlobexBlindEventsLive, percentile, mean } from './lib/flushStudyLib.mjs';
import { computeBalanceAndResolution } from '../server/services/flushMechanics.js';

const EXPLORE_END = '2025-05-16', SEALED_START = '2025-11-20', LIVE_START = '2026-09-01';
const windowOf = (d) => (d <= EXPLORE_END ? 'explore' : d < SEALED_START ? 'inflated' : 'sealed');
const f1 = (v) => (v == null || !Number.isFinite(v) ? 'n/a' : Number(v).toFixed(1));
const pct = (v) => (v == null || !Number.isFinite(v) ? 'n/a' : (100 * v).toFixed(0) + '%');
const typeOf = (e) => (e.session === 'RTH' ? `RTH_FLUSH_${e.dir}` : e.mode === 'CONTINUATION' ? `GLOBEX_FLUSH_${e.dir}` : `GLOBEX_FLUSH_REVERSAL_${e.dir}`);
const groupOf = (e) => (e.session === 'RTH' ? 'RTH' : e.mode === 'CONTINUATION' ? 'GLOBEX_CONT' : 'GLOBEX_REV');
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function ranks(a) { const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; } return r; }
function pearson(x, y) { const n = x.length, mx = mean(x), my = mean(y); let c = 0, vx = 0, vy = 0; for (let i = 0; i < n; i++) { c += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) ** 2; vy += (y[i] - my) ** 2; } return vx > 0 && vy > 0 ? c / Math.sqrt(vx * vy) : null; }
const spearman = (x, y) => pearson(ranks(x), ranks(y));
const cov = (x, y) => { const mx = mean(x), my = mean(y); return x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) / x.length; };

async function main() {
  const { getLevelsForDate } = await loadLevels();
  const followingLevel = await loadFollowingLevels();
  const allBars = await loadBarsWithVolZ('1900-01-01');
  const barsByDate = groupBarsByDate(allBars), rthByDate = groupRthByDate(allBars);
  const adrBefore = makeAdrBefore(rthByDate);

  const rth = buildRthBlindEvents(rthByDate, getLevelsForDate, adrBefore);
  const gx = buildGlobexBlindEventsLive(barsByDate, followingLevel, adrBefore);
  const events = [...rth, ...gx].sort((a, b) => a.date.localeCompare(b.date));

  // backtest-window Globex events (15:59-16:29 only) for the overlap comparison
  const btKeys = new Set();
  for (const dep of findGlobexDepartures(rthByDate, barsByDate, getLevelsForDate)) {
    const seq = globexSequenceFor(allBars, dep); if (seq.length < 60) continue;
    const res = computeBalanceAndResolution(seq.slice(1)); if (!res) continue;
    const eb = seq[1 + res.resolutionIdx], mode = dep.dir === res.resolutionDir ? 'CONTINUATION' : 'REVERSAL';
    btKeys.add(`${dep.date}|${eb.ts.toISOString()}|${mode}|${res.resolutionDir === 'UP' ? 'LONG' : 'SHORT'}`);
  }

  console.log('A. LIVE-WINDOW Globex events vs the backtest-window events (all dates, entry bar identical = same day, time, mode, direction)');
  const gxKeys = gx.map((e) => `${e.date}|${e.entryTs.toISOString()}|${e.mode}|${e.dir}`);
  const both = gxKeys.filter((k) => btKeys.has(k)).length;
  console.log(`  live-window ${gx.length}; backtest-window ${btKeys.size}; identical ${both}; live-window only ${gx.length - both}; backtest-window only ${[...btKeys].filter((k) => !gxKeys.includes(k)).length}`);
  for (const w of ['explore', 'inflated', 'sealed']) { const g = gx.filter((e) => windowOf(e.date) === w); console.log(`  ${w.padEnd(9)} live-window ${g.length}; Sunday-session departure days ${g.filter((e) => e.dow === 0).length}`); }

  console.log('\nB. EVENTS / DAYS BY WINDOW, live-faithful population (one event per departure day)');
  for (const c of [...new Set(events.map(typeOf))].sort()) {
    console.log(`  ${c.padEnd(28)} ` + ['explore', 'inflated', 'sealed'].map((w) => `${w} ${events.filter((e) => typeOf(e) === c && windowOf(e.date) === w).length}`).join('   '));
  }
  const ex = events.filter((e) => windowOf(e.date) === 'explore');
  console.log('\nC. EXPLORE GEOMETRY (points): N, stop p10/p50/p90/max, stop/ADR20 p50,p90, stops >500pt');
  for (const c of [...new Set(ex.map(typeOf))].sort()) {
    const ev = ex.filter((e) => typeOf(e) === c), s = ev.map((e) => e.stopDist), r = ev.filter((e) => e.adr).map((e) => e.stopDist / e.adr);
    console.log(`  ${c.padEnd(28)} N ${String(ev.length).padStart(3)}  stop ${[0.1, 0.5, 0.9, 1].map((p) => f1(percentile(s, p))).join('/')}  stop/ADR ${pct(percentile(r, 0.5))},${pct(percentile(r, 0.9))}  >500: ${s.filter((x) => x > 500).length}`);
  }

  console.log('\nD. ARGON DIAGNOSTICS (explore, direction pooled within group; S=stop/ADR20, B=box/ADR20, K=50/ADR20, O=(stop-box-50)/ADR20)');
  const rows = [];
  for (const g of ['RTH', 'GLOBEX_CONT', 'GLOBEX_REV']) {
    const ev = ex.filter((e) => groupOf(e) === g && e.adr);
    const S = ev.map((e) => e.stopDist / e.adr), B = ev.map((e) => e.box / e.adr), K = ev.map((e) => 50 / e.adr), O = ev.map((e, i) => (e.stopDist - e.box - 50) / e.adr), A = ev.map((e) => e.adr);
    const p80S = percentile(S, 0.8), p80B = percentile(B, 0.8);
    const tailIdx = S.map((v, i) => (v > p80S ? i : -1)).filter((i) => i >= 0);
    const tS = tailIdx.map((i) => S[i]), v = cov(tS, tS);
    const share = (X) => (v > 0 ? cov(tailIdx.map((i) => X[i]), tS) / v : null);
    const TS = new Set(tailIdx), TB = new Set(B.map((x, i) => (x > p80B ? i : -1)).filter((i) => i >= 0));
    const inter = [...TS].filter((i) => TB.has(i)).length, uni = new Set([...TS, ...TB]).size;
    const sunAll = ev.filter((e) => e.dow === 0).length / ev.length, sunTail = tailIdx.filter((i) => ev[i].dow === 0).length / (tailIdx.length || 1);
    // Metric 4: expanding vs rolling-50 skip rates (p80 of S), final third of explore, and the live period (thresholds from ALL earlier events of the group, geometry only)
    const skipRate = (list, from, to, f) => { let sk = 0, n = 0, skR = 0; for (let i = from; i < to; i++) { const prior = list.slice(0, i).map(f); if (prior.length < 50) continue; const s = f(list[i]); n++; if (s > percentile(prior, 0.8)) sk++; if (s > percentile(prior.slice(-50), 0.8)) skR++; } return { n, exp: n ? sk / n : null, roll: n ? skR / n : null }; };
    const fS = (e) => e.stopDist / e.adr, fSp = (e) => (e.stopDist - 50) / e.adr;
    const grpAll = events.filter((e) => groupOf(e) === g && e.adr);
    const exN = grpAll.filter((e) => windowOf(e.date) === 'explore').length;
    const third = skipRate(grpAll, Math.floor(exN * 2 / 3), exN, fS), thirdP = skipRate(grpAll, Math.floor(exN * 2 / 3), exN, fSp);
    const liveFrom = grpAll.findIndex((e) => e.date >= LIVE_START);
    const live = liveFrom >= 0 ? skipRate(grpAll, liveFrom, grpAll.length, fS) : { n: 0 }, liveP = liveFrom >= 0 ? skipRate(grpAll, liveFrom, grpAll.length, fSp) : { n: 0 };
    const Sp = ev.map((e) => (e.stopDist - 50) / e.adr);
    rows.push({ g, n: ev.length, tailN: tailIdx.length, shB: share(B), shK: share(K), shO: share(O), dis: 1 - inter / (TS.size || 1), jac: inter / uni, rhoS: spearman(S, A), rhoSp: spearman(Sp, A), rhoB: spearman(B, A), third, thirdP, live, liveP, sunAll, sunTail });
  }
  for (const r of rows) {
    console.log(`  ${r.g.padEnd(12)} N ${r.n} (tail ${r.tailN}) | tail variance share: box ${pct(r.shB)} buffer ${pct(r.shK)} overshoot ${pct(r.shO)} | skip-set disagreement S vs B ${pct(r.dis)} (Jaccard ${r.jac.toFixed(2)})`);
    console.log(`               Spearman with ADR20: S ${f1(r.rhoS)} B ${f1(r.rhoB)} | skip rate final third of explore (n ${r.third.n}): expanding ${pct(r.third.exp)} rolling-50 ${pct(r.third.roll)} | live period (n ${r.live.n}): expanding ${pct(r.live.exp)} rolling-50 ${pct(r.live.roll)}`);
    console.log(`               WITHOUT the fixed 50pt (Sp=(stop-50)/ADR20): Spearman with ADR20 ${f1(r.rhoSp)} | skip rate final third expanding ${pct(r.thirdP.exp)} rolling-50 ${pct(r.thirdP.roll)} | live period expanding ${pct(r.liveP.exp)} rolling-50 ${pct(r.liveP.roll)}`);
    console.log(`               Sunday-session share: all events ${pct(r.sunAll)}, inside the S tail ${pct(r.sunTail)} (enrichment ${r.sunAll > 0 ? (r.sunTail / r.sunAll).toFixed(2) : 'n/a'}x)`);
  }
  console.log('\nE. S1 with DIRECTION-STRATIFIED expanding p80 (Argon): events it would skip in explore / eligible (needs 20 earlier events of the same group+direction)');
  for (const g of ['RTH', 'GLOBEX_CONT', 'GLOBEX_REV']) for (const d of ['LONG', 'SHORT']) {
    const list = ex.filter((e) => groupOf(e) === g && e.dir === d && e.adr); let sk = 0, el = 0, skP = 0;
    for (let i = 0; i < list.length; i++) { const prior = list.slice(0, i); if (prior.length < 20) continue; el++; if (list[i].stopDist / list[i].adr > percentile(prior.map((e) => e.stopDist / e.adr), 0.8)) sk++; if ((list[i].stopDist - 50) / list[i].adr > percentile(prior.map((e) => (e.stopDist - 50) / e.adr), 0.8)) skP++; }
    console.log(`  ${g.padEnd(12)} ${d.padEnd(5)} events ${String(list.length).padStart(3)} eligible ${String(el).padStart(3)} skipped ${String(sk).padStart(3)} (without the 50pt: ${String(skP).padStart(3)})`);
  }
  console.log(`\nweekday of Globex departure days (explore): ` + DOW.map((n, i) => `${n} ${ex.filter((e) => e.session === 'GLOBEX' && e.dow === i).length}`).join('  '));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
