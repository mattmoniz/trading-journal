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
