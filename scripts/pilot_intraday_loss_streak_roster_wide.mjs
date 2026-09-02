// Broadens pilot_pd_level_fade_intraday_streak.mjs (2026-09-02) per user request ("test it
// against more than just 1-2 days, test it longer against more setups") -- same hypothesis
// (does a same-day, same-exact-setup_type real loss streak predict the next fire of that
// setup_type), same no-lookahead construction, but now over EVERY real setup_type that fires
// live, not just the 3-level PD family. Checks: (1) is this a genuinely roster-wide pattern or
// concentrated in a handful of setup_types (pooled-verdict-hides-subgroups mantra), (2) real
// date-concentration across the full dataset, (3) does it survive excluding the most
// date-clustered days at this larger scale.

import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const isWin = (t) => t.resolution === 'TARGET_HIT' || (t.resolution === 'TRAIL_EXIT' && t.actual_pnl >= 0);

async function main() {
  const { rows: trades } = await query(`
    SELECT id, trade_date::text as trade_date, setup_type, fired_at::text as fired_at,
           resolution, actual_pnl::float as actual_pnl
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND resolution IN ('TARGET_HIT','STOP_HIT','TRAIL_EXIT')
      AND actual_pnl IS NOT NULL
    ORDER BY setup_type, fired_at
  `);
  console.log(`Loaded ${trades.length} decisive real trades, all setup_types, full history.`);
  console.log(`Distinct setup_types: ${new Set(trades.map(t => t.setup_type)).size}`);
  console.log(`Distinct trade_dates: ${new Set(trades.map(t => t.trade_date)).size}`);
  // min/max, not trades[0]/trades[last] -- the query is ORDER BY setup_type, fired_at, so
  // array-position endpoints are whichever setup_type sorts first/last alphabetically, not
  // the actual date range. Caught this exact bug in the console output the first time this
  // script ran (2026-09-02).
  const dates = trades.map(t => t.trade_date).sort();
  console.log(`Date range: ${dates[0]} to ${dates[dates.length - 1]}\n`);

  const byGroup = new Map();
  for (const t of trades) {
    const key = t.setup_type + '|' + t.trade_date;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(t);
  }
  for (const group of byGroup.values()) {
    group.sort((a, b) => a.fired_at.localeCompare(b.fired_at));
    let streak = 0;
    for (const t of group) {
      t.priorLossStreak = streak;
      if (isWin(t)) streak = 0; else streak++;
    }
  }

  function summarize(bucket, label) {
    if (bucket.length === 0) { console.log(`  ${label}: N=0`); return; }
    const wins = bucket.filter(isWin).length;
    const wr = (100 * wins / bucket.length).toFixed(1);
    const ev = (bucket.reduce((s, t) => s + t.actual_pnl, 0) / bucket.length).toFixed(2);
    let rigorStr = bucket.length >= 20
      ? (() => { const r = computeRigor(bucket, { dateField: 'trade_date', pnlFn: t => t.actual_pnl }); return ` | distinctDates=${r?.distinctDates} rigor clean=${r?.clean} stable=${r?.stable} top5DayPct=${r?.top5DayPct}%`; })()
      : ' | N<20, THIN';
    console.log(`  ${label}: N=${bucket.length} WR=${wr}% EV=$${ev}/trade${rigorStr}`);
  }

  console.log('=== ROSTER-WIDE: forward outcome conditioned on prior same-day same-setup_type streak ===');
  for (const streakLevel of [0, 1, 2]) {
    const bucket = trades.filter(t => t.priorLossStreak === streakLevel || (streakLevel === 2 && t.priorLossStreak >= 2));
    summarize(bucket, `priorLossStreak=${streakLevel}${streakLevel === 2 ? '+' : ''}`);
  }

  // Date-concentration check on the streak>=1 population specifically.
  const streaked = trades.filter(t => t.priorLossStreak >= 1);
  const byDate = new Map();
  for (const t of streaked) byDate.set(t.trade_date, (byDate.get(t.trade_date) || 0) + 1);
  const sortedDates = [...byDate.entries()].sort((a, b) => b[1] - a[1]);
  const top5Sum = sortedDates.slice(0, 5).reduce((s, [, n]) => s + n, 0);
  console.log(`\nstreak>=1 population: ${streaked.length} trades across ${byDate.size} distinct dates. Top5 dates = ${top5Sum} (${(100 * top5Sum / streaked.length).toFixed(1)}%). Top 8: ${JSON.stringify(sortedDates.slice(0, 8))}`);

  // Stress test: exclude the single most dominant date, re-check.
  const worstDate = sortedDates[0][0];
  const excl = trades.filter(t => t.trade_date !== worstDate);
  console.log(`\n=== Excluding single most-dominant date (${worstDate}) ===`);
  for (const streakLevel of [0, 1]) {
    const bucket = excl.filter(t => streakLevel === 1 ? t.priorLossStreak >= 1 : t.priorLossStreak === 0);
    summarize(bucket, `priorLossStreak=${streakLevel === 1 ? '1+' : '0'}`);
  }

  // Per-setup_type breakdown for setup_types with enough streak>=1 volume to say anything --
  // is this general across the roster, or a few types driving it (pooled-verdict mantra)?
  console.log('\n=== Per-setup_type breakdown (only types with >=5 streak>=1 fires) ===');
  const byType = new Map();
  for (const t of trades) {
    if (!byType.has(t.setup_type)) byType.set(t.setup_type, { fresh: [], streaked: [] });
    const g = byType.get(t.setup_type);
    if (t.priorLossStreak === 0) g.fresh.push(t); else g.streaked.push(t);
  }
  const rows = [...byType.entries()].filter(([, g]) => g.streaked.length >= 5)
    .map(([type, g]) => {
      const freshWr = g.fresh.length ? 100 * g.fresh.filter(isWin).length / g.fresh.length : null;
      const streakWr = 100 * g.streaked.filter(isWin).length / g.streaked.length;
      const freshEv = g.fresh.length ? g.fresh.reduce((s, t) => s + t.actual_pnl, 0) / g.fresh.length : null;
      const streakEv = g.streaked.reduce((s, t) => s + t.actual_pnl, 0) / g.streaked.length;
      return { type, freshN: g.fresh.length, freshWr, freshEv, streakN: g.streaked.length, streakWr, streakEv, degrades: streakEv < (freshEv ?? 0) };
    })
    .sort((a, b) => (a.streakEv - a.freshEv) - (b.streakEv - b.freshEv));
  for (const r of rows) {
    console.log(`  ${r.type}: fresh N=${r.freshN} WR=${r.freshWr?.toFixed(1)}% EV=$${r.freshEv?.toFixed(2)} -> streak>=1 N=${r.streakN} WR=${r.streakWr.toFixed(1)}% EV=$${r.streakEv.toFixed(2)} ${r.degrades ? '[DEGRADES]' : '[does not degrade]'}`);
  }
  console.log(`\n${rows.filter(r => r.degrades).length} of ${rows.length} eligible setup_types degrade after a same-day loss; ${rows.length - rows.filter(r => r.degrades).length} do not.`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
