/**
 * Auction Read Card — 30-day retroactive backtest
 *
 * For each trading day in the last 30 days, simulates what the
 * pre-market bias card would have displayed that morning, then
 * compares against what actually happened.
 *
 * Run: node scripts/auction_backtest.js
 * Output: /tmp/auction_backtest.txt
 */

import pg from 'pg';
import fs from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../server/.env') });

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'trading_journal',
  user: process.env.DB_USER || 'trader',
  password: process.env.DB_PASSWORD || 'trader123',
});

const q = (sql, params) => pool.query(sql, params).then(r => r.rows);

// ── Mirror of AuctionReadCard bias logic ─────────────────────────────────────

function classifyDayProfile(sessionHigh, sessionLow, ibHigh, ibLow, sessionClose) {
  if (!ibHigh || !ibLow || !sessionHigh || !sessionLow) return 'UNKNOWN';
  const ibRange = ibHigh - ibLow;
  const sessionRange = sessionHigh - sessionLow;
  if (ibRange === 0) return 'UNKNOWN';
  const extension = sessionRange / ibRange;
  const closePct = (sessionClose - sessionLow) / (sessionRange || 1);
  if (extension > 2.0) return 'TREND';
  if (extension > 1.5) return 'NORMAL_VARIATION';
  if (extension > 0.9) return 'NORMAL';
  // Both sides extended but close near extreme = running neutral
  const upperExt = sessionHigh > ibHigh;
  const lowerExt = sessionLow < ibLow;
  if (upperExt && lowerExt && (closePct > 0.75 || closePct < 0.25)) return 'RUNNING_PROFILE_NEUTRAL';
  if (upperExt && lowerExt) return 'NEUTRAL';
  return 'NONTREND';
}

function getMarketState(profile) {
  const efficient   = ['NORMAL', 'NEUTRAL', 'NONTREND'];
  const inefficient = ['TREND', 'NORMAL_VARIATION'];
  if (efficient.includes(profile))   return 'EFFICIENT';
  if (inefficient.includes(profile)) return 'INEFFICIENT';
  if (profile === 'RUNNING_PROFILE_NEUTRAL') return 'TRANSITIONING';
  return 'UNKNOWN';
}

function generateBias(inv, val, nlTrend, pivotBias, profile) {
  if (!inv || !val) return null;
  const nlDir = nlTrend === 'TRENDING_UP' ? 'up' : nlTrend === 'TRENDING_DOWN' ? 'down' : 'ranging';

  const structureLong  = (inv === 'SHORT_TRAPPED' && val !== 'BELOW_VALUE') ||
                         (inv === 'NEUTRAL'        && val === 'ABOVE_VALUE');
  const structureShort = (inv === 'LONG_TRAPPED'  && val !== 'ABOVE_VALUE') ||
                         (inv === 'NEUTRAL'        && val === 'BELOW_VALUE');
  const nlConflicts = (structureLong && nlDir === 'down') || (structureShort && nlDir === 'up');

  if (inv === 'NEUTRAL' && val === 'INSIDE_VALUE') return { dir: 'NEUTRAL', conflict: false };
  if (structureLong)  return { dir: 'LONG',  conflict: nlConflicts };
  if (structureShort) return { dir: 'SHORT', conflict: nlConflicts };
  return { dir: 'NEUTRAL', conflict: false };
}

// ── Per-day value area computation ───────────────────────────────────────────

async function getDayVA(date) {
  const rows = await q(`
    SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
    FROM price_bars
    WHERE symbol='NQ' AND ts::date=$1
      AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
    GROUP BY ROUND(low/0.25)*0.25
    ORDER BY px
  `, [date]);

  if (!rows.length) return null;
  const total = rows.reduce((s, r) => s + parseFloat(r.vol), 0);
  const poc = rows.reduce((b, r) => parseFloat(r.vol) > parseFloat(b.vol) ? r : b, rows[0]);
  const pocIdx = rows.findIndex(r => Math.abs(parseFloat(r.px) - parseFloat(poc.px)) < 0.5);

  let vaVol = parseFloat(poc.vol), lo = pocIdx, hi = pocIdx;
  while (vaVol < total * 0.70 && (lo > 0 || hi < rows.length - 1)) {
    const upV = hi + 1 < rows.length ? parseFloat(rows[hi+1].vol) : 0;
    const dnV = lo - 1 >= 0 ? parseFloat(rows[lo-1].vol) : 0;
    if (upV >= dnV && hi + 1 < rows.length) { hi++; vaVol += upV; }
    else if (lo - 1 >= 0) { lo--; vaVol += dnV; }
    else break;
  }

  return {
    poc:  parseFloat(poc.px),
    vah:  parseFloat(rows[hi].px),
    val:  parseFloat(rows[lo].px),
  };
}

// ── Main backtest ─────────────────────────────────────────────────────────────

async function run() {
  const lines = [];
  const log = (...args) => { const s = args.join(' '); console.log(s); lines.push(s); };

  log('='.repeat(90));
  log('AUCTION READ CARD — 30-DAY RETROACTIVE BACKTEST');
  log('Simulates what the pre-market bias card would have shown each morning');
  log('='.repeat(90));

  // Get last 30 trading days that have ACD data and bar data
  const tradingDays = await q(`
    SELECT DISTINCT ts::date::text as d
    FROM price_bars
    WHERE symbol='NQ'
      AND ts::date >= CURRENT_DATE - 35
      AND ts::date < CURRENT_DATE
      AND EXTRACT(hour FROM ts) BETWEEN 9 AND 10
    ORDER BY d DESC
    LIMIT 30
  `);

  const days = tradingDays.map(r => r.d).reverse();
  log(`\nAnalyzing ${days.length} trading days from ${days[0]} to ${days[days.length-1]}\n`);

  // 30-day avg OR range for OR condition classification
  const avgOrRow = await q(`
    SELECT ROUND(AVG(or_high-or_low)::numeric,1) as avg
    FROM acd_daily_log
    WHERE or_high IS NOT NULL AND trade_date >= CURRENT_DATE-35
  `);
  const avgOR = parseFloat(avgOrRow[0]?.avg) || 85;

  // Monthly pivot
  const pivotRow = await q(`
    SELECT pivot_level FROM acd_monthly_pivot
    ORDER BY created_at DESC LIMIT 1
  `);
  const pivotLevel = pivotRow[0] ? parseFloat(pivotRow[0].pivot_level) : null;

  const results = [];

  for (let i = 1; i < days.length; i++) {
    const today = days[i];
    const priorDay = days[i - 1];

    // ── Prior day data ─────────────────────────────────────────────────────
    const priorBars = await q(`
      SELECT
        MAX(high)::float as session_high,
        MIN(low)::float as session_low,
        (array_agg(close ORDER BY ts DESC))[1]::float as session_close,
        (array_agg(open ORDER BY ts ASC))[1]::float as session_open,
        MAX(high) FILTER (WHERE EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 630)::float as ib_high,
        MIN(low)  FILTER (WHERE EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 630)::float as ib_low
      FROM price_bars
      WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
    `, [priorDay]);

    const pb = priorBars[0];
    if (!pb?.session_high) continue;

    const priorVA = await getDayVA(priorDay);
    if (!priorVA) continue;

    const priorProfile = classifyDayProfile(pb.session_high, pb.session_low, pb.ib_high, pb.ib_low, pb.session_close);

    // ── Today's data ───────────────────────────────────────────────────────
    const acdRow = await q(`
      SELECT or_high::float, or_low::float, daily_score, a_up_fired, a_down_fired,
             session_close::float
      FROM acd_daily_log WHERE trade_date=$1
    `, [today]);

    const acd = acdRow[0];
    if (!acd?.or_high) continue;

    const orMid = (acd.or_high + acd.or_low) / 2;
    const orRange = acd.or_high - acd.or_low;

    // ACD NL30 at start of today (sum of last 30 logged scores before today)
    const nlRow = await q(`
      SELECT COALESCE(SUM(daily_score), 0) as nl30
      FROM (SELECT daily_score FROM acd_daily_log
            WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 30) s
    `, [today]);
    const nl30 = parseInt(nlRow[0]?.nl30) || 0;
    const nlTrend = nl30 > 9 ? 'TRENDING_UP' : nl30 < -9 ? 'TRENDING_DOWN' : 'RANGING';

    // Today's first bar (open)
    const openRow = await q(`
      SELECT (array_agg(open ORDER BY ts ASC))[1]::float as open_price
      FROM price_bars WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 575
    `, [today]);
    const todayOpen = openRow[0]?.open_price;

    // Today's actual close and direction
    const closeRow = await q(`
      SELECT (array_agg(close ORDER BY ts DESC))[1]::float as close_price,
             MAX(high)::float as session_high, MIN(low)::float as session_low
      FROM price_bars WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
    `, [today]);
    const todayClose = closeRow[0]?.close_price;
    const todayHigh  = closeRow[0]?.session_high;
    const todayLow   = closeRow[0]?.session_low;

    // ── Compute signals ────────────────────────────────────────────────────

    // Overnight inventory
    const inv = orMid > priorVA.vah ? 'SHORT_TRAPPED'
              : orMid < priorVA.val ? 'LONG_TRAPPED'
              : 'NEUTRAL';

    // Open vs prior value
    const val = orMid > priorVA.vah ? 'ABOVE_VALUE'
              : orMid < priorVA.val ? 'BELOW_VALUE'
              : 'INSIDE_VALUE';

    // OR condition
    const orRatio = orRange / avgOR;
    const orCond = orRatio < 0.5 ? 'NARROW' : orRatio < 1.5 ? 'NORMAL' : orRatio < 2.5 ? 'WIDE' : 'EMOTIONAL';

    // Pivot bias
    const pivotBias = pivotLevel ? (todayOpen > pivotLevel ? 'up' : 'down') : null;

    // Market state
    const marketState = getMarketState(priorProfile);

    // Pre-market bias
    const bias = generateBias(inv, val, nlTrend, pivotBias, priorProfile);

    // ── Actual outcome ─────────────────────────────────────────────────────
    const ptsVsOpen = todayClose && todayOpen ? todayClose - todayOpen : null;
    const actualDir = acd.daily_score > 0 ? 'BULLISH'
                    : acd.daily_score < 0 ? 'BEARISH'
                    : ptsVsOpen > 0 ? 'BULLISH'
                    : ptsVsOpen < 0 ? 'BEARISH'
                    : 'NEUTRAL';

    // Score
    let outcome = '—';
    if (bias?.dir === 'LONG'  && actualDir === 'BULLISH') outcome = '✓ CORRECT';
    if (bias?.dir === 'SHORT' && actualDir === 'BEARISH') outcome = '✓ CORRECT';
    if (bias?.dir === 'LONG'  && actualDir === 'BEARISH') outcome = '✗ WRONG';
    if (bias?.dir === 'SHORT' && actualDir === 'BULLISH') outcome = '✗ WRONG';
    if (bias?.dir === 'NEUTRAL') outcome = '— NEUTRAL';

    results.push({
      date: today,
      priorProfile,
      marketState,
      inv, val, orCond,
      nl30, nlTrend,
      biasDir: bias?.dir || 'NEUTRAL',
      conflict: bias?.conflict || false,
      actualDir,
      acdScore: acd.daily_score,
      ptsVsOpen: ptsVsOpen ? ptsVsOpen.toFixed(1) : '—',
      sessionRange: todayHigh && todayLow ? (todayHigh - todayLow).toFixed(0) : '—',
      orRange: orRange.toFixed(0),
      priorVAH: priorVA.vah.toFixed(2),
      priorVAL: priorVA.val.toFixed(2),
      orMid: orMid.toFixed(2),
      outcome,
    });
  }

  // ── Print day-by-day table ────────────────────────────────────────────────
  log('\n' + '─'.repeat(90));
  log('DAY-BY-DAY RESULTS');
  log('─'.repeat(90));
  const hdr = ['Date','Prior Profile','Inv','Val','NL30','Bias','Conflict','Actual','Score','Pts','Outcome'];
  log(hdr.map((h,i) => h.padEnd([10,18,14,14,6,8,9,9,6,6,12][i])).join(''));
  log('─'.repeat(90));

  for (const r of results) {
    const cols = [
      r.date,
      r.priorProfile,
      r.inv.replace('_TRAPPED','').replace('_',' '),
      r.val.replace('_VALUE','').replace('_',' '),
      String(r.nl30),
      r.biasDir,
      r.conflict ? 'YES' : 'no',
      r.actualDir,
      String(r.acdScore),
      String(r.ptsVsOpen),
      r.outcome,
    ];
    const widths = [10,18,14,14,6,8,9,9,6,6,12];
    log(cols.map((c,i) => String(c).padEnd(widths[i])).join(''));
  }

  // ── Summary stats ─────────────────────────────────────────────────────────
  log('\n' + '='.repeat(60));
  log('SUMMARY');
  log('='.repeat(60));

  const directional = results.filter(r => !['—','— NEUTRAL'].includes(r.outcome));
  const correct     = results.filter(r => r.outcome.includes('CORRECT'));
  const wrong       = results.filter(r => r.outcome.includes('WRONG'));
  const neutral     = results.filter(r => r.biasDir === 'NEUTRAL');
  const conflicts   = results.filter(r => r.conflict);

  log(`\nTotal days analyzed:    ${results.length}`);
  log(`Directional signals:    ${directional.length} (${neutral.length} neutral/skipped)`);
  log(`Correct:                ${correct.length}`);
  log(`Wrong:                  ${wrong.length}`);
  log(`Accuracy:               ${directional.length ? (correct.length/directional.length*100).toFixed(1) : 0}%`);
  log(`Conflicting signals:    ${conflicts.length} (structure vs NL disagree)`);

  if (correct.length) {
    const avgPtsCorrect = correct.filter(r => r.ptsVsOpen !== '—')
      .reduce((s,r) => s + parseFloat(r.ptsVsOpen), 0) / correct.length;
    log(`Avg pts moved (correct): ${avgPtsCorrect.toFixed(1)}`);
  }
  if (wrong.length) {
    const avgPtsWrong = wrong.filter(r => r.ptsVsOpen !== '—')
      .reduce((s,r) => s + parseFloat(r.ptsVsOpen), 0) / wrong.length;
    log(`Avg pts moved (wrong):   ${avgPtsWrong.toFixed(1)}`);
  }

  // Breakdown by bias direction
  log('\n── By bias direction:');
  for (const dir of ['LONG','SHORT']) {
    const subset = results.filter(r => r.biasDir === dir);
    const ok = subset.filter(r => r.outcome.includes('CORRECT'));
    const bad = subset.filter(r => r.outcome.includes('WRONG'));
    if (subset.length) log(`  ${dir.padEnd(6)}: ${ok.length}/${ok.length+bad.length} (${(ok.length/(ok.length+bad.length||1)*100).toFixed(0)}% accuracy)`);
  }

  // Breakdown by conflict
  log('\n── Conflicting signals (structure vs NL):');
  const confOk  = conflicts.filter(r => r.outcome.includes('CORRECT'));
  const confBad = conflicts.filter(r => r.outcome.includes('WRONG'));
  log(`  ${confOk.length} correct, ${confBad.length} wrong of ${conflicts.length} conflicts`);
  if (conflicts.length) log(`  Accuracy: ${(confOk.length/(confOk.length+confBad.length||1)*100).toFixed(0)}%`);

  // Breakdown by prior day profile
  log('\n── By prior day profile:');
  const profiles = [...new Set(results.map(r => r.priorProfile))];
  for (const p of profiles) {
    const sub = results.filter(r => r.priorProfile === p && !['—','— NEUTRAL'].includes(r.outcome));
    const ok = sub.filter(r => r.outcome.includes('CORRECT'));
    if (sub.length) log(`  ${p.padEnd(24)}: ${ok.length}/${sub.length} (${(ok.length/sub.length*100).toFixed(0)}%)`);
  }

  log('\n' + '='.repeat(60));

  // Save to file
  fs.writeFileSync('/tmp/auction_backtest.txt', lines.join('\n'));
  console.log('\n✓ Results saved to /tmp/auction_backtest.txt');

  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
