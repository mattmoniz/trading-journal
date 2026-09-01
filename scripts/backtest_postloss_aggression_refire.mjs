// User's idea (2026-09-01, with a real chart annotated showing sustained one-sided delta):
// after a stop-out, don't just count minutes -- look at what price/order-flow actually did in
// the window between the stop and a refire. Is the move that caused the stop CONTINUING
// (genuine momentum against the fade, real trend) or did it fizzle/revert back toward the level
// (exhaustion, a more legitimate re-test)? Two measures, both direction-aware relative to the
// failed trade's own adverse direction (not generic magnitude like the already-confirmed-negative
// displacement-since-last-visit test):
//   1. Post-stop price continuation: net displacement further in the ADVERSE direction between
//      the stop and the refire touch (positive = kept going against us, negative = reverted back).
//   2. Post-stop order-flow imbalance: net (adverse-side volume - reverting-side volume) over the
//      same window, direction-aware like the earlier into-the-touch order-flow test (which was
//      noise there -- this is a different window, worth checking independently).
import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { classifyLevelFormation } from '../server/config/setupTypes.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

function auc(scores, outcomes) {
  const valid = scores.map((s, i) => ({ s, o: outcomes[i] })).filter(x => x.s != null);
  const pos = valid.filter(x => x.o === 1), neg = valid.filter(x => x.o === 0);
  if (pos.length === 0 || neg.length === 0) return null;
  let wins = 0, ties = 0;
  for (const p of pos) for (const n of neg) { if (p.s > n.s) wins++; else if (p.s === n.s) ties++; }
  return { auc: (wins + 0.5 * ties) / (pos.length * neg.length), n: valid.length };
}

async function main() {
  const setupsRes = await query(`
    SELECT id, setup_type, trade_date::text as trade_date, fired_at, resolved_at, resolution, actual_pnl::float as pnl,
           entry_zone_low::float, entry_zone_high::float,
           LAG(resolved_at) OVER (PARTITION BY trade_date, setup_type ORDER BY fired_at) as prev_resolved_at,
           LAG(resolution) OVER (PARTITION BY trade_date, setup_type ORDER BY fired_at) as prev_resolution,
           LAG(entry_zone_low) OVER (PARTITION BY trade_date, setup_type ORDER BY fired_at) as prev_entry_low,
           LAG(entry_zone_high) OVER (PARTITION BY trade_date, setup_type ORDER BY fired_at) as prev_entry_high
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW') AND resolution IN ('STOP_HIT','TARGET_HIT') AND actual_pnl IS NOT NULL
      AND setup_type LIKE '%FADE%' AND fired_at IS NOT NULL
    ORDER BY fired_at ASC
  `);
  console.log(`Real FADE trades: ${setupsRes.rows.length}`);

  // Refires whose PRIOR trade was specifically a STOP_HIT (loss) -- the user's question is
  // about post-LOSS behavior specifically, not refires after a win.
  const refires = setupsRes.rows.filter(r => {
    if (!r.prev_resolved_at || r.prev_resolution !== 'STOP_HIT') return false;
    const gapMin = (r.fired_at.getTime() - new Date(r.prev_resolved_at).getTime()) / 60000;
    return gapMin > 0 && gapMin < 30;
  });
  console.log(`Refires after a loss (<30min gap): ${refires.length}`);

  const minDate = setupsRes.rows[0].trade_date, maxDate = setupsRes.rows[setupsRes.rows.length - 1].trade_date;
  const barsRes = await query(`
    SELECT ts, close::float, high::float, low::float, COALESCE(bid_volume,0) as bid_volume, COALESCE(ask_volume,0) as ask_volume
    FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date - INTERVAL '3 days' AND ts < $2::date + INTERVAL '1 day' ORDER BY ts ASC
  `, [minDate, maxDate]);
  const bars = barsRes.rows;
  const tsIndex = new Map();
  for (let i = 0; i < bars.length; i++) tsIndex.set(bars[i].ts.getTime(), i);

  const scored = [];
  for (const r of refires) {
    const dir = directionFromType(r.setup_type); // direction of the CURRENT (refire) trade
    // The failed prior trade's adverse direction = opposite of what the fade wanted, i.e. the
    // direction the level broke: for a SHORT fade that stopped, price broke UP (adverse=up); for
    // a LONG fade that stopped, price broke DOWN (adverse=down). Same setup_type -> same
    // direction for both prior and current (this is a same-type refire by construction).
    const adverseUp = dir === 'SHORT'; // SHORT fade's stop = price went up

    const prevResolvedIdx = tsIndex.get(new Date(r.prev_resolved_at).getTime());
    const flooredFiredAt = new Date(r.fired_at); flooredFiredAt.setSeconds(0, 0);
    const touchIdx = tsIndex.get(flooredFiredAt.getTime());
    if (prevResolvedIdx === undefined || touchIdx === undefined || touchIdx <= prevResolvedIdx) continue;

    const stopBar = bars[prevResolvedIdx];
    const stopPrice = stopBar.close;

    let continuation = 0, adverseVol = 0, reversingVol = 0;
    for (let i = prevResolvedIdx + 1; i < touchIdx; i++) {
      const b = bars[i];
      const disp = adverseUp ? (b.high - stopPrice) : (stopPrice - b.low);
      continuation = Math.max(continuation, disp); // furthest point reached in the adverse direction since the stop
      if (adverseUp) { adverseVol += b.ask_volume; reversingVol += b.bid_volume; }
      else { adverseVol += b.bid_volume; reversingVol += b.ask_volume; }
    }
    const totalVol = adverseVol + reversingVol;
    const flowImbalance = totalVol > 0 ? (adverseVol - reversingVol) / totalVol : null;

    scored.push({
      ...r, continuation, flowImbalance, win: r.pnl > 0 ? 1 : 0,
      formation: classifyLevelFormation(r.setup_type),
    });
  }
  console.log(`Scoreable: ${scored.length}`);

  const contAuc = auc(scored.map(s => s.continuation), scored.map(s => s.win));
  const flowAuc = auc(scored.map(s => s.flowImbalance), scored.map(s => s.win));
  console.log(`\nPost-stop price continuation (further adverse movement before refire): AUC=${contAuc?.auc.toFixed(3)} (N=${contAuc?.n})`);
  console.log(`Post-stop order-flow imbalance (adverse-side vs reverting-side volume): AUC=${flowAuc?.auc.toFixed(3)} (N=${flowAuc?.n})`);

  function bucketReport(scoreKey, label) {
    const withScore = scored.filter(s => s[scoreKey] != null);
    const sorted = [...withScore].sort((a, b) => a[scoreKey] - b[scoreKey]);
    const third = Math.ceil(sorted.length / 3);
    const groups = [sorted.slice(0, third), sorted.slice(third, 2 * third), sorted.slice(2 * third)];
    console.log(`\n${label} tercile WR/EV:`);
    for (const [i, g] of groups.entries()) {
      const wr = g.length ? g.filter(x => x.win === 1).length / g.length : null;
      const ev = g.length ? g.reduce((s, x) => s + x.pnl, 0) / g.length : null;
      console.log(`  T${i + 1}: N=${g.length}, WR=${wr != null ? (wr * 100).toFixed(1) + '%' : 'n/a'}, EV=${ev != null ? '$' + ev.toFixed(2) : 'n/a'}`);
    }
  }
  bucketReport('continuation', 'Post-stop continuation');
  bucketReport('flowImbalance', 'Post-stop order-flow imbalance');

  // Day-clustering + family consistency (per this session's own established discipline).
  const distinctDays = new Set(scored.map(s => s.trade_date)).size;
  const byDate = {};
  for (const s of scored) byDate[s.trade_date] = (byDate[s.trade_date] || 0) + 1;
  const top5 = Object.values(byDate).sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0);
  console.log(`\nDistinct days: ${distinctDays}, top5DayPct: ${scored.length ? (top5 / scored.length * 100).toFixed(1) : 'n/a'}%`);

  const byFormation = {};
  const contMedian = [...scored].map(s => s.continuation).sort((a, b) => a - b)[Math.floor(scored.length / 2)];
  for (const s of scored) {
    const f = s.formation;
    if (!byFormation[f]) byFormation[f] = { low: [], high: [] };
    (s.continuation <= contMedian ? byFormation[f].low : byFormation[f].high).push(s.pnl);
  }
  console.log(`\nBy formation type (continuation median split):`);
  for (const [f, v] of Object.entries(byFormation)) {
    const evLow = v.low.length ? v.low.reduce((a, b) => a + b, 0) / v.low.length : null;
    const evHigh = v.high.length ? v.high.reduce((a, b) => a + b, 0) / v.high.length : null;
    console.log(`  ${f}: LOW-cont N=${v.low.length} EV=${evLow != null ? '$' + evLow.toFixed(2) : 'n/a'}, HIGH-cont N=${v.high.length} EV=${evHigh != null ? '$' + evHigh.toFixed(2) : 'n/a'}`);
  }

  await recordClaim({
    slug: 'postloss_aggression_predicts_refire_outcome',
    claimText: `User's idea (2026-09-01, motivated by a real chart showing sustained one-sided cumulative delta): after a stop-out, does the price/order-flow behavior in the window between the stop and a same-type refire predict the refire's outcome -- is the move that caused the stop CONTINUING (real momentum against the fade) or reverting/fizzling? Tested on real (origin_status=ACTIVE) same-type refires specifically after a STOP_HIT (not after a win), N=${scored.length} across ${distinctDays} distinct days (top5DayPct=${scored.length ? (top5/scored.length*100).toFixed(1) : 'n/a'}%). Post-stop price continuation (furthest adverse-direction point reached before the refire) AUC=${contAuc?.auc.toFixed(3)}. Post-stop order-flow imbalance (adverse-side vs reverting-side volume in that window) AUC=${flowAuc?.auc.toFixed(3)}. See console/script output for full tercile and formation-type breakdowns.`,
    sourceFile: 'scripts/backtest_postloss_aggression_refire.mjs',
    sourceDate: '2026-09-01',
    sampleSize: scored.length,
    rigorStatus: 'first_pass_see_breakdown',
    status: 'PROVISIONAL',
  });

  console.log('\nDone.');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
