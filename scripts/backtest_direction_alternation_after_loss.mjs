// Direction-alternation-after-loss gate -- calibration/recheck only, NOT wired live.
//
// User's proposal (2026-09-05, framed as "prevent sequential losses" and as a variation of the
// existing sibling/directional-conflict rule): once a direction (LONG or SHORT, roster-wide, not
// per-family) takes a real loss, block NEW candidates in that same direction; the blocked
// direction becomes tradeable again only once the OTHER direction itself takes a loss (pure
// alternation on whoever most recently lost -- confirmed with the user, not a daily reset, not a
// fixed cooldown timer). Before a direction has ever lost, nothing is blocked.
//
// No lookahead: state only updates from trades that would have ACTUALLY fired under the rule
// (a trade skipped in the counterfactual never updates blockedDirection), walked strictly in
// fired_at order. Direction comes from the shared resolveDirection() (server/config/setupTypes.js)
// -- never reimplemented here, per this codebase's "export the real function" rule.
//
// Two things are reported, since the user's real goal (fewer sequential losses / drawdown
// relief) and this session's own standing EV-impact discipline are different questions that can
// disagree: (1) does the rule change total realized $ (comparing skipped-trade EV/WR against
// kept-trade EV/WR, mirroring backtest_same_setup_refire_gate.mjs's own convention), and (2) does
// it actually shorten the realized consecutive-loss streak (the user's stated goal), independent
// of whether that costs or saves money. A rule can win on (2) and lose on (1), or vice versa --
// report both, don't collapse to one verdict.
//
// Given this session's own standing finding (4 independent "reduce exposure after a loss" ideas
// backfired on pooled full-history data, see feedback_reactive_exposure_cutting_reversion_trap in
// Claude's memory), this gets the same treatment: full-history AND a recent-regime
// (trade_date>=2026-08-01) split, plus computeRigor() day-clustering/stability on the skipped
// bucket, before trusting any full-history verdict alone.

import { query } from '../server/db.js';
import { resolveDirection } from '../server/config/setupTypes.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

async function loadRealTrades() {
  const r = await query(`
    SELECT setup_type, trade_date::text AS trade_date, fired_at, actual_pnl::float AS pnl,
           stop_level, t1_level
    FROM active_setups
    WHERE origin_status='ACTIVE' AND resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED') AND actual_pnl IS NOT NULL
    ORDER BY fired_at ASC
  `);
  return r.rows;
}

function longestStreak(pnls) {
  let cur = 0, longest = 0;
  for (const p of pnls) {
    if (p < 0) { cur++; longest = Math.max(longest, cur); }
    else cur = 0;
  }
  return longest;
}

function countStreaksOfAtLeast(pnls, minLen) {
  let cur = 0, count = 0;
  for (const p of pnls) {
    if (p < 0) {
      cur++;
      if (cur === minLen) count++; // count each streak once, at the moment it reaches minLen
    } else cur = 0;
  }
  return count;
}

// dailyReset: if true, blockedDirection clears at the start of every new trade_date.
function simulate(trades, dailyReset) {
  let blockedDirection = null;
  let lastDate = null;
  const kept = [];   // trades that would have actually fired under the rule
  const skipped = []; // trades that would have been blocked
  for (const t of trades) {
    if (dailyReset && t.trade_date !== lastDate) { blockedDirection = null; lastDate = t.trade_date; }
    const dir = resolveDirection(t);
    if (dir == null) continue; // can't classify -- exclude from this analysis entirely (both arms)
    if (dir === blockedDirection) {
      skipped.push(t);
      continue;
    }
    kept.push(t);
    if (t.pnl < 0) blockedDirection = dir;                              // just lost -> block this direction
    else if (t.pnl > 0) blockedDirection = (dir === 'LONG') ? 'SHORT' : 'LONG'; // just won -> block the OTHER direction
    // pnl === 0: leave blockedDirection unchanged
  }
  const sum = arr => arr.reduce((s, t) => s + t.pnl, 0);
  const wins = arr => arr.filter(t => t.pnl > 0).length;
  return {
    keptN: kept.length, keptPnl: sum(kept), keptWins: wins(kept),
    skippedN: skipped.length, skippedPnl: sum(skipped), skippedWins: wins(skipped),
    kept, skipped,
  };
}

async function main() {
  const todayR = await query(`SELECT CURRENT_DATE::text AS today`);
  const today = todayR.rows[0].today;

  const allTrades = await loadRealTrades();
  const classified = allTrades.filter(t => resolveDirection(t) != null);
  console.log(`Real resolved trades: ${allTrades.length} total, ${classified.length} classifiable by direction.`);

  const baselineLongestStreak = longestStreak(classified.map(t => t.pnl));
  const baselineStreaks2plus = countStreaksOfAtLeast(classified.map(t => t.pnl), 2);
  const baselineStreaks3plus = countStreaksOfAtLeast(classified.map(t => t.pnl), 3);

  for (const [label, dailyReset] of [['ALTERNATING (no daily reset, user-confirmed variant)', false], ['ALTERNATING + daily reset (robustness check)', true]]) {
    console.log(`\n=== ${label} ===`);
    const full = simulate(classified, dailyReset);
    const recentTrades = classified.filter(t => t.trade_date >= '2026-08-01');
    const recent = simulate(recentTrades, dailyReset);

    const keptStreak = longestStreak(full.kept.map(t => t.pnl));
    const keptStreaks2plus = countStreaksOfAtLeast(full.kept.map(t => t.pnl), 2);
    const keptStreaks3plus = countStreaksOfAtLeast(full.kept.map(t => t.pnl), 3);

    console.log(`Full history: kept N=${full.keptN} (${full.keptWins}W) pnl=$${full.keptPnl.toFixed(2)} | skipped N=${full.skippedN} (${full.skippedWins}W) pnl=$${full.skippedPnl.toFixed(2)}`);
    console.log(`  Baseline (no gate) longest loss streak=${baselineLongestStreak}, streaks-of-2+=${baselineStreaks2plus}, streaks-of-3+=${baselineStreaks3plus}`);
    console.log(`  Under this gate (kept-trades sequence) longest loss streak=${keptStreak}, streaks-of-2+=${keptStreaks2plus}, streaks-of-3+=${keptStreaks3plus}`);
    console.log(`Since 2026-08-01: kept N=${recent.keptN} pnl=$${recent.keptPnl.toFixed(2)} | skipped N=${recent.skippedN} pnl=$${recent.skippedPnl.toFixed(2)}`);

    if (!dailyReset && full.skippedN >= 15) {
      const rigor = computeRigor(full.skipped, { dateField: 'trade_date', pnlFn: t => t.pnl });
      console.log(`  Rigor on skipped bucket: clustered=${rigor.clustered} stable=${rigor.stable} top5DayPct=${rigor.top5DayPct}%`);

      const evVerdict = full.skippedPnl < 0 && recent.skippedPnl <= 0
        ? 'SKIPPED_BUCKET_NET_NEGATIVE_BOTH_WINDOWS_GATE_HAS_EV_VALUE'
        : full.skippedPnl >= 0 && recent.skippedPnl >= 0
        ? 'SKIPPED_BUCKET_NET_POSITIVE_BOTH_WINDOWS_GATE_IS_EV_HARMFUL'
        : 'MIXED_ACROSS_WINDOWS';
      const streakVerdict = keptStreak < baselineLongestStreak ? 'REDUCES_MAX_STREAK' : keptStreak === baselineLongestStreak ? 'NO_CHANGE_TO_MAX_STREAK' : 'INCREASES_MAX_STREAK';

      await recordClaim({
        slug: 'direction_alternation_after_loss_gate_20260905',
        claimText: `Roster-wide direction-alternation gate (block a direction immediately after it loses; unblock it once the ` +
          `other direction loses -- pure alternation, no daily reset, user-confirmed design 2026-09-05, framed as "prevent ` +
          `sequential losses"). Full history: ${full.skippedN} real trades would have been skipped, net $${full.skippedPnl.toFixed(2)} ` +
          `(${full.skippedWins} wins) -- ${full.skippedPnl < 0 ? 'skipping them would have KEPT that loss out, i.e. real EV value' : 'skipping them would have forfeited real profit, i.e. net EV-harmful'}. ` +
          `Since 2026-08-01: skipped N=${recent.skippedN}, net $${recent.skippedPnl.toFixed(2)}. EV verdict: ${evVerdict}. ` +
          `Rigor on skipped bucket: clustered=${rigor.clustered}, stable=${rigor.stable}, top5DayPct=${rigor.top5DayPct}%. ` +
          `Separately, on the user's actual stated goal (fewer sequential losses, not $ impact): baseline (no gate) longest real ` +
          `consecutive-loss streak was ${baselineLongestStreak} (${baselineStreaks2plus} streaks of 2+, ${baselineStreaks3plus} of 3+); ` +
          `under this gate the KEPT-trade sequence's longest streak is ${keptStreak} (${keptStreaks2plus} of 2+, ${keptStreaks3plus} of 3+). ` +
          `Streak verdict: ${streakVerdict}. Not shipped -- reported both dimensions since they can disagree; see OPEN_DECISION ` +
          `direction_alternation_after_loss_gate_pending for the ship/shadow/shelve call.`,
        sourceFile: 'scripts/backtest_direction_alternation_after_loss.mjs',
        sourceDate: today,
        sampleSize: full.skippedN,
        evPerTrade: full.skippedN ? full.skippedPnl / full.skippedN : null,
        rigorStatus: rigor.clustered ? 'day_clustered' : rigor.stable ? 'stable' : 'unstable',
        status: 'PROVISIONAL',
      });
      console.log(`  Recorded RESEARCH_CLAIM direction_alternation_after_loss_gate_20260905 (EV verdict: ${evVerdict}, streak verdict: ${streakVerdict}).`);
    }
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
