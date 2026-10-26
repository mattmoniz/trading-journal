// Causal minute-scale pivot context (2026-10-26, docs/STUFFED_AT_DEFENDED_PIVOT_PREREG_20261026.md).
// Same ingredients as server/services/minorDefendedLevelDetector.js (5-minute bars, findSwingPoints width 5, ZigZag acceptance at 0.25 x ATR, band 0.02 x ATR) but the ZigZag walk is INCREMENTAL:
// every accepted pivot records when it became known (confirmT) and when it stopped being the live pivot (replaced by a more extreme same-type pivot, or broken by a 5-minute close beyond it), so a lookup at time T never uses a later fact.
import { query } from '../../server/db.js';
import { findSwingPoints } from '../../server/services/swingPivots.js';
import { buildRollWeekDateSet, walkZigZagAcceptance } from '../../server/services/acdShared.js';
import { emOf } from './floorEngine.mjs';
export const SW = 5;

// stream NQ 1-minute bars month by month straight into 5-minute bars (no 1-minute array is kept) + calendar-day ranges for the detector-style ATR
export async function load5m(from, to) {
  const bars5m = [], dayRange = new Map(); let cur = null, m = new Date(from + 'T00:00:00Z'); const end = new Date(to + 'T00:00:00Z');
  while (m <= end) {
    const a = m.toISOString().slice(0, 10), nx = new Date(m); nx.setUTCMonth(nx.getUTCMonth() + 1); const b = nx.toISOString().slice(0, 10);
    const r = await query(`SELECT ts::text t, high::float h, low::float l, close::float c FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1 AND ts < $2 ORDER BY ts`, [a, b]);
    for (const x of r.rows) {
      const t = x.t.slice(0, 19), d = t.slice(0, 10), bm = Math.floor(+t.slice(14, 16) / 5) * 5, key = t.slice(0, 14) + String(bm).padStart(2, '0') + ':00';
      if (!cur || cur.tsStr !== key) { if (cur) bars5m.push(cur); cur = { tsStr: key, dateStr: d, high: x.h, low: x.l, close: x.c }; } else { cur.high = Math.max(cur.high, x.h); cur.low = Math.min(cur.low, x.l); cur.close = x.c; }
      const dr = dayRange.get(d) || dayRange.set(d, { h: -Infinity, l: Infinity }).get(d); dr.h = Math.max(dr.h, x.h); dr.l = Math.min(dr.l, x.l);
    }
    m = nx;
  }
  if (cur) bars5m.push(cur);
  const days = [...dayRange.keys()].sort(), atr = {}; days.forEach((d, i) => { if (i >= 20) { let s = 0; for (let j = i - 20; j < i; j++) s += dayRange.get(days[j]).h - dayRange.get(days[j]).l; atr[d] = s / 20; } });
  return { bars5m, atr };
}

export async function pivotTimeline(bars5m, atrByDate, { zig = 0.25, bandMult = 0.02, leaveMult = 0.1, minGapMin = 10 } = {}) {
  const rollDates = buildRollWeekDateSet(bars5m), { highs, lows } = findSwingPoints(bars5m, SW);
  const merged = [...highs.map((p) => ({ ...p, type: 'HIGH' })), ...lows.map((p) => ({ ...p, type: 'LOW' }))].sort((a, b) => a.idx - b.idx);
  const entries = []; let last = null; // incremental walk, same rules as walkZigZagAcceptance
  const mk = (p) => ({ type: p.type, price: p.price, idx: p.idx, confirmIdx: p.idx + SW, replacedIdx: Infinity });
  for (const p of merged) {
    if (rollDates.has(bars5m[p.idx].dateStr)) continue;
    if (!last) { last = mk(p); entries.push(last); continue; }
    const atr = atrByDate[bars5m[p.idx].dateStr]; if (atr == null) continue;
    if (p.type === last.type) { if ((p.type === 'HIGH' && p.price > last.price) || (p.type === 'LOW' && p.price < last.price)) { last.replacedIdx = p.idx + SW; last = mk(p); entries.push(last); } continue; }
    if (Math.abs(p.price - last.price) >= zig * atr) { last = mk(p); entries.push(last); }
  }
  // equality with the shared function (final accepted set)
  const shared = await walkZigZagAcceptance(merged, bars5m, rollDates, zig, (idx) => atrByDate[bars5m[idx].dateStr]);
  const live = entries.filter((e) => e.replacedIdx === Infinity), same = shared.length === live.length && shared.every((s, k) => s.idx === live[k].idx && s.price === live[k].price);
  const minOf = (i) => emOf(bars5m[i].tsStr); // start minute of 5-minute bar i (naive ET minutes since epoch)
  const piv = [];
  for (const e of entries) {
    if (e.confirmIdx >= bars5m.length - 1) continue; const atr = atrByDate[bars5m[e.idx].dateStr]; if (!atr) continue; const band = bandMult * atr, leave = leaveMult * atr, L = e.price, low = e.type === 'LOW';
    let endIdx = Math.min(e.replacedIdx, bars5m.length), touching = false, prevTest = -Infinity; const tests = [];
    let endT = e.replacedIdx === Infinity ? Infinity : minOf(Math.min(e.replacedIdx, bars5m.length - 1)) + 5; // replaced: the pivot stays live until the replacing pivot is KNOWN (end of the bar that confirms it), never earlier
    for (let i = e.confirmIdx + 1; i < endIdx; i++) {
      const b = bars5m[i]; if (rollDates.has(b.dateStr)) { endT = Math.min(endT, minOf(i)); break; }
      if (low ? b.close < L - band : b.close > L + band) { endT = Math.min(endT, minOf(i) + 5); break; } // broken: known at the close of bar i
      if (low ? b.low <= L + band : b.high >= L - band) touching = true;
      else if (touching && (low ? b.low >= L + leave : b.high <= L - leave)) { const tEnd = minOf(i) + 5; if (tEnd - prevTest >= minGapMin) { tests.push(tEnd); prevTest = tEnd; } touching = false; }
    }
    piv.push({ type: e.type, price: L, idx: e.idx, band, confirmT: minOf(e.confirmIdx) + 5, endT, replT: e.replacedIdx === Infinity ? Infinity : minOf(Math.min(e.replacedIdx, bars5m.length - 1)) + 5, tests });
  }
  return { piv, same, nAccepted: live.length, nEntries: entries.length };
}

// active pivot lookup: pivots grouped by trade date for speed
export function indexByDate(piv, dates) {
  const out = new Map(); for (const d of dates) { const s = emOf(d + ' 00:00:00'), e = s + 1440; out.set(d, piv.filter((p) => p.confirmT <= e && p.endT >= s)); } return out;
}
// the nearest active pivot of the given type with the order's last print inside its band, known and confirmed >= 30 minutes before T; defended = a completed prior test
export function pivotAt(cands, type, price, T) {
  let best = null; for (const p of cands) { if (p.type !== type || p.confirmT + 30 > T || T >= p.endT) continue; const dist = Math.abs(price - p.price); if (dist <= p.band && (!best || dist < best.dist)) best = { dist, p, tests: p.tests.filter((t) => t <= T).length }; }
  return best;
}
