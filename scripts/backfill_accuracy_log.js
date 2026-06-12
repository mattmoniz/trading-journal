/**
 * backfill_accuracy_log.js
 *
 * Reconstructs what classifyDayType would have predicted at 10:05 ET for every
 * completed historical session, compares to the confirmed ground-truth label in
 * acd_daily_log.day_type, and writes results to daytype_accuracy_log.
 *
 * Idempotent — safe to re-run. Only UPSERTs; never deletes rows.
 * Skips sessions where first-5 bars are missing (can't reconstruct openingType).
 *
 * Inputs faithfully reconstructed from stored data:
 *   openingType — from first 5 RTH bars in price_bars (9:30–9:34 ET)
 *   nl30        — SUM(daily_score) from acd_daily_log for prior 30 calendar days
 *   orWidth     — acd_daily_log.or_high - acd_daily_log.or_low
 *   asOfMinutes — fixed at 605 (10:05 ET, after OR completes)
 */

import { query } from '../server/db.js';
import { classifyOpeningType, classifyDayType } from '../server/services/caseEngine.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

async function main() {
  console.log('[backfill_accuracy_log] Reconstructing classifyDayType predictions for all completed sessions...\n');

  // All sessions with confirmed ground truth and OR data
  const sessQ = await query(`
    SELECT
      a.trade_date::text                                  AS trade_date,
      (a.or_high - a.or_low)::float                      AS or_width,
      a.day_type                                          AS eod_truth,
      COALESCE((
        SELECT SUM(a2.daily_score)
        FROM acd_daily_log a2
        WHERE a2.trade_date >= a.trade_date - INTERVAL '30 days'
          AND a2.trade_date < a.trade_date
          AND a2.daily_score IS NOT NULL
      ), 0)::int                                          AS nl30
    FROM acd_daily_log a
    WHERE a.trade_date < CURRENT_DATE
      AND a.day_type IS NOT NULL
      AND a.or_high IS NOT NULL AND a.or_low IS NOT NULL
    ORDER BY a.trade_date
  `);

  const sessions = sessQ.rows;
  console.log(`Found ${sessions.length} sessions with ground-truth labels.\n`);

  // First 5 RTH bars for all session dates in one query
  const barsQ = await query(`
    SELECT
      ts::date::text           AS trade_date,
      open::float              AS open,
      high::float              AS high,
      low::float               AS low,
      close::float             AS close,
      EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) AS et_min
    FROM price_bars
    WHERE symbol = 'NQ'
      AND ts::date IN (
        SELECT a.trade_date FROM acd_daily_log a
        WHERE a.trade_date < CURRENT_DATE AND a.day_type IS NOT NULL
      )
      AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 574
    ORDER BY ts
  `);

  // Group bars by date
  const barsByDate = {};
  for (const bar of barsQ.rows) {
    if (!barsByDate[bar.trade_date]) barsByDate[bar.trade_date] = [];
    barsByDate[bar.trade_date].push(bar);
  }

  // Process each session
  let scored = 0, skipped = 0;
  const results = [];

  for (const sess of sessions) {
    const bars = barsByDate[sess.trade_date] || [];

    if (bars.length < 5) {
      skipped++;
      console.log(`  SKIP ${sess.trade_date} — only ${bars.length} opening bars (need 5)`);
      continue;
    }

    const openingType   = classifyOpeningType(bars.slice(0, 5));
    const dayTypeResult = classifyDayType({
      openingType,
      nl30:        sess.nl30,
      orWidth:     sess.or_width,
      asOfMinutes: 605, // 10:05 ET — after OR completes, before IB closes
    });

    const predicted = dayTypeResult.classification;
    const actual    = sess.eod_truth;
    const match     = predicted === actual;

    results.push({ date: sess.trade_date, predicted, actual, match, nl30: sess.nl30, orWidth: sess.or_width, openingType });

    await query(`
      INSERT INTO daytype_accuracy_log
        (trade_date, intraday_call, eod_truth, matched, or_width, nl30)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (trade_date) DO UPDATE SET
        intraday_call = $2,
        eod_truth     = $3,
        matched       = $4,
        or_width      = $5,
        nl30          = $6,
        logged_at     = NOW()
    `, [sess.trade_date, predicted, actual, match, Math.round(sess.or_width), sess.nl30]);

    scored++;
  }

  // ── ACCURACY REPORT ───────────────────────────────────────────────────────

  const total   = results.length;
  const matches = results.filter(r => r.match).length;
  const acc     = total > 0 ? (matches / total * 100).toFixed(1) : 'N/A';

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  OVERALL ACCURACY');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Scored sessions : ${scored}  |  Skipped : ${skipped}`);
  console.log(`  Correct calls   : ${matches} / ${total}  →  ${acc}%`);

  // Per-type precision and recall
  const types = ['TREND', 'BALANCE', 'TURBULENT'];
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  PER-TYPE PRECISION AND RECALL');
  console.log('  (precision = correct / all predicted as type)');
  console.log('  (recall    = correct / all actual days of type)');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Type       | Predicted | Actual | Correct | Precision | Recall');
  console.log('  -----------+-----------+--------+---------+-----------+--------');
  for (const t of types) {
    const predictedAsT = results.filter(r => r.predicted === t);
    const actualT      = results.filter(r => r.actual === t);
    const correct      = results.filter(r => r.predicted === t && r.actual === t).length;
    const precision    = predictedAsT.length > 0 ? (correct / predictedAsT.length * 100).toFixed(1) + '%' : 'N/A';
    const recall       = actualT.length      > 0 ? (correct / actualT.length      * 100).toFixed(1) + '%' : 'N/A';
    console.log(`  ${t.padEnd(10)} | ${String(predictedAsT.length).padStart(9)} | ${String(actualT.length).padStart(6)} | ${String(correct).padStart(7)} | ${precision.padStart(9)} | ${recall}`);
  }

  // Confusion matrix
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  CONFUSION MATRIX  (rows = predicted, cols = actual)');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Predicted\\Actual | TREND | BALANCE | TURBULENT');
  console.log('  -----------------+-------+---------+----------');
  for (const pred of types) {
    const cells = types.map(act =>
      String(results.filter(r => r.predicted === pred && r.actual === act).length).padStart(act === 'TURBULENT' ? 8 : act === 'BALANCE' ? 7 : 5)
    );
    console.log(`  ${pred.padEnd(16)} | ${cells.join(' | ')}`);
  }

  // TREND detail: what was predicted when it was actually a TREND day?
  const actualTrend = results.filter(r => r.actual === 'TREND');
  const trendMissed = actualTrend.filter(r => r.predicted !== 'TREND');
  if (trendMissed.length > 0) {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log(`  ACTUAL TREND DAYS MISSED (n=${trendMissed.length}) — predicted as:`);
    console.log('═══════════════════════════════════════════════════════');
    const counts = {};
    for (const r of trendMissed) counts[r.predicted] = (counts[r.predicted] || 0) + 1;
    for (const [pred, n] of Object.entries(counts)) {
      console.log(`  → ${pred}: ${n} sessions (${(n / actualTrend.length * 100).toFixed(1)}% of all actual TREND days)`);
    }
    // Show a few examples
    console.log('\n  Sample missed TREND days (predicted, openingType, nl30, orWidth):');
    for (const r of trendMissed.slice(0, 8)) {
      console.log(`    ${r.date}  predicted=${r.predicted}  opening=${r.openingType}  nl30=${r.nl30}  orW=${Math.round(r.orWidth)}`);
    }
  }

  // False TREND calls: predicted TREND, actual was something else
  const trendFP = results.filter(r => r.predicted === 'TREND' && r.actual !== 'TREND');
  if (trendFP.length > 0) {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log(`  FALSE TREND CALLS (n=${trendFP.length}) — predicted TREND, actual was:`);
    console.log('═══════════════════════════════════════════════════════');
    const counts = {};
    for (const r of trendFP) counts[r.actual] = (counts[r.actual] || 0) + 1;
    for (const [act, n] of Object.entries(counts)) {
      console.log(`  → ${act}: ${n} sessions`);
    }
    console.log('\n  Sample false TREND calls (actual, openingType, nl30, orWidth):');
    for (const r of trendFP.slice(0, 8)) {
      console.log(`    ${r.date}  actual=${r.actual}  opening=${r.openingType}  nl30=${r.nl30}  orW=${Math.round(r.orWidth)}`);
    }
  }

  console.log('\n[backfill_accuracy_log] Done.\n');
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
