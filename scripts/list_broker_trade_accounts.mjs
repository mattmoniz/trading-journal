// READ-ONLY (2026-10-06): asks the DTC broker which trade accounts exist for this login. Submits nothing.
import { DtcClient } from '../server/services/sierraChart/dtcClient.js';
const c = new DtcClient({ host: process.env.DTC_HOST, port: Number(process.env.DTC_PORT), username: process.env.DTC_USERNAME || '', password: process.env.DTC_PASSWORD || '', tradeAccount: '', clientName: 'account-list-readonly' });
const accounts = [];
c.on('tradeAccount', (m) => accounts.push(m));
c.on('logon', () => c.requestTradeAccounts());
c.connect();
setTimeout(() => { console.log('trade account responses:', JSON.stringify(accounts.map(a => a.TradeAccount ?? a), null, 1)); c.disconnect?.(); process.exit(0); }, 8000);
