// Pre-registered in docs/NQ_ES_DIVERGENCE_REVERSION_PREREG_20261026.md + Amendment 1 (committed before this ran).
import fs from 'fs';
import { query } from '../server/db.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { loadBars, prep, indexBars, clock, mean, pct, SPARSE } from './lib/floorEngine.mjs';

const LS = [5, 15, 30, 60], PCS = [95, 99], HS = [1, 3, 5, 10, 15, 30, 60], COMM = 1.0, ITERS = 2000, PLAC = 10000;
const f2 = (x) => (x == null || Number.isNaN(x) ? '  n/a' : (x >= 0 ? '+' : '') + x.toFixed(2));
const sess = (c) => (c >= 570 && c < 960 ? 'RTH' : c < 570 || c >= 1080 ? 'GLOBEX' : null);

async function main() {
  const endRow = (await query(`SELECT (MAX(ts)::date - 1)::text d FROM price_bars_primary WHERE symbol='NQ' AND ts >= CURRENT_DATE - 7 AND ts < CURRENT_DATE + 1`)).rows[0].d;
  const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2023-03-06', endRow))), ES = indexBars(prep(await loadBars('price_bars_es_front', '1=1', '2023-03-06', endRow)));
  const thin = new Set((await query(`SELECT trade_date::text d FROM es_front_calendar WHERE rth_minutes IS NOT NULL AND rth_minutes < 371`)).rows.map((r) => r.d));
  const n = NQ.n, lnN = new Float64Array(n), lnE = new Float64Array(n), okA = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const j = ES.byEm.get(NQ.EM[i]); const bad = j === undefined || isInsideNqRollWeek(NQ.TD[i]) || SPARSE(NQ.TD[i]) || thin.has(NQ.TD[i]); okA[i] = bad ? 0 : 1; lnN[i] = Math.log(NQ.C[i]); lnE[i] = j === undefined ? NaN : Math.log(ES.C[j]); }
  const esAt = (i, sh) => { const j = ES.byEm.get(NQ.EM[i] + sh); return j === undefined ? NaN : Math.log(ES.C[j]); };
  console.log(`NQ/ES aligned bars ${n}, usable ${okA.reduce((a, b) => a + b, 0)}, end date ${endRow}`);
  // per trade-date index lists of bar indices
  const days = NQ.days, idxOf = new Map(days.map((d, i) => [d, i])), dayBars = days.map(() => []); for (let i = 0; i < n; i++) dayBars[idxOf.get(NQ.TD[i])].push(i);
  // per-day regression sums (1-minute log returns)
  const sxy = new Float64Array(days.length), sxx = new Float64Array(days.length);
  for (let k = 0; k < days.length; k++) for (const i of dayBars[k]) { if (i < 1 || !okA[i] || !okA[i - 1] || NQ.EM[i] - NQ.EM[i - 1] !== 1) continue; const a = lnN[i] - lnN[i - 1], b = lnE[i] - lnE[i - 1]; if (Number.isFinite(a) && Number.isFinite(b)) { sxy[k] += a * b; sxx[k] += b * b; } }
  const betaFor = (k, w) => { let a = 0, b = 0; for (let j = Math.max(0, k - w); j < k; j++) { a += sxy[j]; b += sxx[j]; } return b > 0 ? a / b : null; };
  const rng = mulberry32(hashSeed('div')), results = {};
  const lagOf = (i, L, sh) => (sh === 0 ? [lnN[i] - lnN[i - L], lnE[i] - lnE[i - L]] : [lnN[i] - lnN[i - L], esAt(i, sh) - esAt(i - L, sh)]);
  // events for (L, pc, shift, betaWindow): chronological, cooldown >= max(30, L), z from prior-20-day scale and percentile
  function events(L, pc, sh = 0, bw = 20) {
    const ev = [];
    for (let k = 21; k < days.length; k++) {
      const beta = betaFor(k, bw); if (beta == null) continue;
      const stat = { RTH: [], GLOBEX: [] };
      for (let q = k - 20; q < k; q++) for (const i of dayBars[q]) { if (i < L || !okA[i] || !okA[i - L] || NQ.EM[i] - NQ.EM[i - L] !== L) continue; const s = sess(clock(NQ.T[i])); if (!s) continue; const [a, b] = lagOf(i, L, sh); const d = a - beta * b; if (Number.isFinite(d)) stat[s].push(d); }
      const sc = {}; for (const s of ['RTH', 'GLOBEX']) { const v = stat[s]; if (v.length < 500) continue; const m = mean(v), sd = Math.sqrt(mean(v.map((x) => (x - m) ** 2))); sc[s] = { sd, cut: pct(v.map((x) => Math.abs(x) / sd), pc / 100) }; }
      let last = -1e9;
      for (const i of dayBars[k]) {
        if (i < L + 2 || i + 200 >= n || !okA[i] || !okA[i - L]) continue; const s = sess(clock(NQ.T[i])); if (!s || !sc[s]) continue; if (NQ.EM[i] - last < Math.max(30, L)) continue;
        const [a, b] = lagOf(i, L, sh); const d = a - beta * b; if (!Number.isFinite(d)) continue; const z = d / sc[s].sd; if (Math.abs(z) < sc[s].cut) continue;
        ev.push({ i, k, day: days[k], s, dir: z > 0 ? -1 : 1, beta }); last = NQ.EM[i];
      }
    }
    return ev;
  }
  function trades(ev, H, delay, slip) {
    const out = []; let freeAt = -1e9;
    for (const e of ev) {
      const i0 = e.i + 1 + delay, jx = i0 + H - 1; if (jx >= n || NQ.EM[jx] - NQ.EM[i0] !== H - 1) continue; if (NQ.EM[i0] < freeAt) continue;
      const gross = e.dir * (NQ.C[jx] - NQ.O[i0]); freeAt = NQ.EM[jx] + 1;
      const esEnd = ES.byEm.get(NQ.EM[jx]), esStart = ES.byEm.get(NQ.EM[i0]);
      const rN = NQ.C[jx] - NQ.O[i0], rE = esEnd !== undefined && esStart !== undefined ? ES.C[esEnd] - ES.O[esStart] : NaN;
      out.push({ day: e.day, s: e.s, gross, net: gross - COMM - 2 * slip, legN: -e.dir * 0 + e.dir * rN, legE: Number.isFinite(rE) ? -e.dir * e.beta * rE * (NQ.C[jx] / ES.C[esEnd]) : NaN });
    }
    return out;
  }
  // cluster-robust mean CI by trade date
  const ci = (tr) => { if (tr.length < 20) return null; const by = new Map(); for (const t of tr) { const o = by.get(t.day) || { s: 0, n: 0 }; o.s += t.net - mean(tr.map((x) => x.net)); o.n++; by.set(t.day, o); } const N = tr.length, m = mean(tr.map((t) => t.net)); let v = 0; for (const o of by.values()) v += o.s * o.s; const se = Math.sqrt(v) / N; return { m, lo: m - 1.96 * se, hi: m + 1.96 * se, days: by.size }; };
  const boot = (tr, seed) => { const by = new Map(); for (const t of tr) (by.get(t.day) || by.set(t.day, []).get(t.day)).push(t.net); const keys = [...by.keys()], r = mulberry32(hashSeed(seed)), d = []; for (let it = 0; it < ITERS; it++) { let s = 0, c = 0; for (let k = 0; k < keys.length; k++) for (const x of by.get(keys[Math.floor(r() * keys.length)])) { s += x; c++; } if (c) d.push(s / c); } d.sort((a, b) => a - b); return { lo: d[Math.floor(0.0125 * d.length)], hi: d[Math.floor(0.9875 * d.length)] }; };
  console.log('\nGRID (net points per trade at 0.25 slippage/side, cluster-robust 95 percent CI; trades/days): session L pctl | H=' + HS.join(' '));
  const grid = {};
  for (const L of LS) for (const pc of PCS) { const ev = events(L, pc); for (const s of ['RTH', 'GLOBEX']) { const row = []; for (const H of HS) { const tr = trades(ev.filter((e) => e.s === s), H, 0, 0.25), c = ci(tr); grid[`${s}|${L}|${pc}|${H}`] = c ? { ...c, n: tr.length } : null; row.push(c ? `${f2(c.m)}[${f2(c.lo)},${f2(c.hi)}]n${tr.length}` : 'n/a'); } console.log(`  ${s.padEnd(6)} L${String(L).padEnd(2)} p${pc} | ${row.join(' ')}`); } }
  // PRIMARY: L15 p95 H10
  const ev0 = events(15, 95), P = {}; 
  for (const s of ['RTH', 'GLOBEX']) {
    const evs = ev0.filter((e) => e.s === s), days = [...new Set(evs.map((e) => e.day))].sort(), cut = days[Math.floor(days.length * 0.6) - 1];
    const T = (delay, slip, extra = evs) => trades(extra, 10, delay, slip), base = T(0, 0.25), del = T(1, 0.25), half = (tr, lo) => tr.filter((t) => (lo ? t.day <= cut : t.day > cut));
    const b = boot(base, 'divbase' + s), mdeHalf = (b.hi - b.lo) / 2;
    // sign-flip placebo by trade date, gross + cost model identical
    const byDayG = new Map(); for (const t of base) { const o = byDayG.get(t.day) || { g: 0, n: 0 }; o.g += t.gross; o.n++; byDayG.set(t.day, o); } const dk = [...byDayG.keys()], N = base.length, costs = COMM + 0.5, plac = [];
    for (let it = 0; it < PLAC; it++) { let g = 0; for (const k of dk) g += (rng() < 0.5 ? 1 : -1) * byDayG.get(k).g; plac.push(g / N - costs); } plac.sort((a, c) => a - c);
    P[s] = { n: base.length, gross: mean(base.map((t) => t.gross)), net: mean(base.map((t) => t.net)), ci: b, mdeHalf, netDelayed: mean(del.map((t) => t.net)), nDel: del.length, explore: mean(half(base, true).map((t) => t.net)), hold: mean(half(base, false).map((t) => t.net)), nEx: half(base, true).length, nHo: half(base, false).length, placeboP99: plac[Math.floor(0.99 * PLAC)], slip: [0.25, 0.5, 1.0].map((sl) => mean(T(0, sl).map((t) => t.net))), legNQ: mean(base.map((t) => t.legN)), legES: mean(base.filter((t) => Number.isFinite(t.legE)).map((t) => t.legE)) };
    const lagP = (sh) => { const e2 = events(15, 95, sh).filter((e) => e.s === s); return mean(trades(e2, 10, 0, 0.25).map((t) => t.net)); }; P[s].lagPlus1 = lagP(-1); P[s].lagMinus1 = lagP(1); P[s].beta5 = mean(trades(events(15, 95, 0, 5).filter((e) => e.s === s), 10, 0, 0.25).map((t) => t.net));
    const x = P[s]; const nb = (key) => { const L = 15, H = 10; const hn = [7, 15].map((h) => grid[`${s}|${L}|95|${h}`]), ln = [5, 30].map((l) => grid[`${s}|${l}|95|${H}`]); return [hn.filter((c) => c && c.m > 0).length, ln.filter((c) => c && c.m > 0).length]; };
    x.neighbours = (() => { const hn = [5, 15].map((h) => grid[`${s}|15|95|${h}`]), ln = [5, 30].map((l) => grid[`${s}|${l}|95|10`]); return { H: hn.filter((c) => c && c.m > 0).length + '/2', L: ln.filter((c) => c && c.m > 0).length + '/2' }; })();
    console.log(`\nPRIMARY ${s} (L15 p95 H10): trades ${x.n} (explore ${x.nEx}, hold-out ${x.nHo}); gross ${f2(x.gross)} net ${f2(x.net)} points [Bonferroni CI ${f2(x.ci.lo)},${f2(x.ci.hi)}], smallest detectable about +/-${x.mdeHalf.toFixed(2)}; explore ${f2(x.explore)} hold-out ${f2(x.hold)}; delayed-fill net ${f2(x.netDelayed)} (n ${x.nDel}); net at slippage 0.25/0.5/1.0: ${x.slip.map(f2).join(' / ')}; placebo p99 net ${f2(x.placeboP99)}; ES-lag diagnostics ${f2(x.lagPlus1)} (ES stale) / ${f2(x.lagMinus1)} (ES early, diagnostic only); 5-day beta ${f2(x.beta5)}; neighbours positive H ${x.neighbours.H} L ${x.neighbours.L}; legs (NQ points): NQ ${f2(x.legNQ)} ES(beta-adjusted) ${f2(x.legES)}`);
    x.shown = x.ci.lo > 0 && x.explore > 0 && x.hold > 0 && x.net > x.placeboP99 && x.netDelayed > 0 && x.slip[1] > 0 && x.neighbours.H.startsWith('2') && x.neighbours.L.startsWith('2');
  }
  const other = (s) => (s === 'RTH' ? 'GLOBEX' : 'RTH'); for (const s of ['RTH', 'GLOBEX']) { P[s].verdict = P[s].shown && P[other(s)].ci.hi > 0 ? 'SHOWN' : 'NOT SHOWN (unresolved below the resolution bar)'; console.log(`VERDICT ${s}: ${P[s].verdict}`); }
  fs.writeFileSync('scratch/nq_es_divergence_20261026.json', JSON.stringify({ endRow, primary: P }, null, 1));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
