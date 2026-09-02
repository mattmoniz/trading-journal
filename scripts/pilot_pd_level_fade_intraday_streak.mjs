// Second, more directly actionable test of the same 2026-09-02 question: does N consecutive
// SAME-DAY real losses on the exact same setup_type (e.g. PD_POC_FADE_LONG specifically, not
// pooled with SHORT) predict the NEXT same-day fire of that exact setup_type will also lose
// (continuation -- a real basis for a same-session pause) or will actually bounce back
// (reversion trap -- exactly the failure mode that sank the rolling-WR circuit breaker,
// RESEARCH_CLAIM rolling_wr_circuit_breaker_v2_not_validated_20260901). No lookahead: streak is
// counted only from trades that fired STRICTLY BEFORE the trade being evaluated, same day.

import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const LEVELS = ['PD_POC', 'PD_VAH', 'PD_VAL'];

async function main() {
  const setupTypes = LEVELS.flatMap(l => [`${l}_FADE_LONG`, `${l}_FADE_SHORT`]);
  const { rows: trades } = await query(`
    SELECT id, trade_date::text as trade_date, setup_type, fired_at::text as fired_at,
           resolution, actual_pnl::float as actual_pnl
    FROM active_setups
    WHERE setup_type = ANY($1)
      AND origin_status IN ('ACTIVE','SHADOW')
      AND resolution IN ('TARGET_HIT','STOP_HIT','TRAIL_EXIT')
      AND actual_pnl IS NOT NULL
    ORDER BY setup_type, fired_at
  `, [setupTypes]);

  const isWin = (t) => t.resolution === 'TARGET_HIT' || (t.resolution === 'TRAIL_EXIT' && t.actual_pnl >= 0);

  // Group by (setup_type, trade_date), walk in fired_at order, compute the PRIOR same-day
  // consecutive-loss streak for this exact setup_type at the moment each trade fired.
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
      ? (() => { const r = computeRigor(bucket, { dateField: 'trade_date', pnlFn: t => t.actual_pnl }); return ` | rigor clean=${r?.clean} stable=${r?.stable} top5DayPct=${r?.top5DayPct}%`; })()
      : ' | N<20, THIN';
    console.log(`  ${label}: N=${bucket.length} WR=${wr}% EV=$${ev}/trade${rigorStr}`);
  }

  console.log(`Loaded ${trades.length} decisive real PD-level-fade trades.\n`);
  console.log('=== Forward outcome conditioned on PRIOR same-day same-exact-setup_type loss streak ===');
  for (const streakLevel of [0, 1, 2]) {
    const bucket = trades.filter(t => t.priorLossStreak === streakLevel || (streakLevel === 2 && t.priorLossStreak >= 2));
    summarize(bucket, `priorLossStreak=${streakLevel}${streakLevel === 2 ? '+' : ''}`);
  }

  console.log('\n=== Same split, PD_POC_FADE_LONG only (the exact setup tonight) ===');
  const pocLong = trades.filter(t => t.setup_type === 'PD_POC_FADE_LONG');
  for (const streakLevel of [0, 1, 2]) {
    const bucket = pocLong.filter(t => t.priorLossStreak === streakLevel || (streakLevel === 2 && t.priorLossStreak >= 2));
    summarize(bucket, `priorLossStreak=${streakLevel}${streakLevel === 2 ? '+' : ''}`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
