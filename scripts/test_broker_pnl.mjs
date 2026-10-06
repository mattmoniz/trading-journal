// Tests for brokerPnlFromFills (server/services/sierraChart/brokerPnl.js). Run: node scripts/test_broker_pnl.mjs
import { brokerPnlFromFills } from '../server/services/sierraChart/brokerPnl.js';
let pass = 0, fail = 0;
const near = (name, got, want) => { const ok = got != null && Math.abs(got - want) < 0.01; ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} (got ${got}, want ${want})`); };
// Oct 6 OR15_HIGH_FADE_SHORT: sell filled 31564.75, stop buy filled 31565.00 -> -0.25 pt x $2 - $2 = -$2.50
near('short, filled entry 31564.75, stop 31565.00 -> -2.50', brokerPnlFromFills({ entrySide: 'SELL', entryAvg: 31564.75, exitAvg: 31565.00 }), -2.5);
// Oct 5 GLOBEX_VWAP_FADE_SHORT: sell 31357.00, buy 31357.75 -> -0.75 pt x2 - 2 = -3.50
near('short, 31357.00 -> 31357.75 -> -3.50', brokerPnlFromFills({ entrySide: 'SELL', entryAvg: 31357.00, exitAvg: 31357.75 }), -3.5);
// long winner: buy 100 sell 110 -> 10 pt x2 - 2 = 18
near('long winner 10 pt -> +18', brokerPnlFromFills({ entrySide: 'BUY', entryAvg: 100, exitAvg: 110 }), 18);
// short loser: sell 100 buy 105 -> -5 pt x2 - 2 = -12
near('short loser 5 pt -> -12', brokerPnlFromFills({ entrySide: 'SELL', entryAvg: 100, exitAvg: 105 }), -12);
// missing fill price must give null, never a guess
const missing = brokerPnlFromFills({ entrySide: 'SELL', entryAvg: 31567, exitAvg: null });
if (missing === null) { pass++; console.log('PASS  missing exit fill -> null (no guess)'); } else { fail++; console.log('FAIL  missing exit fill returned ' + missing); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
