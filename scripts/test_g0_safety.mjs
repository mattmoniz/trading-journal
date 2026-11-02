// G0 safety tests (2026-11-02): entry feed gate, boot self-test (incl. mutation tests), auto-rearm wiring. Does not touch the kill switch
// file, never persists to live_attestations, never calls the order sweeps. Honest scope: one check briefly removes DTC_DLL_LIMIT_USD from
// THIS process's env (restored, asserted below) and one does a rolled-back DB insert. It does not run sweepEntries end to end.
import fs from 'fs';
import { etNaiveTimestampToMs } from '../server/services/acdShared.js';
import { feedAgeMinutes, entryFeedDecision, entryFeedGate, FEED_BLOCK_MINUTES, FEED_WARN_MINUTES } from '../server/services/feedFreshness.js';
import { runBootSelfTest, markBootSelfTestCrashed, buildChecks, bootSelfTestAllowsRearm, getBootSelfTestState } from '../server/services/sierraChart/bootSelfTest.js';

let fails = 0;
const t = (name, ok, extra = '') => { console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${extra ? ' -- ' + extra : ''}`); if (!ok) fails++; };

// --- feed gate
const etNaive = (d) => new Date(d).toLocaleString('sv-SE', { timeZone: 'America/New_York' }); // "YYYY-MM-DD HH:MM:SS" in ET
const now = Date.now();
const age3 = feedAgeMinutes(etNaive(now - 3 * 60000), now);
t('ET-naive bar 3 min old parses to ~3 min (not ~4-5 hours)', Math.abs(age3 - 3) < 0.1, `age=${age3}`);
t('fresh bar passes', entryFeedDecision(age3).ok === true);
t('bar older than the limit blocks with a readable reason', entryFeedDecision(FEED_BLOCK_MINUTES + 1).ok === false && /min old/.test(entryFeedDecision(FEED_BLOCK_MINUTES + 1).reason));
t('exactly at the limit still passes', entryFeedDecision(FEED_BLOCK_MINUTES).ok === true);
t('unknown age fails closed', entryFeedDecision(null).ok === false && entryFeedDecision(NaN).ok === false && feedAgeMinutes(undefined) === null && feedAgeMinutes('garbage') === null);
t('future-dated bar fails closed', entryFeedDecision(-30).ok === false);
t('warn threshold is below the block threshold', FEED_WARN_MINUTES < FEED_BLOCK_MINUTES);
t('gate: fresh bar from the DB layer passes', (await entryFeedGate({ queryFn: async () => ({ rows: [{ ts: etNaive(now - 60000) }] }), nowMs: now })).ok === true);
t('gate: stale bar blocks', (await entryFeedGate({ queryFn: async () => ({ rows: [{ ts: etNaive(now - 3600000) }] }), nowMs: now })).ok === false);
t('gate: empty table blocks', (await entryFeedGate({ queryFn: async () => ({ rows: [] }), nowMs: now })).ok === false);
t('gate: query error blocks and does not throw', (await entryFeedGate({ queryFn: async () => { throw new Error('db down'); }, nowMs: now })).ok === false);

// --- self-test with healthy fakes for the two live-state checks (the real switch file is ARMED on the running server)
const haltedKs = { getState: () => ({ armed: false, haltedReason: 'process restart (fail-closed default)' }) };
const inelig = async () => ({ eligible: false, reason: 'kill switch not armed' });
const good = await runBootSelfTest({ checks: buildChecks({ ks: haltedKs, eligible: inelig }), persistResult: false });
t('self-test passes on a healthy halted boot', good.passed === true, good.failures.join(','));
t('passing result allows auto-rearm', bootSelfTestAllowsRearm() === true);

// mutation tests: each broken dependency must fail the self-test and suppress auto-rearm
const armedKs = { getState: () => ({ armed: true, haltedReason: null }) };
const m1 = await runBootSelfTest({ checks: buildChecks({ ks: armedKs, eligible: inelig }), persistResult: false });
t('MUTATION: an armed switch at boot fails the self-test', m1.passed === false && m1.failures.includes('kill_switch_halted_with_reason'));
t('failed result suppresses auto-rearm', bootSelfTestAllowsRearm() === false);
const m2 = await runBootSelfTest({ checks: buildChecks({ ks: haltedKs, eligible: async () => ({ eligible: true, reason: null }) }), persistResult: false });
t('MUTATION: an eligible order while halted fails the self-test', m2.passed === false && m2.failures.includes('entry_ineligible_when_halted'));
const m3 = await runBootSelfTest({ checks: buildChecks({ ks: haltedKs, eligible: async () => { throw new Error('boom'); } }), persistResult: false });
t('MUTATION: a throwing check counts as a failure', m3.passed === false && m3.failures.includes('entry_ineligible_when_halted'));
const m4 = await runBootSelfTest({ checks: [['hangs', () => new Promise(() => {})]], timeoutMs: 200, persistResult: false });
t('MUTATION: a hanging check times out as a failure', m4.passed === false && m4.failures.includes('completed_within_timeout'));
t('the state getter reflects the last run', getBootSelfTestState()?.passed === false);
await runBootSelfTest({ checks: buildChecks({ ks: haltedKs, eligible: inelig }), persistResult: false });
t('a later passing run re-allows auto-rearm', bootSelfTestAllowsRearm() === true);

// review-driven additions (DeepSeek code review 2026-11-02)
t('future tolerance boundary: -1 min passes, -2.1 min blocks', entryFeedDecision(-1).ok === true && entryFeedDecision(-2.1).ok === false);
const ms = etNaiveTimestampToMs;
t('DST spring-forward: 01:30 EST to 03:30 EDT is one hour', ms('2026-03-08 03:30:00') - ms('2026-03-08 01:30:00') === 3600000);
t('DST fall-back: 00:00 EDT to 03:00 EST is four hours', ms('2026-11-01 03:00:00') - ms('2026-11-01 00:00:00') === 4 * 3600000);
const SENTINEL = '4242'; process.env.DTC_DLL_LIMIT_USD = SENTINEL;
const m5 = await runBootSelfTest({ checks: buildChecks({ ks: haltedKs, eligible: inelig, dllEvaluate: async () => ({ blocked: false, reason: 'x' }) }), persistResult: false });
t('MUTATION: a daily-loss gate that does not block an unset limit fails the self-test', m5.passed === false && m5.failures.includes('dll_unset_limit_blocks_with_reason'));
t('the daily-loss env value is restored after a check', process.env.DTC_DLL_LIMIT_USD === SENTINEL);
const m6 = await runBootSelfTest({ checks: buildChecks({ ks: haltedKs, eligible: inelig, dbProbe: async () => { throw new Error('insert refused'); } }), persistResult: false });
t('MUTATION: a failing DB probe fails the self-test', m6.passed === false && m6.failures.includes('db_rolled_back_insert'));
// a late-finishing check must not change the result after the timeout
let release; const gate = new Promise((r) => { release = r; });
const late = await runBootSelfTest({ checks: [['slow', async () => { await gate; return { ok: true }; }]], timeoutMs: 100, persistResult: false });
const before = JSON.stringify(late.checks); release(); await new Promise((r) => setTimeout(r, 50));
t('a late check cannot mutate the recorded result after the timeout', JSON.stringify(late.checks) === before && getBootSelfTestState().passed === false);
// a crashed self-test is recorded as a visible failure and keeps auto-rearm suppressed
await markBootSelfTestCrashed(new Error('simulated crash'), { persistResult: false });
t('a crashed self-test is a recorded failure and suppresses auto-rearm', getBootSelfTestState().failures.includes('self_test_crashed') && bootSelfTestAllowsRearm() === false);
delete process.env.DTC_DLL_LIMIT_USD;

// --- wiring (source-level invariants): the gate and the rearm suppression are actually connected
const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const sweep = src('../server/services/sierraChart/orderSweep.js'), cm = src('../server/services/sierraChart/connectionManager.js');
t('sweepEntries calls entryFeedGate and skips with its reason', /entryFeedGate\(\)/.test(sweep) && /feed && !feed\.ok && wantsMarketEntry\(row\)/.test(sweep));
t('feed gate sits after isOrderEligible and the daily-loss gate', sweep.indexOf('isOrderEligible(row.setup_type') < sweep.indexOf('feed && !feed.ok') && sweep.indexOf('evaluateDailyLossLimit(tradeAccount)') < sweep.indexOf('feed && !feed.ok'));
t('boot self-test runs between forceHaltOnBoot and connectOnce', cm.indexOf('forceHaltOnBoot(') < cm.indexOf('await runBootSelfTest(') && cm.indexOf('await runBootSelfTest(') < cm.indexOf('await connectOnce();'));
t('maybeAutoRearmAfterReconcile consults bootSelfTestAllowsRearm before re-arming', cm.indexOf('bootSelfTestAllowsRearm()') > cm.indexOf('function maybeAutoRearmAfterReconcile') && cm.indexOf('bootSelfTestAllowsRearm()') < cm.indexOf("killSwitch.arm('auto-rearm-on-simulation-boot')"));

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall G0 safety tests passed');
process.exit(fails ? 1 : 0);
