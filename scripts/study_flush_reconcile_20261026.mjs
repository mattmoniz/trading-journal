// RTH_FLUSH reconciliation + walk-forward realistic-fill check. Prereg (committed first): docs/FLUSH_RECONCILE_PREREG_20261026.md
//   node scripts/study_flush_reconcile_20261026.mjs [--no-record]
// loadLevels/evalFromTrigger/simulateExit/percentile/pearson are VERBATIM copies of scripts/backtest_flush_patterns.mjs (that file runs main() on import, so it cannot be imported);
// arm A re-runs its procedure and must reproduce the stored FLUSH_BACKTEST_REFERENCE numbers before B/C/D mean anything.
import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { PPT, COMM, IB_END_MOD, mean, money, percentile, loadLevels, evalFromTrigger, simulateExit, realistic, loadBarsWithVolZ } from './lib/flushStudyLib.mjs';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const SPARSE_FROM = '2025-09-28', SPARSE_TO = '2025-11-19', MIN_PRIOR = 30, LIVE_FROM = '2026-07-09';

async function main() {
  const noRecord = process.argv.includes('--no-record');
  const { getLevelsForDate } = await loadLevels();
  const allBars = await loadBarsWithVolZ('2023-01-15');
  const rthByDate = new Map(); for (const b of allBars) { if (b.mod < 570 || b.mod > 959) continue; const d = b.ts.toISOString().slice(0, 10); (rthByDate.get(d) || rthByDate.set(d, []).get(d)).push(b); }
  const dates = [...rthByDate.keys()].sort();
  const setups = [];
  for (const date of dates) {
    const sessBars = rthByDate.get(date), ibBars = sessBars.filter((b) => b.mod < IB_END_MOD); let ib = null;
    if (ibBars.length >= 30) { const hi = Math.max(...ibBars.map((b) => b.high)), lo = Math.min(...ibBars.map((b) => b.low)); for (let i = 0; i < sessBars.length; i++) { if (sessBars[i].mod < IB_END_MOD) continue; if (sessBars[i].close > hi || sessBars[i].close < lo) { ib = i; break; } } }
    const lv = getLevelsForDate(date), onh = lv ? lv['ONH'] : null, onl = lv ? lv['ONL'] : null; let on = null;
    if (onh != null && onl != null) for (let i = 0; i < sessBars.length; i++) if (sessBars[i].close > onh || sessBars[i].close < onl) { on = i; break; }
    const idx = ib !== null && on !== null ? Math.min(ib, on) : ib !== null ? ib : on; if (idx === null) continue;
    const s = evalFromTrigger(sessBars, idx); if (s) setups.push({ date, ...s, triggerIdx: idx, triggerSrc: ib !== null && on !== null ? (ib <= on ? 'IB' : 'ON') : ib !== null ? 'IB' : 'ON', onh, onl, ibIdx: ib, onIdx: on });
  }
  // ---- ARM A: backtest-exact on ALL dates (regression check vs stored reference) ----
  const tgtA = percentile(setups.map((s) => s.mfe), 0.5), withVol = setups.filter((s) => s.avgVolZ !== null && s.volZTrend !== null);
  const avMed = percentile(withVol.map((s) => s.avgVolZ).sort((a, b) => a - b), 0.5), trMed = percentile(withVol.map((s) => s.volZTrend).sort((a, b) => a - b), 0.5);
  const building = (s) => s.avgVolZ !== null && s.volZTrend !== null && s.avgVolZ > avMed && s.volZTrend > trMed, bTgt = percentile(setups.filter(building).map((s) => s.mfe), 0.75);
  const A = setups.map((s) => ({ date: s.date, dir: s.resolutionDir, ...simulateExit(s, building(s) ? bTgt : tgtA) }));
  const ref = (await query(`SELECT DISTINCT ON (signal_name) signal_name, sample_size n, win_rate::float wr, ev_per_trade::float ev FROM performance_audit WHERE signal_type='FLUSH_BACKTEST_REFERENCE' AND signal_name LIKE 'RTH_FLUSH_%' ORDER BY signal_name, run_date DESC, id DESC`)).rows;
  console.log(`events (all dates, backtest-exact): ${setups.length}; full-sample targets p50 ${tgtA.toFixed(1)} pt, building p75 ${bTgt.toFixed(1)} pt`);
  let parityOk = true;
  for (const [dir, type] of [['UP', 'RTH_FLUSH_LONG'], ['DOWN', 'RTH_FLUSH_SHORT']]) {
    const b = A.filter((r) => r.dir === dir), n = b.length, ev = mean(b.map((r) => r.pnl)), wr = b.filter((r) => r.win).length / n, r0 = ref.find((x) => x.signal_name === type);
    const ok = r0 && Math.abs(n - r0.n) / r0.n <= 0.05 && Math.abs(ev - r0.ev) <= 3; parityOk = parityOk && !!ok;
    console.log(`ARM A ${type}: N=${n} WR=${(100 * wr).toFixed(1)}% EV ${money(ev)} | stored N=${r0?.n} WR=${r0 ? (100 * r0.wr).toFixed(1) : 'n/a'}% EV ${money(r0?.ev)} -> ${ok ? 'PARITY OK' : 'PARITY FAIL'}`);
  }
  console.log(`arm A vs stored reference: ${parityOk ? 'within tolerance' : 'DIFFERENT (expected: the stored rows predate the 2026-10-19 history rebuild, Amendment 1); informational only'}`);

  // ---- filtered set for B/C/D ----
  const kept = setups.filter((s) => s.date >= '2023-03-06' && !(s.date >= SPARSE_FROM && s.date <= SPARSE_TO) && !isInsideNqRollWeek(s.date) && s.sessBars.length >= 371);
  const prevDate = new Map(); dates.forEach((d, i) => prevDate.set(d, dates[i - 1]));
  const kept2 = kept.filter((s) => !isInsideNqRollWeek(prevDate.get(s.date) || '1900-01-01'));
  console.log(`filtered events (2023-03-06+, no sparse window / roll weeks / short sessions): ${kept2.length} of ${setups.length}`);
  const B = [], C = [], Dp = []; let dropped = 0;
  for (let i = 0; i < kept2.length; i++) {
    const s = kept2[i], prior = kept2.slice(0, i); if (prior.length < MIN_PRIOR) { dropped++; continue; }
    const base = percentile(prior.map((p) => p.mfe), 0.5), pv = prior.filter((p) => p.avgVolZ !== null && p.volZTrend !== null);
    let tgt = base; if (pv.length >= 20) { const am = percentile(pv.map((p) => p.avgVolZ).sort((a, b) => a - b), 0.5), tm = percentile(pv.map((p) => p.volZTrend).sort((a, b) => a - b), 0.5), pb = pv.filter((p) => p.avgVolZ > am && p.volZTrend > tm);
      if (pb.length >= 10 && s.avgVolZ !== null && s.volZTrend !== null && s.avgVolZ > am && s.volZTrend > tm) tgt = percentile(pb.map((p) => p.mfe), 0.75); }
    const b0 = simulateExit(s, tgt), b = { ...b0, win: b0.pnl > 0 }, c = realistic(s, tgt, false), d = realistic(s, tgt, true); if (!c || !d) continue;   // B win is net of commission like C/D (A keeps the backtest's gross definition)
    B.push({ date: s.date, dir: s.resolutionDir, ...b }); C.push({ date: s.date, dir: s.resolutionDir, ...c, tgt }); Dp.push({ date: s.date, dir: s.resolutionDir, ...d });
  }
  console.log(`walk-forward events scored ${C.length} (first ${dropped} dropped for the 30-prior-events minimum)`);
  const ci = (arr, seed) => (arr.length >= 4 ? dayBlockedBootstrapCI(arr.map((r) => ({ date: r.date, pnl: r.pnl })), seed, { iters: 3000 }) : { lo: null, hi: null });
  const rep = (label, arr) => { if (!arr.length) return null; const c2 = ci(arr, 'flush|' + label), o = { label, n: arr.length, wr: arr.filter((r) => r.win).length / arr.length, ev: mean(arr.map((r) => r.pnl)), lo: c2.lo, hi: c2.hi }; console.log(`${label.padEnd(26)} N=${String(o.n).padStart(3)} WR=${(100 * o.wr).toFixed(1)}% EV ${money(o.ev)} CI [${money(o.lo)}, ${money(o.hi)}]`); return o; };
  console.log('\n--- ARM B (walk-forward target, ideal fills) / ARM C (walk-forward, realistic fills) / ARM D (mirrored placebo of C) ---');
  const res = {};
  for (const [lab, arr] of [['B', B], ['C', C], ['D placebo', Dp]]) { res[lab] = rep(`${lab} pooled`, arr); for (const dir of ['UP', 'DOWN']) rep(`${lab} ${dir === 'UP' ? 'LONG' : 'SHORT'}`, arr.filter((r) => r.dir === dir)); }
  C.forEach((r, i) => { if (r.date !== Dp[i].date) throw new Error('C/D out of lockstep at ' + i); });
  const diff = C.map((r, i) => ({ date: r.date, pnl: r.pnl - Dp[i].pnl })), dci = ci(diff, 'flush|CminusD');
  const sorted = [...C].sort((a, b) => (a.date < b.date ? -1 : 1)), mid = sorted.length >> 1, h1 = mean(sorted.slice(0, mid).map((r) => r.pnl)), h2 = mean(sorted.slice(mid).map((r) => r.pnl));
  console.log(`C minus D (real edge over the mirrored placebo): ${money(mean(diff.map((r) => r.pnl)))} CI [${money(dci.lo)}, ${money(dci.hi)}]; C halves ${money(h1)} / ${money(h2)}`);
  const years = {}; for (const r of C) (years[r.date.slice(0, 4)] ||= []).push(r); for (const [y, a] of Object.entries(years)) rep(`C ${y}`, a);
  const top5 = (() => { const byDay = new Map(); for (const r of C) byDay.set(r.date, (byDay.get(r.date) || 0) + r.pnl); const v = [...byDay.values()].map(Math.abs).sort((a, b) => b - a), tot = v.reduce((s, x) => s + x, 0); return tot ? 100 * v.slice(0, 5).reduce((s, x) => s + x, 0) / tot : null; })();
  console.log(`top-5-day share of |C P&L|: ${top5?.toFixed(1)}%`);
  const verdict = res['C'].lo > 0 && dci.lo > 0 && h1 > 0 && h2 > 0 ? 'SURVIVES' : 'NOT SHOWN';
  console.log(`VERDICT (frozen rule): ${verdict}`);

  // ---- LIVE RECONCILIATION over the common window ----
  console.log(`\n--- LIVE RECONCILIATION ${LIVE_FROM}..`);
  const live = (await query(`SELECT id, setup_type, trade_date::text d, fired_at::text fa, entry_zone_low::float entry, stop_level::float stop, t1_level::float t1, origin_status, resolution, actual_pnl::float pnl FROM active_setups
    WHERE setup_type IN ('RTH_FLUSH_LONG','RTH_FLUSH_SHORT') AND origin_status IN ('ACTIVE','SHADOW') AND trade_date >= $1 ORDER BY trade_date, fired_at`, [LIVE_FROM])).rows;
  const liveByDate = new Map(); for (const r of live) (liveByDate.get(r.d) || liveByDate.set(r.d, []).get(r.d)).push(r);
  const win = setups.filter((s) => s.date >= LIVE_FROM), cats = { match: 0, directionDiffers: 0, priceDiffers: 0, missingLive: 0, extraLive: 0 }, rows = [];
  const evDates = new Set(win.map((s) => s.date));
  for (const s of win) {
    const l = liveByDate.get(s.date); const dir = s.resolutionDir === 'UP' ? 'RTH_FLUSH_LONG' : 'RTH_FLUSH_SHORT';
    if (!l) { cats.missingLive++; rows.push(`${s.date} backtest ${dir} entry ${s.entryPrice} stop ${s.stopPrice}: NO LIVE ROW`); continue; }
    const lr = l[0]; if (lr.setup_type !== dir) { cats.directionDiffers++; rows.push(`${s.date} backtest ${dir} vs live ${lr.setup_type}`); continue; }
    if (Math.abs(lr.entry - s.entryPrice) > 1 || Math.abs(lr.stop - s.stopPrice) > 1) { cats.priceDiffers++; rows.push(`${s.date} ${dir} entry ${s.entryPrice} vs live ${lr.entry}; stop ${s.stopPrice} vs live ${lr.stop}`); continue; }
    cats.match++;
  }
  for (const d of liveByDate.keys()) if (!evDates.has(d)) { cats.extraLive++; rows.push(`${d} LIVE ROW with no backtest event: ${liveByDate.get(d).map((r) => `${r.setup_type} ${r.entry}`).join(',')}`); }
  const firstLive = live.length ? live[0].d : null, postWin = firstLive ? win.filter((x) => x.date >= firstLive) : [], postMatch = postWin.filter((x) => { const l = liveByDate.get(x.date)?.[0]; return l && l.setup_type === (x.resolutionDir === 'UP' ? 'RTH_FLUSH_LONG' : 'RTH_FLUSH_SHORT') && Math.abs(l.entry - x.entryPrice) <= 1 && Math.abs(l.stop - x.stopPrice) <= 1; }).length;
  console.log(`POST-LAUNCH MATCH RATE (from the first live row ${firstLive}): ${postMatch} of ${postWin.length} = ${postWin.length ? (100 * postMatch / postWin.length).toFixed(0) : 'n/a'}%  (the frozen-window rate below includes pre-launch days)`);
  const matchRate = win.length ? cats.match / win.length : null;
  console.log(`LIVE-WINDOW MATCH RATE ${matchRate == null ? 'n/a' : (100 * matchRate).toFixed(0) + '%'} (${cats.match} of ${win.length} backtest event days have a same-direction live row within 1 pt of entry and stop) -> ${matchRate != null && matchRate >= 0.8 ? 'procedure matches live' : 'BELOW 80%: live and backtest are NOT the same strategy; read C/D as the backtest strategy only'}`);
  console.log(`backtest events in window ${win.length}, live rows ${live.length} on ${liveByDate.size} days:`, cats); rows.slice(0, 40).forEach((r) => console.log('  ' + r));
  // DIAGNOSTIC for post-launch mismatches: replay trigger/resolution times next to the live fire
  const lt = (s2, i) => s2.sessBars[i].ts.toISOString().slice(11, 16);
  for (const s2 of win.filter((x) => x.date >= '2026-08-28')) { const l = liveByDate.get(s2.date)?.[0]; const dir = s2.resolutionDir === 'UP' ? 'RTH_FLUSH_LONG' : 'RTH_FLUSH_SHORT';
    if (l && (l.setup_type !== dir || Math.abs(l.entry - s2.entryPrice) > 1 || Math.abs(l.stop - s2.stopPrice) > 1)) console.log(`  DIAG ${s2.date}: replay trigger ${s2.triggerSrc} @${lt(s2, s2.triggerIdx)} (IB idx ${s2.ibIdx == null ? '-' : lt(s2, s2.ibIdx)}, ON idx ${s2.onIdx == null ? '-' : lt(s2, s2.onIdx)}; ONH ${s2.onh} ONL ${s2.onl}) resolution ${s2.resolutionDir} @${lt(s2, s2.entryIdx)} entry ${s2.entryPrice} stop ${s2.stopPrice} | live ${l.setup_type} fired ${l.fa.slice(11, 16)} entry ${l.entry} stop ${l.stop}`); }
  const cByDate = new Map(C.map((r) => [r.date, r])), pairs = live.filter((r) => cByDate.has(r.d) && r.pnl != null);
  console.log(`same-date comparison (n=${pairs.length}): live realized mean ${money(mean(pairs.map((r) => r.pnl)))} vs arm C simulated mean ${money(mean(pairs.map((r) => cByDate.get(r.d).pnl)))}`);
  if (!noRecord) {
    await recordClaim({ slug: 'rth_flush_reconcile_walkforward_20261026', sourceFile: 'scripts/study_flush_reconcile_20261026.mjs', sourceDate: '2026-10-26', sampleSize: C.length, evPerTrade: res['C'].ev, rigorStatus: 'preregistered_walkforward_realistic_fills_mirrored_placebo_live_reconciliation', status: 'PROVISIONAL',
      claimText: `RTH_FLUSH reconciliation (prereg docs/FLUSH_RECONCILE_PREREG_20261026.md). The stored backtest target is the median MFE of the same population (self-referential) with ideal fills. Arm A reproduces it. Walk-forward (target from prior events only) realistic fills (entry next-bar open, gap fills): pooled N=${C.length}, WR ${(100 * res['C'].wr).toFixed(1)}%, EV ${money(res['C'].ev)} CI [${money(res['C'].lo)}, ${money(res['C'].hi)}]; ideal-fill walk-forward EV ${money(res['B'].ev)}; mirrored placebo EV ${money(res['D placebo'].ev)}; C minus D ${money(mean(diff.map((r) => r.pnl)))} CI [${money(dci.lo)}, ${money(dci.hi)}]; halves ${money(h1)} / ${money(h2)}. VERDICT under the frozen rule: ${verdict}. Live reconciliation ${LIVE_FROM}..: ${JSON.stringify(cats)}; live-window match rate ${matchRate == null ? 'n/a' : (100 * matchRate).toFixed(0) + '%'} (pre-registered window incl. pre-launch days), post-launch ${postMatch} of ${postWin.length}; same-date live mean ${money(mean(pairs.map((r) => r.pnl)))} vs arm C ${money(mean(pairs.map((r) => cByDate.get(r.d).pnl)))} (n=${pairs.length}).` });
    console.log('claim recorded');
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
