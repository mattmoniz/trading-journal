// Has the "Monday gate" helped or hurt? acd.js (since 2026-07-01): `mondayGate = isMonday ? etMinNow >= 630 : true` -- on Mondays the
// level-fade engine does not fire anything until the Initial Balance closes at 10:30 ET.
//
// Counterfactual source (no engine re-simulation needed): when the gate opens at 10:30, the early-touch backfill scans every RTH bar
// since 9:30 and writes a row for each level's first touch, with fired_at = the REAL touch time and an outcome walked from that
// moment. On a Monday those rows are exactly the entries the gate withheld (written late, after 10:30). Caveats: they are always
// SHADOW, only first touches, and nothing before 9:35 (the separate user-set 9:30-9:35 no-entry window).
//
// PRE-REGISTERED reading rule (written before the numbers): the gate HELPED if the withheld Monday window is negative per trade with a
// day-blocked CI below zero, HURT if positive with a CI above zero, otherwise INCONCLUSIVE. N<20 is never decisive. Also reported:
// Monday window vs the SAME-construction window on Tue-Fri (is the early window just generally good/bad), and Monday-window vs Monday
// after 10:30. Per-trade mean = sum/N (not day-weighted); day-blocked bootstrap for CIs only; siblings collapsed before the CI.
// "Declustered" (user's lens) = every row counted; "collapsed" = primaries only, shown beside it because siblings are correlated.
//
// Population: real rows (REAL_TRADE_FILTER, origin ACTIVE/SHADOW, actual_pnl present), level-fade family only
// (_FADE_LONG/_FADE_SHORT, no GLOBEX_/OVERNIGHT), POC_ROTATION_JOIN and other standalone detectors excluded (not gated by this rule).
import { query } from '../server/db.js';
import { REAL_TRADE_FILTER } from './backtest_setup_status.mjs';
import { dayBlockedBootstrapCI, dayBlockedBootstrapDeltaCI, collapseClusterSiblings } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const end = (await query(`SELECT (CURRENT_DATE - 1)::text e, (CURRENT_DATE - 91)::text s`)).rows[0];
const rows = (await query(`
  SELECT trade_date::text AS date, setup_type, origin_status, is_cluster_primary, cluster_touch_id::text AS cluster,
         actual_pnl::float AS pnl, fired_at::time::text AS ft, EXTRACT(dow FROM fired_at)::int AS dow,
         (t1_label LIKE '%backfilled early touch%') AS early_touch,
         (created_at - fired_at) > interval '5 minutes' AS created_late
  FROM active_setups
  WHERE ${REAL_TRADE_FILTER} AND origin_status IN ('ACTIVE','SHADOW') AND actual_pnl IS NOT NULL AND is_rth = true
    AND setup_type ~ '_FADE_(LONG|SHORT)$' AND setup_type NOT LIKE 'GLOBEX_%' AND setup_type NOT LIKE '%OVERNIGHT%'
    AND trade_date BETWEEN $1 AND $2`, [end.s, end.e])).rows;

const win = (r) => r.ft >= '09:35:00' && r.ft < '10:30:00';
const after = (r) => r.ft >= '10:30:00' && r.ft < '16:00:00';
const groups = {
  'MON window 9:35-10:30 (withheld by gate)': rows.filter(r => r.dow === 1 && win(r)),
  'TUE-FRI window 9:35-10:30 (same rows, no gate)': rows.filter(r => r.dow >= 2 && win(r)),
  'MON after 10:30': rows.filter(r => r.dow === 1 && after(r)),
  'TUE-FRI after 10:30': rows.filter(r => r.dow >= 2 && after(r)),
};
const stat = (arr, label, collapse) => {
  const ev = collapse ? arr.filter(r => r.is_cluster_primary !== false) : arr;
  const pnls = ev.map(r => r.pnl);
  const sum = pnls.reduce((a, b) => a + b, 0), n = pnls.length;
  const forCi = collapse ? ev.map(r => ({ date: r.date, pnl: r.pnl })) : collapseClusterSiblings(arr.map(r => ({ date: r.date, pnl: r.pnl, cluster_touch_id: r.cluster })));
  const ci = n >= 5 ? dayBlockedBootstrapCI(forCi, `monday|${label}|${collapse}`) : null;
  return { n, days: new Set(ev.map(r => r.date)).size, sum, per: n ? sum / n : NaN, wr: n ? pnls.filter(p => p > 0).length / n : NaN, ci };
};
const f = (x) => Number.isFinite(x) ? x.toFixed(2) : 'n/a';
console.log(`window ${end.s}..${end.e} | ${rows.length} level-fade rows | Mondays in window: ${new Set(rows.filter(r => r.dow === 1).map(r => r.date)).size}`);
const mw = groups['MON window 9:35-10:30 (withheld by gate)'];
console.log(`sanity: Monday-window rows written ON TIME (the gate should block these): ${mw.filter(r => !r.created_late).length} of ${mw.length}; early-touch backfilled: ${mw.filter(r => r.early_touch).length}`);
const out = {};
for (const collapse of [false, true]) {
  console.log(`\n==== ${collapse ? 'COLLAPSED (primaries only)' : 'DECLUSTERED (every row)'} ====`);
  for (const [k, arr] of Object.entries(groups)) {
    const s = stat(arr, k, collapse); out[`${k}|${collapse}`] = s;
    console.log(`${k.padEnd(48)} N=${String(s.n).padStart(4)} days=${String(s.days).padStart(3)} sum=${f(s.sum).padStart(9)} per-trade=${f(s.per).padStart(7)} WR=${(100 * s.wr).toFixed(0)}%` + (s.ci ? ` CI[${f(s.ci.lo)},${f(s.ci.hi)}]` : '') + (s.n < 20 ? '  [N<20: not decisive]' : ''));
  }
}
const delta = (a, b, label) => {
  const ev = [...groups[a].map(r => ({ date: r.date, g: 'A', pnl: r.pnl })), ...groups[b].map(r => ({ date: r.date, g: 'B', pnl: r.pnl }))];
  const d = dayBlockedBootstrapDeltaCI(ev, `mondaydelta|${label}`, { groupField: 'g', groupA: 'B', groupB: 'A' });
  const ma = groups[a].reduce((x, r) => x + r.pnl, 0) / Math.max(groups[a].length, 1), mb = groups[b].reduce((x, r) => x + r.pnl, 0) / Math.max(groups[b].length, 1);
  console.log(`${label}: per-trade difference ${f(ma - mb)}  CI[${f(d?.lo)},${f(d?.hi)}]`);
};
console.log('\n==== comparisons (declustered, per-trade difference = first minus second) ====');
delta('MON window 9:35-10:30 (withheld by gate)', 'TUE-FRI window 9:35-10:30 (same rows, no gate)', 'Mon window - Tue-Fri window');
delta('MON window 9:35-10:30 (withheld by gate)', 'MON after 10:30', 'Mon window - Mon after 10:30');

// splits: direction, and pre/post PROMOTE_ALL (2026-09-28)
console.log('\n==== split of the withheld Monday window ====');
for (const [lab, pred] of [['LONG', r => r.setup_type.endsWith('_LONG')], ['SHORT', r => r.setup_type.endsWith('_SHORT')], ['before 2026-09-28', r => r.date < '2026-09-28'], ['2026-09-28 on', r => r.date >= '2026-09-28']]) {
  const s = stat(mw.filter(pred), lab, false);
  console.log(`${lab.padEnd(20)} N=${String(s.n).padStart(3)} days=${String(s.days).padStart(2)} sum=${f(s.sum).padStart(8)} per-trade=${f(s.per).padStart(7)}` + (s.ci ? ` CI[${f(s.ci.lo)},${f(s.ci.hi)}]` : '') + (s.n < 20 ? '  [N<20]' : ''));
}
const byDay = new Map(); for (const r of mw) byDay.set(r.date, (byDay.get(r.date) || 0) + r.pnl);
console.log('per-Monday sum of withheld rows:', [...byDay.entries()].sort().map(([d, v]) => `${d.slice(5)}:${Math.round(v)}`).join('  '));
const w = out['MON window 9:35-10:30 (withheld by gate)|false'];
const verdict = w.n < 20 ? 'INCONCLUSIVE (N<20)' : (w.ci && w.ci.hi < 0) ? 'GATE HELPED (withheld rows lose, CI below zero)' : (w.ci && w.ci.lo > 0) ? 'GATE HURT (withheld rows win, CI above zero)' : 'INCONCLUSIVE (CI crosses zero)';
console.log(`\nVERDICT (pre-registered rule): ${verdict}`);
await recordClaim({
  slug: 'monday_gate_help_or_hurt_3mo_20261019',
  claimText: `Monday gate (no level-fade entries before 10:30 ET on Mondays) over ${end.s}..${end.e}: the first touches it withheld (early-touch backfill rows, true touch times) -- declustered N=${w.n} on ${w.days} Mondays, sum $${f(w.sum)}, $${f(w.per)}/trade, CI [${f(w.ci?.lo)},${f(w.ci?.hi)}]. Verdict by the pre-registered rule: ${verdict}. Same-construction Tue-Fri window and Monday-after-10:30 comparisons in scripts/backtest_monday_gate_20261019.mjs output. Caveat: only first touches, SHADOW-construction rows, nothing before 9:35.`,
  sourceFile: 'scripts/backtest_monday_gate_20261019.mjs', sourceDate: end.e,
  sampleSize: w.n, winRate: w.wr, evPerTrade: w.per, rigorStatus: 'day-blocked CI, siblings collapsed for CI; thin (<=13 Mondays)', status: 'PROVISIONAL',
});
process.exit(0);
