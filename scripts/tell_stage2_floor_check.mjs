// Stage 2 end rule check (docs/TELL_STAGE2_END_RULE_20261104.md; adopted by the user 2026-11-04, 'Yes to both'). Called nightly from scripts/run_daily_calibration.sh. Counts the live Stage 2 tell trades (book V1, bar_rule 'split',
// order_state LINKED*, closed, with a model net P&L) and the distinct trade dates, against the shared floors in server/config/forwardFloors.js (tellTrades, tellDates: hr-003, one copy). BELOW EITHER FLOOR it prints progress only and
// changes nothing. AT BOTH floors it computes the day-block bootstrap 95 percent CI of the mean net per linked trade ONCE per run and applies the written rule: upper bound below 0 = RETIRE the tell orders (a HIGH decision is flagged,
// nothing is switched off by this script), interval includes 0 = REVIEW with the user, lower bound above 0 = EVIDENCE of an edge on the sim account (a HIGH decision is flagged). It never changes a setting, never places or cancels an order.
// Model P&L (`net_dollars`); the model-vs-broker gap is measured separately by the nightly live attestation.
import { query } from '../server/db.js';
import { FORWARD_FLOORS } from '../server/config/forwardFloors.js';
import { flagDecision } from './flag_decision.mjs';

// --dry [trades dates] is for testing only: it lowers the floors and prints the verdict WITHOUT flagging a decision.
const DRY = process.argv.includes('--dry'); const FL = DRY ? { tellTrades: Number(process.argv[process.argv.indexOf('--dry') + 1]) || FORWARD_FLOORS.tellTrades, tellDates: Number(process.argv[process.argv.indexOf('--dry') + 2]) || FORWARD_FLOORS.tellDates } : FORWARD_FLOORS;
const mulberry = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const r = await query(`SELECT trade_date::text AS d, net_dollars::float AS n FROM amt_tell_trades WHERE book = 'V1' AND bar_rule = 'split' AND order_state LIKE 'LINKED%' AND status = 'CLOSED' AND net_dollars IS NOT NULL ORDER BY trade_date`);
const n = r.rows.length, dates = [...new Set(r.rows.map((x) => x.d))], nd = dates.length, mean = n ? r.rows.reduce((s, x) => s + x.n, 0) / n : null;
console.log(`tell Stage 2 floor check: ${n}/${FL.tellTrades} linked closed trades, ${nd}/${FL.tellDates} dates, mean net per trade ${mean == null ? 'n/a' : mean.toFixed(2)} (progress only until both floors are reached)`);
if (n >= FL.tellTrades && nd >= FL.tellDates) {
  const by = new Map(); for (const x of r.rows) { const a = by.get(x.d) || { s: 0, c: 0 }; a.s += x.n; a.c += 1; by.set(x.d, a); }
  const days = [...by.values()], rnd = mulberry(20261104), B = 4000, m = [];
  for (let b = 0; b < B; b++) { let s = 0, c = 0; for (let k = 0; k < days.length; k++) { const p = days[Math.floor(rnd() * days.length)]; s += p.s; c += p.c; } m.push(s / c); }
  m.sort((a, z) => a - z); const lo = m[Math.floor(0.025 * B)], hi = m[Math.floor(0.975 * B)];
  const verdict = hi < 0 ? 'RETIRE' : lo > 0 ? 'EVIDENCE' : 'REVIEW';
  console.log(`  FLOORS REACHED: mean ${mean.toFixed(2)} per trade, day-block 95% CI [${lo.toFixed(2)}, ${hi.toFixed(2)}] => ${verdict}`);
  if (DRY) console.log('  (dry run: no decision flagged)'); else await flagDecision({ slug: 'tell_stage2_end_rule_review_due', priority: 'HIGH', sourceDate: new Date().toISOString().slice(0, 10), sourceFile: 'docs/TELL_STAGE2_END_RULE_20261104.md',
    decisionText: `Stage 2 evidence floors reached (${n} linked trades, ${nd} dates). Mean net ${mean.toFixed(2)} per trade, day-block 95% CI [${lo.toFixed(2)}, ${hi.toFixed(2)}]. Written rule says ${verdict}: ${verdict === 'RETIRE' ? 'the interval is entirely below 0: retire the tell orders (AMT_TELL_ORDERS.enabled=false and a restart when flat), keep logging the tell.' : verdict === 'EVIDENCE' ? 'the interval is entirely above 0: evidence of an edge ON THE SIM ACCOUNT; a separate decision on anything beyond the sim account.' : 'the interval includes 0: review with the user, continue only on the user word.'} Nothing was changed automatically.` });
}
process.exit(0);
