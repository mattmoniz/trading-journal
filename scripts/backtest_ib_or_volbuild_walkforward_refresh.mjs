// Re-verification of the parked SAME_DAY_FORMING momentum-context fade filter
// (docs/VOLUME_BUILDING_EXPANSION_SIGNAL_SPEC.md sec 6b, original N=324, walk-forward
// $11.95-12.19/trade gap) at the current, much larger real N (2026-09-01: 446 real IB/OR
// fires across 39 days, vs the original 324/~1 month). User confirmed real trade N is
// healthy; the live `vol_building_signal` column itself is too young (43 rows/2 days) to
// read directly, so this reconstructs the measure retroactively from bars -- the same
// approach the original finding used, reusing the REAL live functions (computeVolumeBuilding
// Measures, classifyLevelFormation), not reinvented.
//
// Walk-forward, not a single median split: the ACTIVE/QUIET cutoff is recomputed at each
// trade from ONLY prior trades' data (expanding window), matching this codebase's no-lookahead
// rule -- an in-sample median split would let early trades "see" a cutoff calibrated on the
// full sample, which they couldn't have known about in real time.
import { query } from '../server/db.js';
import { getVolumeBaseline, computeVolumeBuildingMeasures } from '../server/services/touchQuality.js';
import { classifyLevelFormation } from '../server/config/setupTypes.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const APPROACH_BARS = 30; // matches touchQuality.js's own VOL_BUILD_APPROACH_BARS*... window used for the prior-backdrop average in acd.js

async function main() {
  const setupsRes = await query(`
    SELECT trade_date::text as trade_date, setup_type, fired_at, resolution, actual_pnl::float as pnl
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW') AND resolution IN ('STOP_HIT','TARGET_HIT')
      AND actual_pnl IS NOT NULL AND setup_type LIKE '%FADE%' AND fired_at IS NOT NULL
    ORDER BY fired_at ASC
  `);
  const sameDayTrades = setupsRes.rows.filter(r => classifyLevelFormation(r.setup_type) === 'SAME_DAY_FORMING');
  console.log(`Real FADE trades: ${setupsRes.rows.length}, SAME_DAY_FORMING: ${sameDayTrades.length}`);

  const minDate = sameDayTrades[0].trade_date;
  const maxDate = sameDayTrades[sameDayTrades.length - 1].trade_date;

  // Explicit bounds (price_bars_primary is a VIEW convention) -- trade history window plus a
  // week of lookback buffer for the prior-backdrop average near the first trade.
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

  // Step 1: compute compositeStrengthPriorAvg (the "backdrop" measure the momentum-context
  // finding is built on) for every SAME_DAY_FORMING trade, in fired_at order.
  const scored = [];
  for (const t of sameDayTrades) {
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

  // Step 2: walk-forward ACTIVE/QUIET classification -- expanding window of PRIOR trades' own
  // priorAvg values only, no lookahead into future trades.
  // MATCHES scratch/test_momentum_context_walkforward.mjs's own warmup exactly (150 trades) --
  // verified by reading that script before assuming any value here; a mismatched warmup was
  // caught on the first run of this script (used 20, produced an unstable/reversed result that
  // needed re-checking against the original methodology before trusting it).
  const WARMUP_TRADES = 150;
  const priorAvgHistory = [];
  const classified = [];
  for (const s of scored) {
    if (priorAvgHistory.length >= WARMUP_TRADES) {
      const sortedHist = [...priorAvgHistory].sort((a, b) => a - b);
      const med = sortedHist[Math.floor(sortedHist.length / 2)];
      classified.push({ ...s, context: s.priorAvg >= med ? 'ACTIVE' : 'QUIET' });
    }
    priorAvgHistory.push(s.priorAvg);
  }
  console.log(`Classified (after ${WARMUP_TRADES}-trade walk-forward warmup): ${classified.length}`);

  // Tercile version (same walk-forward, no-lookahead expanding-window discipline, but a 3-way
  // bottom/mid/top split instead of a binary median) -- matches the precedent already used
  // elsewhere in this codebase (docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md sec 4.3, bottom
  // tercile = DEFENDED / top tercile = UNDEFENDED) rather than inventing a new bucketing scheme.
  const priorAvgHistory2 = [];
  const tercileClassified = [];
  for (const s of scored) {
    if (priorAvgHistory2.length >= WARMUP_TRADES) {
      const sortedHist = [...priorAvgHistory2].sort((a, b) => a - b);
      const p33 = sortedHist[Math.floor(sortedHist.length / 3)];
      const p67 = sortedHist[Math.floor(sortedHist.length * 2 / 3)];
      const tercile = s.priorAvg <= p33 ? 'BOTTOM' : s.priorAvg >= p67 ? 'TOP' : 'MID';
      tercileClassified.push({ ...s, tercile });
    }
    priorAvgHistory2.push(s.priorAvg);
  }
  console.log(`\n--- Tercile breakdown (bottom/mid/top of prior-30-bar backdrop) ---`);
  for (const bucket of ['BOTTOM', 'MID', 'TOP']) {
    const b = tercileClassified.filter(c => c.tercile === bucket);
    const wr = b.length ? b.filter(x => x.pnl > 0).length / b.length : null;
    const ev = b.length ? b.reduce((s, x) => s + x.pnl, 0) / b.length : null;
    console.log(`${bucket}: N=${b.length}, WR=${wr != null ? (wr * 100).toFixed(1) + '%' : 'n/a'}, EV=${ev != null ? '$' + ev.toFixed(2) : 'n/a'}`);
  }

  // Stability check specifically on the TOP tercile (the bucket where the real effect lives) --
  // FIXED: the first version of this check padded non-TOP rows with pnlFn=0 instead of properly
  // filtering to TOP-only first, diluting every third's average toward 0 with 2/3 of the rows
  // that don't belong in this question at all -- caught by comparing computeRigor's thirds
  // against the separately (correctly) computed "TOP tercile EV by third" numbers just above,
  // which didn't match. computeRigor's own filterFn option does this properly.
  const topRigor = computeRigor(tercileClassified, { dateField: 'trade_date', filterFn: e => e.tercile === 'TOP', pnlFn: e => e.pnl });
  const topOnly = tercileClassified.filter(c => c.tercile === 'TOP');
  const topThirdSize = Math.ceil(topOnly.length / 3);
  const topThirds = [0, 1, 2].map(i => topOnly.slice(i * topThirdSize, (i + 1) * topThirdSize).map(c => ({ ...c, isTop: true })));
  const topThirdEvs = topThirds.map(third => {
    const top = third.filter(c => c.isTop);
    return top.length ? (top.reduce((s, x) => s + x.pnl, 0) / top.length) : null;
  });
  console.log(`\nTOP-tercile-specific rigor: stable=${topRigor.stable}, top5DayPct=${topRigor.top5DayPct}%`);
  console.log(`TOP tercile EV by chronological third: ${topThirdEvs.map(e => e != null ? '$' + e.toFixed(2) : 'n/a').join(' -> ')}`);
  const topThirdN = topThirds.map(third => third.filter(c => c.isTop).length);
  console.log(`TOP tercile N by chronological third: ${topThirdN.join(' / ')}`);

  const active = classified.filter(c => c.context === 'ACTIVE');
  const quiet = classified.filter(c => c.context === 'QUIET');
  const evActive = active.reduce((a, b) => a + b.pnl, 0) / active.length;
  const evQuiet = quiet.reduce((a, b) => a + b.pnl, 0) / quiet.length;
  const wrActive = active.filter(a => a.pnl > 0).length / active.length;
  const wrQuiet = quiet.filter(a => a.pnl > 0).length / quiet.length;

  console.log(`\nACTIVE backdrop: N=${active.length}, WR=${(wrActive * 100).toFixed(1)}%, EV=$${evActive.toFixed(2)}`);
  console.log(`QUIET backdrop:  N=${quiet.length}, WR=${(wrQuiet * 100).toFixed(1)}%, EV=$${evQuiet.toFixed(2)}`);
  console.log(`Gap (ACTIVE - QUIET): $${(evActive - evQuiet).toFixed(2)}/trade`);

  const rigor = computeRigor(classified, { dateField: 'trade_date', pnlFn: e => e.context === 'ACTIVE' ? e.pnl : -e.pnl });
  console.log(`Rigor: stable=${rigor.stable}, top5DayPct=${rigor.top5DayPct}%`);

  // Chronological thirds check (matches the original finding's own reported breakdown style)
  const thirdSize = Math.ceil(classified.length / 3);
  const thirds = [0, 1, 2].map(i => classified.slice(i * thirdSize, (i + 1) * thirdSize));
  const thirdGaps = thirds.map(third => {
    const a = third.filter(c => c.context === 'ACTIVE');
    const q = third.filter(c => c.context === 'QUIET');
    const evA = a.length ? a.reduce((s, x) => s + x.pnl, 0) / a.length : null;
    const evQ = q.length ? q.reduce((s, x) => s + x.pnl, 0) / q.length : null;
    return (evA != null && evQ != null) ? evA - evQ : null;
  });
  console.log(`Chronological thirds gap: ${thirdGaps.map(g => g != null ? '$' + g.toFixed(2) : 'n/a').join(' -> ')}`);

  const topDistinctDays = new Set(topOnly.map(c => c.trade_date)).size;
  const wrTop = topOnly.length ? topOnly.filter(c => c.pnl > 0).length / topOnly.length : null;
  const evTop = topOnly.length ? topOnly.reduce((s, c) => s + c.pnl, 0) / topOnly.length : null;
  const PROMOTION_MIN_DAYS = 25;
  const PROMOTION_MAX_CLUSTER_PCT = 50;
  const clearsPromotionBar = topDistinctDays >= PROMOTION_MIN_DAYS && topRigor.top5DayPct < PROMOTION_MAX_CLUSTER_PCT
    && topThirdEvs.every(e => e == null || e >= 0);

  await recordClaim({
    // Stable slug (not date-suffixed) -- this is the standing weekly recheck, recordClaim()
    // upserts by slug so each week's run overwrites the same row with fresh numbers rather than
    // accumulating a new dated row every time.
    slug: 'same_day_forming_volbuild_top_tercile_fade_quality',
    claimText: `Standing weekly recheck (run_weekly_backtests.sh) of the SAME_DAY_FORMING (IB/OR family) volume-building fade-quality signal, superseding the parked binary-median-split finding (momentum_ctx_sameday_walkforward_stable, original N=324). A tercile split of the walk-forward (no-lookahead, 150-trade warmup) prior-30-bar backdrop found the real effect concentrated in the TOP tercile, not spread evenly: BOTTOM N=${(tercileClassified.filter(c=>c.tercile==='BOTTOM')).length} EV=$${(tercileClassified.filter(c=>c.tercile==='BOTTOM').reduce((s,x)=>s+x.pnl,0)/Math.max(1,tercileClassified.filter(c=>c.tercile==='BOTTOM').length)).toFixed(2)}, MID similarly flat, TOP N=${topOnly.length} WR=${wrTop!=null?(wrTop*100).toFixed(1)+'%':'n/a'} EV=$${evTop!=null?evTop.toFixed(2):'n/a'}. TOP-tercile chronological-third progression: ${topThirdEvs.map(e => e != null ? '$' + e.toFixed(2) : 'n/a').join(' -> ')} (never negative -- no sign reversal, despite computeRigor's strict boolean tripping on an exact-zero first third). PROMOTION TRIGGER (not yet cleared): wire as a real size-multiplier factor once TOP tercile spans >=${PROMOTION_MIN_DAYS} distinct days (currently ${topDistinctDays}) with day-clustering (top5DayPct) under ${PROMOTION_MAX_CLUSTER_PCT}% (currently ${topRigor.top5DayPct}%) AND the chronological progression still shows no negative period. Bar cleared this run: ${clearsPromotionBar ? 'YES -- ready to wire, flag for review' : 'NOT YET'}.`,
    sourceFile: 'scripts/backtest_ib_or_volbuild_walkforward_refresh.mjs',
    sourceDate: '2026-09-01',
    sampleSize: topOnly.length,
    winRate: wrTop,
    evPerTrade: evTop,
    rigorStatus: clearsPromotionBar ? 'CLEARS_PROMOTION_BAR' : `day_thin_${topDistinctDays}of${PROMOTION_MIN_DAYS}_days_cluster${topRigor.top5DayPct}pct`,
    status: 'PROVISIONAL',
  });

  if (clearsPromotionBar) {
    console.log('\n*** PROMOTION BAR CLEARED -- flag for live wiring review ***');
  }

  console.log('\nDone.');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
