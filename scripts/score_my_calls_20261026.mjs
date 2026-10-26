// Scores the user's logged calls (docs/MY_CALL_LOG_PREREG_20261026.md). usage: node scripts/score_my_calls_20261026.mjs <calls.json>  (array of {id, loggedAt, etDate, etTime, dir, level, mode, why, stop, target}).
// Run ONCE at the pre-registered look. Entry NOW = open of the first 1-minute bar after the call minute; LEVEL = resting limit at the level, 4 hours.
import fs from 'fs';
import { query } from '../server/db.js';
import { hashSeed, mulberry32 } from '../server/services/rigorDiagnostics.js';
import { loadBars, prep, indexBars, clock, mean, walk } from './lib/floorEngine.mjs';
import { d20Of } from './lib/fourHourLevels.mjs';
import { COST, PTV, NDRAW, ci, fmt, dc, median } from './lib/exitSim.mjs';
const rawCalls = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), INCL_RETRO = process.argv.includes('--include-retro'), calls = rawCalls.filter((c) => INCL_RETRO || !c.retro).sort((a, b) => (a.loggedAt < b.loggedAt ? -1 : 1));
const f = (x, d = 3) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(d) : 'n/a'), HZ = [15, 60, 240];
async function main() {
  const endRow = (await query(`SELECT (MAX(ts)::date)::text d FROM price_bars_primary WHERE symbol='NQ' AND ts >= CURRENT_DATE - 7 AND ts < CURRENT_DATE + 1`)).rows[0].d;
  const NQ = indexBars(prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2023-03-06', endRow))), d20 = d20Of(NQ), rng = mulberry32(hashSeed('mycalls'));
  const lowerBound = (ts) => { let lo = 0, hi = NQ.n; while (lo < hi) { const m = (lo + hi) >> 1; if (NQ.T[m] < ts) lo = m + 1; else hi = m; } return lo; };
  const samp = []; for (let i = 3100; i < NQ.n - 3000; i += 15) if (d20[NQ.TD[i]]) samp.push(i);
  const exitFree = (i0, dir, entry, h, scale) => { const j = NQ.byEm.get(NQ.EM[i0] + h - 1); return j === undefined ? null : dir * (NQ.C[j] - entry) / scale; };
  const rows = [], notFilled = [];
  for (const c of calls) {
    const dir = c.dir === 'LONG' ? 1 : -1, minute = `${c.etDate} ${c.etTime.slice(0, 5)}:00`, after = lowerBound(minute) + (NQ.T[lowerBound(minute)] === minute ? 1 : 0); let i0 = after, entry = NQ.O[i0];
    if (i0 >= NQ.n - 300) { rows.push({ c, pending: true }); continue; }
    if (c.mode === 'LEVEL') { i0 = -1; const lim = NQ.EM[after] + 240; for (let i = after; i < NQ.n && NQ.EM[i] <= lim; i++) { if (dir > 0 ? NQ.L[i] <= c.level : NQ.H[i] >= c.level) { i0 = i; entry = dir > 0 ? Math.min(NQ.O[i], c.level) : Math.max(NQ.O[i], c.level); break; } } if (i0 < 0) { notFilled.push(c); continue; } }
    const td = NQ.TD[i0], scale = d20[td]; if (!scale) continue;
    const draws = []; for (let t = 0; t < 3000 && draws.length < NDRAW; t++) { const b = samp[Math.floor(rng() * samp.length)]; if (NQ.TD[b] === td || Math.abs(clock(NQ.T[b]) - clock(NQ.T[i0])) > 30) continue; draws.push(b + 1); }
    const r = { c, td, entry, a: {}, ax: {} };
    for (const h of HZ) { const v = exitFree(i0, dir, entry, h, scale), cs = draws.map((i) => exitFree(i, dir, NQ.O[i], h, scale)).filter((x) => x != null); r.a[h] = v; r.ax[h] = v != null && cs.length >= 5 ? v - mean(cs) : null; }
    const cap = NQ.byEm.get(NQ.EM[i0] + 1439), sp = 0.5 * scale; if (cap !== undefined) { const w = walk(NQ, i0, dir, entry, sp, Infinity, cap); const cs = draws.map((i) => { const cp = NQ.byEm.get(NQ.EM[i] + 1439); return cp === undefined ? null : walk(NQ, i, dir, NQ.O[i], sp, Infinity, cp).pts - COST; }).filter((x) => x != null); r.M = w.pts - COST; r.Mx = cs.length >= 5 ? r.M - mean(cs) : null; }
    if (c.stop || c.target) { const cap2 = NQ.byEm.get(NQ.EM[i0] + 1439); if (cap2 !== undefined) { const sd = c.stop ? Math.abs(entry - c.stop) : Infinity, tg = c.target ? Math.abs(c.target - entry) : Infinity; r.own = walk(NQ, i0, dir, entry, sd, tg, cap2).pts - COST; } }
    rows.push(r);
  }
  const done = rows.filter((r) => !r.pending && r.a); console.log(`${rawCalls.length - calls.length} calls marked 'from earlier' (retrospective) excluded${INCL_RETRO ? ' -- NOT excluded, descriptive hindsight run' : ''}; calls ${calls.length}: scored ${done.length}, NOT_FILLED ${notFilled.length}, pending (too recent) ${rows.filter((r) => r.pending).length}; distinct dates ${new Set(done.map((r) => r.td)).size}`);
  const items = (k) => done.filter((r) => r.ax[k] != null).map((r) => ({ day: r.td, v: r.ax[k] }));
  for (const h of HZ) { const it = items(h); if (it.length >= 5) console.log(`${h === 60 ? 'PRIMARY ' : 'descriptive '}exit-free excess at ${h} min: n ${it.length} mean ${f(mean(it.map((x) => x.v)))} D20 ${fmt(mean(it.map((x) => x.v)), ci(it, 0.025, 'mycalls' + h)).split(' ').slice(1).join(' ')} (95% date-blocked)`); }
  const mM = done.filter((r) => r.M != null); if (mM.length >= 5) console.log(`descriptive moonshot M: n ${mM.length}, mean ${f(mean(mM.map((r) => r.M)), 1)} pts (${f(mean(mM.map((r) => r.M)) * PTV, 0)} dollars), median ${f(median(mM.map((r) => r.M)), 1)}; excess vs blind ${f(mean(mM.filter((r) => r.Mx != null).map((r) => r.Mx)), 1)}`);
  const own = done.filter((r) => r.own != null); if (own.length) console.log(`descriptive own stop/target: n ${own.length}, mean ${f(mean(own.map((r) => r.own)), 1)} pts`);
  for (const d of ['LONG', 'SHORT']) { const it = done.filter((r) => r.c.dir === d && r.ax[60] != null); if (it.length >= 5) console.log(`  ${d}: n ${it.length} excess60 ${f(mean(it.map((r) => r.ax[60])))}`); }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
