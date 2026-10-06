// Sierra Chart order-placement dashboard's backend surface. Thin route file only --
// no logic lives here, everything delegates to server/services/sierraChart/*.js, per
// this codebase's own "routes are thin, logic lives in services" convention.

import express from 'express';
import { query } from '../db.js';
import { getClient, getStatus } from '../services/sierraChart/connectionManager.js';
import { killSwitch, KILL_SWITCH_STATE_PATH } from '../services/sierraChart/orderEligibility.js';
import { panicStopAppOrders, runReconciliation, cancelUnknownOrders } from '../services/sierraChart/reconciliation.js';
import { resolveMnqFrontMonthSymbol } from '../services/sierraChart/contractSymbol.js';
import { findUnconfirmedCloses } from '../services/sierraChart/closeCheck.js';

const router = express.Router();

// GET /api/sierra-chart/status -- everything the dashboard needs in one call.
router.get('/sierra-chart/status', async (req, res) => {
  try {
    const todayQ = await query(`SELECT CURRENT_DATE::text as today`);
    const contract = resolveMnqFrontMonthSymbol(todayQ.rows[0].today);
    const recentQ = await query(`
      SELECT id, setup_id, purpose, client_order_id, server_order_id, symbol, exchange, side,
        order_type, quantity, price1, status, filled_quantity, avg_fill_price, reject_reason,
        submitted_at::text as submitted_at, last_update_at::text as last_update_at
      FROM order_placements ORDER BY id DESC LIMIT 25
    `);
    // Close verification (2026-10-06): trades the app shows closed with no broker exit/stop filled.
    // Report-only; a failed check is reported as null, never hidden as "none".
    const unconfirmedCloses = await findUnconfirmedCloses().catch(() => null);
    res.json({
      connection: getStatus(),
      contract,
      killSwitchStateFile: KILL_SWITCH_STATE_PATH,
      recentOrders: recentQ.rows,
      unconfirmedCloses,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sierra-chart/summary -- plain-text block for Home Assistant's markdown card
// (same convention as /api/setups/today-summary: HA's REST sensor can't iterate JSON).
// Exposed through the Cloudflare tunnel via an exact-path rule; keep it text-only.
router.get('/sierra-chart/summary', (req, res) => {
  const armed = killSwitch.isArmed();
  const st = killSwitch.getState();
  const lines = [
    armed ? '🟢 ARMED — placing real orders on Sim1' : '🔴 DISARMED — no real orders will be placed',
  ];
  if (!armed && st.haltedReason) lines.push(`Reason: ${st.haltedReason}${st.haltedAt ? ' at ' + st.haltedAt : ''}`);
  res.type('text/plain').send(lines.join('\n') + '\n');
});

// GET /api/sierra-chart/activity -- one chronological log of everything that touched the broker
// and every app-side state change, newest first. Read-only. Built from stored records only:
// order_placements (app's own state) and order_placements_updates (every raw broker message).
router.get('/sierra-chart/activity', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const r = await query(`
      SELECT * FROM (
        SELECT CASE WHEN u.client_order_id LIKE 'UNOWNED:%' THEN 'MANUAL' WHEN op.id IS NULL THEN 'OTHER' ELSE 'APP' END AS source,
          u.received_at::text AS at, u.client_order_id AS ref,
          op.setup_id, op.purpose,
          CASE (u.raw_message::jsonb->>'OrderStatus')
            WHEN '1' THEN 'ORDER_SENT' WHEN '2' THEN 'PENDING_OPEN' WHEN '4' THEN 'OPEN'
            WHEN '7' THEN 'FILLED' WHEN '8' THEN 'CANCELED' WHEN '9' THEN 'REJECTED' ELSE 'STATUS_' || COALESCE(u.raw_message::jsonb->>'OrderStatus','?') END AS event,
          u.raw_message::jsonb->>'AverageFillPrice' AS raw_fill, u.raw_message::jsonb->>'FilledQuantity' AS qty,
          u.raw_message::jsonb->>'InfoText' AS info
        FROM order_placements_updates u
        LEFT JOIN order_placements op ON op.client_order_id = u.client_order_id
        UNION ALL
        SELECT 'APP', op.submitted_at::text, op.client_order_id, op.setup_id, op.purpose,
          'SUBMITTED ' || op.order_type || ' ' || op.side || ' px ' || COALESCE(op.price1::text, 'mkt'), NULL, NULL, NULL
        FROM order_placements op
        UNION ALL
        SELECT 'APP', s.resolved_at::text, NULL, s.id, NULL,
          'APP CLOSED ' || COALESCE(s.resolution, '?') || ' pnl ' || COALESCE(s.actual_pnl::text, 'n/a'), NULL, NULL, NULL
        FROM active_setups s WHERE s.origin_status = 'ACTIVE' AND s.resolved_at IS NOT NULL
      ) ev
      ORDER BY at DESC NULLS LAST LIMIT $1`, [limit]);
    res.json({ events: r.rows, generatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sierra-chart/halt -- HALT ONLY. Stops new real entries; it deliberately does NOT
// cancel orders, flatten positions, or touch the broker (that is /stop, which is far more
// than a halt). Exit orders never go through the kill switch, so open trades can still
// close normally. Safe to expose remotely (Home Assistant button) since it only de-risks.
router.post('/sierra-chart/halt', (req, res) => {
  killSwitch.halt('manual halt (remote button)', req.body?.by || 'remote-halt-button');
  res.json({ ok: true, state: killSwitch.getState() });
});

// POST /api/sierra-chart/start -- arm the kill switch. Nothing retroactive needed: the
// next poll's order sweep (orderSweep.js) already checks isOrderEligible() fresh every
// time, so the very next real setup to fire is picked up automatically.
router.post('/sierra-chart/start', (req, res) => {
  killSwitch.arm(req.body?.by || 'dashboard');
  res.json({ ok: true, state: killSwitch.getState() });
});

// POST /api/sierra-chart/stop -- halt new entries, cancel/flatten every position this
// app itself has open (never touching other orders on the account), then verify against
// the broker's own confirmed state. Scoped to this app's own order_placements rows only
// -- explicit user decision, 2026-09-29 (the target account has unrelated pre-existing
// activity on it that must never be touched by this button).
router.post('/sierra-chart/stop', async (req, res) => {
  const client = getClient();
  if (!client || !client.isLive()) {
    // Still halt even if we can't reach the broker right now -- "stop new" doesn't need
    // a live connection, only cancel/flatten does.
    killSwitch.halt('manual stop (dashboard, DTC not live)', req.body?.by || 'user');
    return res.status(503).json({ ok: false, error: 'DTC connection not live -- new entries halted, but cannot cancel/flatten without a live connection. Check Sierra Chart directly.', killSwitchState: killSwitch.getState() });
  }
  try {
    const report = await panicStopAppOrders(client, killSwitch);
    res.status(report.verified ? 200 : 207).json(report); // 207 Multi-Status: some actions may not be confirmed yet
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sierra-chart/reconcile -- on-demand broker-truth comparison (the dashboard's
// own manual-recheck button). Routed through the same runReconciliation() every other
// trigger (logon/terminal-transition/periodic) uses -- 2026-09-29 "Item 1" -- so a
// manual check also persists to sierra_chart_reconciliation_log and applies the same
// unknownToApp halt, rather than being a separate, unpersisted read-only path.
router.get('/sierra-chart/reconcile', async (req, res) => {
  const client = getClient();
  if (!client || !client.isLive()) return res.status(503).json({ error: 'DTC connection not live.' });
  try {
    const todayQ = await query(`SELECT CURRENT_DATE::text as today`);
    const contract = resolveMnqFrontMonthSymbol(todayQ.rows[0].today);
    const result = await runReconciliation(client, killSwitch, contract.orderSymbol, 'MANUAL');
    res.json(result.reconciliationReport);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sierra-chart/cancel-unknown-orders -- cancels every order currently in a
// FRESH reconciliation's unknownToApp list (never a caller-supplied/stale one). Only
// ever touches orders this app genuinely never placed -- see cancelUnknownOrders()'s
// own header for why that's safe by construction, not just by inspection.
router.post('/sierra-chart/cancel-unknown-orders', async (req, res) => {
  const client = getClient();
  if (!client || !client.isLive()) return res.status(503).json({ error: 'DTC connection not live.' });
  try {
    res.json(await cancelUnknownOrders(client));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
