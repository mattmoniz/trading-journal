#!/usr/bin/env node
/**
 * DTC Phase 0 feasibility test.
 * Connects to Sierra Chart's local DTC server (JSON encoding), sends
 * ENCODING_REQUEST → LOGON_REQUEST, reads LOGON_RESPONSE flags, exits.
 *
 * Usage: node scripts/dtc_phase0_test.js [host] [port]
 */
'use strict';

const net = require('net');
const os  = require('os');

// Windows host from WSL — override via args
const HOST = process.argv[2] || (() => {
  // Parse /proc/net/route for default gateway (Windows IP in WSL)
  try {
    const lines = require('fs').readFileSync('/proc/net/route', 'utf8').split('\n').slice(1);
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      if (cols[1] === '00000000' && cols[7] === '00000000') {
        const gw = parseInt(cols[2], 16);
        return [(gw & 0xff), (gw >> 8 & 0xff), (gw >> 16 & 0xff), (gw >> 24 & 0xff)].join('.');
      }
    }
  } catch (_) {}
  return '172.27.192.1';
})();

const PORT = parseInt(process.argv[3] || '11099', 10);

// DTC message type constants
const T = {
  ENCODING_REQUEST:           6,
  ENCODING_RESPONSE:          7,
  LOGON_REQUEST:              1,
  LOGON_RESPONSE:             2,
  HEARTBEAT:                  3,
  CURRENT_POSITIONS_REQUEST:  305,
  ACCOUNT_BALANCE_REQUEST:    601,
  TRADE_ACCOUNTS_REQUEST:     400,
};

const ENCODING = { JSON: 2 };

let buf = '';
let logonDone = false;
let jsonMode = false;  // true after ENCODING_RESPONSE received

function sendBinaryEncodingRequest(sock) {
  // Binary struct: uint16 Size(16), uint16 Type(6), int32 ProtocolVersion(8), int32 Encoding(2=JSON), char[4] "DTC\0"
  const b = Buffer.alloc(16);
  b.writeUInt16LE(16, 0);   // Size
  b.writeUInt16LE(6,  2);   // Type = ENCODING_REQUEST
  b.writeInt32LE(8,   4);   // ProtocolVersion
  b.writeInt32LE(2,   8);   // Encoding = JSON_ENCODING
  b.write('DTC\0', 12, 4, 'ascii');
  process.stdout.write(`→ SEND ENCODING_REQUEST (binary, 16 bytes): ${b.toString('hex')}\n`);
  sock.write(b);
}

function send(sock, obj) {
  const msg = JSON.stringify(obj) + '\0';
  process.stdout.write(`→ SEND type=${obj.Type} ${JSON.stringify(obj).slice(0, 120)}\n`);
  sock.write(msg);
}

function onMessage(sock, msg) {
  let obj;
  try { obj = JSON.parse(msg); } catch (_) {
    console.log(`← RAW (unparseable): ${msg.slice(0, 200)}`);
    return;
  }
  process.stdout.write(`← RECV type=${obj.Type} ${JSON.stringify(obj).slice(0, 200)}\n`);

  switch (obj.Type) {
    case T.ENCODING_RESPONSE:
      console.log(`\n[ENCODING] Server accepted encoding=${obj.Encoding} (2=JSON) via JSON path`);
      break;

    case T.LOGON_RESPONSE:
      logonDone = true;
      console.log('\n========== LOGON_RESPONSE FLAGS ==========');
      console.log(`  Result:                      ${obj.Result} (1=success)`);
      console.log(`  ResultText:                  ${obj.ResultText || '(none)'}`);
      console.log(`  ServerName:                  ${obj.ServerName || '(none)'}`);
      console.log(`  MarketDataSupported:         ${obj.MarketDataSupported}`);
      console.log(`  MarketDepthIsSupported:      ${obj.MarketDepthIsSupported}`);
      console.log(`  TradingIsSupported:          ${obj.TradingIsSupported}`);
      console.log(`  OCOOrdersSupported:          ${obj.OCOOrdersSupported}`);
      console.log(`  SecurityDefinitionsSupported:${obj.SecurityDefinitionsSupported}`);
      console.log(`  HistoricalPriceDataSupported:${obj.HistoricalPriceDataSupported}`);
      console.log(`  BracketOrdersSupported:      ${obj.BracketOrdersSupported}`);
      console.log('==========================================\n');

      if (obj.Result === 1) {
        // Request trade accounts to verify position data access
        send(sock, { Type: T.TRADE_ACCOUNTS_REQUEST, RequestID: 1 });
        setTimeout(() => {
          send(sock, { Type: T.ACCOUNT_BALANCE_REQUEST, RequestID: 2, TradeAccount: '' });
        }, 500);
        setTimeout(() => {
          send(sock, { Type: T.CURRENT_POSITIONS_REQUEST, RequestID: 3, TradeAccount: '' });
        }, 1000);
        setTimeout(() => {
          console.log('\n[Phase 0] Connection proven. Closing cleanly.');
          sock.destroy();
        }, 2500);
      } else {
        console.log('[Phase 0] Logon FAILED — check SC server settings (allow unauthenticated?)');
        sock.destroy();
      }
      break;

    case T.HEARTBEAT:
      // SC sends heartbeats — just log, don't send one back yet
      break;

    case 401:  // TRADE_ACCOUNT_RESPONSE
      console.log(`  → TradeAccount: ${obj.TradeAccount} (IsFinalMessage=${obj.IsFinalMessage})`);
      break;

    case 600:  // ACCOUNT_BALANCE_UPDATE
      console.log(`  → AccountBalance: acct=${obj.TradeAccount} cash=${obj.CashBalance} PnL=${obj.OpenPositionsPnL}`);
      break;

    case 306:  // POSITION_UPDATE
      console.log(`  → Position: sym=${obj.Symbol} qty=${obj.Quantity} avgPrice=${obj.AveragePrice} PnL=${obj.OpenPositionsPnL}`);
      break;

    default:
      break;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log(`[Phase 0] Connecting to DTC server at ${HOST}:${PORT} ...`);

const sock = net.createConnection({ host: HOST, port: PORT });
sock.setTimeout(8000);

sock.on('connect', () => {
  console.log(`[Phase 0] TCP connected.\n`);
  // Step 1: ENCODING_REQUEST must be sent in binary (the protocol baseline)
  sendBinaryEncodingRequest(sock);
});

sock.on('data', (chunk) => {
  console.log(`← RAW DATA (${chunk.length} bytes): ${chunk.toString('hex')}`);
  if (!jsonMode) {
    // Check for binary ENCODING_RESPONSE: uint16 Size, uint16 Type(7), int32 ProtocolVersion, int32 Encoding
    if (chunk.length >= 8 && chunk.readUInt16LE(2) === 7) {
      const encoding = chunk.readInt32LE(8);
      console.log(`← RECV ENCODING_RESPONSE (binary): Encoding=${encoding} (2=JSON)`);
      jsonMode = true;
      // Switch to JSON for all subsequent messages
      send(sock, {
        Type:                      T.LOGON_REQUEST,
        ProtocolVersion:           8,
        Username:                  '',
        Password:                  '',
        GeneralTextData:           '',
        Integer1:                  0,
        Integer2:                  0,
        HeartbeatIntervalInSeconds: 10,
        TradeMode:                 0,
        TradeAccount:              '',
        HardwareIdentifier:        '',
        ClientName:                'TradingJournalPhase0',
      });
      // If there's remaining data in the chunk, process it as JSON
      const remaining = chunk.slice(12).toString('utf8');
      if (remaining.trim()) {
        buf += remaining;
        const parts = buf.split('\0');
        buf = parts.pop();
        for (const part of parts) { if (part.trim()) onMessage(sock, part.trim()); }
      }
      return;
    }
  }
  buf += chunk.toString('utf8');
  const parts = buf.split('\0');
  buf = parts.pop();
  for (const part of parts) {
    if (part.trim()) onMessage(sock, part.trim());
  }
});

sock.on('timeout', () => {
  console.log('\n[Phase 0] Timeout waiting for response.');
  sock.destroy();
});

sock.on('error', (err) => {
  console.error(`\n[Phase 0] Connection error: ${err.message}`);
  if (err.code === 'ECONNREFUSED') {
    console.error('  → DTC server is not running or not on this port.');
    console.error('  → In Sierra Chart: Global Settings → Sierra Chart Server Settings → Enable DTC Server');
    console.error(`  → Confirm port (default 11099) matches: ${PORT}`);
  }
  process.exit(1);
});

sock.on('close', () => {
  console.log('[Phase 0] Connection closed.');
  process.exit(logonDone ? 0 : 1);
});
