// Extracted from scripts/check_order_lifecycle_health.mjs (2026-10-13, user request: "It
// needs to be seconds nor minutes" -- the 5-min cron + a deliberate extra 5-10min visibility
// buffer meant a real setup with no order ever placed could sit showing "pending fill" on the
// dashboard for up to ~15 minutes after it was already, unambiguously, never going to fire --
// confirmed live the same night: 3 real setups (134732/134735/134736) sat ACTIVE from 18:30/
// 18:31 until the cron finally caught them at 18:45.
//
// The buffer was NEVER about correctness (see check_order_lifecycle_health.mjs's own header:
// "there is no scenario where waiting longer lets a real order still land" once a row is past
// sweepEntries()'s own fired_at>NOW()-ENTRY_LOOKBACK_MINUTES window -- that condition can only
// ever become more false with time) -- it was purely so the cron's own alert would fire once
// before the auto-fix landed, for visibility. Now called from the main 15s live poll loop
// (acd.js) AS WELL AS the 5-min cron (which stays as a backstop/alert -- see that script's own
// updated header) -- the live-loop call means this resolves within one poll cycle (~15-18s)
// of crossing ENTRY_LOOKBACK_MINUTES, not minutes later. Idempotent by construction (the WHERE
// clause is the sole eligibility check, re-evaluated fresh every call) -- calling this twice
// in quick succession (once from the live loop, once from the cron) is always safe, the second
// call simply finds 0 rows once the first has already resolved them.
import { query } from '../db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function logAlert(message, detail) {
  const filePath = path.join(__dirname, '../../scratch/server_errors.jsonl');
  const line = JSON.stringify({ ts: new Date().toISOString(), type: 'SERVER_ERROR', message, detail: detail ?? null }) + '\n';
  console.error(message);
  try {
    fs.appendFileSync(filePath, line);
  } catch (_) { /* best-effort, matches recordError()'s own silent-catch convention */ }
}

// Matches sweepEntries()'s own ENTRY_LOOKBACK_MINUTES=3 exactly -- no extra margin needed
// here since this runs on the same ~15s cadence as the live poll that would have placed the
// order in the first place; the old 5-10min buffers were cron-cadence artifacts, not a real
// correctness requirement (see this file's own header).
export const LIVE_AUTO_RESOLVE_MISSING_ORDER_BUFFER_MIN = 3;

export async function autoResolveMissingOrders(bufferMin = LIVE_AUTO_RESOLVE_MISSING_ORDER_BUFFER_MIN) {
  const r = await query(`
    UPDATE active_setups a
    SET status = 'EXPIRED', resolution = 'NOT_FILLED', resolution_method = 'PRIMARY_UNFILLED',
        actual_outcome = 'NOT_FILLED', actual_pnl = NULL, resolved_at = NOW(), updated_at = NOW()
    WHERE a.origin_status = 'ACTIVE' AND a.status = 'ACTIVE'
      AND a.fired_at < (NOW() AT TIME ZONE 'America/New_York') - make_interval(mins => $1)
      AND NOT EXISTS (SELECT 1 FROM order_placements e WHERE e.setup_id = a.id AND e.purpose = 'ENTRY')
    RETURNING a.id, a.setup_type, a.fired_at::text
  `, [bufferMin]);
  for (const row of r.rows) {
    logAlert(`ORDER_LIFECYCLE: AUTO_RESOLVED MISSING_ORDER -- active_setups id=${row.id} (${row.setup_type}) fired_at=${row.fired_at} marked EXPIRED/NOT_FILLED/PRIMARY_UNFILLED (no order ever existed, ${bufferMin}min+ past fired_at). Freed any opposite-direction/same-type gate it was phantom-blocking.`);
  }
  return r.rows.length;
}

// Found live 2026-10-13/14 (user report: "lots of unfilled trades even with some trades
// firing at market"): a DIFFERENT dead-end shape than autoResolveMissingOrders() above --
// a real ENTRY order that WAS submitted, then CANCELED with zero fill by something OUTSIDE
// this app (confirmed live: setup_id=134741's order was CANCELED only ~93s after
// submission, with zero app-side log activity at that moment -- not a broker-side cancel
// this app's own escalateUnfilledEntriesToMarket() initiated). This falls through every
// existing resolution path: resolveSetups.js's chase-abandon only fires for an order still
// `status='OPEN'` that's aged past CHASE_ABANDON_MINUTES (15min) -- an order canceled THIS
// fast never satisfies that, since it's no longer 'OPEN' by the time 15 minutes pass; and
// autoResolveMissingOrders() above only fires when there's NO order row at all, which
// doesn't apply here either (a real, now-dead order row exists). Net effect: structurally
// invisible to every existing auto-fix, confirmed stuck for ~11.5 hours before being found
// and manually resolved.
//
// `client_order_id NOT LIKE '%M'` is the real "never successfully escalated" check --
// placeMarketEscalationEntryOrder() (reconciliation.js) gives a row the 'M' suffix via an
// UPDATE on the SAME row id the moment a market resubmit actually succeeds, so a row still
// lacking it, well after a cancel, genuinely never got resubmitted (not a timing race --
// escalation's own Step 2 checks for exactly this shape every ~15s poll, so if it hasn't
// happened by LIVE_AUTO_RESOLVE_DEAD_CANCEL_BUFFER_MIN, it isn't going to on its own).
export const LIVE_AUTO_RESOLVE_DEAD_CANCEL_BUFFER_MIN = 3;

export async function autoResolveDeadCanceledEntries(bufferMin = LIVE_AUTO_RESOLVE_DEAD_CANCEL_BUFFER_MIN) {
  const r = await query(`
    UPDATE active_setups a
    SET status = 'EXPIRED', resolution = 'NOT_FILLED', resolution_method = 'PRIMARY_UNFILLED',
        actual_outcome = 'NOT_FILLED', actual_pnl = NULL, resolved_at = NOW(), updated_at = NOW()
    FROM order_placements e
    WHERE e.setup_id = a.id AND e.purpose = 'ENTRY' AND e.status = 'CANCELED' AND e.filled_quantity = 0
      AND e.client_order_id NOT LIKE '%M'
      AND a.origin_status = 'ACTIVE' AND a.status = 'ACTIVE'
      AND e.last_update_at < NOW() - make_interval(mins => $1)
    RETURNING a.id, a.setup_type, a.fired_at::text
  `, [bufferMin]);
  for (const row of r.rows) {
    logAlert(`ORDER_LIFECYCLE: AUTO_RESOLVED DEAD_CANCELED_ENTRY -- active_setups id=${row.id} (${row.setup_type}) fired_at=${row.fired_at} marked EXPIRED/NOT_FILLED/PRIMARY_UNFILLED (real ENTRY order was CANCELED with zero fill and never resubmitted, ${bufferMin}min+ since the cancel). Freed any opposite-direction/same-type gate it was phantom-blocking.`);
  }
  return r.rows.length;
}
