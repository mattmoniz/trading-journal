// Shared walk-forward tercile test: does the volume-building prior-backdrop measure predict
// real fade P&L for a given classifyLevelFormation() family? Extracted from
// scripts/backtest_ib_or_volbuild_walkforward_refresh.mjs (the SAME_DAY_FORMING re-verification)
// so scripts/backtest_priorday_volbuild_walkforward.mjs (the PRIOR_DAY_OR_DEVELOPING follow-up,
// 2026-09-01) reuses the exact same no-lookahead methodology instead of a second hand-copy --
// per this codebase's "share modules" convention. Do not duplicate this logic a third time; add
// a new thin wrapper script that calls runVolbuildWalkforwardTercile() instead.
import { query } from '../../server/db.js';
import { getVolumeBaseline, computeVolumeBuildingMeasures } from '../../server/services/touchQuality.js';
import { classifyLevelFormation } from '../../server/config/setupTypes.js';
import { computeRigor } from '../../server/services/rigorDiagnostics.js';
import { recordClaim } from '../record_claim.mjs';

const APPROACH_BARS = 30; // matches touchQuality.js's own VOL_BUILD_APPROACH_BARS*... window
const WARMUP_TRADES = 150; // matches scratch/test_momentum_context_walkforward.mjs's own warmup exactly

export async function runVolbuildWalkforwardTercile({ formationType, familyLabel, claimSlug, sourceFile, promotionMinDays = 25, promotionMaxClusterPct = 50 }) {
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

  const scored = [];
  for (const t of familyTrades) {
    const flooredFiredAt = new Date(t.fired_at);
    flooredFiredAt.setSeconds(0, 0);
    const touchIdx = tsIndex.get(flooredFiredAt.getTime());
    if (touchIdx === undefined || touchIdx < 60) continue;

    const baseline = await getBaselineCached(t.trade_date);
    const priorScores = [];
    for (let k = touchIdx - APPROACH_BARS; k < touchIdx; k++) {
      const pm = computeVolumeBuildingMeasures(bars, k, baseline);
      if ([pm.avgVolZ, pm.volZTrend, pm.avgDayVolZ, pm.dayVolZTrend].every(v => v != null)) {
        priorScores.push(pm.avgVolZ + pm.volZTrend + pm.avgDayVolZ + pm.dayVolZTrend);
      }
    }
    if (priorScores.length < 20) continue;
    const priorAvg = priorScores.reduce((a, b) => a + b, 0) / priorScores.length;
    scored.push({ ...t, priorAvg });
  }
  console.log(`Scoreable (enough prior-bar history): ${scored.length}`);

  // Walk-forward tercile classification -- expanding window of PRIOR trades' own priorAvg
  // values only, no lookahead into future trades.
  const priorAvgHistory = [];
  const tercileClassified = [];
  for (const s of scored) {
    if (priorAvgHistory.length >= WARMUP_TRADES) {
      const sortedHist = [...priorAvgHistory].sort((a, b) => a - b);
      const p33 = sortedHist[Math.floor(sortedHist.length / 3)];
      const p67 = sortedHist[Math.floor(sortedHist.length * 2 / 3)];
      const tercile = s.priorAvg <= p33 ? 'BOTTOM' : s.priorAvg >= p67 ? 'TOP' : 'MID';
      tercileClassified.push({ ...s, tercile });
    }
    priorAvgHistory.push(s.priorAvg);
  }
  console.log(`Classified (after ${WARMUP_TRADES}-trade walk-forward warmup): ${tercileClassified.length}`);

  console.log(`\n--- Tercile breakdown (bottom/mid/top of prior-30-bar backdrop, ${familyLabel}) ---`);
  const bucketStats = {};
  for (const bucket of ['BOTTOM', 'MID', 'TOP']) {
    const b = tercileClassified.filter(c => c.tercile === bucket);
    const wr = b.length ? b.filter(x => x.pnl > 0).length / b.length : null;
    const ev = b.length ? b.reduce((s, x) => s + x.pnl, 0) / b.length : null;
    bucketStats[bucket] = { n: b.length, wr, ev };
    console.log(`${bucket}: N=${b.length}, WR=${wr != null ? (wr * 100).toFixed(1) + '%' : 'n/a'}, EV=${ev != null ? '$' + ev.toFixed(2) : 'n/a'}`);
  }

  // Stability check restricted to TOP-only via filterFn (not zero-padded -- see the 2026-09-01
  // bugfix note in the SAME_DAY_FORMING script this was extracted from).
  const topRigor = computeRigor(tercileClassified, { dateField: 'trade_date', filterFn: e => e.tercile === 'TOP', pnlFn: e => e.pnl });
  const topOnly = tercileClassified.filter(c => c.tercile === 'TOP');
  const topThirdSize = Math.ceil(topOnly.length / 3);
  const topThirds = [0, 1, 2].map(i => topOnly.slice(i * topThirdSize, (i + 1) * topThirdSize));
  const topThirdEvs = topThirds.map(third => third.length ? (third.reduce((s, x) => s + x.pnl, 0) / third.length) : null);
  console.log(`\nTOP-tercile-specific rigor: stable=${topRigor.stable}, top5DayPct=${topRigor.top5DayPct}%`);
  console.log(`TOP tercile EV by chronological third: ${topThirdEvs.map(e => e != null ? '$' + e.toFixed(2) : 'n/a').join(' -> ')}`);
  console.log(`TOP tercile N by chronological third: ${topThirds.map(t => t.length).join(' / ')}`);

  const topDistinctDays = new Set(topOnly.map(c => c.trade_date)).size;
  const wrTop = bucketStats.TOP.wr, evTop = bucketStats.TOP.ev;
  const clearsPromotionBar = topDistinctDays >= promotionMinDays && topRigor.top5DayPct < promotionMaxClusterPct
    && topThirdEvs.every(e => e == null || e >= 0);

  await recordClaim({
    slug: claimSlug,
    claimText: `Standing weekly recheck (run_weekly_backtests.sh) of the ${familyLabel} volume-building fade-quality signal via a walk-forward (no-lookahead, ${WARMUP_TRADES}-trade warmup) tercile split of the prior-30-bar backdrop. BOTTOM N=${bucketStats.BOTTOM.n} EV=$${bucketStats.BOTTOM.ev != null ? bucketStats.BOTTOM.ev.toFixed(2) : 'n/a'}, MID N=${bucketStats.MID.n} EV=$${bucketStats.MID.ev != null ? bucketStats.MID.ev.toFixed(2) : 'n/a'}, TOP N=${topOnly.length} WR=${wrTop != null ? (wrTop * 100).toFixed(1) + '%' : 'n/a'} EV=$${evTop != null ? evTop.toFixed(2) : 'n/a'}. TOP-tercile chronological-third progression: ${topThirdEvs.map(e => e != null ? '$' + e.toFixed(2) : 'n/a').join(' -> ')}. PROMOTION TRIGGER (not yet cleared unless stated): wire as a real size-multiplier factor once TOP tercile spans >=${promotionMinDays} distinct days (currently ${topDistinctDays}) with day-clustering (top5DayPct) under ${promotionMaxClusterPct}% (currently ${topRigor.top5DayPct}%) AND the chronological progression shows no negative period. Bar cleared this run: ${clearsPromotionBar ? 'YES -- ready to wire, flag for review' : 'NOT YET'}.`,
    sourceFile,
    sourceDate: '2026-09-01',
    sampleSize: topOnly.length,
    winRate: wrTop,
    evPerTrade: evTop,
    rigorStatus: clearsPromotionBar ? 'CLEARS_PROMOTION_BAR' : `day_thin_${topDistinctDays}of${promotionMinDays}_days_cluster${topRigor.top5DayPct}pct`,
    status: 'PROVISIONAL',
  });

  if (clearsPromotionBar) console.log('\n*** PROMOTION BAR CLEARED -- flag for live wiring review ***');

  return { skipped: false, bucketStats, topDistinctDays, topClusterPct: topRigor.top5DayPct, topThirdEvs, clearsPromotionBar };
}
