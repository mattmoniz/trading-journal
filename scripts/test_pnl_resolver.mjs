// Offline test for brokerPnlResolver's pure classification. Run: node scripts/test_pnl_resolver.mjs
import { classify } from '../server/services/sierraChart/brokerPnlResolver.js';
let pass = 0, fail = 0;
const check = (n, ok) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`); };
const entry = { purpose: 'ENTRY', status: 'FILLED' };
const ev = (readings, unk = 0) => ({ brokerReadings: readings, unknownOrderMessages: unk });
check('exit filled but no price', classify({ legs: [entry, { purpose: 'STOP', status: 'FILLED' }] }, ev([])) === 'EXIT_FILLED_PRICE_MISSING');
check('retired exit', classify({ legs: [entry, { purpose: 'EXIT', status: 'REJECTED', client_order_id: 'RETIRED-1' }] }, ev([])) === 'EXIT_RETIRED_BROKER_FLAT');
check('broker flat, no messages = silent close', classify({ legs: [entry] }, ev([{ broker_net: -1 }, { broker_net: 0 }], 0)) === 'SILENT_CLOSE_NO_ORDER_MESSAGE');
check('broker flat via unknown order', classify({ legs: [entry] }, ev([{ broker_net: -1 }, { broker_net: 0 }], 2)) === 'CLOSED_BY_UNTRACKED_ORDER');
check('last reading still open', classify({ legs: [entry] }, ev([{ broker_net: -1 }])) === 'POSITION_MAY_STILL_BE_OPEN');
check('no readings', classify({ legs: [entry] }, ev([])) === 'UNDETERMINED_NO_BROKER_READING');
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
