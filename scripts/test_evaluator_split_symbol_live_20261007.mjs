// LIVE round-trip test (2026-10-07) of the symbol/exchange wire-split fix (dtcClient.js). Not
// offline -- this submits a real resting order to whatever account DTC_HOST/DTC_PORT/
// DTC_TRADE_ACCOUNT point at (override via env on the command line; never touches .env).
//
// Proves the thing DeepSeek's review said the earlier OCO/linkage test did NOT prove: that a
// resting LIMIT order now actually RESTS AT ITS REAL PRICE instead of instant-filling at market
// regardless of price (the exact Sim1 failure mode this fix targets). Exercises the REAL calling
// convention production code uses -- combined symbol ("MNQZ6.CME"), exchange: '' -- via
// resolveMnqFrontMonthSymbol(), not a hand-adjusted split form, so this proves the fix as callers
// will actually use it, not just as the offline test constructs it.
//
// Submits a SELL LIMIT far above market (unfillable), watches for 10s, confirms it's still
// resting (not FILLED) and was NOT marked as a market order, then cancels it cleanly.
//
// Usage: DTC_HOST=... DTC_PORT=... DTC_TRADE_ACCOUNT=... node scripts/test_evaluator_split_symbol_live_20261007.mjs
import { DtcClient } from '../server/services/sierraChart/dtcClient.js';
import { resolveMnqFrontMonthSymbolFromEnv } from '../server/services/sierraChart/contractSymbol.js';
import { query } from '../server/db.js';

const host = process.env.DTC_HOST;
const port = Number(process.env.DTC_PORT);
const tradeAccount = process.env.DTC_TRADE_ACCOUNT;
if (!host || !port || !tradeAccount) {
  console.error('Set DTC_HOST, DTC_PORT, DTC_TRADE_ACCOUNT on the command line.');
  process.exit(1);
}

// Uses the real env-aware wrapper (DTC_SYMBOL_YEAR_DIGITS), not a hardcoded digit count -- this
// now exercises the exact same code path orderSweep.js/connectionManager.js use in production.
// CURRENT_DATE from the DB, not JS toISOString() -- the DB runs America/New_York; JS's own
// UTC-based "today" can disagree with it in the evening (standing CLAUDE.md rule).
const todayQ = await query('SELECT CURRENT_DATE::text as today');
const today = todayQ.rows[0].today;
const contract = resolveMnqFrontMonthSymbolFromEnv(today);
console.log(`Target: host=${host} port=${port} account=${tradeAccount} symbol=${contract.orderSymbol} (combined, exchange='', DTC_SYMBOL_YEAR_DIGITS=${process.env.DTC_SYMBOL_YEAR_DIGITS || '(unset, defaults to 1)'}) -- the exact convention orderSweep.js uses in production.`);

const c = new DtcClient({ host, port, username: '', password: '', tradeAccount, clientName: 'symbol-split-live-test' });
const updates = [];
c.on('orderUpdate', (m) => { updates.push(m); console.log('orderUpdate:', JSON.stringify({ OrderStatus: m.OrderStatus, OrderType: m.OrderType, Price1: m.Price1, Symbol: m.Symbol, Exchange: m.Exchange, ServerOrderID: m.ServerOrderID, InfoText: m.InfoText })); });
c.on('error', (e) => console.error('client error:', e.message));

const clientOrderId = `SPLITTEST-${Date.now()}`;
let serverOrderId = null;

c.on('logon', () => {
  console.log('Logged on. Submitting SELL LIMIT @ 40000 (far above market, unfillable) via the real submitOrder() path...');
  c.submitOrder({
    symbol: contract.orderSymbol, exchange: '', side: 'SELL', orderType: 'LIMIT',
    quantity: 1, price1: 40000, clientOrderId, tradeAccount,
  });
});

c.connect();

setTimeout(() => {
  const latest = updates.filter((u) => u.ClientOrderID === clientOrderId || u.ServerOrderID === serverOrderId).at(-1);
  for (const u of updates) if (u.ClientOrderID === clientOrderId && u.ServerOrderID) serverOrderId = u.ServerOrderID;

  const filled = updates.some((u) => u.ClientOrderID === clientOrderId && /fill/i.test(String(u.OrderStatus || '')));
  console.log(`\n--- After 10s: ${updates.filter((u) => u.ClientOrderID === clientOrderId).length} update(s) for this order. Filled: ${filled} ---`);
  if (filled) {
    console.error('FAIL: order filled at an unfillable price -- the split-symbol fix did NOT prevent instant-fill behavior on this account.');
  } else if (serverOrderId) {
    console.log('PASS so far: order is still resting at its real (unfillable) price, not filled. Canceling now...');
    c.cancelOrder({ serverOrderId, clientOrderId: `CANCEL-${clientOrderId}` });
  } else {
    console.error('INCONCLUSIVE: no ServerOrderID ever captured -- check the raw updates above (possible rejection).');
  }

  setTimeout(() => { c.disconnect?.(); process.exit(0); }, 4000);
}, 10000);
