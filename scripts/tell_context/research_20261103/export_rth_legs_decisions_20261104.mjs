// Exporter for docs/STRUCTURE_MODEL_STEP_A_PREREG_20261104.md: per trade date, the number of confirmed rotation legs (the real detectRotationLegs, hr-022) on the 1-minute RTH bars from 09:30 up to the decision minute, for the four decision times (minute 60, 120, 210, 300 since 09:30) and reversal sizes 20..200 step 10. Features only: no outcome is read. Both time bounds on every query (cv-009).
import fs from 'fs';
import path from 'path';
import { query } from '../../../server/db.js';
import { detectRotationLegs } from '../../../server/services/rotationDetector.js';
const repo = path.resolve(new URL('.', import.meta.url).pathname, '..', '..', '..'); const days = JSON.parse(fs.readFileSync(path.join(repo, 'scratch', 'ovn_orderflow_20261104', 'days.json'), 'utf8')); const dates = Object.keys(days).sort(); const out = {}; const TIMES = [60, 120, 210, 300];
for (const d of dates) {
  const r = await query(`SELECT high::float AS high, low::float AS low FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::timestamp + interval '9 hours 30 minutes' AND ts < $1::timestamp + interval '14 hours 30 minutes' ORDER BY ts`, [d]);
  if (r.rows.length < 250) continue; const g = {};
  for (const T of TIMES) { const bars = r.rows.slice(0, T); g[T] = {}; for (let R = 20; R <= 200; R += 10) g[T][R] = detectRotationLegs(bars, R).length; }
  out[d] = g;
}
fs.writeFileSync(path.join(repo, 'scratch', 'ovn_orderflow_20261104', 'rth_legs_at_decisions.json'), JSON.stringify(out)); console.log(Object.keys(out).length, 'dates of', dates.length); process.exit(0);
