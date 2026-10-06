// Tests for dllGateDecision (server/services/sierraChart/dllGate.js). Run: node scripts/test_dll_gate.mjs
import { dllGateDecision } from '../server/services/sierraChart/dllGate.js';
let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); };
check('loss at the limit blocks', dllGateDecision({ realizedBrokerPnl: -200, limit: 200 }).blocked === true);
check('loss beyond the limit blocks', dllGateDecision({ realizedBrokerPnl: -250, limit: 200 }).blocked === true);
check('loss inside the limit does not block', dllGateDecision({ realizedBrokerPnl: -120, limit: 200 }).blocked === false);
check('profit does not block', dllGateDecision({ realizedBrokerPnl: 80, limit: 200 }).blocked === false);
check('no broker P&L yet does not block, and says so', (() => { const d = dllGateDecision({ realizedBrokerPnl: null, limit: 200 }); return d.blocked === false && /cannot evaluate/.test(d.reason); })());
check('no limit configured does not block', dllGateDecision({ realizedBrokerPnl: -999, limit: 0 }).blocked === false);
check('unknown-count trades are reported, not counted as zero', /still without broker P&L/.test(dllGateDecision({ realizedBrokerPnl: -50, unknownCount: 2, limit: 200 }).reason));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
