// Tests a live-triggered hypothesis (2026-09-02, user spotted a real live whipsaw:
// GLOBEX_VWAP_FADE_LONG hit T1 at 7:35am, GLOBEX_VWAP_FADE_SHORT fired 2 minutes later at
// 7:37am and stopped out, giving back the just-banked win): does firing shortly after the
// OPPOSITE direction of the same family just WON predict a worse outcome than a "fresh" fire?
// User's proposed rule: "if a long makes money, there should be a 10 minute pause on shorts."
// Fully live-knowable, no lookahead -- classification uses only trades that already RESOLVED
// (resolved_at) strictly before the trade being evaluated fires.
//
// Tests multiple pause windows (5/10/15/20 min) since 10 was an initial guess, not a fitted
// value, and multiple setup families (starting with GLOBEX_VWAP_FADE, the trigger case, then
// broadened to every paired-direction fade family with real volume) per user request ("can we
// test this any other times").

import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const isWin = (t) => t.resolution === 'TARGET_HIT' || (t.resolution === 'TRAIL_EXIT' && t.actual_pnl >= 0);

// Paired-direction families to test -- base name without _LONG/_SHORT suffix. Includes the
// trigger case (GLOBEX_VWAP_FADE) plus every other family with real paired-direction volume
// found earlier tonight (PD-level fades, VWAP_MAGNET/GLOBEX_VWAP_MAGNET, OR5, IB).
const FAMILIES = [
  'GLOBEX_VWAP_FADE', 'PD_POC_FADE', 'PD_VAH_FADE', 'PD_VAL_FADE',
  'VWAP_MAGNET', 'GLOBEX_VWAP_MAGNET', 'RTH_VWAP_FADE',
  'OR5_HIGH_FADE', 'OR5_LOW_FADE', 'OR5_MID_FADE',
];

async function main() {
  const { rows: [{ today }] } = await query(`SELECT CURRENT_DATE::text as today`);
  const setupTypes = FAMILIES.flatMap(f => [`${f}_LONG`, `${f}_SHORT`]);
  const { rows: trades } = await query(`
    SELECT id, trade_date::text as trade_date, setup_type, fired_at::text as fired_at,
           resolved_at::text as resolved_at, resolution, actual_pnl::float as actual_pnl
    FROM active_setups
    WHERE setup_type = ANY($1)
      AND origin_status IN ('ACTIVE','SHADOW')
      AND resolution IN ('TARGET_HIT','STOP_HIT','TRAIL_EXIT')
      AND actual_pnl IS NOT NULL AND resolved_at IS NOT NULL
    ORDER BY fired_at
  `, [setupTypes]);
  console.log(`Loaded ${trades.length} decisive real trades across ${FAMILIES.length} paired-direction families.\n`);

  function familyOf(setupType) {
    for (const f of FAMILIES) if (setupType === `${f}_LONG` || setupType === `${f}_SHORT`) return f;
    return null;
  }
  function isLong(setupType) { return setupType.endsWith('_LONG'); }

  // Group by family, sorted by fired_at, so "most recent opposite-direction resolution before
  // this trade's own fire" can be found by a simple scan.
  const byFamily = new Map();
  for (const t of trades) {
    const f = familyOf(t.setup_type);
    if (!byFamily.has(f)) byFamily.set(f, []);
    byFamily.get(f).push(t);
  }
  for (const list of byFamily.values()) {
    list.sort((a, b) => a.fired_at.localeCompare(b.fired_at));
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      // (a) Most recent opposite-direction trade that had ALREADY RESOLVED before this one
      // fired -- the original "pause after a win" framing.
      let mostRecentOpposite = null;
      for (let j = i - 1; j >= 0; j--) {
        const cand = list[j];
        if (isLong(cand.setup_type) !== isLong(t.setup_type) && cand.resolved_at < t.fired_at) {
          mostRecentOpposite = cand;
          break;
        }
      }
      if (mostRecentOpposite) {
        t.minsSinceOppositeResolved = (new Date(t.fired_at.replace(' ', 'T') + 'Z').getTime() -
          new Date(mostRecentOpposite.resolved_at.replace(' ', 'T') + 'Z').getTime()) / 60000;
        t.oppositeWasWin = isWin(mostRecentOpposite);
      }
      // (b) CORRECTED, matching what actually happened tonight: was an opposite-direction
      // trade of the SAME family still OPEN (fired_at <= t.fired_at < resolved_at) at the
      // moment this one fired? Live-knowable (you always know your own open positions),
      // independent of whether that open position is currently winning or losing. Also
      // records how many minutes had elapsed since THAT opposite trade fired -- tests the
      // sharper hypothesis (user follow-up): is a very-fast flip (tonight's exact case, 2min)
      // a genuinely different/worse pattern than a slower overlap, even though "overlap in
      // general" came back net positive?
      let openOpposite = null;
      for (const cand of list) {
        if (cand === t) continue;
        if (isLong(cand.setup_type) !== isLong(t.setup_type) && cand.fired_at <= t.fired_at && cand.resolved_at > t.fired_at) {
          if (!openOpposite || cand.fired_at > openOpposite.fired_at) openOpposite = cand;
        }
      }
      t.oppositeStillOpen = !!openOpposite;
      if (openOpposite) {
        t.minsSinceOppositeFired = (new Date(t.fired_at.replace(' ', 'T') + 'Z').getTime() -
          new Date(openOpposite.fired_at.replace(' ', 'T') + 'Z').getTime()) / 60000;
      }
    }
  }

  function summarize(bucket, label) {
    if (bucket.length === 0) { console.log(`    ${label}: N=0`); return null; }
    const wins = bucket.filter(isWin).length;
    const wr = 100 * wins / bucket.length;
    const ev = bucket.reduce((s, t) => s + t.actual_pnl, 0) / bucket.length;
    const rigor = bucket.length >= 20 ? computeRigor(bucket, { dateField: 'trade_date', pnlFn: t => t.actual_pnl }) : null;
    const rigorStr = rigor ? ` | clean=${rigor.clean} stable=${rigor.stable} top5DayPct=${rigor.top5DayPct}% distinctDates=${rigor.distinctDates}` : ' | N<20, THIN';
    console.log(`    ${label}: N=${bucket.length} WR=${wr.toFixed(1)}% EV=$${ev.toFixed(2)}/trade${rigorStr}`);
    return { n: bucket.length, wr, ev, rigor };
  }

  // 1. Trigger case: GLOBEX_VWAP_FADE alone, across multiple pause windows.
  console.log('=== GLOBEX_VWAP_FADE (the trigger case) ===');
  const gvf = trades.filter(t => familyOf(t.setup_type) === 'GLOBEX_VWAP_FADE');
  for (const mins of [5, 10, 15, 20]) {
    const closeFollow = gvf.filter(t => t.oppositeWasWin && t.minsSinceOppositeResolved != null && t.minsSinceOppositeResolved <= mins);
    const rest = gvf.filter(t => !(t.oppositeWasWin && t.minsSinceOppositeResolved != null && t.minsSinceOppositeResolved <= mins));
    console.log(`  <=${mins}min after opposite win:`);
    summarize(closeFollow, `  within ${mins}min`);
    summarize(rest, `  everything else`);
  }

  // 2. Roster-wide pooled, 10-min window (user's proposed value) -- "can we test this any
  // other times" = broaden across the whole paired-direction fade roster, not just tonight's
  // one family.
  console.log('\n=== ROSTER-WIDE (all 10 families pooled), 10-minute window ===');
  const closeFollow10 = trades.filter(t => t.oppositeWasWin && t.minsSinceOppositeResolved != null && t.minsSinceOppositeResolved <= 10);
  const rest10 = trades.filter(t => !(t.oppositeWasWin && t.minsSinceOppositeResolved != null && t.minsSinceOppositeResolved <= 10));
  const closeR = summarize(closeFollow10, 'within 10min of opposite win');
  const restR = summarize(rest10, 'everything else');

  // 3. Per-family breakdown at 10 min, N>=10 only (pooled-verdict-hides-subgroups check).
  console.log('\n=== Per-family breakdown, 10-minute window (families with >=10 close-follow fires) ===');
  for (const f of FAMILIES) {
    const famTrades = trades.filter(t => familyOf(t.setup_type) === f);
    const cf = famTrades.filter(t => t.oppositeWasWin && t.minsSinceOppositeResolved != null && t.minsSinceOppositeResolved <= 10);
    if (cf.length < 10) continue;
    const rf = famTrades.filter(t => !(t.oppositeWasWin && t.minsSinceOppositeResolved != null && t.minsSinceOppositeResolved <= 10));
    console.log(`  ${f}:`);
    summarize(cf, '    close-follow');
    summarize(rf, '    rest');
  }

  // 4. CORRECTED test matching what actually happened tonight: opposite-direction fired
  // while this family's other side was STILL OPEN (not yet resolved) -- not "shortly after a
  // win." This is what tonight's GLOBEX_VWAP_FADE_LONG (fired 07:35, resolved 07:59) /
  // GLOBEX_VWAP_FADE_SHORT (fired 07:37 -- 22 minutes BEFORE the LONG resolved) pair actually
  // was; the win-based classification above never counted it, since resolved_at(LONG) >
  // fired_at(SHORT).
  console.log('\n=== CORRECTED: fired while opposite direction (same family) was still OPEN ===');
  const overlapping = trades.filter(t => t.oppositeStillOpen);
  const notOverlapping = trades.filter(t => !t.oppositeStillOpen);
  const overlapR = summarize(overlapping, 'opposite still open at fire time');
  const noOverlapR = summarize(notOverlapping, 'no opposite open at fire time');

  console.log('\n--- GLOBEX_VWAP_FADE only (trigger case) ---');
  const gvfOverlap = gvf.filter(t => t.oppositeStillOpen);
  const gvfNoOverlap = gvf.filter(t => !t.oppositeStillOpen);
  summarize(gvfOverlap, 'opposite still open');
  summarize(gvfNoOverlap, 'no opposite open');

  console.log('\n--- Per-family breakdown (families with >=10 overlapping fires) ---');
  for (const f of FAMILIES) {
    const famTrades = trades.filter(t => familyOf(t.setup_type) === f);
    const ov = famTrades.filter(t => t.oppositeStillOpen);
    if (ov.length < 10) continue;
    const noOv = famTrades.filter(t => !t.oppositeStillOpen);
    console.log(`  ${f}:`);
    summarize(ov, '    opposite open');
    summarize(noOv, '    no opposite open');
  }

  // 5. SHARPER test (user follow-up, after the aggregate "overlap is fine" result): is a
  // VERY FAST flip specifically (tonight's exact case: 2 minutes) a different, worse pattern
  // than a slower overlap -- even though overlapping in general came back net positive above?
  console.log('\n=== Within "opposite still open": fast vs. slow flip (minutes since opposite fired) ===');
  const withOverlap = trades.filter(t => t.oppositeStillOpen && t.minsSinceOppositeFired != null);
  const fastFlipR = summarize(withOverlap.filter(t => t.minsSinceOppositeFired <= 5), 'FAST flip (<=5min since opposite fired)');
  summarize(withOverlap.filter(t => t.minsSinceOppositeFired > 5 && t.minsSinceOppositeFired <= 15), 'MEDIUM flip (5-15min)');
  summarize(withOverlap.filter(t => t.minsSinceOppositeFired > 15), 'SLOW flip (>15min)');

  console.log('\n--- Same fast-vs-slow split, GLOBEX_VWAP_FADE only (trigger case) ---');
  const gvfOverlap2 = gvf.filter(t => t.oppositeStillOpen && t.minsSinceOppositeFired != null);
  const gvfFastR = summarize(gvfOverlap2.filter(t => t.minsSinceOppositeFired <= 5), 'FAST flip (<=5min)');
  summarize(gvfOverlap2.filter(t => t.minsSinceOppositeFired > 5 && t.minsSinceOppositeFired <= 15), 'MEDIUM flip (5-15min)');
  summarize(gvfOverlap2.filter(t => t.minsSinceOppositeFired > 15), 'SLOW flip (>15min)');

  await recordClaim({
    slug: 'opposite_direction_post_win_pause',
    claimText: `Weekly auto-refresh (scripts/pilot_opposite_direction_post_win_pause.mjs, wired into run_weekly_backtests.sh). Origin: user-spotted live whipsaw (GLOBEX_VWAP_FADE_LONG fired 07:35, resolved 07:59 TARGET_HIT; GLOBEX_VWAP_FADE_SHORT fired 07:37 -- 22min BEFORE the LONG resolved -- and stopped out). Three tests: (1) ORIGINAL "pause after a win" framing -- this specific pair never matched it (LONG hadn't resolved when SHORT fired), and the pattern is historically too rare to test (N=3-12 depending on window). (2) CORRECTED: fired while the opposite direction was still OPEN -- live-knowable, no lookahead. Roster-wide this is net POSITIVE: overlapping N=${overlapR?.n} WR=${overlapR?.wr?.toFixed(1)}% EV=$${overlapR?.ev?.toFixed(2)} vs non-overlapping N=${noOverlapR?.n} WR=${noOverlapR?.wr?.toFixed(1)}% EV=$${noOverlapR?.ev?.toFixed(2)}. (3) SHARPER follow-up (user asked directly whether the whipsaw itself is fixed): within the overlapping population, does a FAST flip (<=5min since the opposite fired, tonight's exact case) behave worse than a slower one? Roster-wide fast-flip: N=${fastFlipR?.n}, WR=${fastFlipR?.wr?.toFixed(1)}%, EV=$${fastFlipR?.ev?.toFixed(2)}/trade. GLOBEX_VWAP_FADE fast-flip specifically: N=${gvfFastR?.n}, WR=${gvfFastR?.wr?.toFixed(1)}%, EV=$${gvfFastR?.ev?.toFixed(2)}/trade. Compare against the medium/slow buckets printed in the current run's console output -- if fast-flip EV is meaningfully worse than medium/slow, that IS a real, narrow, fixable pattern (a short cooldown scoped to fast flips only, not a blanket overlap suppression); if not, tonight's loss was ordinary variance and there is nothing to fix. Auto-refreshes weekly across 10 paired-direction fade families -- check the printed per-family/per-speed breakdown for current-run detail, not restated here to avoid staleness.`,
    sourceFile: 'scripts/pilot_opposite_direction_post_win_pause.mjs',
    sourceDate: today,
    sampleSize: overlapR?.n,
    winRate: overlapR?.wr,
    evPerTrade: overlapR?.ev,
    rigorStatus: overlapR?.rigor?.clean ? 'clean' : 'checked',
    status: 'PROVISIONAL',
  });
  console.log('\nRESEARCH_CLAIM opposite_direction_post_win_pause refreshed.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
