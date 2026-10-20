// flowLeadFeatures.mjs -- readers for the tick-derived files behind forward-monitor rules R6-R8 (docs/ROTATION_GATE_FORWARD_MONITOR_PREREG_20261020.md, amendment 2).
// A session counts as having tick data only if all three files exist: orders (big merged orders), stuffed (their price paths), persec (per-second aggressor volume), in the archive (2023..2026-10-19) or the nightly forward directory.
import fs from 'fs';
const ROOT = new URL('../../', import.meta.url).pathname;
const DIRS = { orders: ['scratch/orders_20261020', 'scratch/forward_ticks/orders'], stuffed: ['scratch/stuffed_20261020', 'scratch/forward_ticks/stuffed'], persec: ['scratch/persec_20261020', 'scratch/forward_ticks/persec'] };
const pathFor = (kind, d) => { for (const dir of DIRS[kind]) { const p = `${ROOT}${dir}/${d}.tsv`; if (fs.existsSync(p)) return p; } return null; };
export const hasTicks = (d) => ['orders', 'stuffed', 'persec'].every((k) => pathFor(k, d));
const C = { big: new Map(), stuffed: new Map(), persec: new Map() };
export const SEC0 = 34200, SECN = 57600 - 34200 + 1;
export function bigNetCum(d, size = 70) {                       // prefix sums over minutes of the day (index m = signed contracts of big orders whose first print is before minute m)
  if (C.big.has(d)) return C.big.get(d); const nm = new Float64Array(1000); const p = pathFor('orders', d);
  if (p) for (const line of fs.readFileSync(p, 'utf8').split('\n')) { if (!line) continue; const c = line.split('\t'); if (+c[2] >= size) nm[Math.floor(+c[1] / 60)] += (c[0] === 'B' ? 1 : -1) * +c[2]; }
  const cum = new Float64Array(1001); for (let m = 0; m < 1000; m++) cum[m + 1] = cum[m] + nm[m]; C.big.set(d, cum); return cum; }
export function stuffedOrders(d, size = 70, ticks = 2) {        // big orders with their price path; stuffed = 60 s after the end the price is >= ticks back against the last print
  if (C.stuffed.has(d)) return C.stuffed.get(d); const out = []; const p = pathFor('stuffed', d);
  if (p) for (const line of fs.readFileSync(p, 'utf8').split('\n')) { if (!line) continue; const c = line.split('\t'); const o = { side: c[0], te: +c[2], size: +c[3], pl: +c[6], vw: +c[7], p60: c[8] === '' ? NaN : +c[8] }; if (o.size < size) continue; o.stuffed = ((o.p60 - o.pl) * (o.side === 'S' ? 1 : -1) / 0.25) >= ticks; o.ref = o.te + 60; out.push(o); }
  C.stuffed.set(d, out); return out; }
export function persecCum(d) {                                  // prefix sums of total contracts per second, seconds 09:30:00-16:00:00
  if (C.persec.has(d)) return C.persec.get(d); const v = new Float64Array(SECN); const p = pathFor('persec', d);
  if (p) for (const line of fs.readFileSync(p, 'utf8').split('\n')) { if (!line) continue; const [s, b, a] = line.split('\t'); const k = +s - SEC0; if (k >= 0 && k < SECN) v[k] += +b + +a; }
  const cum = new Float64Array(SECN + 1); for (let k = 0; k < SECN; k++) cum[k + 1] = cum[k] + v[k]; C.persec.set(d, cum); return cum; }
export const winVol = (cum, T, w) => { const a = T - w - SEC0, b = T - SEC0; return a >= 0 && b <= SECN ? cum[b] - cum[a] : NaN; };   // contracts traded in the w seconds ending at second-of-day T
export const midrank = (x, arr) => { let lt = 0, eq = 0; for (const v of arr) { if (v < x) lt++; else if (v === x) eq++; } return (lt + 0.5 * eq) / arr.length; };
