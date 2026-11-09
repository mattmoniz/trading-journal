// Sim1 order wiring of the TURN SIGNAL (2026-11-09, user: "I want to see trades fire ... like in Sierra chart"). Detector: scripts/vacuum_live/shadow.py + scripts/vacuum_sim/turn_signal.py log Stage-1 (climax cluster / spike)
// and Stage-2 (ignition) events to turn_signal_events; an event marked `taken` (a Stage-2 ignition whose linked OPPOSITE Stage 1 held and whose Stage-1 extension is in the rolling top tercile, one position per track at a time)
// becomes a REAL order on the SIMULATED account by writing an ordinary active_setups row of type VACUUM_EXP_TURN_LONG/SHORT. The VACUUM_EXP_ prefix means ALL the existing wiring applies unchanged (market entry in
// orderSweep, protective STOP by reconciliation, generic resolver stop walk + hard-flat backstop, structural invalidation skip, designed-timeout prefix, sim-only roster exemption while DTC_AUTO_REARM_SAFE=true): NO new
// order-submission code, a mechanical copy of vacuumLiveOrders.js with the table, setup type, alarm kinds (TURN_*) and resolution methods (TURN_*) changed. Pre-registration: docs/TURN_SIGNAL_SIM_FORWARD_PREREG_20261109.md.
// Rules (fixed in writing before any order): 1 MNQ, stop = signal close -/+ 2.5 x EMA10(TR), NO profit target, exit 30 bars after the entry bar (the detector writes outcome_at) or the hard flat (09:29:50 Globex, 15:55 RTH,
// 13:10 early close) or the broker stop; entry only while FRESH (<= maxAgeSec); one position at a time across the vacuum, tell and turn families. NOT a validated edge: a forward test on sim capital the user asked to see live.
import { query } from '../db.js';
import { computeFireTags, FIRE_TAG_COLS, fireTagValues } from './fireTags.js';
import { dropToTimeline } from './acdShared.js';
import { getBetClass } from '../config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../config/instruments.js';
import { killSwitch } from './sierraChart/orderEligibility.js';
import { getEarlyCloseMinute } from './marketCalendar.js';

export const TURN_ORDERS = { enabled: true, pollMs: 5000, stopMult: 2.5, t1PlaceholderDist: 5000, maxAgeSec: 150, tracks: { GBX: true, RTH: true } };
const state = { lastRunAt: null, lastError: null, selfPaused: null, runs: 0, linked: 0, skipped: 0, resolved: 0, problem: null };
const alarmSeen = new Map();
const etMinOf = (ts) => Number(String(ts).slice(11, 13)) * 60 + Number(String(ts).slice(14, 16));

/** Pure: the protective stop of an event: the signal close -/+ stopMult x EMA10(TR) (the detector's V0 stop, measured from the entry, which is the next open ~ the signal close). */
export const stopOf = (e, mult = TURN_ORDERS.stopMult) => Number(e.signal_close) - Number(e.direction) * mult * Number(e.etr);

/** Pure: should this logged event be ordered? e = turn_signal_events row; ctx = { ageSec, busy, lastClose, armed }. */
export function decideEntry(e, ctx, cfg = TURN_ORDERS) {
  const dir = Number(e.direction);
  if (!(dir === 1 || dir === -1) || !(Number(e.etr) > 0) || !Number.isFinite(Number(e.signal_close))) return { action: 'SKIP', state: 'SKIPPED_NOSTOP' };
  if (!cfg.tracks[e.track]) return { action: 'SKIP', state: 'SKIPPED_TRACK' };
  if (!e.taken) return { action: 'SKIP', state: 'SKIPPED_NOTTAKEN' };
  if (ctx.armed === false) return { action: 'SKIP', state: 'SKIPPED_DISARMED' };                // kill switch off: no order can be placed, so no ACTIVE row either (a ghost row would block the next event)
  if (e.outcome_at != null || ctx.ageSec == null || ctx.ageSec > cfg.maxAgeSec) return { action: 'SKIP', state: 'SKIPPED_STALE' };   // already finished or a catch-up/restart replay: never entered after the fact
  if (ctx.busy) return { action: 'SKIP', state: 'SKIPPED_BUSY' };                              // one position at a time (any open order position, any setup)
  if (ctx.lastClose != null) {
    const stop = stopOf(e);
    if (dir === 1 ? ctx.lastClose <= stop : ctx.lastClose >= stop) return { action: 'SKIP', state: 'SKIPPED_PRICE' };   // price already through the stop: the order would open at a loss
  }
  return { action: 'INSERT' };
}

/** Pure: the hard-flat clock of the row (naive ET string). Globex ends 09:29:50; RTH 15:55, or 13:10 on an early close. */
export function expiresAtOf(e) {
  const hhmmss = e.track === 'GBX' ? '09:29:50' : (getEarlyCloseMinute(e.trade_date) != null ? '13:10:00' : '15:55:00');
  return `${e.trade_date} ${hhmmss}`;
}

/** The active_setups INSERT (exported so scripts/test_vacuum_live_orders.mjs can dry-run the exact statement against the real schema in a rolled-back transaction). */
export function buildInsert(e, fireTags = null, cfg = TURN_ORDERS) {
  const dir = Number(e.direction), setupType = `VACUUM_EXP_TURN_${dir === 1 ? 'LONG' : 'SHORT'}`, entry = Number(e.signal_close), stop = Math.round(stopOf(e, cfg.stopMult) * 100) / 100;
  const expiresAt = expiresAtOf(e), t1 = dir === 1 ? entry + cfg.t1PlaceholderDist : entry - cfg.t1PlaceholderDist;
  const sql = `
    INSERT INTO active_setups (trade_date, setup_type, fired_at, expires_at, status, origin_status, entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label, price_at_detection, suppression_reason,
                               ${FIRE_TAG_COLS.join(', ')}, bet_class)
    VALUES ($1,$2,$3,$4,'ACTIVE','ACTIVE',$5,$5,$6,$7,$8,$5,NULL, ${FIRE_TAG_COLS.map((_, i) => `$${9 + i}`).join(', ')}, $${9 + FIRE_TAG_COLS.length})
    ON CONFLICT DO NOTHING RETURNING id`;
  const params = [e.trade_date, setupType, e.fired_at, expiresAt, entry, stop, t1, 'NO_TARGET (30-bar hold / hard flat written by turnSignalOrders.js)', ...fireTagValues(fireTags || {}), getBetClass(setupType)];
  return { sql, params, setupType, entryAt: e.fired_at, expiresAt, t1, stop };
}
export const RESOLVE_SQL = `UPDATE active_setups SET status = 'RESOLVED', resolution = $2, resolution_method = $3, actual_pnl = $4, price_at_resolution = $5, resolved_at = $6, updated_at = NOW()
                           WHERE id = $1 AND status = 'ACTIVE' AND resolved_at IS NULL RETURNING id`;

/** Pure: how to resolve the row of a finished event. orders = { entryFilled, avgFill, stopFilled } from order_placements (broker truth). Values fit resolution VARCHAR(20) / resolution_method VARCHAR(20); none is MARK_TO_MARKET. */
export function decideExit(e, orders) {
  if (!orders.entryFilled) return { resolution: 'NOT_FILLED', method: 'TURN_NO_FILL', pnl: null, exitPx: null };
  const dir = Number(e.direction), entry = Number(e.entry_open);
  const stopped = String(e.exit_note || '').includes('+stop') || orders.stopFilled;
  const flat = String(e.exit_note || '').includes('flat-clamped');
  // detector exit price: the 30-bar close (fwd30 is the dir-signed move from the entry open), or the stop (net_stop25 = signed move - 2.0 cost)
  const exitPx = stopped && e.net_stop25 != null ? entry + dir * (Number(e.net_stop25) + 2.0) : entry + dir * Number(e.fwd30);
  let pnl = null;
  if (orders.avgFill != null && Number.isFinite(exitPx)) pnl = Math.round((((exitPx - Number(orders.avgFill)) * dir) * LIVE_INSTRUMENT.dollarsPerPoint - LIVE_INSTRUMENT.commissionPerRoundTrip) * 100) / 100;   // real entry fill replaces the theoretical entry (resolveSetups.js convention)
  else if (e.net_nostop != null) pnl = Math.round(Number(stopped ? e.net_stop25 : e.net_nostop) * LIVE_INSTRUMENT.dollarsPerPoint * 100) / 100;   // no fill price recorded: the detector's own net (points, cost included) in dollars
  return { resolution: stopped ? 'STOP_HIT' : 'TIME_EXPIRED', method: stopped ? 'TURN_STOP' : (flat ? 'TURN_FLAT' : 'TURN_HOLD30'), pnl, exitPx: Number.isFinite(exitPx) ? exitPx : null };
}

async function isBusy() {
  const a = await query(`SELECT 1 FROM active_setups WHERE (setup_type LIKE 'VACUUM\\_EXP\\_%' OR setup_type LIKE 'AMT\\_TELL\\_%') AND status = 'ACTIVE' LIMIT 1`);
  if (a.rows.length) return true;
  const o = await query(`SELECT 1 FROM order_placements WHERE position_open = TRUE LIMIT 1`);   // any open broker position on the account (a resolved row whose flatten is still in flight, or another setup)
  return o.rows.length > 0;
}
async function lastNqClose() {
  const r = await query(`SELECT close::float AS c FROM price_bars_primary WHERE symbol='NQ' AND ts >= NOW()::timestamp - interval '10 minutes' AND ts <= NOW()::timestamp ORDER BY ts DESC LIMIT 1`);
  return r.rows[0]?.c ?? null;
}
async function raiseAlarm(kind, detail, pause) {
  const key = kind + JSON.stringify(detail);
  if (!alarmSeen.has(key)) {
    alarmSeen.set(key, Date.now());
    console.error(`[turnSignalOrders] ALARM ${kind}`, detail);
    await query(`INSERT INTO amt_tell_alarms (at, kind, detail) VALUES (NOW()::timestamp, $1, $2)`, [kind.slice(0, 30), JSON.stringify(detail)]).catch(() => {});   // shared alarm table; kinds TURN_* are this service's
  }
  state.problem = `${kind} ${JSON.stringify(detail)}`;
  if (pause && !state.selfPaused) { state.selfPaused = `${kind} at ${new Date().toISOString()}`; console.error(`[turnSignalOrders] SELF-PAUSED (no new entries; exits keep being managed): ${state.selfPaused}`); }
}

async function considerEntries() {
  const rows = (await query(`
    SELECT id, trade_date::text AS trade_date, track, direction, taken, fired_at::text AS fired_at, signal_close::float AS signal_close, entry_open::float AS entry_open, etr::float AS etr, outcome_at, (EXTRACT(EPOCH FROM (NOW()::timestamp - fired_at)))::float AS age_sec
    FROM turn_signal_events WHERE taken AND kind = 'S2_IGNITION' AND active_setup_id IS NULL AND order_state IS NULL AND trade_date >= CURRENT_DATE - 1 ORDER BY fired_at, id`)).rows;
  for (const e of rows) {
    const existing = (await query(`SELECT id FROM active_setups WHERE trade_date = $1 AND fired_at = $2 AND setup_type IN ('VACUUM_EXP_TURN_LONG', 'VACUUM_EXP_TURN_SHORT')`, [e.trade_date, e.fired_at])).rows[0];
    if (existing) { await query(`UPDATE turn_signal_events SET active_setup_id = $2, order_state = 'LINKED' WHERE id = $1 AND active_setup_id IS NULL`, [e.id, existing.id]); state.linked++; continue; }   // a crash between insert and link: re-link, never duplicate
    const off = state.selfPaused || !TURN_ORDERS.enabled;
    const decision = off ? { action: 'SKIP', state: 'SKIPPED_DISABLED' }
      : decideEntry(e, { ageSec: e.age_sec, busy: await isBusy(), lastClose: await lastNqClose(), armed: killSwitch.isArmed() });
    if (decision.action === 'SKIP') { await query(`UPDATE turn_signal_events SET order_state = $2 WHERE id = $1 AND order_state IS NULL`, [e.id, decision.state]); state.skipped++; continue; }
    const fireTags = await computeFireTags(e.trade_date, e.track === 'RTH' ? 'RTH' : 'GLOBEX', etMinOf(e.fired_at));
    const { sql, params, setupType, entryAt, stop, t1 } = buildInsert(e, fireTags);
    const ins = await query(sql, params);
    const id = ins.rows[0]?.id ?? (await query(`SELECT id FROM active_setups WHERE trade_date = $1 AND setup_type = $2 AND fired_at = $3`, [e.trade_date, setupType, entryAt])).rows[0]?.id;
    if (!id) { await query(`UPDATE turn_signal_events SET order_state = 'SKIPPED_DUP' WHERE id = $1`, [e.id]); continue; }
    await query(`UPDATE turn_signal_events SET active_setup_id = $2, order_state = 'LINKED' WHERE id = $1 AND active_setup_id IS NULL`, [e.id, id]);
    state.linked++; console.log(`[turnSignalOrders] ${setupType} setup_id=${id} ${e.track} entry ~${e.signal_close} stop ${stop} (event #${e.id}, age ${Math.round(e.age_sec)} s)`);
    try { await dropToTimeline({ id, trade_date: e.trade_date, setup_type: setupType, fired_at: entryAt, entry_zone_low: e.signal_close, stop_level: stop, t1_level: t1, t1_label: 'NO_TARGET', resolution: null, historical_win_rate: null }); } catch { /* timeline is display only */ }
  }
}

async function syncExits() {
  // Every ACTIVE row linked to an event whose outcome the detector has written (the 30th bar after the entry exists, or the hard flat passed).
  const rows = (await query(`
    SELECT e.id, e.direction, e.entry_open::float AS entry_open, e.fwd30::float AS fwd30, e.net_nostop::float AS net_nostop, e.net_stop25::float AS net_stop25, e.exit_note, e.outcome_at::text AS outcome_at, a.id AS setup_id
    FROM turn_signal_events e JOIN active_setups a ON a.id = e.active_setup_id
    WHERE a.status = 'ACTIVE' AND a.resolved_at IS NULL AND e.outcome_at IS NOT NULL`)).rows;
  for (const e of rows) {
    const o = (await query(`SELECT purpose, status, filled_quantity, avg_fill_price::float AS avg_fill_price FROM order_placements WHERE setup_id = $1 AND purpose IN ('ENTRY','STOP')`, [e.setup_id])).rows;
    const entryRow = o.find((x) => x.purpose === 'ENTRY' && Number(x.filled_quantity) > 0);
    const d = decideExit(e, { entryFilled: !!entryRow, avgFill: entryRow?.avg_fill_price ?? null, stopFilled: o.some((x) => x.purpose === 'STOP' && x.status === 'FILLED') });
    const r = await query(RESOLVE_SQL, [e.setup_id, d.resolution, d.method, d.pnl, d.exitPx, e.outcome_at]);   // TOCTOU-safe: the resolver backstop may have got there first
    if (r.rows.length) { state.resolved++; console.log(`[turnSignalOrders] resolved setup_id=${e.setup_id} ${d.resolution}/${d.method} pnl ${d.pnl}`); }
  }
}

async function reconcile() {
  state.problem = null;
  const stuck = (await query(`SELECT a.id FROM active_setups a JOIN turn_signal_events e ON e.active_setup_id = a.id WHERE a.status = 'ACTIVE' AND e.outcome_at IS NOT NULL AND e.outcome_at < NOW()::timestamp - interval '3 minutes'`)).rows;
  for (const r of stuck) await raiseAlarm('TURN_STUCK_ACTIVE', { setup_id: r.id }, true);
  const generic = (await query(`SELECT id, resolution, resolution_method FROM active_setups WHERE setup_type LIKE 'VACUUM\\_EXP\\_TURN\\_%' AND trade_date >= CURRENT_DATE - 1 AND status IN ('RESOLVED','EXPIRED','INVALIDATED')
                                AND (resolution_method IN ('MARK_TO_MARKET','RECOVERY_MTM') OR resolution = 'INVALIDATED')`)).rows;
  for (const r of generic) await raiseAlarm('TURN_GENERIC_RESOLUTION', { setup_id: r.id, resolution: r.resolution, method: r.resolution_method }, true);
  const unflat = (await query(`SELECT a.id FROM active_setups a JOIN order_placements o ON o.setup_id = a.id AND o.purpose = 'ENTRY' WHERE a.setup_type LIKE 'VACUUM\\_EXP\\_TURN\\_%' AND a.status IN ('RESOLVED','EXPIRED')
                                AND o.position_open = TRUE AND a.resolved_at < NOW()::timestamp - interval '3 minutes'`)).rows;   // resolved, entry filled, but the broker position is still open: the flatten never went out
  for (const r of unflat) await raiseAlarm('TURN_UNFLATTENED', { setup_id: r.id }, true);
  const act = (await query(`SELECT count(*)::int AS n FROM active_setups WHERE setup_type LIKE 'VACUUM\\_EXP\\_%' AND status = 'ACTIVE'`)).rows[0].n;
  if (act > 1) await raiseAlarm('TURN_DOUBLE_ENTRY', { active_rows: act }, true);
  if (state.selfPaused && !state.problem) state.problem = `self-paused: ${state.selfPaused}`;
}

// The self-pause survives a restart: any pausing alarm raised today (ET) re-pauses the service until the next trading day (clear it deliberately by deleting today's VAC_* alarm rows).
async function loadPause() {
  if (state.selfPaused) return;
  const r = (await query(`SELECT kind FROM amt_tell_alarms WHERE kind LIKE 'TURN\\_%' AND at >= CURRENT_DATE::timestamp ORDER BY at DESC LIMIT 1`)).rows[0];
  if (r) { state.selfPaused = `${r.kind} (restored from today's alarms)`; console.error(`[turnSignalOrders] SELF-PAUSED on start: ${state.selfPaused}`); }
}

let timer = null, running = false;
export async function runTurnSignalOrdersOnce() {
  if (running) return; running = true;
  try { await loadPause(); await reconcile(); await syncExits(); await considerEntries(); state.lastError = null; }       // reconcile first: a fresh misfire must pause BEFORE any new entry is considered
  catch (e) { state.lastError = e.message; console.error('[turnSignalOrders]', e); }
  finally { running = false; state.lastRunAt = Date.now(); state.runs++; }
}
export function startTurnSignalOrders() { if (!timer) timer = setInterval(runTurnSignalOrdersOnce, TURN_ORDERS.pollMs); }
export function stopTurnSignalOrders() { if (timer) { clearInterval(timer); timer = null; } }
export function getTurnSignalOrdersStatus() {
  return { enabled: !!TURN_ORDERS.enabled && !state.selfPaused, configuredEnabled: !!TURN_ORDERS.enabled, tracks: TURN_ORDERS.tracks, selfPaused: state.selfPaused, problem: state.problem || (state.lastError ? `orders service error: ${state.lastError}` : null),
           lastRunAgeSec: state.lastRunAt ? Math.round((Date.now() - state.lastRunAt) / 1000) : null, linked: state.linked, skipped: state.skipped, resolved: state.resolved };
}
