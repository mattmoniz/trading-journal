// Checks for the 2026-10-19 "filled trade with no entry price blocks the daily-loss gate" fix:
//  1. priceMultiplier: a failed lookup is retried after a short window (it used to be cached as null forever).
//  2. dllGate: a filled trade with no avg_fill_price is counted at an estimated worst case, not block-everything.
//  3. fillPriceRepair: a NULL avg_fill_price is repaired from the kept raw broker message.
// Parts 2-3 run on a copy of a real round trip inside a transaction that is ALWAYS rolled back.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { getPriceMultiplier, _resetPriceMultiplierCacheForTests, FAILED_LOOKUP_RETRY_MS } from '../server/services/sierraChart/priceMultiplier.js';
import { DLL_ROW_SQL, dllGateDecision } from '../server/services/sierraChart/dllGate.js';
import { repairNullFillPrices, pickRawFill } from '../server/services/sierraChart/fillPriceRepair.js';
import { getClient } from '../server/db.js';
import { getLiveDataAttention } from '../server/services/sierraChart/brokerAttention.js';

// ---- 1. multiplier retry ----
class FakeDtc extends EventEmitter {
  constructor() { super(); this.isLoggedOn = true; this.requests = 0; this.answer = false; }
  requestSecurityDefinition(sym) { this.requests++; if (this.answer) setImmediate(() => this.emit('securityDefinition', { Symbol: sym, DisplayPriceMultiplier: 1 })); }
}
_resetPriceMultiplierCacheForTests();
const dtc = new FakeDtc();
let t = 1000; const clock = () => t;
const origSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms) => origSetTimeout(fn, ms > 100 ? 5 : ms); // shrink the 4s lookup timeout for the test
assert.equal(await getPriceMultiplier(dtc, 'MNQZ26.CME', clock), null);          // no answer -> null
assert.equal(dtc.requests, 1);
assert.equal(await getPriceMultiplier(dtc, 'MNQZ26.CME', clock), null);          // inside the retry window -> no new request
assert.equal(dtc.requests, 1);
t += FAILED_LOOKUP_RETRY_MS + 1; dtc.answer = true;                              // window over, broker now answers
assert.equal(await getPriceMultiplier(dtc, 'MNQZ26.CME', clock), 1);             // retried and recovered (old code: null forever)
assert.equal(await getPriceMultiplier(dtc, 'MNQZ26.CME', clock), 1);
assert.equal(dtc.requests, 2);                                                   // success is cached
const dtc2 = new FakeDtc(); dtc2.answer = true; _resetPriceMultiplierCacheForTests();
const [a, b] = await Promise.all([getPriceMultiplier(dtc2, 'X', clock), getPriceMultiplier(dtc2, 'X', clock)]);
assert.deepEqual([a, b, dtc2.requests], [1, 1, 1]);                              // concurrent callers share one request
global.setTimeout = origSetTimeout;
console.log('1. multiplier retry ok');

// ---- pickRawFill ----
assert.equal(pickRawFill([{ OrderStatus: 4, AverageFillPrice: 0 }, { OrderStatus: 7, AverageFillPrice: 29784 }]).rawAvg, 29784);
assert.equal(pickRawFill([{ OrderStatus: 2, AverageFillPrice: 0 }]), null);

// ---- 2 + 3 on a real round trip, rolled back ----
const client = await getClient();
try {
  await client.query('BEGIN');
  const pick = await client.query(`
    SELECT a.id, e.trade_account FROM active_setups a
    JOIN order_placements e ON e.setup_id = a.id AND e.purpose='ENTRY' AND e.status='FILLED' AND e.avg_fill_price IS NOT NULL
    JOIN order_placements_updates u ON u.client_order_id = e.client_order_id
    WHERE a.origin_status='ACTIVE' AND a.status<>'ACTIVE' AND a.stop_level IS NOT NULL AND a.broker_pnl IS NOT NULL
      AND e.order_type = 'LIMIT' AND e.symbol = 'MNQZ26.CME'
    ORDER BY a.id DESC LIMIT 1`);
  assert.ok(pick.rows[0], 'need one real closed trade to copy');
  const { id, trade_account } = pick.rows[0];
  const orig = (await client.query(`SELECT avg_fill_price::float AS p FROM order_placements WHERE setup_id=$1 AND purpose='ENTRY'`, [id])).rows[0].p;
  const origPnl = (await client.query(`SELECT broker_pnl::float AS p FROM active_setups WHERE id=$1`, [id])).rows[0].p;
  // make it "today's trade, broker P&L unknown, entry fill price missing"
  await client.query(`UPDATE active_setups SET trade_date = CURRENT_DATE, broker_pnl = NULL WHERE id=$1`, [id]);
  await client.query(`UPDATE order_placements SET avg_fill_price = NULL, created_at = now() WHERE setup_id=$1 AND purpose='ENTRY'`, [id]);
  const row = (await client.query(DLL_ROW_SQL, [trade_account, 2])).rows[0];
  assert.equal(row.unknown_no_stop, 0, 'a missing fill price must no longer force block-everything');
  assert.ok(row.unknown_worst > 0 && row.unknown_price_estimated >= 1, 'worst case estimated from order/setup price');
  const d = dllGateDecision({ realizedBrokerPnl: row.realized, unknownCount: row.unknown, limit: 1000, unknownWorstCaseLoss: row.unknown_worst });
  console.log('2. gate with missing entry price ->', d.blocked, '|', d.reason);
  assert.equal(d.blocked, false);
  // a limit exactly at (known P&L - worst case) must still block: fail-closed intent is kept
  const edge = row.unknown_worst - row.realized;
  if (edge > 0) assert.equal(dllGateDecision({ realizedBrokerPnl: row.realized, unknownCount: row.unknown, limit: edge, unknownWorstCaseLoss: row.unknown_worst }).blocked, true);
  else console.log('   (known realized P&L today exceeds the worst case; edge-limit check skipped)');
  // no stop -> still block-everything
  await client.query(`UPDATE active_setups SET stop_level = NULL WHERE id=$1`, [id]);
  assert.ok((await client.query(DLL_ROW_SQL, [trade_account, 2])).rows[0].unknown_no_stop >= 1);
  console.log('2. ok');

  // 3. repair from the raw message with a (fake) answering broker
  _resetPriceMultiplierCacheForTests();
  const live = new FakeDtc(); live.answer = true;
  const res = await repairNullFillPrices(live, { query: client.query.bind(client) });
  const after = (await client.query(`SELECT avg_fill_price::float AS p FROM order_placements WHERE setup_id=$1 AND purpose='ENTRY'`, [id])).rows[0].p;
  console.log('3. repair', res, 'restored', after, 'original', orig);
  assert.ok(res.repaired >= 1);
  assert.equal(after, orig);
  const pnlAfter = (await client.query(`SELECT broker_pnl::float AS p FROM active_setups WHERE id=$1`, [id])).rows[0].p;
  console.log('   broker_pnl after repair', pnlAfter, 'original', origPnl);
  console.log('3. ok');

  // 4. alert: an old unpriced fill raises UNPRICED_FILL; a data-gap DLL skip raises ENTRIES_BLOCKED_BY_DATA_GAP; clean = null
  const cdb = { query: client.query.bind(client) };
  await client.query(`UPDATE order_placements SET avg_fill_price = NULL, last_update_at = now() - interval '10 minutes' WHERE setup_id=$1 AND purpose='ENTRY'`, [id]);
  const a1 = await getLiveDataAttention(cdb);
  assert.equal(a1?.kind, 'UNPRICED_FILL');
  await client.query(`UPDATE order_placements SET avg_fill_price = $2 WHERE setup_id=$1 AND purpose='ENTRY'`, [id, orig]);
  await client.query(`INSERT INTO gated_candidates (trade_date, setup_type, gate_name, gate_reason) VALUES (CURRENT_DATE,'X','SIERRA_ENTRY_SKIP','setup_id=1 daily loss limit: 1 trade(s) still without broker P&L -- cannot confirm the account is within limit')`);
  assert.equal((await getLiveDataAttention(cdb))?.kind, 'ENTRIES_BLOCKED_BY_DATA_GAP');
  await client.query(`DELETE FROM gated_candidates WHERE setup_type='X' AND gate_name='SIERRA_ENTRY_SKIP'`);
  const a3 = await getLiveDataAttention(cdb);
  assert.ok(a3 == null || a3.kind === 'UNPRICED_FILL', 'no stray data-gap alert after the skip row is gone');
  console.log('4. alerts ok');
} finally {
  await client.query('ROLLBACK');
  client.release();
}
console.log('fill-price gap checks passed');
process.exit(0);
