// Sierra Chart order-placement dashboard's backend surface. Thin route file only --
// no logic lives here, everything delegates to server/services/sierraChart/*.js, per
// this codebase's own "routes are thin, logic lives in services" convention.

import express from 'express';
import { query } from '../db.js';
import { getClient, getStatus } from '../services/sierraChart/connectionManager.js';
import { killSwitch, KILL_SWITCH_STATE_PATH } from '../services/sierraChart/orderEligibility.js';
import { panicStopAppOrders, runReconciliation, cancelUnknownOrders } from '../services/sierraChart/reconciliation.js';
import { resolveMnqFrontMonthSymbol } from '../services/sierraChart/contractSymbol.js';

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
    res.json({
      connection: getStatus(),
      contract,
      killSwitchStateFile: KILL_SWITCH_STATE_PATH,
      recentOrders: recentQ.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
