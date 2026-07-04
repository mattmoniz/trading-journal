// backtest_level_approach.js
// ═══════════════════════════════════════════════════════════════════════
// For each level, compute historical touch rate + conditional EV broken
// down by (day_type, day_of_week). Output to performance_audit with
// signal_type='LEVEL_APPROACH' so the morning brief can surface "which
// levels are statistically likely to be tested today."
//
// Touch = price came within 15pt of the level during RTH.
// Conditional EV = EV from UNIFIED_BACKTEST for that level (best available).
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const PROXIMITY   = 15;   // touch threshold (pts)
const WINDOW_DAYS = 252;  // ~1 trading year
const MIN_SAMPLE  = 10;   // minimum touches to report

const DOW_LABEL = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

async function run() {
  console.log('Loading data...');

  // 1. Trading days with level_prices + day_type + bars
  const daysRes = await query(`
    SELECT lp.trade_date::text as trade_date,
           EXTRACT(dow FROM lp.trade_date)::int as dow,
           a.day_type
    FROM level_prices lp
    JOIN acd_daily_log a ON a.trade_date = lp.trade_date AND a.day_type IS NOT NULL
    WHERE lp.trade_date <= CURRENT_DATE - INTERVAL '1 day'
      AND EXISTS (
        SELECT 1 FROM price_bars_primary p
        WHERE p.ts::date = lp.trade_date
          AND EXTRACT(hour FROM p.ts)*60+EXTRACT(minute FROM p.ts) BETWEEN 570 AND 959
      )
    GROUP BY lp.trade_date, a.day_type
    HAVING COUNT(DISTINCT lp.level_name) >= 5
    ORDER BY lp.trade_date DESC
    LIMIT $1
  `, [WINDOW_DAYS]);

  const days = daysRes.rows;
  if (!days.length) { console.error('No qualifying days found'); process.exit(1); }
  console.log(`  ${days.length} days with day_type`);

  const firstDate = days[days.length - 1].trade_date;
  const lastDate  = days[0].trade_date;

  // 2. Bulk load level_prices
  const lpRes = await query(`
    SELECT trade_date::text, level_name, price::float
    FROM level_prices
    WHERE trade_date >= $1 AND trade_date <= $2 AND price IS NOT NULL
  `, [firstDate, lastDate]);
  const lpByDate = new Map();
  for (const r of lpRes.rows) {
    if (!lpByDate.has(r.trade_date)) lpByDate.set(r.trade_date, {});
    lpByDate.get(r.trade_date)[r.level_name] = r.price;
  }

  // 3. Bulk load RTH bar ranges per day (just high/low — touch detection only)
  const barsRes = await query(`
    SELECT ts::date::text as trade_date,
           MAX(high)::float as day_high, MIN(low)::float as day_low
    FROM price_bars_primary
    WHERE ts::date >= $1 AND ts::date <= $2
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    GROUP BY ts::date
  `, [firstDate, lastDate]);
  const barsByDate = new Map();
  for (const r of barsRes.rows) barsByDate.set(r.trade_date, r);

  // 4. Load best available EV per level from performance_audit (UNIFIED_BACKTEST preferred)
  const evRes = await query(`
    SELECT DISTINCT ON (signal_name)
      signal_name, ev_per_trade, win_rate, sample_size
    FROM performance_audit
    WHERE signal_type IN ('UNIFIED_BACKTEST','LEVEL_FADE_AUDIT','PD_IB_AUDIT')
      AND ev_per_trade IS NOT NULL
    ORDER BY signal_name,
      CASE signal_type WHEN 'UNIFIED_BACKTEST' THEN 0 WHEN 'LEVEL_FADE_AUDIT' THEN 1 ELSE 2 END,
      run_date DESC
  `);
  const evByLevel = new Map();
  for (const r of evRes.rows) {
    // Strip direction suffix to get base level name
    const base = r.signal_name.replace(/_FADE_(LONG|SHORT)$/, '').replace(/_FADE$/, '').replace(/_(LONG|SHORT)$/, '');
    if (!evByLevel.has(base) || (r.ev_per_trade > (evByLevel.get(base).ev || -999))) {
      evByLevel.set(base, { ev: parseFloat(r.ev_per_trade), wr: parseFloat(r.win_rate), n: r.sample_size });
    }
  }
  console.log(`  EV data for ${evByLevel.size} levels`);

  // 5. Count touches per (level, contextKey) in one pass.
  // contextKey = `${day_type}|${dowLabel}`, plus ALL|ALL / TYPE|ALL / ALL|DOW rollups.
  // stats[levelName][contextKey] = { days, touches }
  const stats = {};

  const inc = (levelName, ctxKey, touched) => {
    if (!stats[levelName]) stats[levelName] = {};
    if (!stats[levelName][ctxKey]) stats[levelName][ctxKey] = { days: 0, touches: 0 };
    stats[levelName][ctxKey].days++;
    if (touched) stats[levelName][ctxKey].touches++;
  };

  for (const day of days) {
    const { trade_date, dow, day_type } = day;
    const lp = lpByDate.get(trade_date);
    const bar = barsByDate.get(trade_date);
    if (!lp || !bar) continue;
    const dowLabel = DOW_LABEL[dow];

    for (const [levelName, price] of Object.entries(lp)) {
      if (levelName === 'RTH_VWAP') continue;
      const touched = bar.day_low <= price + PROXIMITY && bar.day_high >= price - PROXIMITY;

      inc(levelName, `${day_type}|${dowLabel}`, touched); // e.g. BALANCE|TUE
      inc(levelName, `${day_type}|ALL`,          touched); // e.g. BALANCE|ALL
      inc(levelName, `ALL|${dowLabel}`,           touched); // e.g. ALL|TUE
      inc(levelName, 'ALL|ALL',                   touched); // overall
    }
  }

  // Helper to look up a context bucket
  const getCounts = (levelStats, day_type, dowLabel) => levelStats[`${day_type}|${dowLabel}`];

  // 7. Write to performance_audit
  const runDate = new Date().toISOString().slice(0, 10);
  await query(`DELETE FROM performance_audit WHERE signal_type='LEVEL_APPROACH' AND run_date=$1`, [runDate]);

  let rowsWritten = 0;
  for (const [levelName, ctxMap] of Object.entries(stats)) {
    const evInfo = evByLevel.get(levelName);
    for (const [ctxKey, counts] of Object.entries(ctxMap)) {
      if (counts.days < MIN_SAMPLE) continue;
      const touchRate = counts.touches / counts.days;
      const [day_type, dowLabel] = ctxKey.split('|');
      // signal_name encodes context: e.g. "IB_MID|BALANCE|TUE"
      const signalName = `${levelName}|${ctxKey}`;

      await query(`
        INSERT INTO performance_audit
          (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, notes)
        VALUES ($1, $2, 'LEVEL_APPROACH', $3, $4, $5, $6, $7)
        ON CONFLICT (run_date, window_days, signal_type, signal_name)
        DO UPDATE SET sample_size=$4, win_rate=$5, ev_per_trade=$6, notes=$7
      `, [
        runDate,
        WINDOW_DAYS,
        signalName,
        counts.days,
        touchRate,
        evInfo?.ev ?? null,
        JSON.stringify({ level: levelName, day_type, dow: dowLabel, touches: counts.touches }),
      ]);
      rowsWritten++;
    }
  }

  console.log(`\nWrote ${rowsWritten} rows to performance_audit (signal_type=LEVEL_APPROACH)`);

  // Helper to build ranked rows for a given context key
  const rankRows = (ctxKey) => {
    const rows = [];
    for (const [levelName, ctxMap] of Object.entries(stats)) {
      const counts = getCounts(ctxMap, ctxKey.split('|')[0], ctxKey.split('|')[1]);
      if (!counts || counts.days < MIN_SAMPLE) continue;
      const evInfo = evByLevel.get(levelName);
      const touchRate = counts.touches / counts.days;
      const expectedEV = evInfo?.ev != null ? touchRate * evInfo.ev : null;
      rows.push({ levelName, touchRate, ev: evInfo?.ev ?? null, expectedEV, n: counts.days, touches: counts.touches });
    }
    rows.sort((a, b) => (b.expectedEV ?? -999) - (a.expectedEV ?? -999));
    return rows;
  };

  // 8. Print top levels overall sorted by touch_rate × EV
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('TOP LEVELS BY APPROACH PROBABILITY × EV (all days)');
  console.log('═══════════════════════════════════════════════════════════════');
  const overallRows = rankRows('ALL|ALL');
  console.log(`  ${'Level'.padEnd(20)} ${'Touch%'.padStart(7)} ${'Cond.EV'.padStart(9)} ${'Exp.EV'.padStart(9)} ${'N Days'.padStart(7)}`);
  console.log(`  ${'─'.repeat(20)} ${'─'.repeat(7)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(7)}`);
  for (const r of overallRows.slice(0, 20)) {
    console.log(`  ${r.levelName.padEnd(20)} ${(r.touchRate * 100).toFixed(1).padStart(6)}% ${r.ev != null ? ('$'+r.ev.toFixed(0)).padStart(9) : '     N/A'} ${r.expectedEV != null ? ('$'+r.expectedEV.toFixed(0)).padStart(9) : '     N/A'} ${String(r.n).padStart(7)}`);
  }

  // 9. Print by day_type
  for (const dt of ['BALANCE', 'TREND', 'TURBULENT']) {
    const rows = rankRows(`${dt}|ALL`);
    const nDays = rows[0]?.n ?? 0;
    console.log(`\n  ── ${dt} days (top 10, N sessions: ${nDays}) ──`);
    if (!rows.length) { console.log('    (no data meeting MIN_SAMPLE threshold)'); continue; }
    for (const r of rows.slice(0, 10)) {
      console.log(`    ${r.levelName.padEnd(20)} ${(r.touchRate * 100).toFixed(1).padStart(6)}% touch   ${r.ev != null ? ('EV $'+r.ev.toFixed(0)).padStart(10) : '      N/A'}   N=${r.n}`);
    }
  }
}

run().then(() => {
  console.log('\nDone.');
  process.exit(0);
}).catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
