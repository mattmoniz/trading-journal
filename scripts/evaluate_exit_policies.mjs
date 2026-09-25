// Opus Audit #14 (2026-09-24) section 3.2-3.3 / OPEN_DECISION
// trade_forward_path_table_and_policy_evaluator_20260924. Evaluates a small,
// PRE-REGISTERED menu of exit policies over the SAME stored forward-path data
// (build_trade_forward_path.mjs), reporting mean R and day-blocked CI vs the trade's own
// real historical exit -- collapsing 40+ independent one-off exit-mechanism backtest
// scripts into one reusable evaluator, per the audit's explicit reasoning.
//
// STEP_TRAIL added 2026-09-24 per DeepSeek's own review of the first 4-policy version: the
// menu was missing the one mechanism a PRIOR audit (Opus Audit #12) had already flagged as
// the real candidate. Result: STEP_TRAIL is the only one of 5 policies with a POSITIVE delta
// vs the real historical exit (+0.0167R), though its CI still crosses zero -- a real,
// promising-not-confirmed signal, not the "none beat current" verdict the 4-policy version
// implied.
//
// Honest scoping note: this evaluator reimplements each policy's DECISION LOGIC directly
// against the stored path (not a literal call into acd.js's live stepWiderTarget()/
// stepStepTrail(), which are request-scoped state machines wired to live poll cycles, not
// designed for offline batch replay over a stored array) -- each policy here is written to
// match its live counterpart's PUBLISHED mechanism exactly (WIDER_1_5X's own documented
// 1.5x-target-then-bank rule, matching widerTargetWalker.js's WIDER_TARGET_MULT=1.5).
// Wiring the literal live functions is real follow-up work, not done here.
//
// Commission: MNQ $2 round-trip (server/config/instruments.js's LIVE_INSTRUMENT), applied
// as a fixed R-equivalent deduction per trade (2 / ($2/pt * R_points)), matching the
// audit's own "commission_in_R" note (section 3.2) and the pilot_exits_extended.mjs bug
// this guards against ($1 vs $2 commission).
import fs from 'fs';
import { dayBlockedBootstrapDeltaCI } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const PATH_FILE = '/home/mmoniz/trading-journal/scratch/trade_forward_path.json';
const MNQ_DOLLAR_PER_POINT = 2;
const MNQ_ROUND_TRIP_COMMISSION = 2;
const TIME_STOP_BARS = [60, 120, 240];
const WIDER_TARGET_MULT = 1.5; // matches server/services/widerTargetWalker.js's own constant

// Step-trail (server/services/stepTrailWalker.js), added 2026-09-24 per DeepSeek's own
// prioritized next-step: the exit-policy menu was missing this specific mechanism, which a
// PRIOR audit (Opus Audit #12) already flagged as the one candidate most worth testing.
// Calibrated values reused directly from performance_audit ('STEP_TRAIL_FRACTION', latest
// row, 2026-09-20) -- never hand-typed, per this codebase's own standing rule.
const STEP_TRAIL_FRAC = 0.15;
const STEP_TRAIL_P10_BASE_FLOOR = 30; // points

function commissionInR(rPoints) {
  if (!(rPoints > 0)) return 0;
  const dollarPerR = MNQ_DOLLAR_PER_POINT * rPoints;
  return MNQ_ROUND_TRIP_COMMISSION / dollarPerR;
}

// FIXED_CURRENT: the trade's own real historical exit, re-derived from the uncensored
// path (not just re-reading actual_pnl) so it's directly comparable in R units to the
// other policies -- also serves as a sanity check (sign should match real_resolution).
function policyFixedCurrent(t) {
  if (t.stop_hit_bar != null && (t.target_hit_bar == null || t.stop_hit_bar <= t.target_hit_bar)) {
    return -1;
  }
  if (t.target_hit_bar != null) {
    return t.target != null ? Math.abs(t.target - t.entry) / t.R : 1;
  }
  // Neither hit within the walked window -- mark to market at the last bar (matches
  // real TIME_EXPIRED/MARK_TO_MARKET handling).
  return t.close_r_path[t.close_r_path.length - 1] ?? 0;
}

function policyTimeStop(t, nBars) {
  const cap = Math.min(nBars, t.close_r_path.length - 1);
  if (t.stop_hit_bar != null && t.stop_hit_bar <= cap) return -1;
  return t.close_r_path[cap] ?? 0;
}

// WIDER_1_5X: matches widerTargetWalker.js's real, documented mechanism -- if the ORIGINAL
// T1 target is reached first (bar <= stop_hit_bar or no stop), instead of banking at 1R,
// hold for a wider target at WIDER_TARGET_MULT x the original R distance; stop remains the
// ORIGINAL stop (no breakeven ratchet in the base version). If price never reaches the
// wider target within H bars, mark-to-market at the last bar (matching TIME_EXPIRED).
function policyWiderTarget(t) {
  if (t.stop_hit_bar != null && (t.target_hit_bar == null || t.stop_hit_bar <= t.target_hit_bar)) {
    return -1; // stopped before ever reaching T1 -- wider-target logic never engages
  }
  if (t.target_hit_bar == null) {
    return t.close_r_path[t.close_r_path.length - 1] ?? 0; // never reached T1 at all
  }
  // T1 was reached -- from here, look for either the wider target or the original stop,
  // whichever comes first, searching bars from target_hit_bar onward. Stop-first on a
  // same-bar tie (fixed 2026-09-24 per DeepSeek code review -- this checked the wider
  // target before the stop, the opposite of the "stop-first" convention documented in
  // every other walker in this codebase and in compute_reach_r() itself).
  for (let i = t.target_hit_bar; i < t.high_r_path.length; i++) {
    if (t.low_r_path[i] <= -1) return -1; // original stop still live, gets hit on the way
    if (t.high_r_path[i] >= WIDER_TARGET_MULT) return WIDER_TARGET_MULT;
  }
  return t.close_r_path[t.close_r_path.length - 1] ?? 0; // ran out of bars, mark to market
}

// STEP_TRAIL: matches server/services/stepTrailWalker.js's real, documented mechanism.
// Composition, not reimplementation of the DECISION SHAPE: once price reaches the 1.5x
// wider target (same arming point as WIDER_1_5X above), instead of banking there, the stop
// snaps to (1.5R - stepSize) and trails forward -- every time price advances a further full
// stepSize past the current high-water mark, the stop advances by that many steps too
// (floor-division multi-step-per-bar handling, matching the real walker's own comment on
// a single fast bar crossing several step boundaries at once). Exits when price pulls back
// to the trailing stop. stepSize is in R units, derived from the same calibrated fraction
// and points-floor the real live mechanism uses (performance_audit 'STEP_TRAIL_FRACTION',
// run_date 2026-09-20) -- reused, never hand-typed.
function policyStepTrail(t) {
  if (t.stop_hit_bar != null && (t.target_hit_bar == null || t.stop_hit_bar <= t.target_hit_bar)) {
    return -1; // stopped before ever reaching T1 -- step-trail never engages
  }
  if (t.target_hit_bar == null) {
    return t.close_r_path[t.close_r_path.length - 1] ?? 0; // never reached T1 at all
  }
  const effectiveBasePoints = Math.max(WIDER_TARGET_MULT * t.R, STEP_TRAIL_P10_BASE_FLOOR);
  const stepSizePoints = STEP_TRAIL_FRAC * effectiveBasePoints;
  const stepSizeR = stepSizePoints / t.R;

  // Search from target_hit_bar for the arming point (1.5R reached), same stop-first
  // tie-break as WIDER_1_5X.
  let armBar = null;
  for (let i = t.target_hit_bar; i < t.high_r_path.length; i++) {
    if (t.low_r_path[i] <= -1) return -1; // original stop still live, gets hit before arming
    if (t.high_r_path[i] >= WIDER_TARGET_MULT) { armBar = i; break; }
  }
  if (armBar == null) return t.close_r_path[t.close_r_path.length - 1] ?? 0; // never armed

  // Snap immediately on the arming bar (matching the real walker's same-bar snap fix) --
  // any excess above 1.5R on the arming bar itself is not credited (matches the live
  // mechanism: arming and the first trail-advance check are two separate bars).
  let currentStopR = Math.max(-1, WIDER_TARGET_MULT - stepSizeR);
  let highestMfeR = WIDER_TARGET_MULT;

  for (let i = armBar + 1; i < t.high_r_path.length; i++) {
    if (t.low_r_path[i] <= currentStopR) return currentStopR; // trailing stop hit -- checked before advancing, matching the real walker's stopHit-first order
    if (t.high_r_path[i] >= highestMfeR + stepSizeR) {
      const steps = Math.floor((t.high_r_path[i] - highestMfeR) / stepSizeR);
      highestMfeR += steps * stepSizeR;
      currentStopR += steps * stepSizeR;
    }
  }
  return t.close_r_path[t.close_r_path.length - 1] ?? currentStopR; // ran out of bars, mark to market
}

const POLICIES = {
  FIXED_CURRENT: policyFixedCurrent,
  TIME_STOP_60: (t) => policyTimeStop(t, 60),
  TIME_STOP_120: (t) => policyTimeStop(t, 120),
  TIME_STOP_240: (t) => policyTimeStop(t, 240),
  WIDER_1_5X: policyWiderTarget,
  STEP_TRAIL: policyStepTrail,
};

async function main() {
  const trades = JSON.parse(fs.readFileSync(PATH_FILE, 'utf8'));
  console.log(`Loaded ${trades.length} real forward paths`);
  const gapExcluded = trades.filter(t => !t.gap_through);
  console.log(`Excluding ${trades.length - gapExcluded.length} gap-through trades (untradeable path per the OVERNIGHT MFE convention)`);

  const results = {};
  for (const [name, fn] of Object.entries(POLICIES)) {
    const rVals = gapExcluded.map(t => {
      const rRaw = fn(t);
      const comm = commissionInR(t.R);
      return { trade_date: t.trade_date, pnl: rRaw - comm, cluster_touch_id: t.cluster_touch_id };
    });
    const meanR = rVals.reduce((s, v) => s + v.pnl, 0) / rVals.length;
    results[name] = { meanR, events: rVals };
    console.log(`${name}: mean R=${meanR.toFixed(4)} (n=${rVals.length})`);
  }

  console.log('\n=== vs FIXED_CURRENT (day-blocked bootstrap CI on the delta) ===');
  const baselineEvents = results.FIXED_CURRENT.events;
  const comparisons = {};
  for (const [name, r] of Object.entries(results)) {
    if (name === 'FIXED_CURRENT') continue;
    const ciEvents = [];
    for (let i = 0; i < r.events.length; i++) {
      ciEvents.push({ date: r.events[i].trade_date, group: 'CANDIDATE', pnl: r.events[i].pnl });
      ciEvents.push({ date: baselineEvents[i].trade_date, group: 'BASELINE', pnl: baselineEvents[i].pnl });
    }
    const ci = dayBlockedBootstrapDeltaCI(ciEvents, `exit_policy_${name}`, {
      dateField: 'date', groupField: 'group', groupA: 'BASELINE', groupB: 'CANDIDATE',
    });
    const delta = r.meanR - results.FIXED_CURRENT.meanR;
    const excludesZero = ci.lo != null && ci.hi != null && (ci.lo > 0 || ci.hi < 0);
    comparisons[name] = { delta, ci_lo: ci.lo, ci_hi: ci.hi, excludes_zero: excludesZero };
    console.log(`${name} vs FIXED_CURRENT: delta=${delta >= 0 ? '+' : ''}${delta.toFixed(4)}R, CI=[${ci.lo?.toFixed(4)}, ${ci.hi?.toFixed(4)}], excludes_zero=${excludesZero}`);
  }

  await recordClaim({
    slug: 'exit_policy_evaluator_pilot_20260924',
    claimText: [
      'First run of the shared forward-path/policy evaluator (Opus Audit #14 section 3.2,',
      'OPEN_DECISION trade_forward_path_table_and_policy_evaluator_20260924). Real RTH fade',
      `trades, N=${gapExcluded.length} (${trades.length - gapExcluded.length} gap-through`,
      'excluded), uncensored bar-by-bar walk to H=240 bars, MNQ $2 round-trip commission',
      'subtracted in R-equivalent terms.',
      `FIXED_CURRENT (re-derived real historical exit) mean R=${results.FIXED_CURRENT.meanR.toFixed(4)}.`,
      ...Object.entries(comparisons).map(([name, c]) =>
        `${name}: delta=${c.delta >= 0 ? '+' : ''}${c.delta.toFixed(4)}R vs FIXED_CURRENT, day-blocked CI=[${c.ci_lo?.toFixed(4)},${c.ci_hi?.toFixed(4)}], excludes_zero=${c.excludes_zero}.`
      ),
      'Honest scoping: policies here reimplement each mechanism\'s published logic against',
      'the stored path rather than calling the literal live stepWiderTarget()/stepStepTrail()',
      'functions (which are request-scoped, not built for offline batch replay) -- wiring the',
      'literal live functions remains real follow-up work. This first run also unblocks',
      'retroactive step-trail Phase 2 evaluation (OPEN_DECISION step_trail_phase2_promotion_pending)',
      'without waiting for 6 more weeks of forward SHADOW data, per the audit\'s own §3.3 note.',
    ].join(' '),
    sourceFile: 'scripts/evaluate_exit_policies.mjs',
    sourceDate: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    sampleSize: gapExcluded.length,
    winRate: null,
    evPerTrade: null,
    rigorStatus: 'first_run_pilot',
    status: 'PROVISIONAL',
    extra: { fixed_current_mean_r: results.FIXED_CURRENT.meanR, comparisons },
  });
  console.log('\nClaim recorded: exit_policy_evaluator_pilot_20260924');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
