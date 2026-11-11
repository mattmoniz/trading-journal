// Position protection: every open real position must have exactly one working broker-side STOP, or the app is flattening it and halted.
// Built from the Fable whole-app audit (2026-11-10): F01 (no repair loop for a missed stop), F04 (an exit cancels the stop first; a
// rejected exit left nothing), F05 (a stop that could not be placed was a console line only). Design: scratch/fable_audit_designs_20261110.md 3.2.
//
// What this module does and does not do (read before changing it):
//  * It only ever PLACES a stop (placeStopOrder), or, after a deadline, flattens (placeExitOrder, which keeps its own broker-truth guard)
//    and HALTS the kill switch. It never arms, never touches the status lattice, never writes order_placements.status except to mark a
//    stop the broker verifiably does not hold (CANCELED, which a late FILLED can still correct per shouldApplyStatus).
//  * It never places a stop unless the BROKER confirms a position on the entry's side of at least the filled size (a stop on a flat
//    account is a naked order that OPENS a position). A flat or unreadable broker raises an alarm instead (hr-066: the broker aggregate
//    is a fail-closed cross-check, never an oracle for attribution).
//  * Idempotent: a live stop per setup is enforced by idx_order_placements_one_live_stop_per_setup; the replacement client id is derived
//    from the number of existing STOP rows, so two racing callers collide on the unique client id and one of them gets null.
import { query } from '../../db.js';
import { placeStopOrder, placeExitOrder, persistExitGate, getBrokerSnapshot, extractPositionForSymbol, brokerExitDecision, EXIT_LIVE_STATUSES } from './reconciliation.js';

// A stop row in any of these is working (or about to be). CANCELED / REJECTED / ERROR are dead; PENDING_CANCEL is on its way to dead.
export const STOP_WORKING_STATUSES = ['PENDING_SUBMIT', 'SUBMITTED', 'ORDER_SENT', 'PENDING_OPEN', 'OPEN', 'PARTIALLY_FILLED', 'PENDING_CHILD', 'PENDING_CANCEL_REPLACE'];

// Operational deadlines (reaction times, not statistical cutoffs). Measured basis: fill to stop took p50 0.7-0.9 s and max 5.1 s over 375
// entries (Fable audit F01, 2026-11-10), so 10 s of grace before the sweep touches a fresh fill is above the observed maximum, and 60 s of
// unprotected time is more than 10x it before the position is flattened.
export const PROTECTION_FILL_GRACE_MS = 10000;
export const PROTECTION_FLATTEN_DEADLINE_MS = 60000;
export const BROKER_VERIFY_EVERY_MS = 60000; // an open-orders request replays every open order through handleOrderUpdate; keep it rare

/**
 * The stop price for a filled entry. A MARKET entry can fill past the pre-computed stop (stop_level came from the detection price); a
 * stop on the wrong side of the fill triggers instantly. In that case keep the calibrated RISK DISTANCE (|entry_zone_low - stop_level|)
 * and measure it from the real fill. Pure; moved here from applyOrderUpdate so the fill path and the repair path cannot disagree.
 */
export function resolveStopPrice({ entrySide, stopLevel, entryLevel, fillPx }) {
  if (stopLevel == null || !Number.isFinite(stopLevel)) return { stopPrice: null, adjusted: false };
  if (Number.isFinite(fillPx) && Number.isFinite(entryLevel)) {
    const isLong = entrySide === 'BUY';
    const inverted = isLong ? stopLevel >= fillPx : stopLevel <= fillPx;
    if (inverted) {
      const dist = Math.abs(entryLevel - stopLevel);
      return { stopPrice: isLong ? fillPx - dist : fillPx + dist, adjusted: true, dist, plannedStop: stopLevel, fillPx };
    }
  }
  return { stopPrice: stopLevel, adjusted: false };
}

/**
 * Pure. Where a setup's real position stands, from this app's own rows.
 *   NOT_OPEN     no filled entry, or its position slot is released
 *   CLOSED       the stop or the target filled
 *   EXITING      an exit order is working or filled (the exit path owns the position)
 *   PROTECTED    a working stop row exists
 *   UNPROTECTED  filled, open, nothing working: needs a stop (or, after the deadline, a flatten)
 */
export function classifyProtection({ entry, stops, exits, targets }) {
  if (!entry || !(entry.filled_quantity > 0) || !entry.position_open) return 'NOT_OPEN';
  if (stops.some((s) => s.status === 'FILLED') || targets.some((t) => t.status === 'FILLED')) return 'CLOSED';
  if (exits.some((x) => EXIT_LIVE_STATUSES.includes(x.status))) return 'EXITING';
  if (stops.some((s) => STOP_WORKING_STATUSES.includes(s.status))) return 'PROTECTED';
  return 'UNPROTECTED';
}

/** Replacement stop client ids: S<id> for the first stop, then S<id>R1, S<id>R2 ... (each dead stop row burns one number). */
export function nextStopClientOrderId(setupId, existingStopRows) {
  return existingStopRows.length === 0 ? `S${setupId}` : `S${setupId}R${existingStopRows.length}`;
}

async function loadState(setupId) {
  const [e, st, ex, tg, su] = await Promise.all([
    query(`SELECT id, setup_id, side, symbol, exchange, trade_account, environment_service, filled_quantity, position_open, status,
                  avg_fill_price::float AS avg_fill_price, COALESCE(last_update_at, submitted_at) AS last_touch,
                  (EXTRACT(EPOCH FROM (now() - COALESCE(last_update_at, submitted_at))) * 1000)::float AS age_ms
           FROM order_placements WHERE setup_id = $1 AND purpose = 'ENTRY' ORDER BY id DESC LIMIT 1`, [setupId]),
    query(`SELECT id, client_order_id, server_order_id, status, price1::float AS price1, quantity,
                  (EXTRACT(EPOCH FROM (now() - COALESCE(last_update_at, submitted_at))) * 1000)::float AS age_ms
           FROM order_placements WHERE setup_id = $1 AND purpose = 'STOP' ORDER BY id`, [setupId]),
    query(`SELECT id, status, client_order_id FROM order_placements WHERE setup_id = $1 AND purpose = 'EXIT' ORDER BY id`, [setupId]),
    query(`SELECT id, status FROM order_placements WHERE setup_id = $1 AND purpose = 'TARGET' ORDER BY id`, [setupId]),
    query(`SELECT stop_level::float AS stop_level, entry_zone_low::float AS entry_zone_low, setup_type FROM active_setups WHERE id = $1`, [setupId]),
  ]);
  return { entry: e.rows[0] || null, stops: st.rows, exits: ex.rows, targets: tg.rows, setup: su.rows[0] || null };
}

const alertSeen = new Map();
async function raise(setupId, gate, reason, sendAlert) {
  console.error(`[sierraChart.protection] ${gate} setup_id=${setupId}: ${reason}`);
  await persistExitGate(setupId, gate, reason);
  const key = `${gate}|${setupId}`;
  if (sendAlert && (!alertSeen.has(key) || Date.now() - alertSeen.get(key) > 10 * 60 * 1000)) {
    alertSeen.set(key, Date.now());
    try { await sendAlert(`Order protection: ${gate}`, `setup_id=${setupId} ${reason}`); } catch { /* the gate row is the record; a failed phone alert must not stop the repair */ }
  }
}

async function brokerConfirmsPosition(dtcClient, entry, collectWindowMs) {
  const acct = entry.trade_account || undefined;
  const snap = await getBrokerSnapshot(dtcClient, { collectWindowMs, tradeAccount: acct });
  if (snap.failed) return { known: false, reason: 'broker snapshot request failed (connection)', snap };
  const qty = extractPositionForSymbol(snap.positionMessages, entry.symbol, acct);
  const decision = brokerExitDecision({ brokerQty: qty, entrySide: entry.side, filledQuantity: entry.filled_quantity });
  return { known: qty != null, qty, ok: decision.ok, reason: decision.reason, snap };
}

/**
 * Escalation: a position that could not be protected. Halts the kill switch FIRST (no new risk while this is open), then asks the
 * ordinary exit path to flatten it (placeExitOrder keeps its broker-truth guard, so a position the broker does not hold is never sold).
 */
export async function flattenAndHalt(dtcClient, state, why, { killSwitch, sendAlert }) {
  const e = state.entry;
  try { killSwitch.halt(`unprotected position setup_id=${e.setup_id}: ${why}`, 'protection'); }
  catch (err) { console.error('[sierraChart.protection] could not halt the kill switch:', err.message); }
  await raise(e.setup_id, 'SIERRA_UNPROTECTED_FLATTEN', `${why} -- kill switch HALTED, flattening at market`, sendAlert);
  try {
    const r = await placeExitOrder(dtcClient, { setupId: e.setup_id, symbol: e.symbol, exchange: e.exchange, tradeAccount: e.trade_account, environmentService: e.environment_service });
    console.error(`[sierraChart.protection] setup_id=${e.setup_id}: flatten result ${JSON.stringify(r)}`);
    return { action: 'FLATTEN_REQUESTED', exit: r };
  } catch (err) {
    await raise(e.setup_id, 'SIERRA_FLATTEN_FAILED', `flatten threw: ${err.message}`, sendAlert);
    return { action: 'FLATTEN_FAILED', error: err.message };
  }
}

/**
 * Make one setup's position protected. Safe to call any time and from several places (fill handler, rejected exit, sweep): it does
 * nothing unless the position is open and unprotected. Returns { action }: NOOP:<class> | STOP_PLACED | STOP_RACE_LOST | BROKER_FLAT |
 * BROKER_UNKNOWN | FLATTEN_REQUESTED | FLATTEN_FAILED | NO_STOP_LEVEL_FLATTEN.
 *   skipBrokerCheck  only the fill handler's retry, where the broker just told us the entry filled
 *   ignoreDeadline   do not escalate to a flatten on this call (used by callers that retry shortly anyway)
 */
export async function ensureProtected(dtcClient, setupId, { killSwitch, sendAlert, reason = 'sweep', attempts = 3, retryDelayMs = 1000, skipBrokerCheck = false, verifyWindowMs = 1500, ignoreDeadline = false } = {}) {
  let state = await loadState(setupId);
  const cls = classifyProtection(state);
  if (cls !== 'UNPROTECTED') return { action: `NOOP:${cls}` };
  const e = state.entry;
  const unprotectedForMs = state.stops.length === 0 ? e.age_ms : Math.min(e.age_ms, Math.min(...state.stops.map((s) => s.age_ms)));
  const pastDeadline = !ignoreDeadline && unprotectedForMs >= PROTECTION_FLATTEN_DEADLINE_MS;

  const { stopPrice, adjusted, dist, plannedStop, fillPx } = resolveStopPrice({ entrySide: e.side, stopLevel: state.setup?.stop_level, entryLevel: state.setup?.entry_zone_low, fillPx: e.avg_fill_price });
  if (stopPrice == null) {
    return { ...(await flattenAndHalt(dtcClient, state, `filled entry has no stop level (${reason})`, { killSwitch, sendAlert })), why: 'NO_STOP_LEVEL' };
  }

  if (!skipBrokerCheck) {
    let b;
    try { b = await brokerConfirmsPosition(dtcClient, e, verifyWindowMs); }
    catch (err) { b = { known: false, reason: `broker read threw: ${err.message}` }; }
    if (!b.known) {
      await raise(setupId, 'SIERRA_UNPROTECTED_BROKER_UNKNOWN', `open filled entry with no working stop, broker position unreadable (${b.reason}); not placing a stop blind (${reason})`, sendAlert);
      if (pastDeadline) return flattenAndHalt(dtcClient, state, `unprotected ${Math.round(unprotectedForMs / 1000)}s and the broker position could not be read`, { killSwitch, sendAlert });
      return { action: 'BROKER_UNKNOWN' };
    }
    if (!b.ok) {
      // The broker does not hold this setup's side (flat or wrong sign/size): a stop here would be a naked order. Leave the existing
      // reconciliation (silent-close / invariant) to resolve the app's belief; record it.
      await raise(setupId, 'SIERRA_UNPROTECTED_BROKER_FLAT', `app shows an open unprotected position but the broker reads ${b.qty}: ${b.reason}; no stop placed (${reason})`, sendAlert);
      return { action: 'BROKER_FLAT', brokerQty: b.qty };
    }
  }

  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) { await new Promise((r) => setTimeout(r, retryDelayMs)); state = await loadState(setupId); if (classifyProtection(state) !== 'UNPROTECTED') return { action: `NOOP:${classifyProtection(state)}` }; }
    const clientOrderId = nextStopClientOrderId(setupId, state.stops);
    try {
      if (adjusted && i === 0) await persistExitGate(setupId, 'SIERRA_STOP_ADJUSTED', `fill ${fillPx} past planned stop ${plannedStop}; stop placed at ${stopPrice} (risk distance ${dist}pt kept)`);
      const r = await placeStopOrder(dtcClient, {
        setupId, stopPrice, entrySide: e.side, filledQuantity: e.filled_quantity, symbol: e.symbol, exchange: e.exchange,
        tradeAccount: e.trade_account, environmentService: e.environment_service, clientOrderId,
      });
      if (!r) return { action: 'STOP_RACE_LOST' }; // another caller inserted first, or a stop is still on its way out: the next sweep re-checks
      if (state.stops.length > 0 || reason !== 'entry-fill') await raise(setupId, 'SIERRA_STOP_REPLACED', `stop ${r.clientOrderId} placed at ${stopPrice} (${reason}; previous stop rows: ${state.stops.map((s) => `${s.client_order_id}=${s.status}`).join(', ') || 'none'})`, sendAlert);
      return { action: 'STOP_PLACED', clientOrderId: r.clientOrderId, stopPrice };
    } catch (err) {
      lastErr = err;
      console.error(`[sierraChart.protection] setup_id=${setupId}: stop placement attempt ${i + 1}/${attempts} threw: ${err.message}`);
    }
  }
  await raise(setupId, 'SIERRA_STOP_FAILED', `stop could not be placed after ${attempts} attempts (${reason}): ${lastErr?.message}`, sendAlert);
  if (pastDeadline) return flattenAndHalt(dtcClient, state, `stop could not be placed and the position has been unprotected ${Math.round(unprotectedForMs / 1000)}s`, { killSwitch, sendAlert });
  return { action: 'STOP_FAILED', error: lastErr?.message };
}

let lastBrokerVerifyAt = 0;
/** Test hook. */
export function _resetProtectionSweepStateForTests() { lastBrokerVerifyAt = 0; alertSeen.clear(); }

/**
 * Periodic sweep (connectionManager calls it every ~20 s while logged on, and once after every logon reconcile). Cheap when there is
 * nothing open: one indexed query. For each open filled entry: repair if unprotected; otherwise, at most once per BROKER_VERIFY_EVERY_MS,
 * check that the working stop is really in the broker's open-order list.
 */
export async function runProtectionSweep(dtcClient, { killSwitch, sendAlert, now = Date.now } = {}) {
  if (!dtcClient || !dtcClient.isLive || !dtcClient.isLive()) return { skipped: 'not live' };
  const open = await query(`
    SELECT setup_id FROM order_placements
    WHERE purpose = 'ENTRY' AND position_open = TRUE AND filled_quantity > 0
      AND COALESCE(last_update_at, submitted_at) <= now() - make_interval(secs => $1::float)
    ORDER BY setup_id`, [PROTECTION_FILL_GRACE_MS / 1000]);
  const results = [];
  const verifyNow = open.rows.length > 0 && now() - lastBrokerVerifyAt >= BROKER_VERIFY_EVERY_MS;
  let brokerOpenOrders = null;
  if (verifyNow) {
    lastBrokerVerifyAt = now();
    try { const snap = await getBrokerSnapshot(dtcClient, { collectWindowMs: 1500 }); if (!snap.failed) brokerOpenOrders = snap.openOrders; }
    catch (err) { console.error('[sierraChart.protection] broker open-orders read failed:', err.message); }
  }
  for (const { setup_id: setupId } of open.rows) {
    try {
      let state = await loadState(setupId);
      let cls = classifyProtection(state);
      if (cls === 'PROTECTED' && brokerOpenOrders) {
        const stop = [...state.stops].reverse().find((s) => STOP_WORKING_STATUSES.includes(s.status));
        const atBroker = brokerOpenOrders.some((o) => o.ClientOrderID === stop.client_order_id || (stop.server_order_id && o.ServerOrderID === stop.server_order_id));
        // Only a stop the app has believed working for a while, and only when the broker confirms the position, counts as lost.
        if (!atBroker && stop.age_ms >= PROTECTION_FILL_GRACE_MS && stop.status !== 'PENDING_CHILD') {
          const b = await brokerConfirmsPosition(dtcClient, state.entry, 1500).catch(() => ({ known: false }));
          if (b.known && b.ok) {
            await raise(setupId, 'SIERRA_STOP_LOST', `stop ${stop.client_order_id} (${stop.status}) is not in the broker's open orders while the broker holds the position; marking it CANCELED (a late FILLED can still correct it) and replacing it`, sendAlert);
            await query(`UPDATE order_placements SET status = 'CANCELED', reject_reason = 'not at broker (protection sweep)', last_update_at = now() WHERE id = $1 AND status = $2`, [stop.id, stop.status]);
            state = await loadState(setupId); cls = classifyProtection(state);
          }
        }
      }
      if (cls === 'UNPROTECTED') results.push({ setupId, ...(await ensureProtected(dtcClient, setupId, { killSwitch, sendAlert, reason: 'sweep' })) });
      else results.push({ setupId, action: `NOOP:${cls}` });
    } catch (err) {
      console.error(`[sierraChart.protection] sweep failed for setup_id=${setupId}:`, err.message);
      results.push({ setupId, action: 'ERROR', error: err.message });
    }
  }
  return { checked: open.rows.length, results };
}
