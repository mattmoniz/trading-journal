// Tests + replay for the overnight tripwire (docs/OPEN_THREADS.md 2026-10-26). Pure-function checks, then a history replay (how often would it have alarmed?) and tonight's (Sunday 2026-10-25 -> Monday) walk.
import assert from 'node:assert/strict';
import { query } from '../server/db.js';
import { midRank, classify, nightOf, getTripwireState, CHECKPOINT_STEP, MIN_ELAPSED, BASELINE_NIGHTS } from '../server/services/overnightTripwire.js';
assert.equal(midRank([1, 2, 3, 4], 5), 1); assert.equal(midRank([1, 2, 3, 4], 0), 0); assert.equal(midRank([2, 2, 2, 2], 2), 0.5);
const b = Array.from({ length: 40 }, (_, i) => i + 1);
assert.equal(classify({ vol: 100, legs: 100, baseVols: b, baseLegs: b }).level, 'HEAVY');
assert.equal(classify({ vol: 100, legs: 1, baseVols: b, baseLegs: b }).level, 'BUSY');
assert.equal(classify({ vol: 1, legs: 1, baseVols: b, baseLegs: b }).level, 'NORMAL');
assert.equal(classify({ vol: 5, legs: 5, baseVols: b.slice(0, 5), baseLegs: b.slice(0, 5) }).level, 'UNKNOWN', 'too few baseline nights');
const n1 = nightOf(new Date('2026-10-25T23:59:00Z')); assert.deepEqual([n1.evening, n1.tradeDate, n1.elapsed], ['2026-10-25', '2026-10-26', 359]);
const n2 = nightOf(new Date('2026-10-26T08:30:00Z')); assert.deepEqual([n2.evening, n2.tradeDate, n2.elapsed], ['2026-10-25', '2026-10-26', 870]);
console.log('pure checks pass');
// replay: for each stored night, baseline = the 60 nights before it; first checkpoint >= MIN_ELAPSED where the level is reached
const rows = (await query(`SELECT trade_date::text d, checkpoint_min c, volume::float v, legs FROM overnight_checkpoint_stats ORDER BY trade_date, checkpoint_min`)).rows;
const byNight = new Map(); for (const r of rows) (byNight.get(r.d) || byNight.set(r.d, new Map()).get(r.d)).set(r.c, r);
const nights = [...byNight.keys()].sort(); let heavy = 0, busy = 0, evaluated = 0; const firstHeavy = [];
for (let i = BASELINE_NIGHTS; i < nights.length; i++) { evaluated++; const prior = nights.slice(i - BASELINE_NIGHTS, i); let h = null, bz = false;
  for (let c = MIN_ELAPSED; c <= 930; c += CHECKPOINT_STEP) { const t = byNight.get(nights[i]).get(c); if (!t) continue; const base = prior.map((d) => byNight.get(d).get(c)).filter(Boolean); const r = classify({ vol: t.v, legs: t.legs, baseVols: base.map((x) => x.v), baseLegs: base.map((x) => x.legs) }); if (r.level === 'BUSY') bz = true; if (r.level === 'HEAVY' && h === null) h = c; }
  if (h !== null) { heavy++; firstHeavy.push({ d: nights[i], at: h }); } else if (bz) busy++; }
console.log(`replay over ${evaluated} nights (baseline = prior ${BASELINE_NIGHTS}): HEAVY at some checkpoint on ${heavy} nights (${(100 * heavy / evaluated).toFixed(0)}%), BUSY-only on ${busy} (${(100 * busy / evaluated).toFixed(0)}%); first HEAVY after the open (minutes): median ${firstHeavy.map((x) => x.at).sort((a, c) => a - c)[Math.floor(firstHeavy.length / 2)]}; last 6 HEAVY nights: ${firstHeavy.slice(-6).map((x) => `${x.d.slice(5)}@${Math.floor(x.at / 60) + 18 > 23 ? Math.floor(x.at / 60) - 6 : Math.floor(x.at / 60) + 18}:${String(x.at % 60).padStart(2, '0')}`).join(', ')}`);
// tonight's walk (Sunday evening -> Monday): the state at each checkpoint
const walk = []; for (const [hh, mm] of [[20, 0], [21, 0], [22, 0], [23, 0], [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [6, 0], [8, 0], [9, 0]]) { const day = hh >= 18 ? '2026-10-25' : '2026-10-26'; const st = await getTripwireState(new Date(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:30Z`)); walk.push(`${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} ${st.level}${st.volRatio ? ` vol ${st.volRatio}x r${(100 * st.volRank).toFixed(0)} legs ${st.legs} r${(100 * st.legsRank).toFixed(0)}` : ''}`); }
console.log('Sunday-night walk:\n  ' + walk.join('\n  '));
process.exit(0);
