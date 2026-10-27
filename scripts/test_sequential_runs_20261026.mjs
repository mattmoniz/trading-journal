// Regression tests for scripts/lib/sequentialRuns.mjs (floor side, synthetic bars). Run: node scripts/test_sequential_runs_20261026.mjs
import { sequentialRuns } from './lib/sequentialRuns.mjs';
const mk = (rows) => rows.map(([L, C], i) => ({ td: '2026-01-01', L, H: L + 20, C, O: C, V: 1, i0: i, i1: i }));
const h4 = { '2026-01-01': 100 }; // band = 0.25 x 100 = 25
let fails = 0; const eq = (n, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) { fails++; console.log('FAIL', n, JSON.stringify(a), '!=', JSON.stringify(b)); } else console.log('ok  ', n); };
// 1. four clean sequential lows within 25 after a descent, closes above the run low: fires once at the 4th bar
let ev = sequentialRuns(mk([[300, 310], [250, 260], [200, 210], [100, 110], [105, 115], [102, 112], [108, 118]]), h4).filter((e) => e.side === 'floor');
eq('clean run fires at the 4th bar (index 6)', ev.map((e) => [e.t, e.len]), [[6, 4]]);
// 2. DeepSeek's case: an early bar closes exactly at its own low (99->99) but is the run minimum only until a lower earlier low is included; here the first bar of the plateau closes at its low and is the minimum => not defended => no run starting there
ev = sequentialRuns(mk([[300, 310], [200, 210], [100, 100], [101, 111], [102, 112], [103, 113]]), h4).filter((e) => e.side === 'floor');
eq('bar closing at the run low does not count (3 later bars only)', ev.length, 0);
// 3. a lower earlier low makes the closes valid again (non-monotone case): bars lows [90,100,101,101.5], closes [99.5,100,102,102]: run low 90, every close above 90 -> 4-bar run, came from above
ev = sequentialRuns(mk([[300, 310], [200, 210], [90, 99.5], [100, 100], [101, 102], [101.5, 102]]), h4).filter((e) => e.side === 'floor');
eq('earlier lower low rescues the run', ev.map((e) => [e.t, e.len]), [[5, 4]]);
// 4. a run that did not come from above (the bar before is also within the band) is rejected only if it cannot be extended; a run starting at index 0 has no "bar before" and is rejected
ev = sequentialRuns(mk([[100, 110], [101, 111], [102, 112], [103, 113]]), h4).filter((e) => e.side === 'floor');
eq('no bar before the run: rejected', ev.length, 0);
// 5. lows spread wider than the band: no run
ev = sequentialRuns(mk([[300, 310], [100, 110], [130, 140], [102, 112], [104, 114], [101, 111]]), h4).filter((e) => e.side === 'floor');
eq('lows spread beyond the band: none', ev.length, 0);
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
