import { query } from '../server/db.js';
import { classifyOpeningType, classifyDayType, getDayTypeAccuracyStats } from '../server/services/caseEngine.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const RTH_START = 570; // 09:30 ET
const IB_END    = 630; // 10:30 ET

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

  if (currentPrice > ibHigh) {
    const aligned = deltaConf?.direction === 'LONG';
    return { classification: 'TREND', phase: 'IB_CONFIRMED' };
  }
  if (currentPrice < ibLow) {
    const aligned = deltaConf?.direction === 'SHORT';
    return { classification: 'TREND', phase: 'IB_CONFIRMED' };
  }

  const driveReversed = isDrive && (
    (driveLong  && currentPrice < orMid) ||
    (!driveLong && currentPrice > orMid)
  );
  if (driveReversed) {
    return { classification: 'TURBULENT', phase: 'IB_CONFIRMED' };
  }

  if (ibWidth > orWidth * 2.0) {
    return { classification: 'TURBULENT', phase: 'IB_CONFIRMED' };
  }

  return { classification: 'BALANCE', phase: 'IB_CONFIRMED' };
}

async function main() {
  const sessQ = await query(`
    SELECT
      a.trade_date::text             AS trade_date,
      a.or_high::float               AS or_high,
      a.or_low::float                AS or_low,
      (a.or_high - a.or_low)::float  AS or_width,
      a.day_type                     AS eod_truth,
      dal.nl30::float                AS nl30
    FROM acd_daily_log a
    LEFT JOIN daytype_accuracy_log dal ON dal.trade_date = a.trade_date
    WHERE a.trade_date < CURRENT_DATE
      AND a.day_type IS NOT NULL
      AND a.or_high IS NOT NULL AND a.or_low IS NOT NULL
    ORDER BY a.trade_date
  `);
  const sessions = sessQ.rows;

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

  let scored = 0;
  const results = [];
  // Use a dummy stats to prevent network requests inside classifyDayType
  const accuracyStats = { overall: { pct: 50 } }; 

  for (const sess of sessions) {
    const windowBars = barsByDate[sess.trade_date] || [];
    const first5     = windowBars.filter(b => b.et_min < RTH_START + 5);
    const ibBars     = windowBars.filter(b => b.et_min < IB_END);
    const postIbBars = windowBars.filter(b => b.et_min >= IB_END);

    if (first5.length < 5 || ibBars.length < 30 || postIbBars.length < 1 || sess.or_high == null || sess.or_low == null) {
      continue;
    }

    const openingType = classifyOpeningType(first5);
    const ibHigh  = Math.max(...ibBars.map(b => b.high));
    const ibLow   = Math.min(...ibBars.map(b => b.low));
    const ibWidth = ibHigh - ibLow;
    const currentPrice = postIbBars[0].close; 
    const orHigh  = sess.or_high;
    const orLow   = sess.or_low;
    const orWidth = sess.or_width;
    const orMid   = (orHigh + orLow) / 2;
    const deltaConf = confirmedDeltaDirV2(ibBars, 3);
    const nl30 = sess.nl30 || 0;

    // V1 @ 9:35 timing (actually classifyDayType expects asOfMinutes. 5 bars is 9:35, asOf=600 for OR width complete? V1 commits at 9:35 but needs OR width?)
    // Let's use 10:00 (600) for standard V1 so orWidth is available.
    const v1_standard = classifyDayType({
      openingType, nl30, orWidth, asOfMinutes: 600, accuracyStats
    }).classification;

    // V2 candidate
    const v2_cand = classifyDayTypeV2({
      openingType, currentPrice, ibHigh, ibLow, ibWidth, orHigh, orLow, orWidth, orMid, deltaConf,
    }).classification;

    // V1 @ 10:30 (re-run v1 at IB close)
    // To re-run v1 logic using v2 timing (at 10:30), we give it the ibWidth as the "OR width" if we consider 10:30 the new OR? Or just 10:30 timing?
    // V1 logic uses openingType (5-bar), nl30, orWidth (which freezes at 10:00). So running v1 at 10:30 doesn't actually change anything because v1's inputs are fully determined by 10:00!
    // Wait, the prompt says: "accuracy IF v1 were re-run at IB-close time using v1's own logic but v2's timing".
    // If v1's logic relies on "wideOR = orWidth > 80". If we run it at 10:30, maybe we pass IB width instead of OR width?
    // Let's test two things: v1 with just asOf=630 (no change), and v1 where `orWidth` is replaced by `ibWidth`.
    const v1_at_1030_strict = classifyDayType({
      openingType, nl30, orWidth, asOfMinutes: 630, accuracyStats
    }).classification;

    const v1_at_1030_ibwidth = classifyDayType({
      openingType, nl30, orWidth: ibWidth, asOfMinutes: 630, accuracyStats
    }).classification;

    const actual = sess.eod_truth;

    results.push({
      actual, v1_standard, v2_cand, v1_at_1030_strict, v1_at_1030_ibwidth
    });
    scored++;
  }

  const types = ['TREND', 'BALANCE', 'TURBULENT'];
  function scoreSet(name, key) {
    const total = results.length;
    const matches = results.filter(r => r[key] === r.actual).length;
    console.log("\\n--- " + name + " ---");
    console.log("Overall: " + matches + "/" + total + " (" + (matches/total*100).toFixed(1) + "%)");
    for (const t of types) {
      const predT = results.filter(r => r[key] === t);
      const actT = results.filter(r => r.actual === t);
      const corr = predT.filter(r => r.actual === t).length;
      const p = predT.length > 0 ? (corr/predT.length*100).toFixed(1) : 'N/A';
      const r = actT.length > 0 ? (corr/actT.length*100).toFixed(1) : 'N/A';
      console.log(t.padEnd(10) + ": P=" + String(p).padStart(5) + "%  R=" + String(r).padStart(5) + "%  (Pred:" + predT.length + ")");
    }
  }

  scoreSet('V1 Standard (10:00 inputs)', 'v1_standard');
  scoreSet('V2 Candidate (10:30 inputs)', 'v2_cand');
  scoreSet('V1 Logic with IB Width (10:30 timing proxy)', 'v1_at_1030_ibwidth');

  console.log("\\nDone. Saved to scripts/compare_daytype_v1_vs_v2.js");
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
