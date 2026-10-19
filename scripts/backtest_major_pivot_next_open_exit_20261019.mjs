// backtest_major_pivot_next_open_exit_20261019.mjs -- is holding a MAJOR_PIVOT_DEFENDED_BREAK through the NEXT SESSION'S OPENING EXPANSION better than the live
// 12-hour hold, and is the difference the SETUP or just the MARKET?
//
// Why: scripts/study_major_pivot_winners_20261019.mjs found the big winners make their main leg the next morning (8 of 10 first touched +2 ATR more than 12 h after
// entry, typically 06:30-11:30 ET), which a 720-minute hold ends before. But the 10 big winners come from only 6 distinct days and the random-direction placebo
// averaged ~+80/trade (drift), so "24 h looks better" could be the market, not the setup.
//
// Exit rules (a SMALL pre-registered grid, all reported, nothing picked after the fact):
//   HOLD 720 (live), HOLD 1440, and NEXT-OPEN+H = the first 09:30 ET strictly after entry, plus H hours, H in {1, 2, 4}  (exit at the close of the last bar before that time).
// Stop = STOP x the pivot's structural distance, STOP in {1.0, 1.5}; checked every 1-minute bar; no target (the 2026-10-08 finding: the target almost never decides).
// Entry = completed 5-minute bar close (closeTsStr), as in the live fix.
//
// Controls (both, per cell):
//  (1) RANDOM-DIRECTION placebo: same entries, random direction, same stop distance, same exit rule (20 trials).
//  (2) SAME-CLOCK control (the one that answers "setup or market"): for each break, 15 other trading days (no defended break that day) at the SAME minute-of-day,
//      SAME direction, SAME stop distance, SAME exit rule. Break minus its own control average = what the pivot event adds beyond the clock, the drift and the
//      next-morning expansion. Reported as a paired difference with a day-blocked CI and the share of breaks that beat their own control.
// Point estimates are per-trade means (sum/N). Splits are by population (RTH / Globex) and by first/second half of the year.
//
// Run: node scripts/backtest_major_pivot_next_open_exit_20261019.mjs [--record]
import { query } from '../server/db.js';
import { computeDefendedBreaks } from '../server/services/majorPivotDefendedBreakDetector.js';
import { dayBlockedBootstrapCI, hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';

const PT = 2, COMMISSION = 2;
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS) || 365;   // override: LOOKBACK_DAYS=1300 for the full rebuilt history (2023-03 onward)
const STOPS = [1.0, 1.5];
const RULES = [{ k: 'HOLD', min: 720 }, { k: 'HOLD', min: 1440 }, { k: 'OPEN', h: 1 }, { k: 'OPEN', h: 2 }, { k: 'OPEN', h: 4 }];
const LIVE = { stop: 1.5, rule: RULES[0] };
const N_CONTROL = 15, N_PLACEBO = 20, MAX_HORIZON_MIN = 5000;      // 3.5 days of bars is enough for a Friday entry held to Monday's open + 4 h
const RECORD = process.argv.includes('--record');
const ruleLabel = (r) => r.k === 'HOLD' ? `hold ${r.min}m` : `open+${r.h}h`;

// ---- naive-ET time helpers: everything is minutes since 1970 treating the naive ET digits as UTC (consistent, no DST arithmetic needed for ordering)
const toMin = (s) => Math.floor(new Date(s.replace(' ', 'T') + 'Z').getTime() / 60000);
const fromMin = (m) => new Date(m * 60000).toISOString().slice(0, 19).replace('T', ' ');
const minOfDay = (m) => ((m % 1440) + 1440) % 1440;
function nextOpen(entryMin) {                                         // first 09:30 ET strictly after entry
  const day = Math.floor(entryMin / 1440) * 1440, open = day + 570;
  return open > entryMin ? open : open + 1440;
}
function exitMin(entryMin, rule) { return rule.k === 'HOLD' ? entryMin + rule.min : nextOpen(entryMin) + rule.h * 60; }

// ---- load one year of 1-minute NQ bars into typed arrays (chunked by month, only the columns needed)
async function loadBars(startDate, endDate) {
  const ts = [], H = [], L = [], C = [];
  let cur = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  while (cur < end) {
    const nxt = new Date(Math.min(end.getTime(), new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1)).getTime()));
    const r = await query(`SELECT to_char(ts,'YYYY-MM-DD HH24:MI:SS') t, high::float h, low::float l, close::float c FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1 AND ts < $2 ORDER BY ts`,
      [cur.toISOString().slice(0, 10), nxt.toISOString().slice(0, 10)]);
    for (const x of r.rows) { ts.push(toMin(x.t)); H.push(x.h); L.push(x.l); C.push(x.c); }
    cur = nxt;
  }
  return { ts: Float64Array.from(ts), H: Float64Array.from(H), L: Float64Array.from(L), C: Float64Array.from(C) };
}
function lowerBound(arr, v) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; }

// One trade from entry index onward; stop is a distance in points, no target. Returns { pts, how, holdMin } or null.
function sim(B, entryIdx, entryPx, dir, stopDist, exitAt) {
  const stop = entryPx - dir * stopDist;
  let last = -1;
  const limit = Math.min(B.ts.length, entryIdx + MAX_HORIZON_MIN);
  for (let i = entryIdx; i < limit && B.ts[i] < exitAt; i++) {
    last = i;
    if (dir === 1 ? B.L[i] <= stop : B.H[i] >= stop) return { pts: -stopDist, how: 'STOP', holdMin: B.ts[i] - B.ts[entryIdx] };
  }
  if (last < 0) return null;
  return { pts: (B.C[last] - entryPx) * dir, how: 'TIME', holdMin: B.ts[last] - B.ts[entryIdx] };
}

const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pnlOf = (pts) => pts * PT - COMMISSION;
const fmt = (x) => (x == null || Number.isNaN(x) ? '   n/a' : (x >= 0 ? '+' : '') + x.toFixed(0)).padStart(6);
const pct = (x) => (x == null || Number.isNaN(x) ? '  n/a' : (100 * x).toFixed(0) + '%').padStart(5);

console.log(`Loading breaks (zigzag 1.0 and 1.5, ${LOOKBACK_DAYS} days) and one year of 1-minute bars...`);
const breaks10 = await computeDefendedBreaks(1.0, LOOKBACK_DAYS);
const breaks15 = await computeDefendedBreaks(1.5, LOOKBACK_DAYS);
const ids15 = new Set(breaks15.map(b => `${b.entryTsStr}|${b.direction}`));
const firstDay = breaks10.reduce((m, b) => (b.entryTsStr < m ? b.entryTsStr : m), '9999').slice(0, 10);
const startDay = fromMin(toMin(firstDay + ' 00:00:00') - 1440).slice(0, 10);
const todayDb = (await query(`SELECT CURRENT_DATE::text d`)).rows[0].d;                // trading-day date from SQL CURRENT_DATE, never JS toISOString (CLAUDE.md)
const endDay = fromMin(toMin(todayDb + ' 00:00:00') + 2 * 1440).slice(0, 10);
const B = await loadBars(startDay, endDay);
console.log(`${B.ts.length} one-minute bars loaded (${startDay} .. ${endDay}); ${breaks10.length} breaks at 1.0, ${breaks15.length} at 1.5.`);

const breakDays = new Set(breaks10.map(b => b.entryTsStr.slice(0, 10)));
const barDays = new Map();                                            // date -> true for days that have bars (candidate control days)
for (let i = 0; i < B.ts.length; i += 60) barDays.set(fromMin(B.ts[i]).slice(0, 10), true);
const controlDays = [...barDays.keys()].filter(d => !breakDays.has(d)).sort();

const trades = breaks10.map(b => {
  const entryMin = toMin(b.closeTsStr);
  const idx = lowerBound(B.ts, entryMin);
  if (idx >= B.ts.length || B.ts[idx] - entryMin > 10) return null;
  const m = ((toMin(b.entryTsStr) % 1440) + 1440) % 1440;
  return { id: `${b.entryTsStr}|${b.direction}`, date: b.entryTsStr.slice(0, 10), entryMin, idx, entryPx: b.entryPrice, dir: b.direction === 'LONG' ? 1 : -1,
    structDist: Math.abs(b.entryPrice - b.stopPrice), atr: b.atr, session: (m >= 1080 || m < 510) ? 'GLOBEX' : 'RTH', live15: ids15.has(`${b.entryTsStr}|${b.direction}`) };
}).filter(Boolean);

// same-clock controls for each break (fixed per break, so every cell compares against the SAME control entries)
function buildControls(t) {
  const rand = mulberry32(hashSeed(`nextopen_ctrl|${t.id}`));
  const tod = minOfDay(t.entryMin);
  const picks = [];
  const pool = controlDays.filter(d => d !== t.date);
  for (let tries = 0; tries < 400 && picks.length < N_CONTROL; tries++) {
    const d = pool[Math.floor(rand() * pool.length)];
    const em = toMin(d + ' 00:00:00') + tod;
    const idx = lowerBound(B.ts, em);
    if (idx <= 0 || idx >= B.ts.length || B.ts[idx] - em > 2 || B.ts[idx - 1] < em - 3) continue;   // need a bar right at this minute and the one before it
    if (picks.some(p => p.em === em)) continue;
    picks.push({ em, idx, entryPx: B.C[idx - 1] });                   // entry = close of the prior minute, mirroring the break's completed-bar close
  }
  return picks;
}
for (const t of trades) t.controls = buildControls(t);
console.log(`${trades.length} breaks usable; controls per break: median ${median(trades.map(t => t.controls.length))} (of ${N_CONTROL}).`);

function runCell(pop, stopMult, rule) {
  const rows = [];
  for (const t of pop) {
    const stopDist = t.structDist * stopMult;
    const r = sim(B, t.idx, t.entryPx, t.dir, stopDist, exitMin(t.entryMin, rule));
    if (!r) continue;
    const cs = [];
    for (const c of t.controls) { const rc = sim(B, c.idx, c.entryPx, t.dir, stopDist, exitMin(c.em, rule)); if (rc) cs.push(pnlOf(rc.pts)); }
    const pl = [];
    for (let k = 0; k < N_PLACEBO; k++) { const rnd = mulberry32(hashSeed(`nextopen_pl|${t.id}|${stopMult}|${ruleLabel(rule)}|${k}`)); const d = rnd() < 0.5 ? 1 : -1; const rp = sim(B, t.idx, t.entryPx, d, stopDist, exitMin(t.entryMin, rule)); if (rp) pl.push(pnlOf(rp.pts)); }
    rows.push({ date: t.date, pnl: pnlOf(r.pts), how: r.how, holdH: r.holdMin / 60, ctrl: cs.length ? mean(cs) : null, nCtrl: cs.length, placebo: pl.length ? mean(pl) : null });
  }
  return rows;
}

function summarize(rows, label, stopMult, rule) {
  const n = rows.length, pn = rows.map(r => r.pnl);
  const withC = rows.filter(r => r.ctrl != null);
  const diff = withC.map(r => ({ date: r.date, pnl: r.pnl - r.ctrl }));
  const sorted = [...pn].sort((a, b) => b - a), total = pn.reduce((a, b) => a + b, 0);
  const ci = n >= 8 ? dayBlockedBootstrapCI(rows.map(r => ({ date: r.date, pnl: r.pnl })), `nextopen|${label}|${stopMult}|${ruleLabel(rule)}`, { dateField: 'date' }) : { lo: NaN, hi: NaN };
  const dci = diff.length >= 8 ? dayBlockedBootstrapCI(diff, `nextopen_diff|${label}|${stopMult}|${ruleLabel(rule)}`, { dateField: 'date' }) : { lo: NaN, hi: NaN };
  const byDate = [...diff].sort((a, b) => a.date.localeCompare(b.date)), h = Math.floor(byDate.length / 2);
  return { stopMult, rule, n, mean: n ? total / n : 0, median: median(pn), best: sorted[0] ?? 0, top3: total > 0 ? sorted.slice(0, 3).reduce((a, b) => a + b, 0) / total : null,
    stopPct: rows.filter(r => r.how === 'STOP').length / (n || 1), holdH: median(rows.map(r => r.holdH)), ciLo: ci.lo, ciHi: ci.hi,
    ctrlMean: mean(withC.map(r => r.ctrl)), diffMean: mean(diff.map(d => d.pnl)), diffLo: dci.lo, diffHi: dci.hi, beat: withC.length ? withC.filter(r => r.pnl > r.ctrl).length / withC.length : null,
    placeboMean: mean(rows.filter(r => r.placebo != null).map(r => r.placebo)), d1: mean(byDate.slice(0, h).map(d => d.pnl)), d2: mean(byDate.slice(h).map(d => d.pnl)), days: new Set(rows.map(r => r.date)).size };
}

const results = {};
async function analyse(pop, label) {
  console.log(`\n==================== ${label}: ${pop.length} breaks, ${new Set(pop.map(t => t.date)).size} distinct days ====================`);
  if (pop.length < 12) { console.log('Too few breaks.'); return; }
  console.log(' stop      exit | N days |   mean median   best top3 | stop%  hold(h) |  CI lo  CI hi | CONTROL  PAIRED-DIFF   diff CI lo/hi  beat-own-control | placebo | diff 1st/2nd half');
  const out = [];
  for (const stopMult of STOPS) for (const rule of RULES) {
    const rows = runCell(pop, stopMult, rule), s = summarize(rows, label, stopMult, rule); out.push(s);
    const live = stopMult === LIVE.stop && ruleLabel(rule) === ruleLabel(LIVE.rule) ? '  <-- live' : '';
    console.log(`${String(stopMult).padStart(5)} ${ruleLabel(rule).padStart(10)} | ${String(s.n).padStart(3)} ${String(s.days).padStart(4)} | ${fmt(s.mean)} ${fmt(s.median)} ${fmt(s.best)} ${pct(s.top3)} | ${pct(s.stopPct)} ${f1(s.holdH).padStart(7)} | ${fmt(s.ciLo)} ${fmt(s.ciHi)} | ${fmt(s.ctrlMean)}     ${fmt(s.diffMean)}   ${fmt(s.diffLo)} ${fmt(s.diffHi)}       ${pct(s.beat)} | ${fmt(s.placeboMean)} | ${fmt(s.d1)} ${fmt(s.d2)}${live}`);
  }
  results[label] = out;
}
function f1(x) { return x == null || Number.isNaN(x) ? 'n/a' : x.toFixed(1); }

await analyse(trades.filter(t => t.session === 'RTH'), 'RTH threshold1.0');
await analyse(trades.filter(t => t.session === 'RTH' && t.live15), 'RTH threshold1.5 (live population)');
await analyse(trades.filter(t => t.session === 'GLOBEX'), 'GLOBEX threshold1.0');
console.log('\nHow to read: CONTROL = same minute-of-day, same direction, same stop distance and exit rule on 15 other days with no defended break. PAIRED-DIFF = break minus its own control average; a CI that excludes zero and a "beat-own-control" well above 50% would mean the pivot adds something beyond the clock and the drift. "hold(h)" is the median hours actually held.');
console.log('Done.');

if (RECORD) {
  const { recordClaim } = await import('./record_claim.mjs');
  const line = (lab) => { const o = results[lab]; if (!o) return ''; const pick = (st, r) => o.find(x => x.stopMult === st && ruleLabel(x.rule) === r);
    const a = pick(1.5, 'hold 720m'), b = pick(1.0, 'hold 1440m'), c = pick(1.0, 'open+2h');
    return `${lab}: live ${a.mean.toFixed(0)} (control ${a.ctrlMean.toFixed(0)}, paired ${a.diffMean.toFixed(0)} CI ${a.diffLo.toFixed(0)}..${a.diffHi.toFixed(0)}); stop1.0/hold1440 ${b.mean.toFixed(0)} (control ${b.ctrlMean.toFixed(0)}, paired ${b.diffMean.toFixed(0)} CI ${b.diffLo.toFixed(0)}..${b.diffHi.toFixed(0)}, beat own control ${(100 * b.beat).toFixed(0)}%); stop1.0/open+2h ${c.mean.toFixed(0)} (control ${c.ctrlMean.toFixed(0)}, paired ${c.diffMean.toFixed(0)} CI ${c.diffLo.toFixed(0)}..${c.diffHi.toFixed(0)}, beat own control ${(100 * c.beat).toFixed(0)}%)`; };
  await recordClaim({ slug: 'major_pivot_next_open_exit_vs_clock_control_20261019', sourceFile: 'scripts/backtest_major_pivot_next_open_exit_20261019.mjs', sourceDate: '2026-10-19',
    sampleSize: trades.length, evPerTrade: results['RTH threshold1.0']?.find(x => x.stopMult === 1.0 && ruleLabel(x.rule) === 'open+2h')?.mean ?? null, rigorStatus: 'dayBlockedCI+sameclock_control+placebo', status: 'PROVISIONAL',
    claimText: ('MAJOR_PIVOT hold-through-next-open exit vs live 12h hold, with same-clock control (2026-10-19). ' + [line('RTH threshold1.0'), line('RTH threshold1.5 (live population)'), line('GLOBEX threshold1.0')].filter(Boolean).join(' | ')).slice(0, 1800) });
  console.log('claim recorded');
}
process.exit(0);
