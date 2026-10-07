// Offline checks for the broker-exit guard and the fail-closed DLL decision (2026-10-07).
import { brokerExitDecision } from '../server/services/sierraChart/reconciliation.js';
import { dllGateDecision } from '../server/services/sierraChart/dllGate.js';
import assert from 'node:assert/strict';
// Exit guard: entry BUY 1 -> expected net +1; SELL 1 -> expected net -1.
assert.equal(brokerExitDecision({ brokerQty: 1, entrySide: 'BUY', filledQuantity: 1 }).ok, true);
assert.equal(brokerExitDecision({ brokerQty: -1, entrySide: 'SELL', filledQuantity: 1 }).ok, true);
assert.equal(brokerExitDecision({ brokerQty: 0, entrySide: 'SELL', filledQuantity: 1 }).ok, false); // flat -> refuse
assert.equal(brokerExitDecision({ brokerQty: 1, entrySide: 'SELL', filledQuantity: 1 }).ok, false); // opposite -> refuse
assert.equal(brokerExitDecision({ brokerQty: null, entrySide: 'BUY', filledQuantity: 1 }).ok, false); // unknown -> refuse
assert.equal(brokerExitDecision({ brokerQty: 2, entrySide: 'BUY', filledQuantity: 1 }).ok, false); // wrong size -> refuse
// DLL: over-limit blocks; within limit with no unknowns passes; unknown P&L now blocks (fixed 2026-10-07,
// DeepSeek review finding M2) since an unresolved loss could be hiding past the limit.
assert.equal(dllGateDecision({ realizedBrokerPnl: -400, limit: 400 }).blocked, true);
assert.equal(dllGateDecision({ realizedBrokerPnl: -100, limit: 400, unknownCount: 0 }).blocked, false);
assert.equal(dllGateDecision({ realizedBrokerPnl: -100, limit: 400, unknownCount: 2 }).blocked, true);
assert.equal(dllGateDecision({ realizedBrokerPnl: NaN, limit: 400 }).blocked, false); // no limit data at all -- different branch, not unknownCount
console.log('broker guard + DLL checks passed');
