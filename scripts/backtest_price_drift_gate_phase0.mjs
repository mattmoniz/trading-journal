// Price-drift direction gate -- Phase 0 calibration/recheck only, NOT wired live.
//
// User's proposal (2026-09-16, framed as "prevent perpetual counter-trend moves"): a variant
// of the existing DirGate mechanism (isDirectionLossBlocked()/tagDirectionGateShadow() in
// acd.js), but using PRICE DRIFT instead of the last trade's win/loss outcome as the gating
// state. Roster-wide, per direction: remember the entry price of the last real trade that
// fired in that direction. The next candidate in that SAME direction is gated if price has
// since moved further into the "wrong" side (higher for a SHORT, lower for a LONG) than that
// reference. If NOT gated, it fires and its own entry price becomes the new reference for that
// direction -- so as long as price keeps making new highs, every new SHORT keeps getting
// gated (and vice versa for a falling market gating LONGs), self-clearing the moment a
// same-direction attempt occurs at a price that has NOT extended further against it.
//
// State never updates from a trade that would have been gated in the counterfactual (matching
// backtest_direction_alternation_after_loss.mjs's own no-lookahead convention) -- walked
// strictly in fired_at order. Direction via the shared resolveDirection() (server/config/
// setupTypes.js), never reimplemented. Entry price = entry_zone_high ?? entry_zone_low,
// matching breakevenStopShadow.js's own convention for "the trade's entry."
//
// Session-scoped (RTH vs Globex, state resets at the boundary) from the start this time --
// DirGate itself only added this 2026-09-14 after a real live miss (a Globex trade inheriting
// stale state from the prior RTH session), so there's no reason to re-discover that bug here.
// RTH is defined the same way DirGate's own RTH_SESSION_FIRED_AT_SQL does (570-1080 ET
// minutes, bucketing the 4-6pm dead zone as RTH-adjacent since no new candidate fires there).
//
// Real trade population: POOLED_TRADE_FILTER (backtest_setup_status.mjs) -- origin_status
// IN ('ACTIVE','SHADOW'), excludes MTM/stale-basis resolutions, AND is_cluster_primary --
// the last filter matters more here than in a simple aggregation: without it, simultaneous
// confluence-cluster siblings of the same setup_type would look like several independent rapid
// same-direction "attempts" at the same instant, corrupting the sequential state machine this
// script is built around.
//
// Reported per this session's own standing discipline (feedback_reactive_exposure_cutting_
// reversion_trap in Claude's memory: "reduce exposure after a bad sign" ideas have repeatedly
// looked good pooled and reversed on a recent-vs-full split) -- full history AND a rolling
// 45-day recent window, plus computeRigor() day-clustering/stability on the gated bucket,
// before trusting any full-history verdict alone.

import { query } from '../server/db.js';
import { resolveDirection } from '../server/config/setupTypes.js';
import { POOLED_TRADE_FILTER } from './backtest_setup_status.mjs';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const RTH_LOW = 570, RTH_HIGH = 1080; // matches acd.js's RTH_SESSION_FIRED_AT_SQL exactly

export async function loadRealTrades() {
  const r = await query(`
    SELECT setup_type, trade_date::text AS trade_date, fired_at, actual_pnl::float AS pnl,
           stop_level::float AS stop_level, t1_level::float AS t1_level,
           entry_zone_low::float AS entry_zone_low, entry_zone_high::float AS entry_zone_high,
           (EXTRACT(hour FROM fired_at)*60 + EXTRACT(minute FROM fired_at))::int AS fired_mod
    FROM active_setups
    WHERE ${POOLED_TRADE_FILTER} AND actual_pnl IS NOT NULL
    ORDER BY fired_at ASC
  `);
  return r.rows;
}

export function sessionOf(firedMod) {
  return (firedMod >= RTH_LOW && firedMod < RTH_HIGH) ? 'RTH' : 'GLOBEX';
}

// No lookahead: state[dir] only updates from a trade that would have actually fired under the
// rule. Returns every classifiable trade tagged with wouldBeGated, plus the raw kept/skipped
// buckets.
//
// scopeKeyFn: how to bucket the gating state. Roster-wide (dir only) is the literal reading of
// the user's proposal ("DirGate but with price"), but it means a SHORT on a far-away, thinly-
// touched level (e.g. PY_VAL) gets compared against the entry price of the last SHORT on a
// totally different level (e.g. OR5_HIGH) -- that's not measuring trend persistence, it's
// measuring which two unrelated levels happen to sit at which prices. Also run a same-setup_type
// -scoped variant (state keyed by dir+setup_type) as the confound check the "confound checklist"
// convention requires before trusting a roster-wide comparison-style result.
export function simulate(trades, scopeKeyFn) {
  const state = new Map(); // scopeKey -> { price, firedAt }
  let lastSession = null;
  const tagged = [];
  for (const t of trades) {
    const dir = resolveDirection(t);
    const entry = t.entry_zone_high ?? t.entry_zone_low;
    if (dir == null || entry == null) continue; // unclassifiable -- exclude from both arms

    const session = sessionOf(t.fired_mod);
    if (session !== lastSession) { state.clear(); lastSession = session; }

    const scopeKey = scopeKeyFn(t, dir);
    const refEntry = state.has(scopeKey) ? state.get(scopeKey) : null;
    const isFirstTouch = refEntry == null;
    const wouldBeGated = refEntry != null && (dir === 'SHORT' ? entry > refEntry.price : entry < refEntry.price);
    const minutesSinceRef = refEntry ? (new Date(t.fired_at) - new Date(refEntry.firedAt)) / 60000 : null;
    tagged.push({ ...t, dir, entry, session, wouldBeGated, isFirstTouch, minutesSinceRef });
    if (!wouldBeGated) state.set(scopeKey, { price: entry, firedAt: t.fired_at }); // only a real (counterfactually-fired) trade updates the reference
  }
  return tagged;
}

export function bucketStats(rows) {
  const n = rows.length;
  const wins = rows.filter(t => t.pnl > 0).length;
  const pnl = rows.reduce((s, t) => s + t.pnl, 0);
  return { n, wins, pnl, wr: n ? +(100 * wins / n).toFixed(1) : null, ev: n ? +(pnl / n).toFixed(2) : null };
}

function gateStreaks(rows) {
  // Longest run of consecutive wouldBeGated=true, walked in fired order, per direction+session
  // (a streak spanning a session reset isn't really "one streak"). Sanity check only -- confirms
  // the mechanism actually behaves like "stays gated through a sustained trend" as described,
  // not a stat the verdict depends on.
  let cur = 0, longest = 0;
  let lastKey = null;
  for (const t of rows) {
    const key = `${t.dir}|${t.session}`;
    if (key !== lastKey) { cur = 0; lastKey = key; }
    if (t.wouldBeGated) { cur++; longest = Math.max(longest, cur); }
    else cur = 0;
  }
  return longest;
}

// Correct question is NOT "is the gated bucket's own P&L negative" (most of this roster's
// recent real population is net negative regardless -- see feedback-asymmetric-payoff-not-
// winrate / this session's own pooled-EV numbers elsewhere) -- it's "is the gated bucket WORSE
// than the kept bucket," i.e. does removing it actually improve the average of what's left.
function verdict(gStats, kStats, minN = 20) {
  if (gStats.n < minN) return 'THIN_GATED_N';
  if (gStats.ev < kStats.ev) return 'GATE_REMOVES_WORSE_TRADES_ADDS_VALUE';
  if (gStats.ev > kStats.ev) return 'GATE_REMOVES_BETTER_TRADES_HARMFUL_REVERSED';
  return 'NO_DIFFERENCE';
}

// Time buckets on minutesSinceRef -- tests the user's added hypothesis (2026-09-16, prompted
// by a real same-day example: OR30_HIGH_FADE_SHORT @29481.5 10:47:27 stopped, then
// IB_HIGH_FADE_SHORT @29469.5 -- a WORSE price for a short -- just 81 seconds later, also
// stopped) that a FAST worse-priced repeat deserves more scrutiny than a slow one.
const TIME_BUCKETS = [
  { label: '<10min', test: m => m < 10 },
  { label: '10-60min', test: m => m >= 10 && m < 60 },
  { label: '1-4hr', test: m => m >= 60 && m < 240 },
  { label: '4hr+', test: m => m >= 240 },
];

async function runScope(label, scopeKeyFn, recentCutoff, today, slug) {
  const allTrades = await loadRealTrades();
  const tagged = simulate(allTrades, scopeKeyFn);
  const firstTouch = tagged.filter(t => t.isFirstTouch);
  const repeats = tagged.filter(t => !t.isFirstTouch); // excludes first-touch from BOTH arms -- the confound fix
  const gated = repeats.filter(t => t.wouldBeGated);
  const kept = repeats.filter(t => !t.wouldBeGated); // "genuine" kept: a real prior reference existed AND this trade matched/improved on it
  const gatedRecent = gated.filter(t => t.trade_date >= recentCutoff);
  const keptRecent = kept.filter(t => t.trade_date >= recentCutoff);

  const gStats = bucketStats(gated), kStats = bucketStats(kept);
  const gStatsRecent = bucketStats(gatedRecent), kStatsRecent = bucketStats(keptRecent);
  const longestGateStreak = gateStreaks(tagged);
  const overall = bucketStats(tagged);
  const firstStats = bucketStats(firstTouch);

  console.log(`\n########## ${label} ##########`);
  console.log(`Classifiable: ${tagged.length} (of ${allTrades.length} real trades)`);
  console.log(`Overall (no gate):     N=${overall.n} WR=${overall.wr}% EV=$${overall.ev}/trade`);
  console.log(`First-touch-of-session (excluded from the comparison, reference only): N=${firstStats.n} EV=$${firstStats.ev}/trade`);
  console.log(`Would-be-GATED (worse-priced repeat):        N=${gStats.n} WR=${gStats.wr}% EV=$${gStats.ev}/trade total=$${gStats.pnl.toFixed(2)}`);
  console.log(`Would-be-KEPT  (same-or-better-priced repeat): N=${kStats.n} WR=${kStats.wr}% EV=$${kStats.ev}/trade total=$${kStats.pnl.toFixed(2)}`);
  console.log(`Longest consecutive-gated streak (same scope+session): ${longestGateStreak}`);
  console.log(`\n-- Since ${recentCutoff} (rolling 45d) --`);
  console.log(`GATED: N=${gStatsRecent.n} EV=$${gStatsRecent.ev}/trade | KEPT: N=${kStatsRecent.n} EV=$${kStatsRecent.ev}/trade`);

  const dirSplit = {};
  for (const d of ['LONG', 'SHORT']) {
    const gd = bucketStats(gated.filter(t => t.dir === d));
    const kd = bucketStats(kept.filter(t => t.dir === d));
    dirSplit[d] = { gated: gd, kept: kd };
    console.log(`  [${d}] GATED N=${gd.n} EV=$${gd.ev} | KEPT N=${kd.n} EV=$${kd.ev}`);
  }

  console.log(`\n-- GATED bucket by time-since-reference-fire --`);
  const timeSplit = {};
  for (const tb of TIME_BUCKETS) {
    const bucketGated = bucketStats(gated.filter(t => tb.test(t.minutesSinceRef)));
    const bucketKept = bucketStats(kept.filter(t => tb.test(t.minutesSinceRef)));
    timeSplit[tb.label] = { gated: bucketGated, kept: bucketKept };
    console.log(`  [${tb.label}] GATED N=${bucketGated.n} EV=$${bucketGated.ev} | KEPT N=${bucketKept.n} EV=$${bucketKept.ev}`);
  }

  const v = verdict(gStats, kStats);
  const vRecent = gStatsRecent.n >= 10 && kStatsRecent.n >= 10 ? verdict(gStatsRecent, kStatsRecent, 10) : 'THIN_RECENT';
  console.log(`\nVerdict (full): ${v} | Verdict (recent 45d): ${vRecent}`);

  let rigor = { clustered: null, stable: null, top5DayPct: null, distinctDates: null };
  if (gStats.n >= 20) {
    rigor = computeRigor(gated, { dateField: 'trade_date', pnlFn: t => t.pnl });
    console.log(`Rigor on GATED bucket: clustered=${rigor.clustered} stable=${rigor.stable} top5DayPct=${rigor.top5DayPct}% distinctDates=${rigor.distinctDates}`);
  }

  const timeSplitText = TIME_BUCKETS.map(tb =>
    `${tb.label}: GATED N=${timeSplit[tb.label].gated.n} EV=$${timeSplit[tb.label].gated.ev} vs KEPT N=${timeSplit[tb.label].kept.n} EV=$${timeSplit[tb.label].kept.ev}`
  ).join('; ');

  await recordClaim({
    slug,
    claimText: `Price-drift direction gate Phase 0, ${label} scope (event-based, no lookahead -- a DirGate ` +
      `variant that gates a direction if price has moved further against it since the last real SAME-` +
      `DIRECTION fire's entry price, using entry price rather than win/loss as the gating state; state only ` +
      `updates from a trade that would have actually fired in the counterfactual). CORRECTED methodology ` +
      `(first pass was confounded): first-touch-of-session trades (no reference yet, unconditionally kept) ` +
      `are EXCLUDED from both arms -- N=${firstStats.n} EV=$${firstStats.ev}/trade, that's just roster baseline ` +
      `performance and swamped the original comparison. Restricting to genuine repeat fires only: Would-be-` +
      `GATED (worse-priced repeat): N=${gStats.n} WR=${gStats.wr}% EV=$${gStats.ev}/trade total=$${gStats.pnl.toFixed(2)}. ` +
      `Would-be-KEPT (same-or-better-priced repeat): N=${kStats.n} WR=${kStats.wr}% EV=$${kStats.ev}/trade ` +
      `total=$${kStats.pnl.toFixed(2)}. Verdict (full history): ${v}. Since ${recentCutoff}: GATED N=${gStatsRecent.n} ` +
      `EV=$${gStatsRecent.ev}, KEPT N=${kStatsRecent.n} EV=$${kStatsRecent.ev}, verdict: ${vRecent}. Direction split -- ` +
      `LONG: GATED N=${dirSplit.LONG.gated.n} EV=$${dirSplit.LONG.gated.ev} vs KEPT N=${dirSplit.LONG.kept.n} EV=$${dirSplit.LONG.kept.ev}; ` +
      `SHORT: GATED N=${dirSplit.SHORT.gated.n} EV=$${dirSplit.SHORT.gated.ev} vs KEPT N=${dirSplit.SHORT.kept.n} EV=$${dirSplit.SHORT.kept.ev}. ` +
      `Time-since-reference-fire split (user's 2026-09-16 follow-up hypothesis, prompted by a real same-day ` +
      `81-second worse-priced repeat: OR30_HIGH_FADE_SHORT@29481.5 10:47:27 -> IB_HIGH_FADE_SHORT@29469.5 10:48:48, ` +
      `both stopped): ${timeSplitText}. Rigor on gated bucket: clustered=${rigor.clustered}, stable=${rigor.stable}, ` +
      `top5DayPct=${rigor.top5DayPct}%, distinctDates=${rigor.distinctDates}. Longest observed consecutive-gated ` +
      `streak (same scope+session) = ${longestGateStreak}. Phase 0 only -- no placebo control, no order-flow ` +
      `component tested yet, not wired anywhere. Uses each trade's own already-realized actual_pnl (real ` +
      `historical stop/target), so no separate $ resimulation was needed for this gate-type signal.`,
    sourceFile: 'scripts/backtest_price_drift_gate_phase0.mjs',
    sourceDate: today,
    sampleSize: gStats.n,
    evPerTrade: gStats.ev,
    rigorStatus: rigor.clustered ? 'day_clustered' : rigor.stable ? 'stable' : (gStats.n >= 20 ? 'stable' : 'not_checked'),
    status: 'PROVISIONAL',
  });
  console.log(`Recorded RESEARCH_CLAIM ${slug}.`);
  return { v, vRecent, gStats, kStats, overall, timeSplit };
}

async function main() {
  const todayR = await query(`SELECT CURRENT_DATE::text AS today`);
  const today = todayR.rows[0].today;
  const recentCutoffR = await query(`SELECT (CURRENT_DATE - INTERVAL '45 days')::text AS cutoff`);
  const recentCutoff = recentCutoffR.rows[0].cutoff;

  // Arm 1: roster-wide, the literal reading of the proposal (dir only).
  await runScope('ROSTER-WIDE (dir only)', (t, dir) => dir, recentCutoff, today,
    'price_drift_gate_phase0_rosterwide_20260916');

  // Arm 2: same-setup_type-scoped confound check (dir + setup_type) -- does the roster-wide
  // result survive once you're only ever comparing repeat touches of the SAME setup_type
  // against each other, rather than mixing in unrelated levels/setups that just happen to sit
  // at different prices?
  await runScope('SAME-SETUP_TYPE-SCOPED (dir + setup_type)', (t, dir) => `${dir}|${t.setup_type}`, recentCutoff, today,
    'price_drift_gate_phase0_samesetuptype_20260916');

  process.exit(0);
}

// Guard so a sibling script (backtest_price_drift_gate_orderflow_phase0b.mjs) can import
// simulate()/loadRealTrades()/bucketStats()/sessionOf() without also re-running main() and
// double-recording these claims as an import side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
