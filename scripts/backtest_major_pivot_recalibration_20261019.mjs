// backtest_major_pivot_recalibration_20261019.mjs -- does MAJOR_PIVOT_DEFENDED_BREAK ride a whole move, and which exit captures the most of it?
//
// Why (2026-10-19): the live config is three fixed literals from a 2026-09-10 sweep (RTH: stop 1.5x structural distance, FIXED target 2.5x ATR20, hold 720 min),
// never recalibrated; the 2026-10-08 re-test found the target is almost never the exit (6.45% hits, ~71% time exits). The user's framing: this is a HOME-RUN
// setup -- unlike a normal trade whose favorable excursion stops after one rotation, it is meant to keep going across MULTIPLE rotations until price finally stops.
// So a fixed multiple of ATR is the wrong frame. This script tests exits that FOLLOW the move (ratcheting trail of k x ATR behind the best price since entry,
// no target) against the live fixed-target cell and a no-target time exit, and judges them by payoff SHAPE and by CAPTURE (realized points / the trade's own
// maximum favorable excursion inside the same hold), not by win rate.
//
// Method (each item guards a known failure of this codebase):
//  * Population = the REAL computeDefendedBreaks() (never reimplemented), 365 days, zigzag 1.0 (85 breaks). The live 1.5 population is only 41 breaks
//    (29 RTH / 12 Globex) -- too few to fit anything -- and is a SUBSET of the 1.0 set, so it is reported separately.
//  * Entry = the CLOSE of the COMPLETED 5-minute bar: bars are walked from bucketStart+5min (the 2026-10-08 script walked from inside the signal bar).
//  * Baseline (live cell) simulated by THIS code in the same pass, never a stored number.
//  * Exit rules are fixed, identical in every cell; no exit level is derived from the population's own outcomes (that would be a tautology).
//  * Inside one 1-minute bar the stop is checked before the best-price update and before any target (conservative).
//  * Per cell: per-trade mean = sum/N (not a day-weighted mean), day-blocked bootstrap CI, 10-trial random-direction placebo, stop/target/trail/time mix,
//    capture ratio, top-3 share, chronological halves, and a walk-forward pick (choose on the first half by date, judge on the second).
//  * Descriptive MFE table (how far price goes in the trade direction inside the hold, ignoring any stop): is there a multi-rotation move at all?
//
// Run: node scripts/backtest_major_pivot_recalibration_20261019.mjs [--record]   (read the output first; --record writes a RESEARCH_CLAIM)
import { query } from '../server/db.js';
import { computeDefendedBreaks } from '../server/services/majorPivotDefendedBreakDetector.js';
import { dayBlockedBootstrapCI, computeRigor, hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';

const PT = 2, COMMISSION = 2;                 // MNQ $2/pt, $2 round trip (server/config/instruments.js)
const LOOKBACK_DAYS = 365;
const MAX_HOLD = 2880;                         // 2 days: a multi-rotation move can outlast one session
const STOP_MULTS = [1.0, 1.5];                 // x the pivot's structural distance
const EXITS = [{ type: 'FIXED', mult: 2.5 }, { type: 'NONE' }, { type: 'OPP' }, { type: 'TRAIL', mult: 1.0 }, { type: 'TRAIL', mult: 1.5 }, { type: 'TRAIL', mult: 2.0 }, { type: 'TRAIL', mult: 3.0 }];
const HOLDS = [720, 1440, 2880];
const LIVE = { stopMult: 1.5, exit: { type: 'FIXED', mult: 2.5 }, hold: 720 }; // RTH live config (CONFIG in majorPivotDefendedBreakDetector.js)
const PLACEBO_TRIALS = 10;
const MFE_LEVELS = [1, 2, 3, 5];
const RECORD = process.argv.includes('--record');

const minOf = (ts) => { const [h, m] = ts.split(' ')[1].split(':').map(Number); return h * 60 + m; };
const isGlobex = (b) => { const mod = minOf(b.entryTsStr); return mod >= 1080 || mod < 510; };
const addMin = (ts, n) => new Date(new Date(ts.replace(' ', 'T') + 'Z').getTime() + n * 60000).toISOString().slice(0, 19).replace('T', ' ');
const exitLabel = (e) => e.type === 'OPP' ? 'opp break' : e.type === 'FIXED' ? `fixed ${e.mult}x` : e.type === 'NONE' ? 'time only' : `trail ${e.mult}x`;

async function loadTrades(breaks) {
  const out = [];
  const sortedBreaks = [...breaks].sort((a, b) => a.entryTsStr.localeCompare(b.entryTsStr));
  for (const b of breaks) {
    const opp = sortedBreaks.find(o => o.entryTsStr > b.entryTsStr && o.direction !== b.direction);   // the exit signal: a defended break AGAINST this trade
    const oppTime = opp ? addMin(opp.entryTsStr, 5) : null, oppPrice = opp ? opp.entryPrice : null;
    const entryTime = addMin(b.entryTsStr, 5);            // bucket START + 5 min = the completed bar's close
    const endTs = addMin(entryTime, MAX_HOLD);
    const bars = (await query(`SELECT ts::text ts, high::float h, low::float l, close::float c FROM price_bars_primary
      WHERE symbol='NQ' AND ts >= $1 AND ts < $2 ORDER BY ts`, [entryTime, endTs])).rows;
    if (bars.length < 5) continue;
    out.push({ date: b.entryTsStr.slice(0, 10), entryTime, entry: b.entryPrice, structDist: Math.abs(b.entryPrice - b.stopPrice), atr: b.atr,
      dir: b.direction === 'LONG' ? 1 : -1, oppTime, oppPrice, bars, session: isGlobex(b) ? 'GLOBEX' : 'RTH', id: `${b.entryTsStr}|${b.direction}` });
  }
  return out;
}

// Maximum favorable excursion (points, trade direction) inside the hold, ignoring any stop -- the size of the move available to capture.
function mfePts(t, dir, hold) {
  const lim = addMin(t.entryTime, hold); let best = 0;
  for (const b of t.bars) { if (b.ts >= lim) break; best = Math.max(best, dir === 1 ? b.h - t.entry : t.entry - b.l); }
  return best;
}

// One trade, one config, one direction (dir is flipped for the placebo; distances are unchanged).
function simulate(t, dir, stopMult, exit, hold) {
  const stopDist = t.structDist * stopMult;
  const initStop = t.entry - dir * stopDist;
  const target = exit.type === 'FIXED' ? t.entry + dir * exit.mult * t.atr : null;
  const trailDist = exit.type === 'TRAIL' ? exit.mult * t.atr : null;
  const limitTs = addMin(t.entryTime, hold);
  let best = t.entry, last = null;
  for (const b of t.bars) {
    if (b.ts >= limitTs) break;
    last = b;
    let stop = initStop, how = 'STOP';
    if (trailDist != null) { const tr = best - dir * trailDist; if (dir === 1 ? tr > stop : tr < stop) { stop = tr; how = 'TRAIL'; } }
    if (dir === 1 ? b.l <= stop : b.h >= stop) return { pts: (stop - t.entry) * dir, how };
    if (target != null && (dir === 1 ? b.h >= target : b.l <= target)) return { pts: Math.abs(target - t.entry), how: 'TARGET' };
    if (exit.type === 'OPP' && t.oppTime && b.ts >= t.oppTime) return { pts: (t.oppPrice - t.entry) * dir, how: 'OPPOSITE' };
    best = dir === 1 ? Math.max(best, b.h) : Math.min(best, b.l);
  }
  if (!last) return null;
  return { pts: (last.c - t.entry) * dir, how: 'TIME' };
}

function runCell(trades, stopMult, exit, hold, dir = null, rand = null) {
  const res = [];
  for (const t of trades) {
    const d = dir ?? (rand ? (rand() < 0.5 ? 1 : -1) : t.dir);
    const r = simulate(t, d, stopMult, exit, hold);
    if (!r) continue;
    res.push({ date: t.date, pnl: r.pts * PT - COMMISSION, pts: r.pts, mfe: mfePts(t, d, hold), how: r.how, id: t.id });
  }
  return res;
}
const mean = (a) => a.length ? a.reduce((s, x) => s + x.pnl, 0) / a.length : 0;
const median = (a) => { if (!a.length) return 0; const s = a.map(x => x.pnl).sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function cellStats(trades, label, cfg) {
  const rs = runCell(trades, cfg.stopMult, cfg.exit, cfg.hold);
  const n = rs.length;
  const total = rs.reduce((s, x) => s + x.pnl, 0);
  const sorted = [...rs].sort((a, b) => b.pnl - a.pnl);
  const top3 = sorted.slice(0, 3).reduce((s, x) => s + x.pnl, 0);
  const mfeSum = rs.reduce((s, x) => s + x.mfe, 0);
  const placebo = [];
  for (let k = 0; k < PLACEBO_TRIALS; k++) {
    const rand = mulberry32(hashSeed(`mp_recal|${label}|${cfg.stopMult}|${exitLabel(cfg.exit)}|${cfg.hold}|${k}`));
    placebo.push(mean(runCell(trades, cfg.stopMult, cfg.exit, cfg.hold, null, rand)));
  }
  const pAvg = placebo.reduce((a, b) => a + b, 0) / placebo.length;
  const ci = n >= 8 ? dayBlockedBootstrapCI(rs, `mp_recal|${label}|${cfg.stopMult}|${exitLabel(cfg.exit)}|${cfg.hold}`, { dateField: 'date' }) : { lo: NaN, hi: NaN };
  const byDate = [...rs].sort((a, b) => a.date.localeCompare(b.date));
  const half = Math.floor(n / 2);
  const frac = (k) => rs.filter(x => x.how === k || (k === 'TARGET' && x.how === 'OPPOSITE')).length / (n || 1);   // the tgt column also counts OPPOSITE-break exits
  return {
    ...cfg, n, mean: n ? total / n : 0, median: median(rs), total, best: sorted[0]?.pnl ?? 0, worst: sorted[sorted.length - 1]?.pnl ?? 0,
    top3Share: total > 0 ? top3 / total : null, capture: mfeSum > 0 ? rs.reduce((s, x) => s + x.pts, 0) / mfeSum : null,
    stopPct: frac('STOP'), trailPct: frac('TRAIL'), targetPct: frac('TARGET'), timePct: frac('TIME'),
    ciLo: ci.lo, ciHi: ci.hi, placeboAvg: pAvg, placeboMin: Math.min(...placebo), placeboMax: Math.max(...placebo),
    h1: mean(byDate.slice(0, half)), h2: mean(byDate.slice(half)), rs,
  };
}

const cfgKey = (c) => `${c.stopMult}|${exitLabel(c.exit)}|${c.hold}`;
const fmt = (x) => (x == null || Number.isNaN(x) ? '   n/a' : (x >= 0 ? '+' : '') + x.toFixed(0)).padStart(6);
const pct = (x) => (x == null || Number.isNaN(x) ? '  n/a' : (100 * x).toFixed(0) + '%').padStart(5);

function mfeTable(trades) {
  const out = [];
  for (const k of MFE_LEVELS) for (const hold of HOLDS) {
    let hit = 0;
    for (const t of trades) {
      const lim = addMin(t.entryTime, hold); const lvl = t.entry + t.dir * k * t.atr;
      for (const b of t.bars) { if (b.ts >= lim) break; if (t.dir === 1 ? b.h >= lvl : b.l <= lvl) { hit++; break; } }
    }
    out.push({ k, hold, hit, n: trades.length });
  }
  return out;
}

async function analyse(trades, label) {
  console.log(`\n==================== ${label}: ${trades.length} trades, ${new Set(trades.map(t => t.date)).size} distinct days ====================`);
  if (trades.length < 12) { console.log('Too few trades to evaluate.'); return null; }
  const cells = [];
  for (const stopMult of STOP_MULTS) for (const exit of EXITS) for (const hold of HOLDS) cells.push(cellStats(trades, label, { stopMult, exit, hold }));
  const base = cellStats(trades, label, LIVE);
  console.log(`LIVE baseline (stop ${LIVE.stopMult}x, ${exitLabel(LIVE.exit)}, hold ${LIVE.hold}m), simulated here: N=${base.n} mean ${fmt(base.mean)} median ${fmt(base.median)} best ${fmt(base.best)} worst ${fmt(base.worst)} capture ${pct(base.capture)}  CI [${fmt(base.ciLo)},${fmt(base.ciHi)}]  placebo avg ${fmt(base.placeboAvg)} (${fmt(base.placeboMin)}..${fmt(base.placeboMax)})`);
  console.log('\n stop      exit  hold |   N   mean median   best  worst top3 capt | stop trail tgt time |  CI lo  CI hi | placebo avg (min..max) | half1 half2');
  for (const c of [...cells].sort((a, b) => b.mean - a.mean)) {
    const mark = cfgKey(c) === cfgKey(LIVE) ? ' <-- live' : '';
    console.log(`${String(c.stopMult).padStart(5)} ${exitLabel(c.exit).padStart(10)} ${String(c.hold).padStart(5)} | ${String(c.n).padStart(3)} ${fmt(c.mean)} ${fmt(c.median)} ${fmt(c.best)} ${fmt(c.worst)} ${pct(c.top3Share)} ${pct(c.capture)} | ${pct(c.stopPct)} ${pct(c.trailPct)} ${pct(c.targetPct)} ${pct(c.timePct)} | ${fmt(c.ciLo)} ${fmt(c.ciHi)} | ${fmt(c.placeboAvg)} (${fmt(c.placeboMin)}..${fmt(c.placeboMax)}) | ${fmt(c.h1)} ${fmt(c.h2)}${mark}`);
  }
  const sortedT = [...trades].sort((a, b) => a.date.localeCompare(b.date));
  const cut = Math.floor(sortedT.length / 2);
  const first = sortedT.slice(0, cut), second = sortedT.slice(cut);
  let pick = null;
  for (const stopMult of STOP_MULTS) for (const exit of EXITS) for (const hold of HOLDS) {
    const m = mean(runCell(first, stopMult, exit, hold));
    if (!pick || m > pick.m) pick = { stopMult, exit, hold, m };
  }
  const pickOOS = mean(runCell(second, pick.stopMult, pick.exit, pick.hold));
  const liveOOS = mean(runCell(second, LIVE.stopMult, LIVE.exit, LIVE.hold));
  const liveIS = mean(runCell(first, LIVE.stopMult, LIVE.exit, LIVE.hold));
  console.log(`\nWalk-forward: best on the first ${first.length} trades = stop ${pick.stopMult}x / ${exitLabel(pick.exit)} / hold ${pick.hold}m (in-sample ${fmt(pick.m)}); on the later ${second.length} trades it makes ${fmt(pickOOS)}; the LIVE cell makes ${fmt(liveOOS)} there (live in-sample ${fmt(liveIS)}).`);
  console.log('\nSize of the move available (MFE in ATR, trade direction, ignoring any stop; descriptive only) -- share of trades whose best excursion reached k x ATR within the hold:');
  const mt = mfeTable(trades);
  for (const k of MFE_LEVELS) console.log(`  ${String(k).padStart(2)}x ATR: ` + HOLDS.map(h => { const r = mt.find(x => x.k === k && x.hold === h); return `${h}m ${r.hit}/${r.n} (${(100 * r.hit / r.n).toFixed(0)}%)`; }).join('   '));
  const mf = trades.map(t => mfePts(t, t.dir, 2880) / t.atr).sort((a, b) => a - b);
  console.log(`  MFE within 2 days, in ATR: median ${mf[mf.length >> 1].toFixed(2)}, p75 ${mf[Math.floor(mf.length * 0.75)].toFixed(2)}, p90 ${mf[Math.floor(mf.length * 0.9)].toFixed(2)}, max ${mf[mf.length - 1].toFixed(2)}`);
  const rigor = computeRigor(base.rs, { pnlFn: t => t.pnl });
  console.log('Live-cell rigor:', JSON.stringify({ distinctDates: rigor.distinctDates, top5DayPct: rigor.top5DayPct, stable: rigor.stable, clustered: rigor.clustered, clean: rigor.clean }));
  return { label, base, cells, pick, pickOOS, liveOOS, liveIS, n: trades.length };
}

console.log(`Loading the real defended breaks (zigzag 1.0 and 1.5, ${LOOKBACK_DAYS} days)...`);
const breaks10 = await computeDefendedBreaks(1.0, LOOKBACK_DAYS);
const breaks15 = await computeDefendedBreaks(1.5, LOOKBACK_DAYS);
const ids15 = new Set(breaks15.map(b => `${b.entryTsStr}|${b.direction}`));
const all = await loadTrades(breaks10);
const results = [];
results.push(await analyse(all.filter(t => t.session === 'RTH'), 'RTH threshold1.0'));
results.push(await analyse(all.filter(t => t.session === 'RTH' && ids15.has(t.id)), 'RTH threshold1.5 (live population)'));
results.push(await analyse(all.filter(t => t.session === 'GLOBEX'), 'GLOBEX threshold1.0'));
console.log('\nDone.');

if (RECORD) {
  const { recordClaim } = await import('./record_claim.mjs');
  const r = results.filter(Boolean);
  const text = `MAJOR_PIVOT_DEFENDED_BREAK exit recalibration (2026-10-19): completed-bar entry, ${LOOKBACK_DAYS}d, real computeDefendedBreaks(); trailing exits vs live fixed target. ` +
    r.map(x => `${x.label}: N=${x.n}, live cell mean ${x.base.mean.toFixed(0)} capture ${x.base.capture == null ? 'n/a' : (100 * x.base.capture).toFixed(0) + '%'} (CI ${x.base.ciLo.toFixed(0)}..${x.base.ciHi.toFixed(0)}); walk-forward pick stop ${x.pick.stopMult}/${exitLabel(x.pick.exit)}/hold ${x.pick.hold} later-half ${x.pickOOS.toFixed(0)} vs live later-half ${x.liveOOS.toFixed(0)}`).join(' | ');
  await recordClaim({ slug: 'major_pivot_exit_recalibration_trail_20261019', claimText: text.slice(0, 1800), sourceFile: 'scripts/backtest_major_pivot_recalibration_20261019.mjs',
    sourceDate: '2026-10-19', sampleSize: r[0]?.n ?? null, evPerTrade: r[0]?.base.mean ?? null, rigorStatus: 'dayBlockedCI+placebo+walkforward', status: 'PROVISIONAL' });
  console.log('claim recorded');
}
process.exit(0);
