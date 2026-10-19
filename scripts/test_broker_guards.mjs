// Offline checks for the broker-exit guard and the fail-closed DLL decision (2026-10-07).
import { brokerExitDecision, extractPositionForSymbol } from '../server/services/sierraChart/reconciliation.js';
import { dllGateDecision } from '../server/services/sierraChart/dllGate.js';
import assert from 'node:assert/strict';
// Exit guard: entry BUY 1 -> expected net +1; SELL 1 -> expected net -1.
assert.equal(brokerExitDecision({ brokerQty: 1, entrySide: 'BUY', filledQuantity: 1 }).ok, true);
assert.equal(brokerExitDecision({ brokerQty: -1, entrySide: 'SELL', filledQuantity: 1 }).ok, true);
assert.equal(brokerExitDecision({ brokerQty: 0, entrySide: 'SELL', filledQuantity: 1 }).ok, false); // flat -> refuse
assert.equal(brokerExitDecision({ brokerQty: 1, entrySide: 'SELL', filledQuantity: 1 }).ok, false); // opposite -> refuse
assert.equal(brokerExitDecision({ brokerQty: null, entrySide: 'BUY', filledQuantity: 1 }).ok, false); // unknown -> refuse
assert.equal(brokerExitDecision({ brokerQty: 2, entrySide: 'BUY', filledQuantity: 1 }).ok, true); // larger same-direction net is valid under stacking (relaxed 2026-10-13)
assert.equal(brokerExitDecision({ brokerQty: 1, entrySide: 'BUY', filledQuantity: 2 }).ok, false); // smaller than this setup's own open qty -> refuse
// DLL: over-limit blocks; within limit with no unknowns passes; unknown P&L now blocks (fixed 2026-10-07,
// DeepSeek review finding M2) since an unresolved loss could be hiding past the limit.
assert.equal(dllGateDecision({ realizedBrokerPnl: -400, limit: 400 }).blocked, true);
assert.equal(dllGateDecision({ realizedBrokerPnl: -100, limit: 400, unknownCount: 0 }).blocked, false);
assert.equal(dllGateDecision({ realizedBrokerPnl: -100, limit: 400, unknownCount: 2 }).blocked, true);
assert.equal(dllGateDecision({ realizedBrokerPnl: NaN, limit: 400 }).blocked, false); // no limit data at all -- different branch, not unknownCount
// extractPositionForSymbol takes the LAST matching message (a leading transient NoPositions must not read as flat)
const M = (o) => ({ Symbol: 'MNQZ26', ...o });
assert.equal(extractPositionForSymbol([M({ NoPositions: 1 }), M({ Quantity: -1 })], 'MNQZ26.CME'), -1);
assert.equal(extractPositionForSymbol([M({ Quantity: -1 }), M({ NoPositions: 1 })], 'MNQZ26.CME'), 0);
assert.equal(extractPositionForSymbol([M({ Quantity: -1, TradeAccount: 'B' }), M({ Quantity: -2, TradeAccount: 'A' })], 'MNQZ26.CME', 'A'), -2);
assert.equal(extractPositionForSymbol([], 'MNQZ26.CME'), null);
console.log('broker guard + DLL checks passed');
