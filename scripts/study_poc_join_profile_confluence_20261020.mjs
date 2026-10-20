// study_poc_join_profile_confluence_20261020.mjs -- EXPLORATION on the FIRST HALF ONLY (trade dates < 2025-01-01); the hold-out (>= 2025-01-01) is computed and saved but NEVER printed here.
// User 2026-10-20: look at the FULL volume profile (not just the value area) of the prior 1/3/5 RTH sessions, and at where the 1-3-5 day POCs line up with the join's own 65pt-rotation POC (65pt is a near-term execution scale, the multi-day profile is the structural frame).
// Features at the join (all point-in-time: sessions strictly before the trade date; the leg profile uses bars up to the trigger bar), direction-normalized (+ = ahead of entry in the join direction), distances in ATR20:
//   pocDist_N   (entry - POC_N) signed;  volAhead_N  share of the composite volume that lies ahead of the entry;  dens_N  volume density at the entry price / mean density;  airAhead_N / airBehind_N  mean density in the 0.5 ATR ahead / behind of entry / mean density;
//   confRot_N = |rotation-leg POC - POC_N| / ATR;  confL24_N = |24h median L - POC_N| / ATR;  pocStack = number of N in {1,3,5} with confRot_N <= 0.15.
// Placebo: the SAME features from the composite profile SHIFTED by -0.6/-0.3/+0.3/+0.6 ATR (a fake location); a real location feature should show a bigger top-minus-bottom spread than its shifted copies.
// Outcome: realistic-fill live exit E1 (lib/pocJoinLoader.mjs). Run: node scripts/study_poc_join_profile_confluence_20261020.mjs
import fs from 'fs';
import { loadBars, sessionIndex, buildEvents, fwd, simE1, mean, sum, f, dayCI, lb } from './lib/pocJoinLoader.mjs';
import { computeProfile } from '../server/services/developingValueService.js';
const FROM = '2023-03-06', TO = '2026-10-16', HOLD = '2025-01-01', NS = [1, 3, 5], SHIFTS = [-0.6, -0.3, 0.3, 0.6];
const D = await loadBars(FROM, TO); const S = sessionIndex(D); const events = await buildEvents(D, FROM, TO, { R: 65, rMode: 'fixed' });
const profCache = new Map();
function prof(d, N) { const k = d + '|' + N; if (profCache.has(k)) return profCache.get(k); const j = lb(S.dates, d); const prior = S.dates.slice(Math.max(0, j - N), j); let out = null;
  if (prior.length === N) { const bars = []; for (const p of prior) { const [a, b] = S.rth.get(p); for (let i = a; i < b; i++) bars.push({ high: D.H[i], low: D.L[i], volume: D.V[i] }); } const pr = computeProfile(bars);
    if (pr) { const prices = pr.entries.map(e => e.price), vols = pr.entries.map(e => e.volume), cum = []; let c = 0; for (const v of vols) { c += v; cum.push(c); } out = { poc: pr.poc, prices, vols, cum, total: c, meanDens: c / Math.max(1, (prices[prices.length - 1] - prices[0]) / 0.25 + 1) }; } }
  profCache.set(k, out); return out; }
const upTo = (p, price) => { let lo = 0, hi = p.prices.length; while (lo < hi) { const m = (lo + hi) >> 1; if (p.prices[m] <= price) lo = m + 1; else hi = m; } return lo; };   // count of price levels <= price
const cumAt = (p, price) => { const n = upTo(p, price); return n ? p.cum[n - 1] : 0; };
function densAt(p, price) { const n = upTo(p, price); let best = 0; for (const idx of [n - 1, n]) if (idx >= 0 && idx < p.prices.length && Math.abs(p.prices[idx] - price) <= 0.125) best = p.vols[idx]; return best; }   // nearest level within 0.125 (fixed 2026-10-20: the old version only looked at the level at/below, which overstated zero density for off-grid shifted placebo prices; Gemini's independent build rounds to the nearest level)
function windowDens(p, lo, hi) { if (hi <= lo) return 0; return (cumAt(p, hi) - cumAt(p, lo)) / Math.max(1, (hi - lo) / 0.25); }
function feats(e, atr, N, shift, rotPoc) {   // shift: place the composite profile `shift` ATR higher (placebo); 0 = real
  const p = prof(e.d, N); if (!p) return null; const sg = e.long ? 1 : -1, off = shift * atr, entry = e.entry - off;      // shifting the profile up by off is equivalent to moving the entry down by off
  const pocD = sg * (entry - p.poc) / atr, ahead = e.long ? (p.total - cumAt(p, entry)) / p.total : cumAt(p, entry - 0.01) / p.total;
  const w = 0.5 * atr, a1 = e.long ? [entry, entry + w] : [entry - w, entry], b1 = e.long ? [entry - w, entry] : [entry, entry + w];
  return { ['pocDist' + N]: pocD, ['volAhead' + N]: ahead, ['dens' + N]: densAt(p, entry) / p.meanDens, ['airAhead' + N]: windowDens(p, a1[0], a1[1]) / p.meanDens, ['airBehind' + N]: windowDens(p, b1[0], b1[1]) / p.meanDens,
    ['confRot' + N]: Math.abs((rotPoc - off) - p.poc) / atr, ['confL24' + N]: Math.abs((e.L24 - off) - p.poc) / atr }; }
const rows = [];
for (let i = 0; i < events.length; i++) { const w = fwd(D, events, i); if (!w) continue; const e = events[i], atr = S.atr20(e.d); if (!atr) continue;
  const legBars = []; for (let k = e.legStart; k <= e.trig; k++) legBars.push({ high: D.H[k], low: D.L[k], volume: D.V[k] }); const lp = computeProfile(legBars); if (!lp) continue;
  const r = { d: e.d, long: e.long, pnl: simE1(D, e, w[0], w[1]).pnl, pnlFlip: simE1(D, e, w[0], w[1], { long: !e.long }).pnl, half: e.d < HOLD ? 'EXPLORE' : 'HOLDOUT', atr, real: {}, plc: SHIFTS.map(() => ({})) };
  for (const N of NS) { const fr = feats(e, atr, N, 0, lp.poc); if (!fr) continue; Object.assign(r.real, fr); SHIFTS.forEach((s, k) => Object.assign(r.plc[k], feats(e, atr, N, s, lp.poc))); }
  r.real.pocStack = NS.filter(N => r.real['confRot' + N] != null && r.real['confRot' + N] <= 0.15).length; SHIFTS.forEach((s, k) => { r.plc[k].pocStack = NS.filter(N => r.plc[k]['confRot' + N] != null && r.plc[k]['confRot' + N] <= 0.15).length; });
  rows.push(r); }
fs.writeFileSync('scratch/poc_join_profile_rows_20261020.json', JSON.stringify(rows));
const ex = rows.filter(r => r.half === 'EXPLORE'); console.log(`events with features ${rows.length}; EXPLORE half ${ex.length} (trade date < ${HOLD}); hold-out ${rows.length - ex.length} saved, NOT examined here.`);
const base = mean(ex.map(r => r.pnl)); console.log(`explore-half mean E1 ${f(base, 2)}, P(>=+100) ${(100 * ex.filter(r => r.pnl >= 100).length / ex.length).toFixed(1)}%`);
const FEATURES = []; for (const N of NS) for (const k of ['pocDist', 'volAhead', 'dens', 'airAhead', 'airBehind', 'confRot', 'confL24']) FEATURES.push(k + N); FEATURES.push('pocStack');
const q = (a, x) => { const s = [...a].sort((p, r) => p - r); return s[Math.floor(x * (s.length - 1))]; };
function spread(arr, get) { const v = arr.map(get).filter(x => x != null && Number.isFinite(x)); if (v.length < 90) return null; const t1 = q(v, 1 / 3), t2 = q(v, 2 / 3), lo = arr.filter(r => get(r) != null && get(r) <= t1), hi = arr.filter(r => get(r) != null && get(r) > t2); if (lo.length < 30 || hi.length < 30) return null;
  return { lo: mean(lo.map(r => r.pnl)), hi: mean(hi.map(r => r.pnl)), nlo: lo.length, nhi: hi.length, d: mean(hi.map(r => r.pnl)) - mean(lo.map(r => r.pnl)), bigLo: lo.filter(r => r.pnl >= 100).length / lo.length, bigHi: hi.filter(r => r.pnl >= 100).length / hi.length, t1, t2 }; }
console.log('\nfeature        low-third  high-third  hi-minus-lo | big% low/high |  PLACEBO hi-minus-lo for the 4 shifted profiles (-0.6,-0.3,+0.3,+0.6) | real beyond all placebos?');
let n = 0; const out = [];
for (const k of FEATURES) { const sr = spread(ex, r => r.real[k]); if (!sr) { console.log(k.padEnd(13), 'thin/none'); continue; } n++;
  const pl = SHIFTS.map((s, j) => { const sp = spread(ex, r => r.plc[j][k]); return sp ? sp.d : null; });
  const beyond = pl.every(x => x != null) && (sr.d > Math.max(...pl) || sr.d < Math.min(...pl)); out.push({ k, ...sr, pl, beyond });
  console.log(k.padEnd(13), f(sr.lo, 1).padStart(9), f(sr.hi, 1).padStart(11), f(sr.d, 1).padStart(11), '|', (100 * sr.bigLo).toFixed(0).padStart(4) + '%/' + (100 * sr.bigHi).toFixed(0).padStart(3) + '% |', pl.map(x => f(x, 1).padStart(7)).join(' '), '|', beyond ? 'YES' : 'no'); }
console.log(`\nfeatures examined: ${n} (x3 terciles). Any 'YES' is a lead for ONE pre-registered rule, nothing more; the hold-out has not been looked at.`); process.exit(0);
