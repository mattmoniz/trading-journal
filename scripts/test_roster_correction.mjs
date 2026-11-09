// Unit tests for the roster multiplicity correction (scripts/calibrate_live_roster.mjs: holmPass, bootstrapP). Usage: node scripts/test_roster_correction.mjs
import { holmPass, bootstrapP } from './calibrate_live_roster.mjs';
{
  const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
  const h = holmPass([{ key: 'a', p: 0.001 }, { key: 'b', p: 0.02 }, { key: 'c', p: 0.04 }, { key: 'd', p: 0.9 }], 0.10);
  ok(h.has('a') && h.has('b') && h.has('c') && !h.has('d'), 'Holm m=4 alpha 0.10: thresholds 0.025 / 0.033 / 0.05 / 0.10, so a, b, c pass and d (0.9) does not');
  const h3 = holmPass([{ key: 'a', p: 0.001 }, { key: 'b', p: 0.04 }, { key: 'c', p: 0.045 }, { key: 'd', p: 0.9 }, { key: 'e', p: 0.9 }], 0.10);
  ok(h3.has('a') && !h3.has('b') && !h3.has('c'), 'Holm m=5: b at 0.04 fails its 0.033 threshold, and the step-down stops there (c at 0.045 fails too although it is below its own 0.05)');
  ok(holmPass([], 0.1).size === 0, 'Holm on an empty family passes nothing');
  const win = Array.from({ length: 12 }, (_, i) => ({ date: 'd' + i, pnl: 50 + (i % 3) })), lose = Array.from({ length: 12 }, (_, i) => ({ date: 'd' + i, pnl: -50 - (i % 3) }));
  ok(bootstrapP(win, 'w') < 0.01, 'bootstrapP: a consistent winner has a tiny p'); ok(bootstrapP(lose, 'l') > 0.99, 'bootstrapP: a consistent loser has p near 1'); ok(bootstrapP(win, 'w') === bootstrapP(win, 'w'), 'bootstrapP is deterministic');
}
console.log(process.exitCode ? 'FAILED' : 'all passed'); process.exit(process.exitCode || 0);
