// Cheap, quick signal-level screen (user's idea, 2026-09-01): does a 4-hour trailing price trend
// at the moment of a fade's entry predict that fade's outcome -- specifically, do fades AGAINST
// that trend underperform fades WITH it? No suppression mechanism built here -- this is the
// cheapest possible test before deciding whether to invest further, per this codebase's own
// "signal-level forward-return pre-test before building trade machinery" convention.
//
// This is the 5th variant of "detect a trend, treat counter-trend fades differently" tested in
// this codebase -- the prior 4 (whole-day dtClass classifier, 3 related sizing/standdown gates,
// a blind exit rule, a fast real-time move trigger) all failed. This tests the one genuinely
// untested angle: a coarser ~4-hour timeframe read, distinct from both a whole-day label and a
// fast intraday trigger.
//
// No lookahead: trend is computed from bars strictly BEFORE the fade's own fired_at.
import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';

async function main() {
  const trades = await query(`
    SELECT id, setup_type, trade_date::text, fired_at, actual_pnl::float, origin_status
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW') AND resolution IN ('STOP_HIT','TARGET_HIT')
      AND setup_type LIKE '%FADE%' AND fired_at IS NOT NULL
      AND actual_pnl IS NOT NULL
    ORDER BY fired_at ASC
  `);
  console.log(`Real+shadow FADE trades: ${trades.rows.length}`);

  const minDate = trades.rows[0].trade_date;
  const maxDate = trades.rows[trades.rows.length - 1].trade_date;
  const bars = await query(`
    SELECT ts, close::float
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= $1::date - INTERVAL '3 days' AND ts < $2::date + INTERVAL '1 day'
    ORDER BY ts ASC
  `, [minDate, maxDate]);
  const tsIndex = new Map();
  for (let i = 0; i < bars.rows.length; i++) tsIndex.set(bars.rows[i].ts.getTime(), i);
  console.log(`Bars loaded: ${bars.rows.length}`);

  const scored = [];
  for (const t of trades.rows) {
    const dir = directionFromType(t.setup_type); // LONG or SHORT
    if (!dir) continue;
    const flooredFiredAt = new Date(t.fired_at); flooredFiredAt.setSeconds(0, 0);
    const nowIdx = tsIndex.get(flooredFiredAt.getTime());
    if (nowIdx === undefined) continue;
    const pastTs = flooredFiredAt.getTime() - 240 * 60000; // 240 min = 4 hours, strictly before fired_at
    const pastIdx = tsIndex.get(pastTs);
    if (pastIdx === undefined || pastIdx >= nowIdx) continue;

    const nowClose = bars.rows[nowIdx].close;
    const pastClose = bars.rows[pastIdx].close;
    const trendChange = nowClose - pastClose; // >0 = 4h uptrend, <0 = 4h downtrend

    // A fade is COUNTER to the 4h trend if it bets on reversal against that trend's direction:
    // LONG fade during a 4h downtrend, or SHORT fade during a 4h uptrend.
    let withOrAgainst;
    if (trendChange > 0) withOrAgainst = (dir === 'SHORT') ? 'COUNTER' : 'WITH';
    else if (trendChange < 0) withOrAgainst = (dir === 'LONG') ? 'COUNTER' : 'WITH';
    else continue; // exactly flat, discard (rare)

    scored.push({
      ...t, dir, trendChange, withOrAgainst,
      win: t.actual_pnl > 0 ? 1 : 0,
    });
  }
  console.log(`Scoreable: ${scored.length}`);

  function bucketStats(rows, label) {
    if (!rows.length) { console.log(`${label}: N=0`); return; }
    const wr = rows.filter(r => r.win === 1).length / rows.length;
    const ev = rows.reduce((s, r) => s + r.actual_pnl, 0) / rows.length;
    const distinctDays = new Set(rows.map(r => r.trade_date)).size;
    const byDate = {};
    for (const r of rows) byDate[r.trade_date] = (byDate[r.trade_date] || 0) + 1;
    const top5 = Object.values(byDate).sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0);
    const top5Pct = (top5 / rows.length * 100).toFixed(1);
    console.log(`${label}: N=${rows.length}, WR=${(wr * 100).toFixed(1)}%, EV=$${ev.toFixed(2)}, distinctDays=${distinctDays}, top5DayPct=${top5Pct}%`);
  }

  const counter = scored.filter(r => r.withOrAgainst === 'COUNTER');
  const withTrend = scored.filter(r => r.withOrAgainst === 'WITH');
  console.log('\n=== Pooled (ACTIVE+SHADOW) ===');
  bucketStats(counter, 'COUNTER-trend fades');
  bucketStats(withTrend, 'WITH-trend fades');

  console.log('\n=== ACTIVE only ===');
  bucketStats(counter.filter(r => r.origin_status === 'ACTIVE'), 'COUNTER-trend fades (ACTIVE)');
  bucketStats(withTrend.filter(r => r.origin_status === 'ACTIVE'), 'WITH-trend fades (ACTIVE)');

  // Magnitude-conditioned: does a STRONGER 4h trend widen the gap? Terciles by |trendChange|.
  const sorted = [...scored].sort((a, b) => Math.abs(a.trendChange) - Math.abs(b.trendChange));
  const third = Math.ceil(sorted.length / 3);
  const strengthBuckets = [sorted.slice(0, third), sorted.slice(third, 2 * third), sorted.slice(2 * third)];
  console.log('\n=== By 4h trend STRENGTH tercile (weak/mid/strong), COUNTER vs WITH ===');
  strengthBuckets.forEach((bucket, i) => {
    const label = ['weak', 'mid', 'strong'][i];
    bucketStats(bucket.filter(r => r.withOrAgainst === 'COUNTER'), `  ${label} tercile COUNTER`);
    bucketStats(bucket.filter(r => r.withOrAgainst === 'WITH'), `  ${label} tercile WITH`);
  });

  console.log('\nDone. No claim recorded -- this is a cheap first screen, not a decision-grade result.');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
