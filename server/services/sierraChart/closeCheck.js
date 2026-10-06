// Close verification (added 2026-10-06, report-only, never halts or changes a trade).
// The app decides a trade is closed on its own price logic. This checks the broker's own records
// agree: a live trade whose entry filled should have a broker exit or stop that FILLED. If the app
// shows the trade closed but no broker close is recorded, it is flagged so it can be reviewed.

import { query } from '../../db.js';

// Pure rule, so it can be tested without a database.
export function classifyClose({ entryFilled, appClosed, brokerCloseFilled }) {
  if (!entryFilled) return 'NO_ENTRY_FILL';          // nothing was ever at risk
  if (!appClosed) return 'STILL_OPEN';               // app has not closed it yet
  return brokerCloseFilled ? 'CONFIRMED' : 'CLOSE_NOT_CONFIRMED';
}

// Live trades (origin ACTIVE) the app has closed in the last 2 days but the broker has no filled
// exit or stop for. Read-only.
export async function findUnconfirmedCloses() {
  const r = await query(`
    SELECT s.id AS setup_id, s.setup_type, s.resolution, s.resolution_method, s.actual_pnl::float AS pnl,
      s.resolved_at::text AS resolved_at, s.trade_date::text AS trade_date,
      EXISTS (SELECT 1 FROM order_placements e WHERE e.setup_id = s.id AND e.purpose = 'ENTRY' AND e.status = 'FILLED') AS entry_filled,
      EXISTS (SELECT 1 FROM order_placements c WHERE c.setup_id = s.id AND c.purpose IN ('EXIT','STOP') AND c.status = 'FILLED') AS broker_close_filled
    FROM active_setups s
    WHERE s.origin_status = 'ACTIVE' AND s.status = 'RESOLVED'
      AND s.resolved_at >= NOW() - INTERVAL '2 days'
      AND EXISTS (SELECT 1 FROM order_placements e0 WHERE e0.setup_id = s.id AND e0.purpose = 'ENTRY')
    ORDER BY s.resolved_at DESC`);
  return r.rows
    .map(row => ({ ...row, verdict: classifyClose({ entryFilled: row.entry_filled, appClosed: true, brokerCloseFilled: row.broker_close_filled }) }))
    .filter(row => row.verdict === 'CLOSE_NOT_CONFIRMED');
}
