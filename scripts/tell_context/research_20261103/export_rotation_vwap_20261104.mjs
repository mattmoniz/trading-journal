// Exporter for docs/TELL_ROTATION_VWAP_PREREG_20261104.md: per explore trade date, for the end of every completed RTH minute, the state of the CURRENT confirmed 65-point leg from the REAL detector
// (server/services/rotationDetector.js detectRotationLegs, intrabar highs and lows, run from the 09:30 bar): leg direction (+1 up, -1 down, 0 none yet), the pivot (anchor) price, the volume-weighted VWAP
// anchored at the pivot, the equal-weight anchored average of the same typical prices (volume-inflation control, hr-070) and the session VWAP anchored at 09:30. Typical price = (high + low + close) / 3.
// Output scratch/rotation_vwap_20261104/state.json {date: {n, dir[], piv[], rv[], rt[], sv[]}} indexed by minute of RTH (0 = 09:30). Read-only. Usage: node scripts/tell_context/research_20261103/export_rotation_vwap_20261104.mjs
import fs from 'fs';
import path from 'path';
import { query } from '../../../server/db.js';
import { detectRotationLegs } from '../../../server/services/rotationDetector.js';
const repo = path.resolve(new URL('.', import.meta.url).pathname, '..', '..', '..');
const F = JSON.parse(fs.readFileSync(path.join(repo, 'scratch', 'tell_context_20261103', 'b_d_formation_rows.json'), 'utf8')); const dates = Object.keys(F).sort(); const out = {}; const CH = 60; const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const byDate = {};
for (let i = 0; i < dates.length; i += CH) {
  const ch = dates.slice(i, i + CH); const lo = ch[0] + ' 09:30:00', hi = ch[ch.length - 1] + ' 16:00:00';
  const r = await query(`SELECT ts::date::text AS d, (EXTRACT(hour FROM ts)::int * 60 + EXTRACT(minute FROM ts)::int - 570) AS m, high::float AS high, low::float AS low, close::float AS c, volume::float AS v FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= $1::timestamp AND ts < $2::timestamp AND ts::time >= '09:30' AND ts::time < '16:00' ORDER BY ts`, [lo, hi]);
  for (const x of r.rows) (byDate[x.d] || (byDate[x.d] = [])).push(x);
}
let kept = 0, thin = 0;
for (const d of dates) {
  const raw = byDate[d] || []; if (raw.length < 300) { thin++; continue; }
  const bars = new Array(390).fill(null); for (const x of raw) if (x.m >= 0 && x.m < 390) bars[x.m] = x;          // a missing minute stays null and is carried forward below
  if (!bars[0]) { thin++; continue; }                                                                           // the minute index must equal the position in the sequence: a missing 09:30 bar drops the date
  let last = null; for (let m = 0; m < 390; m++) { if (bars[m]) last = bars[m]; else if (last) bars[m] = { ...last, v: 0, high: last.c, low: last.c }; }
  const seq = bars.filter(Boolean); const legs = detectRotationLegs(seq); const n = seq.length;
  const tp = seq.map((b) => (b.high + b.low + b.c) / 3), v = seq.map((b) => b.v);
  const PV = [0], V = [0], P = [0]; for (let i = 0; i < n; i++) { PV.push(PV[i] + tp[i] * v[i]); V.push(V[i] + v[i]); P.push(P[i] + tp[i]); }
  const dir = new Array(n).fill(0), piv = new Array(n).fill(null), rv = new Array(n).fill(null), rt = new Array(n).fill(null), sv = new Array(n).fill(null); let li = -1;
  for (let i = 0; i < n; i++) {
    while (li + 1 < legs.length && legs[li + 1].idx <= i) li++;
    sv[i] = r2(V[i + 1] > 0 ? PV[i + 1] / V[i + 1] : P[i + 1] / (i + 1));
    if (li < 0) continue; const L = legs[li], a = L.anchorIdx; dir[i] = L.dir === 'UP' ? 1 : -1; piv[i] = r2(L.dir === 'UP' ? seq[a].low : seq[a].high);
    rv[i] = r2(V[i + 1] - V[a] > 0 ? (PV[i + 1] - PV[a]) / (V[i + 1] - V[a]) : (P[i + 1] - P[a]) / (i + 1 - a)); rt[i] = r2((P[i + 1] - P[a]) / (i + 1 - a));
  }
  out[d] = { n, dir, piv, rv, rt, sv }; kept++;
}
fs.mkdirSync(path.join(repo, 'scratch', 'rotation_vwap_20261104'), { recursive: true });
fs.writeFileSync(path.join(repo, 'scratch', 'rotation_vwap_20261104', 'state.json'), JSON.stringify(out));
console.log(`dates ${dates.length}, exported ${kept}, thin or missing (under 300 RTH minutes) ${thin}`); process.exit(0);
