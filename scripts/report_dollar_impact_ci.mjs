// Companion to backtest_dollar_impact.py -- computes the real day-blocked bootstrap CI on
// the T3-T1 predicted-probability-tercile $ spread using this codebase's OWN canonical
// dayBlockedBootstrapDeltaCI() (server/services/rigorDiagnostics.js), per the standing
// convention of exporting per-row results as JSON so the JS rigor functions stay the single
// source of truth rather than a second, hand-rolled Python bootstrap.
import fs from 'fs';
import { dayBlockedBootstrapDeltaCI } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const rows = JSON.parse(fs.readFileSync('/home/mmoniz/trading-journal/scratch/dollar_impact_test_rows.json', 'utf8'));
const t1t3 = rows.filter(r => r.pred_tercile === 'T1_lowest' || r.pred_tercile === 'T3_highest')
  .map(r => ({ date: r.trade_date, group: r.pred_tercile, pnl: r.actual_pnl }));

const ci = dayBlockedBootstrapDeltaCI(t1t3, 'dollar_impact_test_20260924', {
  dateField: 'date', groupField: 'group', groupA: 'T1_lowest', groupB: 'T3_highest',
});
const t1 = t1t3.filter(r => r.group === 'T1_lowest');
const t3 = t1t3.filter(r => r.group === 'T3_highest');
const meanT1 = t1.reduce((s, r) => s + r.pnl, 0) / t1.length;
const meanT3 = t3.reduce((s, r) => s + r.pnl, 0) / t3.length;
const delta = meanT3 - meanT1;
const excludesZero = ci.lo != null && ci.hi != null && (ci.lo > 0 || ci.hi < 0);

console.log(`T1 (least confident) mean $: ${meanT1.toFixed(2)} (n=${t1.length})`);
console.log(`T3 (most confident) mean $: ${meanT3.toFixed(2)} (n=${t3.length})`);
console.log(`T3-T1 delta: $${delta.toFixed(2)}, day-blocked 95% CI: [$${ci.lo?.toFixed(2)}, $${ci.hi?.toFixed(2)}]`);
console.log(`Excludes zero: ${excludesZero}`);

await recordClaim({
  slug: 'tick_signed_model_dollar_backtest_20260924',
  claimText: [
    'Real $ backtest of the direction-signed tick logistic model against held-out test',
    'days (never seen in training) -- per Opus Audit #14\'s own "report dollars per',
    'selected trade, not just AUC" rule, which the AUC=0.578/p=0.025 result from earlier',
    'today did not itself satisfy.',
    `T1 (model\'s lowest-confidence tercile) mean $${meanT1.toFixed(2)}/trade (n=${t1.length}),`,
    `T3 (highest-confidence tercile) mean $${meanT3.toFixed(2)}/trade (n=${t3.length}).`,
    `T3-T1 delta=$${delta.toFixed(2)}, day-blocked 95% CI=[$${ci.lo?.toFixed(2)},$${ci.hi?.toFixed(2)}],`,
    `excludes_zero=${excludesZero}.`,
    'This is the same held-out test split used for the earlier AUC number, refit fresh',
    '(the frozen model itself was trained on ALL historical data through its cutoff, so',
    'scoring it against past trades would be circular/in-sample -- this uses a genuinely',
    'out-of-fold fit instead, matching the AUC test\'s own methodology).',
  ].join(' '),
  sourceFile: 'scripts/tick_microstructure/backtest_dollar_impact.py',
  sourceDate: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
  sampleSize: t1t3.length,
  winRate: null,
  evPerTrade: delta,
  rigorStatus: excludesZero ? 'ci_excludes_zero' : 'ci_crosses_zero',
  status: 'PROVISIONAL',
  extra: { meanT1, meanT3, delta, ci_lo: ci.lo, ci_hi: ci.hi },
});
console.log('\nClaim recorded: tick_signed_model_dollar_backtest_20260924');
