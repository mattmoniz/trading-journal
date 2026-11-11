// Order-path scenario tests against a fake broker and a scratch DB schema (Fable audit 2026-11-10: F01, F02, F04, F05; preconditions in
// scratch/fable_audit_designs_20261110.md 3.3). Run: ./scripts/setup_order_path_harness.sh && node scripts/test_order_path_harness.mjs
// Every scenario ends with the protection invariant: a non-zero broker position has exactly one working stop of the same size on the
// other side (or the app flattened it and halted). See scripts/lib/fakeDtc.mjs for what the fake does and does not model.
import assert from 'node:assert/strict';
import path from 'node:path';
import { REPO, SANDBOX_DIR, assertIsolated, resetHarnessTables } from './lib/orderPathHarnessEnv.mjs';
import { FakeDtc, protectionInvariant } from './lib/fakeDtc.mjs';

const { query } = await assertIsolated();
const imp = (p) => import(path.join(REPO, p));
const rec = await imp('server/services/sierraChart/reconciliation.js');
const prot = await imp('server/services/sierraChart/protection.js');
const { KillSwitch } = await imp('server/services/sierraChart/killSwitch.js');
const { killSwitch: realSwitch } = await imp('server/services/sierraChart/orderEligibility.js'); // sandboxed path, asserted above
const sweepMod = await imp('server/services/sierraChart/orderSweep.js');
void sweepMod;

let passed = 0, failed = 0;
const failures = [];
async function scenario(name, fn) {
  await resetHarnessTables(query);
  prot._resetProtectionSweepStateForTests();
  realSwitch.arm('harness');
  const fake = new FakeDtc();
  const pending = [];
  fake.on('orderUpdate', (m) => { pending.push(rec.handleOrderUpdate(m, fake).catch((e) => console.error('  handler error:', e.message))); });
  const settle = async (ms = 60) => { for (let i = 0; i < 20; i++) { const n = pending.length; await Promise.all(pending); await new Promise((r) => setTimeout(r, ms)); if (pending.length === n) break; } };
  const t0 = Date.now();
  try { await fn({ fake, settle }); passed++; console.log(`PASS  ${name} (${Date.now() - t0} ms)`); }
  catch (e) { failed++; failures.push(name); console.log(`FAIL  ${name}\n      ${e.message.split('\n').join('\n      ')}`); }
}

// ---- helpers ---------------------------------------------------------------------------------------------------------------------
async function seedSetup({ stopLevel = 29990, entryLevel = 30000 } = {}) {
  const r = await query(`INSERT INTO active_setups (setup_type, fired_at, stop_level, entry_zone_low) VALUES ('HARNESS_TEST', now(), $1, $2) RETURNING id`, [stopLevel, entryLevel]);
  return r.rows[0].id;
}
const ACCT = { symbol: 'MNQZ26.CME', exchange: '', tradeAccount: 'TEST-ACCT', environmentService: 'harness' };
async function enterAndFill(ctx, { side = 'BUY', entryPx = 30000, stopLevel = 29990, fillPx = entryPx, fillEmit = true } = {}) {
  const id = await seedSetup({ stopLevel, entryLevel: entryPx });
  await rec.placeEntryOrder(ctx.fake, { setupId: id, entryPrice: entryPx, side, quantity: 1, ...ACCT });
  await ctx.settle();
  ctx.fake.fillWorking(`E${id}`, fillPx, fillEmit);
  await ctx.settle();
  return id;
}
const rows = async (id, purpose) => (await query(`SELECT client_order_id, status, side, quantity, price1::float AS price1, position_open, filled_quantity FROM order_placements WHERE setup_id=$1 AND purpose=$2 ORDER BY id`, [id, purpose])).rows;
const gates = async (name) => (await query(`SELECT gate_reason FROM gated_candidates WHERE gate_name=$1`, [name])).rows;
const backdate = (id, secs) => query(`UPDATE order_placements SET last_update_at = now() - make_interval(secs => $2), submitted_at = now() - make_interval(secs => $2) WHERE setup_id=$1`, [id, secs]);
const sweepOpts = () => ({ killSwitch: realSwitch, sendAlert: async () => ({}) });
const inv = (fake) => { const r = protectionInvariant(fake); assert.ok(r.ok, `invariant broken: ${r.why}`); };

// ---- pure: F02 status derivation ---------------------------------------------------------------------------------------------------
await scenario('F02 pure: the recorded 2026-11-09 cancel-reject (status 8, reason 9, filled 1, remaining 0) is FILLED', async () => {
  const msg = { OrderStatus: 8, OrderUpdateReason: 9, FilledQuantity: 1, RemainingQuantity: 0, OrderQuantity: 1, AverageFillPrice: 27950.75 };
  assert.equal(rec.effectiveIncomingStatus(msg, 1), 'FILLED');
  assert.equal(rec.effectiveIncomingStatus({ ...msg, OrderStatus: 9 }, 1), 'FILLED', 'REJECTED word with a full fill');
  assert.equal(rec.effectiveIncomingStatus({ ...msg, RemainingQuantity: 1e308 }, 1), 'FILLED', 'remaining unset, filled >= ordered');
  assert.equal(rec.effectiveIncomingStatus({ ...msg, FilledQuantity: 1, RemainingQuantity: 2, OrderQuantity: 3 }, 3), 'CANCELED', 'partial fill then cancel keeps its word');
  assert.equal(rec.effectiveIncomingStatus({ OrderStatus: 8, FilledQuantity: 0, RemainingQuantity: 1, OrderQuantity: 1 }, 1), 'CANCELED', 'plain cancel');
  assert.equal(rec.effectiveIncomingStatus({ OrderStatus: 8, FilledQuantity: 1e308, RemainingQuantity: 1e308 }, 1), 'CANCELED', 'sentinel quantities are not fills');
  assert.equal(rec.effectiveIncomingStatus({ OrderStatus: 4 }, 1), 'OPEN');
  assert.equal(rec.effectiveIncomingStatus({ OrderStatus: 99 }, 1), null);
});

await scenario('pure: classifyProtection, resolveStopPrice, nextStopClientOrderId', async () => {
  const e = { filled_quantity: 1, position_open: true };
  assert.equal(prot.classifyProtection({ entry: e, stops: [], exits: [], targets: [] }), 'UNPROTECTED');
  assert.equal(prot.classifyProtection({ entry: e, stops: [{ status: 'OPEN' }], exits: [], targets: [] }), 'PROTECTED');
  assert.equal(prot.classifyProtection({ entry: e, stops: [{ status: 'CANCELED' }], exits: [], targets: [] }), 'UNPROTECTED');
  assert.equal(prot.classifyProtection({ entry: e, stops: [{ status: 'CANCELED' }], exits: [{ status: 'SUBMITTED' }], targets: [] }), 'EXITING');
  assert.equal(prot.classifyProtection({ entry: e, stops: [{ status: 'CANCELED' }], exits: [{ status: 'REJECTED' }], targets: [] }), 'UNPROTECTED');
  assert.equal(prot.classifyProtection({ entry: e, stops: [{ status: 'FILLED' }], exits: [], targets: [] }), 'CLOSED');
  assert.equal(prot.classifyProtection({ entry: { ...e, position_open: false }, stops: [], exits: [], targets: [] }), 'NOT_OPEN');
  assert.equal(prot.classifyProtection({ entry: { ...e, filled_quantity: 0 }, stops: [], exits: [], targets: [] }), 'NOT_OPEN');
  assert.deepEqual(prot.resolveStopPrice({ entrySide: 'BUY', stopLevel: 29990, entryLevel: 30000, fillPx: 30000 }), { stopPrice: 29990, adjusted: false });
  const adj = prot.resolveStopPrice({ entrySide: 'BUY', stopLevel: 29990, entryLevel: 30000, fillPx: 29985 });
  assert.equal(adj.stopPrice, 29975); assert.equal(adj.adjusted, true);
  const adjS = prot.resolveStopPrice({ entrySide: 'SELL', stopLevel: 30010, entryLevel: 30000, fillPx: 30015 });
  assert.equal(adjS.stopPrice, 30025);
  assert.equal(prot.resolveStopPrice({ entrySide: 'BUY', stopLevel: null }).stopPrice, null);
  assert.equal(prot.nextStopClientOrderId(7, []), 'S7'); assert.equal(prot.nextStopClientOrderId(7, [{}]), 'S7R1'); assert.equal(prot.nextStopClientOrderId(7, [{}, {}]), 'S7R2');
});

// ---- baseline: the normal path must be unchanged -----------------------------------------------------------------------------------
await scenario('normal LIMIT fill places exactly one STOP at the planned level (regression: unchanged behaviour)', async (ctx) => {
  const id = await enterAndFill(ctx);
  const stops = await rows(id, 'STOP');
  assert.equal(stops.length, 1); assert.equal(stops[0].client_order_id, `S${id}`); assert.equal(stops[0].side, 'SELL'); assert.equal(stops[0].price1, 29990); assert.equal(stops[0].quantity, 1);
  assert.equal((await rows(id, 'ENTRY'))[0].status, 'FILLED');
  inv(ctx.fake);
  assert.equal((await gates('SIERRA_STOP_REPLACED')).length, 0, 'a first stop is not a replacement');
});

await scenario('normal SHORT fill: stop above, gap guard keeps the risk distance when the market fill is past the planned stop', async (ctx) => {
  const id = await enterAndFill(ctx, { side: 'SELL', entryPx: 30000, stopLevel: 30010, fillPx: 30015 });
  const stops = await rows(id, 'STOP');
  assert.equal(stops[0].side, 'BUY'); assert.equal(stops[0].price1, 30025);
  assert.equal((await gates('SIERRA_STOP_ADJUSTED')).length, 1);
  inv(ctx.fake);
});

await scenario('duplicate FILLED message does not place a second stop (lattice + live-stop index)', async (ctx) => {
  const id = await enterAndFill(ctx);
  const filledMsg = { ...ctx.fake._msg({ clientOrderId: `E${id}`, serverId: '1000', side: 'BUY', typeNum: 2, quantity: 1, filled: 1, avgFill: 30000 }, 7) };
  ctx.fake.emit('orderUpdate', filledMsg); ctx.fake.emit('orderUpdate', filledMsg);
  await ctx.settle();
  assert.equal((await rows(id, 'STOP')).length, 1); assert.equal(ctx.fake.workingStops().length, 1);
  inv(ctx.fake);
});

// ---- F02: the recorded failure end to end --------------------------------------------------------------------------------------------
await scenario('F02 end to end: the 11-09 cancel-reject carrying a full fill becomes FILLED, frees nothing wrongly, and the stop is placed', async (ctx) => {
  const id = await seedSetup();
  await rec.placeEntryOrder(ctx.fake, { setupId: id, entryPrice: 30000, side: 'BUY', quantity: 1, ...ACCT });
  await ctx.settle();
  ctx.fake.fillWorking(`E${id}`, 30000, false);                    // the broker filled; the app was told only through the cancel-reject below
  const o = { clientOrderId: `E${id}`, serverId: (await rows(id, 'ENTRY')).length ? '1000' : '1000', side: 'BUY', typeNum: 2, quantity: 1, filled: 1, avgFill: 30000 };
  ctx.fake.emit('orderUpdate', ctx.fake._msg(o, 8, { OrderUpdateReason: 9, InfoText: 'Order cancellation failed | Trading Evaluator (Order cancel reject). Info: Order with ServerOrderID does not exist' }));
  await ctx.settle();
  const e = (await rows(id, 'ENTRY'))[0];
  assert.equal(e.status, 'FILLED'); assert.equal(e.filled_quantity, 1); assert.equal(e.position_open, true);
  assert.equal((await rows(id, 'STOP')).length, 1);
  inv(ctx.fake);
});

await scenario('F02 regression: a plain CANCELED entry (no fill) still releases the position slot and places no stop', async (ctx) => {
  const id = await seedSetup();
  await rec.placeEntryOrder(ctx.fake, { setupId: id, entryPrice: 30000, side: 'BUY', quantity: 1, ...ACCT });
  await ctx.settle();
  ctx.fake.cancelOrder({ serverOrderId: '1000', clientOrderId: `E${id}` });
  await ctx.settle();
  const e = (await rows(id, 'ENTRY'))[0];
  assert.equal(e.status, 'CANCELED'); assert.equal(e.position_open, false); assert.equal((await rows(id, 'STOP')).length, 0);
});

// ---- F05: stop failures --------------------------------------------------------------------------------------------------------------
await scenario('F05 submit throws twice then works: stop placed by the retry, no flatten, no halt', async (ctx) => {
  let n = 0;
  ctx.fake.behaviours.push((p) => (p.orderType === 'STOP' && n++ < 2 ? 'THROW' : undefined));
  const id = await enterAndFill(ctx);
  await ctx.settle(300);
  const stops = await rows(id, 'STOP');
  assert.equal(stops.filter((s) => s.status !== 'ERROR').length, 1, JSON.stringify(stops));
  assert.ok(realSwitch.isArmed(), 'a recovered stop must not halt');
  inv(ctx.fake);
});

await scenario('F05 stop never placeable: alarm row now; past the deadline the sweep flattens and HALTS', async (ctx) => {
  ctx.fake.behaviours.push((p) => (p.orderType === 'STOP' ? 'THROW' : undefined));
  const id = await enterAndFill(ctx);
  await ctx.settle(300);
  assert.equal((await gates('SIERRA_STOP_FAILED')).length >= 1, true, 'alarm row written');
  assert.ok(realSwitch.isArmed(), 'inside the deadline the kill switch is not touched');
  assert.equal(ctx.fake.position, 1);
  await backdate(id, 120);                                            // the position has now been unprotected for 2 minutes
  const r = await prot.runProtectionSweep(ctx.fake, sweepOpts());
  await ctx.settle(300);
  assert.equal(realSwitch.isArmed(), false, 'kill switch halted'); assert.match(realSwitch.getState().haltedReason, /unprotected position/);
  assert.equal(ctx.fake.position, 0, `flattened: ${JSON.stringify(r)}`);
  assert.equal((await gates('SIERRA_UNPROTECTED_FLATTEN')).length >= 1, true);
  inv(ctx.fake);
});

await scenario('F05 filled entry with no stop level: flatten + halt immediately, alarm row', async (ctx) => {
  const id = await seedSetup({ stopLevel: null });
  await rec.placeEntryOrder(ctx.fake, { setupId: id, entryPrice: 30000, side: 'BUY', quantity: 1, ...ACCT });
  await ctx.settle();
  ctx.fake.fillWorking(`E${id}`, 30000, true);
  await ctx.settle(300);
  assert.equal(realSwitch.isArmed(), false); assert.equal(ctx.fake.position, 0);
  assert.equal((await gates('SIERRA_UNPROTECTED_FLATTEN')).length >= 1, true);
});

await scenario('F05 broker rejects the stop asynchronously: the sweep re-places it (S<id>R1) and the invariant holds', async (ctx) => {
  ctx.fake.rejectNext.push((p) => (p.orderType === 'STOP' ? 'REJECT' : undefined));
  const id = await enterAndFill(ctx);
  await ctx.settle(300);
  assert.equal((await rows(id, 'STOP'))[0].status, 'REJECTED'); assert.equal(ctx.fake.workingStops().length, 0);
  await backdate(id, 30);
  await prot.runProtectionSweep(ctx.fake, sweepOpts()); await ctx.settle(300);
  const stops = await rows(id, 'STOP');
  assert.deepEqual(stops.map((s) => s.client_order_id), [`S${id}`, `S${id}R1`]);
  inv(ctx.fake);
});

// ---- F04: rejected exit ----------------------------------------------------------------------------------------------------------------
await scenario('F04 exit rejected after the stop was cancelled: the stop is back at once, verified against the broker', async (ctx) => {
  const id = await enterAndFill(ctx);
  ctx.fake.rejectNext.push((p) => (p.orderType === 'MARKET' ? 'REJECT' : undefined));
  const out = await rec.placeExitOrder(ctx.fake, { setupId: id, ...ACCT });
  assert.equal(out.action, 'FLATTENED');
  await ctx.settle(300);
  const exit = (await rows(id, 'EXIT'))[0];
  assert.equal(exit.status, 'REJECTED');
  const stops = await rows(id, 'STOP');
  assert.equal(stops.length, 2, JSON.stringify(stops)); assert.equal(stops[0].status, 'CANCELED'); assert.equal(stops[1].client_order_id, `S${id}R1`);
  assert.equal(ctx.fake.position, 1, 'still long: the exit never executed');
  inv(ctx.fake);
  assert.equal((await gates('SIERRA_STOP_REPLACED')).length >= 1, true);
});

await scenario('F04 regression: an accepted exit flattens, leaves no stop, frees the slot, and the sweep then does nothing', async (ctx) => {
  const id = await enterAndFill(ctx);
  const out = await rec.placeExitOrder(ctx.fake, { setupId: id, ...ACCT });
  assert.equal(out.action, 'FLATTENED'); await ctx.settle(300);
  assert.equal(ctx.fake.position, 0); assert.equal((await rows(id, 'EXIT'))[0].status, 'FILLED');
  assert.equal((await rows(id, 'ENTRY'))[0].position_open, false);
  assert.equal((await rows(id, 'STOP')).length, 1, 'no replacement stop after a good exit');
  const r = await prot.runProtectionSweep(ctx.fake, sweepOpts());
  assert.equal(r.checked, 0); inv(ctx.fake);
});

// ---- F01: the protection sweep ---------------------------------------------------------------------------------------------------------
await scenario('F01 stop silently lost at the broker: the sweep notices (open-orders check), marks it CANCELED, places a replacement', async (ctx) => {
  const id = await enterAndFill(ctx);
  ctx.fake.vanish(`S${id}`);
  assert.equal(ctx.fake.workingStops().length, 0);
  await backdate(id, 30);
  const r = await prot.runProtectionSweep(ctx.fake, sweepOpts()); await ctx.settle(300);
  const stops = await rows(id, 'STOP');
  assert.equal(stops[0].status, 'CANCELED'); assert.equal(stops.length, 2, `${JSON.stringify(r)} ${JSON.stringify(stops)}`);
  assert.equal((await gates('SIERRA_STOP_LOST')).length, 1);
  inv(ctx.fake);
});

await scenario('F01 healthy position: the sweep verifies (one open-orders read) and changes nothing; then is rate limited', async (ctx) => {
  const id = await enterAndFill(ctx);
  await backdate(id, 30);
  const before = ctx.fake.sent.length;
  const r1 = await prot.runProtectionSweep(ctx.fake, sweepOpts()); await ctx.settle(300);
  assert.equal(ctx.fake.sent.length, before, 'no order sent'); assert.deepEqual(r1.results.map((x) => x.action), ['NOOP:PROTECTED']);
  const reads = ctx.fake.requestsOpenOrders;
  await prot.runProtectionSweep(ctx.fake, sweepOpts()); await ctx.settle(100);
  assert.equal(ctx.fake.requestsOpenOrders, reads, 'second sweep inside 60 s does not ask the broker again');
  inv(ctx.fake);
});

await scenario('F01 nothing open: the sweep touches neither the broker nor any order', async (ctx) => {
  const r = await prot.runProtectionSweep(ctx.fake, sweepOpts());
  assert.equal(r.checked, 0); assert.equal(ctx.fake.requestsOpenOrders + ctx.fake.requestsPositions + ctx.fake.sent.length, 0);
});

await scenario('F01 not connected: the sweep does nothing', async (ctx) => {
  const id = await enterAndFill(ctx); await backdate(id, 30); ctx.fake.setLive(false);
  const r = await prot.runProtectionSweep(ctx.fake, sweepOpts());
  assert.equal(r.skipped, 'not live');
});

await scenario('F01 fresh fill is left to the fill handler (inside the grace period the sweep does not act)', async (ctx) => {
  ctx.fake.behaviours.push((p) => (p.orderType === 'STOP' ? 'THROW' : undefined));
  await enterAndFill(ctx); await ctx.settle(300);
  const sent = ctx.fake.sent.length;
  const r = await prot.runProtectionSweep(ctx.fake, sweepOpts());
  assert.equal(r.checked, 0); assert.equal(ctx.fake.sent.length, sent);
});

await scenario('F01 broker is flat while the app believes it is open and unprotected: NO stop is placed (it would be a naked order), alarm row', async (ctx) => {
  const id = await enterAndFill(ctx);
  await query(`UPDATE order_placements SET status='CANCELED' WHERE setup_id=$1 AND purpose='STOP'`, [id]);
  ctx.fake.vanish(`S${id}`); ctx.fake.setPosition(0);                   // the position was closed outside the app
  await backdate(id, 30);
  const sent = ctx.fake.sent.length;
  const r = await prot.runProtectionSweep(ctx.fake, sweepOpts());
  assert.equal(r.results[0].action, 'BROKER_FLAT'); assert.equal(ctx.fake.sent.length, sent);
  assert.equal((await gates('SIERRA_UNPROTECTED_BROKER_FLAT')).length, 1); assert.equal(ctx.fake.workingStops().length, 0);
});

await scenario('F01 broker position unreadable (connection lost mid-read): no blind stop; flatten only past the deadline and only if readable', async (ctx) => {
  const id = await enterAndFill(ctx);
  await query(`UPDATE order_placements SET status='CANCELED' WHERE setup_id=$1 AND purpose='STOP'`, [id]); ctx.fake.vanish(`S${id}`);
  await backdate(id, 30);
  ctx.fake.requestCurrentPositions = () => { throw new Error('fake: not logged on'); };
  const sent = ctx.fake.sent.length;
  const r = await prot.runProtectionSweep(ctx.fake, sweepOpts());
  assert.equal(r.results[0].action, 'BROKER_UNKNOWN'); assert.equal(ctx.fake.sent.length, sent);
  assert.ok(realSwitch.isArmed());
});

await scenario('F01 two callers race to repair the same position: exactly one live stop results', async (ctx) => {
  const id = await enterAndFill(ctx);
  await query(`UPDATE order_placements SET status='CANCELED' WHERE setup_id=$1 AND purpose='STOP'`, [id]); ctx.fake.vanish(`S${id}`);
  await backdate(id, 30);
  const o = { killSwitch: realSwitch, sendAlert: async () => ({}) };
  const res = await Promise.all([prot.ensureProtected(ctx.fake, id, { ...o, reason: 'a' }), prot.ensureProtected(ctx.fake, id, { ...o, reason: 'b' })]);
  await ctx.settle(300);
  const live = (await rows(id, 'STOP')).filter((x) => !['CANCELED', 'REJECTED', 'ERROR'].includes(x.status));
  assert.equal(live.length, 1, JSON.stringify({ res, stops: await rows(id, 'STOP') }));
  inv(ctx.fake);
});

await scenario('known limit (documented): a fill the app never heard about is NOT repaired by the sweep (needs historical-fill replay); it is only visible as a broker/app mismatch', async (ctx) => {
  const id = await seedSetup();
  await rec.placeEntryOrder(ctx.fake, { setupId: id, entryPrice: 30000, side: 'BUY', quantity: 1, ...ACCT });
  await ctx.settle();
  ctx.fake.fillWorking(`E${id}`, 30000, false);                         // fill message dropped
  await backdate(id, 120);
  await prot.runProtectionSweep(ctx.fake, sweepOpts()); await ctx.settle(300);
  assert.equal((await rows(id, 'STOP')).length, 0, 'the sweep cannot attribute a position it has no fill record for (hr-066)');
  assert.equal(ctx.fake.position, 1);
});

console.log(`\n${passed} passed, ${failed} failed${failed ? ': ' + failures.join('; ') : ''}`);
process.exit(failed ? 1 : 0);
