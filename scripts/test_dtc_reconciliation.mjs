#!/usr/bin/env node
// Read-only test: connect, logon, and call reconcileAgainstBroker() against the real
// account to see what a real (likely empty, since nothing has traded yet) open-orders/
// positions response actually looks like. Places NO orders. Safe to run any time.
import { DtcClient } from '../server/services/sierraChart/dtcClient.js';
import { reconcileAgainstBroker } from '../server/services/sierraChart/reconciliation.js';

const host = process.env.DTC_HOST;
const port = process.env.DTC_PORT ? parseInt(process.env.DTC_PORT, 10) : null;
if (!host || !port) { console.error('Set DTC_HOST and DTC_PORT.'); process.exit(1); }

const client = new DtcClient({ host, port, clientName: 'trading-journal-reconcile-test', tradeAccount: process.env.DTC_TRADE_ACCOUNT || '' });
client.on('error', (e) => console.error('[error]', e.message));

// Log raw events too, so we can see the REAL shape of a response (field names present,
// how a zero-results case actually looks) rather than trusting the struct-doc guess.
client.on('orderUpdate', (m) => console.log('[raw orderUpdate]', JSON.stringify(m)));
client.on('positionUpdate', (m) => console.log('[raw positionUpdate]', JSON.stringify(m)));
client.on('tradeAccount', (m) => console.log('[raw tradeAccount]', JSON.stringify(m)));

client.on('logon', async (msg) => {
  if (msg.Result !== 1) { console.error('logon failed'); process.exit(1); }
  console.log(`Logged on. Service=${msg.Service || '(none)'} requesting trade accounts, open orders, positions...`);
  client.requestTradeAccounts();
  const report = await reconcileAgainstBroker(client, { collectWindowMs: 5000 });
  console.log('\n=== RECONCILIATION REPORT ===');
  console.log(JSON.stringify(report, null, 2));
  client.disconnect('test complete');
  process.exit(0);
});

client.connect().catch((e) => { console.error('connect failed:', e.message); process.exit(1); });
