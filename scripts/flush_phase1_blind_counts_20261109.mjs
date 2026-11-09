// FLUSH TEST PHASE 1: OUTCOME-BLIND COUNT AND GEOMETRY (workplan item E, docs/WORKPLAN_20261109.md; design from Argon round 11).
// Reads NO outcome: no P&L, MFE, MAE, hit/miss, or any price after the entry bar. Only: how many armed events, on how many days, how wide the box and the
// entry-to-stop distance are (measured at the entry bar from bars BEFORE it), at what time of night, and what the arms would change. Because no outcome label is read,
// no research_looks entry is required (hr-023 applies to scripts that read outcome labels).
// PARITY (hr-022): event enumeration lives in scripts/lib/flushStudyLib.mjs (verbatim extraction of backtest_flush_patterns.mjs); this script asserts that its totals equal
// the sample sizes of the last backtest run in performance_audit. Windows: explore <= 2025-05-16 (detailed); 2025-05-17..2025-11-19 (hr-070 volume inflation) and
// >= 2025-11-20 (SEALED) are counted in events/days ONLY and their geometry is never printed.
import { query } from '../server/db.js';
import { computeBalanceAndResolution } from '../server/services/flushMechanics.js';
import { loadLevels, loadBarsWithVolZ, groupBarsByDate, groupRthByDate, rthTriggerIdx, findGlobexDepartures, globexSequenceFor, percentile, mean } from './lib/flushStudyLib.mjs';

const EXPLORE_END = '2025-05-16', SEALED_START = '2025-11-20';
const windowOf = (d) => (d <= EXPLORE_END ? 'explore' : d < SEALED_START ? 'inflated' : 'sealed');
const fmt = (v) => (v == null ? 'n/a' : Number(v).toFixed(1));

async function main() {
  const { getLevelsForDate } = await loadLevels();
  const allBars = await loadBarsWithVolZ('1900-01-01');
  const barsByDate = groupBarsByDate(allBars);
  const rthByDate = groupRthByDate(allBars);

  // ADR_20 per RTH date: mean RTH range of the 20 sessions strictly BEFORE the date (>= 200 bars each); asOf(date, inclusive) for Globex events (RTH of that date is complete).
  const dates = [...rthByDate.keys()].sort();
  const range = new Map();
  for (const d of dates) { const bs = rthByDate.get(d); if (bs.length >= 200) range.set(d, Math.max(...bs.map((b) => b.high)) - Math.min(...bs.map((b) => b.low))); }
  const rangeDates = [...range.keys()].sort();
  const adrBefore = (d, inclusive) => {
    const prior = rangeDates.filter((x) => (inclusive ? x <= d : x < d));
    return prior.length >= 20 ? mean(prior.slice(-20).map((x) => range.get(x))) : null;
  };

  const events = [];
  // ---- RTH
  for (const [date, sessBars] of rthByDate) {
    const t = rthTriggerIdx(sessBars, getLevelsForDate(date));
    if (t === null) continue;
    const res = computeBalanceAndResolution(sessBars.slice(t + 1));
    if (!res) continue;
    const entryBar = sessBars[t + 1 + res.resolutionIdx];
    const adr = adrBefore(date, false);
    events.push({ session: 'RTH', mode: 'RTH', dir: res.resolutionDir === 'UP' ? 'LONG' : 'SHORT', date, fireMin: entryBar.mod - 570, box: res.balanceHigh - res.balanceLow,
      stopDist: Math.abs(res.entryPrice - res.stopPrice), adr });
  }
  // ---- Globex
  for (const dep of findGlobexDepartures(rthByDate, barsByDate, getLevelsForDate)) {
    const seq = globexSequenceFor(allBars, dep);
    if (seq.length < 60) continue;
    const res = computeBalanceAndResolution(seq.slice(1));
    if (!res) continue;
    const entryBar = seq[1 + res.resolutionIdx];
    const mode = dep.dir === res.resolutionDir ? 'CONTINUATION' : 'REVERSAL';
    const m = entryBar.mod;
    events.push({ session: 'GLOBEX', mode, dir: res.resolutionDir === 'UP' ? 'LONG' : 'SHORT', date: dep.date, fireMin: m >= 960 ? m - 960 : m + 480, box: res.balanceHigh - res.balanceLow,
      stopDist: Math.abs(res.entryPrice - res.stopPrice), adr: adrBefore(dep.date, true) });
  }

  // ---- PARITY against the last backtest run
  const pa = await query(`SELECT DISTINCT ON (signal_name) signal_name, sample_size, run_date::text FROM performance_audit WHERE signal_type='OPTIMAL_STOP'
    AND signal_name IN ('RTH_FLUSH_LONG','RTH_FLUSH_SHORT','GLOBEX_FLUSH_LONG','GLOBEX_FLUSH_SHORT','GLOBEX_FLUSH_REVERSAL_LONG','GLOBEX_FLUSH_REVERSAL_SHORT') ORDER BY signal_name, run_date DESC, id DESC`);
  const typeOf = (e) => (e.session === 'RTH' ? `RTH_FLUSH_${e.dir}` : e.mode === 'CONTINUATION' ? `GLOBEX_FLUSH_${e.dir}` : `GLOBEX_FLUSH_REVERSAL_${e.dir}`);
  const mine = {}; for (const e of events) mine[typeOf(e)] = (mine[typeOf(e)] || 0) + 1;
  console.log('PARITY (this script all-dates vs last backtest sample_size):');
  let parityOk = true;
  for (const r of pa.rows) { const ok = mine[r.signal_name] === Number(r.sample_size); parityOk &&= ok; console.log(`  ${r.signal_name.padEnd(28)} script ${String(mine[r.signal_name]).padStart(4)}  backtest ${String(r.sample_size).padStart(4)} (run ${r.run_date}) ${ok ? 'MATCH' : 'DIFFERS'}`); }
  console.log(`  parity ${parityOk ? 'OK' : 'NOT OK: investigate before trusting any count below'}\n`);

  // ---- counts by window
  const cells = [...new Set(events.map(typeOf))].sort();
  console.log('EVENTS / DAYS BY WINDOW (events, distinct days)');
  for (const c of cells) {
    const row = ['explore', 'inflated', 'sealed'].map((w) => { const ev = events.filter((e) => typeOf(e) === c && windowOf(e.date) === w); return `${w} ${ev.length}/${new Set(ev.map((e) => e.date)).size}d`; });
    console.log(`  ${c.padEnd(28)} ${row.join('   ')}`);
  }

  // ---- explore geometry (outcome-blind)
  const ex = events.filter((e) => windowOf(e.date) === 'explore');
  console.log('\nEXPLORE GEOMETRY (points; stopDist = |entry - structural stop|; /ADR20 = in units of the 20-session mean RTH range)');
  console.log('  cell                          N  days   box p50  stop min/p10/p25/p50/p75/p90/max   stop/ADR p50  p90   >500pt  >1000pt');
  for (const c of cells) {
    const ev = ex.filter((e) => typeOf(e) === c); if (!ev.length) continue;
    const s = ev.map((e) => e.stopDist), r = ev.filter((e) => e.adr).map((e) => e.stopDist / e.adr);
    console.log(`  ${c.padEnd(28)} ${String(ev.length).padStart(4)} ${String(new Set(ev.map((e) => e.date)).size).padStart(4)}   ${fmt(percentile(ev.map((e) => e.box), 0.5)).padStart(6)}   ${[0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].map((p) => fmt(percentile(s, p))).join('/')}   ${r.length ? fmt(percentile(r, 0.5) * 100).padStart(5) + '%' : 'n/a'} ${r.length ? fmt(percentile(r, 0.9) * 100) + '%' : ''}   ${s.filter((x) => x > 500).length}   ${s.filter((x) => x > 1000).length}`);
  }

  // ---- time-of-night terciles (derived from the explore distribution, per session x mode, long+short pooled)
  console.log('\nFIRE-TIME TERCILES (explore; RTH = minutes after 09:30, Globex = minutes after 16:00): cut points, then events per tercile per cell');
  const groups = [...new Set(ex.map((e) => `${e.session}|${e.mode}`))].sort();
  for (const g of groups) {
    const ev = ex.filter((e) => `${e.session}|${e.mode}` === g); if (ev.length < 9) { console.log(`  ${g}: N=${ev.length} too few`); continue; }
    const t1 = percentile(ev.map((e) => e.fireMin), 1 / 3), t2 = percentile(ev.map((e) => e.fireMin), 2 / 3);
    const bucket = (e) => (e.fireMin <= t1 ? 'early' : e.fireMin <= t2 ? 'mid' : 'late');
    const split = ['LONG', 'SHORT'].map((d) => `${d}: ` + ['early', 'mid', 'late'].map((k) => ev.filter((e) => e.dir === d && bucket(e) === k).length).join('/')).join('   ');
    console.log(`  ${g.padEnd(20)} cuts ${fmt(t1)} | ${fmt(t2)} min   ${split}`);
  }

  // ---- what S1 (skip when stopDist/ADR above the expanding prior p80, known strictly before the event's date) would change
  console.log('\nS1 (skip if stop/ADR20 > expanding prior p80 of the same cell, needs >= 20 earlier events) - events it would SKIP in explore:');
  for (const c of cells) {
    const ev = ex.filter((e) => typeOf(e) === c && e.adr).sort((a, b) => a.date.localeCompare(b.date));
    let skipped = 0, eligible = 0;
    for (let i = 0; i < ev.length; i++) {
      const prior = ev.slice(0, i).filter((p) => p.date < ev[i].date).map((p) => p.stopDist / p.adr);
      if (prior.length < 20) continue;
      eligible++; if (ev[i].stopDist / ev[i].adr > percentile(prior, 0.8)) skipped++;
    }
    console.log(`  ${c.padEnd(28)} eligible ${String(eligible).padStart(4)}  skipped ${String(skipped).padStart(4)}`);
  }
  console.log(`\nbars loaded ${allBars.length}; RTH dates ${rthByDate.size}; ADR20 available from ${rangeDates[19] ?? 'n/a'}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
