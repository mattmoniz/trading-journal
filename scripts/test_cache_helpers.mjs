// F17/F30 (Fable audit 2026-11-10): cacheDayValue refuses to store empty/incomplete values; caches evict. Run: node scripts/test_cache_helpers.mjs
import assert from 'node:assert/strict';
import { cacheDayValue, getCached, _clearLevelCacheForTests } from '../server/services/acdShared.js';
import { cacheGet, cacheSet } from '../server/lib/cache.js';
_clearLevelCacheForTests();
let calls = 0;
const loader = (v) => async () => { calls++; return v; };
for (const empty of [null, [], {}, new Map(), new Set()]) {
  calls = 0;
  await cacheDayValue('2026-11-10', 'k-empty', loader(empty)); await cacheDayValue('2026-11-10', 'k-empty', loader(empty));
  assert.equal(calls, 2, `empty value ${Array.isArray(empty) ? '[]' : String(empty)} must not be cached`);
}
calls = 0;
const a = await cacheDayValue('2026-11-10', 'k-full', loader({ x: 1 })); const b = await cacheDayValue('2026-11-10', 'k-full', loader({ x: 2 }));
assert.deepEqual(a, { x: 1 }); assert.deepEqual(b, { x: 1 }); assert.equal(calls, 1);
assert.deepEqual(getCached('2026-11-10', 'k-full'), { x: 1 });
calls = 0; await cacheDayValue('d', 'k-zero', loader(0)); await cacheDayValue('d', 'k-zero', loader(0)); assert.equal(calls, 1, 'a legitimate 0 is a complete value and is cached');
cacheSet('t', 1, 1); await new Promise((r) => setTimeout(r, 5)); assert.equal(cacheGet('t'), null);
console.log('cache helper checks passed');
