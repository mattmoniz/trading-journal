// Tests for selectTradeAccount (server/services/sierraChart/orderSweep.js). Run: node scripts/test_globex_account_routing.mjs
import { selectTradeAccount } from '../server/services/sierraChart/orderSweep.js';
let pass = 0, fail = 0;
const eq = (name, got, want) => { got === want ? pass++ : fail++; console.log(`${got === want ? 'PASS' : 'FAIL'}  ${name} (got ${got}, want ${want})`); };
const args = { rthAccount: 'Sim1', globexAccount: 'Sim2' };
eq('RTH setup -> Sim1', selectTradeAccount({ isRth: true, ...args }), 'Sim1');
eq('Globex setup -> Sim2', selectTradeAccount({ isRth: false, ...args }), 'Sim2');
eq('unknown session defaults to RTH account (not Globex)', selectTradeAccount({ isRth: null, ...args }), 'Sim1');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
