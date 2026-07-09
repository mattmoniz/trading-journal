/**
 * daytype_reassessment_config_compare.js
 *
 * Report-only comparison of reassessment-engine configs across all 356
 * scorable sessions, no-lookahead. Does NOT modify
 * server/services/dayTypeReassessmentService.js — a parameterized copy of
 * the engine logic lives here for experimentation only.
 *
 * CONFIG A (current/live candidate): range expansion >= 30% avg_range_20
 *   alone triggers reassessment (any reassessment, first or subsequent).
 * CONFIG B (vol-confirmed first): the FIRST reassessment of a session
 *   requires BOTH range expansion >= 30% AND a vol-jump (postVol/preVol
 *   >= 1.5x) at the SAME checkpoint. Subsequent reassessments use
 *   expansion alone (same as A).
 * CONFIG C1/C2: same as A but with a higher expansion threshold (35% / 40%)
 *   applied to ALL reassessments, no vol-confirmation requirement.
 */

import { query } from '../server/db.js';
import { classifyOpeningType, classifyDayType } from '../server/services/caseEngine.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const RTH_START = 570;
const IB_END = 630;
const CHECKPOINTS = [660, 690, 720, 750, 780, 840, 900, 945]; // 11:00 .. 15:45 ET

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
    const c0 = closes[i - 1], c1 = closes[i];
    if (c0 > 0 && c1 > 0) rets.push(Math.log(c1 / c0));
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance);
}

function fiveMinCloses(bars) {
  const buckets = {};
  for (const b of bars) {
    const k = Math.floor(b.et_min / 5) * 5;
    buckets[k] = b.close;
  }
  return Object.keys(buckets).sort((a, b) => a - b).map(k => buckets[k]);
}

/**
 * Parameterized reassessment engine.
 * @param {object} opts
 * @param {number} opts.expansionThreshold - e.g. 0.30, 0.35, 0.40
 * @param {boolean} opts.requireVolConfirmFirst - if true, the FIRST
 *   reassessment additionally requires volJump (postVol/preVol >= 1.5x).
 */
function runReassessmentVariant({ initialRead, bars, sessOpen, avgRange20, ibHigh, ibLow, checkpoints, expansionThreshold, requireVolConfirmFirst }) {
  let currentRead = initialRead;
  let refHigh = ibHigh;
  let refLow = ibLow;
  let refAnchorT = IB_END;
  let hasReassessed = false;

  const events = [];
  const readAtCheckpoint = {};

  for (const T of checkpoints) {
    const upTo = bars.filter(b => b.et_min <= T);
    if (upTo.length < 5 || !avgRange20) { readAtCheckpoint[T] = currentRead; continue; }

    const currentHigh = Math.max(...upTo.map(b => b.high));
    const currentLow = Math.min(...upTo.map(b => b.low));
    const currentClose = upTo[upTo.length - 1].close;
    const partialRange = currentHigh - currentLow;
    if (partialRange <= 0) { readAtCheckpoint[T] = currentRead; continue; }

    const freshExpansion = Math.max(0, currentHigh - refHigh) + Math.max(0, refLow - currentLow);
    const expansionPct = freshExpansion / avgRange20;
    const rangeTrigger = expansionPct >= expansionThreshold;

    if (rangeTrigger) {
      const preBars = bars.filter(b => b.et_min <= refAnchorT);
      const postBars = bars.filter(b => b.et_min > refAnchorT && b.et_min <= T);
      const preVol = stdevLogReturns(fiveMinCloses(preBars));
      const postVol = stdevLogReturns(fiveMinCloses(postBars));
      const volJump = (preVol != null && postVol != null && preVol > 0) ? (postVol / preVol >= 1.5) : false;

      const range_ratio = partialRange / avgRange20;
      const close_pct = (currentClose - currentLow) / partialRange;
      const trend_str = Math.abs(currentClose - sessOpen) / partialRange;
      const close_outside_ib = currentClose > ibHigh || currentClose < ibLow;
      const newLabel = classifyGroundTruth({ range_ratio, close_pct, trend_str, close_outside_ib });

      const wouldRevertToBalance = newLabel === 'BALANCE' && currentRead !== 'BALANCE';
      const isFirst = !hasReassessed;
      const volGateOk = (isFirst && requireVolConfirmFirst) ? volJump : true;

      if (newLabel !== currentRead && !wouldRevertToBalance && volGateOk) {
        events.push({ time: T, from: currentRead, to: newLabel, volJump, expansionPct });
        currentRead = newLabel;
        refHigh = currentHigh;
        refLow = currentLow;
        refAnchorT = T;
        hasReassessed = true;
      }
    }

    readAtCheckpoint[T] = currentRead;
  }

  return { finalRead: currentRead, events, readAtCheckpoint };
}

async function main() {
  console.log('[daytype_reassessment_config_compare] Report only — no writes.\n');

  const sessQ = await query(`
    WITH sessions AS (
      SELECT
        ts::date AS trade_date,
        (array_agg(open ORDER BY ts))[1]::float AS sess_open,
        MAX(high)::float AS sess_high,
        MIN(low)::float AS sess_low,
        COUNT(*) AS bars
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
          ORDER BY trade_date ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING
        ) AS avg_range_20
      FROM sessions
    )
    SELECT trade_date::text, sess_open, avg_range_20
    FROM with_avg WHERE avg_range_20 IS NOT NULL ORDER BY trade_date
  `);

  const truthQ = await query(`
    SELECT trade_date::text, day_type, (or_high - or_low)::float as or_width,
      COALESCE((
        SELECT SUM(a2.daily_score) FROM acd_daily_log a2
        WHERE a2.trade_date >= a.trade_date - INTERVAL '30 days'
          AND a2.trade_date < a.trade_date AND a2.daily_score IS NOT NULL
      ), 0)::int AS nl30
    FROM acd_daily_log a WHERE day_type IS NOT NULL
  `);
  const truthByDate = {};
  for (const r of truthQ.rows) truthByDate[r.trade_date] = r;

  const sessions = sessQ.rows.filter(s => truthByDate[s.trade_date] && truthByDate[s.trade_date].or_width != null);

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

  // Precompute per-session static initial reads (same for all configs)
  const sessionData = [];
  for (const s of sessions) {
    const bars = (barsByDate[s.trade_date] || []).slice().sort((a,b)=>a.et_min-b.et_min);
    const first5 = bars.filter(b => b.et_min < RTH_START + 5);
    const ibBars = bars.filter(b => b.et_min < IB_END);
    if (first5.length < 5 || ibBars.length < 30) continue;

    const truth = truthByDate[s.trade_date];
    const openingType = classifyOpeningType(first5);
    const staticResult = classifyDayType({ openingType, nl30: truth.nl30, orWidth: truth.or_width, asOfMinutes: 605 });
    const initialRead = staticResult.classification;

    sessionData.push({
      date: s.trade_date,
      actual: truth.day_type,
      initialRead,
      bars,
      sessOpen: s.sess_open,
      avgRange20: s.avg_range_20,
      ibHigh: Math.max(...ibBars.map(b=>b.high)),
      ibLow: Math.min(...ibBars.map(b=>b.low)),
    });
  }

  console.log(`Scored: ${sessionData.length}\n`);
  const total = sessionData.length;
  const staticCorrect = sessionData.filter(r => r.initialRead === r.actual).length;
  const trendCalledBalanceSessions = sessionData.filter(r => r.initialRead === 'BALANCE' && r.actual === 'TREND');

  const configs = [
    { name: 'A (30%, no vol gate)', expansionThreshold: 0.30, requireVolConfirmFirst: false },
    { name: 'B (30% + vol-confirm 1st)', expansionThreshold: 0.30, requireVolConfirmFirst: true },
    { name: 'C1 (35%, no vol gate)', expansionThreshold: 0.35, requireVolConfirmFirst: false },
    { name: 'C2 (40%, no vol gate)', expansionThreshold: 0.40, requireVolConfirmFirst: false },
  ];

  console.log('═'.repeat(90));
  console.log(`STATIC BASELINE: ${staticCorrect}/${total} = ${(staticCorrect/total*100).toFixed(1)}%   |   TREND-called-BALANCE sessions: ${trendCalledBalanceSessions.length}`);
  console.log('═'.repeat(90));

  const rows = [];
  for (const cfg of configs) {
    const results = sessionData.map(r => {
      const eng = runReassessmentVariant({
        initialRead: r.initialRead, bars: r.bars, sessOpen: r.sessOpen, avgRange20: r.avgRange20,
        ibHigh: r.ibHigh, ibLow: r.ibLow, checkpoints: CHECKPOINTS,
        expansionThreshold: cfg.expansionThreshold, requireVolConfirmFirst: cfg.requireVolConfirmFirst,
      });
      return { ...r, finalRead: eng.finalRead, events: eng.events, readAtCheckpoint: eng.readAtCheckpoint };
    });

    const engineCorrect = results.filter(r => r.finalRead === r.actual).length;
    const recovered = results.filter(r => r.initialRead === 'BALANCE' && r.actual === 'TREND' && r.finalRead === 'TREND').length;
    const broken = results.filter(r => r.initialRead === r.actual && r.finalRead !== r.actual).length;
    const fixed = results.filter(r => r.initialRead !== r.actual && r.finalRead === r.actual).length;
    const netCorrect = engineCorrect - staticCorrect;
    const withEvents = results.filter(r => r.events.length > 0).length;
    const multiFlip = results.filter(r => r.events.length > 1).length;

    rows.push({
      name: cfg.name,
      accuracy: (engineCorrect/total*100),
      accuracyN: `${engineCorrect}/${total}`,
      recovered, recoveredPct: trendCalledBalanceSessions.length ? (recovered/trendCalledBalanceSessions.length*100) : 0,
      broken, fixed, netCorrect,
      withEventsPct: (withEvents/total*100), multiFlipPct: (multiFlip/total*100),
    });
  }

  console.log('\nConfig                     | Accuracy        | Trend recovery   | False+ broken | Fixed | Net  | Flip>1');
  console.log('---------------------------+-----------------+------------------+----------------+-------+------+-------');
  for (const r of rows) {
    console.log(
      `${r.name.padEnd(27)}| ${r.accuracyN.padStart(7)} ${r.accuracy.toFixed(1).padStart(5)}% | ${String(r.recovered).padStart(2)}/${trendCalledBalanceSessions.length} (${r.recoveredPct.toFixed(1).padStart(5)}%) | ${String(r.broken).padStart(14)} | ${String(r.fixed).padStart(5)} | ${(r.netCorrect>=0?'+':'')+r.netCorrect}`.padEnd(0) +
      ` | ${r.multiFlipPct.toFixed(1)}%`
    );
  }

  console.log('\n[daytype_reassessment_config_compare] Done. No writes performed.\n');
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
