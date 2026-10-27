// Completed-cell developing volume-by-price profiles, fat nodes and events for the VbP acceptance / re-entry tests
// (docs/VBP_ACCEPTANCE_REENTRY_PREREG_20261027.md + its amendments). Written 2026-10-27 BEFORE any outcome was computed.
// Cells = volume_at_price_30m (a cell starting at T is usable from T+30 minutes). Sessions: RTH = cells starting 09:30..15:30 on the trade date itself,
// GLOBEX = cells starting 18:00 the evening before .. 09:00. A session is used only if EVERY slot is present (13 RTH, 31 Globex), so half-days
// and gap days drop out. Bins = 0.1 x H4 rounded to 0.25 (H4 = mean four-hour bar range of the 20 prior trade days, from build4h).
import { query } from '../../server/db.js';
import { isInsideNqRollWeek } from '../../server/services/acdShared.js';
import { addDay, SPARSE } from './floorEngine.mjs';

export const N_PEAK = 3, MIN_CELLS = 4, MAX_AFTER = 8; // Sierra peak rule N (assumed), minimum completed cells before a node is read, Test D' follow limit (all chosen, frozen)
export const emOfStart = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16)) / 60000;
const clockOf = (s) => +s.slice(11, 13) * 60 + +s.slice(14, 16);
const tdOfStart = (s) => (+s.slice(11, 13) >= 18 ? addDay(s.slice(0, 10), 1) : s.slice(0, 10));

// ---- load every completed cell with trade date <= endTd (chunked by month; the 18:00 evening of endTd belongs to the next trade date, so it is cut off)
export async function loadCells(startDate, endTd) {
  const cut = addDay(endTd, 0) + ' 18:00:00', cells = new Map();
  let m = new Date(startDate + 'T00:00:00Z'); const end = new Date(endTd + 'T00:00:00Z');
  while (m <= end) {
    const a = m.toISOString().slice(0, 10), nx = new Date(m); nx.setUTCMonth(nx.getUTCMonth() + 1); const b = nx.toISOString().slice(0, 10);
    const r = await query(`SELECT bar_start::text s, (price*4)::int k, vol::float v FROM volume_at_price_30m WHERE bar_start >= $1 AND bar_start < $2 AND bar_start < $3 ORDER BY bar_start`, [a, b, cut]);
    for (const x of r.rows) { const s = x.s.slice(0, 19); let o = cells.get(s); if (!o) cells.set(s, (o = { k: [], v: [] })); o.k.push(x.k); o.v.push(x.v); }
    m = nx;
  }
  return cells;
}

// ---- sessions: ordered arrays of cell starts per (trade date, RTH|GLOBEX), only complete sessions
export function buildSessions(cells, tdSet) {
  const by = new Map();
  for (const s of cells.keys()) {
    const c = clockOf(s), td = tdOfStart(s); let sess = null;
    if (c >= 570 && c <= 930 && s.slice(0, 10) === td) sess = 'RTH'; else if (c >= 1080 || (c < 570 && s.slice(0, 10) === td)) sess = 'GLOBEX';
    if (!sess) continue;
    const key = td + '|' + sess; (by.get(key) || by.set(key, []).get(key)).push(s);
  }
  const out = [], excl = { incompleteRTH: 0, incompleteGlobex: 0, roll: 0, sparse: 0, noBars: 0 };
  for (const [key, arr] of by) {
    const [td, sess] = key.split('|'); arr.sort(); const need = sess === 'RTH' ? 13 : 31;
    if (!tdSet.has(td)) { excl.noBars++; continue; }
    if (isInsideNqRollWeek(td)) { excl.roll++; continue; } if (SPARSE(td)) { excl.sparse++; continue; }
    if (arr.length !== need || emOfStart(arr[arr.length - 1]) - emOfStart(arr[0]) !== 30 * (need - 1)) { excl[sess === 'RTH' ? 'incompleteRTH' : 'incompleteGlobex']++; continue; }
    out.push({ td, sess, starts: arr });
  }
  out.sort((a, b) => (a.td < b.td ? -1 : a.td > b.td ? 1 : a.sess === 'GLOBEX' ? -1 : 1));
  return { sessions: out, excl };
}

// ---- profile helpers (price keys are price*4 integers)
export function addCell(prof, cell) { for (let i = 0; i < cell.k.length; i++) prof.set(cell.k[i], (prof.get(cell.k[i]) || 0) + cell.v[i]); }
const medianOf = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
export const binWidth = (H4) => Math.max(0.25, Math.round((0.1 * H4) / 0.25) * 0.25);
// Fat nodes of a profile: Sierra peak (strictly greater than the N bins above, at least the N below), session extremes excluded; edge = contiguous bins out to the first bin at or below the median of the non-empty bins; nodes narrower than 3 bins dropped; identical edge ranges merged (higher peak kept).
export function fatNodes(prof, bw, N = N_PEAK) {
  const acc = new Map(); let mn = Infinity, mx = -Infinity;
  for (const [k, v] of prof) { const b = Math.floor(k / 4 / bw); acc.set(b, (acc.get(b) || 0) + v); if (b < mn) mn = b; if (b > mx) mx = b; }
  const n = mx - mn + 1; if (!(n >= 2 * N + 1)) return [];
  const raw = new Array(n).fill(0); for (const [b, v] of acc) raw[b - mn] = v;
  const med = medianOf(raw.filter((x) => x > 0)), nodes = new Map();
  for (let i = N; i < n - N; i++) {
    let ok = raw[i] > 0; for (let k = 1; k <= N && ok; k++) if (!(raw[i + k] < raw[i]) || !(raw[i - k] <= raw[i])) ok = false;
    if (!ok) continue;
    let lo = i, hi = i; while (lo - 1 >= 0 && raw[lo - 1] > med) lo--; while (hi + 1 < n && raw[hi + 1] > med) hi++;
    if (hi - lo + 1 < 3) continue;
    const key = lo + '|' + hi, nd = { peakBin: mn + i, lowP: (mn + lo) * bw, highP: (mn + hi + 1) * bw, peakP: (mn + i + 0.5) * bw, peakVol: raw[i] };
    const old = nodes.get(key); if (!old || old.peakVol < nd.peakVol) nodes.set(key, nd);
  }
  return [...nodes.values()];
}
// Outside density of one cell relative to the profile so far (units made consistent: per occupied 0.25 price, profile median per non-empty 0.25 price divided by the number of cells in the profile).
export function outsideDensity(cell, prof, nCells, dir, edgeP) {
  let s = 0, o = 0; for (let i = 0; i < cell.k.length; i++) { const p = cell.k[i] / 4; if ((dir > 0 && p > edgeP) || (dir < 0 && p < edgeP)) { s += cell.v[i]; o++; } }
  if (!o) return null; const med = medianOf([...prof.values()].filter((x) => x > 0)) / nCells; return med > 0 ? s / o / med : null;
}

// ---- per-session walk: the cell closes / entry bars come from the 1-minute bars (NQ indexed with EM/byEm); returns events for A (with C and D' follow-up data)
export function sessionEvents(NQ, cells, sess, h4, linesBy, limit) {
  const { td, starts } = sess, H4 = h4[td]; if (!H4) return { events: [], reason: 'noH4' };
  const bw = binWidth(H4), n = starts.length, closeIdx = new Array(n), closeP = new Array(n), openIdx = new Array(n);
  for (let j = 0; j < n; j++) { const em = emOfStart(starts[j]); const ic = NQ.byEm.get(em + 29), io = NQ.byEm.get(em + 30); closeIdx[j] = ic ?? null; closeP[j] = ic == null ? null : NQ.C[ic]; openIdx[j] = io ?? null; }
  const pocs = (linesBy[td] || []).filter(([nm]) => nm.endsWith('_POC')).map(([, p]) => p);
  const prof = new Map(), seen = new Set(), events = [];
  for (let j = 0; j < n; j++) {
    if (j >= MIN_CELLS) { // node from the profile through cell j-1; breakout cell j
      const cj = closeP[j], cp = closeP[j - 1];
      if (cj != null && cp != null && openIdx[j] != null && openIdx[j] < limit - 3000) {
        const nodes = fatNodes(prof, bw);
        for (const dir of [1, -1]) {
          const cand = nodes.filter((nd) => cp >= nd.lowP && cp <= nd.highP && (dir > 0 ? cj > nd.highP : cj < nd.lowP) && !seen.has(dir + '|' + nd.peakBin)).sort((a, b) => b.peakVol - a.peakVol);
          if (!cand.length) continue; const nd = cand[0]; seen.add(dir + '|' + nd.peakBin);
          const edgeP = dir > 0 ? nd.highP : nd.lowP, dens = outsideDensity(cells.get(starts[j]), prof, j, dir, edgeP);
          if (dens == null) continue;
          events.push({ td, sess: sess.sess, j, n, dir, node: nd, edgeP, H4, dens, dist: ((cj - edgeP) * dir) / H4, i0: openIdx[j], clk: +starts[j].slice(11, 13) * 60 + +starts[j].slice(14, 16) + 30,
            pocNear: pocs.some((p) => Math.abs(p - nd.peakP) <= 0.5 * H4), starts, closeP, openIdx, closeIdx, bw, later: [] });
        }
      }
    }
    for (const e of events) { const m = j - e.j; if (m >= 1 && m <= MAX_AFTER) e.later.push({ m, j, close: closeP[j], dens: outsideDensity(cells.get(starts[j]), prof, j, e.dir, e.edgeP) }); }
    addCell(prof, cells.get(starts[j]));
  }
  return { events, bw };
}

// ---- Test B: prior RTH value area (real tick volume, tickVolumeProfile.getDailyProfiles session 'rth') re-entry. One event per session.
// The session's first bar open (09:30 RTH, 18:00 Globex) is outside the prior RTH value area; the first completed cell that closes inside it, followed by a second inside close, is the event (decision at the 2nd cell's close, entry at the next open toward the far boundary).
export function valueAreaEvent(NQ, sess, vaProfiles, priorTd, limit) {
  const va = vaProfiles[priorTd]; if (!va) return { ev: null, why: 'noVA' };
  const { td, starts } = sess, n = starts.length, em0 = emOfStart(starts[0]), i00 = NQ.byEm.get(em0); if (i00 == null) return { ev: null, why: 'noOpenBar' };
  const open = NQ.O[i00], side = open > va.vah ? 1 : open < va.val ? -1 : 0; if (!side) return { ev: null, why: 'openInside' };
  const closeP = [], openIdx = []; for (let j = 0; j < n; j++) { const em = emOfStart(starts[j]); const ic = NQ.byEm.get(em + 29), io = NQ.byEm.get(em + 30); closeP.push(ic == null ? null : NQ.C[ic]); openIdx.push(io ?? null); }
  const inside = (p) => p != null && p >= va.val && p <= va.vah;
  for (let k = 0; k + 1 < n; k++) {
    if (!(inside(closeP[k]) && inside(closeP[k + 1]))) continue;
    if (k > 0 && inside(closeP[k - 1])) return { ev: null, why: 'insideBefore' }; // first inside cell had an inside predecessor: not a re-entry from outside (cannot happen when the earlier cell was the first inside; kept as a guard)
    const i0 = openIdx[k + 1]; if (i0 == null || i0 >= limit - 3000) return { ev: null, why: 'noEntryBar' };
    const dir = -side, far = side > 0 ? va.val : va.vah, entry = NQ.O[i0]; if ((far - entry) * dir <= 0) return { ev: null, why: 'pastFar' };
    const endIdx = NQ.byEm.get(emOfStart(starts[n - 1]) + 29); if (endIdx == null) return { ev: null, why: 'noEnd' };
    return { ev: { td, sess: sess.sess, dir, side, far, entry, i0, endIdx, dist: Math.abs(far - entry), va, clk: +starts[k + 1].slice(11, 13) * 60 + +starts[k + 1].slice(14, 16) + 30 } };
  }
  return { ev: null, why: 'noReentry' };
}
