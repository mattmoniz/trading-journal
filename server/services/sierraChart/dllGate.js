// Daily loss limit gate for real entries (added 2026-10-06, NOT yet wired into the entry path).
// Uses the day's realized P&L from BROKER fills (broker_pnl, when present), not the app's model. A trade
// with no broker P&L yet is not counted as zero: it is reported in `unknownCount` so the gate can say so.
export function dllGateDecision({ realizedBrokerPnl, unknownCount = 0, limit }) {
  if (!Number.isFinite(limit) || limit <= 0) return { blocked: false, reason: 'no limit configured' };
  if (!Number.isFinite(realizedBrokerPnl)) return { blocked: false, reason: 'no broker P&L yet -- cannot evaluate' };
  if (realizedBrokerPnl <= -limit) {
    return { blocked: true, reason: `daily broker loss ${realizedBrokerPnl.toFixed(2)} reached limit -${limit}` };
  }
  return { blocked: false, reason: unknownCount > 0 ? `${unknownCount} trade(s) still without broker P&L` : 'within limit' };
}

// Wiring (2026-10-07, item 7). The limit comes from DTC_DLL_LIMIT_USD, not account_settings: no
// row exists for the Sierra trade accounts, and this gate is real-order-only. Fails CLOSED when
// the variable is unset or not positive, since an unknown limit must not allow a real entry.
// Realized P&L is the sum of broker_pnl for today's filled entries on this trade account.
export async function evaluateDailyLossLimit(tradeAccount) {
  const { query } = await import('../../db.js');
  const limit = Number(process.env.DTC_DLL_LIMIT_USD);
  if (!Number.isFinite(limit) || limit <= 0) {
    return { blocked: true, reason: 'DTC_DLL_LIMIT_USD is not set to a positive number -- entries blocked until configured' };
  }
  const r = await query(`
    SELECT COALESCE(SUM(a.broker_pnl), 0)::float AS realized,
           COUNT(*) FILTER (WHERE a.broker_pnl IS NULL AND a.status <> 'ACTIVE')::int AS unknown
    FROM active_setups a
    JOIN order_placements e ON e.setup_id = a.id AND e.purpose = 'ENTRY' AND e.status = 'FILLED' AND e.trade_account = $1
    WHERE a.trade_date = CURRENT_DATE AND a.origin_status = 'ACTIVE'
  `, [tradeAccount]);
  const row = r.rows[0];
  return dllGateDecision({ realizedBrokerPnl: row.realized, unknownCount: row.unknown, limit });
}
