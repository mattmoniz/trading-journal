// backtest_probe_stall_reversal.js
// Comprehensive backtest: Probe-Stall-Reversal vs First-Touch Fade at key levels
// Pattern: price pushes THROUGH a level by 10-50pt, next bars stall, then reversal back through level

import { query } from '../server/db.js';

const PNL_PER_POINT = 2;
const COMMISSION = 1;
const SYMBOL = 'NQ';
const RTH_START = 570;  // 9:30 ET
const RTH_END = 959;    // 15:59 ET
const IB_END = 630;     // 10:30 ET

// ============================================================
// 1) Load all trading dates and their key levels
// ============================================================
async function loadAllDaysWithLevels() {
  // Get all trading dates from DVL (which has prior-day value area)
  const datesQ = await query(`
    SELECT DISTINCT trade_date FROM developing_value_log
    WHERE trade_date >= '2023-11-17'
    ORDER BY trade_date
  `);
  const tradingDates = datesQ.rows.map(r => r.trade_date);
  console.log(`Found ${tradingDates.length} trading dates in DVL`);

  // Preload all DVL data keyed by date
  const dvlQ = await query(`
    SELECT trade_date, poc::float, vah::float, val::float,
           session_high::float, session_low::float, session_close::float
    FROM developing_value_log ORDER BY trade_date
  `);
  const dvlByDate = {};
  for (const r of dvlQ.rows) dvlByDate[r.trade_date] = r;

  // Preload all ACD data keyed by date
  const acdQ = await query(`
    SELECT trade_date, or_high::float, or_low::float
    FROM acd_daily_log ORDER BY trade_date
  `);
  const acdByDate = {};
  for (const r of acdQ.rows) acdByDate[r.trade_date] = r;

  // Preload prior-day RTH H/L/C for floor pivots (compute from price bars)
  // We'll do this per-date in a single query
  const floorQ = await query(`
    WITH daily_hlc AS (
      SELECT ts::date as d,
             MAX(high)::float as h, MIN(low)::float as l,
             (array_agg(close::float ORDER BY ts DESC))[1] as c
      FROM price_bars_primary
      WHERE symbol='NQ'
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN ${RTH_START} AND ${RTH_END}
      GROUP BY ts::date
    )
    SELECT d as trade_date, h, l, c FROM daily_hlc ORDER BY d
  `);
  const dailyHLC = {};
  for (const r of floorQ.rows) {
    const d = typeof r.trade_date === 'string' ? r.trade_date : r.trade_date.toISOString().slice(0,10);
    dailyHLC[d] = r;
  }

  // Preload IB (9:30-10:30) high/low per date
  const ibQ = await query(`
    SELECT ts::date as d, MAX(high)::float as ibh, MIN(low)::float as ibl
    FROM price_bars_primary
    WHERE symbol='NQ'
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN ${RTH_START} AND ${IB_END}
    GROUP BY ts::date
    ORDER BY d
  `);
  const ibByDate = {};
  for (const r of ibQ.rows) {
    const d = typeof r.d === 'string' ? r.d : r.d.toISOString().slice(0,10);
    ibByDate[d] = { high: r.ibh, low: r.ibl };
  }

  // Build levels for each date
  const results = [];
  const sortedDates = Object.keys(dvlByDate).sort();

  for (let i = 1; i < sortedDates.length; i++) {
    const today = sortedDates[i];
    const yesterday = sortedDates[i-1];
    const pdDVL = dvlByDate[yesterday];
    const todayACD = acdByDate[today];

    if (!pdDVL) continue;

    const levels = [];

    // Prior Day Value Area levels
    if (pdDVL.poc) levels.push({ name: 'PD_POC', price: pdDVL.poc, type: 'pivot' });
    if (pdDVL.vah) levels.push({ name: 'PD_VAH', price: pdDVL.vah, type: 'resistance' });
    if (pdDVL.val) levels.push({ name: 'PD_VAL', price: pdDVL.val, type: 'support' });

    // OR levels (available after first 5 min)
    if (todayACD?.or_high) levels.push({ name: 'OR_HIGH', price: todayACD.or_high, type: 'resistance' });
    if (todayACD?.or_low) levels.push({ name: 'OR_LOW', price: todayACD.or_low, type: 'support' });

    // OR Mid
    if (todayACD?.or_high && todayACD?.or_low) {
      levels.push({ name: 'OR_MID', price: (todayACD.or_high + todayACD.or_low) / 2, type: 'pivot' });
    }

    // Floor Pivots from prior day HLC
    // Find the actual prior trading day in dailyHLC
    const priorDates = Object.keys(dailyHLC).filter(d => d < today).sort();
    const priorTradingDay = priorDates.length > 0 ? priorDates[priorDates.length - 1] : null;
    if (priorTradingDay && dailyHLC[priorTradingDay]) {
      const p = dailyHLC[priorTradingDay];
      if (p.h && p.l && p.c) {
        const PP = (p.h + p.l + p.c) / 3;
        levels.push({ name: 'FLOOR_PP', price: Math.round(PP * 100) / 100, type: 'pivot' });
        levels.push({ name: 'FLOOR_R1', price: Math.round((2*PP - p.l) * 100) / 100, type: 'resistance' });
        levels.push({ name: 'FLOOR_S1', price: Math.round((2*PP - p.h) * 100) / 100, type: 'support' });
      }
    }

    // IB High/Low — available after 10:30, so only use PRIOR day's IB for testing
    // Actually, today's IB is known after 10:30. We'll mark these levels with a time constraint.
    if (ibByDate[today]) {
      levels.push({ name: 'IB_HIGH', price: ibByDate[today].high, type: 'resistance', availableAfterMin: IB_END });
      levels.push({ name: 'IB_LOW', price: ibByDate[today].low, type: 'support', availableAfterMin: IB_END });
      // IB Mid
      levels.push({ name: 'IB_MID', price: (ibByDate[today].high + ibByDate[today].low) / 2, type: 'pivot', availableAfterMin: IB_END });
    }

    // Prior Day IB Mid
    if (priorTradingDay && ibByDate[priorTradingDay]) {
      levels.push({ name: 'PD_IB_MID', price: (ibByDate[priorTradingDay].high + ibByDate[priorTradingDay].low) / 2, type: 'pivot' });
    }

    // Prior Day OR Mid
    const pdACD = acdByDate[yesterday];
    if (pdACD?.or_high && pdACD?.or_low) {
      levels.push({ name: 'PD_OR_MID', price: (pdACD.or_high + pdACD.or_low) / 2, type: 'pivot' });
    }

    results.push({ date: today, levels });
  }

  return results;
}

// ============================================================
// 2) Load 1-min bars for a date
// ============================================================
async function loadBarsForDate(date) {
  const r = await query(`
    SELECT ts, open::float, high::float, low::float, close::float, volume::int
    FROM price_bars_primary
    WHERE symbol=$1 AND ts::date = $2
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN ${RTH_START} AND ${RTH_END}
    ORDER BY ts
  `, [SYMBOL, date]);
  return r.rows.map(row => ({
    ...row,
    etMin: new Date(row.ts).getUTCHours() * 60 + new Date(row.ts).getUTCMinutes(),
    range: row.high - row.low,
  }));
}

// ============================================================
// 3) Pattern Detection
// ============================================================

function detectProbeStallReversal(bars, level, stallType) {
  const trades = [];

  for (let i = 0; i < bars.length - 5; i++) {
    const bar = bars[i];

    // Skip if level not yet available (IB levels only after 10:30)
    if (level.availableAfterMin && bar.etMin < level.availableAfterMin) continue;

    const price = level.price;

    // ---- PROBE ABOVE (price breaks above level) ----
    if (bar.close > price + 10 && bar.close <= price + 50) {
      const probeDepth = bar.close - price;
      const probeRange = bar.range;
      const probeHigh = bar.high;

      // Check stall
      let stallConfirmed = false;
      let stallBarsUsed = 0;

      if (stallType === 'STRICT') {
        // Next bar: range < 50% of probe bar AND closes back toward level
        const next = bars[i+1];
        if (next && next.range < probeRange * 0.5 && next.close < bar.close) {
          stallConfirmed = true;
          stallBarsUsed = 1;
        }
      } else if (stallType === 'MODERATE') {
        // Next bar makes no new high above probe bar high
        const next = bars[i+1];
        if (next && next.high <= probeHigh) {
          stallConfirmed = true;
          stallBarsUsed = 1;
        }
      } else if (stallType === 'LOOSE') {
        // Next 2-3 bars combined don't extend more than 10pt beyond probe high
        let maxHigh = 0;
        const lookBars = Math.min(3, bars.length - i - 1);
        for (let j = 1; j <= lookBars; j++) {
          maxHigh = Math.max(maxHigh, bars[i+j].high);
        }
        if (lookBars > 0 && maxHigh <= probeHigh + 10) {
          stallConfirmed = true;
          stallBarsUsed = lookBars;
        }
      }

      if (!stallConfirmed) continue;

      // REVERSAL ENTRY: wait for price to cross back through the level (close below level)
      let entryBar = null;
      let entryIdx = null;
      for (let j = i + 1 + stallBarsUsed; j < Math.min(i + 10, bars.length); j++) {
        if (bars[j].close < price) {
          entryBar = bars[j];
          entryIdx = j;
          break;
        }
      }

      if (!entryBar) continue;

      // SHORT trade: entry at level, stop at probe extreme + 10, target = level - 40
      const entryPrice = price;
      const stopPrice = probeHigh + 10;
      const targetPrice = price - 40;
      const stopDist = stopPrice - entryPrice;

      // Simulate: check subsequent bars
      let result = null;
      let mae = 0;  // worst adverse excursion (positive = bad for short)
      let mfe = 0;  // best favorable excursion (positive = good for short)

      for (let j = entryIdx + 1; j < bars.length; j++) {
        const excursionUp = bars[j].high - entryPrice;   // adverse for short
        const excursionDown = entryPrice - bars[j].low;    // favorable for short
        mae = Math.max(mae, excursionUp);
        mfe = Math.max(mfe, excursionDown);

        if (bars[j].high >= stopPrice) {
          result = 'STOP';
          break;
        }
        if (bars[j].low <= targetPrice) {
          result = 'TARGET';
          break;
        }
      }

      if (!result) {
        // EOD exit
        const lastBar = bars[bars.length - 1];
        const eodPnl = entryPrice - lastBar.close;
        result = eodPnl > 0 ? 'EOD_WIN' : 'EOD_LOSS';
      }

      trades.push({
        date: bars[0].ts,
        level: level.name,
        direction: 'SHORT',
        probeDepth,
        probeRange,
        entryMin: entryBar.etMin,
        barsToEntry: entryIdx - i,
        result,
        pnl: result === 'TARGET' ? 40 * PNL_PER_POINT - COMMISSION
           : result === 'STOP' ? -stopDist * PNL_PER_POINT - COMMISSION
           : (entryPrice - bars[bars.length-1].close) * PNL_PER_POINT - COMMISSION,
        mae,
        mfe,
        stopDist,
        volume: bar.volume,
      });

      // Skip ahead to avoid overlapping trades on same level
      i = entryIdx + 5;
    }

    // ---- PROBE BELOW (price breaks below level) ----
    else if (bar.close < price - 10 && bar.close >= price - 50) {
      const probeDepth = price - bar.close;
      const probeRange = bar.range;
      const probeLow = bar.low;

      let stallConfirmed = false;
      let stallBarsUsed = 0;

      if (stallType === 'STRICT') {
        const next = bars[i+1];
        if (next && next.range < probeRange * 0.5 && next.close > bar.close) {
          stallConfirmed = true;
          stallBarsUsed = 1;
        }
      } else if (stallType === 'MODERATE') {
        const next = bars[i+1];
        if (next && next.low >= probeLow) {
          stallConfirmed = true;
          stallBarsUsed = 1;
        }
      } else if (stallType === 'LOOSE') {
        let minLow = Infinity;
        const lookBars = Math.min(3, bars.length - i - 1);
        for (let j = 1; j <= lookBars; j++) {
          minLow = Math.min(minLow, bars[i+j].low);
        }
        if (lookBars > 0 && minLow >= probeLow - 10) {
          stallConfirmed = true;
          stallBarsUsed = lookBars;
        }
      }

      if (!stallConfirmed) continue;

      // REVERSAL ENTRY: wait for price to cross back through the level (close above level)
      let entryBar = null;
      let entryIdx = null;
      for (let j = i + 1 + stallBarsUsed; j < Math.min(i + 10, bars.length); j++) {
        if (bars[j].close > price) {
          entryBar = bars[j];
          entryIdx = j;
          break;
        }
      }

      if (!entryBar) continue;

      // LONG trade: entry at level, stop at probe extreme - 10, target = level + 40
      const entryPrice = price;
      const stopPrice = probeLow - 10;
      const targetPrice = price + 40;
      const stopDist = entryPrice - stopPrice;

      let result = null;
      let mae = 0;
      let mfe = 0;

      for (let j = entryIdx + 1; j < bars.length; j++) {
        const excursionDown = entryPrice - bars[j].low;    // adverse for long
        const excursionUp = bars[j].high - entryPrice;     // favorable for long
        mae = Math.max(mae, excursionDown);
        mfe = Math.max(mfe, excursionUp);

        if (bars[j].low <= stopPrice) {
          result = 'STOP';
          break;
        }
        if (bars[j].high >= targetPrice) {
          result = 'TARGET';
          break;
        }
      }

      if (!result) {
        const lastBar = bars[bars.length - 1];
        const eodPnl = lastBar.close - entryPrice;
        result = eodPnl > 0 ? 'EOD_WIN' : 'EOD_LOSS';
      }

      trades.push({
        date: bars[0].ts,
        level: level.name,
        direction: 'LONG',
        probeDepth,
        probeRange,
        entryMin: entryBar.etMin,
        barsToEntry: entryIdx - i,
        result,
        pnl: result === 'TARGET' ? 40 * PNL_PER_POINT - COMMISSION
           : result === 'STOP' ? -stopDist * PNL_PER_POINT - COMMISSION
           : (bars[bars.length-1].close - entryPrice) * PNL_PER_POINT - COMMISSION,
        mae,
        mfe,
        stopDist,
        volume: bar.volume,
      });

      i = entryIdx + 5;
    }
  }

  return trades;
}

// ============================================================
// 4) First-Touch Fade Detection (for comparison)
// ============================================================
function detectFirstTouchFade(bars, level) {
  const trades = [];
  const price = level.price;
  let touched = false;

  for (let i = 0; i < bars.length - 5; i++) {
    if (touched) break; // only first touch
    const bar = bars[i];

    if (level.availableAfterMin && bar.etMin < level.availableAfterMin) continue;

    // Touch from below (fade short)
    if (!touched && bar.high >= price - 2 && bar.high <= price + 5 && bar.open < price) {
      touched = true;
      const entryPrice = price;
      const stopPrice = price + 20;
      const targetPrice = price - 40;

      let result = null;
      let mae = 0, mfe = 0;

      for (let j = i + 1; j < bars.length; j++) {
        mae = Math.max(mae, bars[j].high - entryPrice);
        mfe = Math.max(mfe, entryPrice - bars[j].low);

        if (bars[j].high >= stopPrice) { result = 'STOP'; break; }
        if (bars[j].low <= targetPrice) { result = 'TARGET'; break; }
      }

      if (!result) {
        const eodPnl = entryPrice - bars[bars.length-1].close;
        result = eodPnl > 0 ? 'EOD_WIN' : 'EOD_LOSS';
      }

      trades.push({
        date: bars[0].ts,
        level: level.name,
        direction: 'SHORT',
        result,
        pnl: result === 'TARGET' ? 40 * PNL_PER_POINT - COMMISSION
           : result === 'STOP' ? -20 * PNL_PER_POINT - COMMISSION
           : (entryPrice - bars[bars.length-1].close) * PNL_PER_POINT - COMMISSION,
        mae, mfe,
        entryMin: bar.etMin,
      });
    }

    // Touch from above (fade long)
    if (!touched && bar.low <= price + 2 && bar.low >= price - 5 && bar.open > price) {
      touched = true;
      const entryPrice = price;
      const stopPrice = price - 20;
      const targetPrice = price + 40;

      let result = null;
      let mae = 0, mfe = 0;

      for (let j = i + 1; j < bars.length; j++) {
        mae = Math.max(mae, entryPrice - bars[j].low);
        mfe = Math.max(mfe, bars[j].high - entryPrice);

        if (bars[j].low <= stopPrice) { result = 'STOP'; break; }
        if (bars[j].high >= targetPrice) { result = 'TARGET'; break; }
      }

      if (!result) {
        const eodPnl = bars[bars.length-1].close - entryPrice;
        result = eodPnl > 0 ? 'EOD_WIN' : 'EOD_LOSS';
      }

      trades.push({
        date: bars[0].ts,
        level: level.name,
        direction: 'LONG',
        result,
        pnl: result === 'TARGET' ? 40 * PNL_PER_POINT - COMMISSION
           : result === 'STOP' ? -20 * PNL_PER_POINT - COMMISSION
           : (bars[bars.length-1].close - entryPrice) * PNL_PER_POINT - COMMISSION,
        mae, mfe,
        entryMin: bar.etMin,
      });
    }
  }

  return trades;
}

// ============================================================
// 5) Aggregation helpers
// ============================================================
function aggregateTrades(trades) {
  if (trades.length === 0) return { n: 0, wr: 0, ev: 0, avgMAE: 0, avgMFE: 0, totalPnl: 0 };
  const wins = trades.filter(t => t.result === 'TARGET' || t.result === 'EOD_WIN');
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  return {
    n: trades.length,
    wins: wins.length,
    wr: (wins.length / trades.length * 100),
    ev: totalPnl / trades.length,
    avgMAE: trades.reduce((s, t) => s + t.mae, 0) / trades.length,
    avgMFE: trades.reduce((s, t) => s + t.mfe, 0) / trades.length,
    totalPnl,
  };
}

// ============================================================
// 6) MAIN
// ============================================================
async function main() {
  console.log('='.repeat(100));
  console.log('PROBE-STALL-REVERSAL BACKTEST — All Available Data');
  console.log('='.repeat(100));
  console.log('');

  const allDays = await loadAllDaysWithLevels();
  console.log(`Processing ${allDays.length} trading days with levels...\n`);

  const stallTypes = ['STRICT', 'MODERATE', 'LOOSE'];

  // Accumulate all trades
  const probeTradesByLevelStall = {};  // key: "LEVEL|STALL" -> trades[]
  const firstTouchByLevel = {};        // key: "LEVEL" -> trades[]

  // Initialize
  const levelNames = ['PD_POC','PD_VAH','PD_VAL','OR_HIGH','OR_LOW','OR_MID',
                       'FLOOR_PP','FLOOR_R1','FLOOR_S1','IB_HIGH','IB_LOW','IB_MID',
                       'PD_IB_MID','PD_OR_MID'];
  for (const ln of levelNames) {
    firstTouchByLevel[ln] = [];
    for (const st of stallTypes) {
      probeTradesByLevelStall[`${ln}|${st}`] = [];
    }
  }

  // Process each day
  let processed = 0;
  for (const day of allDays) {
    const bars = await loadBarsForDate(day.date);
    if (bars.length < 30) continue;

    for (const level of day.levels) {
      // First-touch fade
      const ftTrades = detectFirstTouchFade(bars, level);
      if (firstTouchByLevel[level.name]) {
        firstTouchByLevel[level.name].push(...ftTrades);
      }

      // Probe-stall-reversal for each stall type
      for (const st of stallTypes) {
        const pTrades = detectProbeStallReversal(bars, level, st);
        const key = `${level.name}|${st}`;
        if (probeTradesByLevelStall[key]) {
          probeTradesByLevelStall[key].push(...pTrades);
        }
      }
    }

    processed++;
    if (processed % 50 === 0) process.stderr.write(`  ... processed ${processed}/${allDays.length} days\r`);
  }
  console.log(`Processed ${processed} days total.\n`);

  // ============================================================
  // SECTION A: Level x Stall Comparison Table
  // ============================================================
  console.log('='.repeat(110));
  console.log('SECTION A: PROBE-STALL-REVERSAL by Level & Stall Definition');
  console.log('='.repeat(110));

  const header = 'Level'.padEnd(12) + 'Stall'.padEnd(10) +
    'N'.padStart(6) + 'WR%'.padStart(8) + 'EV$'.padStart(9) +
    'AvgMAE'.padStart(9) + 'AvgMFE'.padStart(9) + 'AvgProbe'.padStart(10) +
    'AvgBars2Entry'.padStart(15) + 'TotalPnL'.padStart(12);
  console.log(header);
  console.log('-'.repeat(110));

  for (const ln of levelNames) {
    for (const st of stallTypes) {
      const key = `${ln}|${st}`;
      const trades = probeTradesByLevelStall[key];
      if (trades.length === 0) continue;
      const agg = aggregateTrades(trades);
      const avgProbe = trades.reduce((s,t) => s + t.probeDepth, 0) / trades.length;
      const avgBarsToEntry = trades.reduce((s,t) => s + t.barsToEntry, 0) / trades.length;

      console.log(
        ln.padEnd(12) + st.padEnd(10) +
        String(agg.n).padStart(6) +
        agg.wr.toFixed(1).padStart(8) +
        ('$' + agg.ev.toFixed(2)).padStart(9) +
        agg.avgMAE.toFixed(1).padStart(9) +
        agg.avgMFE.toFixed(1).padStart(9) +
        avgProbe.toFixed(1).padStart(10) +
        avgBarsToEntry.toFixed(1).padStart(15) +
        ('$' + agg.totalPnl.toFixed(0)).padStart(12)
      );
    }
  }

  // ============================================================
  // SECTION B: Head-to-Head Comparison — First Touch vs Probe-Reversal (MODERATE stall)
  // ============================================================
  console.log('\n' + '='.repeat(120));
  console.log('SECTION B: FIRST-TOUCH FADE vs PROBE-STALL-REVERSAL (MODERATE stall)');
  console.log('='.repeat(120));

  const h2 = 'Level'.padEnd(12) +
    '| FT_N'.padStart(7) + ' FT_WR%'.padStart(9) + ' FT_EV$'.padStart(10) + ' FT_PnL'.padStart(10) +
    ' | PR_N'.padStart(8) + ' PR_WR%'.padStart(9) + ' PR_EV$'.padStart(10) + ' PR_PnL'.padStart(10) +
    ' | Better?'.padStart(11) + ' Delta_WR'.padStart(11) + ' Delta_EV'.padStart(11);
  console.log(h2);
  console.log('-'.repeat(120));

  for (const ln of levelNames) {
    const ftAgg = aggregateTrades(firstTouchByLevel[ln]);
    const prKey = `${ln}|MODERATE`;
    const prAgg = aggregateTrades(probeTradesByLevelStall[prKey]);

    if (ftAgg.n === 0 && prAgg.n === 0) continue;

    const better = prAgg.n >= 10 && ftAgg.n >= 10
      ? (prAgg.ev > ftAgg.ev ? 'PROBE' : 'FIRST_TOUCH')
      : 'LOW_N';
    const deltaWR = prAgg.wr - ftAgg.wr;
    const deltaEV = prAgg.ev - ftAgg.ev;

    console.log(
      ln.padEnd(12) +
      ('| ' + ftAgg.n).padStart(7) +
      ftAgg.wr.toFixed(1).padStart(9) +
      ('$' + ftAgg.ev.toFixed(2)).padStart(10) +
      ('$' + ftAgg.totalPnl.toFixed(0)).padStart(10) +
      (' | ' + prAgg.n).padStart(8) +
      prAgg.wr.toFixed(1).padStart(9) +
      ('$' + prAgg.ev.toFixed(2)).padStart(10) +
      ('$' + prAgg.totalPnl.toFixed(0)).padStart(10) +
      (' | ' + better).padStart(11) +
      (deltaWR >= 0 ? '+' : '') .padStart(1) + deltaWR.toFixed(1).padStart(10) +
      ('$' + (deltaEV >= 0 ? '+' : '') + deltaEV.toFixed(2)).padStart(11)
    );
  }

  // ============================================================
  // SECTION C: Probe Depth Analysis
  // ============================================================
  console.log('\n' + '='.repeat(90));
  console.log('SECTION C: PROBE DEPTH ANALYSIS (MODERATE stall) — Shallow (10-25pt) vs Deep (25-50pt)');
  console.log('='.repeat(90));

  // Aggregate all probe trades by depth bucket
  const allProbeTrades = [];
  for (const ln of levelNames) {
    allProbeTrades.push(...probeTradesByLevelStall[`${ln}|MODERATE`]);
  }

  const shallow = allProbeTrades.filter(t => t.probeDepth <= 25);
  const deep = allProbeTrades.filter(t => t.probeDepth > 25);

  const shallowAgg = aggregateTrades(shallow);
  const deepAgg = aggregateTrades(deep);

  console.log('Depth Bucket'.padEnd(18) + 'N'.padStart(6) + 'WR%'.padStart(8) + 'EV$'.padStart(10) +
    'AvgMAE'.padStart(9) + 'AvgMFE'.padStart(9) + 'AvgDepth'.padStart(10));
  console.log('-'.repeat(90));
  console.log(
    'Shallow (10-25)'.padEnd(18) + String(shallowAgg.n).padStart(6) +
    shallowAgg.wr.toFixed(1).padStart(8) + ('$' + shallowAgg.ev.toFixed(2)).padStart(10) +
    shallowAgg.avgMAE.toFixed(1).padStart(9) + shallowAgg.avgMFE.toFixed(1).padStart(9) +
    (shallow.length ? (shallow.reduce((s,t)=>s+t.probeDepth,0)/shallow.length).toFixed(1) : '0').padStart(10)
  );
  console.log(
    'Deep (25-50)'.padEnd(18) + String(deepAgg.n).padStart(6) +
    deepAgg.wr.toFixed(1).padStart(8) + ('$' + deepAgg.ev.toFixed(2)).padStart(10) +
    deepAgg.avgMAE.toFixed(1).padStart(9) + deepAgg.avgMFE.toFixed(1).padStart(9) +
    (deep.length ? (deep.reduce((s,t)=>s+t.probeDepth,0)/deep.length).toFixed(1) : '0').padStart(10)
  );

  // Per level depth analysis
  console.log('\nPer-Level Depth Breakdown:');
  console.log('Level'.padEnd(12) + 'Shallow_N'.padStart(10) + 'Shallow_WR'.padStart(12) + 'Deep_N'.padStart(8) + 'Deep_WR'.padStart(10));
  console.log('-'.repeat(52));
  for (const ln of levelNames) {
    const lTrades = probeTradesByLevelStall[`${ln}|MODERATE`];
    const lShallow = lTrades.filter(t => t.probeDepth <= 25);
    const lDeep = lTrades.filter(t => t.probeDepth > 25);
    if (lShallow.length + lDeep.length === 0) continue;
    const lsAgg = aggregateTrades(lShallow);
    const ldAgg = aggregateTrades(lDeep);
    console.log(
      ln.padEnd(12) +
      String(lsAgg.n).padStart(10) + (lsAgg.n ? lsAgg.wr.toFixed(1)+'%' : 'n/a').padStart(12) +
      String(ldAgg.n).padStart(8) + (ldAgg.n ? ldAgg.wr.toFixed(1)+'%' : 'n/a').padStart(10)
    );
  }

  // ============================================================
  // SECTION D: Volume Analysis
  // ============================================================
  console.log('\n' + '='.repeat(90));
  console.log('SECTION D: VOLUME ANALYSIS (MODERATE stall) — High vs Low Volume Probes');
  console.log('='.repeat(90));

  if (allProbeTrades.length > 0) {
    const volumes = allProbeTrades.map(t => t.volume).filter(v => v > 0).sort((a,b) => a-b);
    const medianVol = volumes.length > 0 ? volumes[Math.floor(volumes.length / 2)] : 0;

    const highVol = allProbeTrades.filter(t => t.volume > medianVol);
    const lowVol = allProbeTrades.filter(t => t.volume <= medianVol && t.volume > 0);

    const hvAgg = aggregateTrades(highVol);
    const lvAgg = aggregateTrades(lowVol);

    console.log(`Median probe bar volume: ${medianVol}`);
    console.log('Volume Bucket'.padEnd(18) + 'N'.padStart(6) + 'WR%'.padStart(8) + 'EV$'.padStart(10) +
      'AvgMAE'.padStart(9) + 'AvgMFE'.padStart(9));
    console.log('-'.repeat(60));
    console.log(
      'High Volume'.padEnd(18) + String(hvAgg.n).padStart(6) +
      hvAgg.wr.toFixed(1).padStart(8) + ('$' + hvAgg.ev.toFixed(2)).padStart(10) +
      hvAgg.avgMAE.toFixed(1).padStart(9) + hvAgg.avgMFE.toFixed(1).padStart(9)
    );
    console.log(
      'Low Volume'.padEnd(18) + String(lvAgg.n).padStart(6) +
      lvAgg.wr.toFixed(1).padStart(8) + ('$' + lvAgg.ev.toFixed(2)).padStart(10) +
      lvAgg.avgMAE.toFixed(1).padStart(9) + lvAgg.avgMFE.toFixed(1).padStart(9)
    );
    console.log(`\nHypothesis: High volume probe = more trapped traders = better reversal`);
    console.log(`Result: High vol WR ${hvAgg.wr.toFixed(1)}% vs Low vol WR ${lvAgg.wr.toFixed(1)}% — ` +
      `${hvAgg.wr > lvAgg.wr ? 'CONFIRMED' : 'NOT CONFIRMED'}`);
  }

  // ============================================================
  // SECTION E: Time of Day Analysis
  // ============================================================
  console.log('\n' + '='.repeat(90));
  console.log('SECTION E: TIME OF DAY (MODERATE stall)');
  console.log('='.repeat(90));

  const amTrades = allProbeTrades.filter(t => t.entryMin < 720); // before noon
  const pmTrades = allProbeTrades.filter(t => t.entryMin >= 720);
  const amAgg = aggregateTrades(amTrades);
  const pmAgg = aggregateTrades(pmTrades);

  console.log('Period'.padEnd(18) + 'N'.padStart(6) + 'WR%'.padStart(8) + 'EV$'.padStart(10) +
    'AvgMAE'.padStart(9) + 'AvgMFE'.padStart(9));
  console.log('-'.repeat(60));
  console.log('AM (9:30-12:00)'.padEnd(18) + String(amAgg.n).padStart(6) + amAgg.wr.toFixed(1).padStart(8) +
    ('$' + amAgg.ev.toFixed(2)).padStart(10) + amAgg.avgMAE.toFixed(1).padStart(9) + amAgg.avgMFE.toFixed(1).padStart(9));
  console.log('PM (12:00-16:00)'.padEnd(18) + String(pmAgg.n).padStart(6) + pmAgg.wr.toFixed(1).padStart(8) +
    ('$' + pmAgg.ev.toFixed(2)).padStart(10) + pmAgg.avgMAE.toFixed(1).padStart(9) + pmAgg.avgMFE.toFixed(1).padStart(9));

  // Finer time buckets
  console.log('\nHourly Breakdown:');
  console.log('Hour'.padEnd(12) + 'N'.padStart(6) + 'WR%'.padStart(8) + 'EV$'.padStart(10));
  console.log('-'.repeat(36));
  for (let h = 9; h <= 15; h++) {
    const hStart = h * 60 + (h === 9 ? 30 : 0);
    const hEnd = (h+1) * 60 - 1;
    const hTrades = allProbeTrades.filter(t => t.entryMin >= hStart && t.entryMin <= hEnd);
    if (hTrades.length === 0) continue;
    const hAgg = aggregateTrades(hTrades);
    const label = `${h}:${h===9?'30':'00'}-${h+1}:00`;
    console.log(label.padEnd(12) + String(hAgg.n).padStart(6) + hAgg.wr.toFixed(1).padStart(8) +
      ('$' + hAgg.ev.toFixed(2)).padStart(10));
  }

  // ============================================================
  // SECTION F: Optimal Stop Analysis
  // ============================================================
  console.log('\n' + '='.repeat(90));
  console.log('SECTION F: OPTIMAL STOP DISTANCE (testing probe extreme + 5/10/15/20pt)');
  console.log('='.repeat(90));

  // Re-run with different stop distances using all MODERATE probe trades
  // We already have MAE data, so we can simulate
  const stopTests = [5, 10, 15, 20, 25];
  console.log('StopBuffer'.padEnd(12) + 'N'.padStart(6) + 'WR%'.padStart(8) + 'EV$'.padStart(10) + 'TotalPnL'.padStart(12));
  console.log('-'.repeat(48));

  for (const stopBuf of stopTests) {
    // For each trade, recalculate with this stop buffer
    let wins = 0, total = 0, totalPnl = 0;
    for (const t of allProbeTrades) {
      total++;
      const actualStop = t.probeDepth + stopBuf; // from entry (level) to probe extreme + buffer
      // If MAE < actual stop distance, it survived the adverse move
      if (t.mae < actualStop) {
        // Didn't get stopped - check if target hit
        if (t.mfe >= 40) {
          wins++;
          totalPnl += 40 * PNL_PER_POINT - COMMISSION;
        } else {
          // EOD - approximate
          totalPnl += (t.mfe * 0.3) * PNL_PER_POINT - COMMISSION; // conservative EOD estimate
        }
      } else {
        // Stopped out
        totalPnl += -actualStop * PNL_PER_POINT - COMMISSION;
      }
    }
    const wr = total > 0 ? wins/total*100 : 0;
    const ev = total > 0 ? totalPnl/total : 0;
    console.log(
      ('+' + stopBuf + 'pt').padEnd(12) + String(total).padStart(6) + wr.toFixed(1).padStart(8) +
      ('$' + ev.toFixed(2)).padStart(10) + ('$' + totalPnl.toFixed(0)).padStart(12)
    );
  }

  // ============================================================
  // SECTION G: Which Levels ACTUALLY Work?
  // ============================================================
  console.log('\n' + '='.repeat(90));
  console.log('SECTION G: LEVEL RANKING — Which levels produce the best probe-reversal? (MODERATE)');
  console.log('='.repeat(90));

  const levelRank = [];
  for (const ln of levelNames) {
    const trades = probeTradesByLevelStall[`${ln}|MODERATE`];
    if (trades.length < 5) continue;
    const agg = aggregateTrades(trades);
    levelRank.push({ level: ln, ...agg, avgProbe: trades.reduce((s,t)=>s+t.probeDepth,0)/trades.length });
  }
  levelRank.sort((a,b) => b.ev - a.ev);

  console.log('Rank'.padStart(4) + ' Level'.padEnd(14) + 'N'.padStart(6) + 'WR%'.padStart(8) +
    'EV$'.padStart(10) + 'TotalPnL'.padStart(12) + 'AvgProbe'.padStart(10) + 'AvgMAE'.padStart(9) + 'AvgMFE'.padStart(9));
  console.log('-'.repeat(82));

  levelRank.forEach((r, idx) => {
    console.log(
      String(idx+1).padStart(4) + (' ' + r.level).padEnd(14) + String(r.n).padStart(6) +
      r.wr.toFixed(1).padStart(8) + ('$' + r.ev.toFixed(2)).padStart(10) +
      ('$' + r.totalPnl.toFixed(0)).padStart(12) + r.avgProbe.toFixed(1).padStart(10) +
      r.avgMAE.toFixed(1).padStart(9) + r.avgMFE.toFixed(1).padStart(9)
    );
  });

  // ============================================================
  // SECTION H: Stall Type Comparison (aggregated across all levels)
  // ============================================================
  console.log('\n' + '='.repeat(90));
  console.log('SECTION H: STALL TYPE COMPARISON (aggregated across all levels)');
  console.log('='.repeat(90));

  for (const st of stallTypes) {
    let allTrades = [];
    for (const ln of levelNames) {
      allTrades.push(...probeTradesByLevelStall[`${ln}|${st}`]);
    }
    const agg = aggregateTrades(allTrades);
    console.log(
      st.padEnd(12) + 'N=' + String(agg.n).padStart(5) +
      '  WR=' + agg.wr.toFixed(1).padStart(5) + '%' +
      '  EV=$' + agg.ev.toFixed(2).padStart(7) +
      '  Total=$' + agg.totalPnl.toFixed(0).padStart(8) +
      '  AvgMAE=' + agg.avgMAE.toFixed(1).padStart(5) +
      '  AvgMFE=' + agg.avgMFE.toFixed(1).padStart(5)
    );
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log('\n' + '='.repeat(100));
  console.log('SUMMARY & KEY FINDINGS');
  console.log('='.repeat(100));

  // Best probe-reversal level
  if (levelRank.length > 0) {
    const best = levelRank[0];
    console.log(`\nBest probe-reversal level: ${best.level} (N=${best.n}, WR=${best.wr.toFixed(1)}%, EV=$${best.ev.toFixed(2)})`);
  }

  // Best stall type
  const stallResults = stallTypes.map(st => {
    let allTrades = [];
    for (const ln of levelNames) allTrades.push(...probeTradesByLevelStall[`${ln}|${st}`]);
    return { st, ...aggregateTrades(allTrades) };
  });
  const bestStall = stallResults.sort((a,b) => b.ev - a.ev)[0];
  console.log(`Best stall definition: ${bestStall.st} (N=${bestStall.n}, WR=${bestStall.wr.toFixed(1)}%, EV=$${bestStall.ev.toFixed(2)})`);

  // Probe vs first touch verdict
  console.log('\n--- PROBE vs FIRST-TOUCH VERDICT (per level, MODERATE stall) ---');
  for (const ln of levelNames) {
    const ft = aggregateTrades(firstTouchByLevel[ln]);
    const pr = aggregateTrades(probeTradesByLevelStall[`${ln}|MODERATE`]);
    if (ft.n < 10 || pr.n < 10) continue;
    const verdict = pr.ev > ft.ev ? 'WAIT FOR PROBE' : 'TAKE FIRST TOUCH';
    console.log(`  ${ln}: FT(N=${ft.n}, WR=${ft.wr.toFixed(1)}%, EV=$${ft.ev.toFixed(2)}) vs PR(N=${pr.n}, WR=${pr.wr.toFixed(1)}%, EV=$${pr.ev.toFixed(2)}) => ${verdict}`);
  }

  // Volume verdict
  if (allProbeTrades.length > 0) {
    const volumes = allProbeTrades.map(t => t.volume).filter(v => v > 0).sort((a,b) => a-b);
    const medianVol = volumes.length > 0 ? volumes[Math.floor(volumes.length / 2)] : 0;
    const hv = aggregateTrades(allProbeTrades.filter(t => t.volume > medianVol));
    const lv = aggregateTrades(allProbeTrades.filter(t => t.volume <= medianVol && t.volume > 0));
    console.log(`\nVolume: High vol WR=${hv.wr.toFixed(1)}% EV=$${hv.ev.toFixed(2)} vs Low vol WR=${lv.wr.toFixed(1)}% EV=$${lv.ev.toFixed(2)} => ${hv.ev > lv.ev ? 'HIGH VOLUME PROBES BETTER' : 'VOLUME DOES NOT HELP'}`);
  }

  // Depth verdict
  console.log(`Depth: Shallow(10-25pt) WR=${shallowAgg.wr.toFixed(1)}% EV=$${shallowAgg.ev.toFixed(2)} vs Deep(25-50pt) WR=${deepAgg.wr.toFixed(1)}% EV=$${deepAgg.ev.toFixed(2)} => ${shallowAgg.ev > deepAgg.ev ? 'SHALLOW PROBES BETTER' : 'DEEP PROBES BETTER'}`);

  // Time verdict
  console.log(`Time: AM WR=${amAgg.wr.toFixed(1)}% EV=$${amAgg.ev.toFixed(2)} vs PM WR=${pmAgg.wr.toFixed(1)}% EV=$${pmAgg.ev.toFixed(2)} => ${amAgg.ev > pmAgg.ev ? 'AM BETTER' : 'PM BETTER'}`);

  console.log('\n' + '='.repeat(100));
  console.log('BACKTEST COMPLETE');
  console.log('='.repeat(100));

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
