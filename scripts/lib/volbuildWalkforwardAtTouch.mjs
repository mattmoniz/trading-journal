// Shared walk-forward test: does volume-building compositeStrength AT THE TOUCH BAR predict
// real fade P&L for a given classifyLevelFormation() family?
//
// CORRECTED 2026-09-01 after direct user pushback on two real methodology problems in the
// first version of this file (then named volbuildWalkforwardTercile.mjs):
// 1. It measured a 30-bar TRAILING AVERAGE of compositeStrength before the touch ("momentum
//    context" backdrop, matching the original parked finding's own construction) -- but the
//    RUN/HELD test that actually found the large, clean, family-split signal
//    (RESEARCH_CLAIM volume_building_run_held_by_level_formation_type, N=36,848) measured
//    compositeStrength AT THE TOUCH BAR ITSELF, no smoothing. Different variable entirely.
// 2. It split into TERCILES, inconsistent with the RUN/HELD test's QUARTILES. Since the RUN/HELD
//    quartile data showed a smooth monotonic climb through the top quartile specifically, a
//    tercile's wider (33%) top bucket risked diluting an effect concentrated in a narrower slice
//    -- exactly the coarse-bucket-hides-a-real-effect failure mode already seen once this session
//    (SAME_DAY_FORMING's binary median split hid what a tercile split revealed).
// Re-testing PRIOR_DAY_OR_DEVELOPING with the corrected (at-touch, quartile) measure did NOT
// turn a false negative into a clean positive -- it produced a genuinely ambiguous, U-shaped,
// unstable result (RESEARCH_CLAIM prior_day_volbuild_top_tercile_fade_quality, corrected to
// INCONCLUSIVE). But applying the SAME corrected measure to SAME_DAY_FORMING for consistency
// (not cherry-picked) produced an EVEN CLEANER result than the original tercile version: a
// smooth monotonic Q1->Q4 climb, true chronological stability, EV=$26.87/trade in Q4 (up from
// $18.06 with the smoothed/tercile version). Standardizing on this methodology going forward.
import { query } from '../../server/db.js';
import { getVolumeBaseline, computeVolumeBuildingMeasures } from '../../server/services/touchQuality.js';
import { classifyLevelFormation } from '../../server/config/setupTypes.js';
import { computeRigor } from '../../server/services/rigorDiagnostics.js';
import { recordClaim } from '../record_claim.mjs';

const WARMUP_TRADES = 150; // matches scratch/test_momentum_context_walkforward.mjs's own warmup exactly

export async function runVolbuildWalkforwardAtTouch({ formationType, familyLabel, claimSlug, sourceFile, promotionMinDays = 25, promotionMaxClusterPct = 50 }) {
  const setupsRes = await query(`
    SELECT trade_date::text as trade_date, setup_type, fired_at, resolution, actual_pnl::float as pnl
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW') AND resolution IN ('STOP_HIT','TARGET_HIT')
      AND actual_pnl IS NOT NULL AND setup_type LIKE '%FADE%' AND fired_at IS NOT NULL
    ORDER BY fired_at ASC
  `);
  const familyTrades = setupsRes.rows.filter(r => classifyLevelFormation(r.setup_type) === formationType);
  console.log(`Real FADE trades: ${setupsRes.rows.length}, ${formationType}: ${familyTrades.length}`);
  if (familyTrades.length < WARMUP_TRADES + 20) {
    console.log(`Too few trades (< warmup + 20) to run this test yet.`);
    return { skipped: true, reason: 'insufficient_n', n: familyTrades.length };
  }

  const minDate = familyTrades[0].trade_date;
  const maxDate = familyTrades[familyTrades.length - 1].trade_date;

  // Explicit bounds (price_bars_primary is a VIEW convention).
  const barsRes = await query(`
    SELECT ts, COALESCE(bid_volume,0)+COALESCE(ask_volume,0) as volume,
           (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as mod
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= $1::date - INTERVAL '7 days' AND ts < $2::date + INTERVAL '1 day'
    ORDER BY ts ASC
  `, [minDate, maxDate]);
  const bars = barsRes.rows.map(b => ({ ts: b.ts.getTime(), mod: b.mod, volume: Number(b.volume) }));
  const tsIndex = new Map();
  for (let i = 0; i < bars.length; i++) tsIndex.set(bars[i].ts, i);
  console.log(`Loaded ${bars.length} bars.`);

  const baselineCache = new Map();
  async function getBaselineCached(date) {
    if (!baselineCache.has(date)) baselineCache.set(date, await getVolumeBaseline(query, date));
    return baselineCache.get(date);
  }

  // AT-TOUCH compositeStrength -- matches scripts/backtest_liquidity_zones_volbuild_touch_
  // quality.mjs's construction exactly (computeVolumeBuildingMeasures at touchIdx itself, no
  // trailing average), which is the same measure/function acd.js uses live.
  const scored = [];
  for (const t of familyTrades) {
    const flooredFiredAt = new Date(t.fired_at);
    flooredFiredAt.setSeconds(0, 0);
    const touchIdx = tsIndex.get(flooredFiredAt.getTime());
    if (touchIdx === undefined) continue;
    const baseline = await getBaselineCached(t.trade_date);
    const measures = computeVolumeBuildingMeasures(bars, touchIdx, baseline);
    if ([measures.avgVolZ, measures.volZTrend, measures.avgDayVolZ, measures.dayVolZTrend].every(v => v != null)) {
      const cs = measures.avgVolZ + measures.volZTrend + measures.avgDayVolZ + measures.dayVolZTrend;
      scored.push({ ...t, cs });
    }
  }
  console.log(`Scoreable (at-touch compositeStrength available): ${scored.length}`);

  // Walk-forward QUARTILE classification -- expanding window of PRIOR trades' own cs values
  // only, no lookahead into future trades. Quartile, not tercile, to match the RUN/HELD test's
  // own bucketing exactly.
  const history = [];
  const classified = [];
  for (const s of scored) {
    if (history.length >= WARMUP_TRADES) {
      const sorted = [...history].sort((a, b) => a - b);
      const p25 = sorted[Math.floor(sorted.length * 0.25)];
      const p50 = sorted[Math.floor(sorted.length * 0.50)];
      const p75 = sorted[Math.floor(sorted.length * 0.75)];
      let q;
      if (s.cs <= p25) q = 'Q1'; else if (s.cs <= p50) q = 'Q2'; else if (s.cs <= p75) q = 'Q3'; else q = 'Q4';
      classified.push({ ...s, q });
    }
    history.push(s.cs);
  }
  console.log(`Classified (after ${WARMUP_TRADES}-trade walk-forward warmup): ${classified.length}`);

  console.log(`\n--- AT-TOUCH compositeStrength, quartile split, ${familyLabel} ---`);
  const bucketStats = {};
  for (const bucket of ['Q1', 'Q2', 'Q3', 'Q4']) {
    const b = classified.filter(c => c.q === bucket);
    const wr = b.length ? b.filter(x => x.pnl > 0).length / b.length : null;
    const ev = b.length ? b.reduce((s, x) => s + x.pnl, 0) / b.length : null;
    bucketStats[bucket] = { n: b.length, wr, ev };
    console.log(`${bucket}: N=${b.length}, WR=${wr != null ? (wr * 100).toFixed(1) + '%' : 'n/a'}, EV=${ev != null ? '$' + ev.toFixed(2) : 'n/a'}`);
  }
  const monotonic = bucketStats.Q1.ev <= bucketStats.Q2.ev && bucketStats.Q2.ev <= bucketStats.Q3.ev && bucketStats.Q3.ev <= bucketStats.Q4.ev;
  console.log(`Monotonic Q1<=Q2<=Q3<=Q4: ${monotonic}`);

  const topRigor = computeRigor(classified, { dateField: 'trade_date', filterFn: e => e.q === 'Q4', pnlFn: e => e.pnl });
  const topOnly = classified.filter(c => c.q === 'Q4');
  const topThirdSize = Math.ceil(topOnly.length / 3);
  const topThirds = [0, 1, 2].map(i => topOnly.slice(i * topThirdSize, (i + 1) * topThirdSize));
  const topThirdEvs = topThirds.map(third => third.length ? (third.reduce((s, x) => s + x.pnl, 0) / third.length) : null);
  console.log(`\nQ4-specific rigor: stable=${topRigor.stable}, top5DayPct=${topRigor.top5DayPct}%`);
  console.log(`Q4 EV by chronological third: ${topThirdEvs.map(e => e != null ? '$' + e.toFixed(2) : 'n/a').join(' -> ')}`);
  console.log(`Q4 N by chronological third: ${topThirds.map(t => t.length).join(' / ')}`);

  const topDistinctDays = new Set(topOnly.map(c => c.trade_date)).size;
  const wrTop = bucketStats.Q4.wr, evTop = bucketStats.Q4.ev;
  const clearsPromotionBar = monotonic && topRigor.stable && topDistinctDays >= promotionMinDays && topRigor.top5DayPct < promotionMaxClusterPct
    && topThirdEvs.every(e => e == null || e >= 0);

  const bucketSummary = ['Q1', 'Q2', 'Q3', 'Q4'].map(b => `${b} N=${bucketStats[b].n} EV=$${bucketStats[b].ev != null ? bucketStats[b].ev.toFixed(2) : 'n/a'}`).join(', ');

  await recordClaim({
    slug: claimSlug,
    claimText: `Standing weekly recheck (run_weekly_backtests.sh) of the ${familyLabel} volume-building fade-quality signal, walk-forward (no-lookahead, ${WARMUP_TRADES}-trade warmup) AT-TOUCH compositeStrength (matching the live acd.js/RUN-HELD-test measure exactly, not a smoothed backdrop average), quartile split (matching the RUN/HELD test's own bucketing). ${bucketSummary}. Monotonic Q1<=Q2<=Q3<=Q4: ${monotonic}. Q4-specific chronological-third progression: ${topThirdEvs.map(e => e != null ? '$' + e.toFixed(2) : 'n/a').join(' -> ')}, stable=${topRigor.stable}, distinctDays=${topDistinctDays}, top5DayPct=${topRigor.top5DayPct}%. PROMOTION TRIGGER (not yet cleared unless stated): monotonic AND Q4 chronologically stable AND Q4 spans >=${promotionMinDays} distinct days AND day-clustering under ${promotionMaxClusterPct}% AND no negative chronological period. Bar cleared this run: ${clearsPromotionBar ? 'YES -- ready to wire, flag for review' : 'NOT YET'}.`,
    sourceFile,
    sourceDate: '2026-09-01',
    sampleSize: topOnly.length,
    winRate: wrTop,
    evPerTrade: evTop,
    rigorStatus: clearsPromotionBar ? 'CLEARS_PROMOTION_BAR' : (monotonic ? `monotonic_but_day_thin_${topDistinctDays}of${promotionMinDays}` : 'not_monotonic_inconclusive'),
    status: 'PROVISIONAL',
  });

  if (clearsPromotionBar) console.log('\n*** PROMOTION BAR CLEARED -- flag for live wiring review ***');

  return { skipped: false, bucketStats, monotonic, topDistinctDays, topClusterPct: topRigor.top5DayPct, topThirdEvs, topStable: topRigor.stable, clearsPromotionBar };
}
