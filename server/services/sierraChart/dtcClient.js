// DTC Protocol client for Sierra Chart order placement.
//
// DELIBERATELY PORTABLE: this file has ZERO imports from trading-journal-specific code
// (no server/db.js, no server/config/instruments.js, nothing project-specific). It's a
// plain Node.js `net` TCP client that speaks the DTC protocol. Host/port/credentials are
// passed into the constructor by the CALLER, never read from this app's own config or
// env vars directly -- so this file could be lifted into a different project with zero
// changes. See docs/OPEN_THREADS.md's 2026-09-28 Sierra Chart entry for the full design
// rationale (user's explicit "plug and play" requirement).
//
// Message field names, type codes, and enum values below are ALL verified directly
// against Sierra Chart's own real DTCProtocol.h header and message-reference doc pages
// (fetched 2026-09-28, not guessed -- see that same OPEN_THREADS.md entry for the exact
// pages).
//
// BOOTSTRAP SEQUENCE (confirmed 2026-09-28 via Sierra Chart's own docs, after a real
// ECONNRESET against a live server pointed at this being wrong): the ENCODING_REQUEST
// and ENCODING_RESPONSE messages MUST both be sent/received using raw BINARY encoding,
// regardless of what encoding the client is negotiating FOR -- quote: "During the
// initial exchange of the ENCODING_REQUEST and ENCODING_RESPONSE messages at the
// beginning of the network connection, these must be both sent using Binary Encoding."
// The client must then WAIT for the binary ENCODING_RESPONSE before sending anything
// else, including LOGON_REQUEST -- quote: "The Client waits for the ENCODING_RESPONSE
// from the Server ... The Client then changes encoding specified by the Encoding field
// ... All subsequent messages must be sent and received using the potential new
// encoding." The original version of this file skipped both of these (sent
// ENCODING_REQUEST as JSON text, fired LOGON_REQUEST immediately without waiting) --
// that's what caused the ECONNRESET seen against a real Sierra Chart install.
//
// s_EncodingRequest / s_EncodingResponse binary layout (from DTCProtocol.h, both
// structs identical): Size(uint16) + Type(uint16) + ProtocolVersion(int32) +
// Encoding(int32, EncodingEnum) + ProtocolType(char[4], "DTC"+NUL) = 16 bytes exactly.
// NOT independently confirmed by the fetched docs: byte order. Little-endian is used
// here as the standard DTC/Windows-native convention -- if wrong, the server will reset
// the connection again immediately at this same step (a cheap, decisive signal, not a
// silent-corruption risk), which is the first thing to check if a fresh connection
// attempt still resets right away after this fix.

import net from 'net';
import { EventEmitter } from 'events';

// ---- Message type codes (DTCProtocol.h, verified) ----
const MSG_TYPE = {
  LOGON_REQUEST: 1,
  LOGON_RESPONSE: 2,
  HEARTBEAT: 3,
  ENCODING_REQUEST: 6,
  ENCODING_RESPONSE: 7,
  CANCEL_ORDER: 203,
  CANCEL_REPLACE_ORDER: 204,
  OPEN_ORDERS_REQUEST: 300,
  SUBMIT_NEW_SINGLE_ORDER: 208,
  ORDER_UPDATE: 301,
  CURRENT_POSITIONS_REQUEST: 305,
  POSITION_UPDATE: 306,
  TRADE_ACCOUNTS_REQUEST: 400,
  TRADE_ACCOUNT_RESPONSE: 401,
  SECURITY_DEFINITION_FOR_SYMBOL_REQUEST: 506,
  SECURITY_DEFINITION_RESPONSE: 507,
};

// ---- Enum values (DTCProtocol.h, verified) ----
const ENCODING = { BINARY: 0, BINARY_VLS: 1, JSON: 2, JSON_COMPACT: 3, PROTOCOL_BUFFERS: 4 };
const BUY_SELL = { BUY: 1, SELL: 2 };
const ORDER_TYPE = { MARKET: 1, LIMIT: 2, STOP: 3, STOP_LIMIT: 4 };
const TIME_IN_FORCE = { DAY: 1, GTC: 2, GOOD_TILL_DATE_TIME: 3, IOC: 4, ALL_OR_NONE: 5, FOK: 6 };
export const ORDER_STATUS = {
  UNSPECIFIED: 0, ORDER_SENT: 1, PENDING_OPEN: 2, PENDING_CHILD: 3, OPEN: 4,
  PENDING_CANCEL_REPLACE: 5, PENDING_CANCEL: 6, FILLED: 7, CANCELED: 8,
  REJECTED: 9, PARTIALLY_FILLED: 10,
};
export const ORDER_UPDATE_REASON = {
  OPEN_ORDERS_REQUEST_RESPONSE: 1, NEW_ORDER_ACCEPTED: 2, GENERAL_ORDER_UPDATE: 3,
  ORDER_FILLED: 4, ORDER_FILLED_PARTIALLY: 5, ORDER_CANCELED: 6,
  ORDER_CANCEL_REPLACE_COMPLETE: 7, NEW_ORDER_REJECTED: 8, ORDER_CANCEL_REJECTED: 9,
  ORDER_CANCEL_REPLACE_REJECTED: 10,
};

const PROTOCOL_VERSION = 8;
const NUL = '\0';

/**
 * A DTC client, config-driven, zero knowledge of any specific trading app.
 *
 * new DtcClient({
 *   host, port,               // required -- caller's responsibility, never hardcoded here
 *   username, password,       // Sierra Chart DTC login (Global Settings -> DTC Protocol Server)
 *   clientName,               // free-text, shown in Sierra Chart's own connection list
 *   tradeAccount,             // which Sierra Chart trade account to submit orders against
 *   heartbeatIntervalSec = 20,
 * })
 *
 * Events emitted (EventEmitter): 'connected', 'logon' (LOGON_RESPONSE payload),
 * 'disconnected' (reason), 'orderUpdate' (raw ORDER_UPDATE payload), 'error' (Error).
 * Callers should listen for 'orderUpdate' and interpret OrderStatus/OrderUpdateReason
 * themselves (exported above) -- this client does not interpret fills/rejects, since
 * that's a decision for the trading-journal-specific consumer, not this generic client.
 */
export class DtcClient extends EventEmitter {
  constructor({ host, port, username, password, clientName = 'dtc-client', tradeAccount, heartbeatIntervalSec = 20 }) {
    super();
    if (!host || !port) throw new Error('DtcClient requires host and port -- never defaulted, never hardcoded.');
    this._host = host;
    this._port = port;
    this._username = username;
    this._password = password;
    this._clientName = clientName;
    this._tradeAccount = tradeAccount;
    this._heartbeatIntervalSec = heartbeatIntervalSec;
    this._socket = null;
    this._buf = '';
    this._rawBuf = Buffer.alloc(0);
    this._encodingNegotiated = false;
    this._heartbeatTimer = null;
    this._loggedOn = false;
    this._nextClientOrderId = 1;
    this._lastMessageAt = null;
  }

  get isConnected() { return !!this._socket && !this._socket.destroyed; }
  get isLoggedOn() { return this._loggedOn; }
  get tradeAccount() { return this._tradeAccount; }
  get lastKnownService() { return this._lastKnownService ?? null; }

  /**
   * `isConnected`/`isLoggedOn` are just booleans -- neither detects a dead-but-not-yet-
   * closed TCP connection (the remote end dropped without ever sending a FIN/RST). A
   * DTC server sends a HEARTBEAT roughly every `heartbeatIntervalSec`; if genuinely
   * nothing has arrived (not even a heartbeat) for more than 2x that interval, treat the
   * connection as stale even though the socket object itself still looks "open." Flagged
   * by DeepSeek review 2026-09-29 as a real gap for a real-order system -- a caller
   * submitting into a half-open socket gets no error (the write just buffers), the order
   * silently never reaches the broker, and only reconcileAgainstBroker() would ever
   * notice, well after the fact. Callers placing real orders should check this before
   * trusting `isLoggedOn` alone.
   */
  isLive() {
    if (!this.isConnected || !this._loggedOn) return false;
    if (this._lastMessageAt == null) return false;
    return (Date.now() - this._lastMessageAt) < this._heartbeatIntervalSec * 1000 * 2;
  }

  getConnectionHealth() {
    return {
      connected: this.isConnected,
      loggedOn: this._loggedOn,
      lastMessageAgeMs: this._lastMessageAt == null ? null : Date.now() - this._lastMessageAt,
      live: this.isLive(),
    };
  }

  connect() {
    if (this._socket) throw new Error('DtcClient.connect() called while already connected -- call disconnect() first.');
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this._host, port: this._port });
      this._socket = sock;
      const onConnectError = (err) => { this._teardown(); reject(err); };
      sock.once('error', onConnectError);
      sock.once('connect', () => {
        sock.off('error', onConnectError);
        sock.on('error', (err) => this.emit('error', err));
        sock.on('close', () => this._onSocketClose('closed'));
        sock.on('data', (chunk) => this._onData(chunk));
        this.emit('connected');
        // Binary ENCODING_REQUEST -- see the file-header comment for why this can't be
        // JSON. LOGON_REQUEST is sent later, from _onData(), once the binary
        // ENCODING_RESPONSE actually arrives -- not here.
        this._socket.write(this._buildEncodingRequestBinary());
        resolve();
      });
    });
  }

  _buildEncodingRequestBinary() {
    const buf = Buffer.alloc(16);
    buf.writeUInt16LE(16, 0);                          // Size
    buf.writeUInt16LE(MSG_TYPE.ENCODING_REQUEST, 2);   // Type = 6
    buf.writeInt32LE(PROTOCOL_VERSION, 4);             // ProtocolVersion
    buf.writeInt32LE(ENCODING.JSON, 8);                // Encoding requested
    buf.write('DTC', 12, 3, 'ascii');                  // ProtocolType[4], 4th byte stays \0
    return buf;
  }

  _parseEncodingResponseBinary(buf) {
    return {
      Size: buf.readUInt16LE(0),
      Type: buf.readUInt16LE(2),
      ProtocolVersion: buf.readInt32LE(4),
      Encoding: buf.readInt32LE(8),
      ProtocolType: buf.slice(12, 16).toString('ascii').replace(/\0.*$/, ''),
    };
  }

  disconnect(reason = 'client requested') {
    this._teardown();
    this.emit('disconnected', reason);
  }

  _teardown() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    if (this._socket) {
      this._socket.removeAllListeners();
      this._socket.destroy();
      this._socket = null;
    }
    this._loggedOn = false;
    this._buf = '';
    this._rawBuf = Buffer.alloc(0);
    this._encodingNegotiated = false;
  }

  _onSocketClose(reason) {
    const wasLoggedOn = this._loggedOn;
    this._teardown();
    this.emit('disconnected', wasLoggedOn ? reason : `${reason} (never completed logon)`);
  }

  _sendLogonRequest() {
    this._send({
      Type: MSG_TYPE.LOGON_REQUEST,
      ProtocolVersion: PROTOCOL_VERSION,
      Username: this._username,
      Password: this._password,
      HeartbeatIntervalInSeconds: this._heartbeatIntervalSec,
      TradeAccount: this._tradeAccount,
      ClientName: this._clientName,
    });
  }

  /**
   * Ask Sierra Chart for the real trade account list under the current login. Response
   * arrives as one or more 'tradeAccount' events (TotalNumberMessages/MessageNumber
   * lets the caller know when all of them have arrived) -- fields verified against
   * DTCProtocol.h's s_TradeAccountResponse, 2026-09-28.
   */
  requestTradeAccounts() {
    if (!this._loggedOn) throw new Error('DtcClient.requestTradeAccounts(): not logged on.');
    this._send({ Type: MSG_TYPE.TRADE_ACCOUNTS_REQUEST, RequestID: this._nextRequestId() });
  }

  /**
   * Ask Sierra Chart for every currently open order, for reconciliation on
   * connect/reconnect -- "what does the broker think is actually open right now,"
   * never assumed. Responses arrive as ordinary 'orderUpdate' events with
   * OrderUpdateReason=OPEN_ORDERS_REQUEST_RESPONSE (1). Fields verified against
   * DTCProtocol.h's s_OpenOrdersRequest, 2026-09-28.
   */
  requestOpenOrders(tradeAccount = this._tradeAccount) {
    if (!this._loggedOn) throw new Error('DtcClient.requestOpenOrders(): not logged on.');
    this._send({ Type: MSG_TYPE.OPEN_ORDERS_REQUEST, RequestID: this._nextRequestId(), RequestAllOrders: 1, TradeAccount: tradeAccount });
  }

  /**
   * Ask Sierra Chart for every currently open position -- the other half of startup
   * reconciliation alongside requestOpenOrders(). Responses arrive as 'positionUpdate'
   * events. Fields verified against DTCProtocol.h's s_CurrentPositionsRequest/
   * s_PositionUpdate, 2026-09-28.
   */
  requestCurrentPositions(tradeAccount = this._tradeAccount) {
    if (!this._loggedOn) throw new Error('DtcClient.requestCurrentPositions(): not logged on.');
    this._send({ Type: MSG_TYPE.CURRENT_POSITIONS_REQUEST, RequestID: this._nextRequestId(), TradeAccount: tradeAccount });
  }

  /**
   * Ask Sierra Chart for a symbol's real contract specs -- specifically
   * `DisplayPriceMultiplier`, the factor broker-reported fill-price fields
   * (AverageFillPrice/LastFillPrice on ORDER_UPDATE) need multiplying by to get the real
   * float price (confirmed live 2026-09-29: MNQZ6.CME's real fills came back as e.g.
   * `3043725`, and this symbol's own DisplayPriceMultiplier=0.00999... resolves it to the
   * real `30437.25`). `Price1`/`Price2` that THIS client sets when submitting an order are
   * NOT affected -- only broker-originated fill-price fields need this. Response arrives
   * as a 'securityDefinition' event.
   */
  requestSecurityDefinition(symbol, exchange = '') {
    if (!this._loggedOn) throw new Error('DtcClient.requestSecurityDefinition(): not logged on.');
    this._send({ Type: MSG_TYPE.SECURITY_DEFINITION_FOR_SYMBOL_REQUEST, RequestID: this._nextRequestId(), Symbol: symbol, Exchange: exchange });
  }

  _nextRequestId() { return this._nextRequestIdCounter = (this._nextRequestIdCounter || 0) + 1; }

  _startHeartbeat() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = setInterval(() => {
      this._send({ Type: MSG_TYPE.HEARTBEAT, CurrentDateTime: Math.floor(Date.now() / 1000) });
    }, this._heartbeatIntervalSec * 1000);
  }

  // JSON messages are NUL-byte terminated on the wire -- one JSON object per message,
  // no length prefix needed since JSON is self-delimiting once you split on '\0'.
  _send(obj) {
    if (!this.isConnected) throw new Error('DtcClient: cannot send, not connected.');
    this._socket.write(JSON.stringify(obj) + NUL);
  }

  _onData(chunk) {
    this._lastMessageAt = Date.now(); // any bytes at all count as liveness, not just parsed messages
    if (!this._encodingNegotiated) {
      this._rawBuf = Buffer.concat([this._rawBuf, chunk]);
      if (this._rawBuf.length < 16) return; // wait for the rest of the 16-byte struct
      const resp = this._parseEncodingResponseBinary(this._rawBuf.slice(0, 16));
      const remainder = this._rawBuf.slice(16);
      this._rawBuf = Buffer.alloc(0);
      this._encodingNegotiated = true;
      if (resp.Type !== MSG_TYPE.ENCODING_RESPONSE) {
        this.emit('error', new Error(`DtcClient: expected ENCODING_RESPONSE (7) as the first message, got Type=${resp.Type} -- bootstrap assumption may be wrong, see file header comment.`));
        return;
      }
      if (resp.Encoding !== ENCODING.JSON) {
        this.emit('error', new Error(`DtcClient: server did not confirm JSON encoding (responded Encoding=${resp.Encoding}) -- this client only speaks JSON, cannot continue.`));
        return;
      }
      this._sendLogonRequest();
      if (remainder.length) this._onData(remainder); // any JSON bytes that arrived in the same packet
      return;
    }
    this._buf += chunk.toString('utf8');
    let idx;
    while ((idx = this._buf.indexOf(NUL)) !== -1) {
      const raw = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 1);
      if (!raw) continue;
      let msg;
      try { msg = JSON.parse(raw); }
      catch (e) { this.emit('error', new Error(`DtcClient: failed to parse message: ${e.message} -- raw: ${raw.slice(0, 200)}`)); continue; }
      this._handleMessage(msg);
    }
  }

  _handleMessage(msg) {
    switch (msg.Type) {
      // ENCODING_RESPONSE is never handled here -- it's always Binary-encoded per the
      // DTC bootstrap sequence, consumed directly in _onData() before this JSON path
      // is even reached (see the file header comment).
      case MSG_TYPE.LOGON_RESPONSE:
        this._loggedOn = msg.Result === 1; // LOGON_SUCCESS = 1, per DTCProtocol.h
        // No top-level `Service` field exists on LOGON_RESPONSE -- confirmed live 2026-09-29
        // (an earlier version of this line read msg.Service directly and always got null).
        // The real environment identifier is embedded in ResultText as a pipe-delimited
        // "Service=<x>|SymbolSettings=<y>" string, e.g. "Connected to SC DTC Protocol
        // server. Service=rithmic_v2.trading|SymbolSettings=rithmic_v2.trading" -- this is
        // the single most important field for knowing which real environment (Rithmic-
        // routed vs. anything else) this connection is actually against.
        this._lastKnownService = (msg.ResultText || '').match(/Service=([^|]+)/)?.[1] || null;
        if (this._loggedOn) this._startHeartbeat();
        this.emit('logon', msg);
        if (!this._loggedOn) this.emit('error', new Error(`DTC logon failed: ${msg.ResultText || 'no reason given'}`));
        break;
      case MSG_TYPE.HEARTBEAT:
        // Server heartbeat -- purely a liveness signal, no action needed. If these stop
        // arriving, the caller's own connection-health check (not this file) should
        // notice via a stale last-message timestamp, matching the DeepSeek critique's
        // "heartbeat age, not a boolean connected" finding.
        break;
      case MSG_TYPE.ORDER_UPDATE:
        this.emit('orderUpdate', msg);
        break;
      case MSG_TYPE.POSITION_UPDATE:
        this.emit('positionUpdate', msg);
        break;
      case MSG_TYPE.TRADE_ACCOUNT_RESPONSE:
        this.emit('tradeAccount', msg);
        break;
      case MSG_TYPE.SECURITY_DEFINITION_RESPONSE:
        this.emit('securityDefinition', msg);
        break;
      default:
        this.emit('error', new Error(`DtcClient: unhandled message Type=${msg.Type}`));
    }
  }

  /**
   * Submit a new order. Returns the ClientOrderID this client generated (the caller's
   * only handle on the order until an ORDER_UPDATE arrives echoing it back) -- does NOT
   * wait for a fill; the caller listens for 'orderUpdate' events and matches on
   * ClientOrderID. This client does not track open orders/positions itself -- that's
   * reconciliation logic, which belongs in the trading-journal-specific consumer, not
   * here (per the portability boundary this file is designed around).
   *
   * { symbol, exchange, side: 'BUY'|'SELL', orderType: 'MARKET'|'LIMIT'|'STOP',
   *   quantity, price1, price2, timeInForce = 'DAY', clientOrderId }
   *
   * `clientOrderId` is optional -- if the caller doesn't supply one, this client
   * generates a simple in-process sequential id (fine for the standalone smoke test,
   * NOT fine for a real persistent caller). A real order-placing caller with its own
   * durable ID source (e.g. a DB row id/UUID that survives a process restart) should
   * always pass its own -- this client's internal counter resets to 1 on every restart,
   * which would collide with IDs already used by a still-open order from before the
   * restart. This client has no way to know that on its own (no persistent storage,
   * by design -- see the portability header comment), so the caller must own uniqueness
   * whenever restart-survival matters.
   */
  submitOrder({ symbol, exchange, side, orderType, quantity, price1 = 0, price2 = 0, timeInForce = 'DAY', clientOrderId, tradeAccount }) {
    if (!this._loggedOn) throw new Error('DtcClient.submitOrder(): not logged on.');
    if (!BUY_SELL[side]) throw new Error(`DtcClient.submitOrder(): invalid side "${side}"`);
    if (!ORDER_TYPE[orderType]) throw new Error(`DtcClient.submitOrder(): invalid orderType "${orderType}"`);
    if (!TIME_IN_FORCE[timeInForce]) throw new Error(`DtcClient.submitOrder(): invalid timeInForce "${timeInForce}"`);
    if (clientOrderId == null) clientOrderId = String(this._nextClientOrderId++);
    this._send({
      Type: MSG_TYPE.SUBMIT_NEW_SINGLE_ORDER,
      Symbol: symbol,
      Exchange: exchange,
      ClientOrderID: clientOrderId,
      OrderType: ORDER_TYPE[orderType],
      BuySell: BUY_SELL[side],
      Price1: price1,
      Price2: price2,
      TimeInForce: TIME_IN_FORCE[timeInForce],
      Quantity: quantity,
      TradeAccount: tradeAccount || this._tradeAccount,
      IsAutomatedOrder: true,
    });
    return clientOrderId;
  }

  /**
   * Cancel a still-working order. Per Sierra Chart's own DTC docs (fetched 2026-09-28,
   * verified against DTCProtocol.h's s_OrderUpdate struct): CANCEL_ORDER identifies the
   * order to cancel by ServerOrderID ONLY, not ClientOrderID -- ClientOrderID is required
   * on the message too but is a validation field, not the lookup key. The caller must
   * have captured ServerOrderID from a prior ORDER_UPDATE for this order (it does not
   * exist until the server assigns it, so a brand-new order can't be canceled by its
   * ClientOrderID alone before at least one ORDER_UPDATE has arrived).
   *
   * { serverOrderId, clientOrderId }
   */
  cancelOrder({ serverOrderId, clientOrderId }) {
    if (!this._loggedOn) throw new Error('DtcClient.cancelOrder(): not logged on.');
    if (!serverOrderId) throw new Error('DtcClient.cancelOrder(): serverOrderId is required -- CANCEL_ORDER cannot identify an order by ClientOrderID alone.');
    this._send({
      Type: MSG_TYPE.CANCEL_ORDER,
      ServerOrderID: serverOrderId,
      ClientOrderID: clientOrderId,
    });
  }
}
