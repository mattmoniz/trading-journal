/**
 * validate_daytype_v2.js
 *
 * MEASUREMENT ONLY. Implements the parked IB v2 day-type classifier candidate
 * (docs/daytype_classifier_v2_candidate.md) as a standalone, isolated function
 * — classifyDayTypeV2 — and scores it against the SAME ground truth and the
 * SAME session set used for the v1 backfill (scripts/backfill_accuracy_log.js
 * / daytype_accuracy_log), so the two are directly comparable.
 *
 * Does NOT modify, call, or import classifyDayType from caseEngine.js.
 * Does NOT write any results to the database. Report-only.
 *
 * v2 "call" scored here = the Phase 2 (IB_CONFIRMED) decision at 10:30 ET,
 * since that's the phase whose label is final for the session (Phase 1 is
 * just an early/low-confidence placeholder that Phase 2 always overrides by
 * 10:30 — there is nothing to score there that differs from v1's early read).
 *
 * Required reconstructed inputs (per the candidate doc):
 *   openingType — first 5 RTH bars (9:30–9:34), same as v1
 *   ibHigh/ibLow/ibWidth — from the COMPLETED Initial Balance: bars 9:30–10:29 ET
 *     (the first 60 one-minute bars). NOTE: "currentPrice" must be measured at
 *     a point AFTER the IB-forming window closes — using the same window's own
 *     last-bar close would be tautological (a bar's close can never exceed the
 *     high of a range that includes that very bar, so "breakout" could never
 *     fire). The doc's "Phase 2 fires at 10:30 when the IB closes" is read here
 *     as: IB = first 60 minutes (9:30–10:29), checked against price AT 10:30.
 *   currentPrice — close of the 10:30 ET bar (first bar after the IB closes)
 *   orHigh/orLow/orWidth/orMid — from acd_daily_log
 *   deltaConf — confirmedDeltaDir over the IB window (reported; does not
 *               change the v2 label, only its stated probability — see doc)
 *
 * Sessions where the first-5 bars or the 9:30–10:30 IB window can't be
 * reconstructed are SKIPPED and counted.
 */

import { query } from '../server/db.js';
import { classifyOpeningType } from '../server/services/caseEngine.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const RTH_START = 570; // 09:30 ET in minutes from midnight
const IB_END    = 630; // 10:30 ET

// ── Isolated v2 classifier (NOT wired into caseEngine.js) ──────────────────

// Same 3-bar consecutive-delta confirmation rule v1/computeCase uses, applied
// to the IB window bars. Returns null if it can't be confirmed (not scored —
// reported only, since v2's label doesn't depend on it).
function confirmedDeltaDirV2(bars, n = 3) {
  if (bars.length < n) return null;
  for (let endIdx = bars.length - 1; endIdx >= n - 1; endIdx--) {
    const slice  = bars.slice(endIdx - n + 1, endIdx + 1);
    const deltas = slice.map(b => Number(b.ask_volume || 0) - Number(b.bid_volume || 0));
    const net    = deltas.reduce((s, d) => s + d, 0);
    const barsAgo = bars.length - 1 - endIdx;
    if (deltas.every(d => d > 0)) return { direction: 'LONG',  streak: n, net, barsAgo };
    if (deltas.every(d => d < 0)) return { direction: 'SHORT', streak: n, net, barsAgo };
  }
  return null;
}

function classifyDayTypeV2({ openingType, currentPrice, ibHigh, ibLow, ibWidth, orHigh, orLow, orWidth, orMid, deltaConf }) {
  const isDrive   = openingType.startsWith('OPEN_DRIVE');
  const driveLong = openingType === 'OPEN_DRIVE_LONG';

  // Phase 2 (IB_CONFIRMED) decision tree, in priority order — verbatim from the candidate doc

  if (currentPrice > ibHigh) {
    const aligned = deltaConf?.direction === 'LONG';
    return {
      classification: 'TREND', phase: 'IB_CONFIRMED',
      probability: aligned ? 82 : 70,
      playbook: 'IB High broken. Lean long — add on holds above IB High. Trail stop after T1. 2R+ targets.',
      whatWouldChangeIt: 'Price closes back below IB High on 3-bar bearish delta',
    };
  }

  if (currentPrice < ibLow) {
    const aligned = deltaConf?.direction === 'SHORT';
    return {
      classification: 'TREND', phase: 'IB_CONFIRMED',
      probability: aligned ? 82 : 70,
      playbook: 'IB Low broken. Lean short — add on bounces below IB Low. Trail stop after T1. 2R+ targets.',
      whatWouldChangeIt: 'Price reclaims IB Low on 3-bar bullish delta',
    };
  }

  const driveReversed = isDrive && (
    (driveLong  && currentPrice < orMid) ||
    (!driveLong && currentPrice > orMid)
  );
  if (driveReversed) {
    return {
      classification: 'TURBULENT', phase: 'IB_CONFIRMED',
      probability: 65,
      playbook: 'Opening drive reversed through OR midpoint — trapped inventory. Fade session extreme. Reduce size.',
      whatWouldChangeIt: 'Price reclaims OR midpoint and closes outside IB on volume',
    };
  }

  if (ibWidth > orWidth * 2.0) {
    // price is necessarily inside the IB here — the two branches above already
    // handled price > ibHigh / price < ibLow
    return {
      classification: 'TURBULENT', phase: 'IB_CONFIRMED',
      probability: 60,
      playbook: 'IB expanded 2x+ OR without directional break — wide rotational day. Fade IB extremes. No extension plays.',
      whatWouldChangeIt: 'Price closes outside IB on above-avg volume with delta',
    };
  }

  return {
    classification: 'BALANCE', phase: 'IB_CONFIRMED',
    probability: 72,
    playbook: 'Price inside IB at 10:30 — range day. Fade IB extremes. 1–1.5R targets. Stand aside near IB midpoint.',
    whatWouldChangeIt: 'Price closes outside IB High or IB Low on above-avg volume',
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[validate_daytype_v2] Scoring IB v2 candidate against ground truth (measurement only — no writes)\n');

  // Same session set as backfill_accuracy_log.js: confirmed ground truth + OR data
  const sessQ = await query(`
    SELECT
      a.trade_date::text             AS trade_date,
      a.or_high::float               AS or_high,
      a.or_low::float                AS or_low,
      (a.or_high - a.or_low)::float  AS or_width,
      a.day_type                     AS eod_truth
    FROM acd_daily_log a
    WHERE a.trade_date < CURRENT_DATE
      AND a.day_type IS NOT NULL
      AND a.or_high IS NOT NULL AND a.or_low IS NOT NULL
    ORDER BY a.trade_date
  `);
  const sessions = sessQ.rows;
  console.log(`Found ${sessions.length} sessions with ground-truth labels (same set as v1 backfill).\n`);

  // Bulk-fetch all bars from 9:30–10:30 ET for all session dates in one query
  const barsQ = await query(`
    SELECT
      ts::date::text           AS trade_date,
      open::float              AS open,
      high::float              AS high,
      low::float               AS low,
      close::float             AS close,
      volume::float            AS volume,
      ask_volume::float        AS ask_volume,
      bid_volume::float        AS bid_volume,
      EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) AS et_min
    FROM price_bars
    WHERE symbol = 'NQ'
      AND ts::date IN (
        SELECT a.trade_date FROM acd_daily_log a
        WHERE a.trade_date < CURRENT_DATE AND a.day_type IS NOT NULL
      )
      AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN ${RTH_START} AND ${IB_END}
    ORDER BY ts
  `);

  const barsByDate = {};
  for (const bar of barsQ.rows) {
    if (!barsByDate[bar.trade_date]) barsByDate[bar.trade_date] = [];
    barsByDate[bar.trade_date].push(bar);
  }

  let scored = 0, skipped = 0;
  const skipReasons = {};
  const results = [];

  for (const sess of sessions) {
    const windowBars = barsByDate[sess.trade_date] || [];
    const first5     = windowBars.filter(b => b.et_min < RTH_START + 5);
    const ibBars     = windowBars.filter(b => b.et_min < IB_END);              // 9:30–10:29 (completed IB)
    const postIbBars = windowBars.filter(b => b.et_min >= IB_END);             // 10:30 onward

    if (first5.length < 5) {
      skipped++;
      skipReasons[sess.trade_date] = `only ${first5.length} opening bars (need 5 for openingType)`;
      continue;
    }
    if (ibBars.length < 30) { // ~60 expected; tolerate gaps but require a real IB window
      skipped++;
      skipReasons[sess.trade_date] = `only ${ibBars.length} bars in 9:30–10:29 IB window (need ≥30)`;
      continue;
    }
    if (postIbBars.length < 1) {
      skipped++;
      skipReasons[sess.trade_date] = 'no bar at/after 10:30 to read currentPrice from';
      continue;
    }
    if (sess.or_high == null || sess.or_low == null) {
      skipped++;
      skipReasons[sess.trade_date] = 'missing OR high/low in acd_daily_log';
      continue;
    }

    const openingType = classifyOpeningType(first5);
    const ibHigh  = Math.max(...ibBars.map(b => b.high));
    const ibLow   = Math.min(...ibBars.map(b => b.low));
    const ibWidth = ibHigh - ibLow;
    const currentPrice = postIbBars[0].close; // close of the 10:30 bar — first bar after IB closes
    const orHigh  = sess.or_high;
    const orLow   = sess.or_low;
    const orWidth = sess.or_width;
    const orMid   = (orHigh + orLow) / 2;
    const deltaConf = confirmedDeltaDirV2(ibBars, 3);

    const v2Result = classifyDayTypeV2({
      openingType, currentPrice, ibHigh, ibLow, ibWidth, orHigh, orLow, orWidth, orMid, deltaConf,
    });

    const predicted = v2Result.classification;
    const actual    = sess.eod_truth;
    const match     = predicted === actual;

    results.push({
      date: sess.trade_date, predicted, actual, match,
      openingType, ibHigh, ibLow, ibWidth, currentPrice, orWidth,
      deltaDir: deltaConf?.direction || null,
    });
    scored++;
  }

  // ── REPORT ─────────────────────────────────────────────────────────────

  const total   = results.length;
  const matches = results.filter(r => r.match).length;
  const acc     = total > 0 ? (matches / total * 100) : null;

  console.log('═══════════════════════════════════════════════════════');
  console.log('  IB v2 — SESSIONS SCORED VS SKIPPED');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Scored : ${scored}   Skipped : ${skipped}   (of ${sessions.length} candidate sessions)`);
  if (skipped > 0) {
    console.log('  Skip reasons:');
    for (const [d, why] of Object.entries(skipReasons)) console.log(`    ${d} — ${why}`);
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  IB v2 — OVERALL ACCURACY');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Correct calls : ${matches} / ${total}  →  ${acc.toFixed(1)}%`);

  const types = ['TREND', 'BALANCE', 'TURBULENT'];
  const v2ByType = {};
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  IB v2 — PER-TYPE PRECISION AND RECALL');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Type       | Predicted | Actual | Correct | Precision | Recall');
  console.log('  -----------+-----------+--------+---------+-----------+--------');
  for (const t of types) {
    const predictedAsT = results.filter(r => r.predicted === t);
    const actualT      = results.filter(r => r.actual === t);
    const correct      = results.filter(r => r.predicted === t && r.actual === t).length;
    const precision    = predictedAsT.length > 0 ? (correct / predictedAsT.length * 100) : null;
    const recall       = actualT.length      > 0 ? (correct / actualT.length      * 100) : null;
    v2ByType[t] = { predicted: predictedAsT.length, actual: actualT.length, correct, precision, recall };
    console.log(`  ${t.padEnd(10)} | ${String(predictedAsT.length).padStart(9)} | ${String(actualT.length).padStart(6)} | ${String(correct).padStart(7)} | ${(precision==null?'N/A':precision.toFixed(1)+'%').padStart(9)} | ${recall==null?'N/A':recall.toFixed(1)+'%'}`);
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  IB v2 — CONFUSION MATRIX  (rows = predicted, cols = actual)');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Predicted\\Actual | TREND | BALANCE | TURBULENT');
  console.log('  -----------------+-------+---------+----------');
  for (const pred of types) {
    const cells = types.map(act =>
      String(results.filter(r => r.predicted === pred && r.actual === act).length).padStart(act === 'TURBULENT' ? 8 : act === 'BALANCE' ? 7 : 5)
    );
    console.log(`  ${pred.padEnd(16)} | ${cells.join(' | ')}`);
  }

  // ── SIDE-BY-SIDE COMPARISON vs current (v1) classifier ─────────────────
  // v1 baseline figures supplied by the user, sourced from daytype_accuracy_log (353 sessions)
  const v1 = {
    overall: 53.0,
    TREND:     { precision: 26.1, recall: 8.3 },
    BALANCE:   { precision: 65.1, recall: 73.9 },
    TURBULENT: { precision: 21.8, recall: 28.8 },
  };

  const fmt = (n) => n == null ? 'N/A' : n.toFixed(1) + '%';
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  SIDE-BY-SIDE — CURRENT (v1) CLASSIFIER vs IB v2 CANDIDATE');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Sessions scored          v1: 353        v2: ${scored}`);
  console.log(`  Overall accuracy         v1: ${fmt(v1.overall)}      v2: ${fmt(acc)}`);
  console.log('  ---------------------------------------------------------------');
  console.log('  TREND precision          v1: ' + fmt(v1.TREND.precision).padEnd(8) + '  v2: ' + fmt(v2ByType.TREND.precision));
  console.log('  TREND recall   ★         v1: ' + fmt(v1.TREND.recall).padEnd(8) + '  v2: ' + fmt(v2ByType.TREND.recall) + '   ← decision metric (v1 baseline = 8.3%)');
  console.log('  ---------------------------------------------------------------');
  console.log('  BALANCE precision        v1: ' + fmt(v1.BALANCE.precision).padEnd(8) + '  v2: ' + fmt(v2ByType.BALANCE.precision));
  console.log('  BALANCE recall           v1: ' + fmt(v1.BALANCE.recall).padEnd(8) + '  v2: ' + fmt(v2ByType.BALANCE.recall));
  console.log('  ---------------------------------------------------------------');
  console.log('  TURBULENT precision      v1: ' + fmt(v1.TURBULENT.precision).padEnd(8) + '  v2: ' + fmt(v2ByType.TURBULENT.precision));
  console.log('  TURBULENT recall         v1: ' + fmt(v1.TURBULENT.recall).padEnd(8) + '  v2: ' + fmt(v2ByType.TURBULENT.recall));
  console.log('═══════════════════════════════════════════════════════');

  const trendRecallDelta = (v2ByType.TREND.recall ?? 0) - v1.TREND.recall;
  const balPrecDelta     = (v2ByType.BALANCE.precision ?? 0) - v1.BALANCE.precision;
  console.log(`\n  TREND recall change vs v1   : ${trendRecallDelta >= 0 ? '+' : ''}${trendRecallDelta.toFixed(1)} pts`);
  console.log(`  BALANCE precision change vs v1 : ${balPrecDelta >= 0 ? '+' : ''}${balPrecDelta.toFixed(1)} pts`);
  console.log('\n  Adoption gate (per docs/daytype_classifier_v2_candidate.md and user instruction):');
  console.log('  "v2 must materially improve TREND recall without wrecking BALANCE precision."');
  console.log('  This script makes NO deployment decision — numbers only, for the user to judge.');

  console.log('\n[validate_daytype_v2] Done. No live logic changed, nothing written to the database.\n');
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
