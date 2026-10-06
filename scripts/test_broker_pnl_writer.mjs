// Tests for recordBrokerPnlForSetup with a fake database (no real writes). Run: node scripts/test_broker_pnl_writer.mjs
import { recordBrokerPnlForSetup } from '../server/services/sierraChart/brokerPnlWriter.js';
let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); };
function fakeDb(entryRow) {
  const writes = [];
  return { writes, query: async (sql, params) => {
    if (sql.includes('UPDATE')) { writes.push(params); return { rows: [] }; }
    return { rows: entryRow ? [entryRow] : [] };
  } };
}
let db = fakeDb({ entry_side: 'SELL', entry_avg: 31564.75, exit_avg: 31565.00 });
let r = await recordBrokerPnlForSetup(1, db);
check('writes when both fills present', r.written && db.writes.length === 1 && Math.abs(db.writes[0][1] + 2.5) < 0.01);
db = fakeDb({ entry_side: 'SELL', entry_avg: 31564.75, exit_avg: null });
r = await recordBrokerPnlForSetup(2, db);
check('writes nothing when exit fill missing', !r.written && db.writes.length === 0);
db = fakeDb(null);
r = await recordBrokerPnlForSetup(3, db);
check('writes nothing when no filled entry', !r.written && db.writes.length === 0);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
