// MOMENTUM_CHASE walk-forward, realistic-fill, regime-gate study. Prereg (committed first): docs/MOMENTUM_CHASE_WALKFORWARD_PREREG_20261026.md
//   node scripts/study_momentum_chase_walkforward_20261026.mjs [--no-record]
import { query } from '../server/db.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
import { PPT, COMM, mean, money, percentile } from './lib/flushStudyLib.mjs';
import { recordClaim } from './record_claim.mjs';

const SPARSE_FROM = '2025-09-28', SPARSE_TO = '2025-11-19', MIN_PRIOR_GARCH = 150, TRAIL_DAYS = 90, MIN_WIDTH_BARS = 20;
const addDay = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

function simulate(bars, startIdx, entry, long, width, ideal) {   // symmetric 1:1 stop/target, stop first, session-close exit
  const stop = long ? entry - width : entry + width, tgt = long ? entry + width : entry - width; let exit = bars[bars.length - 1].close;
  for (let i = startIdx; i < bars.length; i++) {
    const b = bars[i], stopHit = long ? b.low <= stop : b.high >= stop, hit = long ? b.high >= tgt : b.low <= tgt;
    if (stopHit) { exit = ideal ? stop : long ? Math.min(stop, b.open) : Math.max(stop, b.open); break; }
    if (hit) { exit = ideal ? tgt : long ? Math.max(tgt, b.open) : Math.min(tgt, b.open); break; }
  }
  const pnl = (long ? exit - entry : entry - exit) * PPT - COMM; return { pnl, win: pnl > 0 };
}

async function main() {
  const noRecord = process.argv.includes('--no-record');
  const rows = (await query(`SELECT ts, open::float, high::float, low::float, close::float, (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as mod FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= '2023-01-15' AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959 ORDER BY ts ASC`)).rows;
  const byDate = new Map(); for (const b of rows) { const d = b.ts.toISOString().slice(0, 10); (byDate.get(d) || byDate.set(d, []).get(d)).push(b); }
  const dates = [...byDate.keys()].filter((d) => byDate.get(d).length >= 371).sort(), prevOf = new Map(dates.map((d, i) => [d, dates[i - 1]]));
  // 5-minute bar ranges per date (RTH), for the trailing width calibration
  const ranges5 = new Map(); for (const d of dates) { const bk = new Map(); for (const b of byDate.get(d)) { const k = Math.floor(b.mod / 5), e = bk.get(k); if (!e) bk.set(k, { hi: b.high, lo: b.low }); else { e.hi = Math.max(e.hi, b.high); e.lo = Math.min(e.lo, b.low); } } ranges5.set(d, [...bk.values()].map((e) => e.hi - e.lo).filter((r) => r > 0)); }
  // GARCH regimes: walk-forward (expanding, prior rows only, >= MIN_PRIOR_GARCH) and the live detector's whole-history cutoffs
  const garch = (await query(`SELECT run_date::text d, (notes::jsonb->>'scale')::float scale FROM performance_audit WHERE signal_type='GARCH_VOL_SCALE' AND signal_name <> 'LATEST' ORDER BY run_date ASC`)).rows;
  const allScales = garch.map((g) => g.scale).sort((a, b) => a - b), f30 = percentile(allScales, 0.30), f80 = percentile(allScales, 0.80);
  const regWF = new Map(), regFull = new Map();
  garch.forEach((g, k) => { regFull.set(g.d, g.scale < f30 ? 'LOW' : g.scale <= f80 ? 'MEDIUM' : 'HIGH'); if (k >= MIN_PRIOR_GARCH) { const pr = garch.slice(0, k).map((x) => x.scale).sort((a, b) => a - b), p30 = percentile(pr, 0.30), p80 = percentile(pr, 0.80); regWF.set(g.d, g.scale < p30 ? 'LOW' : g.scale <= p80 ? 'MEDIUM' : 'HIGH'); } });
  const widthFor = (d, regMap, want) => { const lo = addDay(d, -TRAIL_DAYS), arr = []; for (const x of dates) { if (x >= d) break; if (x < lo) continue; if (want && regMap.get(x) !== want) continue; arr.push(...ranges5.get(x)); } return arr.length >= MIN_WIDTH_BARS ? Math.round(percentile(arr.sort((a, b) => a - b), 0.75)) : null; };

  // events per day (one each): arm B (5-minute bar close) and arm C (1-minute bar close, entry next open)
  const excl = { sparse: 0, roll: 0, noPrior: 0 }, ev = [];
  for (const d of dates) {
    if (d < '2023-03-06') continue; if (d >= SPARSE_FROM && d <= SPARSE_TO) { excl.sparse++; continue; }
    const pd = prevOf.get(d); if (!pd) { excl.noPrior++; continue; } if (isInsideNqRollWeek(d) || isInsideNqRollWeek(pd)) { excl.roll++; continue; }
    const pb = byDate.get(pd), pdh = Math.max(...pb.map((b) => b.high)), pdl = Math.min(...pb.map((b) => b.low)), bars = byDate.get(d);
    let cIdx = null, cLong = null; for (let i = 0; i < bars.length - 1; i++) { const b = bars[i]; if (b.mod < 575 || b.mod >= 720) continue; if (b.close > pdh) { cIdx = i; cLong = true; break; } if (b.close < pdl) { cIdx = i; cLong = false; break; } }
    let bIdx = null, bLong = null;
    { const bk = new Map(); bars.forEach((b, i) => { const k = Math.floor(b.mod / 5); (bk.get(k) || bk.set(k, []).get(k)).push(i); });
      for (const k of [...bk.keys()].sort((a, b) => a - b)) { if (k * 5 < 570 || k * 5 + 5 > 720) continue; const idxs = bk.get(k), last = idxs[idxs.length - 1], c = bars[last].close; if (idxs.length < 5) continue; if (c > pdh) { bIdx = last; bLong = true; break; } if (c < pdl) { bIdx = last; bLong = false; break; } } }
    ev.push({ d, bars, cIdx, cLong, bIdx, bLong });
  }
  console.log(`days ${dates.length}; usable event days ${ev.length}; excluded`, excl, `| days with C signal ${ev.filter((e) => e.cIdx !== null).length}, B signal ${ev.filter((e) => e.bIdx !== null).length}`);
  console.log(`GARCH rows ${garch.length}; walk-forward regime available for ${regWF.size} days; whole-history cutoffs p30 ${f30.toFixed(3)} p80 ${f80.toFixed(3)}`);

  const ci = (arr, seed) => (arr.length >= 4 ? dayBlockedBootstrapCI(arr.map((r) => ({ date: r.d, pnl: r.pnl })), seed, { iters: 3000 }) : { lo: null, hi: null });
  const rep = (label, arr) => { if (!arr.length) { console.log(`${label.padEnd(40)} N=0`); return null; } const c2 = ci(arr, 'mc|' + label), o = { label, n: arr.length, wr: arr.filter((r) => r.win).length / arr.length, ev: mean(arr.map((r) => r.pnl)), lo: c2.lo, hi: c2.hi }; console.log(`${label.padEnd(40)} N=${String(o.n).padStart(3)} WR=${(100 * o.wr).toFixed(1)}% EV ${money(o.ev)} CI [${money(o.lo)}, ${money(o.hi)}]`); return o; };
  const run = (regMap, want, label) => {
    const B = [], C = [], D = [];
    for (const e of ev) {
      if (want && regMap.get(e.d) !== want) continue; if (!want && !regMap.has(e.d)) continue;
      const w = widthFor(e.d, regMap, want); if (!w) continue;
      if (e.bIdx !== null) { const r = simulate(e.bars, e.bIdx + 1, e.bars[e.bIdx].close, e.bLong, w, true); B.push({ d: e.d, long: e.bLong, ...r }); }
      if (e.cIdx !== null) { const en = e.bars[e.cIdx + 1].open, r = simulate(e.bars, e.cIdx + 1, en, e.cLong, w, false), m = simulate(e.bars, e.cIdx + 1, en, !e.cLong, w, false); C.push({ d: e.d, long: e.cLong, width: w, ...r }); D.push({ d: e.d, long: !e.cLong, ...m }); }
    }
    console.log(`\n=== ${label} ===`); const rb = rep(`${label} B (5-min close, ideal)`, B), rc = rep(`${label} C (1-min close, realistic)`, C), rd = rep(`${label} D (mirrored placebo of C)`, D);
    const diff = C.map((r, i) => ({ d: r.d, pnl: r.pnl - D[i].pnl })), dci = ci(diff, 'mc|diff|' + label);
    const sorted = [...C].sort((a, b) => (a.d < b.d ? -1 : 1)), mid = sorted.length >> 1, h1 = mean(sorted.slice(0, mid).map((r) => r.pnl)), h2 = mean(sorted.slice(mid).map((r) => r.pnl));
    if (C.length) console.log(`  C minus D ${money(mean(diff.map((r) => r.pnl)))} CI [${money(dci.lo)}, ${money(dci.hi)}]; C halves ${money(h1)} / ${money(h2)}`);
    return { B, C, D, rb, rc, rd, dci, h1, h2, diff };
  };
  const out = {}; for (const w of ['MEDIUM', 'LOW', 'HIGH']) out[w] = run(regWF, w, `WF-${w}`); out.ALL = run(regWF, null, 'WF-ALL(any regime)'); out.FULL = run(regFull, 'MEDIUM', 'WHOLE-HISTORY cutoffs MEDIUM (live definition)');
  const M = out.MEDIUM; console.log('\n--- WF-MEDIUM detail (primary) ---');
  for (const [lab, f] of [['LONG', (r) => r.long], ['SHORT', (r) => !r.long]]) rep(`C ${lab}`, M.C.filter(f));
  const yrs = {}; for (const r of M.C) (yrs[r.d.slice(0, 4)] ||= []).push(r); for (const [y, a] of Object.entries(yrs)) rep(`C ${y}`, a);
  const verdict = M.rc && M.rc.lo > 0 && M.dci.lo > 0 && M.h1 > 0 && M.h2 > 0 ? 'SURVIVES' : 'NOT SHOWN'; console.log(`\nVERDICT (frozen rule, WF-MEDIUM arm C): ${verdict}`);

  // live comparison
  const live = (await query(`SELECT setup_type, trade_date::text d, actual_pnl::float pnl FROM active_setups WHERE setup_type LIKE 'MOMENTUM_CHASE%' AND actual_pnl IS NOT NULL ORDER BY trade_date`)).rows;
  const sim = new Map(out.FULL.C.map((r) => [r.d, r])), pairs = live.filter((l) => sim.has(l.d) && sim.get(l.d).long === l.setup_type.endsWith('LONG'));
  console.log(`\nLIVE MOMENTUM_CHASE rows ${live.length} (mean ${money(mean(live.map((l) => l.pnl)))}); matched to a whole-history-MEDIUM arm C event on the same date and direction: ${pairs.length}; live mean ${money(mean(pairs.map((l) => l.pnl)))} vs simulated ${money(mean(pairs.map((l) => sim.get(l.d).pnl)))}`);
  if (!noRecord) {
    const L = (o) => (o ? `N=${o.n} WR ${(100 * o.wr).toFixed(1)}% EV ${money(o.ev)} CI [${money(o.lo)}, ${money(o.hi)}]` : 'n/a');
    await recordClaim({ slug: 'momentum_chase_walkforward_20261026', sourceFile: 'scripts/study_momentum_chase_walkforward_20261026.mjs', sourceDate: '2026-10-26', sampleSize: M.C.length, evPerTrade: M.rc?.ev, rigorStatus: 'preregistered_walkforward_regime_cutoffs_and_width_realistic_fills_mirrored_placebo', status: 'PROVISIONAL',
      claimText: `MOMENTUM_CHASE walk-forward (prereg docs/MOMENTUM_CHASE_WALKFORWARD_PREREG_20261026.md). Regime cutoffs from prior GARCH rows only (>=150), width from the trailing 90 days only, one event per day. WF-MEDIUM arm C (1-minute close beyond PDH/PDL 9:35-12:00, entry next open, gap fills): ${L(M.rc)}; research-style arm B (5-minute close, ideal fills) ${L(M.rb)}; mirrored placebo ${L(M.rd)}; C minus D ${money(mean(M.diff.map((r) => r.pnl)))} CI [${money(M.dci.lo)}, ${money(M.dci.hi)}]; halves ${money(M.h1)} / ${money(M.h2)}. Other regimes (arm C): LOW ${L(out.LOW.rc)}; HIGH ${L(out.HIGH.rc)}; ungated ${L(out.ALL.rc)}; live-definition (whole-history cutoffs) MEDIUM ${L(out.FULL.rc)}. VERDICT under the frozen rule: ${verdict}. Live: ${live.length} SHADOW rows, matched ${pairs.length}, live mean ${money(mean(pairs.map((l) => l.pnl)))} vs simulated ${money(mean(pairs.map((l) => sim.get(l.d).pnl)))}. MEDIUM was selected after seeing LOW and HIGH (1-of-3 pick).` });
    console.log('claim recorded');
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
