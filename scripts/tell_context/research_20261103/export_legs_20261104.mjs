// Exporter for docs/TELL_LEG_PROFILE_STOP_AND_FLOOR_EXITS_PREREG_20261104.md: per explore date the confirmed 65-point legs from the REAL detector (server/services/rotationDetector.js detectRotationLegs, intrabar highs and lows, run from the 09:30 bar)
// over the RTH minute bars already exported by export_structure_20261104.mjs (raw.json, missing minutes carried forward as in export_rotation_vwap_20261104.mjs): each leg's direction (+1 up, -1 down), pivot minute (anchor) and confirmation minute (minute of RTH, 0 = 09:30).
// Output scratch/legs_20261104/legs.json {date: [{d, a, c}]}. Read-only, no database. Usage: node scripts/tell_context/research_20261103/export_legs_20261104.mjs
import fs from 'fs';
import path from 'path';
import { detectRotationLegs } from '../../../server/services/rotationDetector.js';
const repo = path.resolve(new URL('.', import.meta.url).pathname, '..', '..', '..');
const raw = JSON.parse(fs.readFileSync(path.join(repo, 'scratch', 'structure_20261104', 'raw.json'), 'utf8')); const out = {}; let n = 0;
for (const [d, r] of Object.entries(raw)) {
  const pos = new Map(r.rth.m.map((m, k) => [m, k])); const bars = []; let lastC = null;
  for (let i = 0; i < 390; i++) { const k = pos.get(i); if (k !== undefined) { bars.push({ high: r.rth.h[k], low: r.rth.l[k] }); lastC = r.rth.c[k]; } else bars.push({ high: lastC, low: lastC }); }
  out[d] = detectRotationLegs(bars).map((L) => ({ d: L.dir === 'UP' ? 1 : -1, a: L.anchorIdx, c: L.idx })); n++;
}
fs.mkdirSync(path.join(repo, 'scratch', 'legs_20261104'), { recursive: true }); fs.writeFileSync(path.join(repo, 'scratch', 'legs_20261104', 'legs.json'), JSON.stringify(out));
console.log(`legs exported for ${n} dates`); process.exit(0);
