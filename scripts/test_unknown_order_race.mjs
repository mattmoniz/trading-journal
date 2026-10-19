// Pure checks for the confirm-then-halt split used by runReconciliation() (2026-10-19). The live part (fresh snapshot) needs a broker.
import assert from 'node:assert/strict';
import { splitUnknownOrders } from '../server/services/sierraChart/reconciliation.js';
const o = (id) => ({ ClientOrderID: id, ServerOrderID: 'x' + id });
// own, recently-terminal stops -> race candidates, nothing "other"
let r = splitUnknownOrders([o('S136195'), o('S136198')], ['S136195', 'S136198']);
assert.equal(r.raceCandidates.length, 2); assert.equal(r.other.length, 0);
// a foreign order (not in the app's recent terminal set) must stay "other" -> still halts
r = splitUnknownOrders([o('S136195'), o('MANUAL-ATM-1')], ['S136195']);
assert.equal(r.raceCandidates.length, 1); assert.equal(r.other.length, 1); assert.equal(r.other[0].ClientOrderID, 'MANUAL-ATM-1');
// an order with no ClientOrderID can never be a race candidate
r = splitUnknownOrders([{ ServerOrderID: '9' }], ['S1']);
assert.equal(r.raceCandidates.length, 0); assert.equal(r.other.length, 1);
// nothing recently terminal -> everything is "other"
r = splitUnknownOrders([o('S1')], []);
assert.equal(r.other.length, 1);
console.log('unknown-order race split checks passed');
