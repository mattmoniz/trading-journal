// Tests for the LIVE_ROSTER gate (2026-10-21): pure roster-building logic + the gate against the real DB row + fail-closed paths.
import { oppositeOf, evaluateType, buildRoster, MIN_DAYS } from './calibrate_live_roster.mjs';
import { computeSuppressionSets, isLiveEligible, getCanonicalLiveStatus, checkLiveRoster, getLiveRoster, __setLiveRosterForTest, LIVE_ROSTER_GATE } from '../server/services/setupEligibility.js';
import { checkStandardLiveGates } from '../server/services/detectorLiveGates.js';
let fails = 0; const ok = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails++; };
ok(oppositeOf('IB_HIGH_FADE_SHORT') === 'IB_HIGH_FADE_LONG', 'oppositeOf SHORT->LONG');
ok(oppositeOf('PW_VAL_FADE_LONG_OVERNIGHT') === 'PW_VAL_FADE_SHORT_OVERNIGHT', 'oppositeOf keeps _OVERNIGHT suffix');
ok(oppositeOf('MOMENTUM_CHASE_MEDIUM') === null, 'oppositeOf no direction => null');
const ev = (pass, lobd) => ({ pass, passLeaveBestDayOut: lobd });
const known = new Set(['A_FADE_LONG', 'A_FADE_SHORT', 'B_FADE_LONG', 'B_FADE_SHORT']);
let r = buildRoster(new Map([['A_FADE_LONG', ev(true, false)]]), null, known, true);
ok(r.has('A_FADE_LONG') && r.has('A_FADE_SHORT') && r.get('A_FADE_SHORT').role === 'sibling', 'first run seeds without hysteresis; sibling added when siblings are on');
r = buildRoster(new Map([['A_FADE_LONG', ev(true, false)]]), null, known, false);
ok(r.has('A_FADE_LONG') && !r.has('A_FADE_SHORT'), 'siblings off: passing type only');
r = buildRoster(new Map([['A_FADE_LONG', ev(true, false)]]), null, known);
ok(!r.has('A_FADE_SHORT'), 'default is siblings off (3-setup start)');
r = buildRoster(new Map([['A_FADE_LONG', ev(true, false)], ['B_FADE_LONG', ev(true, true)]]), new Set(['A_FADE_LONG']), known, true);
ok(r.has('A_FADE_LONG') && r.has('B_FADE_LONG'), 'previous member stays on base rule; new member passing leave-best-day-out is promoted');
r = buildRoster(new Map([['B_FADE_LONG', ev(true, false)]]), new Set(['A_FADE_LONG']), known);
ok(r.size === 0, 'new promotion failing leave-best-day-out is held back; previous member that no longer passes is demoted instantly');
const t = (d, p) => ({ date: d, pnl: p, cluster_touch_id: null });
ok(evaluateType([t('2026-08-01', 5)], 'x').thin === true, 'evaluateType: too few days => thin');
const mk = (n, f) => Array.from({ length: n }, (_, i) => t('2026-08-' + String(i + 1).padStart(2, '0'), f(i)));
ok(evaluateType(mk(MIN_DAYS - 1, () => 10), 'x').thin === true, 'evaluateType: MIN_DAYS-1 days => thin');
const atFloor = evaluateType(mk(MIN_DAYS, (i) => 10 + (i % 3)), 'x');
ok(atFloor.thin === false && atFloor.pass === true && atFloor.passLeaveBestDayOut === false, 'evaluateType: exactly MIN_DAYS days can pass the base rule but cannot be promoted fresh (leave-best-day-out needs one more day)');
const aboveFloor = evaluateType(mk(MIN_DAYS + 3, (i) => 10 + (i % 3)), 'x');
ok(aboveFloor.pass === true && aboveFloor.passLeaveBestDayOut === true, 'evaluateType: a clearly positive, steady type with MIN_DAYS+3 days passes both tests');
// live DB row
const roster = await getLiveRoster();
ok(roster.state === 'OK' && roster.types.size >= 1, `real roster row loads (state ${roster.state}, ${roster.types.size} types, run ${roster.runDate})`);
const sets = await computeSuppressionSets(1);
const on = [...roster.types][0], offType = [...sets.knownTypes].find((x) => !roster.types.has(x));
ok(sets.rosterBlocked.has(offType) && sets.suppressedSetups.has(offType), `off-roster known type ${offType} lands in suppressedSetups + rosterBlocked`);
ok(!sets.rosterBlocked.has(on), `roster type ${on} is not roster-blocked`);
ok(!sets.rosterBlocked.size || !sets.knownTypes.size ? false : [...sets.rosterBlocked].every((x) => sets.knownTypes.has(x)), 'rosterBlocked only contains known types');
ok(isLiveEligible(offType, sets) === false, 'isLiveEligible false for an off-roster type');
const gs = await getCanonicalLiveStatus(offType);
ok(gs.status === 'SHADOW' && gs.reason === 'NOT_ON_LIVE_ROSTER', `getCanonicalLiveStatus SHADOW/NOT_ON_LIVE_ROSTER for ${offType}`);
const g1 = await checkStandardLiveGates({ direction: 'LONG', setupType: offType });
ok(g1.forceShadow && g1.reason === 'NOT_ON_LIVE_ROSTER', 'detector checkpoint force-shadows an off-roster type');
const gOn = await checkLiveRoster(on); ok(!gOn.blocked, 'roster member passes the roster check');
// fail-closed paths
for (const state of ['MISSING', 'STALE', 'EMPTY']) {
  __setLiveRosterForTest({ state, types: new Set([on]), runDate: null });
  const c = await checkLiveRoster(on);
  ok(c.blocked && c.reason === 'LIVE_ROSTER_UNAVAILABLE', `state ${state} blocks even a roster member (fail closed)`);
  ok(isLiveEligible(on, { suppressedSetups: new Set(), dowSuppressToday: new Set(), knownTypes: new Set([on]) }) === false, `isLiveEligible false in state ${state}`);
}
LIVE_ROSTER_GATE.enabled = false;
ok(!(await checkLiveRoster(offType)).blocked, 'gate disabled => no roster blocking (explicit human flag)');
LIVE_ROSTER_GATE.enabled = true;
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
