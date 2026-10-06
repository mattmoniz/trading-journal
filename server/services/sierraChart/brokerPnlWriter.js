// Writes a trade's broker-derived P&L (added 2026-10-06, NOT yet wired into the live close path).
// Only writes when BOTH the entry fill and the exit (stop or market exit) fill are present in the broker
// record. Otherwise it writes nothing, so a gap is never turned into a number. Sets pnl_source = 'BROKER'.
import { query } from '../../db.js';
import { brokerPnlFromFills } from './brokerPnl.js';

export async function recordBrokerPnlForSetup(setupId, db = { query }) {
  const r = await db.query(`
    SELECT e.side AS entry_side, e.avg_fill_price::float AS entry_avg,
      (SELECT x.avg_fill_price::float FROM order_placements x
        WHERE x.setup_id = $1 AND x.purpose IN ('STOP','EXIT') AND x.status = 'FILLED'
        ORDER BY x.id DESC LIMIT 1) AS exit_avg
    FROM order_placements e
    WHERE e.setup_id = $1 AND e.purpose = 'ENTRY' AND e.status = 'FILLED'
    ORDER BY e.id DESC LIMIT 1`, [setupId]);
  const row = r.rows[0];
  if (!row) return { written: false, reason: 'no filled entry' };
  const pnl = brokerPnlFromFills({ entrySide: row.entry_side, entryAvg: row.entry_avg, exitAvg: row.exit_avg });
  if (pnl == null) return { written: false, reason: 'missing entry or exit fill price' };
  await db.query(`UPDATE active_setups SET broker_pnl = $2, pnl_source = 'BROKER' WHERE id = $1`, [setupId, pnl]);
  return { written: true, pnl };
}
