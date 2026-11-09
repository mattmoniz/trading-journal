// Tests for server/services/vacuumLiveOrders.js (Sim1 wiring of the user's original expansion rule, 2026-11-09). (1) pure decision/exit logic, (2) the exact INSERT and RESOLVE statements dry-run against the REAL schema inside a
// transaction ALWAYS rolled back (a committed ACTIVE row would be swept into a real simulated order), (3) the registry/resolver/eligibility/entry-prefix wiring. Usage: node scripts/test_vacuum_live_orders.mjs
import assert from 'node:assert/strict';
import { decideEntry, decideExit, buildInsert, expiresAtOf, stopOf, RESOLVE_SQL, VACUUM_EXP_ORDERS } from '../server/services/vacuumLiveOrders.js';
import { getClient } from '../server/db.js';
import { computeFireTags } from '../server/services/fireTags.js';
import { wantsMarketEntry } from '../server/services/sierraChart/orderSweep.js';
import { isAmtTellSimExempt, DESIGNED_TIMEOUT_EXIT_PREFIXES, resolveDirection, isVacuumExpType } from '../server/config/setupTypes.js';
import { computeSuppressionSets } from '../server/services/setupEligibility.js';
import { getEarlyCloseMinute } from '../server/services/marketCalendar.js';
import fs from 'node:fs';
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };

const ev = (o = {}) => ({ id: 1, trade_date: '2026-11-09', track: 'GBX', direction: 1, taken: true, fired_at: '2026-11-09 03:00:04', signal_close: 27000, entry_open: 27001, etr: 10, outcome_at: null, ...o });
const c0 = { ageSec: 20, busy: false, lastClose: 27001, armed: true };
ok('stop: long = close - 2.5 x etr', () => assert.equal(stopOf(ev()), 26975));
ok('stop: short = close + 2.5 x etr', () => assert.equal(stopOf(ev({ direction: -1 })), 27025));
ok('fresh taken event inserts', () => assert.deepEqual(decideEntry(ev(), c0), { action: 'INSERT' }));
ok('RTH track inserts', () => assert.equal(decideEntry(ev({ track: 'RTH' }), c0).action, 'INSERT'));
ok('not taken is never ordered', () => assert.equal(decideEntry(ev({ taken: false }), c0).state, 'SKIPPED_NOTTAKEN'));
ok('older than maxAgeSec is stale (restart replay)', () => assert.equal(decideEntry(ev(), { ...c0, ageSec: VACUUM_EXP_ORDERS.maxAgeSec + 1 }).state, 'SKIPPED_STALE'));
ok('unknown age is stale (fail closed)', () => assert.equal(decideEntry(ev(), { ...c0, ageSec: null }).state, 'SKIPPED_STALE'));
ok('already finished event is never entered after the fact', () => assert.equal(decideEntry(ev({ outcome_at: '2026-11-09 04:00:00' }), c0).state, 'SKIPPED_STALE'));
ok('busy blocks', () => assert.equal(decideEntry(ev(), { ...c0, busy: true }).state, 'SKIPPED_BUSY'));
ok('disarmed kill switch: no row', () => assert.equal(decideEntry(ev(), { ...c0, armed: false }).state, 'SKIPPED_DISARMED'));
ok('long with price through the stop is skipped', () => assert.equal(decideEntry(ev(), { ...c0, lastClose: 26975 }).state, 'SKIPPED_PRICE'));
ok('short with price through the stop is skipped', () => assert.equal(decideEntry(ev({ direction: -1 }), { ...c0, lastClose: 27025 }).state, 'SKIPPED_PRICE'));
ok('unknown price does not block', () => assert.equal(decideEntry(ev(), { ...c0, lastClose: null }).action, 'INSERT'));
ok('missing etr is rejected (no stop, no order)', () => assert.equal(decideEntry(ev({ etr: null }), c0).state, 'SKIPPED_NOSTOP'));
ok('a disabled track is skipped', () => assert.equal(decideEntry(ev(), c0, { ...VACUUM_EXP_ORDERS, tracks: { GBX: false, RTH: true } }).state, 'SKIPPED_TRACK'));

ok('hard flat: Globex 09:29:50', () => assert.equal(expiresAtOf(ev()), '2026-11-09 09:29:50'));
ok('hard flat: RTH 15:55', () => assert.equal(expiresAtOf(ev({ track: 'RTH' })), '2026-11-09 15:55:00'));
const early = ['2026-11-27', '2026-12-24', '2026-07-03'].find((d) => getEarlyCloseMinute(d) != null);
ok('hard flat: RTH early close 13:10 (' + early + ')', () => { assert.ok(early, 'an early-close date exists in the calendar'); assert.equal(expiresAtOf(ev({ track: 'RTH', trade_date: early })), `${early} 13:10:00`); });

const done = (o = {}) => ({ direction: 1, entry_open: 27001, fwd30: 12, net_nostop: 10, net_stop25: 10, exit_note: 'hold', ...o });
ok('exit: entry never filled -> NOT_FILLED, no pnl', () => assert.deepEqual(decideExit(done(), { entryFilled: false }), { resolution: 'NOT_FILLED', method: 'VAC_NO_FILL', pnl: null, exitPx: null }));
ok('exit: hold -> TIME_EXPIRED/VAC_HOLD30, pnl from the REAL fill (long filled 1 pt worse)', () => { const d = decideExit(done(), { entryFilled: true, avgFill: 27002 }); assert.equal(d.resolution, 'TIME_EXPIRED'); assert.equal(d.method, 'VAC_HOLD30'); assert.equal(d.exitPx, 27013); assert.equal(d.pnl, (27013 - 27002) * 2 - 2); });
ok('exit: short pnl sign', () => { const d = decideExit(done({ direction: -1, fwd30: 12 }), { entryFilled: true, avgFill: 27000 }); assert.equal(d.exitPx, 26989); assert.equal(d.pnl, (27000 - 26989) * 2 - 2); });
ok('exit: flat-clamped method', () => assert.equal(decideExit(done({ exit_note: 'flat-clamped' }), { entryFilled: true, avgFill: 27001 }).method, 'VAC_FLAT'));
ok('exit: +stop note -> STOP_HIT at the detector stop price', () => { const d = decideExit(done({ exit_note: 'hold+stop', net_stop25: -27, fwd30: 8 }), { entryFilled: true, avgFill: 27001 }); assert.equal(d.resolution, 'STOP_HIT'); assert.equal(d.method, 'VAC_STOP'); assert.equal(d.exitPx, 26976); });
ok('exit: broker stop filled overrides a hold', () => assert.equal(decideExit(done(), { entryFilled: true, avgFill: 27001, stopFilled: true }).resolution, 'STOP_HIT'));
ok('exit: no fill price falls back to the detector net in dollars', () => assert.equal(decideExit(done(), { entryFilled: true, avgFill: null }).pnl, 20));
ok('no method is MARK_TO_MARKET and all fit VARCHAR(20)', () => { for (const note of ['hold', 'flat-clamped', 'hold+stop', 'flat-clamped+stop']) for (const f of [true, false]) { const d = decideExit(done({ exit_note: note }), { entryFilled: f, avgFill: 27001 }); assert.ok(d.method.length <= 20 && d.resolution.length <= 20); assert.ok(!/MARK_TO_MARKET|RECOVERY_MTM/.test(d.method)); } });

ok('wiring: VACUUM_EXP_ is a market-entry family', () => { assert.equal(wantsMarketEntry({ setup_type: 'VACUUM_EXP_LONG' }), true); assert.equal(wantsMarketEntry({ setup_type: 'VACUUM_EXP_SHORT' }), true); });
ok('wiring: designed-timeout prefix present', () => assert.ok(DESIGNED_TIMEOUT_EXIT_PREFIXES.includes('VACUUM_EXP_')));
ok('wiring: direction resolves from the name', () => { assert.equal(resolveDirection({ setup_type: 'VACUUM_EXP_LONG', entry_zone_low: 100, stop_level: 90, t1_level: 5100 }), 'LONG'); assert.equal(resolveDirection({ setup_type: 'VACUUM_EXP_SHORT', entry_zone_low: 100, stop_level: 110, t1_level: -4900 }), 'SHORT'); });
ok('wiring: OCO bracket flag is off', () => assert.notEqual(process.env.SIERRA_USE_OCO_BRACKET, 'true'));
ok('wiring: enabled flag is a deliberate boolean', () => assert.equal(typeof VACUUM_EXP_ORDERS.enabled, 'boolean'));
ok('wiring: resolver and expiry source mention VACUUM_EXP_ (bar-walk branch, needsBars exclusion, OR-break skip)', () => {
  const r = fs.readFileSync(new URL('../server/services/resolveSetups.js', import.meta.url), 'utf8'), x = fs.readFileSync(new URL('../server/services/setupExpiry.js', import.meta.url), 'utf8');
  assert.equal((r.match(/VACUUM_EXP_/g) || []).length >= 2, true); assert.equal(x.includes("startsWith('VACUUM_EXP_')"), true); });
const saved = process.env.DTC_AUTO_REARM_SAFE;
process.env.DTC_AUTO_REARM_SAFE = 'true'; ok('exempt on a simulation-safe profile', () => assert.equal(isAmtTellSimExempt('VACUUM_EXP_LONG'), true));
process.env.DTC_AUTO_REARM_SAFE = 'false'; ok('NOT exempt on any other profile', () => assert.equal(isAmtTellSimExempt('VACUUM_EXP_LONG'), false));
ok('other setup types are never exempt; isVacuumExpType is exact', () => { process.env.DTC_AUTO_REARM_SAFE = 'true'; assert.equal(isAmtTellSimExempt('PD_VAH_FADE_SHORT'), false); assert.equal(isVacuumExpType('VACUUM_EXP_SHORT'), true); assert.equal(isVacuumExpType('XVACUUM_EXP_'), false); });
process.env.DTC_AUTO_REARM_SAFE = 'true';
const sets = await computeSuppressionSets(1);
n++; assert.ok(!sets.suppressedSetups.has('VACUUM_EXP_LONG') && !sets.rosterBlocked.has('VACUUM_EXP_LONG') && !sets.dowSuppressToday.has('VACUUM_EXP_SHORT')); console.log('ok suppression sets never contain VACUUM_EXP_*');
process.env.DTC_AUTO_REARM_SAFE = saved;

// real-schema dry run, always rolled back
const client = await getClient();
try {
  await client.query('BEGIN');
  for (const [track, dir, etMin, hh] of [['GBX', 1, 180, '09:29:50'], ['RTH', -1, 600, '15:55:00']]) {
    const e = ev({ track, direction: dir, trade_date: '2026-11-05', fired_at: `2026-11-05 ${track === 'GBX' ? '03:00:04' : '10:00:04'}` });
    const tags = await computeFireTags(e.trade_date, track === 'RTH' ? 'RTH' : 'GLOBEX', etMin);
    const b = buildInsert(e, tags); const ins = await client.query(b.sql, b.params);
    assert.equal(ins.rows.length, 1); const id = ins.rows[0].id;
    const row = (await client.query(`SELECT setup_type, status, origin_status, is_rth, stop_level::float, t1_level::float, entry_zone_low::float, expires_at::text, bet_class, is_cluster_primary FROM active_setups WHERE id=$1`, [id])).rows[0];
    assert.equal(row.setup_type, dir === 1 ? 'VACUUM_EXP_LONG' : 'VACUUM_EXP_SHORT'); assert.equal(row.status, 'ACTIVE'); assert.equal(row.origin_status, 'ACTIVE'); assert.equal(row.is_rth, track === 'RTH');
    assert.equal(row.stop_level, dir === 1 ? 26975 : 27025); assert.equal(row.t1_level, dir === 1 ? 32000 : 22000); assert.equal(row.expires_at, `2026-11-05 ${hh}`); assert.equal(resolveDirection(row), dir === 1 ? 'LONG' : 'SHORT');
    assert.equal((await client.query(b.sql, b.params)).rows.length, 0);   // the touch-instant dedup makes a repeat a no-op
    assert.equal((await client.query(RESOLVE_SQL, [id, 'TIME_EXPIRED', 'VAC_HOLD30', 20, 27013, '2026-11-05 03:40:00'])).rows.length, 1);
    assert.equal((await client.query(RESOLVE_SQL, [id, 'STOP_HIT', 'VAC_STOP', -27, 26976, '2026-11-05 03:41:00'])).rows.length, 0);   // never re-resolved
    n += 1; console.log(`ok real-schema dry run ${track}: insert (${row.setup_type}, stop ${row.stop_level}, expires ${row.expires_at}), dedup, resolve, no double-resolve`);
  }
} finally { await client.query('ROLLBACK'); client.release(); }
// every query of the service's reconcile/exit/entry passes, read-only parse+plan check against the real schema
{ const c = await getClient(); try {
  await c.query('BEGIN READ ONLY');
  for (const sql of [
    `SELECT id, trade_date::text AS trade_date, track, direction, taken, fired_at::text AS fired_at, signal_close::float AS signal_close, entry_open::float AS entry_open, etr::float AS etr, outcome_at, (EXTRACT(EPOCH FROM (NOW()::timestamp - fired_at)))::float AS age_sec FROM vacuum_live_events WHERE taken AND active_setup_id IS NULL AND order_state IS NULL AND trade_date >= CURRENT_DATE - 1 ORDER BY fired_at, id`,
    `SELECT e.id, e.direction, e.entry_open::float AS entry_open, e.fwd30::float AS fwd30, e.net_nostop::float AS net_nostop, e.net_stop25::float AS net_stop25, e.exit_note, e.outcome_at::text AS outcome_at, a.id AS setup_id FROM vacuum_live_events e JOIN active_setups a ON a.id = e.active_setup_id WHERE a.status = 'ACTIVE' AND a.resolved_at IS NULL AND e.outcome_at IS NOT NULL`,
    `SELECT a.id FROM active_setups a JOIN vacuum_live_events e ON e.active_setup_id = a.id WHERE a.status = 'ACTIVE' AND e.outcome_at IS NOT NULL AND e.outcome_at < NOW()::timestamp - interval '3 minutes'`,
    `SELECT a.id FROM active_setups a JOIN order_placements o ON o.setup_id = a.id AND o.purpose = 'ENTRY' WHERE a.setup_type LIKE 'VACUUM\\_EXP\\_%' AND a.status IN ('RESOLVED','EXPIRED') AND o.position_open = TRUE AND a.resolved_at < NOW()::timestamp - interval '3 minutes'`,
    `SELECT 1 FROM active_setups WHERE (setup_type LIKE 'VACUUM\\_EXP\\_%' OR setup_type LIKE 'AMT\\_TELL\\_%') AND status = 'ACTIVE' LIMIT 1`,
    `SELECT kind FROM amt_tell_alarms WHERE kind LIKE 'VAC\\_%' AND at >= CURRENT_DATE::timestamp ORDER BY at DESC LIMIT 1`]) await c.query(sql);
  await c.query('ROLLBACK'); n++; console.log('ok service queries parse and plan against the real schema');
} finally { c.release(); } }
console.log(`\nALL ${n} PASS`); process.exit(0);
