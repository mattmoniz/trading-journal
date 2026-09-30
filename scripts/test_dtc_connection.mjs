#!/usr/bin/env node
// Stage 1 smoke test -- connect to Sierra Chart's DTC Protocol Server and log on.
// Does NOT submit an order unless --submit-test-order is passed explicitly (see below).
//
// Prerequisites in Sierra Chart (Global Settings):
//   1. Enable "DTC Protocol Server"
//   2. Enable "Allow Trading" (separate from data-only access)
//   3. If connecting from anywhere other than the same machine, enable "Require
//      Authentication" and set a Username/Password
//   4. Confirm Trade Simulation Mode is ON (Trade >> Trade Simulation Mode On) --
//      this script should only ever be run against that, not a real account, until
//      Stage 2 is explicitly decided.
//
// Usage:
//   DTC_HOST=<ip> DTC_PORT=<port> node scripts/test_dtc_connection.mjs
//   DTC_HOST=<ip> DTC_PORT=<port> DTC_USERNAME=<u> DTC_PASSWORD=<p> node scripts/test_dtc_connection.mjs
//
// Add --submit-test-order to also place one tiny test order after a successful logon
// (1 MNQ, market order) -- only meaningful once logon succeeds and you've confirmed
// Trade Simulation Mode is on. Left off by default on purpose.

import { DtcClient, ORDER_STATUS, ORDER_UPDATE_REASON } from '../server/services/sierraChart/dtcClient.js';

const host = process.env.DTC_HOST;
const port = process.env.DTC_PORT ? parseInt(process.env.DTC_PORT, 10) : null;
const submitTestOrder = process.argv.includes('--submit-test-order');

if (!host || !port) {
  console.error('Set DTC_HOST and DTC_PORT env vars first. See this script\'s own header comment for Sierra Chart prerequisites.');
  process.exit(1);
}

const client = new DtcClient({
  host, port,
  username: process.env.DTC_USERNAME || '',
  password: process.env.DTC_PASSWORD || '',
  clientName: 'trading-journal-stage1-test',
  tradeAccount: process.env.DTC_TRADE_ACCOUNT || '',
});

client.on('error', (err) => console.error('[error]', err.message));
client.on('disconnected', (reason) => console.log('[disconnected]', reason));
client.on('orderUpdate', (msg) => {
  const statusName = Object.entries(ORDER_STATUS).find(([, v]) => v === msg.OrderStatus)?.[0];
  const reasonName = Object.entries(ORDER_UPDATE_REASON).find(([, v]) => v === msg.OrderUpdateReason)?.[0];
  console.log(`[orderUpdate] ClientOrderID=${msg.ClientOrderID} status=${statusName} reason=${reasonName} filled=${msg.FilledQuantity ?? 0} avgPrice=${msg.AverageFillPrice ?? '-'} info="${msg.InfoText ?? ''}"`);
});

client.on('logon', (msg) => {
  console.log(`[logon] Result=${msg.Result} (1=SUCCESS) ResultText="${msg.ResultText || ''}" TradingIsSupported=${msg.TradingIsSupported} ServerName="${msg.ServerName || ''}"`);
  if (msg.Result !== 1) {
    console.error('Logon failed -- check Username/Password/TradeAccount and that "Allow Trading" is enabled in Sierra Chart.');
    client.disconnect('logon failed');
    process.exit(1);
  }
  if (!submitTestOrder) {
    console.log('Logon succeeded. Not submitting a test order (pass --submit-test-order to do that). Disconnecting.');
    setTimeout(() => { client.disconnect('smoke test complete'); process.exit(0); }, 1000);
    return;
  }
  console.log('Submitting 1 MNQ test market order (BUY)...');
  const id = client.submitOrder({ symbol: 'MNQZ6', exchange: 'CME', side: 'BUY', orderType: 'MARKET', quantity: 1 });
  console.log(`Order submitted, ClientOrderID=${id}. Waiting for ORDER_UPDATE... (Ctrl+C to exit)`);
});

console.log(`Connecting to ${host}:${port}...`);
client.connect().catch((err) => {
  console.error('Connection failed:', err.message);
  console.error('If this is a timeout/refused error, check: (1) DTC Protocol Server is enabled in Sierra Chart, (2) the port matches, (3) Windows Firewall allows the connection from WSL2.');
  process.exit(1);
});
