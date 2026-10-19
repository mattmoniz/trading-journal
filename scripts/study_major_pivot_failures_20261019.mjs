// study_major_pivot_failures_20261019.mjs -- DESCRIPTIVE: why do defended-level major pivot breaks fail (67% stopped out at a 1.0x structural stop)?
// How do they fail (fast reversal vs slow bleed), is the stop inside normal noise (stopped, then right anyway), and does trend context known AT ENTRY
// (prior-session direction, 5-session trend, entry extension beyond the pivot, stop width, time of day, ATR regime) separate winners from losers?
// 85 breaks / 365 days at zigzag 1.0 -> description and hypotheses only. Context features use only information available at the completed-bar entry.
// Run: node scripts/study_major_pivot_failures_20261019.mjs
import { query } from '../server/db.js';
import { computeDefendedBreaks } from '../server/services/majorPivotDefendedBreakDetector.js';

const HOLD = 2880, STOP_MULT = 1.0;
const addMin = (ts, n) => new Date(new Date(ts.replace(' ', 'T') + 'Z').getTime() + n * 60000).toISOString().slice(0, 19).replace('T', ' ');
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const f1 = (x) => x == null ? 'n/a' : x.toFixed(1), f2 = (x) => x == null ? 'n/a' : x.toFixed(2);
const rate = (arr, f) => { const n = arr.length, k = arr.filter(f).length; return `${String(k).padStart(2)}/${String(n).padEnd(2)} (${n ? String(Math.round(100 * k / n)).padStart(3) : '  0'}%)`; };

// RTH session closes/opens by date (for the "known at entry" trend context)
const sess = (await query(`SELECT d::text d, o::float o, c::float c FROM (SELECT ts::date d, (array_agg(open ORDER BY ts))[1] o, (array_agg(close ORDER BY ts DESC))[1] c, COUNT(*) n FROM price_bars_primary WHERE symbol='NQ' AND ts >= CURRENT_DATE-420 AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959 GROUP BY 1) z WHERE n > 300 ORDER BY d`)).rows;
const sIdx = new Map(sess.map((s, i) => [s.d, i]));
function priorSessions(date) {          // index of the last COMPLETED RTH session strictly before `date`
  let lo = 0, hi = sess.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sess[m].d < date) lo = m + 1; else hi = m; } return lo - 1;
}

console.log('Loading breaks (zigzag 1.0, 365 days)...');
const breaks = await computeDefendedBreaks(1.0, Number(process.env.LOOKBACK_DAYS) || 365);
const T = [];
for (const b of breaks) {
  const entryTime = b.closeTsStr, dir = b.direction === 'LONG' ? 1 : -1, atr = b.atr, structDist = Math.abs(b.entryPrice - b.stopPrice);
  const bars = (await query(`SELECT ts::text ts, high::float h, low::float l, close::float c FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1 AND ts < $2 ORDER BY ts`, [entryTime, addMin(entryTime, HOLD)])).rows;
  if (bars.length < 30) continue;
  const stop = b.entryPrice - dir * structDist * STOP_MULT;
  let stopped = null, reach1 = false, best = 0;
  for (let i = 0; i < bars.length; i++) {
    const x = bars[i]; if (stopped == null && (dir === 1 ? x.l <= stop : x.h >= stop)) { stopped = i + 1; break; }
    const fav = (dir === 1 ? x.h - b.entryPrice : b.entryPrice - x.l) / atr; best = Math.max(best, fav); if (fav >= 1) reach1 = true;
  }
  // after the stop: did price still go on to reach +1 ATR in the trade direction ("stopped, then right") or reverse a full ATR the other way?
  let thenRight = false, reversed = false;
  if (stopped != null) for (let i = stopped; i < bars.length; i++) { const x = bars[i]; if ((dir === 1 ? x.h - b.entryPrice : b.entryPrice - x.l) / atr >= 1) { thenRight = true; break; } }
  if (stopped != null) for (let i = stopped; i < bars.length; i++) { const x = bars[i]; if ((dir === 1 ? stop - x.l : x.h - stop) / atr >= 1) { reversed = true; break; } }
  const date = entryTime.slice(0, 10), pi = priorSessions(date);
  const priorMove = pi >= 0 ? (sess[pi].c - sess[pi].o) * dir / atr : null;                  // prior RTH session direction vs the trade (ATR)
  const trend5 = pi >= 5 ? (sess[pi].c - sess[pi - 5].c) * dir / atr : null;                 // 5-session trend vs the trade (ATR)
  const [, hms] = entryTime.split(' '); const mod = +hms.slice(0, 2) * 60 + +hms.slice(3, 5);
  const tod = (mod >= 1080 || mod < 510) ? 'GLOBEX' : mod < 690 ? 'RTH-AM' : mod < 840 ? 'RTH-MID' : 'RTH-PM';
  T.push({ date, entryTime, dir, atr, structDist, stopped, success: reach1 && (stopped == null || true) && best >= 1, thenRight, reversed, best,
    priorMove, trend5, ext: (b.entryPrice - b.pivotPrice) * dir / atr, stopW: structDist / atr, tod, streak: b.streak });
}
const succ = (t) => t.best >= 1 && (t.stopped == null || t.best >= 1), fails = T.filter(t => t.stopped != null && !succ(t)), wins = T.filter(succ);
console.log(`${T.length} breaks: succeeded (>=1 ATR before the 1.0x stop) ${wins.length}, stopped without ever reaching 1 ATR ${fails.length}, other ${T.length - wins.length - fails.length}\n`);

console.log('1) HOW DO THE FAILURES FAIL?');
const mins = fails.map(t => t.stopped);
console.log(`   time to the stop: within 30 min ${rate(fails, t => t.stopped <= 30)}, within 60 min ${rate(fails, t => t.stopped <= 60)}, within 3 h ${rate(fails, t => t.stopped <= 180)}, over 12 h ${rate(fails, t => t.stopped > 720)}; median ${f1(q(mins, 0.5) / 60)} h`);
console.log(`   best excursion BEFORE failing (ATR): median ${f2(q(fails.map(t => t.best), 0.5))}, p75 ${f2(q(fails.map(t => t.best), 0.75))}  (so most never even got going: ${rate(fails, t => t.best < 0.25)} never reached +0.25 ATR)`);
console.log(`   stop width = ${f2(q(T.map(t => t.stopW), 0.5))} ATR median (p25 ${f2(q(T.map(t => t.stopW), 0.25))}, p75 ${f2(q(T.map(t => t.stopW), 0.75))})`);
console.log(`   after being stopped out: price still went on to reach +1 ATR in the TRADE direction within 2 days (stopped, then right): ${rate(fails, t => t.thenRight)};  fully reversed >=1 ATR the other way: ${rate(fails, t => t.reversed)}`);

console.log('\n2) DOES TREND CONTEXT KNOWN AT ENTRY SEPARATE THEM?  (share that succeeded; small N, hypotheses only)');
const withP = T.filter(t => t.priorMove != null), with5 = T.filter(t => t.trend5 != null);
console.log(`   prior session moved WITH the trade (>+0.25 ATR): ${rate(withP.filter(t => t.priorMove > 0.25), succ)}   flat: ${rate(withP.filter(t => Math.abs(t.priorMove) <= 0.25), succ)}   AGAINST (<-0.25): ${rate(withP.filter(t => t.priorMove < -0.25), succ)}`);
console.log(`   last 5 sessions trended WITH the trade (>+0.5 ATR): ${rate(with5.filter(t => t.trend5 > 0.5), succ)}   sideways: ${rate(with5.filter(t => Math.abs(t.trend5) <= 0.5), succ)}   AGAINST (<-0.5): ${rate(with5.filter(t => t.trend5 < -0.5), succ)}`);
const es = T.map(t => t.ext), e1 = q(es, 1 / 3), e2 = q(es, 2 / 3);
console.log(`   entry extension beyond the defended pivot (ATR; terciles ${f2(e1)} / ${f2(e2)}): tight ${rate(T.filter(t => t.ext <= e1), succ)}  middle ${rate(T.filter(t => t.ext > e1 && t.ext <= e2), succ)}  extended ${rate(T.filter(t => t.ext > e2), succ)}`);
const ws = T.map(t => t.stopW), w1 = q(ws, 1 / 3), w2 = q(ws, 2 / 3);
console.log(`   stop width (structural distance / ATR; terciles ${f2(w1)} / ${f2(w2)}): narrow ${rate(T.filter(t => t.stopW <= w1), succ)}  middle ${rate(T.filter(t => t.stopW > w1 && t.stopW <= w2), succ)}  wide ${rate(T.filter(t => t.stopW > w2), succ)}`);
console.log(`   time of day: ` + ['RTH-AM', 'RTH-MID', 'RTH-PM', 'GLOBEX'].map(k => `${k} ${rate(T.filter(t => t.tod === k), succ)}`).join('   '));
const as = T.map(t => t.atr), a1 = q(as, 1 / 3), a2 = q(as, 2 / 3);
console.log(`   ATR regime (terciles ${a1.toFixed(0)} / ${a2.toFixed(0)} pts): low ${rate(T.filter(t => t.atr <= a1), succ)}  mid ${rate(T.filter(t => t.atr > a1 && t.atr <= a2), succ)}  high ${rate(T.filter(t => t.atr > a2), succ)}`);
console.log(`   direction: LONG ${rate(T.filter(t => t.dir === 1), succ)}  SHORT ${rate(T.filter(t => t.dir === -1), succ)}`);
console.log(`   with BOTH prior session and 5-session trend with the trade: ${rate(T.filter(t => t.priorMove > 0.25 && t.trend5 > 0.5), succ)};  both against: ${rate(T.filter(t => t.priorMove < -0.25 && t.trend5 < -0.5), succ)}`);
console.log('\nDone.');
process.exit(0);
