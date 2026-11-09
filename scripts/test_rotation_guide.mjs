// Tests for server/services/rotationGuide.js: (1) synthetic bars: no leg, an up-leg, a flip, lost-VWAP; (2) the five tell fires of 2026-11-04 read from the real bars (state at each fire, checked against the numbers computed independently
// the same morning with a separate script: legs UP 10:00 @ 28,788.25 confirmed 10:01, DOWN 10:15 @ 28,969 confirmed 10:19; rotational VWAP 28,853.3 / 28,853.1 / 28,862.7 / 28,930.3 / 28,890.2); (3) parity with the research export
// (scratch/rotation_vwap_20261104/state.json, scripts/tell_context/research_20261103/export_rotation_vwap_20261104.mjs) on historical dates with a full 390-minute session.
// Usage: node scripts/test_rotation_guide.mjs   (exit 1 on any failure)
import fs from 'fs';
import { rotationSeries, getRotationAtFires, getRotationGuide } from '../server/services/rotationGuide.js';
import { query } from '../server/db.js';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const near = (a, b, t = 0.11) => a != null && b != null && Math.abs(a - b) <= t;
const bar = (m, h, l, c, v = 100) => ({ m, h, l, c, v });
// (1) synthetic
const flat = Array.from({ length: 30 }, (_, i) => bar(i, 101, 99, 100));
ok(rotationSeries(flat).stateAt(29).dir === null, 'flat bars: no leg confirmed');
const up = [...flat, bar(30, 140, 100, 139), bar(31, 170, 138, 169)];                         // 99 -> 170: an UP leg of 71 confirmed on bar 31
const su = rotationSeries(up).stateAt(31); ok(su.dir === 'UP' && su.anchorPrice === 99 && su.confirmedT === '10:01', 'up-leg confirmed after 65 points, pivot = the low');
ok(su.supported === true && su.side === 'ABOVE', 'price above the VWAP of its own up-leg is supported');
const flip = [...up, bar(32, 170, 100, 105)];                                                   // 170 -> 100: 70 down: the leg flips to DOWN anchored at 170
const sf = rotationSeries(flip).stateAt(32); ok(sf.dir === 'DOWN' && sf.anchorPrice === 170, 'a 65-point reversal flips the leg and re-anchors at the pivot high');
const lost = [...up, ...Array.from({ length: 10 }, (_, k) => bar(32 + k, 170, 166, 168, 1000)), bar(42, 150, 128, 130, 100)];                 // heavy volume near 168, then price drops to 130 (only 40 points: no flip)
const sl = rotationSeries(lost).stateAt(42); ok(sl.dir === 'UP' && sl.side === 'BELOW' && sl.supported === false && sl.distPts < 0, 'lost-VWAP: an up-leg with price under its own VWAP is flagged not supported');
// (2) the real morning
const fires = [['499', '2026-11-04 10:03:43.709', 'UP', 28853.3], ['503', '2026-11-04 10:05:06.259', 'UP', 28853.1], ['505', '2026-11-04 10:11:02.405', 'UP', 28862.7], ['509', '2026-11-04 10:20:15.511', 'DOWN', 28930.3], ['513', '2026-11-04 10:24:35.751', 'DOWN', 28890.2]];
const m = await getRotationAtFires('2026-11-04', fires.map(([id, firedAt]) => ({ id, firedAt })));
for (const [id, , dir, vw] of fires) ok(m[id] && m[id].dir === dir && near(m[id].rvwap, vw), `fire ${id}: leg ${dir}, rotational VWAP ${vw} (got ${m[id]?.dir} ${m[id]?.rvwap})`);
ok(m['499'].anchorT === '10:00' && near(m['499'].anchorPrice, 28788.25, 0.01) && m['499'].confirmedT === '10:01', 'first three fires: UP leg anchored 10:00 at 28,788.25, confirmed 10:01');
ok(m['509'].anchorT === '10:15' && near(m['509'].anchorPrice, 28969, 0.01) && m['509'].confirmedT === '10:19', 'last two fires: DOWN leg anchored 10:15 at 28,969, confirmed 10:19 (the flip)');
ok(m['509'].supported === true && m['505'].dir === 'UP', 'the post-flip fire sits on the supported side of the new down-leg VWAP');
// (3) parity with the research export
if (fs.existsSync(new URL('../scratch/rotation_vwap_20261104/state.json', import.meta.url))) {
  const st = JSON.parse(fs.readFileSync(new URL('../scratch/rotation_vwap_20261104/state.json', import.meta.url), 'utf8')); const dates = Object.keys(st).filter((d) => d < '2025-01-01' && st[d].n === 390).sort(); let checked = 0, bad = 0;
  for (const d of [dates[5], dates[150], dates[300], dates[400]].filter(Boolean)) {
    const rows = (await query(`SELECT (EXTRACT(hour FROM ts)::int * 60 + EXTRACT(minute FROM ts)::int - 570) AS m, high::float AS h, low::float AS l, close::float AS c, COALESCE(volume,0)::float AS v FROM price_bars_primary WHERE symbol='NQ' AND ts >= ($1::timestamp + interval '9 hours 30 minutes') AND ts < ($1::timestamp + interval '16 hours') ORDER BY ts`, [d])).rows;
    if (rows.length !== 390) continue; const s = rotationSeries(rows);
    for (const i of [60, 120, 200, 300, 380]) { const g = s.stateAt(i), e = st[d]; checked++; const gd = g.dir === 'UP' ? 1 : g.dir === 'DOWN' ? -1 : 0; if (gd !== e.dir[i] || (g.dir && (!near(g.rvwap, e.rv[i], 0.011) || !near(g.anchorPrice, e.piv[i], 0.011)))) { bad++; console.log('  mismatch', d, i, g.dir, g.rvwap, g.anchorPrice, 'vs', e.dir[i], e.rv[i], e.piv[i]); } }
  }
  ok(checked > 0 && bad === 0, `parity with the research export on ${checked} (date, minute) points`);
} else console.log('skip (3): no research export file');
const live = await getRotationGuide(); ok(['OK', 'NOT_STARTED'].includes(live.state) && !JSON.stringify(live).includes('NaN') && !JSON.stringify(live).includes('undefined'), `live board: ${live.state}${live.now ? ', leg ' + live.now.dir + ', VWAP ' + live.now.rvwap + ', price ' + live.now.price : ''}`);
console.log(fails ? `${fails} FAILURE(S)` : 'all rotation-guide checks pass'); process.exit(fails ? 1 : 0);
