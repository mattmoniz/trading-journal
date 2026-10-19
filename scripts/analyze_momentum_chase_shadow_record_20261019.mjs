// MOMENTUM_CHASE_MEDIUM_LONG/SHORT live SHADOW record vs its backtest claim (OPEN_DECISION
// momentum_chase_hardwired_shadow_no_promotion_path_20261019). Backtest claim being checked:
// RESEARCH_CLAIM setup6_momentum_chase_medium_regime_positive_20260909 (N=128, WR 58.6%, +$13.23/trade).
import { query } from '../server/db.js';
import { REAL_TRADE_FILTER } from './backtest_setup_status.mjs';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import { flagDecision } from './flag_decision.mjs';

// Upper bound = yesterday per the DB's own clock (never JS toISOString), so one run is internally consistent and a
// re-run never reads a half-finished day.
const UPPER = (await query(`SELECT (CURRENT_DATE - 1)::text AS d`)).rows[0].d;
const rows = (await query(`
  SELECT trade_date::text AS date, setup_type, resolution, actual_pnl::float AS pnl, (fired_at::time < '09:35:00') AS in_open_dead_zone
  FROM active_setups WHERE setup_type LIKE 'MOMENTUM_CHASE_MEDIUM_%' AND ${REAL_TRADE_FILTER} AND actual_pnl IS NOT NULL
    AND trade_date <= $1 ORDER BY fired_at`, [UPPER])).rows;
const stat = (r) => ({ n: r.length, days: new Set(r.map(x => x.date)).size, wins: r.filter(x => x.pnl > 0).length, sum: r.reduce((a, x) => a + x.pnl, 0) });
const show = (label, r) => {
  const s = stat(r); const ci = r.length >= 5 ? dayBlockedBootstrapCI(r, 'momchase|' + label) : null;
  console.log(`${label.padEnd(34)} N=${s.n} days=${s.days} WR=${(100 * s.wins / s.n).toFixed(1)}% sum=${s.sum.toFixed(0)} perTrade=${(s.sum / s.n).toFixed(2)}` + (ci ? ` CI[${ci.lo.toFixed(1)},${ci.hi.toFixed(1)}]` : '') + (s.n < 20 ? ' [N<20: not decisive]' : ''));
  return { ...s, perTrade: s.sum / s.n, ci };
};
const all = show('ALL', rows);
show('LONG', rows.filter(r => r.setup_type.endsWith('LONG')));
show('SHORT', rows.filter(r => r.setup_type.endsWith('SHORT')));
const post = show('since 2026-09-28 (post dead-zone fix)', rows.filter(r => r.date >= '2026-09-28'));
const early = rows.filter(r => r.in_open_dead_zone).length;
console.log(`rows that fired inside the 9:30-9:35 dead zone: ${early} of ${rows.length}`);
await recordClaim({
  slug: 'momentum_chase_live_shadow_record_20261019',
  claimText: `MOMENTUM_CHASE live SHADOW record through ${UPPER}: N=${all.n} on ${all.days} days, WR ${(100 * all.wins / all.n).toFixed(1)}%, perTrade $${all.perTrade.toFixed(2)}, day-blocked CI [${all.ci.lo.toFixed(1)},${all.ci.hi.toFixed(1)}] (crosses zero, N<20). Backtest claim was N=128, WR 58.6%, +$13.23. Since 2026-09-28: N=${post.n}, perTrade $${post.perTrade.toFixed(2)}. ${early} of ${rows.length} fired inside the 9:30-9:35 dead zone (pre-fix). Not enough to support promotion; not enough to reject. Recheck at N>=20.`,
  sourceFile: 'scripts/analyze_momentum_chase_shadow_record_20261019.mjs', sourceDate: '2026-10-19',
  sampleSize: all.n, winRate: all.wins / all.n, evPerTrade: all.perTrade, rigorStatus: 'day-blocked CI crosses zero; N<20', status: 'PROVISIONAL',
});
// Closes the loop: the moment the live SHADOW record reaches the N>=20 floor, put the promotion question in front of
// the user (session-start prints every PENDING decision) instead of relying on anyone remembering to re-run this.
if (all.n >= 20) {
  await flagDecision({
    slug: 'momentum_chase_n20_promotion_review_20261019',
    decisionText: `MOMENTUM_CHASE live SHADOW record reached N=${all.n} (${all.days} days): WR ${(100 * all.wins / all.n).toFixed(1)}%, $${all.perTrade.toFixed(2)}/trade, day-blocked CI [${all.ci.lo.toFixed(1)},${all.ci.hi.toFixed(1)}]. Backtest claim was N=128, WR 58.6%, +$13.23. Decide: wire momentumChaseDetector.js to getCanonicalLiveStatus() (needs design + code review first; PROMOTE_ALL_MODE leaves a CI-crosses-zero type ACTIVE), keep it SHADOW, or retire it. See momentum_chase_hardwired_shadow_no_promotion_path_20261019 for context.`,
    sourceFile: 'scripts/analyze_momentum_chase_shadow_record_20261019.mjs', sourceDate: UPPER,
  });
}
process.exit(0);
