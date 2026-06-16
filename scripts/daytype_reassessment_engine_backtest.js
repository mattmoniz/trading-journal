/**
 * daytype_reassessment_engine_backtest.js
 *
 * FINAL VERIFICATION GATE. Runs the assembled reassessment engine
 * (server/services/dayTypeReassessmentService.js) end-to-end across all
 * historical sessions in no-lookahead replay, and reports whether it beats
 * the static 52.8% baseline. REPORT ONLY — no writes, does not touch
 * detection/resolution logic.
 *
 * For each session:
 *   1. Initial read = static classifyDayType @ 10:05 ET (same as the live
 *      52.8% baseline / backfill_accuracy_log.js).
 *   2. Run runReassessment() over checkpoints 11:00 .. 15:45 ET.
 *   3. Compare finalRead to ground truth (acd_daily_log.day_type).
 *
 * Reports: overall accuracy vs baseline, TREND-called-BALANCE recovery,
 * flip-flop rate, wrong-reassessment rate, and the accuracy curve by
 * checkpoint.
 */

import { query } from '../server/db.js';
import { classifyOpeningType, classifyDayType } from '../server/services/caseEngine.js';
import { runReassessment } from '../server/services/dayTypeReassessmentService.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const RTH_START = 570;
const IB_END = 630;
const CHECKPOINTS = [660, 690, 720, 750, 780, 840, 900, 945]; // 11:00 .. 15:45 ET
const fmtT = (m) => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;

async function main() {
  console.log('[daytype_reassessment_engine_backtest] Report only — no writes.\n');

  // Sessions + avg_range_20 (same construction as derive_day_types.js)
  const sessQ = await query(`
    WITH sessions AS (
      SELECT
        ts::date                                                              AS trade_date,
        (array_agg(open  ORDER BY ts))[1]::float                             AS sess_open,
        MAX(high)::float                                                      AS sess_high,
        MIN(low)::float                                                       AS sess_low,
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

  const sessions = sessQ.rows.filter(s => truthByDate[s.trade_date] && truthByDate[s.trade_date].or_width != null);
  console.log(`Sessions with ground truth + avg_range_20 + OR data: ${sessions.length}\n`);

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

  // ── Run engine per session ────────────────────────────────────────────────
  const results = [];
  let skipped = 0;
  for (const s of sessions) {
    const bars = (barsByDate[s.trade_date] || []).slice().sort((a,b)=>a.et_min-b.et_min);
    const first5 = bars.filter(b => b.et_min < RTH_START + 5);
    const ibBars = bars.filter(b => b.et_min < IB_END);
    if (first5.length < 5 || ibBars.length < 30) { skipped++; continue; }

    const truth = truthByDate[s.trade_date];
    const openingType = classifyOpeningType(first5);
    const staticResult = classifyDayType({
      openingType, nl30: truth.nl30, orWidth: truth.or_width, asOfMinutes: 605,
    });
    const initialRead = staticResult.classification;

    const ibHigh = Math.max(...ibBars.map(b=>b.high));
    const ibLow  = Math.min(...ibBars.map(b=>b.low));

    const engineResult = runReassessment({
      initialRead, bars, sessOpen: s.sess_open, avgRange20: s.avg_range_20,
      ibHigh, ibLow, checkpoints: CHECKPOINTS,
    });

    results.push({
      date: s.trade_date,
      actual: truth.day_type,
      initialRead,
      finalRead: engineResult.finalRead,
      events: engineResult.events,
      readAtCheckpoint: engineResult.readAtCheckpoint,
    });
  }
  console.log(`Scored: ${results.length}   Skipped (insufficient bars): ${skipped}\n`);

  // ── 1. Overall accuracy: static baseline vs engine final read ──────────────
  const total = results.length;
  const staticCorrect = results.filter(r => r.initialRead === r.actual).length;
  const engineCorrect = results.filter(r => r.finalRead === r.actual).length;

  console.log('═'.repeat(70));
  console.log('1. OVERALL ACCURACY — STATIC BASELINE vs REASSESSMENT ENGINE');
  console.log('═'.repeat(70));
  console.log(`  Static (10:05 call, never updates) : ${staticCorrect}/${total} = ${(staticCorrect/total*100).toFixed(1)}%`);
  console.log(`  Engine (final read after reassess)  : ${engineCorrect}/${total} = ${(engineCorrect/total*100).toFixed(1)}%`);
  console.log(`  Delta: ${(engineCorrect/total*100 - staticCorrect/total*100).toFixed(1)} points`);

  // ── 2. TREND-called-BALANCE recovery ────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('2. TREND-CALLED-BALANCE RECOVERY (the 49-session / 13.8% blind spot)');
  console.log('═'.repeat(70));
  const trendCalledBalance = results.filter(r => r.initialRead === 'BALANCE' && r.actual === 'TREND');
  const recovered = trendCalledBalance.filter(r => r.finalRead === 'TREND');
  const stillWrong = trendCalledBalance.filter(r => r.finalRead !== 'TREND');
  console.log(`  Sessions where static called BALANCE but actual was TREND: ${trendCalledBalance.length}`);
  console.log(`  Recovered to TREND by engine: ${recovered.length} (${trendCalledBalance.length ? (recovered.length/trendCalledBalance.length*100).toFixed(1) : 'n/a'}%)`);
  console.log(`  Still wrong after engine: ${stillWrong.length}`);
  const stillWrongCounts = {};
  for (const r of stillWrong) stillWrongCounts[r.finalRead] = (stillWrongCounts[r.finalRead]||0)+1;
  for (const [k,n] of Object.entries(stillWrongCounts)) console.log(`    -> still ${k}: ${n}`);

  // Did the engine introduce any NEW errors on sessions the static classifier got RIGHT?
  console.log('\n  Side effect check — sessions static got RIGHT but engine changed to WRONG:');
  const brokenByEngine = results.filter(r => r.initialRead === r.actual && r.finalRead !== r.actual);
  console.log(`    ${brokenByEngine.length} sessions (static correct, engine final incorrect)`);
  for (const r of brokenByEngine.slice(0, 10)) {
    console.log(`    ${r.date}: ${r.initialRead} (correct) -> ${r.finalRead} (actual=${r.actual})  events=${r.events.map(e=>`${e.timeLabel}:${e.from}->${e.to}`).join(', ')}`);
  }

  // ── 3. Flip-flop rate & wrong-reassessment rate ─────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('3. FLIP-FLOP RATE & WRONG-REASSESSMENT RATE');
  console.log('═'.repeat(70));
  const withEvents = results.filter(r => r.events.length > 0);
  const multiFlip = results.filter(r => r.events.length > 1);
  console.log(`  Sessions with >=1 reassessment event: ${withEvents.length}/${total} (${(withEvents.length/total*100).toFixed(1)}%)`);
  console.log(`  Sessions with >1 reassessment event (flip-flop): ${multiFlip.length}/${total} (${(multiFlip.length/total*100).toFixed(1)}%)`);
  for (const r of multiFlip) {
    console.log(`    ${r.date}: ${r.initialRead} -> ${r.events.map(e=>`${e.to}@${e.timeLabel}`).join(' -> ')}  (actual=${r.actual}, final=${r.finalRead})`);
  }

  // "Wrong reassessment" = an event whose resulting label (e.to) != actual,
  // counted per-event (an event can later be corrected by another event).
  let totalEvents = 0, wrongEvents = 0, rightEvents = 0;
  for (const r of results) {
    for (const e of r.events) {
      totalEvents++;
      if (e.to === r.actual) rightEvents++; else wrongEvents++;
    }
  }
  console.log(`\n  Total reassessment events: ${totalEvents}`);
  console.log(`  Events landing on the CORRECT label (e.to === actual): ${rightEvents} (${totalEvents?(rightEvents/totalEvents*100).toFixed(1):'n/a'}%)`);
  console.log(`  Events landing on a WRONG label (e.to !== actual): ${wrongEvents} (${totalEvents?(wrongEvents/totalEvents*100).toFixed(1):'n/a'}%)`);

  // Of sessions where static was WRONG, how many did the engine make RIGHT vs WRONG vs leave WRONG (different wrong)?
  console.log('\n  Of sessions where STATIC was wrong:');
  const staticWrong = results.filter(r => r.initialRead !== r.actual);
  const engineFixed = staticWrong.filter(r => r.finalRead === r.actual);
  const engineStillWrong = staticWrong.filter(r => r.finalRead !== r.actual);
  console.log(`    Static wrong: ${staticWrong.length}`);
  console.log(`    Engine fixed it (now correct): ${engineFixed.length} (${(engineFixed.length/staticWrong.length*100).toFixed(1)}%)`);
  console.log(`    Engine still wrong: ${engineStillWrong.length} (${(engineStillWrong.length/staticWrong.length*100).toFixed(1)}%)`);

  // ── 4. Accuracy curve by checkpoint ─────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('4. ACCURACY CURVE — ENGINE READ AT EACH CHECKPOINT vs FINAL TRUTH');
  console.log('═'.repeat(70));
  console.log('  (static-only accuracy is flat at ' + (staticCorrect/total*100).toFixed(1) + '% for reference)\n');
  console.log('  Time   | Engine accuracy | TREND match% | BALANCE match% | TURBULENT match%');
  console.log('  -------+------------------+---------------+-----------------+------------------');
  for (const T of CHECKPOINTS) {
    const reads = results.map(r => r.readAtCheckpoint[T] ?? r.initialRead);
    const correct = reads.filter((read,i) => read === results[i].actual).length;
    const types = ['TREND','BALANCE','TURBULENT'];
    const byType = {};
    for (const t of types) {
      const actualT = results.filter(r => r.actual === t);
      const matchT = actualT.filter((r,_i) => {
        const idx = results.indexOf(r);
        return (r.readAtCheckpoint[T] ?? r.initialRead) === t;
      });
      byType[t] = actualT.length ? (matchT.length/actualT.length*100) : null;
    }
    console.log(`  ${fmtT(T)}  | ${(correct/total*100).toFixed(1).padStart(15)}% | ${(byType.TREND==null?'n/a':byType.TREND.toFixed(1)+'%').padStart(12)} | ${(byType.BALANCE==null?'n/a':byType.BALANCE.toFixed(1)+'%').padStart(14)} | ${(byType.TURBULENT==null?'n/a':byType.TURBULENT.toFixed(1)+'%').padStart(15)}`);
  }

  // ── 5. Full confusion matrix for engine final read ──────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('5. ENGINE FINAL-READ CONFUSION MATRIX (rows=engine final, cols=actual)');
  console.log('═'.repeat(70));
  const types = ['TREND','BALANCE','TURBULENT'];
  console.log('  Predicted\\Actual |  TREND | BALANCE | TURBULENT |  TOTAL');
  for (const pred of types) {
    const cells = types.map(act => results.filter(r => r.finalRead===pred && r.actual===act).length);
    const tot = cells.reduce((a,b)=>a+b,0);
    console.log(`  ${pred.padEnd(16)} | ${String(cells[0]).padStart(6)} | ${String(cells[1]).padStart(7)} | ${String(cells[2]).padStart(9)} | ${String(tot).padStart(6)}`);
  }

  // ── 6. Sample reassessment messages (for review) ────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('6. SAMPLE REASSESSMENT MESSAGES');
  console.log('═'.repeat(70));
  let shown = 0;
  for (const r of results) {
    if (!r.events.length) continue;
    for (const e of r.events) {
      console.log(`  ${r.date} [actual=${r.actual}] ${e.message}`);
      shown++;
      if (shown >= 15) break;
    }
    if (shown >= 15) break;
  }

  console.log('\n[daytype_reassessment_engine_backtest] Done. No writes performed.\n');
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
