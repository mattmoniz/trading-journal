// Boot self-test for the fail-closed order path (G0, 2026-11-02; docs/G0_ENTRY_GATE_AND_BOOT_SELFTEST_DESIGN_20261102.md s2 and s5).
// Runs right after killSwitch.forceHaltOnBoot() and BEFORE connectOnce(), so it always finishes before the first reconcile
// that can auto-rearm. SIDE-EFFECT FREE by construction: it never calls sweepRealOrders/sweepExits, never touches the DTC
// client, never arms or halts the switch, and its one DB probe is a rolled-back insert. Its only lasting writes are the result row in
// live_attestations and a brief removal of DTC_DLL_LIMIT_USD (restored in a finally, bounded by its own timeout). A failure (or a timeout) is NOT
// fatal to boot: the switch stays halted and connectionManager.maybeAutoRearmAfterReconcile() refuses to auto-rearm until
// the next boot passes, so a human has to look.
import { killSwitch, isOrderEligible } from './orderEligibility.js';
import { dllGateDecision, evaluateDailyLossLimit, DLL_DATA_GAP_TEXT } from './dllGate.js';
import { entryFeedDecision } from '../feedFreshness.js';
import { getClient as getDbClient, query } from '../../db.js'; // NOT the DTC getClient in connectionManager.js

export const SELFTEST_TIMEOUT_MS = 15000;
const CHECK_NAME = 'boot_selftest';

let lastResult = null; // { passed, ranAt, failures: [..], checks: [{name, ok, detail}] } -- null until a run finishes

export function getBootSelfTestState() { return lastResult; }
// Fail closed: no result yet (or a failed one) means no auto-rearm.
export function bootSelfTestAllowsRearm() { return lastResult?.passed === true; }

const DLL_CHECK_TIMEOUT_MS = 5000;
async function dllUnsetLimitBlocks(evaluate = evaluateDailyLossLimit) {
  // evaluateDailyLossLimit does `await import(db.js)` BEFORE it reads DTC_DLL_LIMIT_USD, so the variable has to stay removed
  // across the awaited call (a synchronous remove/restore would be restored too early). Safe here: this runs at boot while the
  // switch is halted, an unset limit only ever makes the gate block (fail closed), and the call returns before any DB work. The
  // call is raced against its own short timeout so the finally ALWAYS runs and the value is restored even if it hangs.
  const saved = process.env.DTC_DLL_LIMIT_USD;
  delete process.env.DTC_DLL_LIMIT_USD;
  let timer;
  try {
    const r = await Promise.race([evaluate('SELFTEST_ACCOUNT'), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`evaluateDailyLossLimit did not return within ${DLL_CHECK_TIMEOUT_MS} ms`)), DLL_CHECK_TIMEOUT_MS); })]);
    return { ok: r.blocked === true && typeof r.reason === 'string' && r.reason.length > 0, detail: r };
  } finally {
    clearTimeout(timer);
    if (saved !== undefined) process.env.DTC_DLL_LIMIT_USD = saved;
  }
}

async function rolledBackInsertWorks() {
  const c = await getDbClient();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO gated_candidates (trade_date, setup_type, gate_name, gate_reason) VALUES (CURRENT_DATE, 'SELFTEST', 'SIERRA_ENTRY_SKIP', 'boot self-test probe (rolled back)')`);
    return { ok: true, detail: 'insert into gated_candidates succeeded and was rolled back' };
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

// Each check returns { ok, detail }; a throw counts as a failure. The kill switch and eligibility function are injectable so
// scripts/test_g0_safety.mjs can mutation-test the checks without touching the live switch state file.
export function buildChecks({ ks = killSwitch, eligible = isOrderEligible, dllEvaluate = evaluateDailyLossLimit, dbProbe = rolledBackInsertWorks } = {}) {
  return [
  ['kill_switch_halted_with_reason', async () => {
    const s = ks.getState();
    return { ok: s.armed === false && !!s.haltedReason, detail: { armed: s.armed, haltedReason: s.haltedReason } };
  }],
  ['entry_ineligible_when_halted', async () => {
    const r = await eligible('SELFTEST_SYNTHETIC', null);
    return { ok: r.eligible === false && typeof r.reason === 'string' && r.reason.length > 0, detail: r };
  }],
  ['dll_unset_limit_blocks_with_reason', () => dllUnsetLimitBlocks(dllEvaluate)],
  ['dll_pure_decisions', async () => {
    const lim = 1000;
    const atLimit = dllGateDecision({ realizedBrokerPnl: -lim, limit: lim });
    const unknownWithinLimit = dllGateDecision({ realizedBrokerPnl: -100, unknownCount: 2, unknownWorstCaseLoss: 50, limit: lim });
    const unknownNoWorstCase = dllGateDecision({ realizedBrokerPnl: -100, unknownCount: 1, limit: lim });
    const ok = atLimit.blocked === true
      && unknownWithinLimit.blocked === false // unknown P&L WITH a computable worst case does not block (2026-10-18 change)
      && unknownNoWorstCase.blocked === true && unknownNoWorstCase.reason.includes(DLL_DATA_GAP_TEXT);
    return { ok, detail: { atLimit: atLimit.blocked, unknownWithinLimit: unknownWithinLimit.blocked, unknownNoWorstCase: unknownNoWorstCase.blocked } };
  }],
  ['feed_gate_decisions', async () => {
    const fresh = entryFeedDecision(2), stale = entryFeedDecision(999), unknown = entryFeedDecision(NaN), future = entryFeedDecision(-60);
    return { ok: fresh.ok === true && stale.ok === false && unknown.ok === false && future.ok === false, detail: { fresh: fresh.ok, stale: stale.ok, unknown: unknown.ok, future: future.ok } };
  }],
  ['db_rolled_back_insert', () => dbProbe()],
  ];
}

async function persist(result) {
  try {
    await query(
      `INSERT INTO live_attestations (trade_date, check_name, status, detail) VALUES (CURRENT_DATE, $1, $2, $3::jsonb)
       ON CONFLICT (trade_date, check_name) DO UPDATE SET status = EXCLUDED.status, detail = EXCLUDED.detail, checked_at = now()`,
      [CHECK_NAME, result.passed ? 'OK' : 'DIVERGENCE', JSON.stringify({ failures: result.failures, checks: result.checks })]);
  } catch (err) { console.error('[bootSelfTest] could not persist the result to live_attestations:', err.message); }
}

// Marks a self-test that crashed or never finished, so the banner and auto-rearm gate show a reason instead of staying silent.
export async function markBootSelfTestCrashed(err, { persistResult = true } = {}) {
  const result = { passed: false, ranAt: new Date().toISOString(), failures: ['self_test_crashed'], checks: [{ name: 'self_test_crashed', ok: false, detail: String(err?.message || err) }] };
  lastResult = result;
  console.error(`[BOOT_SELFTEST_FAILED] self-test crashed before finishing: ${result.checks[0].detail}. Auto-rearm is SUPPRESSED; arm manually only after investigating.`);
  if (persistResult) await persist(result);
  return result;
}

export async function runBootSelfTest({ checks = buildChecks(), timeoutMs = SELFTEST_TIMEOUT_MS, persistResult = true } = {}) {
  const out = [];
  let closed = false; // once the timeout fires, a late-finishing check must not touch the result
  const body = (async () => {
    for (const [name, fn] of checks) {
      let entry;
      try { const r = await fn(); entry = { name, ok: !!r.ok, detail: r.detail }; }
      catch (err) { entry = { name, ok: false, detail: `threw: ${err.message}` }; }
      if (closed) return;
      out.push(entry);
    }
  })();
  let timer;
  const timedOut = await Promise.race([body.then(() => false), new Promise((res) => { timer = setTimeout(() => res(true), timeoutMs); })]);
  clearTimeout(timer);
  closed = true;
  const snapshot = out.slice();
  if (timedOut) snapshot.push({ name: 'completed_within_timeout', ok: false, detail: `no result after ${timeoutMs} ms` });
  const failures = snapshot.filter((c) => !c.ok).map((c) => c.name);
  const result = { passed: failures.length === 0 && !timedOut, ranAt: new Date().toISOString(), failures, checks: snapshot };
  lastResult = result;
  if (result.passed) console.log(`[bootSelfTest] PASSED (${snapshot.length} checks); auto-rearm is allowed for this boot.`);
  else console.error(`[BOOT_SELFTEST_FAILED] failures: ${failures.join(', ')}. The kill switch stays halted and auto-rearm is SUPPRESSED until a boot passes; arm manually only after investigating.`);
  if (persistResult) await persist(result);
  return result;
}
