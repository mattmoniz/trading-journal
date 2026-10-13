/**
 * Background health check for the real order-placement lifecycle, run every 5 minutes via
 * cron (tighter than check_price_bars_freshness.mjs's 10min -- an order-lifecycle bug
 * compounds faster: a stuck/phantom row can start blocking opposite-direction candidates
 * within minutes, not hours).
 *
 * Built 2026-10-13 after finding 3 real active_setups rows (134090, 134096, 134110) sitting
 * status='ACTIVE' for hours with a dead real order behind them (CANCELED at the broker, or
 * never submitted at all) -- origin_status='ACTIVE' looked exactly like a genuine live
 * position from every angle except the one that mattered (order_placements), and nothing
 * caught it until a manual investigation prompted by a direct user question. This script is
 * the standing safety net going forward: check every real order's lifecycle against known-
 * healthy patterns and alert the moment something looks stuck, not hours/days later.
 *
 * Checks (each is a real, previously-confirmed-possible failure mode, not a hypothetical):
 * 1. MISSING_ORDER -- an origin_status='ACTIVE' row with no order_placements row at all, well
 *    past sweepEntries()'s own 3-minute ENTRY_LOOKBACK_MINUTES window. sweepEntries() has no
 *    retry outside that window, so a single missed poll (restart, connection drop, kill
 *    switch not yet armed) means the order is NEVER submitted, ever -- this check is the
 *    only thing that will ever surface that after the fact.
 * 2. STUCK_UNFILLED -- an ENTRY order still OPEN well past
 *    orderSweep.js's ENTRY_FILL_TIMEOUT_SECONDS (90s), meaning
 *    escalateUnfilledEntriesToMarket() should have already canceled it but hasn't.
 * 3. CANCELED_NO_RESUBMIT -- an original ENTRY order (client_order_id has no 'M' suffix)
 *    CANCELED with the setup still status='ACTIVE' and no market-escalation resubmit
 *    ('M'-suffixed sibling via the SAME row, per reconciliation.js's in-place-reuse design)
 *    after a buffer -- escalation Step 2 should have resubmitted but hasn't. Also catches the
 *    exact shape of tonight's incident: an order canceled by the BROKER for an unrelated
 *    reason (e.g. a stale/invalid trade_account) that the app's own escalation never
 *    initiated and so never expects to resubmit on its own -- this check doesn't care who
 *    requested the cancel, only that nothing has resubmitted since.
 * 4. PHANTOM_ACTIVE -- defense in depth for the exact 2026-10-13 incident this script was
 *    built from: an origin_status='ACTIVE' primary still status='ACTIVE' whose real order is
 *    CANCELED/REJECTED with zero fill, well past when resolveSetups.js's own fill-gate fix
 *    should have caught it. Should be structurally impossible after that fix -- a hit here
 *    means the fix itself has a gap, not just that a stray row slipped through once.
 * 5. RECONCILIATION_NOT_CLEAN -- the live connection's own broker-truth reconciliation report
 *    (GET /api/sierra-chart/status) isn't clean (unknownToApp/staleInApp non-empty). Reuses
 *    the real, already-reviewed reconcileAgainstBroker() output via the live endpoint rather
 *    than re-deriving broker state here.
 *
 * Alert-only for checks 2-5, matching check_price_bars_freshness.mjs's own stated philosophy
 * ("making sure a recurrence gets noticed... not repairing the root cause") -- each of those
 * involves a real resting/just-placed order, and a wrong automated guess there has real-money
 * surface area, so a human decides what to do.
 *
 * Check 1 (MISSING_ORDER) is the one deliberate exception, added 2026-10-13 after the first
 * real occurrence (active_setups id=134133, a server restart during this same session wiped
 * pocRotationJoinDetector.js's in-memory poll-skip cache and backdated a real signal past
 * sweepEntries()'s entry window -- see docs/OPEN_THREADS.md's 2026-10-13 entry) needed a manual
 * fix. User's explicit choice (asked directly, picked the narrowest of 3 offered options):
 * auto-resolve ONLY this clear-cut case, nothing else. It's genuinely unambiguous -- once a row
 * is this far past fired_at with ZERO order_placements rows at all, sweepEntries()'s own
 * fired_at > NOW() - 3min condition can only ever become more false as time passes, so there is
 * no scenario where waiting longer lets a real order still land. AUTO_RESOLVE_BUFFER_MIN is
 * wider than MISSING_ORDER_BUFFER_MIN (10min vs 5min) purely for operational visibility -- so
 * the alert fires on its own at least once before the auto-fix lands, not because the extra
 * margin is needed for correctness.
 *
 * Run: node scripts/check_order_lifecycle_health.mjs
 * Cron: every 5 minutes.
 */
import { query } from '../server/db.js';
import pool from '../server/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getCurrentPrice } from '../server/services/priceRetrieval.js';
import { MAX_CHASE_DISTANCE_POINTS } from '../server/services/sierraChart/orderSweep.js';
import { CHASE_ABANDON_MINUTES } from '../server/services/resolveSetups.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3002';

// Buffers are deliberately generous relative to the mechanisms they're checking --
// ENTRY_LOOKBACK_MINUTES is 3min, ENTRY_FILL_TIMEOUT_SECONDS is 90s -- so a false positive
// from normal poll-cadence jitter (15s polls) is very unlikely at these thresholds.
const MISSING_ORDER_BUFFER_MIN = 5;
const STUCK_UNFILLED_BUFFER_MIN = 3;
const CANCELED_NO_RESUBMIT_BUFFER_MIN = 2;
const PHANTOM_ACTIVE_BUFFER_MIN = 5;
// Wider than MISSING_ORDER_BUFFER_MIN deliberately -- see this file's header for why the extra
// margin is about visibility, not correctness.
const AUTO_RESOLVE_MISSING_ORDER_BUFFER_MIN = 10;

function logAlert(message, detail) {
  const filePath = path.join(__dirname, '../scratch/server_errors.jsonl');
  const line = JSON.stringify({ ts: new Date().toISOString(), type: 'SERVER_ERROR', message, detail: detail ?? null }) + '\n';
  console.error(message);
  try {
    fs.appendFileSync(filePath, line);
  } catch (_) { /* best-effort, matches recordError()'s own silent-catch convention */ }
}

async function checkMissingOrders() {
  const r = await query(`
    SELECT a.id, a.setup_type, a.fired_at::text
    FROM active_setups a
    WHERE a.origin_status = 'ACTIVE' AND a.status = 'ACTIVE'
      AND a.fired_at < (NOW() AT TIME ZONE 'America/New_York') - make_interval(mins => $1)
      AND NOT EXISTS (SELECT 1 FROM order_placements e WHERE e.setup_id = a.id AND e.purpose = 'ENTRY')
  `, [MISSING_ORDER_BUFFER_MIN]);
  for (const row of r.rows) {
    logAlert(`ORDER_LIFECYCLE: MISSING_ORDER -- active_setups id=${row.id} (${row.setup_type}) fired_at=${row.fired_at} is origin_status='ACTIVE'/status='ACTIVE' with NO order_placements row at all, past sweepEntries()'s 3min lookback window. A real order was expected and never got submitted -- this setup will never get real execution.`);
  }
  await autoResolveMissingOrders();
  return r.rows.length;
}

// The one deliberate auto-fix in this file -- see the header comment for why this specific
// case (and only this one) is safe to resolve without a human looking first. Same fields as
// the two manual fixes applied 2026-10-13 (134090/134096/134110, then 134133): status=EXPIRED,
// resolution=NOT_FILLED, resolution_method=PRIMARY_UNFILLED, actual_pnl left NULL (no real
// fill ever happened, so there's no real P&L to record). The WHERE clause is the sole source
// of truth for eligibility -- re-checked fresh in this same query, not reused from
// checkMissingOrders()'s earlier SELECT, so a race where an order somehow landed in between
// (it structurally can't -- sweepEntries()'s own fired_at>NOW()-3min condition only ever
// becomes more false with time -- but guarded anyway, matching this codebase's standing
// "never trust a prior SELECT on an UPDATE touching real setup state" convention).
async function autoResolveMissingOrders() {
  const r = await query(`
    UPDATE active_setups a
    SET status = 'EXPIRED', resolution = 'NOT_FILLED', resolution_method = 'PRIMARY_UNFILLED', resolved_at = NOW()
    WHERE a.origin_status = 'ACTIVE' AND a.status = 'ACTIVE'
      AND a.fired_at < (NOW() AT TIME ZONE 'America/New_York') - make_interval(mins => $1)
      AND NOT EXISTS (SELECT 1 FROM order_placements e WHERE e.setup_id = a.id AND e.purpose = 'ENTRY')
    RETURNING a.id, a.setup_type, a.fired_at::text
  `, [AUTO_RESOLVE_MISSING_ORDER_BUFFER_MIN]);
  for (const row of r.rows) {
    logAlert(`ORDER_LIFECYCLE: AUTO_RESOLVED MISSING_ORDER -- active_setups id=${row.id} (${row.setup_type}) fired_at=${row.fired_at} marked EXPIRED/NOT_FILLED/PRIMARY_UNFILLED (no order ever existed, ${AUTO_RESOLVE_MISSING_ORDER_BUFFER_MIN}min+ past fired_at). Freed any opposite-direction/same-type gate it was phantom-blocking.`);
  }
  return r.rows.length;
}

// Each check below now returns { count, ids } (or { count, detail } for reconciliation)
// instead of a bare count -- the ids/detail feed persistHealthStatus()'s signature, which is
// what lets a dismissal distinguish "the exact same problem" from "something changed, show it
// again" (see that function's own header for why).
// User asked directly (2026-10-13) why a stuck order "can't be addressed right away" --
// the answer, for most real cases, is the MAX_CHASE_DISTANCE_POINTS guard correctly refusing
// to chase a price that's run too far (see orderSweep.js's own header for why chasing would
// be worse than waiting). The alert used to just say "should have canceled this already but
// hasn't," which reads as a malfunction even when the guard is working exactly as designed.
// Now explains WHY: within the chase distance (a genuine anomaly, worth investigating) vs
// beyond it (expected, and will self-resolve via resolveSetups.js's CHASE_ABANDON_MINUTES
// check -- included here so there's a concrete ETA, not just "it'll sort itself out").
async function checkStuckUnfilled() {
  const r = await query(`
    SELECT e.id, e.setup_id, a.setup_type, e.submitted_at::text, e.price1::float, e.side
    FROM order_placements e
    JOIN active_setups a ON a.id = e.setup_id
    WHERE e.purpose = 'ENTRY' AND e.status = 'OPEN' AND e.client_order_id NOT LIKE '%M'
      AND e.submitted_at < (NOW() AT TIME ZONE 'America/New_York') - make_interval(mins => $1)
  `, [STUCK_UNFILLED_BUFFER_MIN]);
  const currentPrice = r.rows.length ? await getCurrentPrice('NQ', 'check_order_lifecycle_health.checkStuckUnfilled') : null;
  // nowEt as a naive-ET text string, diffed against submitted_at via the identical
  // str.replace(' ','T') parse on both sides -- same safe pattern as resolveSetups.js's own
  // chase-abandon check (see that file's comment for why mixing conventions here silently
  // produces garbage, a real bug caught and fixed in this exact spot before shipping).
  const nowEtRow = r.rows.length ? await query(`SELECT (NOW() AT TIME ZONE 'America/New_York')::text as now_et`) : null;
  const nowEt = nowEtRow ? nowEtRow.rows[0].now_et : null;
  for (const row of r.rows) {
    let reason = 'escalateUnfilledEntriesToMarket() should have canceled this already but hasn\'t -- genuine anomaly, worth investigating directly.';
    if (currentPrice != null && Number.isFinite(row.price1)) {
      const chaseDistance = row.side === 'BUY' ? (currentPrice - row.price1) : (row.price1 - currentPrice);
      if (chaseDistance > MAX_CHASE_DISTANCE_POINTS) {
        const ageMin = (new Date(nowEt.replace(' ', 'T')) - new Date(row.submitted_at.replace(' ', 'T'))) / 60000;
        const minutesLeft = Math.max(0, Math.round(CHASE_ABANDON_MINUTES - ageMin));
        reason = `price has moved ${chaseDistance.toFixed(1)}pts away from the LIMIT (${row.price1}) -- beyond the ${MAX_CHASE_DISTANCE_POINTS}pt chase cap, so this is expected, not a malfunction. Will auto-resolve as NOT_FILLED (resolveSetups.js's chase-abandon check) in ~${minutesLeft}min if it stays this far away -- not an immediate fix, by design (chasing this far would mean a materially different, uncalibrated entry price).`;
      }
    }
    logAlert(`ORDER_LIFECYCLE: STUCK_UNFILLED -- order_placements id=${row.id} (setup_id=${row.setup_id}, ${row.setup_type}) submitted_at=${row.submitted_at} is still OPEN past the escalation timeout. ${reason}`);
  }
  return { count: r.rows.length, ids: r.rows.map(row => row.id) };
}

async function checkCanceledNoResubmit() {
  const r = await query(`
    SELECT e.id, e.setup_id, a.setup_type, e.last_update_at::text
    FROM order_placements e
    JOIN active_setups a ON a.id = e.setup_id
    WHERE e.purpose = 'ENTRY' AND e.status = 'CANCELED' AND e.client_order_id NOT LIKE '%M'
      AND a.status = 'ACTIVE'
      AND e.last_update_at < (NOW() AT TIME ZONE 'America/New_York') - make_interval(mins => $1)
      AND NOT EXISTS (
        SELECT 1 FROM order_placements m
        WHERE m.setup_id = e.setup_id AND m.purpose = 'ENTRY' AND m.client_order_id LIKE '%M'
      )
  `, [CANCELED_NO_RESUBMIT_BUFFER_MIN]);
  for (const row of r.rows) {
    logAlert(`ORDER_LIFECYCLE: CANCELED_NO_RESUBMIT -- order_placements id=${row.id} (setup_id=${row.setup_id}, ${row.setup_type}) CANCELED at ${row.last_update_at}, setup still status='ACTIVE', no market-escalation resubmit since. Either the escalation logic failed to act, or the broker canceled it for a reason outside the app's own escalation flow (e.g. an account/symbol issue) and nothing has followed up.`);
  }
  return { count: r.rows.length, ids: r.rows.map(row => row.id) };
}

async function checkPhantomActive() {
  const r = await query(`
    SELECT a.id, a.setup_type, a.fired_at::text, e.status as order_status, e.last_update_at::text as order_last_update
    FROM active_setups a
    JOIN order_placements e ON e.setup_id = a.id AND e.purpose = 'ENTRY'
    WHERE a.origin_status = 'ACTIVE' AND a.status = 'ACTIVE' AND a.resolution IS NULL
      AND (a.is_cluster_primary IS NULL OR a.is_cluster_primary = true)
      AND e.status IN ('CANCELED', 'REJECTED') AND COALESCE(e.filled_quantity, 0) = 0
      AND e.last_update_at < (NOW() AT TIME ZONE 'America/New_York') - make_interval(mins => $1)
  `, [PHANTOM_ACTIVE_BUFFER_MIN]);
  for (const row of r.rows) {
    logAlert(`ORDER_LIFECYCLE: PHANTOM_ACTIVE -- active_setups id=${row.id} (${row.setup_type}) is still status='ACTIVE' with resolution=NULL, but its real order is ${row.order_status} (zero fill) since ${row.order_last_update}. This should be structurally impossible after the 2026-10-13 resolver fill-gate fix -- if this fires, that fix has a gap, not just a one-off stray row.`);
  }
  return { count: r.rows.length, ids: r.rows.map(row => row.id) };
}

async function checkReconciliation() {
  try {
    const res = await fetch(`${APP_BASE_URL}/api/sierra-chart/status`);
    if (!res.ok) return { count: 0, detail: null };
    const j = await res.json();
    const report = j?.connection?.lastReconciliationReport;
    if (report && report.clean === false) {
      logAlert(`ORDER_LIFECYCLE: RECONCILIATION_NOT_CLEAN -- the live broker-truth reconciliation report is not clean (checkedAt=${report.checkedAt}).`, JSON.stringify({ unknownToApp: report.unknownToApp, staleInApp: report.staleInApp }).slice(0, 300));
      return { count: 1, detail: { unknownToApp: report.unknownToApp, staleInApp: report.staleInApp } };
    }
  } catch (_) { /* server not reachable -- a different check (price-bars freshness, uptime monitoring) already covers "is the server even up" */ }
  return { count: 0, detail: null };
}

// Persists the latest run's state so GET /api/setups/today-summary (the endpoint feeding the
// Home Assistant "Session Timeline" card -- the page the user actually watches trades on) and
// quick-check.html's own banner can surface an unresolved issue, without either re-deriving
// any of this file's own SQL (same "share modules instead of reimplementing" convention
// already used by this file's own bigMoveLine/sigmaLine-style signals in acd.js). ONLY counts
// checks 2-5 (the alert-only ones) -- MISSING_ORDER is excluded on purpose, since it
// self-resolves within AUTO_RESOLVE_MISSING_ORDER_BUFFER_MIN and showing it would just be
// noise about something this script already fixed on its own.
// signal_name='LATEST' singleton row, same convention as GARCH_VOL_SCALE/MOMENTUM_CHASE_
// WIDTH_CALIB's own LATEST rows (volatilityRegime.js / momentumChaseDetector.js).
//
// `signature` (2026-10-13, user request: a manual dismiss on quick-check.html/the HA page that
// re-surfaces if the SAME problem persists past a window, or immediately if a DIFFERENT row
// trips the same check) -- a stable JSON fingerprint of the exact ids/detail causing each
// category, not just counts. server/services/orderLifecycleAlert.js's dismiss logic compares a
// stored dismissal's signature against this one; any change here (a new/different row, a new
// reconciliation detail) makes them stop matching and the alert shows again immediately,
// independent of the time-based re-surface. Sorted ids so the same SET of rows always
// produces the same signature regardless of query result ordering.
function buildSignature({ stuckUnfilledIds, canceledNoResubmitIds, phantomActiveIds, reconciliationDetail }) {
  return JSON.stringify({
    s: [...stuckUnfilledIds].sort((a, b) => a - b),
    c: [...canceledNoResubmitIds].sort((a, b) => a - b),
    p: [...phantomActiveIds].sort((a, b) => a - b),
    r: reconciliationDetail,
  });
}

async function persistHealthStatus({ stuckUnfilled, canceledNoResubmit, phantomActive, reconciliationNotClean, signature }) {
  const total = stuckUnfilled + canceledNoResubmit + phantomActive + (reconciliationNotClean ? 1 : 0);
  const notes = JSON.stringify({
    stuckUnfilled, canceledNoResubmit, phantomActive, reconciliationNotClean, signature,
    checkedAt: new Date().toISOString(),
  });
  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes)
    VALUES (CURRENT_DATE, 0, 'ORDER_LIFECYCLE_HEALTH', 'LATEST', $1, $2)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
      sample_size = EXCLUDED.sample_size, notes = EXCLUDED.notes
  `, [total, notes]).catch((err) => console.error('[check_order_lifecycle_health] failed to persist status:', err.message));
}

async function run() {
  const [missing, stuckUnfilledR, canceledNoResubmitR, phantomActiveR, reconciliationR] = await Promise.all([
    checkMissingOrders(),
    checkStuckUnfilled(),
    checkCanceledNoResubmit(),
    checkPhantomActive(),
    checkReconciliation(),
  ]);
  const signature = buildSignature({
    stuckUnfilledIds: stuckUnfilledR.ids, canceledNoResubmitIds: canceledNoResubmitR.ids,
    phantomActiveIds: phantomActiveR.ids, reconciliationDetail: reconciliationR.detail,
  });
  await persistHealthStatus({
    stuckUnfilled: stuckUnfilledR.count, canceledNoResubmit: canceledNoResubmitR.count,
    phantomActive: phantomActiveR.count, reconciliationNotClean: reconciliationR.count > 0, signature,
  });
  const total = missing + stuckUnfilledR.count + canceledNoResubmitR.count + phantomActiveR.count + reconciliationR.count;
  if (total === 0) console.log('[check_order_lifecycle_health] clean -- no anomalies found.');
  await pool.end();
}

run().catch((e) => {
  console.error('[check_order_lifecycle_health] ERROR:', e.message);
  process.exit(1);
});
