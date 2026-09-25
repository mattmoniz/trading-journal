// Item 2 of the DeepSeek-recommended next steps (2026-09-24): de-risk the $27.56/trade
// T3-T1 dollar spread by checking whether it survives dropping its single biggest-
// contributing day, and the top-2 combined -- per DeepSeek's own recommendation ("does the
// CI still exclude zero if you drop 09-17 or 09-18, the two biggest contributors").
import fs from 'fs';
import { dayBlockedBootstrapDeltaCI } from '../server/services/rigorDiagnostics.js';

const rows = JSON.parse(fs.readFileSync('/home/mmoniz/trading-journal/scratch/dollar_impact_test_rows.json', 'utf8'));
const t1t3 = rows.filter(r => r.pred_tercile === 'T1_lowest' || r.pred_tercile === 'T3_highest')
  .map(r => ({ date: r.trade_date, group: r.pred_tercile, pnl: r.actual_pnl }));

function summarize(events, label) {
  const t1 = events.filter(r => r.group === 'T1_lowest');
  const t3 = events.filter(r => r.group === 'T3_highest');
  if (t1.length === 0 || t3.length === 0) {
    console.log(`${label}: insufficient data after exclusion (T1 n=${t1.length}, T3 n=${t3.length})`);
    return;
  }
  const meanT1 = t1.reduce((s, r) => s + r.pnl, 0) / t1.length;
  const meanT3 = t3.reduce((s, r) => s + r.pnl, 0) / t3.length;
  const delta = meanT3 - meanT1;
  const ci = dayBlockedBootstrapDeltaCI(events, `leave_one_day_out_${label}`, {
    dateField: 'date', groupField: 'group', groupA: 'T1_lowest', groupB: 'T3_highest',
  });
  const excludesZero = ci.lo != null && ci.hi != null && (ci.lo > 0 || ci.hi < 0);
  console.log(`${label}: T1 n=${t1.length}/$${meanT1.toFixed(2)}, T3 n=${t3.length}/$${meanT3.toFixed(2)}, delta=$${delta.toFixed(2)}, CI=[$${ci.lo?.toFixed(2)},$${ci.hi?.toFixed(2)}], excludes_zero=${excludesZero}`);
}

summarize(t1t3, 'ALL_DAYS_baseline');
summarize(t1t3.filter(r => r.date !== '2026-09-18'), 'drop_09-18_biggest');
summarize(t1t3.filter(r => r.date !== '2026-09-17'), 'drop_09-17_2nd_biggest');
summarize(t1t3.filter(r => r.date !== '2026-09-18' && r.date !== '2026-09-17'), 'drop_both_top2');
summarize(t1t3.filter(r => !['2026-09-13', '2026-09-20'].includes(r.date)), 'drop_2_single-trade_weekend_days');
