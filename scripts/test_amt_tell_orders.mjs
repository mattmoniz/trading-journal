// Tests for server/services/amtTellOrders.js (Stage 2 of the live tell detector). (1) pure decision logic, (2) the exact INSERT and RESOLVE statements dry-run against the REAL schema inside a transaction that is
// ALWAYS rolled back (a committed ACTIVE row would be swept into a real simulated order), (3) the resolver/eligibility/entry-prefix wiring. Usage: node scripts/test_amt_tell_orders.mjs
import assert from 'node:assert/strict';
import { decideEntry, decideExit, buildInsert, RESOLVE_SQL, AMT_TELL_ORDERS, chooseBook, effectiveTrade, orderStateOf } from '../server/services/amtTellOrders.js';
import { getClient } from '../server/db.js';
import { computeFireTags } from '../server/services/fireTags.js';
import { wantsMarketEntry } from '../server/services/sierraChart/orderSweep.js';
import { isAmtTellSimExempt, DESIGNED_TIMEOUT_EXIT_PREFIXES } from '../server/config/setupTypes.js';
import { computeSuppressionSets } from '../server/services/setupEligibility.js';
import { resolveDirection } from '../server/config/setupTypes.js';
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };

const tell = (o = {}) => ({ status: 'OPEN', entry_idx: 100, direction: 1, stop_price: 29800, entry_price: 29850, fired_at: '2026-10-29 10:06:48', ...o });
ok('fresh open tell inserts', () => assert.deepEqual(decideEntry(tell(), { nBars: 100, busy: false, lastClose: 29851 }), { action: 'INSERT' }));
ok('one completed bar behind still inserts', () => assert.equal(decideEntry(tell(), { nBars: 101, busy: false, lastClose: 29851 }).action, 'INSERT'));
// day-state gate (2026-11-09): LONG only, only while the RTH day state is a known liquidation; always LAST so SKIPPED_LIQ marks only tells that would otherwise be ordered
const LIQ = { known: true, liquidation: true, state: 'DOWN_EARLY', since: '2026-11-05 09:36' }, CALM = { known: true, liquidation: false, state: 'NORMAL' };
ok('gate: long tell during a liquidation is skipped as SKIPPED_LIQ', () => assert.deepEqual(decideEntry(tell(), { nBars: 100, busy: false, lastClose: 29851, dayGate: LIQ }), { action: 'SKIP', state: 'SKIPPED_LIQ' }));
ok('gate: SKIPPED_LIQ fits order_state VARCHAR(16)', () => assert.ok('SKIPPED_LIQ'.length <= 16));
ok('gate: a calm day does not gate', () => assert.equal(decideEntry(tell(), { nBars: 100, busy: false, lastClose: 29851, dayGate: CALM }).action, 'INSERT'));
ok('gate: unknown / stale / warm-up state fails open', () => { for (const g of [null, undefined, { known: false, liquidation: true }]) assert.equal(decideEntry(tell(), { nBars: 100, busy: false, lastClose: 29851, dayGate: g }).action, 'INSERT'); });
ok('gate: a SHORT tell is never gated', () => assert.equal(decideEntry(tell({ direction: -1, stop_price: 29900 }), { nBars: 100, busy: false, lastClose: 29851, dayGate: LIQ }).action, 'INSERT'));
ok('gate: other skip reasons keep precedence (stale beats liquidation)', () => assert.equal(decideEntry(tell(), { nBars: 102, busy: false, lastClose: 29851, dayGate: LIQ }).state, 'SKIPPED_STALE'));
ok('gate: busy beats liquidation', () => assert.equal(decideEntry(tell(), { nBars: 100, busy: true, lastClose: 29851, dayGate: LIQ }).state, 'SKIPPED_BUSY'));
ok('gate: enabled in config', () => assert.equal(AMT_TELL_ORDERS.dayStateGate.enabled, true));
ok('two bars behind is stale', () => assert.equal(decideEntry(tell(), { nBars: 102, busy: false, lastClose: 29851 }).state, 'SKIPPED_STALE'));
ok('unknown bar count is stale (fail closed)', () => assert.equal(decideEntry(tell(), { nBars: null, busy: false, lastClose: 29851 }).state, 'SKIPPED_STALE'));
ok('already-closed tell is never entered after the fact', () => assert.equal(decideEntry(tell({ status: 'CLOSED' }), { nBars: 100, busy: false, lastClose: 29851 }).state, 'SKIPPED_STALE'));
ok('busy blocks (one position at a time)', () => assert.equal(decideEntry(tell(), { nBars: 100, busy: true, lastClose: 29851 }).state, 'SKIPPED_BUSY'));
ok('long with price through the stop is skipped', () => assert.equal(decideEntry(tell(), { nBars: 100, busy: false, lastClose: 29799 }).state, 'SKIPPED_PRICE'));
ok('short with price through the stop is skipped', () => assert.equal(decideEntry(tell({ direction: -1, stop_price: 29900, entry_price: 29850 }), { nBars: 100, busy: false, lastClose: 29901 }).state, 'SKIPPED_PRICE'));
ok('short in the clear inserts', () => assert.equal(decideEntry(tell({ direction: -1, stop_price: 29900, entry_price: 29850 }), { nBars: 100, busy: false, lastClose: 29849 }).action, 'INSERT'));
ok('unknown price does not block', () => assert.equal(decideEntry(tell(), { nBars: 100, busy: false, lastClose: null }).action, 'INSERT'));


// ---- override (docs/TELL_OVERRIDE_LIVE_DESIGN_20261103.md): chooseBook / effectiveTrade / the flipped order's exit
const OV = { enabled: true, flip: true, edgeStop: false, waitMs: 20000, maxFlipsPerDay: 2 };
const info0 = { nBars: 100, ageMs: 3000, flipsToday: 0, parityBad: false };
const shRow = (o = {}) => ({ direction: 1, stop_price: 29780, entry_price: 29851, status: 'OPEN', followed_a: false, ...o });
const shortTell = () => tell({ direction: -1, stop_price: 29900, entry_price: 29850 });
ok('override: AGAINST flips to book C with its own direction, stop and entry', () => { const c = chooseBook(shortTell(), { label: 'AGAINST', B: null, C: shRow() }, info0, OV); assert.equal(c.book, 'C'); const e = effectiveTrade(shortTell(), c); assert.equal(e.direction, 1); assert.equal(e.stop_price, 29780); assert.equal(e.entry_price, 29851); });
ok('override: AGREES / NEUTRAL / UNKNOWN follow the tell', () => { for (const l of ['AGREES', 'NEUTRAL', 'UNKNOWN']) assert.equal(chooseBook(shortTell(), { label: l, B: null, C: null }, info0, OV).book, 'A'); });
ok('override: no context row yet WAITs only while the entry bar is still forming and the fire is young', () => { assert.equal(chooseBook(shortTell(), null, info0, OV).book, 'WAIT'); assert.equal(chooseBook(shortTell(), null, { ...info0, ageMs: 21000 }, OV).book, 'A'); assert.equal(chooseBook(shortTell(), null, { ...info0, nBars: 101 }, OV).book, 'A'); });
ok('override: a late AGAINST context fails to the TELL, never to a skip, and the tell is still orderable', () => { const c = chooseBook(shortTell(), { label: 'AGAINST', B: null, C: null }, { ...info0, nBars: 101 }, OV); assert.equal(c.book, 'A'); assert.equal(decideEntry(effectiveTrade(shortTell(), c), { nBars: 101, busy: false, lastClose: 29849 }).action, 'INSERT'); });
ok('override: a book that follows the tell on this fire is not an override', () => assert.equal(chooseBook(shortTell(), { label: 'AGAINST', B: null, C: shRow({ followed_a: true }) }, info0, OV).book, 'A'));
ok('override: an already-closed flip is skipped, never ordered after the fact', () => { const c = chooseBook(shortTell(), { label: 'AGAINST', B: null, C: shRow({ status: 'CLOSED' }) }, info0, OV); assert.equal(c.book, 'SKIP'); assert.equal(c.state, 'SKIPPED_BOOKDONE'); assert.ok(c.state.length <= 16); });
ok('override: the daily flip cap and a parity failure fall back to the tell', () => { const ov = { label: 'AGAINST', B: null, C: shRow() }; assert.equal(chooseBook(shortTell(), ov, { ...info0, flipsToday: 2 }, OV).book, 'A'); assert.equal(chooseBook(shortTell(), ov, { ...info0, parityBad: true }, OV).book, 'A'); });
ok('override: disabled means the pure tell', () => assert.equal(chooseBook(shortTell(), { label: 'AGAINST', B: null, C: shRow() }, info0, { ...OV, enabled: false }).book, 'A'));
ok('override: edgeStop is OFF by default and B follows only when switched on', () => { const ov = { label: 'AGREES', B: shRow({ direction: -1, stop_price: 29890 }), C: null }; assert.equal(chooseBook(shortTell(), ov, info0, OV).book, 'A'); const c = chooseBook(shortTell(), ov, info0, { ...OV, edgeStop: true }); assert.equal(c.book, 'B'); assert.equal(effectiveTrade(shortTell(), c).direction, -1); });
ok('override: the flipped order is a LONG setup built from the effective trade', () => { const c = chooseBook(shortTell(), { label: 'AGAINST', B: null, C: shRow() }, info0, OV); const b = buildInsert(effectiveTrade(shortTell(), c), null); assert.equal(b.setupType, 'AMT_TELL_LONG'); assert.equal(b.params[5], 29780); });
ok('override: order_state records the book', () => { assert.equal(orderStateOf('A'), 'LINKED'); assert.equal(orderStateOf('C'), 'LINKED_C'); assert.equal(orderStateOf('B'), 'LINKED_B'); assert.ok(orderStateOf('C').length <= 16); });
ok('override: a flipped exit is signed by the SHADOW row direction (not the tell row)', () => {
  const d = decideExit({ exit_reason: 'TIMEOUT', net_dollars: 227.5, exit_points: 118, entry_price: 28300, direction: 1 }, { entryFilled: true, avgFill: 28300.25, stopFilled: false });
  assert.equal(d.resolution, 'TIME_EXPIRED'); assert.equal(d.method, 'TELL_TIMEOUT'); assert.ok(d.pnl > 200, 'a long that gained 118 points is a gain, not a loss: ' + d.pnl); });

const ctx0 = { nBars: 100, busy: false, lastClose: 29851, armed: true };
ok('window: 09:59 signal is outside', () => assert.equal(decideEntry(tell({ fired_at: '2026-10-29 09:59:59' }), ctx0).state, 'SKIPPED_WINDOW'));
ok('window: 10:00:00 and 14:30:00 signals are inside', () => { for (const f of ['2026-10-29 10:00:00', '2026-10-29 14:30:00']) assert.equal(decideEntry(tell({ fired_at: f }), ctx0).action, 'INSERT'); });
ok('window: 14:31 signal is outside', () => assert.equal(decideEntry(tell({ fired_at: '2026-10-29 14:31:00' }), ctx0).state, 'SKIPPED_WINDOW'));
ok('globex-hour signal is outside', () => assert.equal(decideEntry(tell({ fired_at: '2026-10-29 03:12:00' }), ctx0).state, 'SKIPPED_WINDOW'));
ok('disarmed kill switch: no row', () => assert.equal(decideEntry(tell(), { ...ctx0, armed: false }).state, 'SKIPPED_DISARMED'));
const closed = (reason, net = -52) => ({ exit_reason: reason, net_dollars: net, entry_price: 29850.5, exit_points: 15, direction: 1 });
ok('pnl uses the REAL entry fill (long: filled 1.5 pt worse than the simulated entry)', () => assert.equal(decideExit(closed('FADE', 28), { entryFilled: true, stopFilled: false, avgFill: 29852 }).pnl, 25));
ok('pnl uses the REAL entry fill (short)', () => assert.equal(decideExit({ exit_reason: 'FADE', net_dollars: 28, entry_price: 29850.5, exit_points: 15, direction: -1 }, { entryFilled: true, stopFilled: false, avgFill: 29849 }).pnl, 25));
ok('pnl falls back to the detector net without a fill price', () => assert.equal(decideExit(closed('FADE', 28), { entryFilled: true, stopFilled: false, avgFill: null }).pnl, 28));
ok('exit: entry never filled -> NOT_FILLED, no pnl', () => assert.deepEqual(decideExit(closed('FADE', 152), { entryFilled: false, stopFilled: false, avgFill: null }), { resolution: 'NOT_FILLED', method: 'TELL_NO_FILL', pnl: null }));
ok('exit: FADE', () => assert.deepEqual(decideExit(closed('FADE', 152), { entryFilled: true, stopFilled: false, avgFill: null }), { resolution: 'TIME_EXPIRED', method: 'TELL_FADE', pnl: 152 }));
ok('exit: TIMEOUT', () => assert.equal(decideExit(closed('TIMEOUT'), { entryFilled: true, stopFilled: false }).method, 'TELL_TIMEOUT'));
ok('exit: EOD and EOS', () => { for (const r of ['EOD', 'EOS']) assert.equal(decideExit(closed(r), { entryFilled: true, stopFilled: false }).method, 'TELL_EOD'); });
ok('exit: STOP and STOP_GAP', () => { for (const r of ['STOP', 'STOP_GAP']) assert.deepEqual(decideExit(closed(r), { entryFilled: true, stopFilled: false }).resolution, 'STOP_HIT'); });
ok('exit: broker stop filled overrides a FADE', () => assert.equal(decideExit(closed('FADE', 152), { entryFilled: true, stopFilled: true }).resolution, 'STOP_HIT'));
ok('no method is MARK_TO_MARKET and all fit VARCHAR(20)', () => { for (const r of ['STOP', 'STOP_GAP', 'FADE', 'TIMEOUT', 'EOD', 'EOS']) { const d = decideExit(closed(r), { entryFilled: true, stopFilled: false }); assert.ok(d.method.length <= 20 && d.resolution.length <= 20); assert.ok(!/MARK_TO_MARKET|RECOVERY_MTM/.test(d.method + d.resolution)); } });

ok('wiring: AMT_TELL_ is a market-entry family', () => { assert.equal(wantsMarketEntry({ setup_type: 'AMT_TELL_LONG' }), true); assert.equal(wantsMarketEntry({ setup_type: 'AMT_TELL_SHORT' }), true); });
ok('wiring: designed-timeout prefix present', () => assert.ok(DESIGNED_TIMEOUT_EXIT_PREFIXES.includes('AMT_TELL_')));
ok('wiring: direction resolves from the name', () => { assert.equal(resolveDirection({ setup_type: 'AMT_TELL_LONG', entry_zone_low: 100, stop_level: 90, t1_level: 5100 }), 'LONG'); assert.equal(resolveDirection({ setup_type: 'AMT_TELL_SHORT', entry_zone_low: 100, stop_level: 110, t1_level: -4900 }), 'SHORT'); });
ok('wiring: OCO bracket flag is off', () => assert.notEqual(process.env.SIERRA_USE_OCO_BRACKET, 'true'));
ok('enabled flag is a deliberate boolean', () => assert.equal(typeof AMT_TELL_ORDERS.enabled, 'boolean'));

// sim-only exemption follows the profile flag
const saved = process.env.DTC_AUTO_REARM_SAFE;
process.env.DTC_AUTO_REARM_SAFE = 'true'; ok('exempt on a simulation-safe profile', () => assert.equal(isAmtTellSimExempt('AMT_TELL_LONG'), true));
process.env.DTC_AUTO_REARM_SAFE = 'false'; ok('NOT exempt on any other profile', () => assert.equal(isAmtTellSimExempt('AMT_TELL_LONG'), false));
ok('other setup types are never exempt', () => { process.env.DTC_AUTO_REARM_SAFE = 'true'; assert.equal(isAmtTellSimExempt('PD_VAH_FADE_SHORT'), false); });
process.env.DTC_AUTO_REARM_SAFE = 'true';
const sets = await computeSuppressionSets(1);
n++; assert.ok(!sets.suppressedSetups.has('AMT_TELL_LONG') && !sets.rosterBlocked.has('AMT_TELL_LONG') && !sets.dowSuppressToday.has('AMT_TELL_SHORT')); console.log('ok suppression sets never contain AMT_TELL_*');
process.env.DTC_AUTO_REARM_SAFE = saved;

// real-schema dry run, always rolled back
const countAmt = async () => String((await (await getClient()).query(`SELECT count(*) FROM active_setups WHERE setup_type LIKE 'AMT\\_TELL\\_%'`)).rows[0].count);
const amtBefore = await countAmt();
const client = await getClient();
try {
  await client.query('BEGIN');
  const t = { trade_date: '2026-10-29', direction: 1, entry_at: '2026-10-29 10:06:49', entry_price: 29850.5, stop_price: 29840.5, entry_idx: 3, status: 'OPEN' };
  const tags = await computeFireTags(t.trade_date, 'RTH', 606);
  const b = buildInsert(t, tags); const ins = await client.query(b.sql, b.params);
  assert.equal(ins.rows.length, 1); const id = ins.rows[0].id;
  const row = (await client.query(`SELECT setup_type, status, origin_status, is_rth, stop_level::float, t1_level::float, entry_zone_low::float, expires_at::text, bet_class, is_cluster_primary FROM active_setups WHERE id=$1`, [id])).rows[0];
  assert.equal(row.setup_type, 'AMT_TELL_LONG'); assert.equal(row.status, 'ACTIVE'); assert.equal(row.origin_status, 'ACTIVE'); assert.equal(row.is_rth, true); assert.equal(row.stop_level, 29840.5); assert.equal(row.t1_level, 34850.5);
  assert.equal(row.expires_at, '2026-10-29 15:57:00'); assert.equal(row.is_cluster_primary, true);
  const again = await client.query(b.sql, b.params); assert.equal(again.rows.length, 0);   // the touch-instant dedup makes a repeat a no-op
  const r1 = await client.query(RESOLVE_SQL, [id, 'TIME_EXPIRED', 'TELL_FADE', 152, 29865.5, '2026-10-29 12:54:39']); assert.equal(r1.rows.length, 1);
  const r2 = await client.query(RESOLVE_SQL, [id, 'STOP_HIT', 'TELL_STOP', -22, 29840, '2026-10-29 12:55:00']); assert.equal(r2.rows.length, 0);   // an already-resolved row is never re-resolved
  const fin = (await client.query(`SELECT status, resolution, resolution_method, actual_pnl::float FROM active_setups WHERE id=$1`, [id])).rows[0]; assert.deepEqual(fin, { status: 'RESOLVED', resolution: 'TIME_EXPIRED', resolution_method: 'TELL_FADE', actual_pnl: 152 });
  n += 3; console.log('ok real-schema dry run: insert, dedup, resolve, no double-resolve');
} finally { await client.query('ROLLBACK'); client.release(); }
// exercise every query of one service pass (entries, exits, the stuck and stale checks) against the real schema, but ONLY when it has nothing to act on (no eligible tell rows, no active tell setups): a parse/plan check, no orders possible
{ const c = await getClient(); try {
  const elig = (await c.query(`SELECT count(*)::int n FROM amt_tell_trades t JOIN amt_tell_sessions s ON s.trade_date = t.trade_date AND s.bar_rule = t.bar_rule AND s.state = 'LIVE' WHERE t.bar_rule = 'split' AND t.book = 'V1' AND t.active_setup_id IS NULL AND t.order_state IS NULL`)).rows[0].n;
  const act = (await c.query(`SELECT count(*)::int n FROM active_setups WHERE setup_type LIKE 'AMT\\_TELL\\_%' AND status = 'ACTIVE'`)).rows[0].n;
  if (elig === 0 && act === 0) { const { runAmtTellOrdersOnce, getAmtTellOrdersStatus } = await import('../server/services/amtTellOrders.js'); await runAmtTellOrdersOnce(); const st = getAmtTellOrdersStatus(); assert.ok(!/orders service error/.test(st.problem || ''), st.problem); n++; console.log('ok a full service pass runs every query against the real schema with nothing to act on'); }
  else console.log(`skipped the full-pass check: something eligible exists (entries ${elig}, active ${act})`);
} finally { c.release(); } }
const amtAfter = await countAmt();
assert.equal(amtAfter, amtBefore); console.log(`all ${n} checks passed; the dry run left no AMT_TELL rows behind (${amtBefore} before and after)`);
process.exit(0);
