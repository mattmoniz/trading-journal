// Data layer for the directional-bias-state study (docs/DIRECTIONAL_BIAS_STATE_SPEC.md). RESEARCH ONLY, as-of safe by construction:
// every accessor that takes a checkpoint (date + session) only returns information from bars strictly BEFORE that checkpoint.
// Feature DEFINITIONS (crack size, which single print is salient, stretch) deliberately live in the study script, not here, so the
// pre-registered choice is made in one place after the design critique.
import { query } from '../../server/db.js';
import { isInsideNqRollWeek } from '../../server/services/acdShared.js';

const TICK = 0.25;
export const mod = (b) => +b.ts.slice(11, 13) * 60 + +b.ts.slice(14, 16);
const msOf = (ts) => Date.UTC(+ts.slice(0, 4), +ts.slice(5, 7) - 1, +ts.slice(8, 10), +ts.slice(11, 13), +ts.slice(14, 16));
const sessionLabel = (ts) => { const hr = +ts.slice(11, 13); return new Date(Date.UTC(+ts.slice(0, 4), +ts.slice(5, 7) - 1, +ts.slice(8, 10) + (hr >= 18 ? 1 : 0))).toISOString().slice(0, 10); };
export const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
export const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
export const pctRank = (ref, v) => (ref.length ? 100 * ref.filter((x) => x < v).length / ref.length : NaN);

// sessions: label date d = the trading date whose RTH it contains; globex bars = prior 18:00 .. 09:29, rth = 09:30 .. 15:59
export async function loadSessions({ from = '2025-11-20 18:00', to = '2026-10-17' } = {}) {
  const rows = (await query(`SELECT ts::text ts, open::float o, high::float h, low::float l, close::float c, volume::float v, bid_volume::float bv, ask_volume::float av
    FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::timestamp AND ts < $2::timestamp ORDER BY ts`, [from, to])).rows;
  const S = new Map();
  for (const b of rows) { const m = mod(b); if (m >= 1020 && m < 1080) continue; b.m = m; b.ms = msOf(b.ts); const d = sessionLabel(b.ts); if (!S.has(d)) S.set(d, []); S.get(d).push(b); }
  const sessions = [];
  for (const d of [...S.keys()].sort()) {
    const bars = S.get(d), g = bars.filter((b) => b.m >= 1080 || b.m < 570), r = bars.filter((b) => b.m >= 570 && b.m < 960);
    if (g.length < 300 || r.length < 300) continue;
    const rng = (a) => Math.max(...a.map((b) => b.h)) - Math.min(...a.map((b) => b.l));
    sessions.push({ d, roll: isInsideNqRollWeek(d), g, r, gOpen: g[0].o, gClose: g[g.length - 1].c, rOpen: r[0].o, rClose: r[r.length - 1].c, gRng: rng(g), rRng: rng(r), dayRng: rng(bars), lo: Math.min(...bars.map((b) => b.l)), hi: Math.max(...bars.map((b) => b.h)) });
  }
  sessions.forEach((s, i) => { s.i = i; });
  return sessions;
}
// median full-session range of the 20 sessions BEFORE index i (normaliser; as-of)
export function normRange(sessions, i, n = 20) { const t = sessions.slice(Math.max(0, i - n), i); return t.length >= 10 ? median(t.map((s) => s.dayRng)) : NaN; }

// single-print zones (30-min TPO on RTH, 0.25 ticks, run >= minPts), annotated with formation facts
export function buildZones(sessions, minPts = 12) {
  const zones = [];
  for (const s of sessions) {
    const per = new Map();
    for (const b of s.r) { const p = Math.floor((b.m - 570) / 30); for (let k = Math.round(b.l / TICK); k <= Math.round(b.h / TICK); k++) { if (!per.has(k)) per.set(k, new Set()); per.get(k).add(p); } }
    const ticks = [...per.keys()].sort((a, b) => a - b); if (!ticks.length) continue;
    const dayLo = ticks[0] * TICK, dayHi = ticks[ticks.length - 1] * TICK;
    let run = []; const runs = [];
    for (const k of ticks) { if (per.get(k).size === 1) { if (run.length && k !== run[run.length - 1] + 1) { runs.push(run); run = []; } run.push(k); } else if (run.length) { runs.push(run); run = []; } }
    if (run.length) runs.push(run);
    for (const r of runs) { const lo = r[0] * TICK, hi = r[r.length - 1] * TICK; if (hi - lo < minPts) continue;
      zones.push({ d: s.d, i: s.i, lo, hi, size: hi - lo, loc: lo <= dayLo + 1 ? 'LOW_TAIL' : hi >= dayHi - 1 ? 'HIGH_TAIL' : 'INTERIOR', dayLo, dayHi, formedAfterMs: s.r[s.r.length - 1].ms }); }
  }
  return zones;
}
// fill state of a zone AS OF a checkpoint (checkpoint = ms; only bars with ms < checkpoint and after formation count).
// depth in [0,1]: share of the zone already traded through from the near edge. Uses ALL sessions' bars (Globex fills count).
export function fillState(sessions, zone, checkpointMs, side) { // side 'BELOW' = zone under price (filled by trading down through zone.lo)
  let reach = side === 'BELOW' ? Infinity : -Infinity;
  for (let i = zone.i + 1; i < sessions.length; i++) { const s = sessions[i]; if (s.g[0].ms >= checkpointMs) break;
    for (const arr of [s.g, s.r]) for (const b of arr) { if (b.ms >= checkpointMs) break; if (b.ms <= zone.formedAfterMs) continue; if (side === 'BELOW') { if (b.l < reach) reach = b.l; } else if (b.h > reach) reach = b.h; } }
  const depth = side === 'BELOW' ? Math.max(0, Math.min(1, (zone.hi - Math.min(reach, zone.hi)) / (zone.hi - zone.lo))) : Math.max(0, Math.min(1, (Math.max(reach, zone.lo) - zone.lo) / (zone.hi - zone.lo)));
  return { depth, open: depth < 1 };
}
// all zones open and on one side of `px` at a checkpoint, formed strictly before it
export function openZonesAsOf(sessions, zones, checkpointMs, px, side) {
  const out = [];
  for (const z of zones) { if (z.formedAfterMs >= checkpointMs) continue; if (side === 'BELOW' ? z.hi >= px : z.lo <= px) continue; const f = fillState(sessions, z, checkpointMs, side); if (f.open) out.push({ ...z, depth: f.depth, dist: side === 'BELOW' ? px - z.hi : z.lo - px, ageSessions: 0 }); }
  return out.sort((a, b) => a.dist - b.dist);
}
export const nextSessionBars = (sessions, i, kind) => (sessions[i + 1] ? sessions[i + 1][kind] : null);
