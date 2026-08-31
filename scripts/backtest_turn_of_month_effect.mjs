import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { findTradingDayGaps } from '../server/services/queries.js';
// FIXED 2026-08-31 (DeepSeek code review round 3, finding R11; also fixes a real bug the same
// finding didn't catch -- see below): this used to open its own raw pg.Client with hardcoded
// credentials instead of the shared query() helper. Migrating also fixes a genuine breakage:
// server/db.js globally overrides pg's `date` (OID 1082) type parser to return the raw string
// rather than a JS Date object -- a process-wide mutation of pg's shared type-parser registry,
// not per-client -- so once ANYTHING in this process imports server/db.js (as the
// assertNoTradingDayGaps import above now transitively does), a raw pg.Client's date columns
// silently stop being Date objects and this file's own `.toISOString()` calls throw. Using
// query() directly (which already depends on that same override) makes the string-not-Date
// contract explicit instead of accidentally-broken.
import { query } from '../server/db.js';

const DOLLARS_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function variance(arr, avg) {
  if (arr.length <= 1) return 0;
  const m = avg ?? mean(arr);
  return arr.reduce((a, b) => a + Math.pow(b - m, 2), 0) / (arr.length - 1);
}

function welchTTest(sample1, sample2) {
  const m1 = mean(sample1);
  const m2 = mean(sample2);
  const v1 = variance(sample1, m1);
  const v2 = variance(sample2, m2);
  const n1 = sample1.length;
  const n2 = sample2.length;
  
  const se = Math.sqrt((v1 / n1) + (v2 / n2));
  if (se === 0) return { t: 0, p: 1 };
  const t = (m1 - m2) / se;
  
  const dfNum = Math.pow((v1 / n1) + (v2 / n2), 2);
  const dfDen = Math.pow(v1 / n1, 2) / (n1 - 1) + Math.pow(v2 / n2, 2) / (n2 - 1);
  const df = dfDen === 0 ? 0 : dfNum / dfDen;
  
  return { t, df };
}

function formatCurrency(val) {
  const sign = val < 0 ? '-' : '+';
  return `${sign}$${Math.abs(val).toFixed(2)}`;
}

async function run() {
  console.log("Fetching daily prices...");
  const res = await query(`
    WITH valid_bars AS (
        SELECT 
            pb.ts,
            pb.open,
            pb.close,
            CASE 
                WHEN EXTRACT(hour FROM pb.ts) >= 18 THEN (pb.ts::date + interval '1 day')::date
                ELSE pb.ts::date
            END as trade_date
        FROM price_bars_primary pb
        WHERE pb.symbol = 'NQ'
    ),
    rth_dates AS (
        SELECT DISTINCT trade_date
        FROM valid_bars
        WHERE EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ),
    daily_prices AS (
        SELECT 
            trade_date,
            (array_agg(open ORDER BY ts ASC))[1] as globex_open,
            (array_agg(close ORDER BY ts DESC))[1] as globex_close,
            (array_agg(open ORDER BY ts ASC) FILTER (WHERE EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959))[1] as rth_open,
            (array_agg(close ORDER BY ts DESC) FILTER (WHERE EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959))[1] as rth_close
        FROM valid_bars
        WHERE trade_date IN (SELECT trade_date FROM rth_dates)
        GROUP BY trade_date
    )
    SELECT * FROM daily_prices ORDER BY trade_date;
  `);

  // FIXED 2026-08-31 (OPEN_DECISION price_bars_primary_systemic_quarterly_data_gap): this is the
  // exact script whose audit surfaced the bug -- currMonth!==nextMonth (line ~123 below)
  // misclassified a real ~63-day contract-rollover gap as a legitimate turn-of-month transition,
  // corrupting 22% of this script's sample. Real, permanent gaps confirmed at all 6 quarterly NQ
  // rollovers from Dec2023 through Mar2025 inclusive, plus a 7th smaller/not-yet-root-caused one
  // around 2025-09 (see server/services/queries.js's own header comment and OPEN_DECISION
  // price_bars_nqh26_contract_thin_and_early_20260928 for the full writeups). This data was
  // never captured and cannot be recovered -- there is nothing to filter OUT of `rows` (the
  // missing dates are already simply absent, not present-and-wrong), so the fix instead makes
  // every positional window computed below GAP-AWARE: any event/window whose index range would
  // straddle a real gap is skipped, rather than silently treating dates[i]/dates[i+1] as
  // adjacent calendar days when they're not.
  const rows = res.rows;
  console.log(`Loaded ${rows.length} valid trading days.`);

  const dates = [];
  const globex_open = [];
  const globex_close = [];
  const rth_open = [];
  const rth_close = [];

  for (const r of rows) {
    const dStr = r.trade_date; // trade_date is already a 'YYYY-MM-DD' string (server/db.js's date type-parser override)
    dates.push(dStr);
    globex_open.push(parseFloat(r.globex_open));
    globex_close.push(parseFloat(r.globex_close));
    rth_open.push(parseFloat(r.rth_open));
    rth_close.push(parseFloat(r.rth_close));
  }

  const dayGaps = findTradingDayGaps(dates, 5);
  console.log(`${dayGaps.length} real trading-day gap(s) > 5 days found in this history (all quarterly-contract-rollover-related, expected -- see OPEN_DECISION price_bars_primary_systemic_quarterly_data_gap): ${dayGaps.map(g => `${g.fromDate}->${g.toDate}(${g.gapDays}d)`).join(', ')}`);
  const gapAfterIndex = new Set(dayGaps.map(g => g.fromIndex));
  // True if the closed index range [startIdx, endIdx] straddles a real gap boundary -- callers
  // use this to skip any event/window that would otherwise silently span one.
  function windowSpansGap(startIdx, endIdx) {
    for (let k = startIdx; k < endIdx; k++) if (gapAfterIndex.has(k)) return true;
    return false;
  }

  const tomIndices = [];
  for (let i = 0; i < dates.length - 3; i++) {
    const currMonth = dates[i].substring(0, 7);
    const nextMonth = dates[i+1].substring(0, 7);
    if (currMonth !== nextMonth && !windowSpansGap(i, i + 1)) {
      tomIndices.push(i);
    }
  }

  const opexIndices = []; 
  const allMonths = [...new Set(dates.map(d => d.substring(0, 7)))];
  
  for (const ym of allMonths) {
    const [year, month] = ym.split('-').map(Number);
    let count = 0;
    let thirdFriday = null;
    for (let day = 1; day <= 31; day++) {
      const d = new Date(year, month - 1, day);
      if (d.getMonth() !== month - 1) break;
      if (d.getDay() === 5) { 
        count++;
        if (count === 3) {
          const yy = d.getFullYear();
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          const dd = String(d.getDate()).padStart(2, '0');
          thirdFriday = `${yy}-${mm}-${dd}`;
          break;
        }
      }
    }
    
    if (thirdFriday) {
      let j = -1;
      for (let i = 0; i < dates.length; i++) {
        if (dates[i] <= thirdFriday) j = i;
        else break;
      }
      if (j >= 4 && dates[j] >= ym + '-01') {
        opexIndices.push(j);
      }
    }
  }

  function evaluateStrategy(indices, windowSize, isOpex = false, useGlobex = false) {
    // FIXED 2026-08-31 (OPEN_DECISION price_bars_primary_systemic_quarterly_data_gap): the
    // baseline loop below scans EVERY windowSize-length window across the whole array -- without
    // a gap check it silently included windows straddling one of the real ~63-day contract-
    // rollover gaps too, contaminating the "unconditional" baseline it's compared against, not
    // just the flagged tom/opex events.
    const allReturns = [];
    for (let i = 0; i <= dates.length - windowSize; i++) {
      if (windowSpansGap(i, i + windowSize - 1)) continue;
      let openPrice, closePrice;
      if (useGlobex) {
        openPrice = globex_open[i];
        closePrice = globex_close[i + windowSize - 1];
      } else {
        openPrice = rth_open[i];
        closePrice = rth_close[i + windowSize - 1];
      }
      const pnlDollars = (closePrice - openPrice) * DOLLARS_PER_POINT;
      allReturns.push(pnlDollars);
    }

    const eventReturns = [];
    const eventDetails = [];

    for (const idx of indices) {
      const startIdx = isOpex ? idx - (windowSize - 1) : idx;
      const endIdx = isOpex ? idx : idx + (windowSize - 1);

      if (endIdx >= dates.length) continue;
      if (windowSpansGap(startIdx, endIdx)) continue;

      let openPrice, closePrice;
      if (useGlobex) {
        openPrice = globex_open[startIdx];
        closePrice = globex_close[endIdx];
      } else {
        openPrice = rth_open[startIdx];
        closePrice = rth_close[endIdx];
      }
      const pnlDollars = (closePrice - openPrice) * DOLLARS_PER_POINT;
      eventReturns.push(pnlDollars);
      
      eventDetails.push({
        startDate: dates[startIdx],
        endDate: dates[endIdx],
        returnDollars: pnlDollars,
        openPrice,
        closePrice
      });
    }

    const tTest = welchTTest(eventReturns, allReturns);
    
    const thirdSize = Math.floor(eventReturns.length / 3);
    const thirds = [
      eventReturns.slice(0, thirdSize),
      eventReturns.slice(thirdSize, 2 * thirdSize),
      eventReturns.slice(2 * thirdSize)
    ];
    
    const allMean = mean(allReturns);
    const stability = thirds.map((t, i) => {
      const tm = mean(t);
      return { 
        name: `Third ${i+1}`, 
        mean: tm, 
        diff: tm - allMean,
        signHolds: (tm - allMean) > 0 
      };
    });

    return {
      n: eventReturns.length,
      allMean: mean(allReturns),
      allMedian: median(allReturns),
      eventMean: mean(eventReturns),
      eventMedian: median(eventReturns),
      tStat: tTest.t,
      df: tTest.df,
      stability,
      eventDetails,
      diff: mean(eventReturns) - mean(allReturns)
    };
  }

  const results = {
    tomRth: evaluateStrategy(tomIndices, 4, false, false),
    tomGlobex: evaluateStrategy(tomIndices, 4, false, true),
    opexRth: evaluateStrategy(opexIndices, 5, true, false),
    opexGlobex: evaluateStrategy(opexIndices, 5, true, true)
  };

  const csvLines = ['StartDate,EndDate,OpenPrice,ClosePrice,ReturnDollars'];
  for (const d of results.tomRth.eventDetails) {
    csvLines.push(`${d.startDate},${d.endDate},${d.openPrice.toFixed(2)},${d.closePrice.toFixed(2)},${d.returnDollars.toFixed(2)}`);
  }
  const csvPath = path.join(__dirname, '..', 'reports', 'turn_of_month_instances_2026-08-26.csv');
  
  if (!fs.existsSync(path.dirname(csvPath))) {
      fs.mkdirSync(path.dirname(csvPath), { recursive: true });
  }
  fs.writeFileSync(csvPath, csvLines.join('\n'));

  console.log("=== Turn-of-the-Month (RTH) ===");
  console.log(`N: ${results.tomRth.n}`);
  console.log(`Event Mean: ${formatCurrency(results.tomRth.eventMean)}`);
  console.log(`Event Median: ${formatCurrency(results.tomRth.eventMedian)}`);
  console.log(`Baseline Mean: ${formatCurrency(results.tomRth.allMean)}`);
  console.log(`Baseline Median: ${formatCurrency(results.tomRth.allMedian)}`);
  console.log(`Diff: ${formatCurrency(results.tomRth.diff)}`);
  console.log(`T-Stat: ${results.tomRth.tStat.toFixed(2)}`);
  results.tomRth.stability.forEach(s => console.log(`${s.name}: ${formatCurrency(s.diff)} (${s.signHolds ? 'PASS' : 'FAIL'})`));

  console.log("\n=== Turn-of-the-Month (Globex) ===");
  console.log(`N: ${results.tomGlobex.n}`);
  console.log(`Event Mean: ${formatCurrency(results.tomGlobex.eventMean)}`);
  console.log(`Baseline Mean: ${formatCurrency(results.tomGlobex.allMean)}`);
  console.log(`Diff: ${formatCurrency(results.tomGlobex.diff)}`);
  console.log(`T-Stat: ${results.tomGlobex.tStat.toFixed(2)}`);

  console.log("\n=== OpEx Week (RTH) ===");
  console.log(`N: ${results.opexRth.n}`);
  console.log(`Event Mean: ${formatCurrency(results.opexRth.eventMean)}`);
  console.log(`Baseline Mean: ${formatCurrency(results.opexRth.allMean)}`);
  console.log(`Diff: ${formatCurrency(results.opexRth.diff)}`);
  console.log(`T-Stat: ${results.opexRth.tStat.toFixed(2)}`);

  const opexCsvLines = ['StartDate,EndDate,OpenPrice,ClosePrice,ReturnDollars'];
  for (const d of results.opexRth.eventDetails) {
    opexCsvLines.push(`${d.startDate},${d.endDate},${d.openPrice.toFixed(2)},${d.closePrice.toFixed(2)},${d.returnDollars.toFixed(2)}`);
  }
  const opexCsvPath = path.join(__dirname, '..', 'reports', 'opex_week_instances_2026-08-26.csv');
  fs.writeFileSync(opexCsvPath, opexCsvLines.join('\n'));
}

run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
