// Daily loss limit gate for real entries (added 2026-10-06, NOT yet wired into the entry path).
// Uses the day's realized P&L from BROKER fills (broker_pnl, when present), not the app's model. A trade
// with no broker P&L yet is not counted as zero: it is reported in `unknownCount` so the gate can say so.
//
// FIXED 2026-10-07 (DeepSeek review finding M2): a trade closed today with no broker_pnl recorded yet
// (reconciliation lag/failure) used to be reported in unknownCount but never blocked -- a real loss could
// sit hidden past the limit while reconciliation was behind. unknownCount > 0 now blocks, matching the
// fail-closed intent this function already states for the limit variable itself.
// CHANGED 2026-10-18 (user: no live trades Thu/Fri): "unknownCount > 0 blocks everything" turned ONE
// trade missing broker P&L into a block that lasted ~36h (RTH_VWAP_FADE_SHORT 135660 never got an exit
// row, so its broker_pnl never arrived; 67 real entries were skipped on this reason alone). The fail-
// closed intent -- a hidden loss must not sit past the limit -- is kept, but unknown trades are now
// counted at their WORST CASE (full stop risk, `unknownWorstCaseLoss`, positive dollars) instead of
// blocking outright: known P&L minus that worst case must still be inside the limit. Callers that
// don't pass `unknownWorstCaseLoss` keep the old behavior (any unknown blocks).
import { LIVE_INSTRUMENT } from '../../config/instruments.js';

// The wording of the "cannot compute a worst case" block. brokerAttention.js matches on this exact text to raise the
// ENTRIES_BLOCKED_BY_DATA_GAP banner, so it is one shared constant (DeepSeek review 2026-10-19, finding 4: a wording edit here
// would otherwise silently disable the banner).
export const DLL_DATA_GAP_TEXT = 'cannot confirm the account is within limit';

export function dllGateDecision({ realizedBrokerPnl, unknownCount = 0, limit, unknownWorstCaseLoss = null, unknownNote = '' }) {
  if (!Number.isFinite(limit) || limit <= 0) return { blocked: false, reason: 'no limit configured' };
  if (!Number.isFinite(realizedBrokerPnl)) return { blocked: false, reason: 'no broker P&L yet -- cannot evaluate' };
  if (realizedBrokerPnl <= -limit) {
    return { blocked: true, reason: `daily broker loss ${realizedBrokerPnl.toFixed(2)} reached limit -${limit}` };
  }
  if (unknownCount > 0 && Number.isFinite(unknownWorstCaseLoss)) {
    const worst = realizedBrokerPnl - unknownWorstCaseLoss;
    if (worst <= -limit) {
      return { blocked: true, reason: `${unknownCount} trade(s) without broker P&L${unknownNote}; known ${realizedBrokerPnl.toFixed(2)} minus worst-case ${unknownWorstCaseLoss.toFixed(2)} reaches limit -${limit}` };
    }
    return { blocked: false, reason: `within limit counting ${unknownCount} trade(s) without broker P&L at worst case (-${unknownWorstCaseLoss.toFixed(2)})` };
  }
  if (unknownCount > 0) {
    return { blocked: true, reason: `${unknownCount} trade(s) still without broker P&L -- ${DLL_DATA_GAP_TEXT}${unknownNote}` };
  }
  return { blocked: false, reason: 'within limit' };
}

// Entry price used for an unknown trade's worst case: the recorded fill, else (2026-10-19) the entry order's own
// price (a limit fills at or better than it, so the stop distance from it is an upper bound), else the setup's
// entry level. Before this, ONE fill stored without a price (multiplier lookup failed, see priceMultiplier.js) had
// no computable worst case and the gate refused every entry for ~7h. A trade with no stop, or no entry price of
// any kind, still falls back to block-everything -- the fail-closed intent is unchanged.
export const DLL_ROW_SQL = `
    WITH slip AS (
      -- Rolling adverse-slippage allowance (DeepSeek review 2026-10-19, finding 1): a LIMIT that "market-executes" or a MARKET entry
      -- can fill worse than the price we fall back on. Derived from the account's own last 30 days of priced entries -- the 95th
      -- percentile distance between the setup's entry level and the real fill -- not a hardcoded number.
      SELECT COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ABS(x.avg_fill_price - s.entry_zone_low)), 0)::float AS p
      FROM order_placements x JOIN active_setups s ON s.id = x.setup_id
      WHERE x.purpose = 'ENTRY' AND x.status = 'FILLED' AND x.avg_fill_price IS NOT NULL AND s.entry_zone_low IS NOT NULL
        AND x.created_at > NOW() - interval '30 days'
    )
    SELECT COALESCE(SUM(a.broker_pnl), 0)::float AS realized,
           COUNT(*) FILTER (WHERE a.broker_pnl IS NULL AND a.status <> 'ACTIVE')::int AS unknown,
           COALESCE(SUM((ABS(COALESCE(e.avg_fill_price, NULLIF(e.price1, 0), a.entry_zone_low) - a.stop_level)
                         + CASE WHEN e.avg_fill_price IS NULL THEN slip.p ELSE 0 END)
                        * GREATEST(COALESCE(e.filled_quantity, 0), 1) * $2)
             FILTER (WHERE a.broker_pnl IS NULL AND a.status <> 'ACTIVE' AND a.stop_level IS NOT NULL
                     AND COALESCE(e.avg_fill_price, NULLIF(e.price1, 0), a.entry_zone_low) IS NOT NULL), 0)::float AS unknown_worst,
           -- A trade with no stop OR no entry price of any kind has no computable worst case (ABS(NULL - x) is NULL and
           -- SUM would silently drop it as $0 risk -- DeepSeek review finding 1), so it falls back to block-everything.
           -- NULLIF(price1, 0): an escalated MARKET entry stores price1 = 0 (reconciliation.js), which is "no price", not price zero.
           COUNT(*) FILTER (WHERE a.broker_pnl IS NULL AND a.status <> 'ACTIVE'
                     AND (a.stop_level IS NULL OR COALESCE(e.avg_fill_price, NULLIF(e.price1, 0), a.entry_zone_low) IS NULL))::int AS unknown_no_stop,
           COUNT(*) FILTER (WHERE a.broker_pnl IS NULL AND a.status <> 'ACTIVE' AND e.avg_fill_price IS NULL)::int AS unknown_price_estimated,
           COALESCE(ARRAY_AGG(a.id) FILTER (WHERE a.broker_pnl IS NULL AND a.status <> 'ACTIVE'), '{}') AS unknown_ids
    FROM active_setups a
    JOIN order_placements e ON e.setup_id = a.id AND e.purpose = 'ENTRY' AND e.status = 'FILLED' AND e.trade_account = $1
    CROSS JOIN slip
    WHERE a.trade_date = CURRENT_DATE AND a.origin_status = 'ACTIVE'
  `;

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
  const r = await query(DLL_ROW_SQL, [tradeAccount, LIVE_INSTRUMENT.dollarsPerPoint]);
  const row = r.rows[0];
  // A trade with no stop on record has no computable worst case -> fall back to the old fail-closed block.
  const worst = row.unknown_no_stop > 0 ? null : row.unknown_worst;
  const estNote = row.unknown_price_estimated > 0 && row.unknown_no_stop === 0 ? ` [entry fill price missing on ${row.unknown_price_estimated} trade(s); worst case uses the order/setup entry price plus a rolling slippage allowance]` : '';
  // Say WHY the P&L is unknown (brokerPnlResolver.js), so this reads as a data problem, not a loss-limit one.
  let unknownNote = '';
  if (row.unknown_ids.length) {
    const c = await query(`
      SELECT DISTINCT ON (sid) sid, gate_reason FROM (
        SELECT (regexp_match(gate_reason, '^setup_id=([0-9]+) '))[1]::int AS sid, gate_reason, evaluated_at
        FROM gated_candidates WHERE gate_name = 'PNL_UNKNOWN_CAUSE' AND evaluated_at >= NOW() - interval '4 days') g
      WHERE sid = ANY($1) ORDER BY sid, evaluated_at DESC`, [row.unknown_ids]);
    unknownNote = c.rows.length
      ? ' [NOT a loss-limit breach; cause: ' + c.rows.map(x => x.gate_reason.replace(/^setup_id=\d+ /, '').split(':')[0]).join(', ') + ']'
      : ' [cause not diagnosed yet]';
  }
  return dllGateDecision({ realizedBrokerPnl: row.realized, unknownCount: row.unknown, limit, unknownWorstCaseLoss: worst, unknownNote: unknownNote + estNote });
}
