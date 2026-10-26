// Pre-registered in docs/ONH_HOLD_PLUS_DEFENDED_ZONE_PREREG_20261026.md (+ Amendment 1 if present) -- committed before any outcome was computed.
// Day level, causal at 15:55 ET: ONH-HELD (broke above the overnight high by 12:00 on a 5-minute close, never closed below ONH - 0.02 D20 after, closes above it), ZONE-DEFENDED (the RTH low is within a band of at least N prior approach days in the previous 90 trade days that then held),
// CONJUNCTION = both. Outcome: long from the 15:56 open to the next trade date's 15:55 close in D20 units, EXCESS over the same-weekday mean of all valid days.
import fs from 'fs';
import { query } from '../server/db.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { loadBars, prep, indexBars, clock, mean, SPARSE } from './lib/floorEngine.mjs';
import { d20Of } from './lib/fourHourLevels.mjs';
import { dc, ci, fmt, dropTopDate, diffCI } from './lib/exitSim.mjs';
import { f3 } from './lib/floorStats.mjs';

const CONFIGS = process.env.CONFIG ? [JSON.parse(process.env.CONFIG)] : [{ n: 3, band: 0.15 }, { n: 2, band: 0.15 }, { n: 2, band: 0.25 }];
async function main() {
  const endRow = (await query(`SELECT (MAX(ts)::date - 3)::text d FROM price_bars_primary WHERE symbol='NQ' AND ts >= CURRENT_DATE - 7 AND ts < CURRENT_DATE + 1`)).rows[0].d;
  const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2023-03-06', await (async () => (await query(`SELECT CURRENT_DATE::text d`)).rows[0].d)()))), d20 = d20Of(NQ);
  const day = new Map(); // trade date -> {rs, re (RTH first/last idx), lo, hi (full session), first, last}
  for (let i = 0; i < NQ.n; i++) { const td = NQ.TD[i], c = clock(NQ.T[i]), o = day.get(td) || day.set(td, { rs: -1, re: -1, lo: Infinity, hi: -Infinity, first: i, last: i }).get(td); o.last = i; o.lo = Math.min(o.lo, NQ.L[i]); o.hi = Math.max(o.hi, NQ.H[i]); if (NQ.T[i].slice(0, 10) === td && c >= 570 && c < 960) { if (o.rs < 0) o.rs = i; o.re = i; } }
  const dates = [...day.keys()].sort().filter((d) => day.get(d).rs >= 0 && day.get(d).re - day.get(d).rs >= 300), pos = new Map(dates.map((d, k) => [d, k]));
  const rows = [];
  for (let k = 20; k < dates.length - 1 + 1; k++) {
    const td = dates[k], D = day.get(td), sc = d20[td]; if (!sc || isInsideNqRollWeek(td) || SPARSE(td)) continue;
    let onh = -Infinity; for (let i = D.first; i < D.rs; i++) onh = Math.max(onh, NQ.H[i]); if (!Number.isFinite(onh)) continue;
    // RTH 5-minute closes up to the bar ending 15:55
    const five = []; for (let i = D.rs; i <= D.re; i++) { const c = clock(NQ.T[i]), j = Math.floor((c - 570) / 5); if (c >= 955) break; (five[j] ||= { start: 570 + 5 * j }).close = NQ.C[i]; }
    let tb = -1; for (let j = 1; j < five.length; j++) if (five[j] && five[j].start >= 575 && five[j].close > onh) { tb = j; break; }
    const band = 0.02 * sc; let held = tb >= 0 && five[tb].start <= 720; if (held) for (let j = tb + 1; j < five.length; j++) if (five[j] && five[j].close < onh - band) { held = false; break; } if (held && !(five[five.length - 1].close > onh)) held = false;
    let rthLow = Infinity; for (let i = D.rs; i <= D.re; i++) rthLow = Math.min(rthLow, NQ.L[i]);
    let e0 = -1; for (let i = D.re; i >= D.rs && i > D.re - 12; i--) if (clock(NQ.T[i]) === 956) e0 = i; if (e0 < 0) { for (let i = D.re; i >= D.rs; i--) { if (clock(NQ.T[i]) >= 956) e0 = i; else break; } }
    // forward exit: next trade date's 15:55 bar
    const nd = dates[k + 1], N = nd ? day.get(nd) : null; let x1 = -1; if (N && (new Date(nd) - new Date(td)) / 86400000 <= 5) for (let i = N.re; i >= N.rs; i--) if (clock(NQ.T[i]) === 955) { x1 = i; break; }
    // approach counts per config
    const cnt = {}; for (const cf of CONFIGS) { let c = 0, lastPos = -99; for (let q = Math.max(0, k - 90); q <= k - 4; q++) { const p = dates[q], P = day.get(p); if (Math.abs(P.lo - rthLow) > cf.band * sc) continue; let hi = -Infinity; for (let m = 1; m <= 3 && q + m < dates.length; m++) hi = Math.max(hi, day.get(dates[q + m]).hi); if (hi - P.lo < 0.5 * d20[p] || !d20[p]) continue; if (q - lastPos >= 2) { c++; lastPos = q; } } cnt[`${cf.n}|${cf.band}`] = c; }
    rows.push({ td, k, held, rthLow, cnt, e0, x1, sc, entry: e0 >= 0 ? NQ.O[e0] : null, r: e0 >= 0 && x1 >= 0 ? (NQ.C[x1] - NQ.O[e0]) / sc : null, mfe: e0 >= 0 && x1 >= 0 ? (Math.max(...NQ.H.slice(N.first > e0 ? e0 : e0, x1 + 1)) - NQ.O[e0]) / sc : null, wd: new Date(td + 'T12:00:00Z').getUTCDay() });
  }
  const valid = rows.filter((r) => r.r != null && r.td <= endRow); console.log(`trade days with RTH ${dates.length}; analysable days ${valid.length} (${valid[0]?.td}..${valid[valid.length - 1]?.td}); ONH-HELD days ${valid.filter((r) => r.held).length}`);
  for (const cf of CONFIGS) { const key = `${cf.n}|${cf.band}`; console.log(`  config approaches>=${cf.n} band ${cf.band} D20: ZONE-DEFENDED days ${valid.filter((r) => r.cnt[key] >= cf.n).length}, CONJUNCTION days ${valid.filter((r) => r.held && r.cnt[key] >= cf.n).length}`); }
  let cfg = CONFIGS[CONFIGS.length - 1]; for (const cf of CONFIGS) if (valid.filter((r) => r.held && r.cnt[`${cf.n}|${cf.band}`] >= cf.n).length >= 30) { cfg = cf; break; }
  const key = `${cfg.n}|${cfg.band}`; console.log(`SELECTED (from counts only, before any outcome): approaches>=${cfg.n}, band ${cfg.band} x D20`);
  if (process.env.COUNT_ONLY) return;
  const wk = {}; for (const r of valid) (wk[r.wd] ||= []).push(r.r); const wm = (wd) => mean(wk[wd]); for (const r of valid) r.x = r.r - wm(r.wd);
  const cut = valid[Math.floor(valid.length * 0.6)].td, sets = { ONH: (r) => r.held, ZONE: (r) => r.cnt[key] >= cfg.n, CONJ: (r) => r.held && r.cnt[key] >= cfg.n }, lo = 0.0083;
  console.log(`\nweekday-matched control; explore <= ${cut}; explore CI 98.33 percent (Bonferroni over 3), hold-out one-sided 95 percent`);
  let cands = 0, surv = 0; const items = (S) => S.map((r) => ({ day: r.td, v: r.x }));
  for (const [nm, f] of Object.entries(sets)) {
    const S = valid.filter(f), A = S.filter((r) => r.td <= cut), H = S.filter((r) => r.td > cut), under = (z) => z.length < 30 || new Set(z.map((r) => r.td)).size < 20; let v = 'UNDERPOWERED', ea = `n=${A.length}`, ha = `n=${H.length}`;
    const all = items(S); console.log(`\n${nm}: n ${S.length}; mean next-day return ${f3(mean(S.map((r) => r.r)))} D20; weekday control ${f3(mean(S.map((r) => wm(r.wd))))}; EXCESS ${S.length >= 5 ? fmt(mean(all.map((x) => x.v)), ci(all, 0.025, nm + 'all')) : 'n/a'}; mean max favourable move ${f3(mean(S.map((r) => r.mfe)))} D20; share up ${(100 * S.filter((r) => r.r > 0).length / Math.max(1, S.length)).toFixed(0)}%`);
    if (!under(A)) { const ia = items(A), c = ci(ia, lo, nm + 'a'); ea = `${fmt(mean(ia.map((x) => x.v)), c)} n=${A.length}, without top date ${f3(dropTopDate(ia))}`; if (!(c.lo > 0)) v = 'no'; else { cands++; if (under(H)) v = 'CANDIDATE, hold-out UNDERPOWERED'; else { const ih = items(H), ch = ci(ih, 0.05, nm + 'h'); ha = `${fmt(mean(ih.map((x) => x.v)), ch)} n=${H.length}`; const ok = mean(ih.map((x) => x.v)) > 0 && ch.lo > 0 && dropTopDate(ia) > 0; v = ok ? 'SCREEN-SURVIVOR' : 'candidate, not a survivor'; if (ok) surv++; } } }
    console.log(`  explore ${ea}\n  hold-out ${ha}\n  => ${v}${under(A) ? ' (explore half has fewer than 30 days or 20 dates)' : ''}`);
  }
  console.log(`CELLS 3, CANDIDATES ${cands}, SCREEN-SURVIVORS ${surv}, expected by chance about ${(3 * 0.0083).toFixed(2)}`);
  console.log('\nDESCRIPTIVE (not citable): does the combination add to its parts');
  const only = (a, b) => { const A = valid.filter(a).filter((r) => !b(r)), B = valid.filter(b); return [A, B]; };
  for (const [nm, a, b] of [['CONJ vs ONH-held days without the zone', sets.CONJ, sets.ONH], ['CONJ vs zone days without the hold', sets.CONJ, sets.ZONE]]) { const C = valid.filter(a), O = valid.filter((r) => b(r) && !a(r)); if (C.length >= 5 && O.length >= 5) { const d = diffCI(items(C), items(O), nm); console.log(`  ${nm}: ${C.length} vs ${O.length}, difference ${f3(mean(C.map((r) => r.x)) - mean(O.map((r) => r.x)))} [95% ${f3(d.lo)}, ${f3(d.hi)}]`); } }
  const pend = rows.filter((r) => r.r == null && r.entry != null && r.k >= dates.length - 3); for (const r of pend) console.log(`  forward / pending day ${r.td}: ONH-HELD ${r.held}, approaches counted ${r.cnt[key]} (zone-defended ${r.cnt[key] >= cfg.n}), entry ${r.entry}, low ${r.rthLow}`);
  fs.writeFileSync('scratch/onh_hold_zone_20261026.json', JSON.stringify({ cfg, cut, cands, surv, n: valid.length }));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
