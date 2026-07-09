/**
 * daytype_reassessment_backtest.js
 *
 * REPORT ONLY. Evidence base for whether/how to build a day-type reassessment
 * engine. Three parts:
 *
 * PART 1 — current live classifier (classifyDayType @ 10:05 ET) accuracy vs
 *          ground truth (acd_daily_log.day_type). (Re-derived here for the
 *          confusion-matrix breakdown; same methodology as
 *          scripts/backfill_accuracy_log.js.)
 *
 * PART 2 — no-lookahead replay: at each checkpoint time T, apply the SAME
 *          ground-truth formula (scripts/derive_day_types.js) to the
 *          PARTIAL session (only bars up to T, IB computed from bars up to
 *          min(T,10:30)) and compare to the FINAL ground truth. This answers
 *          "how early is the day's true character detectable using the lens
 *          we use to grade it".
 *
 * PART 3 — for sessions where the early read (checkpoint = 11:00 ET) differs
 *          from the final ground truth ("character change" sessions), test
 *          candidate reassessment triggers fired in the post-checkpoint
 *          window: (A) break-and-hold outside IB, (B) fresh range expansion
 *          beyond what was seen pre-checkpoint, (C) volatility jump
 *          (stdev of 5-min log returns, post vs pre). Reports true-positive
 *          rate (fires on real character-change sessions) vs false-positive
 *          rate (fires on no-change sessions = noise).
 *
 * Does not modify any table, does not call/import classifyDayType from
 * caseEngine.js for Part 2/3 (those use the ground-truth formula directly,
 * per the task spec). Part 1 mirrors backfill_accuracy_log.js's existing
 * results for convenience (no DB writes here).
 */

import { query } from '../server/db.js';
import { classifyOpeningType, classifyDayType } from '../server/services/caseEngine.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const RTH_START = 570;  // 9:30 ET
const IB_END    = 630;  // 10:30 ET
const CHECKPOINTS = [600, 630, 660, 690, 720, 750, 780, 840, 900, 945]; // 10:00 .. 15:45 ET
const fmtT = (m) => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;

function classifyGroundTruth({ range_ratio, close_pct, trend_str, close_outside_ib }) {
  const isOutside = close_outside_ib === true;
  if (
    (close_pct >= 0.80 || close_pct <= 0.20) &&
    trend_str >= 0.50 &&
    range_ratio >= 0.75 &&
    isOutside
  ) return 'TREND';
  if (range_ratio >= 1.25) return 'TURBULENT';
  return 'BALANCE';
}

function stdevLogReturns(closes) {
  if (closes.length < 3) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    const c0 = closes[i-1], c1 = closes[i];
    if (c0 > 0 && c1 > 0) rets.push(Math.log(c1/c0));
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s,x)=>s+x,0)/rets.length;
  const variance = rets.reduce((s,x)=>s+(x-mean)**2,0)/(rets.length-1);
  return Math.sqrt(variance);
}

function fiveMinCloses(bars) {
  // bars sorted by et_min, 1-min. Bucket into 5-min closes.
  const buckets = {};
  for (const b of bars) {
    const k = Math.floor(b.et_min/5)*5;
    buckets[k] = b.close; // last close wins (bars already sorted)
  }
  return Object.keys(buckets).sort((a,b)=>a-b).map(k => buckets[k]);
}

async function main() {
  console.log('[daytype_reassessment_backtest] Report only — no writes.\n');

  // ── Session list with avg_range_20 + IB (same construction as derive_day_types.js) ──
  const sessQ = await query(`
    WITH sessions AS (
      SELECT
        ts::date                                                              AS trade_date,
        (array_agg(open  ORDER BY ts))[1]::float                             AS sess_open,
        MAX(high)::float                                                      AS sess_high,
        MIN(low)::float                                                       AS sess_low,
        (array_agg(close ORDER BY ts DESC))[1]::float                        AS sess_close,
        COUNT(*)                                                              AS bars
      FROM price_bars
      WHERE symbol = 'NQ'
        AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN ${RTH_START} AND 959
        AND ts::date < CURRENT_DATE
      GROUP BY ts::date
      HAVING COUNT(*) >= 200
    ),
    with_avg AS (
      SELECT *,
        AVG(sess_high - sess_low) OVER (
          ORDER BY trade_date
          ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING
        ) AS avg_range_20
      FROM sessions
    )
    SELECT trade_date::text, sess_open, avg_range_20
    FROM with_avg
    WHERE avg_range_20 IS NOT NULL
    ORDER BY trade_date
  `);

  // Join with ground truth + OR data (for Part 1)
  const truthQ = await query(`
    SELECT trade_date::text, day_type, (or_high - or_low)::float as or_width,
      COALESCE((
        SELECT SUM(a2.daily_score) FROM acd_daily_log a2
        WHERE a2.trade_date >= a.trade_date - INTERVAL '30 days'
          AND a2.trade_date < a.trade_date AND a2.daily_score IS NOT NULL
      ), 0)::int AS nl30
    FROM acd_daily_log a
    WHERE day_type IS NOT NULL
  `);
  const truthByDate = {};
  for (const r of truthQ.rows) truthByDate[r.trade_date] = r;

  const sessions = sessQ.rows.filter(s => truthByDate[s.trade_date]);
  console.log(`Sessions with ground truth + avg_range_20: ${sessions.length}\n`);

  // ── Bulk-fetch all RTH bars for these dates ──────────────────────────────
  const dateList = sessions.map(s => s.trade_date);
  const barsQ = await query(`
    SELECT ts::date::text AS trade_date, open::float, high::float, low::float, close::float,
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int AS et_min
    FROM price_bars
    WHERE symbol='NQ' AND ts::date = ANY($1::date[])
      AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN ${RTH_START} AND 959
    ORDER BY ts
  `, [dateList]);
  const barsByDate = {};
  for (const b of barsQ.rows) (barsByDate[b.trade_date] ??= []).push(b);

  // ════════════════════════════════════════════════════════════════════════
  // PART 1 — current live classifier accuracy (re-derived for confusion matrix)
  // ════════════════════════════════════════════════════════════════════════
  console.log('═'.repeat(70));
  console.log('PART 1 — LIVE CLASSIFIER (classifyDayType @ 10:05 ET) vs GROUND TRUTH');
  console.log('═'.repeat(70));

  const p1results = [];
  for (const s of sessions) {
    const bars = barsByDate[s.trade_date] || [];
    const first5 = bars.filter(b => b.et_min < RTH_START + 5);
    if (first5.length < 5) continue;
    const truth = truthByDate[s.trade_date];
    if (truth.or_width == null) continue;
    const openingType = classifyOpeningType(first5);
    const result = classifyDayType({
      openingType, nl30: truth.nl30, orWidth: truth.or_width, asOfMinutes: 605,
    });
    p1results.push({ date: s.trade_date, predicted: result.classification, actual: truth.day_type });
  }

  const types = ['TREND','BALANCE','TURBULENT'];
  const p1total = p1results.length;
  const p1correct = p1results.filter(r => r.predicted === r.actual).length;
  console.log(`Scored: ${p1total}   Correct: ${p1correct}  →  ${(p1correct/p1total*100).toFixed(1)}%\n`);

  console.log('Confusion matrix (rows=predicted, cols=actual):');
  console.log('  Predicted\\Actual |  TREND | BALANCE | TURBULENT |  TOTAL');
  for (const pred of types) {
    const cells = types.map(act => p1results.filter(r => r.predicted===pred && r.actual===act).length);
    const tot = cells.reduce((a,b)=>a+b,0);
    console.log(`  ${pred.padEnd(16)} | ${String(cells[0]).padStart(6)} | ${String(cells[1]).padStart(7)} | ${String(cells[2]).padStart(9)} | ${String(tot).padStart(6)}`);
  }
  console.log('\nMost common misclassifications:');
  const misMap = {};
  for (const r of p1results) {
    if (r.predicted !== r.actual) {
      const k = `${r.actual} called ${r.predicted}`;
      misMap[k] = (misMap[k]||0)+1;
    }
  }
  Object.entries(misMap).sort((a,b)=>b[1]-a[1]).forEach(([k,n]) => {
    console.log(`  ${k}: ${n} sessions (${(n/p1total*100).toFixed(1)}% of all sessions)`);
  });

  // ════════════════════════════════════════════════════════════════════════
  // PART 2 — no-lookahead replay: when does true character become detectable
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('PART 2 — NO-LOOKAHEAD REPLAY: EARLY READ vs FINAL GROUND TRUTH');
  console.log('═'.repeat(70));

  // For each session, compute the ground-truth-formula label at each checkpoint
  const perSession = []; // { date, final, byCheckpoint: { 600: 'BALANCE', ... } }
  for (const s of sessions) {
    const bars = (barsByDate[s.trade_date] || []).slice().sort((a,b)=>a.et_min-b.et_min);
    if (!bars.length) continue;
    const truth = truthByDate[s.trade_date];
    const sessOpen = s.sess_open;
    const avgRange20 = s.avg_range_20;

    const byCheckpoint = {};
    for (const T of CHECKPOINTS) {
      const upTo = bars.filter(b => b.et_min <= T);
      if (upTo.length < 5) { byCheckpoint[T] = null; continue; }
      const partialHigh = Math.max(...upTo.map(b=>b.high));
      const partialLow  = Math.min(...upTo.map(b=>b.low));
      const partialClose = upTo[upTo.length-1].close;
      const partialRange = partialHigh - partialLow;
      if (partialRange <= 0) { byCheckpoint[T] = null; continue; }

      // IB: bars up to min(T, IB_END) -- no lookahead past T
      const ibBars = bars.filter(b => b.et_min < Math.min(T, IB_END) + (T < IB_END ? 1 : 0) && b.et_min < IB_END);
      const ibSlice = T >= IB_END ? bars.filter(b=>b.et_min < IB_END) : upTo;
      const ibHigh = ibSlice.length ? Math.max(...ibSlice.map(b=>b.high)) : partialHigh;
      const ibLow  = ibSlice.length ? Math.min(...ibSlice.map(b=>b.low))  : partialLow;

      const range_ratio = partialRange / avgRange20;
      const close_pct   = (partialClose - partialLow) / partialRange;
      const trend_str   = Math.abs(partialClose - sessOpen) / partialRange;
      const close_outside_ib = partialClose > ibHigh || partialClose < ibLow;

      byCheckpoint[T] = classifyGroundTruth({ range_ratio, close_pct, trend_str, close_outside_ib });
    }
    perSession.push({ date: s.trade_date, final: truth.day_type, byCheckpoint });
  }
  console.log(`Sessions in replay: ${perSession.length}\n`);

  console.log('Time   | n scored | match-final % | TREND match% | BALANCE match% | TURBULENT match%');
  console.log('-------+----------+----------------+---------------+-----------------+------------------');
  for (const T of CHECKPOINTS) {
    const scored = perSession.filter(s => s.byCheckpoint[T] != null);
    const matches = scored.filter(s => s.byCheckpoint[T] === s.final);
    const pct = (matches.length/scored.length*100);
    const byType = {};
    for (const t of types) {
      const finalT = scored.filter(s => s.final === t);
      const matchT = finalT.filter(s => s.byCheckpoint[T] === t);
      byType[t] = finalT.length ? (matchT.length/finalT.length*100) : null;
    }
    console.log(`${fmtT(T)}  | ${String(scored.length).padStart(8)} | ${pct.toFixed(1).padStart(13)}% | ${(byType.TREND==null?'n/a':byType.TREND.toFixed(1)+'%').padStart(12)} | ${(byType.BALANCE==null?'n/a':byType.BALANCE.toFixed(1)+'%').padStart(14)} | ${(byType.TURBULENT==null?'n/a':byType.TURBULENT.toFixed(1)+'%').padStart(15)}`);
  }

  // "First checkpoint where the read is correct AND stays correct through close"
  console.log('\nDistribution of "first checkpoint where early read == final, and stays == final at every later checkpoint":');
  const stableFrom = {};
  let neverStable = 0;
  for (const s of perSession) {
    let firstStable = null;
    for (let i = 0; i < CHECKPOINTS.length; i++) {
      const T = CHECKPOINTS[i];
      if (s.byCheckpoint[T] == null) continue;
      const restMatch = CHECKPOINTS.slice(i).every(T2 => s.byCheckpoint[T2] == null || s.byCheckpoint[T2] === s.final);
      if (s.byCheckpoint[T] === s.final && restMatch) { firstStable = T; break; }
    }
    if (firstStable == null) neverStable++;
    else stableFrom[firstStable] = (stableFrom[firstStable]||0)+1;
  }
  for (const T of CHECKPOINTS) {
    const n = stableFrom[T] || 0;
    console.log(`  Stable-correct from ${fmtT(T)}: ${n} sessions (${(n/perSession.length*100).toFixed(1)}%)`);
  }
  console.log(`  Never stable-correct (flips at least once after first match, or never matches): ${neverStable} (${(neverStable/perSession.length*100).toFixed(1)}%)`);

  // ════════════════════════════════════════════════════════════════════════
  // PART 3 — structural events that signal a real character change
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('PART 3 — STRUCTURAL TRIGGERS FOR CHARACTER CHANGE (checkpoint = 11:00 ET)');
  console.log('═'.repeat(70));

  const T0 = 660; // 11:00 ET
  const changeSessions = perSession.filter(s => s.byCheckpoint[T0] != null && s.byCheckpoint[T0] !== s.final);
  const noChangeSessions = perSession.filter(s => s.byCheckpoint[T0] != null && s.byCheckpoint[T0] === s.final);
  console.log(`At 11:00 ET: ${changeSessions.length} sessions where early read != final (CHARACTER CHANGE), ${noChangeSessions.length} where early read == final (NO CHANGE)`);
  if (changeSessions.length < 20) console.log('  [LIMITED SAMPLE n<20 for character-change group]');

  // Pre-compute per-date bars split pre/post T0, and IB (9:30-10:30)
  function computeTriggers(date) {
    const bars = (barsByDate[date] || []).slice().sort((a,b)=>a.et_min-b.et_min);
    const pre  = bars.filter(b => b.et_min <= T0);
    const post = bars.filter(b => b.et_min > T0);
    const ibSlice = bars.filter(b => b.et_min < IB_END);
    const ibHigh = ibSlice.length ? Math.max(...ibSlice.map(b=>b.high)) : null;
    const ibLow  = ibSlice.length ? Math.min(...ibSlice.map(b=>b.low))  : null;

    // A: break-and-hold outside IB after T0 (2+ consecutive closes outside),
    //    where pre-T0 did NOT already have such a hold
    const preHold = hasConsecOutside(pre, ibHigh, ibLow, 2);
    const postHold = hasConsecOutside(post, ibHigh, ibLow, 2);
    const triggerA = !preHold && postHold;

    // B: fresh range expansion after T0 beyond pre-T0 extremes, sized vs avg_range_20
    const s = sessions.find(x => x.trade_date === date);
    const avgRange20 = s ? s.avg_range_20 : null;
    const preHigh = pre.length ? Math.max(...pre.map(b=>b.high)) : null;
    const preLow  = pre.length ? Math.min(...pre.map(b=>b.low))  : null;
    const postHigh = post.length ? Math.max(...post.map(b=>b.high)) : preHigh;
    const postLow  = post.length ? Math.min(...post.map(b=>b.low))  : preLow;
    const freshExpansion = Math.max(0, postHigh - preHigh) + Math.max(0, preLow - postLow);
    const triggerB = avgRange20 ? (freshExpansion / avgRange20) >= 0.30 : false;

    // C: volatility jump — stdev of 5-min log returns, post vs pre
    const preVol  = stdevLogReturns(fiveMinCloses(pre));
    const postVol = stdevLogReturns(fiveMinCloses(post));
    const triggerC = (preVol != null && postVol != null && preVol > 0) ? (postVol / preVol) >= 1.5 : false;

    return { triggerA, triggerB, triggerC };
  }

  function hasConsecOutside(barsArr, ibHigh, ibLow, n) {
    if (ibHigh == null || ibLow == null) return false;
    let streak = 0;
    for (const b of barsArr) {
      const outside = b.close > ibHigh || b.close < ibLow;
      streak = outside ? streak + 1 : 0;
      if (streak >= n) return true;
    }
    return false;
  }

  const triggerNames = {
    triggerA: 'A: Break-and-hold outside IB (post-11:00, not already held pre-11:00)',
    triggerB: 'B: Fresh range expansion post-11:00 >= 30% of avg_range_20',
    triggerC: 'C: Volatility jump (5-min log-return stdev post/pre >= 1.5x)',
  };

  for (const key of Object.keys(triggerNames)) {
    const changeFires = changeSessions.filter(s => computeTriggers(s.date)[key]).length;
    const noChangeFires = noChangeSessions.filter(s => computeTriggers(s.date)[key]).length;
    const tpr = changeSessions.length ? (changeFires/changeSessions.length*100) : null;
    const fpr = noChangeSessions.length ? (noChangeFires/noChangeSessions.length*100) : null;
    console.log(`\n${triggerNames[key]}`);
    console.log(`  Fires on CHARACTER-CHANGE sessions: ${changeFires}/${changeSessions.length} (${tpr==null?'n/a':tpr.toFixed(1)+'%'})${changeSessions.length<20?'  [LIMITED SAMPLE n<20]':''}`);
    console.log(`  Fires on NO-CHANGE sessions (noise): ${noChangeFires}/${noChangeSessions.length} (${fpr==null?'n/a':fpr.toFixed(1)+'%'})`);
  }

  // Breakdown: among character-change sessions, what was the early->final transition?
  console.log('\nCharacter-change transitions (early@11:00 -> final):');
  const transMap = {};
  for (const s of changeSessions) {
    const k = `${s.byCheckpoint[T0]} -> ${s.final}`;
    transMap[k] = (transMap[k]||0)+1;
  }
  Object.entries(transMap).sort((a,b)=>b[1]-a[1]).forEach(([k,n]) => {
    console.log(`  ${k}: ${n} sessions`);
  });

  console.log('\n[daytype_reassessment_backtest] Done. No writes performed.\n');
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
