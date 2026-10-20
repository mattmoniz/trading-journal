// study_level_reaction_timing_20261019.mjs -- does price actually REACT at our named levels, and does it pay to fire differently (deeper than the level) or time it differently (wait N minutes)?
// User 2026-10-19: "I also want to know if price reacts at certain levels and maybe we need to fire differently or time it differently."
// Pure bar-level market-behavior study (per CLAUDE.md: test the market question on raw bars first; no setup trade machinery, no active_setups).
// For every named level in level_prices (RTH, same-day-forming levels only after their formation gate), find touch EPISODES: first bar whose range comes within P of the level after a bar that closed
// outside the zone on one side (approach side). Re-arm after price closes > 2P away again. Entry = a limit at the level (fills when touched). REACTION = approachSign * (close[t+h] - level) / ATR20 -- positive means
// price bounced back toward where it came from (fade works), negative means it went through. Same measurement on PLACEBO levels (the real level shifted by +/-0.3 and +/-0.6 ATR) so drift/volatility
// that is not about the level cancels. P = PROX_ATR x ATR20 (sensitivity: 0.05 / 0.10); ATR20 = mean of the prior 20 sessions' RTH range (no lookahead).
// Reports per family: N, days, mean reaction at 15/60/120 min, placebo, difference + day-blocked bootstrap CI (60 min); delay curve (enter d minutes after the touch); touch number (1st vs later);
// time of day; and OVERSHOOT (how far past the level price pokes in the next 30 min) which says how much deeper a limit would need to sit.
// Run: node scripts/study_level_reaction_timing_20261019.mjs [from] [to]   (defaults 2023-03-06 .. today)
import { query } from '../server/db.js';

const FROM = process.argv[2] || '2023-03-06', TO = process.argv[3] || null;
const PROX = Number(process.env.PROX_ATR) || 0.10, SHIFTS = [-0.6, -0.3, 0.3, 0.6], HZ = [15, 60, 120], DELAYS = [0, 5, 15, 30];
const GATE = { OR5: 575, OR10: 580, OR15: 585, OR30: 600, IB: 630 };           // minute-of-day a same-day-forming level exists (end of its window)
const formGate = (n) => { for (const k of Object.keys(GATE)) if (n.startsWith(k + '_')) return GATE[k]; if (n === 'DAILY_OPEN') return 571; return 570; };
const family = (n) => /^(OR\d+|IB)_/.test(n) ? n.replace(/_.*/, '').replace(/\d+/, '') + '_today'
  : /^(CAM_)/.test(n) ? 'CAMARILLA' : /^(FLOOR_|MPP|MR\d|MS\d|WPP|WR\d|WS\d)/.test(n) ? 'PIVOTS' : /^(PD_(HIGH|LOW|CLOSE))$/.test(n) ? 'PD_HL_CLOSE' : /^PD_(VAH|VAL|POC)$/.test(n) ? 'PD_VALUEAREA'
  : /^PD_(IB|OR|SESSION)/.test(n) ? 'PD_MIDS' : /^PW_/.test(n) ? 'PRIOR_WEEK' : /^PM_/.test(n) ? 'PRIOR_MONTH' : /^(PY_|3M_|10D_|5D_)/.test(n) ? 'LONGER_TERM' : /^(ONH|ONL)$/.test(n) ? 'OVERNIGHT_HL'
  : /(OPEN|VWAP)$/.test(n) && n !== 'RTH_VWAP' ? 'OPENS_VWAPS' : null;
const sum = (a) => { let s = 0; for (const x of a) s += x; return s; }, mean = (a) => a.length ? sum(a) / a.length : NaN;
const f = (x, d = 3) => (x == null || Number.isNaN(x) ? '  n/a' : (x >= 0 ? '+' : '') + x.toFixed(d));

// ---- load RTH 1-min bars by month (chunked), per-day arrays
const days = new Map();   // date -> {o,h,l,c,min}
let cur = new Date(FROM + 'T00:00:00Z'); cur.setUTCDate(cur.getUTCDate() - 40);
const end = TO ? new Date(TO + 'T00:00:00Z') : new Date();
while (cur < end) {
  const nxt = new Date(cur); nxt.setUTCDate(nxt.getUTCDate() + 31);
  const r = (await query(`SELECT ts::date::text d, (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int m, high::float h, low::float l, close::float c FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date AND ts::time BETWEEN '09:30' AND '15:59' ORDER BY ts`, [cur.toISOString().slice(0, 10), nxt.toISOString().slice(0, 10)])).rows;
  for (const x of r) { let d = days.get(x.d); if (!d) days.set(x.d, d = { h: [], l: [], c: [], m: [] }); d.h.push(x.h); d.l.push(x.l); d.c.push(x.c); d.m.push(x.m); }
  cur = nxt;
}
const dates = [...days.keys()].filter(d => days.get(d).c.length > 300).sort();
const atrOf = new Map(); { const rng = []; for (const d of dates) { if (rng.length >= 20) atrOf.set(d, mean(rng.slice(-20))); const dd = days.get(d); rng.push(Math.max(...dd.h) - Math.min(...dd.l)); } }
const lv = (await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE trade_date >= $1::date AND price IS NOT NULL ${TO ? 'AND trade_date <= $2::date' : ''}`, TO ? [FROM, TO] : [FROM])).rows;
const byDay = new Map(); for (const r of lv) { const fam = family(r.n); if (!fam) continue; (byDay.get(r.d) || byDay.set(r.d, []).get(r.d)).push({ n: r.n, fam, p: r.p }); }

function events(dd, level, gateMin, atr) {
  const P = PROX * atr, out = []; let armed = true, k = 0;
  for (let i = 1; i < dd.c.length - 1; i++) {
    if (dd.m[i] < gateMin) continue;
    if (!armed) { if (Math.abs(dd.c[i] - level) > 2 * P) armed = true; continue; }
    const prev = dd.c[i - 1]; if (Math.abs(prev - level) <= P) continue;
    if (dd.l[i] <= level + P && dd.h[i] >= level - P) {
      const sign = prev > level ? 1 : -1; armed = false; k++;
      const m = {}; const ret = (j, from) => (j < dd.c.length ? sign * (dd.c[j] - from) / atr : null);
      for (const h of HZ) m['r' + h] = ret(i + h, level);
      for (const dl of DELAYS) { const j = i + dl; m['d' + dl] = j + 60 < dd.c.length ? sign * (dd.c[j + 60] - dd.c[j]) / atr : null; }   // 60-min move after waiting dl minutes, signed (fade direction)
      let pen = 0; for (let j = i; j <= Math.min(i + 30, dd.c.length - 1); j++) pen = Math.max(pen, sign > 0 ? level - dd.l[j] : dd.h[j] - level); m.pen = pen / atr;
      m.k = k; m.tod = dd.m[i] < 630 ? 'open(9:30-10:30)' : dd.m[i] < 780 ? 'mid(10:30-1:00)' : 'late(1:00-4:00)'; out.push(m);
    }
  }
  return out;
}
// ---- collect real + placebo events per family, tagged by day
const R = {}, Pl = {}; let skippedRoll = 0; const skippedDates = [];
for (let di = 0; di < dates.length; di++) {
  const d = dates[di];
  const atr = atrOf.get(d), lvls = byDay.get(d); if (!atr || !lvls) continue; const dd = days.get(d);
  // data-integrity gate: PD_CLOSE must equal the prior session's own last RTH close. On quarterly-roll days the derived levels can sit on the expiring contract (~275pt off the bars), which would make every
  // level look 'far' from price and every touch a placebo -- skip those days (found 2026-10-19: 2023-12-15, 2024-03-15, 2024-06-21, 2024-09-20, 2024-12-20, 2025-03-21).
  const pdc = lvls.find(x => x.n === 'PD_CLOSE'), prevD = dates[di - 1];
  if (pdc && prevD && Math.abs(pdc.p - days.get(prevD).c[days.get(prevD).c.length - 1]) > 0.1 * atr) { skippedRoll++; skippedDates.push(d); continue; }
  for (const L of lvls) {
    const g = formGate(L.n);
    const nb = lvls.filter(x => x !== L && Math.abs(x.p - L.p) < 3 * PROX * atr).length;   // other real levels within 3 proximity widths: 0 = isolated, 2+ = stacked
    for (const e of events(dd, L.p, g, atr)) (R[L.fam] ||= []).push({ d, nb, lvl: L.n, ...e });
    for (const s of SHIFTS) {
      const pp = L.p + s * atr;
      // placebo must sit in EMPTY space: the roster has ~70 levels per day, so a shifted copy often lands on another real level, which dilutes the contrast toward zero. Drop shifted points within 3P of any real level that day.
      if (process.env.EMPTY_PLACEBO === '1' && lvls.some(x => Math.abs(x.p - pp) < 3 * PROX * atr)) continue;
      for (const e of events(dd, pp, g, atr)) (Pl[L.fam] ||= []).push({ d, ...e });
    }
  }
}
function boot(real, plc, key, n = 1500) {
  const byD = {}; for (const e of real) if (e[key] != null) (byD[e.d] ||= { r: [], p: [] }).r.push(e[key]); for (const e of plc) if (e[key] != null) (byD[e.d] ||= { r: [], p: [] }).p.push(e[key]);
  const ds = Object.values(byD); let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296; const diffs = [];
  for (let b = 0; b < n; b++) { let rs = 0, rn = 0, ps = 0, pn = 0; for (let i = 0; i < ds.length; i++) { const x = ds[(rnd() * ds.length) | 0]; rs += sum(x.r); rn += x.r.length; ps += sum(x.p); pn += x.p.length; } if (rn && pn) diffs.push(rs / rn - ps / pn); }
  diffs.sort((a, b) => a - b); return [diffs[Math.floor(0.025 * diffs.length)], diffs[Math.floor(0.975 * diffs.length)]];
}
console.log(`Skipped ${skippedRoll} days where derived levels disagree with the bars (roll days): ${skippedDates.join(' ')}`);
console.log(`Study window ${dates[0]}..${dates[dates.length - 1]} (${dates.length} RTH sessions). Proximity ${PROX} x ATR20. Reaction units = ATR20 multiples; positive = bounced back (fade side), negative = went through.`);
console.log('\n=== 1. DOES PRICE REACT? (reaction after touch, real level vs shifted placebo levels; diff = real - placebo, 95% day-blocked CI) ===');
console.log('family'.padEnd(14), 'touches days |  15min real/plc | 60min real  plc   diff   [CI]            | 120min real/plc');
const verdict = [];
for (const fam of Object.keys(R).sort()) {
  const r = R[fam], p = Pl[fam] || [], mm = (a, k) => mean(a.map(e => e[k]).filter(x => x != null));
  const [lo, hi] = boot(r, p, 'r60'); const diff = mm(r, 'r60') - mm(p, 'r60');
  verdict.push([fam, diff, lo, hi, r.length]);
  console.log(fam.padEnd(14), String(r.length).padStart(7), String(new Set(r.map(e => e.d)).size).padStart(4), '|', f(mm(r, 'r15')), f(mm(p, 'r15')), '|', f(mm(r, 'r60')), f(mm(p, 'r60')), f(diff), `[${f(lo)},${f(hi)}]`, lo > 0 ? ' REACTS' : hi < 0 ? ' GOES-THROUGH' : '       ', '|', f(mm(r, 'r120')), f(mm(p, 'r120')));
}
console.log('\n=== 2. TIMING: 60-min fade-direction move if you enter D minutes AFTER the touch (real - placebo, ATR units) ===');
console.log('family'.padEnd(14), DELAYS.map(d => ('wait ' + d + 'm').padStart(14)).join(''));
for (const fam of Object.keys(R).sort()) { const r = R[fam], p = Pl[fam] || []; console.log(fam.padEnd(14), DELAYS.map(dl => { const k = 'd' + dl; const x = mean(r.map(e => e[k]).filter(v => v != null)) - mean(p.map(e => e[k]).filter(v => v != null)); const [lo, hi] = boot(r, p, k, 600); return (f(x) + (lo > 0 ? '*' : hi < 0 ? '!' : ' ')).padStart(14); }).join('')); }
console.log('  (* = CI above zero, ! = CI below zero)');
console.log('\n=== 3. WHICH TOUCH, WHAT TIME (60-min reaction real - placebo) ===');
for (const fam of Object.keys(R).sort()) {
  const r = R[fam], p = Pl[fam] || [], seg = (fn) => { const a = r.filter(fn), b = p.filter(fn); return a.length >= 20 ? `${f(mean(a.map(e => e.r60).filter(x => x != null)) - mean(b.map(e => e.r60).filter(x => x != null)), 2)}(n${a.length})` : 'thin'; };
  console.log(fam.padEnd(14), '1st touch', seg(e => e.k === 1).padEnd(14), '2nd+', seg(e => e.k > 1).padEnd(14), '| open', seg(e => e.tod[0] === 'o').padEnd(14), 'mid', seg(e => e.tod[0] === 'm').padEnd(14), 'late', seg(e => e.tod[0] === 'l'));
}
console.log('\n=== 3b. ISOLATED vs STACKED levels (60-min reaction, real minus the same-family placebo mean; stacked = 2+ other real levels within 3 widths) ===');
for (const fam of Object.keys(R).sort()) { const r = R[fam], p = Pl[fam] || [], pm = mean(p.map(e => e.r60).filter(x => x != null)); const seg = (fn) => { const a = r.filter(fn).map(e => e.r60).filter(x => x != null); return a.length >= 30 ? `${f(mean(a) - pm, 3)}(n${a.length})` : 'thin'; }; console.log(fam.padEnd(14), 'isolated', seg(e => e.nb === 0).padEnd(14), 'one neighbour', seg(e => e.nb === 1).padEnd(14), 'stacked', seg(e => e.nb >= 2)); }
console.log('\n=== 3c. INDIVIDUAL LEVELS: best / worst 60-min reaction vs same-family placebo (N>=150 touches; with ~70 levels some extremes are expected by chance) ===');
{ const rows = []; for (const fam of Object.keys(R)) { const pm = mean((Pl[fam] || []).map(e => e.r60).filter(x => x != null)); const by = {}; for (const e of R[fam]) if (e.r60 != null) (by[e.lvl] ||= []).push(e); for (const [n, a] of Object.entries(by)) if (a.length >= 150) { const [lo, hi] = boot(a, [], 'r60', 400); rows.push([n, a.length, mean(a.map(e => e.r60)) - pm, new Set(a.map(e => e.d)).size]); } } rows.sort((x, y) => y[2] - x[2]); const fmtr = (r) => `${r[0]} ${f(r[2])} (n${r[1]}, ${r[3]} days)`; console.log('best :', rows.slice(0, 8).map(fmtr).join(' | ')); console.log('worst:', rows.slice(-8).map(fmtr).join(' | ')); const sp = rows.map(r => r[2]); console.log(`spread of the ${rows.length} levels: sd ${f(Math.sqrt(mean(sp.map(x => (x - mean(sp)) ** 2))))} ATR`); }
console.log('\n=== 4. OVERSHOOT: how far past the level price pokes in the next 30 min (ATR units) -> where a deeper limit would sit ===');
for (const fam of Object.keys(R).sort()) { const pen = R[fam].map(e => e.pen).sort((a, b) => a - b); const q = (x) => pen[Math.floor(x * (pen.length - 1))]; console.log(fam.padEnd(14), `median ${f(q(0.5), 2)}  p75 ${f(q(0.75), 2)}  p90 ${f(q(0.9), 2)}  | share poking past >0.25 ATR ${(100 * pen.filter(x => x > 0.25).length / pen.length).toFixed(0)}%`); }
process.exit(0);
