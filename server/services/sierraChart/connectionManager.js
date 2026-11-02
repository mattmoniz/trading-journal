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
import { handleOrderUpdate, runReconciliation, extractPositionForSymbol, getBrokerSnapshot } from './reconciliation.js';
import { resolveMnqFrontMonthSymbolFromEnv } from './contractSymbol.js';
import { query } from '../../db.js';
import { getPriceMultiplier } from './priceMultiplier.js';
import { runBootSelfTest, markBootSelfTestCrashed, bootSelfTestAllowsRearm } from './bootSelfTest.js';

let client = null;
let lastReconciliationReport = null;
let rearmSuppressedLogged = false; // log the self-test suppression once per boot, not on every reconcile
let lastInvariantCheck = null;
let reconnectTimer = null;
let periodicReconcileTimer = null;
let bootHaltDone = false;

const RECONNECT_DELAY_MS = 10000;
// Periodic reconciliation backstop (docs/OPEN_THREADS.md's 2026-09-29 "Item 1" spec) --
// covers a quiet night with zero real order activity at all, where the event-driven
// (terminal-transition-triggered) path below would otherwise never fire.
const PERIODIC_RECONCILE_MS = 15 * 60 * 1000;

// Position sampler (2026-10-18, user-approved): the app only read the broker's position on order events and
// every 15 min, so Friday's silent close was only bracketed to an 86-second window. This asks for POSITIONS
// ONLY every 15s (never open orders -- those replies would be replayed through handleOrderUpdate() and
// appended to the order-message log every tick) and writes a reconciliation-log row only when the net
// CHANGES, so the log stays small while the time a position changed is known to ~15s. It never halts,
// places, or cancels anything; brokerPnlResolver.js reads these rows as extra broker readings.
const POSITION_SAMPLE_MS = 15 * 1000;
let positionSampleTimer = null;
let lastSampledNet;

// Prevention (2026-10-19): learn each contract's price multiplier BEFORE the first fill needs it. A lookup that
// first happens at fill time can time out and leave that fill unpriced (the 2026-10-18 roll incident). Warms the
// current front month and the next quarterly (so a roll never starts cold). Runs every sampler tick: a cached
// answer costs nothing, a failed one is retried by getPriceMultiplier()'s own short retry window.
async function warmPriceMultipliers(today) {
  const ahead = new Date(`${today}T12:00:00Z`); ahead.setUTCDate(ahead.getUTCDate() + 21);
  const symbols = new Set([
    resolveMnqFrontMonthSymbolFromEnv(today).orderSymbol,
    resolveMnqFrontMonthSymbolFromEnv(ahead.toISOString().slice(0, 10)).orderSymbol,
  ]);
  for (const sym of symbols) {
    const had = await getPriceMultiplier(client, sym).catch(() => null);
    if (had == null && !warnedWarmFailure.has(sym)) {
      warnedWarmFailure.add(sym);
      console.error(`[sierraChart.connectionManager] could not learn the price multiplier for ${sym} yet -- will keep retrying; fills on it would be stored unpriced until it is known (fillPriceRepair.js fixes them afterwards).`);
    } else if (had != null) warnedWarmFailure.delete(sym);
  }
}
const warnedWarmFailure = new Set();

async function samplePosition() {
  if (!client || !client.isLive()) return;
  try {
    const todayQ = await query(`SELECT CURRENT_DATE::text as today`);
    await warmPriceMultipliers(todayQ.rows[0].today).catch((e) => console.error('[sierraChart.connectionManager] multiplier warm-up failed:', e.message));
    const symbol = resolveMnqFrontMonthSymbolFromEnv(todayQ.rows[0].today).orderSymbol;
    // Through getBrokerSnapshot() so it is serialized with every other snapshot (2026-10-19, DeepSeek review L3): a private listener could
    // capture a reply meant for an overlapping request and misread another account's flat as this one's.
    const snap = await getBrokerSnapshot(client, { collectWindowMs: 1500 });
    if (snap.failed) return;
    const positionMessages = snap.positionMessages;
    const net = extractPositionForSymbol(positionMessages, symbol, client.tradeAccount);
    if (net == null || net === lastSampledNet) return;
    lastSampledNet = net;
    await query(`INSERT INTO sierra_chart_reconciliation_log (trigger, report, broker_net) VALUES ('POSITION_SAMPLE', '{}'::jsonb, $1)`, [net]);
  } catch (err) {
    console.error('[sierraChart.connectionManager] position sample failed:', err.message);
  }
}

function stopPositionSampler() {
  if (positionSampleTimer) { clearInterval(positionSampleTimer); positionSampleTimer = null; }
}

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
  // G0 boot self-test (2026-11-02): runs to completion BEFORE the first connect/reconcile, because that reconcile is what can
  // auto-rearm. A failure or a throw leaves no passing result, and maybeAutoRearmAfterReconcile() fails closed on that.
  await runBootSelfTest().catch((err) => markBootSelfTestCrashed(err).catch((e2) => console.error('[BOOT_SELFTEST_FAILED] could not record the crash:', e2.message)));
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
  if (!bootSelfTestAllowsRearm()) {
    if (!rearmSuppressedLogged) { rearmSuppressedLogged = true; console.error('[sierraChart.connectionManager] auto-rearm SUPPRESSED: this boot\'s self-test did not pass (see live_attestations check boot_selftest). Arm manually after investigating.'); }
    return;
  }
  if (!lastReconciliationReport || !lastReconciliationReport.clean) return;
  // The open-orders report being clean is not enough: a position-invariant mismatch halts in the SAME pass, and with no resting orders the
  // report is clean, so the halt was undone immediately (2026-10-19, DeepSeek review C1). `checked:false` (no position message at all,
  // which is what a flat broker sends) is unknown, not a mismatch, and still allowed -- a failed snapshot already makes the report unclean.
  if (lastInvariantCheck && (lastInvariantCheck.match === false || lastInvariantCheck.otherAccountsMismatch === true)) return;
  const previousHaltReason = state.haltedReason;
  killSwitch.arm('auto-rearm-on-simulation-boot');
  console.log(`[sierraChart.connectionManager] DTC_AUTO_REARM_SAFE=true for trade account "${process.env.DTC_TRADE_ACCOUNT}" and a fresh reconciliation came back clean -- auto-armed (was halted: ${previousHaltReason || '(no reason recorded)'}).`);
}

// While the switch is halted by a SYSTEM check (a reconciliation / position-invariant mismatch, never the user's own Stop button) on a
// sim-safe profile, look again in 45 s instead of waiting for the next 15-minute periodic tick (2026-10-19: a benign snapshot-lag halt at
// 10:32:53 kept real entries off until 10:43:30). Logged as 'PERIODIC' (the trigger column is a CHECK list); a recheck that is still
// mismatched halts again and schedules the next one, a clean one re-arms through the existing maybeAutoRearmAfterReconcile() gate.
let haltRecheckTimer = null;
function scheduleHaltRecheckIfNeeded() {
  if (process.env.DTC_AUTO_REARM_SAFE !== 'true' || haltRecheckTimer) return;
  const st = killSwitch.getState();
  if (st.armed || st.haltedBy === 'user') return;
  haltRecheckTimer = setTimeout(() => { haltRecheckTimer = null; triggerReconciliation('PERIODIC'); }, 45 * 1000);
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
    scheduleHaltRecheckIfNeeded();
    // After the app closed out a trade the broker had already closed, re-check right away so app and broker
    // are seen agreeing and the existing sim auto-rearm gate can act within seconds, not on the next tick.
    // One follow-up only (never chains from itself).
    if (result.silentCloseResult?.attempted && trigger !== 'POST_SILENT_CLOSE') {
      setTimeout(() => triggerReconciliation('POST_SILENT_CLOSE'), 2000);
    }
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
  // 2026-10-19: the default order path sends the LOGON account on the wire regardless of the per-session label (submitAndRecord never forwards
  // tradeAccount), so a different DTC_GLOBEX_TRADE_ACCOUNT makes the recorded account fictional and breaks account-scoped exits/invariants
  // (the 2026-10-18 stranded short). Say so loudly at boot; applyOrderUpdate also flags any live mismatch.
  if (process.env.DTC_GLOBEX_TRADE_ACCOUNT && process.env.DTC_GLOBEX_TRADE_ACCOUNT !== process.env.DTC_TRADE_ACCOUNT) {
    console.error(`[sierraChart.connectionManager] WARNING: DTC_GLOBEX_TRADE_ACCOUNT (${process.env.DTC_GLOBEX_TRADE_ACCOUNT}) != DTC_TRADE_ACCOUNT (${process.env.DTC_TRADE_ACCOUNT}) but orders are always sent under the logon account -- Globex-session order rows will carry a label the broker does not honor. Set them equal unless per-order account routing has been implemented and verified.`);
  }
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
    stopPositionSampler();
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
    stopPositionSampler();
    lastSampledNet = undefined;
    positionSampleTimer = setInterval(samplePosition, POSITION_SAMPLE_MS);
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
