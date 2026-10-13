// Shared read/dismiss logic for the order-lifecycle watcher's alert state (2026-10-13, user
// request). check_order_lifecycle_health.mjs (cron, every 5min) persists the raw state as a
// performance_audit signal_type='ORDER_LIFECYCLE_HEALTH'/signal_name='LATEST' row, including a
// `signature` field (a JSON fingerprint of the exact rows/detail causing each category -- see
// that script's buildSignature() for why). This file is the ONE place that decides whether the
// alert should currently be SHOWN, given that raw state plus any dismissal -- both
// GET /api/setups/today-summary (the HA "Session Timeline" card) and GET /api/setups/live-flags
// (quick-check.html's banner) call getOrderLifecycleAlertState() instead of each re-deriving
// their own version of "is this dismissed," so a dismiss from either surface is honored by both
// (the user wants ONE alert concept, shown in two places, not two independently-tracked ones).
//
// Dismiss semantics (user's own framing): hides the CURRENT problem, but comes back if EITHER
// the exact same problem is still there after DISMISS_WINDOW_MIN, OR anything about the
// problem changes (a different stuck order, a new reconciliation mismatch) -- the latter is
// enforced by comparing signatures, not by time alone. 45min is the midpoint of the user's own
// stated "30-60min" range for the time-based side of this -- easy to retune if it's not right.
import { query } from '../db.js';

const DISMISS_WINDOW_MIN = 45;
const STALE_WATCHER_MIN = 15; // matches today-summary's pre-existing staleness threshold

async function getLatestHealthRow() {
  const r = await query(`
    SELECT sample_size, notes, created_at::text FROM performance_audit
    WHERE signal_type='ORDER_LIFECYCLE_HEALTH' AND signal_name='LATEST'
    ORDER BY created_at DESC LIMIT 1
  `);
  return r.rows[0] || null;
}

async function getLatestDismissRow() {
  const r = await query(`
    SELECT notes FROM performance_audit
    WHERE signal_type='ORDER_LIFECYCLE_DISMISS' AND signal_name='LATEST'
    ORDER BY created_at DESC LIMIT 1
  `);
  return r.rows[0] || null;
}

// Returns { hasIssue, stale, message, signature } -- message/signature are null whenever
// there's nothing to show (clean, or dismissed and still within the dismiss window with a
// matching signature). `signature` is what a dismiss button sends back to dismissOrder
// LifecycleAlert() below; the caller never needs to understand its internal shape.
export async function getOrderLifecycleAlertState() {
  const row = await getLatestHealthRow();
  if (!row) return { hasIssue: false, stale: false, message: null, signature: null };

  const n = JSON.parse(row.notes || '{}');
  const ageMin = n.checkedAt ? (Date.now() - new Date(n.checkedAt).getTime()) / 60000 : Infinity;
  if (ageMin > STALE_WATCHER_MIN) {
    return {
      hasIssue: true, stale: true, signature: null,
      message: `Order-lifecycle watcher hasn't reported in ${Math.round(ageMin)}min (expected every 5min) -- check the cron, don't assume clean.`,
    };
  }
  if (!row.sample_size || row.sample_size <= 0) {
    return { hasIssue: false, stale: false, message: null, signature: null };
  }

  const dismissRow = await getLatestDismissRow();
  if (dismissRow) {
    const d = JSON.parse(dismissRow.notes || '{}');
    const dismissAgeMin = d.dismissedAt ? (Date.now() - new Date(d.dismissedAt).getTime()) / 60000 : Infinity;
    if (d.signature === n.signature && dismissAgeMin <= DISMISS_WINDOW_MIN) {
      return { hasIssue: true, stale: false, message: null, signature: n.signature, dismissed: true };
    }
  }

  const parts = [];
  if (n.stuckUnfilled) parts.push(`${n.stuckUnfilled} stuck unfilled`);
  if (n.canceledNoResubmit) parts.push(`${n.canceledNoResubmit} canceled-no-resubmit`);
  if (n.phantomActive) parts.push(`${n.phantomActive} phantom-active`);
  if (n.reconciliationNotClean) parts.push('reconciliation not clean');
  return {
    hasIssue: true, stale: false, signature: n.signature,
    message: `Order lifecycle issue: ${parts.join(', ')}`,
  };
}

// Verifies the client's signature still matches the CURRENT health row before recording the
// dismissal -- rejects a stale dismiss attempt (the client saw an older problem that's since
// changed) rather than silently dismissing whatever is live right now. Returns { ok, reason }.
export async function dismissOrderLifecycleAlert(signature) {
  const row = await getLatestHealthRow();
  if (!row) return { ok: false, reason: 'no current alert state to dismiss' };
  const n = JSON.parse(row.notes || '{}');
  if (!signature || signature !== n.signature) {
    return { ok: false, reason: 'signature mismatch -- the alert has changed since you loaded it, refresh and try again' };
  }
  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, notes)
    VALUES (CURRENT_DATE, 0, 'ORDER_LIFECYCLE_DISMISS', 'LATEST', $1)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET notes = EXCLUDED.notes
  `, [JSON.stringify({ signature, dismissedAt: new Date().toISOString() })]);
  return { ok: true };
}
