#!/usr/bin/env node
// Comprehensive Backtest: Setups + Level Fades + Combined Ranking + Portfolio Recommendations
// PNL_PER_POINT = 2 (MNQ), COMMISSION = $1/RT

// Suppress query logging
process.env.NODE_ENV = 'production';

import { query } from '../server/db.js';

const PNL_PER_POINT = 2;
const COMMISSION = 1;
const TODAY = new Date();
const WINDOWS = [90, 180];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function fmt(n, dec = 2) {
  if (n == null || isNaN(n)) return '--';
  return Number(n).toFixed(dec);
}

function fmtDollar(n) {
  if (n == null || isNaN(n)) return '--';
  const s = Number(n).toFixed(0);
  return n >= 0 ? `$${s}` : `-$${Math.abs(Number(s))}`;
}

function padR(s, w) { return String(s).padEnd(w); }
function padL(s, w) { return String(s).padStart(w); }

function printTable(headers, rows, colWidths) {
  const sep = colWidths.map(w => '-'.repeat(w)).join('-+-');
  console.log(headers.map((h, i) => padR(h, colWidths[i])).join(' | '));
  console.log(sep);
  rows.forEach(row => {
    console.log(row.map((c, i) => {
      const s = String(c ?? '--');
      return i === 0 ? padR(s, colWidths[i]) : padL(s, colWidths[i]);
    }).join(' | '));
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// PART 1: SETUP BACKTEST
// ═════════════════════════════════════════════════════════════════════════════

async function runSetupBacktest() {
  console.log('\n' + '='.repeat(120));
  console.log('PART 1: SETUP BACKTEST (bar-by-bar replay from active_setups)');
  console.log('='.repeat(120));

  // Load all setups with valid entry/stop/t1
  const { rows: setups } = await query(`
    SELECT id, setup_type, trade_date, fired_at, expires_at,
           entry_zone_low::float, entry_zone_high::float, stop_level::float, t1_level::float,
           resolution, status, actual_pnl::float, resolved_at
    FROM active_setups
    WHERE entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
      AND fired_at IS NOT NULL
    ORDER BY fired_at
  `);

  console.log(`\nLoaded ${setups.length} setups with valid entry/stop/t1 and fired_at`);

  // Determine direction for each setup: if stop > entry => SHORT, else LONG
  setups.forEach(s => {
    s.isLong = s.stop_level < s.entry_zone_low;
    s.entryMid = (s.entry_zone_low + s.entry_zone_high) / 2;
    s.riskPts = Math.abs(s.entryMid - s.stop_level);
    s.rewardPts = Math.abs(s.t1_level - s.entryMid);
  });

  // Batch load bars for each setup day (fired_at to end of session or expires_at)
  console.log('Replaying bars for MAE/MFE analysis...');

  const setupResults = [];

  // Process in batches by trade_date to reduce DB queries
  const byDate = {};
  setups.forEach(s => {
    const d = s.trade_date;
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(s);
  });

  const dates = Object.keys(byDate).sort();
  let processed = 0;

  for (const date of dates) {
    const daySetups = byDate[date];
    // Load RTH bars for the date (9:30 ET = 570 min, 16:00 ET = 960 min)
    const { rows: bars } = await query(`
      SELECT ts, open::float, high::float, low::float, close::float
      FROM price_bars_primary
      WHERE ts::date = $1
        AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
      ORDER BY ts
    `, [date]);

    if (bars.length === 0) continue;

    for (const setup of daySetups) {
      const firedAt = setup.fired_at;
      const expiresAt = setup.expires_at;

      // Get bars from fired_at onward
      const relevantBars = bars.filter(b => b.ts >= firedAt);
      if (relevantBars.length === 0) {
        setupResults.push({ ...setup, outcome: 'NO_BARS', mfe: 0, mae: 0, durationMin: 0 });
        continue;
      }

      let mfe = 0, mae = 0, resolved = false, outcome = null, resolvedAt = null;
      const entryPrice = setup.entryMid;

      for (const bar of relevantBars) {
        // Check expiry
        if (expiresAt && bar.ts > expiresAt) break;

        const barHigh = bar.high;
        const barLow = bar.low;

        if (setup.isLong) {
          // For longs: MFE = max(high - entry), MAE = max(entry - low)
          const excursionUp = barHigh - entryPrice;
          const excursionDown = entryPrice - barLow;
          if (excursionUp > mfe) mfe = excursionUp;
          if (excursionDown > mae) mae = excursionDown;

          // Conservative same-bar: check stop first
          if (barLow <= setup.stop_level) {
            outcome = 'STOP_HIT';
            resolvedAt = bar.ts;
            resolved = true;
            break;
          }
          if (barHigh >= setup.t1_level) {
            outcome = 'TARGET_HIT';
            resolvedAt = bar.ts;
            resolved = true;
            break;
          }
        } else {
          // For shorts: MFE = max(entry - low), MAE = max(high - entry)
          const excursionDown = entryPrice - barLow;
          const excursionUp = barHigh - entryPrice;
          if (excursionDown > mfe) mfe = excursionDown;
          if (excursionUp > mae) mae = excursionUp;

          // Conservative same-bar: check stop first
          if (barHigh >= setup.stop_level) {
            outcome = 'STOP_HIT';
            resolvedAt = bar.ts;
            resolved = true;
            break;
          }
          if (barLow <= setup.t1_level) {
            outcome = 'TARGET_HIT';
            resolvedAt = bar.ts;
            resolved = true;
            break;
          }
        }
      }

      if (!resolved) outcome = 'EXPIRED';

      const durationMin = resolvedAt
        ? Math.round((resolvedAt - firedAt) / 60000)
        : relevantBars.length;

      // PnL calculation
      let pnl = 0;
      if (outcome === 'TARGET_HIT') {
        pnl = setup.rewardPts * PNL_PER_POINT - COMMISSION;
      } else if (outcome === 'STOP_HIT') {
        pnl = -setup.riskPts * PNL_PER_POINT - COMMISSION;
      }
      // EXPIRED = 0 pnl (flat at mark)

      setupResults.push({
        ...setup,
        outcome,
        mfe,
        mae,
        durationMin,
        pnl,
        resolvedBarAt: resolvedAt
      });
    }

    processed++;
    if (processed % 50 === 0) process.stderr.write(`  ${processed}/${dates.length} dates...\r`);
  }

  console.log(`Replayed ${setupResults.length} setups across ${dates.length} trading days`);

  // Load developing_value_log for range context
  const { rows: dvlRows } = await query(`
    SELECT trade_date, session_high::float, session_low::float FROM developing_value_log
    WHERE session_high IS NOT NULL AND session_low IS NOT NULL
  `);
  const dvlMap = {};
  dvlRows.forEach(r => { dvlMap[r.trade_date] = r.session_high - r.session_low; });

  // ─── Aggregate per setup_type per window ──────────────────────────────────

  const windowResults = {};

  for (const windowDays of WINDOWS) {
    const cutoff = new Date(TODAY);
    cutoff.setDate(cutoff.getDate() - windowDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const filtered = setupResults.filter(s => s.trade_date >= cutoffStr);

    // Group by setup_type
    const byType = {};
    filtered.forEach(s => {
      if (!byType[s.setup_type]) byType[s.setup_type] = [];
      byType[s.setup_type].push(s);
    });

    const typeStats = [];

    for (const [type, trades] of Object.entries(byType)) {
      const n = trades.length;
      if (n < 5) continue;

      const wins = trades.filter(t => t.outcome === 'TARGET_HIT');
      const losses = trades.filter(t => t.outcome === 'STOP_HIT');
      const expired = trades.filter(t => t.outcome === 'EXPIRED');
      const resolved = trades.filter(t => t.outcome !== 'EXPIRED' && t.outcome !== 'NO_BARS');
      const wr = resolved.length > 0 ? wins.length / resolved.length : 0;

      const mfes = trades.map(t => t.mfe);
      const maes = trades.map(t => t.mae);
      const durations = trades.filter(t => t.durationMin > 0).map(t => t.durationMin);

      // Developing range context
      const mfePctRange = [];
      const maePctRange = [];
      trades.forEach(t => {
        const range = dvlMap[t.trade_date];
        if (range && range > 0) {
          mfePctRange.push(t.mfe / range * 100);
          maePctRange.push(t.mae / range * 100);
        }
      });

      const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
      const evPerTrade = totalPnl / n;

      // Current stop and T1 averages
      const avgStop = trades.reduce((s, t) => s + t.riskPts, 0) / n;
      const avgT1 = trades.reduce((s, t) => s + t.rewardPts, 0) / n;

      // Optimal levels from MAE/MFE
      const p75Mae = percentile(maes, 75);
      const p50Mfe = percentile(mfes, 50);
      const p90Mae = percentile(maes, 90);

      // Stop blowthrough: % of losers that MAE > defined stop
      const blowthroughs = losses.filter(t => t.mae > t.riskPts);
      const blowthroughRate = losses.length > 0 ? blowthroughs.length / losses.length : 0;

      // T1 overshoot: avg MFE of winners beyond T1
      const winOvershoots = wins.map(t => t.mfe - t.rewardPts).filter(v => v > 0);
      const avgOvershoot = winOvershoots.length > 0 ? winOvershoots.reduce((a, b) => a + b, 0) / winOvershoots.length : 0;

      // Compute optimal EV with P75 MAE as stop, P50 MFE as target
      // Re-simulate: with wider/tighter levels, which trades would flip?
      let optWins = 0, optLosses = 0, optExpired = 0;
      for (const t of trades) {
        if (t.mfe >= p50Mfe && t.mae < p75Mae) optWins++;
        else if (t.mae >= p75Mae) optLosses++;
        else optExpired++;
      }
      const optResolved = optWins + optLosses;
      const optWR = optResolved > 0 ? optWins / optResolved : 0;
      const optEV = (optWins * (p50Mfe * PNL_PER_POINT - COMMISSION) +
                     optLosses * (-p75Mae * PNL_PER_POINT - COMMISSION)) / n;

      typeStats.push({
        type, n,
        wins: wins.length, losses: losses.length, expired: expired.length,
        wr,
        avgMfe: mfes.reduce((a, b) => a + b, 0) / n,
        p25Mfe: percentile(mfes, 25),
        p50Mfe: percentile(mfes, 50),
        p75Mfe: percentile(mfes, 75),
        avgMae: maes.reduce((a, b) => a + b, 0) / n,
        p25Mae: percentile(maes, 25),
        p50Mae: percentile(maes, 50),
        p75Mae,
        p90Mae,
        avgMfePctRange: mfePctRange.length > 0 ? mfePctRange.reduce((a, b) => a + b, 0) / mfePctRange.length : null,
        avgMaePctRange: maePctRange.length > 0 ? maePctRange.reduce((a, b) => a + b, 0) / maePctRange.length : null,
        avgDuration: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
        evPerTrade,
        totalPnl,
        avgStop,
        avgT1,
        stopTight: avgStop < p75Mae ? 'YES' : 'no',
        t1Leaving: avgT1 < p50Mfe ? 'YES' : 'no',
        optStop: p75Mae,
        optTarget: p50Mfe,
        optEV,
        optWR,
        blowthroughRate,
        avgOvershoot
      });
    }

    typeStats.sort((a, b) => b.evPerTrade - a.evPerTrade);
    windowResults[windowDays] = typeStats;
  }

  // ─── Print Setup Results ──────────────────────────────────────────────────

  for (const windowDays of WINDOWS) {
    const stats = windowResults[windowDays];
    console.log(`\n${'─'.repeat(120)}`);
    console.log(`SETUP PERFORMANCE: ${windowDays}-DAY WINDOW (N >= 5)`);
    console.log('─'.repeat(120));

    if (stats.length === 0) {
      console.log('No setups with N >= 5 in this window');
      continue;
    }

    // Main performance table
    const headers1 = ['Setup Type', 'N', 'W', 'L', 'Exp', 'WR%', 'AvgMFE', 'AvgMAE', 'EV/Trade', 'TotalPnL'];
    const widths1 = [30, 5, 5, 5, 5, 7, 8, 8, 10, 10];
    const rows1 = stats.map(s => [
      s.type, s.n, s.wins, s.losses, s.expired,
      fmt(s.wr * 100, 1), fmt(s.avgMfe, 1), fmt(s.avgMae, 1),
      fmtDollar(s.evPerTrade), fmtDollar(s.totalPnl)
    ]);
    printTable(headers1, rows1, widths1);

    // MAE/MFE distribution table
    console.log(`\n  MAE/MFE Distribution (points):`);
    const headers2 = ['Setup Type', 'P25MFE', 'P50MFE', 'P75MFE', 'P25MAE', 'P50MAE', 'P75MAE', 'P90MAE', 'MFE%Rng', 'MAE%Rng'];
    const widths2 = [30, 8, 8, 8, 8, 8, 8, 8, 8, 8];
    const rows2 = stats.map(s => [
      s.type,
      fmt(s.p25Mfe, 1), fmt(s.p50Mfe, 1), fmt(s.p75Mfe, 1),
      fmt(s.p25Mae, 1), fmt(s.p50Mae, 1), fmt(s.p75Mae, 1), fmt(s.p90Mae, 1),
      s.avgMfePctRange != null ? fmt(s.avgMfePctRange, 1) + '%' : '--',
      s.avgMaePctRange != null ? fmt(s.avgMaePctRange, 1) + '%' : '--'
    ]);
    printTable(headers2, rows2, widths2);

    // Optimization table
    console.log(`\n  Stop/Target Calibration:`);
    const headers3 = ['Setup Type', 'CurStop', 'P75MAE', 'Tight?', 'CurT1', 'P50MFE', 'Leave$?', 'OptEV', 'OptWR%', 'Blowthru%', 'Overshoot', 'AvgMin'];
    const widths3 = [30, 8, 8, 7, 8, 8, 7, 8, 7, 10, 10, 7];
    const rows3 = stats.map(s => [
      s.type,
      fmt(s.avgStop, 1), fmt(s.p75Mae, 1), s.stopTight,
      fmt(s.avgT1, 1), fmt(s.p50Mfe, 1), s.t1Leaving,
      fmtDollar(s.optEV), fmt(s.optWR * 100, 1),
      fmt(s.blowthroughRate * 100, 1) + '%', fmt(s.avgOvershoot, 1) + 'pt',
      fmt(s.avgDuration, 0)
    ]);
    printTable(headers3, rows3, widths3);
  }

  // ─── Side-by-side comparison ──────────────────────────────────────────────
  console.log(`\n${'='.repeat(120)}`);
  console.log('SETUP COMPARISON: 90-DAY vs 180-DAY');
  console.log('='.repeat(120));

  const allTypes = new Set([
    ...windowResults[90].map(s => s.type),
    ...windowResults[180].map(s => s.type)
  ]);

  const compRows = [];
  for (const type of allTypes) {
    const s90 = windowResults[90].find(s => s.type === type);
    const s180 = windowResults[180].find(s => s.type === type);
    const ev90 = s90 ? s90.evPerTrade : null;
    const ev180 = s180 ? s180.evPerTrade : null;
    const diverges = (ev90 != null && ev180 != null && ((ev90 > 0 && ev180 < 0) || (ev90 < 0 && ev180 > 0)));
    compRows.push({
      type,
      n90: s90?.n ?? '--', wr90: s90 ? fmt(s90.wr * 100, 1) : '--', ev90: ev90 != null ? fmtDollar(ev90) : '--', pnl90: s90 ? fmtDollar(s90.totalPnl) : '--',
      n180: s180?.n ?? '--', wr180: s180 ? fmt(s180.wr * 100, 1) : '--', ev180: ev180 != null ? fmtDollar(ev180) : '--', pnl180: s180 ? fmtDollar(s180.totalPnl) : '--',
      diverges: diverges ? '***' : '',
      evSort: (ev90 ?? -9999) + (ev180 ?? -9999)
    });
  }

  compRows.sort((a, b) => b.evSort - a.evSort);

  const compHeaders = ['Setup Type', 'N(90)', 'WR(90)', 'EV(90)', 'PnL(90)', 'N(180)', 'WR(180)', 'EV(180)', 'PnL(180)', 'Div?'];
  const compWidths = [30, 6, 7, 10, 10, 6, 7, 10, 10, 5];
  const compTableRows = compRows.map(r => [
    r.type, r.n90, r.wr90, r.ev90, r.pnl90, r.n180, r.wr180, r.ev180, r.pnl180, r.diverges
  ]);
  printTable(compHeaders, compTableRows, compWidths);

  return { setupResults, windowResults };
}

// ═════════════════════════════════════════════════════════════════════════════
// PART 2: LEVEL FADE EDGE BACKTEST
// ═════════════════════════════════════════════════════════════════════════════

async function runLevelFadeBacktest() {
  console.log('\n\n' + '='.repeat(120));
  console.log('PART 2: LEVEL FADE EDGE BACKTEST (replay from raw bars)');
  console.log('='.repeat(120));

  const TOUCH_THRESHOLD = 10; // points within level
  const FADE_TARGET = 20;    // points
  const BREAK_TARGET = 20;   // points
  const MAX_BARS_TO_RESOLVE = 30;

  // Load PD levels from developing_value_log
  const { rows: dvlRows } = await query(`
    SELECT trade_date, poc::float, vah::float, val::float,
           session_high::float, session_low::float, session_close::float
    FROM developing_value_log
    ORDER BY trade_date
  `);

  // Load OR/IB data from acd_daily_log
  const { rows: acdRows } = await query(`
    SELECT trade_date, or_high::float, or_low::float
    FROM acd_daily_log
    ORDER BY trade_date
  `);

  // Build maps
  const dvlMap = {};
  dvlRows.forEach((r, i) => {
    dvlMap[r.trade_date] = r;
    // Also store previous day for PD levels
    if (i > 0) {
      if (!dvlMap[r.trade_date]) dvlMap[r.trade_date] = r;
      dvlMap[r.trade_date].pd_poc = dvlRows[i - 1].poc;
      dvlMap[r.trade_date].pd_vah = dvlRows[i - 1].vah;
      dvlMap[r.trade_date].pd_val = dvlRows[i - 1].val;
      dvlMap[r.trade_date].pd_high = dvlRows[i - 1].session_high;
      dvlMap[r.trade_date].pd_low = dvlRows[i - 1].session_low;
      dvlMap[r.trade_date].pd_close = dvlRows[i - 1].session_close;
    }
  });

  const acdMap = {};
  acdRows.forEach(r => { acdMap[r.trade_date] = r; });

  // Get all distinct trading dates in 180-day window
  const cutoff180 = new Date(TODAY);
  cutoff180.setDate(cutoff180.getDate() - 180);
  const cutoffStr = cutoff180.toISOString().slice(0, 10);

  const { rows: tradingDates } = await query(`
    SELECT DISTINCT ts::date as trade_date
    FROM price_bars_primary
    WHERE ts::date >= $1
      AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ORDER BY trade_date
  `, [cutoffStr]);

  console.log(`Processing ${tradingDates.length} trading days for level fade analysis...`);

  // Results storage
  const levelTouches = []; // { date, level_type, level_price, touch_time, is_first_touch, fade_result, fade_mfe, fade_mae, break_result }

  let daysProcessed = 0;

  for (const { trade_date } of tradingDates) {
    const dvl = dvlMap[trade_date];
    const acd = acdMap[trade_date];

    // Need prior day data
    if (!dvl || !dvl.pd_poc) continue;

    // Load RTH bars
    const { rows: bars } = await query(`
      SELECT ts, open::float, high::float, low::float, close::float
      FROM price_bars_primary
      WHERE ts::date = $1
        AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
      ORDER BY ts
    `, [trade_date]);

    if (bars.length < 10) continue;

    // Compute IB high/low (first 30 bars = 9:30-10:00, but IB is 9:30-10:30 = 60 bars)
    const ibBars = bars.filter(b => {
      const min = b.ts.getUTCHours() * 60 + b.ts.getUTCMinutes();
      return min < 630; // before 10:30
    });
    const ibHigh = ibBars.length > 0 ? Math.max(...ibBars.map(b => b.high)) : null;
    const ibLow = ibBars.length > 0 ? Math.min(...ibBars.map(b => b.low)) : null;

    // Compute floor pivot levels from prior day H/L/C
    const pdH = dvl.pd_high;
    const pdL = dvl.pd_low;
    const pdC = dvl.pd_close;
    let pivot = null, r1 = null, s1 = null;
    if (pdH && pdL && pdC) {
      pivot = (pdH + pdL + pdC) / 3;
      r1 = 2 * pivot - pdL;
      s1 = 2 * pivot - pdH;
    }

    // Define levels to test (with direction: fade means price moves away from the level)
    const levels = [];
    if (dvl.pd_poc) levels.push({ type: 'PD_POC', price: dvl.pd_poc, fadeDir: 'both' });
    if (dvl.pd_vah) levels.push({ type: 'PD_VAH', price: dvl.pd_vah, fadeDir: 'short' }); // fade = short from above
    if (dvl.pd_val) levels.push({ type: 'PD_VAL', price: dvl.pd_val, fadeDir: 'long' });  // fade = long from below
    if (acd && acd.or_high) levels.push({ type: 'OR_HIGH', price: acd.or_high, fadeDir: 'short' });
    if (acd && acd.or_low) levels.push({ type: 'OR_LOW', price: acd.or_low, fadeDir: 'long' });
    if (ibHigh) levels.push({ type: 'IB_HIGH', price: ibHigh, fadeDir: 'short' });
    if (ibLow) levels.push({ type: 'IB_LOW', price: ibLow, fadeDir: 'long' });
    if (pivot) levels.push({ type: 'FLOOR_PIVOT', price: pivot, fadeDir: 'both' });
    if (r1) levels.push({ type: 'FLOOR_R1', price: r1, fadeDir: 'short' });
    if (s1) levels.push({ type: 'FLOOR_S1', price: s1, fadeDir: 'long' });

    // Track first touch per level type per day
    const touchedThisDay = {};

    // Scan bars after IB close (bar index 60+) for level touches
    const postIbBars = bars.filter(b => {
      const min = b.ts.getUTCHours() * 60 + b.ts.getUTCMinutes();
      return min >= 630; // after 10:30
    });

    for (let i = 0; i < postIbBars.length; i++) {
      const bar = postIbBars[i];
      const barMin = bar.ts.getUTCHours() * 60 + bar.ts.getUTCMinutes();
      const todBucket = barMin < 690 ? 'MORNING' : barMin < 780 ? 'MIDDAY' : 'AFTERNOON';

      for (const level of levels) {
        // Check if bar touches the level (within threshold)
        const touchesFromAbove = bar.low <= level.price + TOUCH_THRESHOLD && bar.high >= level.price;
        const touchesFromBelow = bar.high >= level.price - TOUCH_THRESHOLD && bar.low <= level.price;

        if (!touchesFromAbove && !touchesFromBelow) continue;

        const isFirstTouch = !touchedThisDay[level.type];
        touchedThisDay[level.type] = true;

        // Determine fade direction based on where price approached from
        let fadeIsShort;
        if (level.fadeDir === 'short') fadeIsShort = true;
        else if (level.fadeDir === 'long') fadeIsShort = false;
        else {
          // 'both' - determine from approach direction
          fadeIsShort = bar.close > level.price; // if closing above, fade is short
        }

        // Track forward bars for fade/break
        const forwardBars = postIbBars.slice(i + 1, i + 1 + MAX_BARS_TO_RESOLVE);
        let fadeMfe = 0, fadeMae = 0, faded = false, broke = false;
        let fadeResolvedBars = 0;

        for (let j = 0; j < forwardBars.length; j++) {
          const fb = forwardBars[j];
          fadeResolvedBars = j + 1;

          if (fadeIsShort) {
            // Fade = price drops from level; MFE = max drop, MAE = max rise
            const drop = level.price - fb.low;
            const rise = fb.high - level.price;
            if (drop > fadeMfe) fadeMfe = drop;
            if (rise > fadeMae) fadeMae = rise;
            if (drop >= FADE_TARGET) { faded = true; break; }
            if (rise >= BREAK_TARGET) { broke = true; break; }
          } else {
            // Fade = price rises from level; MFE = max rise, MAE = max drop
            const rise = fb.high - level.price;
            const drop = level.price - fb.low;
            if (rise > fadeMfe) fadeMfe = rise;
            if (drop > fadeMae) fadeMae = drop;
            if (rise >= FADE_TARGET) { faded = true; break; }
            if (drop >= BREAK_TARGET) { broke = true; break; }
          }
        }

        levelTouches.push({
          date: trade_date,
          levelType: level.type,
          levelPrice: level.price,
          touchTime: bar.ts,
          todBucket,
          isFirstTouch,
          fadeIsShort,
          faded,
          broke,
          fadeMfe,
          fadeMae,
          fadeResolvedBars,
          // PnL: if faded, profit = FADE_TARGET * PNL_PER_POINT - COMMISSION
          pnl: faded ? (FADE_TARGET * PNL_PER_POINT - COMMISSION)
             : broke ? (-BREAK_TARGET * PNL_PER_POINT - COMMISSION)
             : 0
        });
      }
    }

    daysProcessed++;
    if (daysProcessed % 10 === 0) process.stderr.write(`  ${daysProcessed}/${tradingDates.length} days...\r`);
  }

  console.log(`Found ${levelTouches.length} level touches across ${daysProcessed} days`);

  // ─── Aggregate level fade stats per window ────────────────────────────────

  const levelWindowResults = {};

  for (const windowDays of WINDOWS) {
    const cutoff = new Date(TODAY);
    cutoff.setDate(cutoff.getDate() - windowDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const filtered = levelTouches.filter(t => t.date >= cutoffStr);

    // Group by level type
    const byLevel = {};
    filtered.forEach(t => {
      if (!byLevel[t.levelType]) byLevel[t.levelType] = [];
      byLevel[t.levelType].push(t);
    });

    const levelStats = [];

    for (const [type, touches] of Object.entries(byLevel)) {
      const n = touches.length;
      if (n < 5) continue;

      const faded = touches.filter(t => t.faded);
      const broke = touches.filter(t => t.broke);
      const resolved = faded.length + broke.length;
      const fadeWR = resolved > 0 ? faded.length / resolved : 0;

      const mfes = touches.map(t => t.fadeMfe);
      const maes = touches.map(t => t.fadeMae);

      const totalPnl = touches.reduce((s, t) => s + t.pnl, 0);
      const evPerTrade = totalPnl / n;

      // Time of day breakdown
      const todBuckets = {};
      touches.forEach(t => {
        if (!todBuckets[t.todBucket]) todBuckets[t.todBucket] = { faded: 0, broke: 0, total: 0 };
        todBuckets[t.todBucket].total++;
        if (t.faded) todBuckets[t.todBucket].faded++;
        if (t.broke) todBuckets[t.todBucket].broke++;
      });

      let bestTod = '--';
      let bestTodWR = 0;
      for (const [tod, stats] of Object.entries(todBuckets)) {
        const resolved = stats.faded + stats.broke;
        const wr = resolved > 0 ? stats.faded / resolved : 0;
        if (wr > bestTodWR && resolved >= 3) {
          bestTodWR = wr;
          bestTod = `${tod}(${fmt(wr * 100, 0)}%)`;
        }
      }

      // First touch vs retest
      const firsts = touches.filter(t => t.isFirstTouch);
      const retests = touches.filter(t => !t.isFirstTouch);
      const firstFadeWR = firsts.filter(t => t.faded).length / (firsts.filter(t => t.faded || t.broke).length || 1);
      const retestFadeWR = retests.filter(t => t.faded).length / (retests.filter(t => t.faded || t.broke).length || 1);

      levelStats.push({
        type: `FADE_${type}`,
        levelType: type,
        n, faded: faded.length, broke: broke.length,
        unresolved: n - resolved,
        fadeWR,
        avgMfe: mfes.reduce((a, b) => a + b, 0) / n,
        p50Mfe: percentile(mfes, 50),
        p75Mfe: percentile(mfes, 75),
        avgMae: maes.reduce((a, b) => a + b, 0) / n,
        p50Mae: percentile(maes, 50),
        p75Mae: percentile(maes, 75),
        evPerTrade,
        totalPnl,
        bestTod,
        firstN: firsts.length,
        firstWR: fmt(firstFadeWR * 100, 1),
        retestN: retests.length,
        retestWR: fmt(retestFadeWR * 100, 1)
      });
    }

    levelStats.sort((a, b) => b.evPerTrade - a.evPerTrade);
    levelWindowResults[windowDays] = levelStats;
  }

  // ─── Print Level Fade Results ─────────────────────────────────────────────

  for (const windowDays of WINDOWS) {
    const stats = levelWindowResults[windowDays];
    console.log(`\n${'─'.repeat(120)}`);
    console.log(`LEVEL FADE PERFORMANCE: ${windowDays}-DAY WINDOW (10pt touch, 20pt fade/break targets, 30-bar window)`);
    console.log('─'.repeat(120));

    if (stats.length === 0) {
      console.log('No level types with N >= 5');
      continue;
    }

    const headers = ['Level Fade', 'N', 'Faded', 'Broke', 'Unres', 'FadeWR%', 'AvgMFE', 'P50MFE', 'AvgMAE', 'P50MAE', 'EV/Trade', 'TotalPnL'];
    const widths = [20, 5, 6, 6, 6, 8, 8, 8, 8, 8, 10, 10];
    const rows = stats.map(s => [
      s.type, s.n, s.faded, s.broke, s.unresolved,
      fmt(s.fadeWR * 100, 1), fmt(s.avgMfe, 1), fmt(s.p50Mfe, 1),
      fmt(s.avgMae, 1), fmt(s.p50Mae, 1),
      fmtDollar(s.evPerTrade), fmtDollar(s.totalPnl)
    ]);
    printTable(headers, rows, widths);

    // Time of day and first touch
    console.log(`\n  Time-of-Day & First Touch Analysis:`);
    const headers2 = ['Level Fade', 'BestToD', '1stN', '1stWR%', 'RetestN', 'RetestWR%'];
    const widths2 = [20, 20, 6, 8, 8, 9];
    const rows2 = stats.map(s => [
      s.type, s.bestTod, s.firstN, s.firstWR, s.retestN, s.retestWR
    ]);
    printTable(headers2, rows2, widths2);
  }

  return { levelTouches, levelWindowResults };
}

// ═════════════════════════════════════════════════════════════════════════════
// PART 3 & 4: COMBINED RANKING + PORTFOLIO RECOMMENDATIONS
// ═════════════════════════════════════════════════════════════════════════════

function printCombinedRanking(setupWindowResults, levelWindowResults) {
  console.log('\n\n' + '='.repeat(120));
  console.log('PART 3: COMBINED EDGE RANKING (Setups + Level Fades)');
  console.log('='.repeat(120));

  // Merge all signals for each window
  const combined = {};
  for (const windowDays of WINDOWS) {
    combined[windowDays] = [];

    // Add setups
    for (const s of (setupWindowResults[windowDays] || [])) {
      combined[windowDays].push({
        signal: s.type,
        category: 'SETUP',
        n: s.n,
        wr: s.wr,
        evPerTrade: s.evPerTrade,
        totalPnl: s.totalPnl
      });
    }

    // Add level fades
    for (const l of (levelWindowResults[windowDays] || [])) {
      combined[windowDays].push({
        signal: l.type,
        category: 'LEVEL_FADE',
        n: l.n,
        wr: l.fadeWR,
        evPerTrade: l.evPerTrade,
        totalPnl: l.totalPnl
      });
    }
  }

  // Build lookup maps
  const map90 = {};
  const map180 = {};
  (combined[90] || []).forEach(s => { map90[s.signal] = s; });
  (combined[180] || []).forEach(s => { map180[s.signal] = s; });
  const allSignals = new Set([...Object.keys(map90), ...Object.keys(map180)]);

  // Top 15 by EV/trade
  console.log('\n--- TOP 15 BY EV/TRADE (side-by-side) ---');
  const evRows = [];
  for (const sig of allSignals) {
    const s90 = map90[sig];
    const s180 = map180[sig];
    const ev90 = s90?.evPerTrade ?? null;
    const ev180 = s180?.evPerTrade ?? null;
    const avgEV = ((ev90 ?? 0) + (ev180 ?? 0)) / (((ev90 != null) ? 1 : 0) + ((ev180 != null) ? 1 : 0) || 1);
    const diverges = (ev90 != null && ev180 != null && ((ev90 > 0 && ev180 < 0) || (ev90 < 0 && ev180 > 0)));
    evRows.push({ sig, cat: s90?.category ?? s180?.category, ev90, ev180, avgEV, diverges,
      n90: s90?.n, n180: s180?.n, wr90: s90?.wr, wr180: s180?.wr,
      pnl90: s90?.totalPnl, pnl180: s180?.totalPnl });
  }
  evRows.sort((a, b) => b.avgEV - a.avgEV);

  const evHeaders = ['Signal', 'Category', 'N(90)', 'WR(90)', 'EV(90)', 'N(180)', 'WR(180)', 'EV(180)', 'Diverge?'];
  const evWidths = [30, 12, 6, 7, 10, 6, 7, 10, 8];
  const evTableRows = evRows.slice(0, 15).map(r => [
    r.sig, r.cat,
    r.n90 ?? '--', r.wr90 != null ? fmt(r.wr90 * 100, 1) : '--', r.ev90 != null ? fmtDollar(r.ev90) : '--',
    r.n180 ?? '--', r.wr180 != null ? fmt(r.wr180 * 100, 1) : '--', r.ev180 != null ? fmtDollar(r.ev180) : '--',
    r.diverges ? '***' : ''
  ]);
  printTable(evHeaders, evTableRows, evWidths);

  // Top 15 by total PnL
  console.log('\n--- TOP 15 BY TOTAL PNL (side-by-side) ---');
  const pnlRows = [...evRows];
  pnlRows.sort((a, b) => ((b.pnl180 ?? 0) + (b.pnl90 ?? 0)) - ((a.pnl180 ?? 0) + (a.pnl90 ?? 0)));

  const pnlHeaders = ['Signal', 'Category', 'PnL(90)', 'EV(90)', 'PnL(180)', 'EV(180)', 'Diverge?'];
  const pnlWidths = [30, 12, 10, 10, 10, 10, 8];
  const pnlTableRows = pnlRows.slice(0, 15).map(r => [
    r.sig, r.cat,
    r.pnl90 != null ? fmtDollar(r.pnl90) : '--', r.ev90 != null ? fmtDollar(r.ev90) : '--',
    r.pnl180 != null ? fmtDollar(r.pnl180) : '--', r.ev180 != null ? fmtDollar(r.ev180) : '--',
    r.diverges ? '***' : ''
  ]);
  printTable(pnlHeaders, pnlTableRows, pnlWidths);

  // Regime-sensitive (divergent between windows)
  const divergent = evRows.filter(r => r.diverges);
  if (divergent.length > 0) {
    console.log('\n--- REGIME-SENSITIVE SIGNALS (positive in one window, negative in the other) ---');
    const divHeaders = ['Signal', 'Category', 'EV(90)', 'EV(180)', 'Direction'];
    const divWidths = [30, 12, 10, 10, 30];
    const divTableRows = divergent.map(r => [
      r.sig, r.cat,
      r.ev90 != null ? fmtDollar(r.ev90) : '--',
      r.ev180 != null ? fmtDollar(r.ev180) : '--',
      (r.ev90 > 0 && r.ev180 < 0) ? '+EV recently, -EV longer term' : '-EV recently, +EV longer term'
    ]);
    printTable(divHeaders, divTableRows, divWidths);
  } else {
    console.log('\n--- No regime-sensitive signals detected (all consistent between windows) ---');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PART 4: PORTFOLIO RECOMMENDATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('\n\n' + '='.repeat(120));
  console.log('PART 4: RECOMMENDED PORTFOLIO');
  console.log('='.repeat(120));

  const active = [], shadow = [], remove = [];

  for (const row of evRows) {
    const ev90 = row.ev90;
    const ev180 = row.ev180;

    if (ev90 != null && ev90 > 0 && ev180 != null && ev180 > 0) {
      active.push(row);
    } else if ((ev90 != null && ev90 > 0) || (ev180 != null && ev180 > 0)) {
      shadow.push(row);
    } else {
      remove.push(row);
    }
  }

  console.log('\n--- ACTIVE: Positive EV in BOTH windows ---');
  if (active.length === 0) {
    console.log('  (none)');
  } else {
    active.sort((a, b) => b.avgEV - a.avgEV);
    for (const r of active) {
      console.log(`  ${padR(r.sig, 30)} [${r.cat}]  EV(90d): ${r.ev90 != null ? fmtDollar(r.ev90) : '--'}  EV(180d): ${r.ev180 != null ? fmtDollar(r.ev180) : '--'}  N(90/180): ${r.n90 ?? '--'}/${r.n180 ?? '--'}`);
    }
  }

  console.log('\n--- SHADOW: Positive in ONE window only (monitor) ---');
  if (shadow.length === 0) {
    console.log('  (none)');
  } else {
    shadow.sort((a, b) => b.avgEV - a.avgEV);
    for (const r of shadow) {
      const which = (r.ev90 != null && r.ev90 > 0) ? '90d positive' : '180d positive';
      console.log(`  ${padR(r.sig, 30)} [${r.cat}]  EV(90d): ${r.ev90 != null ? fmtDollar(r.ev90) : '--'}  EV(180d): ${r.ev180 != null ? fmtDollar(r.ev180) : '--'}  (${which})`);
    }
  }

  console.log('\n--- REMOVE: Negative EV in BOTH windows ---');
  if (remove.length === 0) {
    console.log('  (none)');
  } else {
    remove.sort((a, b) => a.avgEV - b.avgEV);
    for (const r of remove) {
      console.log(`  ${padR(r.sig, 30)} [${r.cat}]  EV(90d): ${r.ev90 != null ? fmtDollar(r.ev90) : '--'}  EV(180d): ${r.ev180 != null ? fmtDollar(r.ev180) : '--'}`);
    }
  }

  // Stop/Target recalibration for active setups
  console.log('\n--- STOP/TARGET RECALIBRATION FOR ACTIVE SETUPS ---');
  for (const r of active) {
    if (r.cat !== 'SETUP') continue;
    // Find detailed stats from setup window results
    const s90 = setupWindowResults[90]?.find(s => s.type === r.sig);
    const s180 = setupWindowResults[180]?.find(s => s.type === r.sig);
    const s = s90 || s180;
    if (!s) continue;
    console.log(`\n  ${s.type}:`);
    console.log(`    Current Stop: ${fmt(s.avgStop, 1)}pt  |  P75 MAE: ${fmt(s.p75Mae, 1)}pt  |  ${s.stopTight === 'YES' ? 'STOP TOO TIGHT - widen to ' + fmt(s.p75Mae, 1) + 'pt' : 'Stop OK'}`);
    console.log(`    Current T1:   ${fmt(s.avgT1, 1)}pt  |  P50 MFE: ${fmt(s.p50Mfe, 1)}pt  |  ${s.t1Leaving === 'YES' ? 'LEAVING MONEY - consider ' + fmt(s.p50Mfe, 1) + 'pt' : 'T1 OK'}`);
    console.log(`    Stop blowthrough: ${fmt(s.blowthroughRate * 100, 1)}%  |  Winner overshoot: ${fmt(s.avgOvershoot, 1)}pt`);
    console.log(`    Current EV: ${fmtDollar(s.evPerTrade)}/trade  |  Optimized EV: ${fmtDollar(s.optEV)}/trade (WR: ${fmt(s.optWR * 100, 1)}%)`);
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('='.repeat(120));
  console.log('COMPREHENSIVE BACKTEST REPORT');
  console.log(`Generated: ${new Date().toISOString().slice(0, 16)} | PNL_PER_POINT: ${PNL_PER_POINT} | COMMISSION: $${COMMISSION}/RT`);
  console.log('='.repeat(120));

  const { setupResults, windowResults: setupWindowResults } = await runSetupBacktest();
  const { levelTouches, levelWindowResults } = await runLevelFadeBacktest();
  printCombinedRanking(setupWindowResults, levelWindowResults);

  console.log('\n' + '='.repeat(120));
  console.log('END OF REPORT');
  console.log('='.repeat(120));

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
