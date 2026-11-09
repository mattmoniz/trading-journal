// Exporter for the RTH high-rotation-regime day count (Opus idea 1, docs/MARKET_MODEL_DESIGN_BRIEF_20261104.md section 10): per trade date, the number of confirmed rotation legs (the real detectRotationLegs, hr-022) on the 1-minute RTH bars 09:30-10:59, for reversal sizes 20..200 step 10 (65 = the live setting). Features only: no outcome is read. Both time bounds on every query (cv-009).
import fs from 'fs';
import path from 'path';
import { query } from '../../../server/db.js';
import { detectRotationLegs } from '../../../server/services/rotationDetector.js';
const repo = path.resolve(new URL('.', import.meta.url).pathname, '..', '..', '..'); const days = JSON.parse(fs.readFileSync(path.join(repo, 'scratch', 'ovn_orderflow_20261104', 'days.json'), 'utf8')); const dates = Object.keys(days).sort(); const out = {};
for (const d of dates) {
  const r = await query(`SELECT high::float AS high, low::float AS low FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::timestamp + interval '9 hours 30 minutes' AND ts < $1::timestamp + interval '11 hours' ORDER BY ts`, [d]);
  if (r.rows.length < 80) continue; const g = {}; for (let R = 20; R <= 200; R += 10) g[R] = detectRotationLegs(r.rows, R).length; g[65] = detectRotationLegs(r.rows, 65).length;
  out[d] = { n: r.rows.length, legs: g };
}
fs.writeFileSync(path.join(repo, 'scratch', 'ovn_orderflow_20261104', 'rth_legs_by_11.json'), JSON.stringify(out)); console.log(Object.keys(out).length, 'dates of', dates.length); process.exit(0);
