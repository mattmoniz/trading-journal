// Owns the ONE long-lived DtcClient instance for this server process. Every consumer
// (routes, the order sweep, the dashboard) reads through this module's getClient()/
// getStatus() rather than constructing its own DtcClient -- a second independent
// connection would mean two different ClientOrderID sequences and two different views
// of "is this order live," which this app's whole design assumes never happens.
//
// Host/port/credentials are read from env vars here (DTC_HOST/DTC_PORT/DTC_USERNAME/
// DTC_PASSWORD/DTC_TRADE_ACCOUNT), matching this build's standing "keep it nimble, it
// might get moved" requirement (docs/OPEN_THREADS.md, 2026-09-28) -- never hardcoded.
// If DTC_HOST isn't set, this module simply never connects (getStatus() reports
// 'NOT_CONFIGURED') -- the rest of the app must keep working with Sierra Chart wiring
// absent entirely, same as before this build existed.

import { DtcClient } from './dtcClient.js';
import { killSwitch } from './orderEligibility.js';
import { handleOrderUpdate, runReconciliation } from './reconciliation.js';
import { resolveMnqFrontMonthSymbolFromEnv } from './contractSymbol.js';
import { query } from '../../db.js';

let client = null;
let lastReconciliationReport = null;
let lastInvariantCheck = null;
let reconnectTimer = null;
let periodicReconcileTimer = null;
let bootHaltDone = false;

const RECONNECT_DELAY_MS = 10000;
// Periodic reconciliation backstop (docs/OPEN_THREADS.md's 2026-09-29 "Item 1" spec) --
// covers a quiet night with zero real order activity at all, where the event-driven
// (terminal-transition-triggered) path below would otherwise never fire.
const PERIODIC_RECONCILE_MS = 15 * 60 * 1000;

function buildClient() {
  const host = process.env.DTC_HOST;
  const port = process.env.DTC_PORT ? parseInt(process.env.DTC_PORT, 10) : null;
  if (!host || !port) return null;
  return new DtcClient({
    host, port,
    username: process.env.DTC_USERNAME || '',
    password: process.env.DTC_PASSWORD || '',
    tradeAccount: process.env.DTC_TRADE_ACCOUNT || '',
    clientName: 'trading-journal-server',
  });
}

/**
 * Call once at server startup. Forces the kill switch to HALTED unconditionally
 * (fail-closed-on-restart guarantee -- see killSwitch.js) BEFORE attempting to connect,
 * so a crash/restart can never silently resume armed state regardless of connection
 * timing. If DTC_HOST/DTC_PORT aren't set, this is a no-op beyond the halt (no
 * connection attempted) -- Sierra Chart wiring is entirely optional infrastructure.
 */
export async function startConnectionManager() {
  killSwitch.forceHaltOnBoot('process restart (fail-closed default)');
  bootHaltDone = true;
  await connectOnce();
}

/**
 * Auto-rearm-on-simulation, upgraded 2026-10-11 to also gate on a clean post-reconnect
 * reconciliation (matches docs/DTC_AUTO_REARM_ON_BOOT_SPEC.md's original 2026-10-08 design),
 * then upgraded AGAIN 2026-10-13 (user directive: "permanently armed until otherwise stated
 * ... too many variables in the air ... trading simulation money") to also clear a MID-SESSION
 * halt, not just a boot-time one -- previously this only ever re-armed after the one specific
 * 'system-boot' halt reason, deliberately leaving any OTHER halt (a real-looking mismatch found
 * while live) requiring a manual re-arm. That distinction mattered less once
 * checkPositionInvariant() (reconciliation.js) gained its own retry-before-halt fix the same
 * day -- the halts THIS function now also auto-clears already survived one fresh recheck before
 * ever halting in the first place, so by the time this function gets a chance to look again,
 * it's checking a genuinely independent, later snapshot, not just retrying the same race twice.
 * Two independent gates, both still required:
 *  1. SCOPE: DTC_AUTO_REARM_SAFE=true, an explicit per-profile opt-in flag
 *     (config/dtc-accounts/*.env) -- not an inference from the account name/number. A future
 *     real-money profile must not carry this flag, same standing rule as before.
 *  2. HEALTH: only re-arms once a FRESH reconciliation (whatever trigger: LOGON, PERIODIC,
 *     TERMINAL_TRANSITION -- see every triggerReconciliation() call site below) comes back
 *     clean. No longer restricted to haltedBy==='system-boot' -- ANY halt reason clears once a
 *     fresh check confirms the broker and this app's own records agree again. The halt event
 *     itself stays fully visible either way (haltedReason/haltedAt/haltedBy are never erased,
 *     only armed/haltedAt update on a successful auto-rearm) -- this removes the requirement to
 *     manually re-arm, not the visibility into what tripped and when.
 */
function maybeAutoRearmAfterReconcile() {
  if (process.env.DTC_AUTO_REARM_SAFE !== 'true') return;
  const state = killSwitch.getState();
  if (state.armed) return;
  if (!lastReconciliationReport || !lastReconciliationReport.clean) return;
  const previousHaltReason = state.haltedReason;
  killSwitch.arm('auto-rearm-on-simulation-boot');
  console.log(`[sierraChart.connectionManager] DTC_AUTO_REARM_SAFE=true for trade account "${process.env.DTC_TRADE_ACCOUNT}" and a fresh reconciliation came back clean -- auto-armed (was halted: ${previousHaltReason || '(no reason recorded)'}).`);
}

/**
 * The one place this module actually runs a reconciliation pass -- resolves today's
 * front-month symbol and delegates to reconciliation.js's runReconciliation() (which
 * owns the single broker snapshot, the single-flight guard, persistence, and the
 * unknownToApp halt). Updates the module-level `lastReconciliationReport`/
 * `lastInvariantCheck` the dashboard reads via getStatus() -- same two variables as
 * before this build, just now also written from 3 more triggers than just logon.
 */
async function triggerReconciliation(trigger) {
  if (!client || !client.isLive()) return; // nothing to check against without a live connection
  try {
    const todayQ = await query(`SELECT CURRENT_DATE::text as today`);
    const contract = resolveMnqFrontMonthSymbolFromEnv(todayQ.rows[0].today);
    const result = await runReconciliation(client, killSwitch, contract.orderSymbol, trigger);
    lastReconciliationReport = result.reconciliationReport;
    lastInvariantCheck = result.invariantCheck;
    if (!result.reconciliationReport.clean) {
      console.error(`[sierraChart.connectionManager] RECONCILIATION MISMATCH (${trigger}):`, JSON.stringify(result.reconciliationReport));
    }
    // Called from EVERY trigger (2026-10-13), not just LOGON -- a mid-session halt now gets
    // a chance to auto-clear on the very next TERMINAL_TRANSITION (an order reaching a real
    // terminal state, so typically within seconds of real activity) or PERIODIC tick, not
    // just on the next full reconnect. See this function's own header for the full reasoning
    // and the DTC_AUTO_REARM_SAFE scope gate that still fully applies here.
    maybeAutoRearmAfterReconcile();
  } catch (err) {
    console.error(`[sierraChart.connectionManager] runReconciliation (${trigger}) failed:`, err);
  }
}

function stopPeriodicReconcile() {
  if (periodicReconcileTimer) { clearInterval(periodicReconcileTimer); periodicReconcileTimer = null; }
}

async function connectOnce() {
  const c = buildClient();
  if (!c) { console.log('[sierraChart.connectionManager] DTC_HOST/DTC_PORT not set -- Sierra Chart connection not attempted.'); return; }
  client = c;
  client.on('error', (err) => console.error('[sierraChart.connectionManager] DTC error:', err.message));
  // handleOrderUpdate() returns whether this update just applied a REAL terminal-state
  // transition (newly FILLED, or newly CANCELED/REJECTED) -- that's the event-driven
  // reconciliation trigger (docs/OPEN_THREADS.md's 2026-09-29 "Item 1"), deliberately NOT
  // firing on every message (an ordinary working-state update shouldn't trigger a full
  // broker round trip).
  client.on('orderUpdate', (msg) => {
    handleOrderUpdate(msg, client)
      .then((becameTerminal) => { if (becameTerminal) triggerReconciliation('TERMINAL_TRANSITION'); })
      .catch((err) => console.error('[sierraChart.connectionManager] handleOrderUpdate failed:', err));
  });
  client.on('disconnected', (reason) => {
    console.error(`[sierraChart.connectionManager] disconnected: ${reason} -- reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
    stopPeriodicReconcile();
    scheduleReconnect();
  });
  client.on('logon', async (msg) => {
    if (msg.Result !== 1) { console.error('[sierraChart.connectionManager] logon failed:', msg.ResultText); return; }
    console.log(`[sierraChart.connectionManager] logged on. Service=${msg.Service || '(none)'}`);
    // Reconcile against the broker's own truth every time a connection is (re)established
    // -- closes the "must reconcile on restart, not assume flat" gap (docs/OPEN_THREADS.md).
    // Also fail-closed halts on a position-invariant mismatch (see reconciliation.js's
    // header), and the auto-rearm check (see that function's own header) -- all 3 folded
    // into the one triggerReconciliation() call below, same as every other trigger.
    await triggerReconciliation('LOGON');
    // Periodic backstop for a quiet night with zero real order activity at all -- restart
    // it fresh on every (re)logon so a reconnect never ends up with two overlapping timers.
    stopPeriodicReconcile();
    periodicReconcileTimer = setInterval(() => triggerReconciliation('PERIODIC'), PERIODIC_RECONCILE_MS);
  });
  try { await client.connect(); }
  catch (err) { console.error('[sierraChart.connectionManager] connect failed:', err.message); scheduleReconnect(); }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectOnce(); }, RECONNECT_DELAY_MS);
}

/** The shared client, or null if never configured/connected. Callers must check isLive(). */
export function getClient() { return client; }

export function getStatus() {
  if (!bootHaltDone) return { configured: false, state: 'NOT_STARTED' };
  if (!client) return { configured: !!process.env.DTC_HOST, state: 'NOT_CONFIGURED' };
  return {
    configured: true,
    state: client.isLive() ? 'LIVE' : client.isLoggedOn ? 'LOGGED_ON_STALE' : client.isConnected ? 'CONNECTED_NOT_LOGGED_ON' : 'DISCONNECTED',
    connectionHealth: client.getConnectionHealth(),
    service: client.lastKnownService,
    tradeAccount: client.tradeAccount,
    lastReconciliationReport,
    lastInvariantCheck,
    killSwitch: killSwitch.getState(),
  };
}
