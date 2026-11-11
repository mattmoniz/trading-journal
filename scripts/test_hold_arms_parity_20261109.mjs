// Parity test: scripts/lib/holdArms.mjs simulateC0 vs the Python replay (needs `capitulation_replay_a10.py --dump-c0` first). 399 historical rows compared 2026-11-09, 0 mismatches.
import fs from 'fs';
import { loadHoldBars, simulateC0, flatTime } from './lib/holdArms.mjs';
import { tsMs } from './lib/levelContext.mjs';
const D = '../scratch/capitulation_replay_20261109';
const rows = new Map(JSON.parse(fs.readFileSync(`${D}/a6_rows.json`)).map((r) => [r.id, r])), dump = JSON.parse(fs.readFileSync(`${D}/a10_c0_dump.json`));
const sample = dump.filter((_, i) => i % 13 === 0).slice(0, 400); let bad = 0, kinds = { STOP: 0, EXP: 0 };
for (const d of sample) {
  const r = rows.get(d.id), exp = r.exp || flatTime(r.f), bars = await loadHoldBars(r.f, exp), p = simulateC0(bars, d.side, r.stp, tsMs(r.f), tsMs(exp));
  const ok = p && p.state === d.kind && p.ms === d.ms && Math.abs(p.px - d.px) < 1e-9; kinds[d.kind]++;
  if (!ok) { bad++; if (bad <= 5) console.log('MISMATCH', d.id, JSON.stringify(p), JSON.stringify(d)); }
}
console.log('rows compared', sample.length, 'mismatches', bad, JSON.stringify(kinds)); process.exit(0);
