// Do the risk gates that force a real candidate to SHADOW cost money? (OPEN_DECISION
// shadow_no_reason_rows_leak_to_live_20261019, user lens: "shadow is a pipeline to live").
// For every SHADOW row carrying an exact gate reason, compare its realized P&L (what it WOULD have made
// had it fired live) against the real ACTIVE-origin trades in the same window.
//
// Rules applied (CLAUDE.md): REAL_TRADE_FILTER; is_cluster_primary only; upper bound pinned (no live-table
// growth confound); POC_ROTATION_JOIN reported separately (its exit mechanism changed 2026-10-11); per-trade
// mean = sum(pnl)/N (NOT the day-weighted mean), day-blocked bootstrap only for the CIs; the post-2026-10-12
// window is the primary read because the gate set and POC exit changed 2026-10-11/12.
// CAVEAT baked into the output: a gate-blocked trade is not independent of the position that blocked it
// (opposite-direction-open exists so you never hold both), so "would have made X" is an upper-level guide,
// not a P&L you could have collected with one contract.
import { query } from '../server/db.js';
import { REAL_TRADE_FILTER } from './backtest_setup_status.mjs';
import { dayBlockedBootstrapCI, dayBlockedBootstrapDeltaCI } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const UPPER = '2026-10-18';
const WINDOWS = [
  { name: 'POST_1012 (primary read)', from: '2026-10-12' },
  { name: 'PRE_1012 (context only, gate set differed)', from: '2026-09-03', to: '2026-10-11' },
];
const bucketOf = (r) => {
  if (r.origin_status === 'ACTIVE') return 'LIVE_ACTIVE (baseline)';
  const s = r.suppression_reason || 'NULL (unlabeled)';
  if (s.startsWith('CROSS_DIRECTION_FAST_FLIP')) return 'CROSS_DIRECTION_FAST_FLIP';
  if (s.startsWith('ML_VETO')) return 'ML_VETO_GATE';
  if (['OPPOSITE_DIRECTION_OPEN', 'ROTATION_DIRECTION_CONFLICT', 'SAME_TYPE_REFIRE', 'POST_WIN_OPP_FAMILY_REV', 'OPENING_DRIVE_COUNTER', 'REFIRE_COOLDOWN', 'LIVE_TIME_WINDOW'].includes(s)) return s;
  return 'OTHER_SHADOW (' + s + ')';
};
const mean = (a) => a.length ? a.reduce((x, y) => x + y.pnl, 0) / a.length : NaN;
const f = (x) => Number.isFinite(x) ? x.toFixed(2) : 'n/a';

const summary = [];
for (const w of WINDOWS) {
  const to = w.to || UPPER;
  const rows = (await query(`
    SELECT trade_date::text AS date, origin_status, suppression_reason, setup_type, actual_pnl::float AS pnl
    FROM active_setups
    WHERE ${REAL_TRADE_FILTER} AND (is_cluster_primary IS NULL OR is_cluster_primary = true)
      AND actual_pnl IS NOT NULL AND trade_date BETWEEN $1 AND $2`, [w.from, to])).rows;
  for (const poc of [false, true]) {
    const sub = rows.filter(r => r.setup_type.startsWith('POC_ROTATION_JOIN') === poc).map(r => ({ ...r, group: bucketOf(r) }));
    console.log(`\n=== ${w.name} ${w.from}..${to} | ${poc ? 'POC_ROTATION_JOIN ONLY' : 'EVERYTHING EXCEPT POC_ROTATION_JOIN'} ===`);
    const base = sub.filter(r => r.group === 'LIVE_ACTIVE (baseline)');
    const groups = [...new Set(sub.map(r => r.group))].sort();
    for (const g of groups) {
      const ev = sub.filter(r => r.group === g);
      const days = new Set(ev.map(r => r.date)).size;
      const ci = ev.length >= 5 ? dayBlockedBootstrapCI(ev, `gatecost|${w.name}|${poc}|${g}`) : null;
      let delta = null;
      if (g !== 'LIVE_ACTIVE (baseline)' && ev.length >= 5 && base.length >= 5) {
        delta = dayBlockedBootstrapDeltaCI(sub.filter(r => r.group === g || r.group === 'LIVE_ACTIVE (baseline)'), `gatecostd|${w.name}|${poc}|${g}`,
          { groupA: 'LIVE_ACTIVE (baseline)', groupB: g });
      }
      const thin = ev.length < 20 ? ' [N<20: not decisive]' : '';
      console.log(`${g.padEnd(46)} N=${String(ev.length).padStart(4)} days=${String(days).padStart(2)} sum=${f(ev.reduce((a, r) => a + r.pnl, 0)).padStart(9)} perTrade=${f(mean(ev)).padStart(7)}`
        + (ci ? ` CI[${f(ci.lo)},${f(ci.hi)}]` : '') + (delta ? ` deltaVsLive=${f(mean(ev) - mean(base))} CI[${f(delta.lo)},${f(delta.hi)}]` : '') + thin);
      summary.push({ window: w.name, poc, group: g, n: ev.length, days, perTrade: mean(ev), ci, delta });
    }
  }
}
await recordClaim({
  slug: 'shadow_gate_cost_by_reason_20261019',
  claimText: 'Per-gate realized P&L of SHADOW rows that carry an exact gate reason, vs real LIVE trades in the same window (primaries only, REAL_TRADE_FILTER, upper bound 2026-10-18, POC_ROTATION_JOIN separate). Primary read = post-2026-10-12 window. Re-run scripts/analyze_shadow_gate_cost_20261019.mjs for current numbers; stored detail: ' + JSON.stringify(summary.filter(s => s.window.startsWith('POST') && !s.poc).map(s => [s.group, s.n, s.days, Math.round(s.perTrade * 100) / 100, s.ci ? [Math.round(s.ci.lo), Math.round(s.ci.hi)] : null])).slice(0, 900),
  sourceFile: 'scripts/analyze_shadow_gate_cost_20261019.mjs', sourceDate: '2026-10-19',
  sampleSize: summary.filter(s => s.window.startsWith('POST') && !s.poc && s.group !== 'LIVE_ACTIVE (baseline)').reduce((a, s) => a + s.n, 0),
  winRate: null, evPerTrade: null, rigorStatus: 'day-blocked CI, primaries only; one-week-scale post-1012 window', status: 'PROVISIONAL',
});
process.exit(0);
