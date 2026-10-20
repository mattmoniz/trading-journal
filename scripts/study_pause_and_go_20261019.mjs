// study_pause_and_go_20261019.mjs -- "stair-step" hypothesis (user chart reading 2026-10-19): impulse leg -> PAUSE (stalled, compressed, heavy volume stuffed) at stacked defended levels -> continuation.
// Phase 0 bar-level pretest, no stop/target machinery: forward signed return (ATR20 units) after the pause BREAKS, at 15/30/60/120/240 min, vs placebo (levels shifted +/-0.3/0.6 ATR, sign-flip null, AT-LEVELS vs BARE).
// Leg = 65pt reversal rule (same as rotationDetector). Pause = last 12 bars with range <= p25 of the same session-type's trailing-20-session 12-bar ranges, stalled short of the leg extreme. Break = first close beyond the window within 12 bars.
// Independently built alongside Gemini's version (scratch/gemini_pause_and_go.mjs); both from the spec in scratch/claude_request.md. Distribution reference = previous 20 sessions of the SAME type (RTH vs Globex).
// Run: node scripts/study_pause_and_go_20261019.mjs [from] [to]
import fs from 'fs';
import { query } from '../server/db.js';
const FROM = process.argv[2] || '2023-03-06', TO = process.argv[3] || '2026-10-16', R = 65, W = 12, HZ = [15, 30, 60, 120, 240], SHIFTS = [-0.6, -0.3, 0.3, 0.6];
const sum = (a) => { let s = 0; for (const x of a) s += x; return s; }, mean = (a) => a.length ? sum(a) / a.length : NaN, f = (x, d = 3) => (x == null || Number.isNaN(x) ? '  n/a' : (x >= 0 ? '+' : '') + x.toFixed(d));
const addDay = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const LONG = /^(PW_|PM_|PY_|3M_|10D_|5D_|WEEKLY_|MONTHLY_|WPP|WR\d|WS\d|MPP|MR\d|MS\d)/, USE = /^(PD_|PW_|PM_|PY_|3M_|10D_|5D_|CAM_|FLOOR_|ONH$|ONL$|WPP|WR\d|WS\d|MPP|MR\d|MS\d|WEEKLY_OPEN|MONTHLY_OPEN|WEEKLY_VWAP|MONTHLY_VWAP)/;
// ---- load
const eve = new Map(), mor = new Map(), rth = new Map();
let cur = new Date(FROM + 'T00:00:00Z'); cur.setUTCDate(cur.getUTCDate() - 45); const end = new Date(TO + 'T00:00:00Z'); end.setUTCDate(end.getUTCDate() + 1);
while (cur < end) { const nxt = new Date(cur); nxt.setUTCDate(nxt.getUTCDate() + 31);
  for (const x of (await query(`SELECT ts::date::text d, (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int m, high::float h, low::float l, close::float c, COALESCE(volume,0)::float v, COALESCE(bid_volume,0)::float bv, COALESCE(ask_volume,0)::float av FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date ORDER BY ts`, [cur.toISOString().slice(0, 10), nxt.toISOString().slice(0, 10)])).rows) {
    const t = x.m >= 1080 ? eve : x.m < 570 ? mor : x.m < 960 ? rth : null; if (!t) continue; let a = t.get(x.d); if (!a) t.set(x.d, a = []); a.push(x); } cur = nxt; }
const rthDates = [...rth.keys()].filter(d => rth.get(d).length > 60).sort();
const atrOf = new Map(); { const rng = []; for (const d of rthDates) { if (rng.length >= 20) atrOf.set(d, mean(rng.slice(-20))); const b = rth.get(d); rng.push(Math.max(...b.map(x => x.h)) - Math.min(...b.map(x => x.l))); } }
const lv = new Map(); for (const r of (await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE trade_date BETWEEN $1::date AND $2::date AND price IS NOT NULL`, [FROM, TO])).rows) if (USE.test(r.n) || r.n === 'PD_CLOSE') (lv.get(r.d) || lv.set(r.d, []).get(r.d)).push(r);
const sessionsOf = (D) => ({ RTH: rth.get(D) || [], GLOBEX: [...(eve.get(addDay(D, -1)) || []), ...(mor.get(D) || [])] });
// rolling 12-bar stats per session (for the trailing reference distribution)
function rollStats(b) { const rg = [], vs = []; for (let i = W - 1; i < b.length; i++) { let hi = -Infinity, lo = Infinity, v = 0; for (let k = i - W + 1; k <= i; k++) { hi = Math.max(hi, b[k].h); lo = Math.min(lo, b[k].l); v += b[k].v; } rg.push(hi - lo); vs.push(v); } return { rg, vs }; }
const refCache = { RTH: [], GLOBEX: [] };    // trailing list of per-session roll stats, by type
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
const baseline = []; const events = []; let skippedRoll = 0, sparse = 0, sessCount = { RTH: 0, GLOBEX: 0 };
for (let di = 0; di < rthDates.length; di++) {
  const D = rthDates[di], ses = sessionsOf(D), atr = atrOf.get(D), L = lv.get(D) || [];
  const prevD = rthDates[di - 1], pdc = L.find(x => x.n === 'PD_CLOSE');
  const dayOk = atr && L.length && !(pdc && prevD && Math.abs(pdc.p - rth.get(prevD)[rth.get(prevD).length - 1].c) > 0.1 * atr);
  for (const type of ['RTH', 'GLOBEX']) {
    const b = ses[type]; const st = b.length >= W + 5 ? rollStats(b) : null;
    const ref = refCache[type];
    if (D >= FROM && D <= TO && dayOk && b.length && st && ref.length >= 20) {
      if (type === 'GLOBEX' && b.length < 0.9 * 930) { sparse++; }
      else {
        sessCount[type]++;
        const allRg = ref.slice(-20).flatMap(s => s.rg), allVs = ref.slice(-20).flatMap(s => s.vs), p25 = pct(allRg, 0.25), vm = mean(allVs), vsd = Math.sqrt(mean(allVs.map(x => (x - vm) ** 2)));
        // pass 1: leg state + pause candidates
        let runH = -Infinity, runL = Infinity, dir = 0, legStart = null, ext = null, extIdx = -1, used = false, order = 0; const cands = [];
        for (let i = 0; i < b.length; i++) {
          const x = b[i]; runH = Math.max(runH, x.h); runL = Math.min(runL, x.l);
          if (dir === 0) { const up = x.h - runL >= R, dn = runH - x.l >= R; if (up && !dn) { dir = 1; legStart = runL; ext = x.h; extIdx = i; used = false; order = 0; } else if (dn && !up) { dir = -1; legStart = runH; ext = x.l; extIdx = i; used = false; order = 0; } continue; }
          if (dir === 1) { if (x.h > ext) { ext = x.h; extIdx = i; used = false; } if (ext - x.l >= R) { dir = -1; legStart = ext; ext = x.l; extIdx = i; used = false; order = 0; continue; } }
          else { if (x.l < ext) { ext = x.l; extIdx = i; used = false; } if (x.h - ext >= R) { dir = 1; legStart = ext; ext = x.h; extIdx = i; used = false; order = 0; continue; } }
          if (i % 15 === 0) { const rr0 = {}; for (const h of HZ) if (i + h < b.length) rr0[h] = dir * (b[i + h].c - x.c) / atr; baseline.push({ D, ses: type, rr: rr0 }); }
          if (used || i < W - 1 || i - extIdx < 3) continue;
          let hi = -Infinity, lo = Infinity, v = 0, bv = 0, av = 0; for (let k = i - W + 1; k <= i; k++) { hi = Math.max(hi, b[k].h); lo = Math.min(lo, b[k].l); v += b[k].v; bv += b[k].bv; av += b[k].av; }
          const rg = hi - lo; if (rg > p25) continue;
          const stalled = dir === 1 ? hi <= ext - 0.25 * rg : lo >= ext + 0.25 * rg; if (!stalled) continue;
          used = true; order++; cands.push({ i, hi, lo, S: dir, order, volz: vsd > 0 ? (v - vm) / vsd : 0, flow: (av + bv) > 0 ? dir * (av - bv) / (av + bv) : 0 });
        }
        // pass 2: break search
        for (const c of cands) for (let j = c.i + 1; j <= Math.min(c.i + 12, b.length - 1); j++) {
          const cl = b[j].c, goUp = cl > c.hi, goDn = cl < c.lo; if (!goUp && !goDn) continue;
          const Bd = goUp ? 1 : -1, type2 = Bd === c.S ? 'GO' : 'FAIL', rr = {};
          for (const h of HZ) if (j + h < b.length) rr[h] = Bd * (b[j + h].c - cl) / atr;
          const near = (shift) => { const lo2 = c.lo - 0.15 * atr, hi2 = c.hi + 0.15 * atr; let n = 0, nl = 0; for (const l of L) { if (l.n === 'PD_CLOSE' && !USE.test('PD_CLOSE')) continue; const p = l.p + shift * atr; if (p >= lo2 && p <= hi2) { n++; if (LONG.test(l.n)) nl++; } } return [n, nl]; };
          const [n0, nl0] = near(0); const pl = SHIFTS.map(s => near(s)[0]);
          events.push({ D, ses: type, type: type2, order: c.order, volz: c.volz, flow: c.flow, n: n0, nl: nl0, plAt: pl.map(x => x >= 1), rr, S: c.S, Bd });
          break; }
      }
    }
    if (st) { ref.push(st); if (ref.length > 25) ref.shift(); }
  }
}
// ---- stats
let seed = 31337; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
function ci(arr, h, n = 600) { const by = new Map(); for (const e of arr) if (e.rr[h] != null) (by.get(e.D) || by.set(e.D, []).get(e.D)).push(e.rr[h]); const ds = [...by.values()]; if (!ds.length) return [NaN, NaN]; const S = ds.map(sum), C = ds.map(x => x.length), o = []; for (let b = 0; b < n; b++) { let s = 0, c = 0; for (let k = 0; k < ds.length; k++) { const j = (rnd() * ds.length) | 0; s += S[j]; c += C[j]; } if (c) o.push(s / c); } o.sort((a, b) => a - b); return [o[Math.floor(0.025 * o.length)], o[Math.floor(0.975 * o.length)]]; }
const cell = (label, arr) => { if (arr.length < 20) return console.log(label.padEnd(30), `thin N=${arr.length}`); const days = new Set(arr.map(e => e.D)).size; console.log(label.padEnd(30), String(arr.length).padStart(5), String(days).padStart(5), HZ.map(h => { const v = arr.map(e => e.rr[h]).filter(x => x != null); const [lo, hi] = ci(arr, h); return (f(mean(v), 2) + (lo > 0 ? '*' : hi < 0 ? '!' : ' ')).padStart(9); }).join('')); };
console.log(`Sessions used RTH ${sessCount.RTH}, GLOBEX ${sessCount.GLOBEX} (sparse Globex dropped ${sparse}). Events ${events.length}: GO ${events.filter(e => e.type === 'GO').length}, FAIL ${events.filter(e => e.type === 'FAIL').length}.`);
console.log('Return = break-direction signed move in ATR20 units after the break bar. * = day-blocked 95% CI above zero, ! = below.\n');
for (const sesName of ['RTH', 'GLOBEX', 'ALL']) {
  const E = events.filter(e => sesName === 'ALL' || e.ses === sesName), GO = E.filter(e => e.type === 'GO'), FA = E.filter(e => e.type === 'FAIL');
  console.log(`=== ${sesName} ===`); console.log('cell'.padEnd(30), '    N  days', HZ.map(h => (h + 'm').padStart(9)).join(''));
  cell('GO all', GO); cell('GO AT levels (stack>=1)', GO.filter(e => e.n >= 1)); cell('GO BARE (stack=0)', GO.filter(e => e.n === 0)); cell('GO stack>=2', GO.filter(e => e.n >= 2)); cell('GO long-term level in stack', GO.filter(e => e.nl >= 1));
  for (const o of [1, 2, 3]) cell('GO pause order ' + (o === 3 ? '3+' : o), GO.filter(e => o === 3 ? e.order >= 3 : e.order === o));
  const vz = GO.map(e => e.volz).sort((a, b) => a - b), fl = GO.map(e => e.flow).sort((a, b) => a - b), q = (a, x) => a[Math.floor(x * (a.length - 1))];
  cell('GO volume-z low third', GO.filter(e => e.volz <= q(vz, 1 / 3))); cell('GO volume-z top third', GO.filter(e => e.volz > q(vz, 2 / 3)));
  cell('GO flow-vs-leg low third', GO.filter(e => e.flow <= q(fl, 1 / 3))); cell('GO flow-vs-leg top third', GO.filter(e => e.flow > q(fl, 2 / 3)));
  cell('BASELINE any bar in a leg', baseline.filter(e => sesName === 'ALL' || e.ses === sesName));
  cell('FAIL all', FA); cell('FAIL AT levels', FA.filter(e => e.n >= 1)); cell('FAIL BARE', FA.filter(e => e.n === 0));
  // placebo: GO events classified AT under shifted levels (pooled over 4 shifts)
  const plAt = []; for (const e of GO) e.plAt.forEach(a => { if (a) plAt.push(e); }); cell('GO AT under SHIFTED levels', plAt);
  const nullM = {}; for (const h of HZ) { const v = GO.map(e => e.rr[h]).filter(x => x != null), obs = mean(v); let ge = 0; const Nn = 1000; for (let b = 0; b < Nn; b++) { let s = 0; for (const x of v) s += (rnd() < 0.5 ? 1 : -1) * x; if (s / v.length >= obs) ge++; } nullM[h] = ge / Nn; }
  console.log('sign-flip null one-sided p, GO all:', HZ.map(h => h + 'm ' + nullM[h].toFixed(3)).join('  '), '\n');
}
fs.writeFileSync('scratch/pause_and_go_claude_events_20261019.json', JSON.stringify(events)); process.exit(0);
