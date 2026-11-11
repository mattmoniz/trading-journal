// In-process fake DTC client + broker book for order-path tests (Fable audit, 2026-11-10; docs/FABLE_AUDIT_REVIEW_20261110.md).
// It implements the DtcClient surface the order path uses (submitOrder / cancelOrder / requestOpenOrders / requestCurrentPositions /
// requestSecurityDefinition, on/off/emit, isLive/isLoggedOn/tradeAccount) over an in-memory book, so reconciliation.js, protection.js and
// orderSweep.js run for real against it. NOT a TCP server: the wire encoding in dtcClient.js is not exercised here (that needs Sierra
// Chart). Every order_update it emits has the field shapes of the recorded real messages (see the 2026-11-09 cancel-reject message).
import { EventEmitter } from 'node:events';

export const STATUS = { ORDER_SENT: 1, PENDING_OPEN: 2, PENDING_CHILD: 3, OPEN: 4, FILLED: 7, CANCELED: 8, REJECTED: 9, PARTIALLY_FILLED: 10 };
const TYPE = { 1: 'MARKET', 2: 'LIMIT', 3: 'STOP' };

export class FakeDtc extends EventEmitter {
  constructor({ account = 'TEST-ACCT', bareSymbol = 'MNQZ26', multiplier = 1 } = {}) {
    super();
    this.setMaxListeners(50);
    this.tradeAccount = account; this.bareSymbol = bareSymbol; this.multiplier = multiplier;
    this.isLoggedOn = true; this.isConnected = true; this._live = true;
    this.book = new Map();            // clientOrderId -> working order
    this.sent = [];                   // every submitOrder call, in order
    this.cancels = [];                // every cancelOrder call
    this.position = 0;                // signed net, per this single account
    this.nextServerId = 1000;
    this.rejectNext = [];             // predicates: (p) => 'REJECT' | 'THROW' | undefined, consumed in order of match
    this.behaviours = [];             // persistent predicates, same contract
    this.silentFills = false;         // when true, market orders fill at the broker but emit NO update (a dropped fill message)
    this.requestsOpenOrders = 0; this.requestsPositions = 0;
  }
  isLive() { return this._live; }
  setLive(v) { this._live = v; }

  _msg(order, status, extra = {}) {
    return {
      Type: 301, TradeAccount: this.tradeAccount, Symbol: this.bareSymbol, Exchange: '', ClientOrderID: order.clientOrderId, ServerOrderID: order.serverId,
      OrderStatus: status, OrderUpdateReason: 3, BuySell: order.side === 'BUY' ? 1 : 2, OrderType: order.typeNum, OrderQuantity: order.quantity,
      FilledQuantity: order.filled || 0, RemainingQuantity: order.quantity - (order.filled || 0), AverageFillPrice: order.avgFill ?? 1.7976931348623157e308,
      LatestTransactionDateTime: this._clock = (this._clock || 1794240000) + 1, InfoText: '', ...extra,
    };
  }
  _emitSoon(msg) { setImmediate(() => this.emit('orderUpdate', msg)); }

  submitOrder(p) {
    this.sent.push({ ...p });
    const rule = this._consumeRule(p);
    if (rule === 'THROW') throw new Error('fake: submit failed (not logged on)');
    const typeNum = p.orderType === 'MARKET' ? 1 : p.orderType === 'LIMIT' ? 2 : 3;
    const order = { clientOrderId: p.clientOrderId, serverId: String(this.nextServerId++), side: p.side, orderType: p.orderType, typeNum, quantity: p.quantity, price1: p.price1, filled: 0, avgFill: null, purpose: undefined };
    if (rule === 'REJECT') { this._emitSoon(this._msg(order, STATUS.REJECTED, { InfoText: 'fake: rejected' })); return; }
    if (p.orderType === 'MARKET') { this._fill(order, p.price1 || this.lastPrice || 100, !this.silentFills); return; }
    this.book.set(order.clientOrderId, order);
    this._emitSoon(this._msg(order, STATUS.OPEN));
  }
  _consumeRule(p) {
    for (let i = 0; i < this.rejectNext.length; i++) { const r = this.rejectNext[i](p); if (r) { this.rejectNext.splice(i, 1); return r; } }
    for (const b of this.behaviours) { const r = b(p); if (r) return r; }
    return undefined;
  }
  cancelOrder({ serverOrderId, clientOrderId }) {
    this.cancels.push({ serverOrderId, clientOrderId });
    const o = [...this.book.values()].find((x) => x.serverId === String(serverOrderId) || x.clientOrderId === clientOrderId);
    if (!o) return;
    this.book.delete(o.clientOrderId);
    this._emitSoon(this._msg(o, STATUS.CANCELED, { OrderUpdateReason: 6 }));
  }
  // Fill an order at the broker (updates the position) and optionally tell the app.
  _fill(order, price, emit = true) {
    order.filled = order.quantity; order.avgFill = price;
    this.position += (order.side === 'BUY' ? 1 : -1) * order.quantity;
    this.lastPrice = price;
    this.book.delete(order.clientOrderId);
    if (emit) this._emitSoon(this._msg(order, STATUS.FILLED, { LastFillPrice: price, LastFillQuantity: order.quantity }));
  }
  // Test controls --------------------------------------------------------------------------------------------------------------------
  fillWorking(clientOrderId, price, emit = true) { const o = this.book.get(clientOrderId); if (!o) throw new Error(`fake: no working order ${clientOrderId}`); this._fill(o, price, emit); return o; }
  vanish(clientOrderId) { this.book.delete(clientOrderId); }             // the broker silently loses a working order
  rejectWorking(clientOrderId) { const o = this.book.get(clientOrderId); this.book.delete(clientOrderId); this._emitSoon(this._msg(o, STATUS.REJECTED, { InfoText: 'fake: rejected' })); }
  setPosition(n) { this.position = n; }
  workingOrders() { return [...this.book.values()]; }
  workingStops(side) { return this.workingOrders().filter((o) => o.orderType === 'STOP' && (!side || o.side === side)); }

  requestOpenOrders() {
    this.requestsOpenOrders++;
    setImmediate(() => {
      for (const o of this.book.values()) this.emit('orderUpdate', this._msg(o, STATUS.OPEN, { OrderUpdateReason: 1 }));
      this.emit('orderUpdate', { Type: 301, OrderUpdateReason: 1, ServerOrderID: '', ClientOrderID: '', NoOrders: 1, OrderStatus: 0 });
    });
  }
  requestCurrentPositions() {
    this.requestsPositions++;
    setImmediate(() => this.emit('positionUpdate', { Symbol: this.bareSymbol, TradeAccount: this.tradeAccount, Quantity: this.position, AveragePrice: this.lastPrice || 0, NoPositions: this.position === 0 ? 1 : 0 }));
  }
  requestSecurityDefinition(symbol) { setImmediate(() => this.emit('securityDefinition', { Symbol: symbol, DisplayPriceMultiplier: this.multiplier })); }
}

/** The one assertion every scenario ends with (designs 3.3): a non-zero broker position has exactly one working stop of the same size on the other side. */
export function protectionInvariant(fake) {
  if (fake.position === 0) return { ok: fake.workingStops().length === 0, why: fake.workingStops().length ? `flat but ${fake.workingStops().length} resting stop(s) (naked orders)` : 'flat, no stops' };
  const need = fake.position > 0 ? 'SELL' : 'BUY';
  const stops = fake.workingStops(need);
  const qty = stops.reduce((a, o) => a + o.quantity, 0);
  return { ok: stops.length === 1 && qty === Math.abs(fake.position), why: `position ${fake.position}, working ${need} stops: ${stops.length} (qty ${qty})` };
}
