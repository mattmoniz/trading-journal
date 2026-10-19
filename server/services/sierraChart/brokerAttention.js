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
  UNPRICED_FILL: {
    title: 'A real fill has no price recorded -- the app cannot size its risk and may stop taking new entries',
    steps: [
      'The app retries the price lookup by itself every few seconds; this clears on its own once the price is filled in.',
      'If it is still here after a few minutes, tell Claude "unpriced fill" -- the cause is usually the price multiplier for a new contract month not being learned.',
    ],
  },
  ENTRIES_BLOCKED_BY_DATA_GAP: {
    title: 'New entries are being refused by the daily-loss check because trade data is missing -- NOT because the loss limit was reached',
    steps: [
      'Real losses are not the cause. The check cannot confirm today\'s P&L because a trade is missing a price or broker P&L.',
      'Tell Claude "entries blocked by data gap" -- it will find the trade and repair it. Nothing needs to be done in Sierra Chart.',
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

// Conditions computed from CURRENT state, so they clear the moment the data is repaired -- nothing to
// resolve by hand (added 2026-10-19 after one unpriced fill silently blocked every entry for ~7h; the only
// trace was SIERRA_ENTRY_SKIP rows nobody looks at).
export async function getLiveDataAttention(db = { query }) {
  const unpriced = await db.query(`
    SELECT setup_id, purpose, TO_CHAR(MIN(last_update_at), 'YYYY-MM-DD HH24:MI') AS since
    FROM order_placements
    WHERE status = 'FILLED' AND avg_fill_price IS NULL AND filled_quantity > 0
      AND created_at > NOW() - interval '24 hours' AND last_update_at < NOW() - interval '2 minutes'
    GROUP BY setup_id, purpose ORDER BY MIN(last_update_at) LIMIT 5`);
  if (unpriced.rows.length) {
    const first = unpriced.rows[0];
    return { kind: 'UNPRICED_FILL', ...KINDS.UNPRICED_FILL, since: first.since,
      detail: unpriced.rows.map(r => `setup ${r.setup_id} ${r.purpose}`).join(', ') };
  }
  const blocked = await db.query(`
    SELECT TO_CHAR(MIN(evaluated_at), 'YYYY-MM-DD HH24:MI') AS since, COUNT(*)::int AS n FROM gated_candidates
    WHERE gate_name = 'SIERRA_ENTRY_SKIP' AND evaluated_at > NOW() - interval '15 minutes'
      AND gate_reason LIKE '%daily loss limit:%' AND gate_reason LIKE '%cannot confirm the account is within limit%'`);
  if (blocked.rows[0].n > 0) {
    return { kind: 'ENTRIES_BLOCKED_BY_DATA_GAP', ...KINDS.ENTRIES_BLOCKED_BY_DATA_GAP, since: blocked.rows[0].since,
      detail: `${blocked.rows[0].n} entries refused in the last 15 minutes` };
  }
  return null;
}

// Latest unresolved item, or null. Resolved once a later reconciliation shows app and broker agreeing.
export async function getBrokerAttention() {
  const live = await getLiveDataAttention();
  if (live) return live;
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
