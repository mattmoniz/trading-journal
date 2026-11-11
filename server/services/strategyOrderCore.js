// Shared skeleton of the three "strategy -> Sim1 orders" services (amtTellOrders.js, vacuumLiveOrders.js, turnSignalOrders.js). Fable audit F26, 2026-11-11.
// Each service writes ordinary active_setups rows and lets orderSweep.js / reconciliation.js / protection.js do everything broker-side; what they had in common was
// copied three times: the in-memory state + alarm + self-pause, the 4-step poll runner, the status shape, last NQ close, the generic misfire checks and (vacuum/turn)
// the event-table entry/exit loops. A fix to one (the F02 stuck-flag class of bug) had to be made three times. It now lives here ONCE.
// What stays in each service on purpose: the pure decideEntry / decideExit / buildInsert (the strategy), isBusy for the tell (its own scope), the tell's override and
// day-state logic, and the order of its reconcile checks. NOTHING in here submits an order. Behaviour is identical to the three originals (same SQL text, same order
// of steps, same log lines apart from the service name); scripts/test_{amt_tell,vacuum_live,turn_signal}_orders.mjs are the safety net.
import { query } from '../db.js';
import { computeFireTags } from './fireTags.js';
import { dropToTimeline } from './acdShared.js';
import { killSwitch } from './sierraChart/orderEligibility.js';

export const RESOLVE_SQL = `UPDATE active_setups SET status = 'RESOLVED', resolution = $2, resolution_method = $3, actual_pnl = $4, price_at_resolution = $5, resolved_at = $6, updated_at = NOW()
                           WHERE id = $1 AND status = 'ACTIVE' AND resolved_at IS NULL RETURNING id`;
export const etMinOf = (ts) => Number(String(ts).slice(11, 13)) * 60 + Number(String(ts).slice(14, 16));

export async function lastNqClose() {
  const r = await query(`SELECT close::float AS c FROM price_bars_primary WHERE symbol='NQ' AND ts >= NOW()::timestamp - interval '10 minutes' AND ts <= NOW()::timestamp ORDER BY ts DESC LIMIT 1`);
  return r.rows[0]?.c ?? null;
}

/** One position at a time across the vacuum, turn and tell families (used by vacuumLiveOrders and turnSignalOrders; the tell keeps its own narrower isBusy). */
export async function isBusyAcrossFamilies() {
  const a = await query(`SELECT 1 FROM active_setups WHERE (setup_type LIKE 'VACUUM\\_EXP\\_%' OR setup_type LIKE 'AMT\\_TELL\\_%') AND status = 'ACTIVE' LIMIT 1`);
  if (a.rows.length) return true;
  const o = await query(`SELECT 1 FROM order_placements WHERE position_open = TRUE LIMIT 1`);   // any open broker position on the account (a resolved row whose flatten is still in flight, or another setup)
  return o.rows.length > 0;
}

/**
 * The service shell. cfg = the service's own config object (read live: .enabled, .pollMs); pauseKindSql = the WHERE fragment over amt_tell_alarms.kind that restores the
 * day's self-pause after a restart; statusExtra() = fields added to the status object (tracks / override).
 */
export function createStrategyService({ logName, cfg, pauseKindSql, statusExtra = () => ({}), onStart = null }) {
  const state = { lastRunAt: null, lastError: null, selfPaused: null, runs: 0, linked: 0, skipped: 0, resolved: 0, problem: null };
  const alarmSeen = new Map();
  let timer = null, running = false;

  async function raiseAlarm(kind, detail, pause) {
    const key = kind + JSON.stringify(detail);
    if (!alarmSeen.has(key)) {
      alarmSeen.set(key, Date.now());
      console.error(`[${logName}] ALARM ${kind}`, detail);
      await query(`INSERT INTO amt_tell_alarms (at, kind, detail) VALUES (NOW()::timestamp, $1, $2)`, [kind.slice(0, 30), JSON.stringify(detail)]).catch(() => {});   // shared alarm table
    }
    state.problem = `${kind} ${JSON.stringify(detail)}`;
    if (pause && !state.selfPaused) { state.selfPaused = `${kind} at ${new Date().toISOString()}`; console.error(`[${logName}] SELF-PAUSED (no new entries; exits keep being managed): ${state.selfPaused}`); }
  }

  // The self-pause survives a restart: any pausing alarm raised today (ET) re-pauses the service until the next trading day (clear it deliberately by deleting today's alarm rows).
  async function loadPause() {
    if (state.selfPaused) return;
    const r = (await query(`SELECT kind FROM amt_tell_alarms WHERE ${pauseKindSql} AND at >= CURRENT_DATE::timestamp ORDER BY at DESC LIMIT 1`)).rows[0];
    if (r) { state.selfPaused = `${r.kind} (restored from today's alarms)`; console.error(`[${logName}] SELF-PAUSED on start: ${state.selfPaused}`); }
  }

  /** Generic misfire checks (same SQL as the three originals); a service composes its reconcile() from these in its own order. */
  async function checkGenericResolution(typeLike, kind) {
    const generic = (await query(`SELECT id, resolution, resolution_method FROM active_setups WHERE setup_type LIKE '${typeLike}' AND trade_date >= CURRENT_DATE - 1 AND status IN ('RESOLVED','EXPIRED','INVALIDATED')
                                AND (resolution_method IN ('MARK_TO_MARKET','RECOVERY_MTM') OR resolution = 'INVALIDATED')`)).rows;
    for (const r of generic) await raiseAlarm(kind, { setup_id: r.id, resolution: r.resolution, method: r.resolution_method }, true);
  }
  async function checkUnflattened(typeLike, kind) {
    const unflat = (await query(`SELECT a.id FROM active_setups a JOIN order_placements o ON o.setup_id = a.id AND o.purpose = 'ENTRY' WHERE a.setup_type LIKE '${typeLike}' AND a.status IN ('RESOLVED','EXPIRED')
                                AND o.position_open = TRUE AND a.resolved_at < NOW()::timestamp - interval '3 minutes'`)).rows;   // resolved, entry filled, but the broker position is still open: the flatten never went out
    for (const r of unflat) await raiseAlarm(kind, { setup_id: r.id }, true);
  }
  async function checkDoubleEntry(typeLike, kind) {
    const act = (await query(`SELECT count(*)::int AS n FROM active_setups WHERE setup_type LIKE '${typeLike}' AND status = 'ACTIVE'`)).rows[0].n;
    if (act > 1) await raiseAlarm(kind, { active_rows: act }, true);
  }
  async function checkStuckActive(eventTable, kind) {
    const stuck = (await query(`SELECT a.id FROM active_setups a JOIN ${eventTable} e ON e.active_setup_id = a.id WHERE a.status = 'ACTIVE' AND e.outcome_at IS NOT NULL AND e.outcome_at < NOW()::timestamp - interval '3 minutes'`)).rows;
    for (const r of stuck) await raiseAlarm(kind, { setup_id: r.id }, true);
  }

  /** Event-table exit loop (vacuum, turn): resolve every ACTIVE row whose event outcome the detector has written. */
  async function syncEventExits(eventTable, decideExit) {
    const rows = (await query(`
      SELECT e.id, e.direction, e.entry_open::float AS entry_open, e.fwd30::float AS fwd30, e.net_nostop::float AS net_nostop, e.net_stop25::float AS net_stop25, e.exit_note, e.outcome_at::text AS outcome_at, a.id AS setup_id
      FROM ${eventTable} e JOIN active_setups a ON a.id = e.active_setup_id
      WHERE a.status = 'ACTIVE' AND a.resolved_at IS NULL AND e.outcome_at IS NOT NULL`)).rows;
    for (const e of rows) {
      const o = (await query(`SELECT purpose, status, filled_quantity, avg_fill_price::float AS avg_fill_price FROM order_placements WHERE setup_id = $1 AND purpose IN ('ENTRY','STOP')`, [e.setup_id])).rows;
      const entryRow = o.find((x) => x.purpose === 'ENTRY' && Number(x.filled_quantity) > 0);
      const d = decideExit(e, { entryFilled: !!entryRow, avgFill: entryRow?.avg_fill_price ?? null, stopFilled: o.some((x) => x.purpose === 'STOP' && x.status === 'FILLED') });
      const r = await query(RESOLVE_SQL, [e.setup_id, d.resolution, d.method, d.pnl, d.exitPx, e.outcome_at]);   // TOCTOU-safe: the resolver backstop may have got there first
      if (r.rows.length) { state.resolved++; console.log(`[${logName}] resolved setup_id=${e.setup_id} ${d.resolution}/${d.method} pnl ${d.pnl}`); }
    }
  }

  /** Event-table entry loop (vacuum, turn). setupTypes = the two setup_type names this service writes; extraWhere = e.g. "AND kind = 'S2_IGNITION'". */
  async function considerEventEntries({ eventTable, extraWhere = '', setupTypes, decideEntry, buildInsert, isBusy }) {
    const rows = (await query(`
      SELECT id, trade_date::text AS trade_date, track, direction, taken, fired_at::text AS fired_at, signal_close::float AS signal_close, entry_open::float AS entry_open, etr::float AS etr, outcome_at, (EXTRACT(EPOCH FROM (NOW()::timestamp - fired_at)))::float AS age_sec
      FROM ${eventTable} WHERE taken ${extraWhere} AND active_setup_id IS NULL AND order_state IS NULL AND trade_date >= CURRENT_DATE - 1 ORDER BY fired_at, id`)).rows;
    for (const e of rows) {
      const existing = (await query(`SELECT id FROM active_setups WHERE trade_date = $1 AND fired_at = $2 AND setup_type IN (${setupTypes.map((t) => `'${t}'`).join(', ')})`, [e.trade_date, e.fired_at])).rows[0];
      if (existing) { await query(`UPDATE ${eventTable} SET active_setup_id = $2, order_state = 'LINKED' WHERE id = $1 AND active_setup_id IS NULL`, [e.id, existing.id]); state.linked++; continue; }   // a crash between insert and link: re-link, never duplicate
      const off = state.selfPaused || !cfg.enabled;
      const decision = off ? { action: 'SKIP', state: 'SKIPPED_DISABLED' }
        : decideEntry(e, { ageSec: e.age_sec, busy: await isBusy(), lastClose: await lastNqClose(), armed: killSwitch.isArmed() });
      if (decision.action === 'SKIP') { await query(`UPDATE ${eventTable} SET order_state = $2 WHERE id = $1 AND order_state IS NULL`, [e.id, decision.state]); state.skipped++; continue; }
      const fireTags = await computeFireTags(e.trade_date, e.track === 'RTH' ? 'RTH' : 'GLOBEX', etMinOf(e.fired_at));
      const { sql, params, setupType, entryAt, stop, t1 } = buildInsert(e, fireTags);
      const ins = await query(sql, params);
      const id = ins.rows[0]?.id ?? (await query(`SELECT id FROM active_setups WHERE trade_date = $1 AND setup_type = $2 AND fired_at = $3`, [e.trade_date, setupType, entryAt])).rows[0]?.id;
      if (!id) { await query(`UPDATE ${eventTable} SET order_state = 'SKIPPED_DUP' WHERE id = $1`, [e.id]); continue; }
      await query(`UPDATE ${eventTable} SET active_setup_id = $2, order_state = 'LINKED' WHERE id = $1 AND active_setup_id IS NULL`, [e.id, id]);
      state.linked++; console.log(`[${logName}] ${setupType} setup_id=${id} ${e.track} entry ~${e.signal_close} stop ${stop} (event #${e.id}, age ${Math.round(e.age_sec)} s)`);
      try { await dropToTimeline({ id, trade_date: e.trade_date, setup_type: setupType, fired_at: entryAt, entry_zone_low: e.signal_close, stop_level: stop, t1_level: t1, t1_label: 'NO_TARGET', resolution: null, historical_win_rate: null }); } catch { /* timeline is display only */ }
    }
  }

  /** steps = { reconcile, syncExits, considerEntries }; reconcile first: a fresh misfire must pause BEFORE any new entry is considered. */
  async function runOnce(steps) {
    if (running) return; running = true;
    try { await loadPause(); await steps.reconcile(); await steps.syncExits(); await steps.considerEntries(); state.lastError = null; }
    catch (e) { state.lastError = e.message; console.error(`[${logName}]`, e); }
    finally { running = false; state.lastRunAt = Date.now(); state.runs++; }
  }
  function start(runFn) { if (!timer) { timer = setInterval(runFn, cfg.pollMs); if (onStart) onStart(); } }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  function status() {
    return { enabled: !!cfg.enabled && !state.selfPaused, configuredEnabled: !!cfg.enabled, ...statusExtra(), selfPaused: state.selfPaused, problem: state.problem || (state.lastError ? `orders service error: ${state.lastError}` : null),
             lastRunAgeSec: state.lastRunAt ? Math.round((Date.now() - state.lastRunAt) / 1000) : null, linked: state.linked, skipped: state.skipped, resolved: state.resolved };
  }
  return { state, raiseAlarm, loadPause, checkGenericResolution, checkUnflattened, checkDoubleEntry, checkStuckActive, syncEventExits, considerEventEntries, runOnce, start, stop, status };
}
