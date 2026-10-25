// Part B events builder: docs/BAR_CONTEXT_STUDIES_PREREG_B_20261026.md + Amendment 1. Replicates the replay's touch rule (scripts/study_replay_with_times_20261020.mjs) with the
// exclusions actually applied, collapses events sharing a bar into ONE touch, and stores features (T_k, T_S, disjoint T'_k, T_15) and outcomes (ret30/60/120 from open[t+1], pnl_sym).
//   node scripts/build_mtf_touch_events_20261026.mjs   -> scratch/mtf_touch_events_20261026.json
import fs from 'fs';
import { query } from '../server/db.js';
import { loadBars, sessionIndex } from './lib/pocJoinLoader.mjs';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';

export const FROM = '2023-03-06', TO = '2026-10-23', PROX = 15, SPARSE_FROM = '2025-09-28', SPARSE_TO = '2025-11-19', PPT = 2, COMM = 2;
const GATE = { OR5: 575, OR10: 580, OR15: 585, OR30: 600, IB: 630 }; const formGate = (n) => { for (const k of Object.keys(GATE)) if (n.startsWith(k + '_')) return GATE[k]; return 575; };
const familyOf = (n) => /^(OR\d+|IB)_/.test(n) ? 'SAME_DAY_OR_IB' : /^PD_/.test(n) ? 'PD' : /^PW_|^W[PRS]|^WEEKLY/.test(n) ? 'WEEKLY' : /^PM_|^M[PRS]|^MONTHLY/.test(n) ? 'MONTHLY' : /^CAM_/.test(n) ? 'CAM' : /^FLOOR_/.test(n) ? 'FLOOR' : 'OTHER';

const D = await loadBars(FROM, TO), S = sessionIndex(D);
const opt = new Set((await query(`SELECT DISTINCT signal_name FROM performance_audit WHERE signal_type='OPTIMAL_STOP'`)).rows.map((r) => r.signal_name));
const LV = new Map();
for (const r of (await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE trade_date BETWEEN $1::date AND $2::date AND price IS NOT NULL AND level_name <> 'RTH_VWAP'`, [FROM, TO])).rows) (LV.get(r.d) || LV.set(r.d, []).get(r.d)).push(r);
const mod = (gi) => +D.TS[gi].slice(11, 13) * 60 + +D.TS[gi].slice(14, 16);
const rd = new Map(); try { for (const r of JSON.parse(fs.readFileSync(new URL('../scratch/rotation_gate_replay_rows_ts_20261020.json', import.meta.url)))) rd.set(`${r.ts}|${r.lvl}`, r); } catch (_) { /* optional overlap join */ }

function symPnl(gi, endIdx, f) {            // symmetric +/-0.5 ATR20 stop/target from open[t+1], market fills, stop first
  const long = f > 0, entry = D.O[gi + 1], atr = D._atr, stopP = long ? entry - 0.5 * atr : entry + 0.5 * atr, tgtP = long ? entry + 0.5 * atr : entry - 0.5 * atr;
  for (let k = gi + 1; k <= endIdx; k++) {
    if (long ? D.L[k] <= stopP : D.H[k] >= stopP) { const fill = long ? Math.min(stopP, D.O[k]) : Math.max(stopP, D.O[k]); return (long ? fill - entry : entry - fill) * PPT - COMM; }
    if (long ? D.H[k] >= tgtP : D.L[k] <= tgtP) { const fill = long ? Math.max(tgtP, D.O[k]) : Math.min(tgtP, D.O[k]); return (long ? fill - entry : entry - fill) * PPT - COMM; }
  }
  return (long ? D.C[endIdx] - entry : entry - D.C[endIdx]) * PPT - COMM;
}

const excl = { sparse: 0, roll: 0, rollMismatch: 0, noAtrOrLevels: 0 }; const touches = new Map(); let events = 0;
for (let di = 0; di < S.dates.length; di++) {
  const d = S.dates[di]; if (d < FROM || d > TO) continue;
  if (d >= SPARSE_FROM && d <= SPARSE_TO) { excl.sparse++; continue; }
  const prev = S.dates[di - 1]; if (isInsideNqRollWeek(d) || (prev && isInsideNqRollWeek(prev))) { excl.roll++; continue; }
  const atr = S.atr20(d), L = LV.get(d); if (!atr || !L || !prev) { excl.noAtrOrLevels++; continue; }
  const [a, b] = S.rth.get(d), [pa, pb] = S.rth.get(prev), pdc = L.find((x) => x.n === 'PD_CLOSE');
  if (pdc && Math.abs(pdc.p - D.C[pb - 1]) > 0.1 * atr) { excl.rollMismatch++; continue; }
  D._atr = atr;
  const orH = Math.max(...D.H.slice(a, a + 30)), orL = Math.min(...D.L.slice(a, a + 30));
  for (const lev of L) {
    if (!opt.has(lev.n + '_FADE_LONG') && !opt.has(lev.n + '_FADE_SHORT')) continue; const g = formGate(lev.n);
    for (let gi = a + 5; gi < b - 1; gi++) {
      if (mod(gi) < Math.max(575, g) || Math.abs(D.C[gi] - lev.p) > PROX) continue;
      const long = !(D.C[gi - 5] < D.C[gi]), f = long ? 1 : -1, type = `${lev.n}_FADE_${long ? 'LONG' : 'SHORT'}`; if (!opt.has(type)) break;
      events++;
      const key = `${d}|${gi}`; let t = touches.get(key);
      if (!t) {
        const m = mod(gi), c1 = D.C[gi - 1], at = (k) => (gi + k <= b - 1 ? f * (D.C[gi + k] - D.O[gi + 1]) / atr : null);
        t = { d, gi, ts: D.TS[gi], mod: m, f, atr, fam: familyOf(lev.n), levels: [], T60: f * (c1 - D.C[gi - 1 - 60]) / atr, T240: f * (c1 - D.C[gi - 1 - 240]) / atr, T15: f * (c1 - D.C[gi - 1 - 15]) / atr,
          Tp60: f * (D.C[gi - 6] - D.C[gi - 1 - 60]) / atr, Tp240: f * (D.C[gi - 6] - D.C[gi - 1 - 240]) / atr, TS: f * (D.C[pb - 1] - D.O[pa]) / atr,
          bucket: m < 630 ? 'FIRST_HOUR' : m < 870 ? 'MID' : 'LAST_90', orPos: m < 600 ? 'FORMING' : D.C[gi] > orH ? 'ABOVE_OR' : D.C[gi] < orL ? 'BELOW_OR' : 'INSIDE_OR',
          ret30: at(30), ret60: at(60), ret120: at(120), pnlSym: symPnl(gi, b - 1, f) };
        touches.set(key, t);
      }
      t.levels.push(lev.n); const r = rd.get(`${D.TS[gi]}|${lev.n}`); if (r && t.rd === undefined) { t.rd = r.rd; t.agree = r.agree; }
      break; // once per level per day (the replay's rule)
    }
  }
}

// ---- random-timestamp placebo: for each real touch, a random bar of the same session (after 09:35, horizon available) with a random f; 20 seeded draws ----
const PLACEBO_DRAWS = 20; const hash = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const mulberry = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const placebo = Array.from({ length: PLACEBO_DRAWS }, () => []);
const sessOf = new Map(); for (const d of S.dates) sessOf.set(d, S.rth.get(d));
for (const t of touches.values()) {
  const [a, b] = sessOf.get(t.d), prev = S.dates[S.dates.indexOf(t.d) - 1], [pa, pb] = S.rth.get(prev), atr = t.atr; D._atr = atr;
  for (let k = 0; k < PLACEBO_DRAWS; k++) {
    const rnd = mulberry(hash(`${t.d}|${t.gi}|${k}`)); const lo = a + 5, hi = b - 2; const gi = lo + Math.floor(rnd() * (hi - lo)); const f = rnd() < 0.5 ? 1 : -1; const c1 = D.C[gi - 1];
    const at = (kk) => (gi + kk <= b - 1 ? f * (D.C[gi + kk] - D.O[gi + 1]) / atr : null);
    placebo[k].push({ d: t.d, f, T60: f * (c1 - D.C[gi - 1 - 60]) / atr, T240: f * (c1 - D.C[gi - 1 - 240]) / atr, TS: f * (D.C[pb - 1] - D.O[pa]) / atr, ret30: at(30), ret60: at(60), ret120: at(120), pnlSym: symPnl(gi, b - 1, f) });
  }
}
// ---- descriptive Globex arm: real-fill Globex rows since 2026-07-09 (primary, ACTIVE+SHADOW), features at the fire minute ----
import { resolveDirection } from '../server/config/setupTypes.js';
import { lb } from './lib/pocJoinLoader.mjs';
const gx = (await query(`SELECT setup_type, fired_at::text fa, entry_zone_low::float elo, entry_zone_high::float ehi, stop_level::float stop, t1_level::float t1 FROM active_setups
  WHERE is_rth = false AND origin_status IN ('ACTIVE','SHADOW') AND is_cluster_primary IS NOT FALSE AND actual_pnl IS NOT NULL AND trade_date >= '2026-07-09' AND resolution IS DISTINCT FROM 'NOT_FILLED'
  AND ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE AND setup_type NOT LIKE 'POC_ROTATION_JOIN%'`)).rows;
const globex = [];
for (const r of gx) {
  const dir = resolveDirection({ setup_type: r.setup_type, entry_zone_low: r.elo, entry_zone_high: r.ehi, stop_level: r.stop, t1_level: r.t1 }); if (dir === null) continue; const f = dir === 'LONG' ? 1 : -1;
  const gi = lb(D.TS, r.fa.slice(0, 16) + ':00'); if (gi < 300 || gi + 61 >= D.TS.length) continue; const fd = r.fa.slice(0, 10);
  const pd = [...S.dates].reverse().find((d) => d < (+r.fa.slice(11, 13) >= 18 ? addDays(fd, 1) : fd) && d < fd + 'z'); if (!pd) continue; const [pa, pb] = S.rth.get(pd); const atr = S.atr20(pd); if (!atr) continue;
  globex.push({ d: fd, f, T60: f * (D.C[gi - 1] - D.C[gi - 61]) / atr, T240: f * (D.C[gi - 1] - D.C[gi - 241]) / atr, TS: f * (D.C[pb - 1] - D.O[pa]) / atr, ret60: f * (D.C[gi + 60] - D.O[gi + 1]) / atr });
}
function addDays(dstr, n) { const x = new Date(dstr + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
const rows = [...touches.values()].sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : x.gi - y.gi)).map((t) => ({ ...t, nLevels: t.levels.length, levels: undefined, fam: t.fam }));
fs.writeFileSync(new URL('../scratch/mtf_touch_events_20261026.json', import.meta.url), JSON.stringify({ rows, excl, events, from: FROM, to: TO, placebo, globex }));
const dates = new Set(rows.map((r) => r.d));
console.log(`window ${FROM}..${TO}: events ${events} -> touches ${rows.length} on ${dates.size} dates; excluded days`, excl);
console.log('touches by bucket', Object.fromEntries(['FIRST_HOUR', 'MID', 'LAST_90'].map((b) => [b, rows.filter((r) => r.bucket === b).length])), 'by f', { long: rows.filter((r) => r.f > 0).length, short: rows.filter((r) => r.f < 0).length });
console.log('placebo draws', PLACEBO_DRAWS, 'x', placebo[0].length, '| globex descriptive rows', globex.length);
console.log('with ret60', rows.filter((r) => r.ret60 != null).length, '| with rd join', rows.filter((r) => r.rd !== undefined).length);
process.exit(0);
