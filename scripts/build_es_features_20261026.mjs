// ES corroboration / canary features per NQ level touch: docs/ES_CORROBORATION_PREREG_20261026.md (+ Amendment 1). Features use closed bars strictly before the event bar t.
//   node scripts/build_es_features_20261026.mjs  -> scratch/es_features_20261026.json   (prints COUNTS ONLY, no outcome statistics)
import fs from 'fs';
import { query } from '../server/db.js';
import { loadBars, lb } from './lib/pocJoinLoader.mjs';
const FROM = '2023-03-06', TO = '2026-10-23', LS = [5, 15, 60], KS = [1, 3];
const ET = JSON.parse(fs.readFileSync(new URL('../scratch/level_touch_events_20261026.json', import.meta.url))).rows;
const D = await loadBars(FROM, TO);
const cal = new Map((await query(`SELECT trade_date::text d, rth_minutes m, is_roll_day r FROM es_front_calendar WHERE trade_date BETWEEN $1::date AND $2::date`, [FROM, TO])).rows.map((r) => [r.d, r]));
// ES RTH range per clean session (for ATR20_ES = mean range of the 20 prior clean ES sessions)
const rng = (await query(`SELECT trade_date::text d, MAX(high)::float - MIN(low)::float rg, COUNT(*)::int n FROM price_bars_es_front WHERE ts >= $1::date AND ts < ($2::date + 1) AND ts::time >= '09:30' AND ts::time < '16:00' GROUP BY 1 ORDER BY 1`, ['2023-01-01', TO])).rows.filter((r) => r.n >= 371);
const esDates = rng.map((r) => r.d), esRg = new Map(rng.map((r) => [r.d, r.rg]));
const atrE = (d) => { const j = lb(esDates, d); if (j < 20) return null; let s = 0; for (let i = j - 20; i < j; i++) s += esRg.get(esDates[i]); return s / 20; };
// ES closes by timestamp, front contract only, loaded month by month (bounded)
const ES = new Map(); { let cur = new Date('2023-01-01T00:00:00Z'); const end = new Date('2026-10-31T00:00:00Z');
  while (cur < end) { const nx = new Date(cur); nx.setUTCMonth(nx.getUTCMonth() + 1);
    for (const r of (await query(`SELECT ts::text t, close::float c FROM price_bars_es_front WHERE ts >= $1::date AND ts < $2::date`, [cur.toISOString().slice(0, 10), nx.toISOString().slice(0, 10)])).rows) ES.set(r.t.slice(0, 19), r.c);
    cur = nx; } }
const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19), toMs = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16));
const nq = (ts) => { const i = lb(D.TS, ts); return D.TS[i] === ts ? D.C[i] : null; };
// close-based running extremity of the day (09:30 through each minute), ES and NQ, for Family D
const cumE = new Map(), cumN = new Map();   // date -> { lo[], hi[] } indexed by minute offset from 09:30
const mkCum = (d, get) => { const lo = new Array(390).fill(null), hi = new Array(390).fill(null); let l = Infinity, h = -Infinity; for (let m = 0; m < 390; m++) { const tm = 570 + m, ts = `${d} ${String(Math.floor(tm / 60)).padStart(2, '0')}:${String(tm % 60).padStart(2, '0')}:00`, c = get(ts); if (c != null) { l = Math.min(l, c); h = Math.max(h, c); } lo[m] = l === Infinity ? null : l; hi[m] = h === -Infinity ? null : h; } return { lo, hi }; };
const extremity = (cum, d, ts, f, cClose) => { const m = +ts.slice(11, 13) * 60 + +ts.slice(14, 16) - 1 - 570; if (m < 4 || m >= 390) return null; const c = cum.get(d), lo = c.lo[m], hi = c.hi[m]; if (lo == null || hi == null || !(hi > lo)) return null; return f < 0 ? (cClose - lo) / (hi - lo) : (hi - cClose) / (hi - lo); };
for (const d of new Set(ET.map((r) => r.d))) { cumE.set(d, mkCum(d, (ts) => ES.get(ts) ?? null)); cumN.set(d, mkCum(d, nq)); }
const rows = [], drop = { notClean: 0, rollDay: 0, noAtrE: 0, missing: 0 };
for (const r of ET) {
  const c = cal.get(r.d); if (!c || c.m < 371) { drop.notClean++; continue; } if (c.r) { drop.rollDay++; continue; }
  const aE = atrE(r.d); if (!aE) { drop.noAtrE++; continue; }
  const t0 = toMs(r.ts), at = (back) => fmt(t0 - back * 60000), o = { d: r.d, gi: r.gi };
  const cN1 = nq(at(1)), cE1 = ES.get(at(1)); let ok = cN1 != null && cE1 != null;
  for (const L of LS) { const n0 = nq(at(1 + L)), e0 = ES.get(at(1 + L)); if (n0 == null || e0 == null) { o['aN' + L] = o['aE' + L] = null; continue; } o['aN' + L] = -r.f * (cN1 - n0) / r.atr; o['aE' + L] = -r.f * (cE1 - e0) / aE; }
  for (const k of KS) { const n0 = nq(at(1 + k)), e0 = ES.get(at(1 + k)); if (n0 == null || e0 == null) { o['nN' + k] = o['nE' + k] = null; continue; } o['nN' + k] = r.f * (cN1 - n0) / r.atr; o['nE' + k] = r.f * (cE1 - e0) / aE; }
  o.xE = extremity(cumE, r.d, r.ts, r.f, cE1); o.xN = extremity(cumN, r.d, r.ts, r.f, cN1);
  if (!ok) { drop.missing++; continue; } rows.push(o);
}
fs.writeFileSync(new URL('../scratch/es_features_20261026.json', import.meta.url), JSON.stringify({ rows, drop, LS, KS }));
const days = new Set(rows.map((r) => r.d)), avail = (k) => rows.filter((r) => r[k] != null).length;
console.log(`touches ${ET.length}; with ES features ${rows.length} on ${days.size} days; dropped`, drop);
console.log('feature availability', Object.fromEntries([...LS.flatMap((L) => ['aN' + L, 'aE' + L]), ...KS.flatMap((k) => ['nN' + k, 'nE' + k]), 'xE', 'xN'].map((k) => [k, avail(k)])));
console.log('by year', Object.fromEntries([...new Set(rows.map((r) => r.d.slice(0, 4)))].sort().map((y) => [y, rows.filter((r) => r.d.startsWith(y)).length])));
process.exit(0);
