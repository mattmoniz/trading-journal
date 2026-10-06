// Tests for the close-verification rule (server/services/sierraChart/closeCheck.js).
// Run: node scripts/test_close_check.mjs
import { classifyClose } from '../server/services/sierraChart/closeCheck.js';
let pass = 0, fail = 0;
const expect = (name, got, want) => { got === want ? pass++ : fail++; console.log(`${got === want ? 'PASS' : 'FAIL'}  ${name} (got ${got}, want ${want})`); };
expect('entry never filled -> NO_ENTRY_FILL', classifyClose({ entryFilled: false, appClosed: true, brokerCloseFilled: false }), 'NO_ENTRY_FILL');
expect('filled, app still open -> STILL_OPEN', classifyClose({ entryFilled: true, appClosed: false, brokerCloseFilled: false }), 'STILL_OPEN');
expect('filled, app closed, broker close filled -> CONFIRMED', classifyClose({ entryFilled: true, appClosed: true, brokerCloseFilled: true }), 'CONFIRMED');
expect('filled, app closed, no broker close -> CLOSE_NOT_CONFIRMED', classifyClose({ entryFilled: true, appClosed: true, brokerCloseFilled: false }), 'CLOSE_NOT_CONFIRMED');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
