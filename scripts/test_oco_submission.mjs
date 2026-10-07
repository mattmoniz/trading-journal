// Offline checks for the OCO bracket message construction (2026-10-07). No network, no DB -- a stub
// socket captures what submitOrder/submitOcoOrder would actually send, and we check it against
// DTCProtocol.h's real struct field names/types (/mnt/c/SierraChart/DTC/DTCProtocol.h on this machine).
// This proves the message SHAPE is right. It does NOT prove the broker accepts/links it -- that needs
// a real round-trip, deliberately not run here (placing any order needs explicit authorization).
import { DtcClient } from '../server/services/sierraChart/dtcClient.js';
import assert from 'node:assert/strict';

const sent = [];
const c = new DtcClient({ host: 'x', port: 1, username: '', password: '' });
c._loggedOn = true;
c._send = (msg) => sent.push(msg);

// Parent order: IsParentOrder must be set as the integer 1, not a JSON boolean (2026-10-07 fix -- the
// real struct field is uint8_t; a JSON `true` silently failed to register as a parent on a live venue).
c.submitOrder({ symbol: 'MNQZ6.CME', exchange: '', side: 'SELL', orderType: 'LIMIT', quantity: 1, price1: 31567, clientOrderId: 'E1', tradeAccount: 'Sim1', isParentOrder: true });
assert.equal(sent[0].Type, 208); // SUBMIT_NEW_SINGLE_ORDER
assert.equal(sent[0].IsParentOrder, 1);
assert.notEqual(sent[0].IsParentOrder, true); // must be the integer, not a boolean -- this is the real bug
assert.equal(sent[0].IsAutomatedOrder, 1);
assert.equal(sent[0].ClientOrderID, 'E1');

// A normal (non-bracket) entry must NOT carry the field at all -- existing callers unaffected.
sent.length = 0;
c.submitOrder({ symbol: 'MNQZ6.CME', exchange: '', side: 'SELL', orderType: 'LIMIT', quantity: 1, price1: 31567, clientOrderId: 'E2', tradeAccount: 'Sim1' });
assert.equal('IsParentOrder' in sent[0], false);

// OCO children: field names, positions and enum values must match s_SubmitNewOCOOrder exactly.
sent.length = 0;
c.submitOcoOrder({
  symbol: 'MNQZ6.CME', exchange: '', tradeAccount: 'Sim1', parentTriggerClientOrderId: 'E1', timeInForce: 'GTC',
  leg1: { clientOrderId: 'S1', orderType: 'STOP', side: 'BUY', price1: 31608, quantity: 1 },
  leg2: { clientOrderId: 'T1', orderType: 'LIMIT', side: 'BUY', price1: 31525, quantity: 1 },
});
const oco = sent[0];
assert.equal(oco.Type, 201); // SUBMIT_NEW_OCO_ORDER
assert.equal(oco.ParentTriggerClientOrderID, 'E1');
assert.equal(oco.ClientOrderID_1, 'S1'); assert.equal(oco.OrderType_1, 3); assert.equal(oco.BuySell_1, 1); assert.equal(oco.Price1_1, 31608); assert.equal(oco.Quantity_1, 1);
assert.equal(oco.ClientOrderID_2, 'T1'); assert.equal(oco.OrderType_2, 2); assert.equal(oco.BuySell_2, 1); assert.equal(oco.Price1_2, 31525); assert.equal(oco.Quantity_2, 1);
assert.equal(oco.TimeInForce, 2); // GTC
assert.equal(oco.PartialFillHandling, 1); // REDUCE_QUANTITY default
assert.equal(oco.IsAutomatedOrder, 1);

// Validation: a bracket needs both legs, with real sides/order types -- never sent half-built.
assert.throws(() => c.submitOcoOrder({ symbol: 'x', parentTriggerClientOrderId: 'E1', leg1: { clientOrderId: 'S1', orderType: 'STOP', side: 'BUY' } }), /leg2 is required/);
assert.throws(() => c.submitOcoOrder({ symbol: 'x', parentTriggerClientOrderId: 'E1', leg1: { clientOrderId: 'S1', orderType: 'STOP', side: 'SIDEWAYS' }, leg2: { clientOrderId: 'T1', orderType: 'LIMIT', side: 'BUY' } }), /invalid side/);
assert.throws(() => c.submitOcoOrder({ symbol: 'x', leg1: { clientOrderId: 'S1', orderType: 'STOP', side: 'BUY' }, leg2: { clientOrderId: 'T1', orderType: 'LIMIT', side: 'BUY' } }), /parentTriggerClientOrderId is required/);

console.log('OCO submission shape checks passed (message construction only -- not a live broker round-trip)');
