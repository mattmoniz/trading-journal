// Follow-up to the 2026-07-17 MFE-runner-widening mining pass (docs/OPEN_THREADS.md,
// OPEN_DECISION value_area_responsive_short_runner_followup). That pass found
// VALUE_AREA_RESPONSIVE_SHORT was the ONE setup_type of 71 checked where widening the
// target from the live p75_mfe cap to p95_mfe flips EV from -$1.99 to +$5.25 (N=75,
// top-5-days 6.7% of N) — everything else either stayed negative or only gained $1-2/trade
// on an already-profitable setup. This script does the "dedicated closer look" the decision
// asked for: day-type/DOW breakdown (N>=20 gated), the shared rigor diagnostic (not a new
// hand-rolled clustering check), and a real live-fire cross-check.
//
// Reuses the REAL, canonical sweep functions from update_optimal_stops.mjs (not the scratch
// mining script's copy) per the "export the real function, never reimplement" rule — this
// script is a closer look at that finding, not a new independent derivation.
import { query } from '../server/db.js';
import { sweepOptimalStopAndTarget, DEFAULT_DPP } from './update_optimal_stops.mjs';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const SETUP_TYPE = 'VALUE_AREA_RESPONSIVE_SHORT';
const MIN_N = 20;

function maeCandidatesFor(trades) {
  const maes = trades.map(t => t.mae_points).sort((a, b) => a - b);
  const pct = (p) => maes[Math.floor((maes.length - 1) * p)];
  return [
    { value: pct(0.25), pct: 0.25 }, { value: pct(0.40), pct: 0.40 },
    { value: pct(0.50), pct: 0.50 }, { value: pct(0.60), pct: 0.60 },
    { value: pct(0.75), pct: 0.75 },
  ].filter(c => c.value != null && c.value > 0);
}

function mfePercentile(trades, p) {
  const mfes = trades.map(t => t.mfe_points).sort((a, b) => a - b);
  return mfes[Math.floor((mfes.length - 1) * p)];
}

function sweepBoth(trades) {
  if (trades.length < MIN_N) return null;
  const maeCandidates = maeCandidatesFor(trades);
  const p75mfe = Math.round(mfePercentile(trades, 0.75) || 150);
  const p95mfe = Math.round(mfePercentile(trades, 0.95) || 300);
  const capped = sweepOptimalStopAndTarget(trades, maeCandidates, p75mfe, DEFAULT_DPP, DEFAULT_DPP);
  const uncapped = sweepOptimalStopAndTarget(trades, maeCandidates, p95mfe, DEFAULT_DPP, DEFAULT_DPP);
  if (!capped || !uncapped) return null;
  return { n: trades.length, capped, uncapped, delta: uncapped.ev - capped.ev };
}

async function main() {
  // Matches scratch/gemini_mfe_runner_mining.mjs's exact filter set (replay_resolution, not
  // resolution -- the MAE/MFE-replay-derived outcome, which is what a target-widening
  // hypothesis is actually testing -- plus its <=300pt outlier cap on both mae/mfe) so this
  // is a true apples-to-apples reproduction of the finding being followed up on, not a
  // methodology drift disguised as a "closer look."
  const { rows: trades } = await query(`
    SELECT a.trade_date::text as trade_date, a.mae_points::float, a.mfe_points::float,
      a.actual_pnl::float, dl.day_type, a.origin_status
    FROM active_setups a
    LEFT JOIN acd_daily_log dl ON dl.trade_date = a.trade_date
    WHERE a.setup_type = $1 AND a.status = 'RESOLVED'
      AND a.replay_resolution IN ('TARGET_HIT','STOP_HIT')
      AND a.mae_points IS NOT NULL AND a.mfe_points IS NOT NULL AND a.actual_pnl IS NOT NULL
      AND a.mae_points <= 300 AND a.mfe_points <= 300
    ORDER BY a.trade_date ASC
  `, [SETUP_TYPE]);

  console.log(`=== ${SETUP_TYPE} runner-widening follow-up ===`);
  console.log(`Total resolved trades (all origin_status): ${trades.length}\n`);

  // ── 1. Overall reproduction (sanity check against the mining pass's own numbers) ──
  const overall = sweepBoth(trades);
  console.log('--- OVERALL ---');
  if (overall) {
    console.log(`N=${overall.n}  capped(p75_mfe): stop=${overall.capped.stop} target=${overall.capped.target} EV=$${overall.capped.ev.toFixed(2)}`);
    console.log(`         uncapped(p95_mfe): stop=${overall.uncapped.stop} target=${overall.uncapped.target} EV=$${overall.uncapped.ev.toFixed(2)}`);
    console.log(`         delta: $${overall.delta.toFixed(2)}/trade`);
  } else {
    console.log('N too thin for a sweep.');
  }

  const rigorOverall = computeRigor(trades, { dateField: 'trade_date', pnlFn: (t) => t.actual_pnl });
  console.log(`Rigor (overall, on raw actual_pnl — informational only): top5DayPct=${rigorOverall.top5DayPct}% clustered=${rigorOverall.clustered} stable=${rigorOverall.stable} thirds=${JSON.stringify(rigorOverall.thirds)}`);

  // ── 2. Day-type breakdown ──────────────────────────────────────────────────
  console.log('\n--- BY DAY_TYPE (N>=20 gated) ---');
  const byDayType = {};
  for (const t of trades) {
    const k = t.day_type || 'UNKNOWN';
    (byDayType[k] ||= []).push(t);
  }
  for (const [dt, group] of Object.entries(byDayType).sort((a, b) => b[1].length - a[1].length)) {
    if (group.length < MIN_N) {
      console.log(`${dt.padEnd(12)} N=${group.length} — below N>=${MIN_N} floor, skipped`);
      continue;
    }
    const s = sweepBoth(group);
    if (!s) { console.log(`${dt.padEnd(12)} N=${group.length} — sweep returned no candidate`); continue; }
    const rigor = computeRigor(group, { dateField: 'trade_date', pnlFn: (t) => t.actual_pnl });
    console.log(`${dt.padEnd(12)} N=${s.n}  capped EV=$${s.capped.ev.toFixed(2)} (target=${s.capped.target})  uncapped EV=$${s.uncapped.ev.toFixed(2)} (target=${s.uncapped.target})  delta=$${s.delta.toFixed(2)}  top5DayPct=${rigor.top5DayPct}%`);
  }

  // ── 3. Day-of-week breakdown ───────────────────────────────────────────────
  console.log('\n--- BY DAY-OF-WEEK (N>=20 gated) ---');
  const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const byDow = {};
  for (const t of trades) {
    const d = new Date(t.trade_date + 'T12:00:00Z'); // noon UTC to avoid DST/date-boundary drift
    const k = DOW[d.getUTCDay()];
    (byDow[k] ||= []).push(t);
  }
  for (const dow of ['Mon','Tue','Wed','Thu','Fri']) {
    const group = byDow[dow] || [];
    if (group.length < MIN_N) {
      console.log(`${dow.padEnd(6)} N=${group.length} — below N>=${MIN_N} floor, skipped`);
      continue;
    }
    const s = sweepBoth(group);
    if (!s) { console.log(`${dow.padEnd(6)} N=${group.length} — sweep returned no candidate`); continue; }
    const rigor = computeRigor(group, { dateField: 'trade_date', pnlFn: (t) => t.actual_pnl });
    console.log(`${dow.padEnd(6)} N=${s.n}  capped EV=$${s.capped.ev.toFixed(2)}  uncapped EV=$${s.uncapped.ev.toFixed(2)}  delta=$${s.delta.toFixed(2)}  top5DayPct=${rigor.top5DayPct}%`);
  }

  // ── 4. Real live-fire cross-check (not backfill) ──────────────────────────
  console.log('\n--- LIVE-FIRE CROSS-CHECK (origin_status != BACKFILL) ---');
  const liveTrades = trades.filter(t => t.origin_status && t.origin_status !== 'BACKFILL' && t.origin_status !== 'UNKNOWN');
  console.log(`Real live-fired resolved trades: ${liveTrades.length} of ${trades.length} total (${(100 * liveTrades.length / trades.length).toFixed(1)}%)`);
  if (liveTrades.length > 0) {
    console.log('origin_status breakdown:', JSON.stringify(
      liveTrades.reduce((acc, t) => { acc[t.origin_status] = (acc[t.origin_status] || 0) + 1; return acc; }, {})
    ));
  }
  if (liveTrades.length >= MIN_N) {
    const liveSweep = sweepBoth(liveTrades);
    if (liveSweep) {
      console.log(`Live-only sweep: N=${liveSweep.n} capped EV=$${liveSweep.capped.ev.toFixed(2)} uncapped EV=$${liveSweep.uncapped.ev.toFixed(2)} delta=$${liveSweep.delta.toFixed(2)}`);
    }
  } else {
    console.log(`Below N>=${MIN_N} floor — cannot independently confirm the widened-target thesis against real live fires yet, only backfill-derived data.`);
  }
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
