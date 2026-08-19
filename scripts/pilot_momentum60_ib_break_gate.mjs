// =============================================================================
// PILOT — replacing MOMENTUM_60m_60m_TREND's dead EOD-day_type admission gate with a
// live-knowable one: "IB already broke in the same direction as the momentum extreme."
//
// Background (OPEN_DECISION promotion_pipeline_structural_fix_2026_08_16, 2026-08-18
// update): minuteBarSignalDetector.js's live poller gates on acd_daily_log.day_type ===
// 'TREND', but that column is only written by the 20:20 ET end-of-day cron -- it is
// structurally null/stale at 10:30-10:32 ET, the exact minute the momentum-extreme
// crossing actually fires on every one of the 6 known real TREND days checked. The gate
// has therefore never once been passable live. Swapping in dayTypeReassessmentService.js's
// live estimate (the obvious fix) was tested and rejected by DeepSeek's design review: that
// estimator's own first checkpoint requires being past IB_END=10:30, so it cannot have an
// answer yet at the exact instant the gate needs one either -- it just fails differently.
//
// User-confirmed insight: 10:30 ET is also exactly when the Initial Balance closes, so IB
// break direction (computeIbBullBear(), already live-computed and used for IB_BULLISH/
// IB_BEARISH elsewhere in acd.js) becomes knowable at the SAME INSTANT, with zero lag --
// unlike the day-type estimator. This script tests, with no lookahead, whether IB break
// direction matching the momentum extreme's direction (evaluated at the moment of each
// historical crossing) is a good stand-in for "this is a TREND day," then simulates the
// real trade this would have produced using the setup's own already-calibrated OPTIMAL_STOP
// row, and compares against two baselines computed by the SAME simulation method (not a
// stored/historical number computed a different way, per CLAUDE.md's baseline-parity rule):
//   1. the dead-gate baseline (day_type==='TREND' checked at fire time -- structurally 0
//      trades live, but simulated here with hindsight day_type for reference only)
//   2. the fully unconditioned baseline (every momentum-extreme event, no gate at all)
// plus the IB-break-REJECTED complement (events where IB break did NOT match), as the
// same-selection-minus-signal control this codebase's confound checklist calls for.
//
// No lookahead: IB bars (9:30-10:30 ET) are always fully elapsed before any event at
// etMin>=630 is evaluated -- events before 10:30 are excluded entirely, matching both the
// live poller's EVAL_START_ET_MIN gate and the original day-type conditioning audit's own
// restriction (day_type is only trustworthy at/after IB close).
//
// Run: node scripts/pilot_momentum60_ib_break_gate.mjs
// =============================================================================
import { query } from '../server/db.js';
import { computeIbBullBear } from '../server/services/caseEngine.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const THRESHOLD_WINDOW_DAYS = 20;
const EXTREME_PCTL = 0.20;
const LOOKBACK_MIN = 60;
const HORIZON_MIN = 60;
const PNL_PER_PT = 2; // MNQ, $2/pt -- see server/config/instruments.js LIVE_INSTRUMENT
const EVAL_START_ET_MIN = 630; // 10:30 ET, matches minuteBarSignalDetector.js EVAL_START_ET_MIN
const KNOWN_TREND_DAYS = ['2026-07-20', '2026-07-24', '2026-07-29', '2026-08-03', '2026-08-04', '2026-08-05'];

const { rows: bars } = await query(`
  WITH raw AS (
    SELECT
      (ts AT TIME ZONE 'America/New_York')::date AS td,
      (EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York')*60+EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York'))::int as et_min,
      ts, open::float, high::float, low::float, close::float, volume::float,
      COALESCE(ask_volume,0)::float as ask_vol, COALESCE(bid_volume,0)::float as bid_vol
    FROM price_bars_primary
    WHERE symbol='NQ'
      AND (ts AT TIME ZONE 'America/New_York')::date >= '2023-11-15'
      AND (ts AT TIME ZONE 'America/New_York')::date < CURRENT_DATE
      AND (EXTRACT(hour FROM ts AT TIME ZONE 'America/New_York')*60+EXTRACT(minute FROM ts AT TIME ZONE 'America/New_York')) BETWEEN 570 AND 959
  )
  SELECT td, et_min,
    (array_agg(open ORDER BY ts ASC))[1] as open,
    MAX(high) as high, MIN(low) as low,
    (array_agg(close ORDER BY ts DESC))[1] as close,
    SUM(volume) as volume, SUM(ask_vol) as ask_vol, SUM(bid_vol) as bid_vol
  FROM raw GROUP BY td, et_min ORDER BY td, et_min
`);
const days = [...new Set(bars.map(b => String(b.td)))].sort();
const dayStartGi = new Map(), dayEndGi = new Map();
{
  let prevDay = null;
  for (let gi = 0; gi < bars.length; gi++) {
    const d = String(bars[gi].td);
    if (d !== prevDay) { dayStartGi.set(d, gi); prevDay = d; }
    dayEndGi.set(d, gi);
  }
}
console.log(`Loaded ${bars.length} bars, ${days.length} days`);

function momentum(gi) { const gj = gi - LOOKBACK_MIN; if (gj < 0) return null; return bars[gi].close - bars[gj].close; }
const vals = new Array(bars.length);
for (let gi = 0; gi < bars.length; gi++) vals[gi] = momentum(gi);

function thresholdsForDay(dayIdx) {
  if (dayIdx < THRESHOLD_WINDOW_DAYS) return null;
  const collected = [];
  for (let k = dayIdx - THRESHOLD_WINDOW_DAYS; k < dayIdx; k++) {
    const d = days[k];
    for (let gi = dayStartGi.get(d); gi <= dayEndGi.get(d); gi++) { const v = vals[gi]; if (v != null) collected.push(v); }
  }
  if (collected.length < 100) return null;
  collected.sort((a, b) => a - b);
  return { lo: collected[Math.floor(collected.length * EXTREME_PCTL)], hi: collected[Math.floor(collected.length * (1 - EXTREME_PCTL))] };
}

// ── Fire-once event detection (identical to backtest_momentum60_daytype.mjs) ──
const events = [];
for (let dayIdx = THRESHOLD_WINDOW_DAYS; dayIdx < days.length; dayIdx++) {
  const d = days[dayIdx];
  const th = thresholdsForDay(dayIdx);
  if (!th) continue;
  const startGi = dayStartGi.get(d), endGi = dayEndGi.get(d);
  let wasExtreme = false;
  for (let gi = startGi; gi <= endGi; gi++) {
    const v = vals[gi];
    if (v == null) { wasExtreme = false; continue; }
    const isHigh = v >= th.hi, isLow = v <= th.lo, isExtreme = isHigh || isLow;
    if (isExtreme && !wasExtreme) {
      const fwdGi = gi + HORIZON_MIN;
      if (fwdGi <= endGi) events.push({ gi, endGi, day: d, etMin: bars[gi].et_min, extremeDir: isHigh ? 1 : -1 });
    }
    wasExtreme = isExtreme;
  }
}
console.log(`Total fire-once MOMENTUM_60m/60m events: ${events.length}`);

const dayTypeRows = await query(`SELECT trade_date::text as td, day_type FROM acd_daily_log WHERE day_type IS NOT NULL`);
const dayTypeMap = new Map(dayTypeRows.rows.map(r => [r.td, r.day_type]));

// ── Per-day IB break read, via the real exported computeIbBullBear() -- never
// reimplemented, per CLAUDE.md's export-the-real-function rule. IB window is always fully
// elapsed (570-629 ET) before any event at etMin>=630 is evaluated, so this carries no
// lookahead relative to the live poller's own EVAL_START_ET_MIN gate. ──
const ibReadByDay = new Map();
for (const d of days) {
  const startGi = dayStartGi.get(d), endGi = dayEndGi.get(d);
  const ibBars = [];
  for (let gi = startGi; gi <= endGi; gi++) {
    const b = bars[gi];
    if (b.et_min >= 570 && b.et_min <= 629) ibBars.push({ high: b.high, low: b.low, close: b.close, ask_vol: b.ask_vol, bid_vol: b.bid_vol });
  }
  ibReadByDay.set(d, computeIbBullBear(ibBars));
}

const evalEvents = events.filter(e => e.etMin >= EVAL_START_ET_MIN).map(e => {
  const ib = ibReadByDay.get(e.day);
  const matchesIbBreak = !!ib && ((e.extremeDir === 1 && ib.ibBullish) || (e.extremeDir === -1 && ib.ibBearish));
  return { ...e, actualDayType: dayTypeMap.get(e.day) || null, ib, matchesIbBreak };
});
console.log(`Events at/after 10:30 ET (live-gate-eligible): ${evalEvents.length}`);

// ── Phase A: correlation check, no simulation yet ──
console.log('\n=== PHASE A: does IB-break-match predict TREND? ===');

const known = evalEvents.filter(e => KNOWN_TREND_DAYS.includes(e.day));
const knownMatch = known.filter(e => e.matchesIbBreak).length;
console.log(`\n6 known real TREND days: ${known.length} events fired, ${knownMatch} matched IB-break direction (${known.length ? (100 * knownMatch / known.length).toFixed(1) : 'n/a'}%)`);
for (const e of known) {
  console.log(`  ${e.day} ${String(e.etMin).padStart(4)}et_min extremeDir=${e.extremeDir === 1 ? 'UP' : 'DOWN'} ibBullish=${e.ib?.ibBullish} ibBearish=${e.ib?.ibBearish} match=${e.matchesIbBreak}`);
}

const byDayType = new Map();
for (const e of evalEvents) {
  const dt = e.actualDayType || 'UNLABELED';
  if (!byDayType.has(dt)) byDayType.set(dt, { total: 0, matched: 0 });
  const rec = byDayType.get(dt);
  rec.total++; if (e.matchesIbBreak) rec.matched++;
}
console.log('\nMatch rate by ACTUAL eventual day_type (recall/false-admit check):');
for (const [dt, rec] of byDayType) {
  console.log(`  ${dt.padEnd(10)} N=${rec.total}  matched=${rec.matched} (${(100 * rec.matched / rec.total).toFixed(1)}%)`);
}

const admitted = evalEvents.filter(e => e.matchesIbBreak);
const admittedByType = new Map();
for (const e of admitted) {
  const dt = e.actualDayType || 'UNLABELED';
  admittedByType.set(dt, (admittedByType.get(dt) || 0) + 1);
}
console.log(`\nOf ${admitted.length} events IB-break WOULD ADMIT, actual day_type breakdown (precision check):`);
for (const [dt, n] of admittedByType) console.log(`  ${dt.padEnd(10)} ${n} (${(100 * n / admitted.length).toFixed(1)}%)`);

// ── Phase B: simulate the real trade ──
console.log('\n=== PHASE B: simulate real stop/target trades ===');

const { rows: optRows } = await query(`
  SELECT optimal_stop::float as stop, optimal_target::float as target
  FROM performance_audit WHERE signal_type='OPTIMAL_STOP' AND signal_name='MOMENTUM_60m_60m_TREND'
  ORDER BY run_date DESC LIMIT 1
`);
if (!optRows[0]) { console.error('No OPTIMAL_STOP row for MOMENTUM_60m_60m_TREND -- run scripts/backtest_momentum60_daytype.mjs first.'); process.exit(1); }
const STOP = optRows[0].stop, TARGET = optRows[0].target;
console.log(`Using existing OPTIMAL_STOP row: stop=${STOP}pt target=${TARGET}pt`);

function simulate(evts) {
  const results = [];
  for (const e of evts) {
    const tradeDir = e.extremeDir; // continuation: trade WITH the extreme
    const entry = bars[e.gi].close;
    const stopPx = tradeDir === 1 ? entry - STOP : entry + STOP;
    const targetPx = tradeDir === 1 ? entry + TARGET : entry - TARGET;
    const windowEnd = Math.min(e.gi + HORIZON_MIN, e.endGi);
    let resolution = null;
    for (let gi = e.gi + 1; gi <= windowEnd; gi++) {
      const b = bars[gi];
      if (tradeDir === 1) {
        if (b.low <= stopPx) { resolution = 'STOP_HIT'; break; }
        if (b.high >= targetPx) { resolution = 'TARGET_HIT'; break; }
      } else {
        if (b.high >= stopPx) { resolution = 'STOP_HIT'; break; }
        if (b.low <= targetPx) { resolution = 'TARGET_HIT'; break; }
      }
    }
    if (!resolution) {
      const finalClose = bars[windowEnd].close;
      const finalMove = tradeDir === 1 ? finalClose - entry : entry - finalClose;
      resolution = finalMove > 0 ? 'TARGET_HIT' : 'STOP_HIT';
    }
    const win = resolution === 'TARGET_HIT';
    const pnl = (win ? TARGET : -STOP) * PNL_PER_PT;
    results.push({ day: e.day, resolution, win, pnl });
  }
  return results;
}

function summarize(label, trades) {
  const n = trades.length;
  const wins = trades.filter(t => t.win).length;
  const wr = n ? wins / n : null;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const ev = n ? totalPnl / n : null;
  const rigor = n ? computeRigor(trades, { dateField: 'day', pnlFn: t => t.pnl }) : null;
  console.log(`\n${label}`);
  console.log(`  N=${n}  WR=${wr ? (100 * wr).toFixed(1) : 'n/a'}%  EV=$${ev != null ? ev.toFixed(2) : 'n/a'}  Total=$${totalPnl.toFixed(0)}`);
  if (rigor) console.log(`  rigor: distinctDates=${rigor.distinctDates} top5DayPct=${rigor.top5DayPct}% clustered=${rigor.clustered} stable=${rigor.stable} thirds=${JSON.stringify(rigor.thirds)} clean=${rigor.clean}`);
  return { n, wr, ev, totalPnl, rigor };
}

const candidateTrades = simulate(admitted);
const candidateSummary = summarize('CANDIDATE: IB-break-match admission gate', candidateTrades);

const rejected = evalEvents.filter(e => !e.matchesIbBreak);
const rejectedTrades = simulate(rejected);
const rejectedSummary = summarize('CONTROL: IB-break-REJECTED complement (same selection, no signal)', rejectedTrades);

const unconditionedTrades = simulate(evalEvents);
const unconditionedSummary = summarize('BASELINE 1: fully unconditioned (no gate at all), SAME stop/target as candidate', unconditionedTrades);

const hindsightTrendTrades = simulate(evalEvents.filter(e => e.actualDayType === 'TREND'));
const hindsightTrendSummary = summarize('REFERENCE ONLY (hindsight, not live-knowable): actual day_type===TREND', hindsightTrendTrades);

console.log('\n=== SUMMARY ===');
console.log(`Dead gate (day_type checked live at fire time): 0 trades -- structurally never passable, confirmed by existing live behavior.`);
console.log(`Candidate (IB-break-match, live-knowable at 10:30 ET): N=${candidateSummary.n} EV=$${candidateSummary.ev?.toFixed(2)}`);
console.log(`Unconditioned baseline (same stop/target): N=${unconditionedSummary.n} EV=$${unconditionedSummary.ev?.toFixed(2)}`);
console.log(`Historical unconditioned reference (different stop/target, -$15.75/trade, docs/OPEN_THREADS.md ~line 894): context only, not directly comparable.`);
console.log(`Rejected complement: N=${rejectedSummary.n} EV=$${rejectedSummary.ev?.toFixed(2)}`);
console.log(`Hindsight TREND reference (not live-knowable at fire time): N=${hindsightTrendSummary.n} EV=$${hindsightTrendSummary.ev?.toFixed(2)}`);

// ── Persist as a RESEARCH_CLAIM regardless of sign, per CLAUDE.md's standing rule ──
const beatsBaseline = candidateSummary.n >= 20 && candidateSummary.ev != null && unconditionedSummary.ev != null && candidateSummary.ev > unconditionedSummary.ev;
const cleanRigor = candidateSummary.rigor?.clean === true;
const status = candidateSummary.n < 20 ? 'PROVISIONAL' : (beatsBaseline && cleanRigor ? 'PROVISIONAL' : 'CONFIRMED');
const claimText = `MOMENTUM_60m_60m_TREND's dead EOD-day_type gate replaced (in test only) with IB-break-direction-match, evaluated live-knowable at 10:30 ET. 6 known TREND days: ${knownMatch}/${known.length} matched. Candidate (admitted) N=${candidateSummary.n} WR=${candidateSummary.wr != null ? (100 * candidateSummary.wr).toFixed(1) : 'n/a'}% EV=$${candidateSummary.ev != null ? candidateSummary.ev.toFixed(2) : 'n/a'} vs unconditioned-same-method baseline N=${unconditionedSummary.n} EV=$${unconditionedSummary.ev != null ? unconditionedSummary.ev.toFixed(2) : 'n/a'}. Rejected-complement N=${rejectedSummary.n} EV=$${rejectedSummary.ev != null ? rejectedSummary.ev.toFixed(2) : 'n/a'}. Rigor: clean=${candidateSummary.rigor?.clean}.`;

const { rows: todayRows } = await query(`SELECT CURRENT_DATE::text as today`);
await recordClaim({
  slug: 'momentum60_ib_break_admission_gate_test',
  claimText,
  sourceFile: 'scripts/pilot_momentum60_ib_break_gate.mjs',
  sourceDate: todayRows[0].today,
  sampleSize: candidateSummary.n,
  winRate: candidateSummary.wr != null ? +(candidateSummary.wr * 100).toFixed(1) : null,
  evPerTrade: candidateSummary.ev != null ? +candidateSummary.ev.toFixed(2) : null,
  rigorStatus: candidateSummary.rigor ? JSON.stringify(candidateSummary.rigor) : 'not_checked',
  status,
  extra: {
    known_trend_day_match_rate: known.length ? +(100 * knownMatch / known.length).toFixed(1) : null,
    unconditioned_baseline_ev: unconditionedSummary.ev,
    rejected_complement_ev: rejectedSummary.ev,
    stop: STOP, target: TARGET,
    match_rate_by_day_type: Object.fromEntries([...byDayType].map(([k, v]) => [k, +(100 * v.matched / v.total).toFixed(1)])),
  },
});
console.log(`\nRecorded RESEARCH_CLAIM momentum60_ib_break_admission_gate_test (${status}).`);
console.log('\n[pilot_momentum60_ib_break_gate] Done. NOT wired live -- research only, per explicit user instruction.');
process.exit(0);
