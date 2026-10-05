// scripts/backtest_exit_tightening_20261005.mjs
//
// Exit tightening test (spec: docs/EXIT_TIGHTENING_TEST_SPEC.md, reviewed by DeepSeek 2026-10-05).
// Question: would a tighter stop, or a target nearer entry, have beaten the CURRENT exit on the same
// real trades? Read-only: writes nothing to the database. Prints a report and writes JSON to scratch/.
//
// Design choices, each answering a specific DeepSeek finding:
//  - Candidates are FRACTIONS OF THE CURRENT, ALREADY-CALIBRATED exit distances (stop_level and t1_level as
//    stored), fixed before any outcome is looked at. Nothing is fitted to these trades' MFE/MAE (no hindsight,
//    no survivorship from realized MFE). The grid is 3x3 minus the baseline cell.
//  - Baseline is re-simulated through the SAME replay on the SAME trades (not read from stored P&L). Parity
//    against the stored actual_pnl is reported as a sanity check.
//  - Intra-bar tie-break (both stop and target inside one bar): reported under BOTH conventions (stop-first,
//    target-first). A conclusion counts only if it holds under both.
//  - Entry fill gate: the first bar, starting at the fire minute, that trades through entry (the resolver's
//    own rule). Trades that never fill before expires_at are excluded and counted, not scored as zero.
//  - Time horizon fixed to each trade's own expires_at, identical for every candidate.
//  - Inference is DAY-BLOCKED: per-day summed paired deltas, sign-flip permutation (flip whole days) and a
//    day-block bootstrap CI. Effective N is distinct trading days, not trade count.
//  - Multiplicity: 8 candidates, so the p-value bar is Bonferroni-adjusted (0.05 / 8).
//
// Population (2026-10-05 revision after a parity audit): trades whose exit at ENTRY is a plain stop and
// target. Excludes wider_target_mult / extend_target_level rows (set at insert, not outcome-based), and
// MARK_TO_MARKET rows. The first run included trades resolved through a wider target, a banked lock or a
// trail, which the stored stop/target replay cannot reproduce; that inflated every tighter candidate.
// Population: REAL_TRADE_FILTER + POOLED_TRADE_FILTER (cluster siblings collapsed to primary), imported from
// scripts/backtest_setup_status.mjs (the canonical filter pair). Also excludes late-fill, stale-price and
// bad_bars_basis rows explicitly, and requires a determinable direction (resolveDirection).
//
// Usage: node scripts/backtest_exit_tightening_20261005.mjs
import fs from 'fs';
import { query } from '../server/db.js';
import { resolveDirection } from '../server/config/setupTypes.js';
import { REAL_TRADE_FILTER, POOLED_TRADE_FILTER } from './backtest_setup_status.mjs';

const PNL_PER_POINT = 2;          // MNQ $2/pt (server/config/instruments.js)
const COMMISSION_RT = 2;          // $1 per side, round trip $2
const K_STOP = [0.5, 0.75, 1.0];  // multiples of the current stop distance
const M_TARGET = [0.5, 0.75, 1.0]; // multiples of the current target distance
const N_RESAMPLE = 5000;
const BONFERRONI_ALPHA = 0.05 / 8;

// Deterministic PRNG so the report is reproducible.
let seed = 20261005;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// ---------- population ----------
const popSql = `
  SELECT id, setup_type, trade_date::text AS trade_date,
         fired_at::text AS fired_at, expires_at::text AS expires_at, entry_zone_low::float AS elo, entry_zone_high::float AS ehi,
         stop_level::float AS stop_level, t1_level::float AS t1_level,
         actual_pnl::float AS actual_pnl, resolution, resolution_method
  FROM active_setups
  WHERE ${REAL_TRADE_FILTER}
    AND ${POOLED_TRADE_FILTER}
    AND stop_level IS NOT NULL AND t1_level IS NOT NULL
    AND (entry_zone_high IS NOT NULL OR entry_zone_low IS NOT NULL)
    AND expires_at IS NOT NULL
    AND actual_pnl IS NOT NULL
    AND wider_target_mult IS NULL AND extend_target_level IS NULL
    AND resolution_method IS DISTINCT FROM 'MARK_TO_MARKET'
  ORDER BY fired_at, id`;
const rows = (await query(popSql)).rows;

const trades = [];
const excluded = { no_direction: 0, no_entry: 0 };
for (const r of rows) {
  const dir = resolveDirection(r);
  if (!dir) { excluded.no_direction++; continue; }
  const entry = r.ehi ?? r.elo;
  if (entry == null) { excluded.no_entry++; continue; }
  trades.push({ ...r, dir, long: dir === 'LONG', entry });
}
console.log(`population: ${rows.length} rows; scorable ${trades.length}; excluded ${JSON.stringify(excluded)}`);

// fired_at/expires_at are selected as TEXT on purpose: node-postgres turns a naive timestamp into a JS Date
// (parsed as UTC), and passing that Date back as a query parameter shifts it by the local offset (4 hours
// in ET). Found 2026-10-05: the first two runs read bars from 4 hours early.
// ---------- bars per trade (bounded to its own window) ----------
// price_bars_primary is a view; one bounded query per trade, same as the rest of the codebase's replays.
async function barsFor(t) {
  const r = await query(`
    SELECT ts::text AS ts, open::float AS o, high::float AS h, low::float AS l, close::float AS c
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= date_trunc('minute', $1::timestamp) AND ts <= $2::timestamp
    ORDER BY ts`, [t.fired_at, t.expires_at]);
  return r.rows;
}

// ---------- replay ----------
// Returns { pnl, outcome } in dollars net of commission, or { filled:false } if entry never trades.
function replay(bars, t, stopPx, tgtPx, tieFirst) {
  const { long, entry } = t;
  let fillIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (long ? b.l <= entry : b.h >= entry) { fillIdx = i; break; }
  }
  if (fillIdx < 0) return { filled: false };
  for (let i = fillIdx; i < bars.length; i++) {
    const b = bars[i];
    const stopHit = long ? b.l <= stopPx : b.h >= stopPx;
    const tgtHit = long ? b.h >= tgtPx : b.l <= tgtPx;
    if (stopHit && tgtHit) {
      const useStop = tieFirst === 'stop';
      const px = useStop ? stopPx : tgtPx;
      return { filled: true, outcome: useStop ? 'STOP' : 'TARGET', pnl: pts(long, entry, px) * PNL_PER_POINT - COMMISSION_RT };
    }
    if (stopHit) return { filled: true, outcome: 'STOP', pnl: pts(long, entry, stopPx) * PNL_PER_POINT - COMMISSION_RT };
    if (tgtHit) return { filled: true, outcome: 'TARGET', pnl: pts(long, entry, tgtPx) * PNL_PER_POINT - COMMISSION_RT };
  }
  // Time expiry: mark at the last bar's close, same as the resolver's MARK_TO_MARKET convention.
  const last = bars[bars.length - 1];
  return { filled: true, outcome: 'TIME', pnl: pts(long, entry, last.c) * PNL_PER_POINT - COMMISSION_RT };
}
const pts = (long, entry, px) => (long ? px - entry : entry - px);

// Candidate levels, derived only from the trade's own stored (already calibrated) distances.
function levelsFor(t, k, m) {
  const stopDist = Math.abs(t.entry - t.stop_level) * k;
  const tgtDist = Math.abs(t.t1_level - t.entry) * m;
  return {
    stopPx: t.long ? t.entry - stopDist : t.entry + stopDist,
    tgtPx: t.long ? t.entry + tgtDist : t.entry - tgtDist,
  };
}

// ---------- run ----------
const CANDIDATES = [];
for (const k of K_STOP) for (const m of M_TARGET) if (!(k === 1 && m === 1)) CANDIDATES.push({ k, m });

const perTrade = [];
let noBars = 0;
for (const t of trades) {
  const bars = await barsFor(t);
  if (bars.length === 0) { noBars++; continue; }
  const base = { ...levelsFor(t, 1, 1) };
  // Baseline: the stored stop/target, replayed on the same bars, both tie conventions.
  const bStop = replay(bars, t, base.stopPx, base.tgtPx, 'stop');
  const bTgt = replay(bars, t, base.stopPx, base.tgtPx, 'target');
  if (!bStop.filled) continue; // never filled: excluded from every arm equally
  const row = { id: t.id, day: t.trade_date, setup: t.setup_type, long: t.long, stored: t.actual_pnl, baseStop: bStop.pnl, baseTgt: bTgt.pnl, resolution: t.resolution, method: t.resolution_method, cand: {} };
  for (const c of CANDIDATES) {
    const L = levelsFor(t, c.k, c.m);
    row.cand[`${c.k}|${c.m}`] = {
      stop: replay(bars, t, L.stopPx, L.tgtPx, 'stop'),
      tgt: replay(bars, t, L.stopPx, L.tgtPx, 'target'),
    };
  }
  perTrade.push(row);
}
console.log(`scored trades: ${perTrade.length} (no bars: ${noBars}; never filled excluded)`);

// Parity: replayed baseline vs the stored actual_pnl (resolver convention may differ slightly).
const parity = perTrade.map(r => r.baseStop - r.stored);
const parityMean = parity.reduce((a, b) => a + b, 0) / parity.length;
const parityMAD = parity.map(Math.abs).sort((a, b) => a - b)[Math.floor(parity.length / 2)];
console.log(`parity (replayed baseline - stored actual_pnl): mean ${parityMean.toFixed(2)}, median abs ${parityMAD.toFixed(2)}`);

// Parity breakdown by stored resolution, so a remaining mismatch can be traced to its mechanism.
const byMethod = {};
for (const r of perTrade) {
  const k = `${r.resolution}/${r.method}`;
  (byMethod[k] ||= []).push(r.baseStop - r.stored);
}
console.log('parity by stored resolution/method (n, mean replay-stored, median abs):');
for (const [k, xs] of Object.entries(byMethod).sort((a, b) => b[1].length - a[1].length)) {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const med = [...xs].map(Math.abs).sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.log(`  ${k.padEnd(40)} n=${String(xs.length).padEnd(5)} mean=${mean.toFixed(1).padEnd(9)} medAbs=${med.toFixed(1)}`);
}

// ---------- statistics ----------
// Per-day summed paired deltas, for day-blocked inference.
function dayDeltas(rowsIn, deltaFn) {
  const byDay = new Map();
  for (const r of rowsIn) {
    const d = deltaFn(r);
    if (d == null) continue;
    byDay.set(r.day, (byDay.get(r.day) || 0) + d);
  }
  return [...byDay.values()];
}
function signFlipP(days) {
  const obs = Math.abs(days.reduce((a, b) => a + b, 0));
  let hits = 0;
  for (let i = 0; i < N_RESAMPLE; i++) {
    let s = 0;
    for (const d of days) s += rand() < 0.5 ? d : -d;
    if (Math.abs(s) >= obs) hits++;
  }
  return (hits + 1) / (N_RESAMPLE + 1);
}
function blockBootCI(days) {
  const means = [];
  for (let i = 0; i < N_RESAMPLE; i++) {
    let s = 0;
    for (let j = 0; j < days.length; j++) s += days[Math.floor(rand() * days.length)];
    means.push(s);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * N_RESAMPLE)], means[Math.floor(0.975 * N_RESAMPLE)]];
}
function halves(rowsIn, deltaFn) {
  const days = [...new Set(rowsIn.map(r => r.day))].sort();
  const mid = days[Math.floor(days.length / 2)];
  const a = rowsIn.filter(r => r.day < mid), b = rowsIn.filter(r => r.day >= mid);
  const mean = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
  return {
    firstHalf: mean(a.map(deltaFn).filter(x => x != null)),
    secondHalf: mean(b.map(deltaFn).filter(x => x != null)),
  };
}

const report = [];
for (const c of CANDIDATES) {
  const key = `${c.k}|${c.m}`;
  for (const tie of ['stop', 'target']) {
    const deltaFn = r => {
      const cand = r.cand[key][tie === 'stop' ? 'stop' : 'tgt'];
      const base = tie === 'stop' ? r.baseStop : r.baseTgt;
      if (!cand.filled) return null;
      return cand.pnl - base;
    };
    const scored = perTrade.filter(r => deltaFn(r) != null);
    const days = dayDeltas(scored, deltaFn);
    const meanPerTrade = scored.reduce((s, r) => s + deltaFn(r), 0) / Math.max(scored.length, 1);
    const p = signFlipP(days);
    const ci = blockBootCI(days);
    const h = halves(scored, deltaFn);
    report.push({
      stopMult: c.k, targetMult: c.m, tie,
      trades: scored.length, distinctDays: days.length,
      meanDeltaPerTrade: +meanPerTrade.toFixed(2),
      ci95Day: [+ci[0].toFixed(0), +ci[1].toFixed(0)],
      p: +p.toFixed(4),
      halves: { first: h.firstHalf != null ? +h.firstHalf.toFixed(2) : null, second: h.secondHalf != null ? +h.secondHalf.toFixed(2) : null },
      passesBonferroni: p < BONFERRONI_ALPHA,
      ciExcludesZero: ci[0] > 0 || ci[1] < 0,
    });
  }
}

console.log('\nstopMult targetMult tie     trades days  meanΔ/trade  CI95(day, $)        p       halves(1st/2nd)     pass');
for (const r of report) {
  const pass = r.passesBonferroni && r.ciExcludesZero && r.halves.first != null && r.halves.second != null && Math.sign(r.halves.first) === Math.sign(r.halves.second) && r.meanDeltaPerTrade > 0;
  console.log(`${String(r.stopMult).padEnd(9)} ${String(r.targetMult).padEnd(10)} ${r.tie.padEnd(7)} ${String(r.trades).padEnd(6)} ${String(r.distinctDays).padEnd(5)} ${String(r.meanDeltaPerTrade).padEnd(12)} [${r.ci95Day[0]}, ${r.ci95Day[1]}]`.padEnd(70) + ` ${String(r.p).padEnd(7)} ${String(r.halves.first)}/${r.halves.second}`.padEnd(30) + ` ${pass ? 'YES' : 'no'}`);
}

const out = { generated: new Date().toISOString(), population: rows.length, scored: perTrade.length, excluded, noBars, parityMean, parityMAD, report };
fs.writeFileSync(new URL('../scratch/exit_tightening_20261005.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('\nwrote scratch/exit_tightening_20261005.json');
process.exit(0);
