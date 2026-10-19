// Unit test for brokerReportedAccountOverride (detect-only helper) (reconciliation.js). Run: node scripts/test_account_label_mismatch.mjs
import { brokerReportedAccountOverride as f } from '../server/services/sierraChart/reconciliation.js';
let pass = 0, fail = 0;
const expect = (name, got, want) => { const ok = got === want; ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); };
expect('same account -> no change', f('DTC-Live-Simulator', { TradeAccount: 'DTC-Live-Simulator' }), null);
expect('label Globex, broker Simulator -> adopt Simulator', f('DTC-Live-Globex', { TradeAccount: 'DTC-Live-Simulator' }), 'DTC-Live-Simulator');
expect('broker sends no account -> no change', f('DTC-Live-Globex', {}), null);
expect('broker sends empty string -> no change', f('DTC-Live-Globex', { TradeAccount: '  ' }), null);
expect('non-string account -> no change', f('DTC-Live-Globex', { TradeAccount: 5 }), null);
expect('no stored label -> no change (never invent one)', f(null, { TradeAccount: 'DTC-Live-Simulator' }), null);
expect('null msg -> no change', f('DTC-Live-Globex', null), null);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
