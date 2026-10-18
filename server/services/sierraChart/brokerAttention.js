// Plain-English "this needs you" messages for broker-side problems the app could not fix itself
// (added 2026-10-18, user request: "if that issue can't be resolved, it should notify me before the
// second issue happens"). Stored as gated_candidates rows (gate_name 'BROKER_ATTENTION') so it is
// queryable and survives restarts. An item stays active until a later reconciliation records a
// matching broker/app position (invariant_match = true).
import { query } from '../../db.js';

const KINDS = {
  EXTRA_EXPOSURE: {
    title: 'The broker holds a different position than this app expects -- real orders are paused',
    steps: [
      'Open Sierra Chart and look at the real position and any open orders for MNQ.',
      'If a position is there that you did not intend, flatten it in Sierra.',
      'Then tell Claude "reset the broker baseline" so the app counts from the real position. On sim accounts, trading re-arms by itself once the app and broker agree.',
    ],
  },
  MULTIPLE_OPEN_TRADES_UNCLEAR: {
    title: 'The broker changed position but the app cannot tell which of several trades closed',
    steps: [
      'Open Sierra Chart and check the position and recent Trade Activity.',
      'If you flattened or reversed by hand, that is the cause. Tell Claude which trades you closed, or say "reset the broker baseline" if the broker is flat.',
    ],
  },
  CLOSE_NOT_FIXABLE: {
    title: 'A trade closed at the broker and the app could not record how',
    steps: [
      'Check Sierra Chart Trade Activity for that trade\'s real exit price and tell Claude, or say "reset the broker baseline" if you just want to move on.',
    ],
  },
};

export async function raiseBrokerAttention(kind, detail) {
  const k = KINDS[kind];
  if (!k) throw new Error(`unknown broker attention kind ${kind}`);
  const reason = JSON.stringify({ kind, title: k.title, steps: k.steps, detail });
  await query(`
    INSERT INTO gated_candidates (trade_date, setup_type, gate_name, gate_reason)
    SELECT CURRENT_DATE, 'BROKER'::varchar, 'BROKER_ATTENTION', $1::text
    WHERE NOT EXISTS (SELECT 1 FROM gated_candidates g WHERE g.gate_name = 'BROKER_ATTENTION'
      AND g.gate_reason LIKE '{"kind":"' || $2::text || '"%' AND g.evaluated_at > NOW() - interval '30 minutes')
  `, [reason, kind]).catch((err) => console.error('[sierraChart.brokerAttention] failed to persist:', err.message));
}

// Latest unresolved item, or null. Resolved once a later reconciliation shows app and broker agreeing.
export async function getBrokerAttention() {
  const r = await query(`
    SELECT g.gate_reason, TO_CHAR(g.evaluated_at, 'YYYY-MM-DD HH24:MI') AS since
    FROM gated_candidates g
    WHERE g.gate_name = 'BROKER_ATTENTION' AND g.evaluated_at >= NOW() - interval '24 hours'
      AND NOT EXISTS (SELECT 1 FROM sierra_chart_reconciliation_log l
                      WHERE l.invariant_match = TRUE AND l.checked_at > g.evaluated_at)
    ORDER BY g.evaluated_at DESC LIMIT 1`);
  if (!r.rows[0]) return null;
  try { return { ...JSON.parse(r.rows[0].gate_reason), since: r.rows[0].since }; } catch { return null; }
}
