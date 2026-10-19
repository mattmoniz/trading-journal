// Stage A3 of the auction-state study (docs/POC_ROTATION_TPO_CONTEXT_SPEC.md v2; DeepSeek protocol step 5 "A3").
// RESEARCH ONLY. Same ONE feature as Stage A (scripts/study_auction_state_stageA.mjs), applied to the 65pt rotation
// events instead of level touches: does value FOLLOWING the join direction (acceptance) predict whether JOINING the
// rotation works?  A = L for an UP-leg join (value skewed up = following price), 1 - L for a DOWN-leg join, where
// L = (POC-VAL)/(VAH-VAL) from computeProfile(RTH bars [09:30 .. trigger bar]) -- as-of, never full-session.
// Bucketed HIGH/MID/LOW by rank against the SAME minute-of-day over the previous 20 sessions. Primary contrast
// HIGH vs LOW only. Events: the REAL detectSignalEvents(65,'standard',theta,sessions,'fixed') over 23h sessions
// (6PM-5PM, same construction as pocRotationJoinDetector.js); RTH-entry events only (Globex events are a separate
// arm not run here). Outcome is EXIT-AGNOSTIC (the old/new exit mechanisms are deliberately not involved): signed
// (join-direction) change from the open of the bar after the trigger at 10/30/60 bars. Fit window ends 2026-10-10.
import { detectSignalEvents } from '../server/services/pocRotationService.js';
import { computeProfile } from '../server/services/developingValueService.js';
import { dayBlockedBootstrapDeltaCI, mulberry32, hashSeed } from '../server/services/rigorDiagnostics.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { query } from '../server/db.js';

const FROM = '2026-04-01 18:00:00', FIT_END = '2026-10-10';
const REF_DAYS = 20, MIN_REF = 10, H = [10, 30, 60];
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');

// theta: identical definition to pocRotationJoinDetector.js getTheta() (median 1-min bar range, floor 0.25)
const theta = Math.max(0.25, +(await query(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY high - low) m FROM price_bars_primary WHERE symbol='NQ'`)).rows[0].m);
const raw = (await query(`SELECT ts::text ts, open::float open, high::float high, low::float low, close::float close, volume::float volume
  FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::timestamp AND ts < ($2::date + 1)::timestamp ORDER BY ts`, [FROM, FIT_END])).rows;
const sessions = new Map(); // session date -> bars (6PM prior day .. 5PM)
for (const b of raw) {
  const hr = +b.ts.slice(11, 13), min = +b.ts.slice(14, 16), mod = hr * 60 + min;
  if (mod >= 1020 && mod < 1080) continue; // 5-6PM maintenance gap
  const d = new Date(Date.UTC(+b.ts.slice(0, 4), +b.ts.slice(5, 7) - 1, +b.ts.slice(8, 10) + (hr >= 18 ? 1 : 0))).toISOString().slice(0, 10);
  if (!sessions.has(d)) sessions.set(d, []);
  sessions.get(d).push({ ...b, mod, date: b.ts.slice(0, 10) });
}
const dates = [...sessions.keys()].sort().filter(d => d <= FIT_END && !isInsideNqRollWeek(d) && sessions.get(d).length > 600);
console.log(`theta=${theta}; sessions usable: ${dates.length}; bars loaded: ${raw.length}`);

const rthOf = (d) => sessions.get(d).filter(b => b.mod >= 570 && b.mod < 960 && b.date === d);
const LC = new Map();
function lAtMinute(d, mod) { // L from the RTH bars [09:30 .. minute `mod`] of session d
  const k = `${d}|${mod}`; if (LC.has(k)) return LC.get(k);
  const bars = rthOf(d).filter(b => b.mod <= mod);
  const p = bars.length >= 5 ? computeProfile(bars.map(b => ({ high: b.high, low: b.low, volume: b.volume }))) : null;
  const L = !p ? null : (p.vah === p.val ? 0.5 : (p.poc - p.val) / (p.vah - p.val));
  LC.set(k, L); return L;
}
const orient = (L, dir) => (dir === 'UP' ? L : 1 - L);

const sessionList = dates.map(d => ({ t: d, bars: sessions.get(d) }));
const { all_signal } = detectSignalEvents(65, 'standard', theta, sessionList, 'fixed');
console.log(`rotation events (all sessions, incl. Globex): ${all_signal.length}`);

const rows = [];
for (const ev of all_signal) {
  if (ev.entry_idx == null) continue;
  const bars = sessions.get(ev.t); const eb = bars[ev.entry_idx], tb = bars[ev.trigger_idx];
  if (!eb || eb.mod < 570 || eb.mod >= 960 || eb.date !== ev.t) continue; // RTH entries only
  if (ev.entry_idx + 61 >= bars.length) continue;
  const L = lAtMinute(ev.t, tb.mod); if (L == null) continue;
  const A = orient(L, ev.direction);
  const di = dates.indexOf(ev.t); const ref = [];
  for (const pd of dates.slice(Math.max(0, di - REF_DAYS), di)) { const Lp = lAtMinute(pd, tb.mod); if (Lp != null) ref.push(orient(Lp, ev.direction)); }
  if (ref.length < MIN_REF) continue;
  const rank = ref.filter(x => x < A).length / ref.length;
  const bucket = rank >= 2 / 3 ? 'HIGH' : rank <= 1 / 3 ? 'LOW' : 'MID';
  const s = ev.direction === 'UP' ? 1 : -1, entry = eb.open;
  const rthOpen = rthOf(ev.t)[0]?.open ?? tb.close;
  const dayDir = Math.sign(tb.close - rthOpen);
  const out = {};
  for (const h of H) { let mfe = 0, mae = 0; for (let j = 0; j < h; j++) { const b = bars[ev.entry_idx + j]; mfe = Math.max(mfe, s * ((s > 0 ? b.high : b.low) - entry)); mae = Math.max(mae, -s * ((s > 0 ? b.low : b.high) - entry)); } out['ret' + h] = s * (bars[ev.entry_idx + h].close - entry); out['mfe' + h] = mfe; out['mae' + h] = mae; }
  rows.push({ date: ev.t, dir: ev.direction, A, bucket, withDay: dayDir === s, ...out });
}
console.log(`RTH join events used: ${rows.length} over ${new Set(rows.map(r => r.date)).size} days`);

const uncond = (l) => `n=${l.length} days=${new Set(l.map(r => r.date)).size} ret10=${f(mean(l.map(r => r.ret10)))} ret30=${f(mean(l.map(r => r.ret30)))} ret60=${f(mean(l.map(r => r.ret60)))}`;
console.log('\nUNCONDITIONAL join-direction forward change (points):');
console.log('  all           ', uncond(rows)); console.log('  UP legs       ', uncond(rows.filter(r => r.dir === 'UP'))); console.log('  DOWN legs     ', uncond(rows.filter(r => r.dir === 'DOWN')));
console.log('  join WITH day-so-far direction   ', uncond(rows.filter(r => r.withDay))); console.log('  join AGAINST day-so-far direction', uncond(rows.filter(r => !r.withDay)));
console.log('\nbucket   n   days  ret10   ret30   ret60   mfe30  mae30');
for (const b of ['LOW', 'MID', 'HIGH']) { const l = rows.filter(r => r.bucket === b); console.log(`${b.padEnd(6)}${String(l.length).padStart(5)}${String(new Set(l.map(r => r.date)).size).padStart(6)}${f(mean(l.map(r => r.ret10))).padStart(8)}${f(mean(l.map(r => r.ret30))).padStart(8)}${f(mean(l.map(r => r.ret60))).padStart(8)}${f(mean(l.map(r => r.mfe30))).padStart(8)}${f(mean(l.map(r => r.mae30))).padStart(7)}`); }

function delta(list, label, key = 'ret30') {
  const hi = list.filter(r => r.bucket === 'HIGH'), lo = list.filter(r => r.bucket === 'LOW');
  const dh = new Set(hi.map(r => r.date)).size, dl = new Set(lo.map(r => r.date)).size;
  const ev = [...hi.map(r => ({ date: r.date, pnl: r[key], group: 'HIGH' })), ...lo.map(r => ({ date: r.date, pnl: r[key], group: 'LOW' }))];
  let ci = ev.length > 4 ? dayBlockedBootstrapDeltaCI(ev, `stageA3|${label}|${key}`, { groupA: 'HIGH', groupB: 'LOW' }) : null;
  // dayBlockedBootstrapDeltaCI returns the CI of mean(groupB) - mean(groupA) = LOW - HIGH; flip it to HIGH - LOW.
  if (ci && ci.lo != null) ci = { lo: -ci.hi, hi: -ci.lo };
  const d = mean(hi.map(r => r[key])) - mean(lo.map(r => r[key]));
  const rand = mulberry32(hashSeed(`stageA3-placebo|${label}|${key}`)); const vals = ev.map(e => e.pnl); let ge = 0; const N = 2000;
  for (let k = 0; k < N; k++) { const sh = [...vals]; for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; } if (Math.abs(mean(sh.slice(0, hi.length)) - mean(sh.slice(hi.length))) >= Math.abs(d)) ge++; }
  console.log(`${label.padEnd(40)} ${key}: HIGH n=${hi.length}/${dh}d LOW n=${lo.length}/${dl}d delta=${f(d, 2)} CI=${ci ? `[${f(ci.lo, 2)}, ${f(ci.hi, 2)}]` : 'n/a'} placebo p=${f(ge / N, 3)} ${dh >= 20 && dl >= 20 ? '' : '<20 days'}`);
  return { d, ci, dh, dl };
}
console.log('\n=== PRE-REGISTERED A3: HIGH-acceptance minus LOW-acceptance, join-direction forward change (points) ===');
const a3 = delta(rows, 'A3 all RTH join events');
for (const k of ['ret10', 'ret60']) delta(rows, 'A3 all RTH join events', k);
delta(rows.filter(r => r.withDay), 'A3 control: join WITH day-so-far');
delta(rows.filter(r => !r.withDay), 'A3 control: join AGAINST day-so-far');
for (const dir of ['UP', 'DOWN']) delta(rows.filter(r => r.dir === dir), `A3 descriptive: ${dir}-leg joins only`);
console.log(`\nA3 verdict: delta=${f(a3.d, 2)} CI=${a3.ci ? `[${f(a3.ci.lo, 2)}, ${f(a3.ci.hi, 2)}]` : 'n/a'} -> ${a3.ci && (a3.ci.lo > 0 || a3.ci.hi < 0) && a3.dh >= 20 && a3.dl >= 20 ? 'CI EXCLUDES ZERO (check controls)' : 'NO USABLE SPLIT on the primary contrast'}`);
process.exit(0);
