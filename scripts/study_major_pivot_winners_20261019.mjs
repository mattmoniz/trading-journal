// study_major_pivot_winners_20261019.mjs -- DESCRIPTIVE study (no trade rules are set or changed): when a MAJOR_PIVOT_DEFENDED_BREAK works, how does it move,
// how far does it go, which levels are around it, and does the level context show a propensity for success?
//
// User question 2026-10-19: "when this trade is very successful, how does it move? Is it quick, how far does it proceed? Which levels are near it and does that
// show a propensity scenario for success? Anything you notice when you do a bar by bar?"
//
// Honest limits: 85 breaks / 365 days (zigzag 1.0; 41 at the live 1.5), so everything below is DESCRIPTION and hypothesis generation, not a validated edge. Splits are
// reported with their N. "Success" is stop-aware (1.0x the pivot's structural distance), so a move that only happens after the trade is stopped out does not count.
// Levels: ONLY prior-period / pivot levels known before the session (level_prices); same-day-forming levels (IB/OR/VWAPs/daily open/overnight high-low) are excluded.
// Entry = the COMPLETED 5-minute bar close (closeTsStr, from the real computeDefendedBreaks()). No lookahead in any "context" feature (levels are as of entry);
// the post-entry path metrics (MFE, rotations, early adverse excursion) are descriptive outcomes and are labelled as such.
//
// Run: node scripts/study_major_pivot_winners_20261019.mjs
import { query } from '../server/db.js';
import { computeDefendedBreaks } from '../server/services/majorPivotDefendedBreakDetector.js';

const HOLD = 2880;                         // 2 days of 1-minute bars after entry
const STOP_MULT = 1.0;                     // x structural distance, the better-looking stop from the 2026-10-19 recalibration (descriptive only)
const ROT_ATR = 0.5;                       // a pullback of >= 0.5 ATR counts as a rotation against the move
const EXCLUDE = /^(RTH_VWAP|WEEKLY_VWAP|MONTHLY_VWAP|IB_|OR\d+_|DAILY_OPEN|ONH|ONL)/;   // formed the same session / developing -> not "known at entry"

const addMin = (ts, n) => new Date(new Date(ts.replace(' ', 'T') + 'Z').getTime() + n * 60000).toISOString().slice(0, 19).replace('T', ' ');
const minOf = (ts) => { const [h, m] = ts.split(' ')[1].split(':').map(Number); return h * 60 + m; };
const dow = (ts) => new Date(ts.slice(0, 10) + 'T12:00:00Z').getUTCDay();
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const f1 = (x) => x == null ? ' n/a' : x.toFixed(1);
const f2 = (x) => x == null ? ' n/a' : x.toFixed(2);

async function levelsFor(closeTs) {
  // level_prices.trade_date is the day a row APPLIES TO; a Globex entry at/after 18:00 belongs to the NEXT trading day's row (>= / ASC convention, CLAUDE.md).
  const mod = minOf(closeTs), day = closeTs.slice(0, 10);
  const r = mod >= 1080
    ? await query(`SELECT level_name, price::float p FROM level_prices WHERE trade_date = (SELECT MIN(trade_date) FROM level_prices WHERE trade_date > $1::date)`, [day])
    : await query(`SELECT level_name, price::float p FROM level_prices WHERE trade_date = $1::date`, [day]);
  return r.rows.filter(x => !EXCLUDE.test(x.level_name) && Number.isFinite(x.p));
}

function analysePath(t) {
  const dir = t.dir, atr = t.atr, stopDist = t.structDist * STOP_MULT;
  const stop = t.entry - dir * stopDist;
  let best = 0, tBest = 0, stopped = null, firstTouch = {}, ext = t.entry, lastRotLow = null, rotations = 0, maxRetrace = 0, earlyMae = 0, mae30 = 0, maxRetraceBeforePeak = 0;
  let reach1BeforeStop = false, reach2BeforeStop = false, state = 'UP', rotRefExt = t.entry;
  for (let i = 0; i < t.bars.length; i++) {
    const b = t.bars[i], mins = i + 1;
    const fav = dir === 1 ? b.h - t.entry : t.entry - b.l, adv = dir === 1 ? t.entry - b.l : b.h - t.entry;
    if (stopped == null && (dir === 1 ? b.l <= stop : b.h >= stop)) stopped = mins;
    if (stopped == null) {
      if (fav / atr >= 1 && !reach1BeforeStop) reach1BeforeStop = true;
      if (fav / atr >= 2 && !reach2BeforeStop) reach2BeforeStop = true;
    }
    for (const k of [0.5, 1, 2]) if (firstTouch[k] == null && fav / atr >= k && stopped == null) firstTouch[k] = mins;
    if (mins <= 60) earlyMae = Math.max(earlyMae, adv / atr);
    if (mins <= 30) mae30 = Math.max(mae30, adv / atr);
    if (fav > best) { best = fav; tBest = mins; }
    // rotations against the move, measured on the way to the peak (zigzag of 0.5 ATR on 1-minute highs/lows)
    const favPx = dir === 1 ? b.h : b.l, advPx = dir === 1 ? b.l : b.h;
    if (state === 'UP') {
      if ((favPx - rotRefExt) * dir > 0) rotRefExt = favPx;
      const pull = (rotRefExt - advPx) * dir / atr;
      if (pull >= ROT_ATR) { rotations++; state = 'PULL'; lastRotLow = advPx; if (mins <= tBest + 1) maxRetraceBeforePeak = Math.max(maxRetraceBeforePeak, pull); }
      else if (mins <= tBest + 1) maxRetraceBeforePeak = Math.max(maxRetraceBeforePeak, pull);
    } else {
      if ((advPx - lastRotLow) * dir < 0) lastRotLow = advPx;                       // keep extending the pullback
      if ((favPx - lastRotLow) * dir / atr >= ROT_ATR) { state = 'UP'; rotRefExt = favPx; }
    }
  }
  // Second pass, ONLY the bars up to the peak: deepest give-back from the running best (ATR) and the number of pullbacks >= ROT_ATR from the running best.
  let runBest = 0, ddPeak = 0, rotUp = 0, inPull = false, bestAtPull = 0;
  for (let i = 0; i < Math.min(tBest, t.bars.length); i++) {
    const b = t.bars[i];
    const fav = (dir === 1 ? b.h - t.entry : t.entry - b.l) / atr, adv = (dir === 1 ? t.entry - b.l : b.h - t.entry) / atr;
    if (fav > runBest) { runBest = fav; if (inPull) inPull = false; }
    const give = runBest + adv;                               // distance from the running best down to this bar's worst price, in ATR
    ddPeak = Math.max(ddPeak, give);
    if (!inPull && give >= ROT_ATR && runBest > 0) { rotUp++; inPull = true; }
  }
  return { mfe: best / atr, mfePts: best, tBest, stoppedAt: stopped, t05: firstTouch[0.5] ?? null, t1: firstTouch[1] ?? null, t2: firstTouch[2] ?? null,
    earlyMae60: earlyMae, mae30, rotations: rotUp, maxRetraceBeforePeak: ddPeak, reach1BeforeStop, reach2BeforeStop };
}

function levelContext(t, levels) {
  const ahead = levels.map(l => ({ ...l, d: (l.p - t.entry) * t.dir / t.atr })).filter(l => l.d > 0.02).sort((a, b) => a.d - b.d);
  const behind = levels.map(l => ({ ...l, d: (t.entry - l.p) * t.dir / t.atr })).filter(l => l.d > 0.02).sort((a, b) => a.d - b.d);
  const near = levels.map(l => Math.abs(l.p - t.pivotPrice) / t.atr).sort((a, b) => a - b)[0];
  // did price actually reach each level ahead (before the stop), and when?
  const reached = ahead.slice(0, 6).map(l => {
    let hit = null;
    for (let i = 0; i < t.bars.length; i++) { const b = t.bars[i]; if (t.stopMin != null && i + 1 >= t.stopMin) break; if (t.dir === 1 ? b.h >= l.p : b.l <= l.p) { hit = i + 1; break; } }
    return { name: l.level_name, d: l.d, hitMin: hit };
  });
  return { runway1: ahead[0]?.d ?? null, runway1Name: ahead[0]?.level_name ?? null, runway2: ahead[1]?.d ?? null, levelsWithin2ATR: ahead.filter(l => l.d <= 2).length,
    behind1: behind[0]?.d ?? null, behind1Name: behind[0]?.level_name ?? null, pivotToLevelATR: near, reached };
}

console.log('Loading the real defended breaks (zigzag 1.0, 365 days)...');
const breaks = await computeDefendedBreaks(1.0, Number(process.env.LOOKBACK_DAYS) || 365);
const trades = [];
for (const b of breaks) {
  const entryTime = b.closeTsStr;
  const bars = (await query(`SELECT ts::text ts, high::float h, low::float l, close::float c FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1 AND ts < $2 ORDER BY ts`, [entryTime, addMin(entryTime, HOLD)])).rows;
  if (bars.length < 30) continue;
  const t = { id: b.entryTsStr, date: entryTime.slice(0, 10), entryTime, entry: b.entryPrice, atr: b.atr, dir: b.direction === 'LONG' ? 1 : -1, structDist: Math.abs(b.entryPrice - b.stopPrice),
    pivotPrice: b.pivotPrice, streak: b.streak, bars, session: (() => { const m = minOf(b.entryTsStr); return m >= 1080 || m < 510 ? 'GLOBEX' : 'RTH'; })() };
  Object.assign(t, analysePath(t));
  t.stopMin = t.stoppedAt;
  Object.assign(t, levelContext(t, await levelsFor(entryTime)));
  const clock = (m) => m == null ? null : addMin(entryTime, m).slice(5, 16);
  t.clock1 = clock(t.t1); t.clock2 = clock(t.t2);
  t.outcome = t.reach2BeforeStop ? 'BIG (>=2 ATR before stop)' : t.reach1BeforeStop ? 'WIN (1-2 ATR before stop)' : t.stoppedAt != null ? 'STOPPED (never reached 1 ATR)' : 'NEITHER (drifted)';
  trades.push(t);
}
console.log(`${trades.length} breaks with 2 days of bars. Stop used for "success": ${STOP_MULT}x the pivot's structural distance.\n`);

// ---- A) outcome mix
const mix = {}; for (const t of trades) mix[t.outcome] = (mix[t.outcome] || 0) + 1;
console.log('A) OUTCOME MIX (stop-aware):'); for (const [k, v] of Object.entries(mix)) console.log(`   ${k.padEnd(34)} ${String(v).padStart(3)}  (${(100 * v / trades.length).toFixed(0)}%)`);
const stoppedMins = trades.filter(t => t.stoppedAt != null).map(t => t.stoppedAt / 60);
console.log(`   stopped trades stop out after (hours): median ${f1(q(stoppedMins, 0.5))}, p25 ${f1(q(stoppedMins, 0.25))}, p75 ${f1(q(stoppedMins, 0.75))}  (n=${stoppedMins.length})`);

// ---- B) the successful ones: how fast, how far
const winners = trades.filter(t => t.reach1BeforeStop);
const big = trades.filter(t => t.reach2BeforeStop);
const speed = (arr, k) => arr.map(t => t[k]).filter(x => x != null);
console.log(`\nB) HOW THE SUCCESSFUL ONES MOVE  (reached >=1 ATR before the stop: ${winners.length}; >=2 ATR: ${big.length})`);
for (const [label, arr] of [['reached 1 ATR', winners], ['reached 2 ATR', big]]) {
  console.log(`   ${label}: peak excursion (ATR) median ${f2(q(arr.map(t => t.mfe), 0.5))}, max ${f2(Math.max(...arr.map(t => t.mfe)))}; peak in points median ${f1(q(arr.map(t => t.mfePts), 0.5))}`);
  console.log(`      minutes to first +0.5 ATR: median ${f1(q(speed(arr, 't05'), 0.5))} | to +1 ATR: median ${f1(q(speed(arr, 't1'), 0.5))} | to +2 ATR: median ${f1(q(speed(arr, 't2'), 0.5))} | time to the peak (hours): median ${f1(q(arr.map(t => t.tBest / 60), 0.5))}, p75 ${f1(q(arr.map(t => t.tBest / 60), 0.75))}`);
  console.log(`      rotations against the move (>=0.5 ATR pullbacks) on the way: median ${f1(q(arr.map(t => t.rotations), 0.5))}, max ${Math.max(...arr.map(t => t.rotations))}; deepest pullback before the peak (ATR): median ${f2(q(arr.map(t => t.maxRetraceBeforePeak), 0.5))}`);
}

// ---- C) every BIG winner, one line each
console.log('\nC) EVERY BIG WINNER (reached >=2 ATR before the stop):');
console.log('   when (entry close)    dir   sess   entry   ATR  peakATR  peakPts  toPeak(h)  min->1ATR  early60mAdv  rot  runway1(ATR,level)             levels<=2ATR');
for (const t of [...big].sort((a, b) => b.mfe - a.mfe)) {
  console.log(`   ${t.entryTime.slice(0, 16)}   ${t.dir === 1 ? 'LONG ' : 'SHORT'} ${t.session.padEnd(6)} ${t.entry.toFixed(0)}  ${t.atr.toFixed(0).padStart(3)}  ${f2(t.mfe).padStart(6)}  ${t.mfePts.toFixed(0).padStart(6)}  ${f1(t.tBest / 60).padStart(8)}  ${String(t.t1 ?? '-').padStart(8)}  ${f2(t.earlyMae60).padStart(10)}  ${String(t.rotations).padStart(3)}  ${(f2(t.runway1) + ' ' + (t.runway1Name || '')).padEnd(30)} ${t.levelsWithin2ATR}`);
}

// ---- C2) WHEN does the big move happen on the clock? (entry -> first +1 ATR and first +2 ATR, as calendar clock times)
console.log('\nC2) WHEN ON THE CLOCK do the big winners make their move?  (entry close -> first +1 ATR touch -> first +2 ATR touch; ET)');
for (const t of [...big].sort((a, b) => a.entryTime.localeCompare(b.entryTime))) console.log(`   entry ${t.entryTime.slice(5, 16)} ${t.session.padEnd(6)}   +1 ATR at ${t.clock1 ?? '-'}   +2 ATR at ${t.clock2 ?? '-'}   (${f1((t.t1 ?? 0) / 60)}h / ${f1((t.t2 ?? 0) / 60)}h after entry)`);
const hrs = (arr) => arr.map(t => t.t2 / 60).filter(x => x > 0);
console.log(`   share of the big winners whose +2 ATR touch came MORE than 12h after entry (i.e. after a 720-minute hold would already have ended): ${big.filter(t => t.t2 > 720).length}/${big.length}   more than 24h: ${big.filter(t => t.t2 > 1440).length}/${big.length}`);
console.log(`   share that reached +1 ATR only after 12h: ${winners.filter(t => t.t1 > 720).length}/${winners.length}; after 24h: ${winners.filter(t => t.t1 > 1440).length}/${winners.length}`);

// ---- D) does the context separate success from failure? (descriptive; N is small)
const rate = (arr, f) => { const n = arr.length, k = arr.filter(f).length; return `${k}/${n} (${n ? (100 * k / n).toFixed(0) : 0}%)`; };
const succ = (t) => t.reach1BeforeStop;
console.log('\nD) PROPENSITY -- share of breaks that reached >=1 ATR before the stop, by context known AT ENTRY (small N; hypothesis only):');
console.log(`   all breaks: ${rate(trades, succ)}   RTH ${rate(trades.filter(t => t.session === 'RTH'), succ)}   Globex ${rate(trades.filter(t => t.session === 'GLOBEX'), succ)}   LONG ${rate(trades.filter(t => t.dir === 1), succ)}   SHORT ${rate(trades.filter(t => t.dir === -1), succ)}`);
const withRun = trades.filter(t => t.runway1 != null);
const rs = withRun.map(t => t.runway1).sort((a, b) => a - b), r1 = q(rs, 1 / 3), r2 = q(rs, 2 / 3);
console.log(`   distance to the NEXT known level in the trade direction (runway, ATR): terciles split at ${f2(r1)} / ${f2(r2)}`);
console.log(`      short runway (<=${f2(r1)}): ${rate(withRun.filter(t => t.runway1 <= r1), succ)}   middle: ${rate(withRun.filter(t => t.runway1 > r1 && t.runway1 <= r2), succ)}   long runway (>${f2(r2)}): ${rate(withRun.filter(t => t.runway1 > r2), succ)}`);
const lv = trades.map(t => t.levelsWithin2ATR);
console.log(`   number of known levels inside the first 2 ATR ahead: few (<=${q(lv, 0.5)}) ${rate(trades.filter(t => t.levelsWithin2ATR <= q(lv, 0.5)), succ)}   many (>${q(lv, 0.5)}) ${rate(trades.filter(t => t.levelsWithin2ATR > q(lv, 0.5)), succ)}`);
const bh = trades.filter(t => t.behind1 != null);
console.log(`   a known level just BEHIND entry (<=0.5 ATR, i.e. the break has support under it): yes ${rate(bh.filter(t => t.behind1 <= 0.5), succ)}   no ${rate(trades.filter(t => t.behind1 == null || t.behind1 > 0.5), succ)}`);
console.log(`   the defended pivot sat on a known level (pivot within 0.25 ATR of one): yes ${rate(trades.filter(t => t.pivotToLevelATR <= 0.25), succ)}   no ${rate(trades.filter(t => t.pivotToLevelATR > 0.25), succ)}`);
console.log(`   defended-streak (prior denials of the zone): 1 ${rate(trades.filter(t => t.streak === 1), succ)}   2 ${rate(trades.filter(t => t.streak === 2), succ)}   3+ ${rate(trades.filter(t => t.streak >= 3), succ)}`);
console.log(`   day of week: ` + [1, 2, 3, 4, 5, 0].map(d => `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'][d === 0 ? 0 : d]} ${rate(trades.filter(t => dow(t.entryTime) === d), succ)}`).join('  '));
console.log(`   early path (post-entry, DESCRIPTIVE only -- not usable as an entry filter): adverse excursion in the first 30 min >0.5 ATR: ${rate(trades.filter(t => t.mae30 > 0.5), succ)}   <=0.5 ATR: ${rate(trades.filter(t => t.mae30 <= 0.5), succ)}`);

// ---- E) do the levels actually act as waypoints? how often does price reach the next known levels (before the stop)?
console.log('\nE) DO THE LEVELS ACT AS WAYPOINTS?  of all breaks, the share where price reached the 1st / 2nd / 3rd known level ahead before the stop, and typical time to get there:');
for (let i = 0; i < 4; i++) {
  const arr = trades.filter(t => t.reached[i]); const hit = arr.filter(t => t.reached[i].hitMin != null);
  console.log(`   level #${i + 1} ahead: reached ${hit.length}/${arr.length} (${arr.length ? (100 * hit.length / arr.length).toFixed(0) : 0}%)   median distance ${f2(q(arr.map(t => t.reached[i].d), 0.5))} ATR   median minutes to reach ${f1(q(hit.map(t => t.reached[i].hitMin), 0.5))}`);
}

// ---- E2) the same waypoint/runway question using only MAJOR levels (the full list is so dense that every break is "near a level")
const MAJOR = /^(PD_HIGH|PD_LOW|PW_HIGH|PW_LOW|PM_HIGH|PM_LOW|PW_VAH|PW_VAL|PW_POC|PM_VAH|PM_VAL|PM_POC|PY_VAH|PY_VAL|PY_POC|3M_VAH|3M_VAL|3M_POC|WEEKLY_OPEN|MONTHLY_OPEN|PD_VAH|PD_VAL|PD_POC)$/;
console.log('\nE2) MAJOR LEVELS ONLY (prior day/week/month/3-month/year highs, lows, value areas, POCs, weekly/monthly open):');
let nM = 0; const rows = [];
for (const t of trades) {
  const lv = (await levelsFor(t.entryTime)).filter(l => MAJOR.test(l.level_name));
  const ahead = lv.map(l => ({ ...l, d: (l.p - t.entry) * t.dir / t.atr })).filter(l => l.d > 0.02).sort((a, b) => a.d - b.d);
  const first = ahead[0]; if (!first) continue; nM++;
  let hit = null; for (let i = 0; i < t.bars.length; i++) { const b = t.bars[i]; if (t.stoppedAt != null && i + 1 >= t.stoppedAt) break; if (t.dir === 1 ? b.h >= first.p : b.l <= first.p) { hit = i + 1; break; } }
  rows.push({ d: first.d, name: first.level_name, hit, succ: t.reach1BeforeStop });
}
const ds = rows.map(r => r.d).sort((a, b) => a - b), m1 = q(ds, 1 / 3), m2 = q(ds, 2 / 3);
console.log(`   next MAJOR level ahead: median distance ${f2(q(ds, 0.5))} ATR (p25 ${f2(q(ds, 0.25))}, p75 ${f2(q(ds, 0.75))}); reached before the stop: ${rows.filter(r => r.hit != null).length}/${rows.length}; median minutes to reach ${f1(q(rows.filter(r => r.hit != null).map(r => r.hit), 0.5))}`);
console.log(`   success (>=1 ATR before the stop) by distance to the next major level: near (<=${f2(m1)}): ${rate(rows.filter(r => r.d <= m1), r => r.succ)}   middle: ${rate(rows.filter(r => r.d > m1 && r.d <= m2), r => r.succ)}   far (>${f2(m2)}): ${rate(rows.filter(r => r.d > m2), r => r.succ)}`);

// ---- F) bar by bar for the best four
console.log('\nF) BAR BY BAR -- the 4 largest successful moves (15-minute steps, price vs entry in ATR; ^ = new best, v = pullback >= 0.5 ATR from best):');
for (const t of [...big].sort((a, b) => b.mfe - a.mfe).slice(0, 4)) {
  console.log(`\n   ${t.entryTime.slice(0, 16)} ${t.dir === 1 ? 'LONG' : 'SHORT'} ${t.session}  entry ${t.entry}  ATR ${t.atr.toFixed(0)}  peak ${f2(t.mfe)} ATR after ${f1(t.tBest / 60)}h   levels ahead: ${t.reached.slice(0, 4).map(r => `${r.name}@${f2(r.d)}ATR${r.hitMin != null ? '(hit ' + r.hitMin + 'm)' : ''}`).join(', ')}`);
  let line = '   ', bestSeen = 0;
  for (let i = 14; i < Math.min(t.bars.length, t.tBest + 90); i += 15) {
    const b = t.bars[i]; const rel = (b.c - t.entry) * t.dir / t.atr; const mark = rel > bestSeen + 0.02 ? '^' : (bestSeen - rel >= 0.5 ? 'v' : ' ');
    bestSeen = Math.max(bestSeen, rel); line += `${String(Math.round((i + 1) / 60 * 10) / 10).padStart(4)}h ${rel >= 0 ? '+' : ''}${rel.toFixed(2)}${mark} `;
    if (line.length > 150) { console.log(line); line = '   '; }
  }
  if (line.trim()) console.log(line);
}
console.log('\nDone.');
process.exit(0);
