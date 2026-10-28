// Tests for server/services/amtTellOrders.js (Stage 2 of the live tell detector). (1) pure decision logic, (2) the exact INSERT and RESOLVE statements dry-run against the REAL schema inside a transaction that is
// ALWAYS rolled back (a committed ACTIVE row would be swept into a real simulated order), (3) the resolver/eligibility/entry-prefix wiring. Usage: node scripts/test_amt_tell_orders.mjs
import assert from 'node:assert/strict';
import { decideEntry, decideExit, buildInsert, RESOLVE_SQL, AMT_TELL_ORDERS } from '../server/services/amtTellOrders.js';
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
ok('two bars behind is stale', () => assert.equal(decideEntry(tell(), { nBars: 102, busy: false, lastClose: 29851 }).state, 'SKIPPED_STALE'));
ok('unknown bar count is stale (fail closed)', () => assert.equal(decideEntry(tell(), { nBars: null, busy: false, lastClose: 29851 }).state, 'SKIPPED_STALE'));
ok('already-closed tell is never entered after the fact', () => assert.equal(decideEntry(tell({ status: 'CLOSED' }), { nBars: 100, busy: false, lastClose: 29851 }).state, 'SKIPPED_STALE'));
ok('busy blocks (one position at a time)', () => assert.equal(decideEntry(tell(), { nBars: 100, busy: true, lastClose: 29851 }).state, 'SKIPPED_BUSY'));
ok('long with price through the stop is skipped', () => assert.equal(decideEntry(tell(), { nBars: 100, busy: false, lastClose: 29799 }).state, 'SKIPPED_PRICE'));
ok('short with price through the stop is skipped', () => assert.equal(decideEntry(tell({ direction: -1, stop_price: 29900, entry_price: 29850 }), { nBars: 100, busy: false, lastClose: 29901 }).state, 'SKIPPED_PRICE'));
ok('short in the clear inserts', () => assert.equal(decideEntry(tell({ direction: -1, stop_price: 29900, entry_price: 29850 }), { nBars: 100, busy: false, lastClose: 29849 }).action, 'INSERT'));
ok('unknown price does not block', () => assert.equal(decideEntry(tell(), { nBars: 100, busy: false, lastClose: null }).action, 'INSERT'));

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
const left = (await (await getClient()).query(`SELECT count(*) FROM active_setups WHERE setup_type LIKE 'AMT\\_TELL\\_%'`)).rows[0].count;
assert.equal(String(left), '0'); console.log(`all ${n} checks passed; no AMT_TELL rows left in active_setups`);
process.exit(0);
