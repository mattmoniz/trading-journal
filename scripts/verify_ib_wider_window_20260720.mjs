// One-off independent spot-check of the 2026-07-20 wider-window backtest's two flagged-as-risky
// rows (IB_HIGH_SHORT, IB_LOW_LONG) -- both showed large N multipliers (10-15x) between the
// RTH-only and "valid-until-superseded" windows, and docs/WIDER_WINDOW_BACKTEST_20260720.md
// explicitly says these were never independently re-verified the way CAM_R4_SHORT's RTH
// baseline was. This is that re-verification, done BEFORE any live behavior changes per the
// OPEN_DECISION wider_window_level_fade_backtest_findings_20260720.
//
// Imports the real `resolve()` from scripts/backtest_unified.js (not reimplemented) for the
// stop/target simulation. Reuses real level_prices.IB_HIGH/IB_LOW (canonical, already-computed
// values -- not recomputed by hand). The RTH-only side is cross-checked against the committed
// script's own dry-run output before trusting the wider-window side, since detectLevelFades()
// itself hardcodes an RTH-only bar filter internally and cannot be called with a wider window --
// this script's touch-detection loop mirrors its exact logic (15pt proximity, from-above/below
// direction, one-fire-per-window) but is a separate, minimal implementation for the window
// dimension specifically, since that's the one thing the real function structurally can't do.
//
// Run: node scripts/verify_ib_wider_window_20260720.mjs
import { query } from '../server/db.js';
import { resolve } from './backtest_unified.js';

const GATE = 630; // 10:30 ET, IB close -- matches LEVEL_GATES.IB_HIGH/IB_LOW in backtest_unified.js

async function main() {
  console.log('Loading level_prices (IB_HIGH/IB_LOW, canonical)...');
  const lvlRes = await query(`
    SELECT trade_date::text as d, level_name, price::float as price
    FROM level_prices WHERE level_name IN ('IB_HIGH','IB_LOW')
  `);
  const levelsByDate = new Map(); // d -> {IB_HIGH, IB_LOW}
  for (const r of lvlRes.rows) {
    if (!levelsByDate.has(r.d)) levelsByDate.set(r.d, {});
    levelsByDate.get(r.d)[r.level_name] = r.price;
  }
  const dates = [...levelsByDate.keys()].sort();
  console.log(`${dates.length} dates with IB_HIGH/IB_LOW level_prices rows.`);

  console.log('Loading ALL NQ bars (24hr, not RTH-only)...');
  const barsRes = await query(`
    SELECT ts, ts::date::text as d,
      EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)::int as tod,
      open::float, high::float, low::float, close::float
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const allBars = barsRes.rows.map(b => ({ ...b, ts: new Date(b.ts).getTime() }));
  console.log(`${allBars.length} total bars loaded.`);

  // Index: first bar index at/after tod>=GATE for each date (IB close bar), and first bar
  // index for the NEXT trading date's tod>=GATE (next IB close = window end).
  function firstIdxAtOrAfter(dateStr, todMin) {
    // binary-search-free linear scan is fine here (one-off script), find first bar on/after
    // dateStr with tod>=todMin (handles the case a date has no exact bar at that tod)
    for (let i = 0; i < allBars.length; i++) {
      if (allBars[i].d > dateStr) return i; // date has no bars at all past this point -- shouldn't happen given level_prices exists
      if (allBars[i].d === dateStr && allBars[i].tod >= todMin) return i;
    }
    return -1;
  }

  const results = { IB_HIGH_SHORT: [], IB_LOW_LONG: [] };

  for (let di = 0; di < dates.length; di++) {
    const d = dates[di];
    const lv = levelsByDate.get(d);
    if (!lv || lv.IB_HIGH == null || lv.IB_LOW == null) continue;

    const startIdx = firstIdxAtOrAfter(d, GATE);
    if (startIdx < 0 || startIdx === 0) continue;

    // Window end = first bar at/after next date's GATE (i.e. tomorrow's IB close). If no
    // later date has a bar >= GATE (end of data), window runs to the end of allBars.
    let endIdx = allBars.length;
    // find the next date strictly after d that has bars (skip weekends/holidays naturally
    // since we only look for the next actual bar row)
    for (let i = startIdx; i < allBars.length; i++) {
      if (allBars[i].d > d && allBars[i].tod >= GATE) { endIdx = i; break; }
    }

    const isMonday = new Date(d + 'T12:00:00').getDay() === 1;
    const STOP = isMonday ? 60 : 90, TARGET = isMonday ? 30 : 40;

    // IB_HIGH_SHORT: first touch of IB_HIGH from above, in [startIdx, endIdx)
    if (results.IB_HIGH_SHORT !== null) {
      for (let i = startIdx + 1; i < endIdx; i++) {
        const b = allBars[i], prev = allBars[i - 1];
        if (Math.abs(b.close - lv.IB_HIGH) > 15) continue;
        if (!(prev.close > lv.IB_HIGH)) continue; // must be approaching from above for SHORT
        const entry = b.close;
        const r = resolve(allBars, i, 'SHORT', entry, entry + STOP, entry - TARGET, 240);
        results.IB_HIGH_SHORT.push({ date: d, ...r });
        break; // one fire per window, matches detectLevelFades()'s `fired` set
      }
    }
    // IB_LOW_LONG: first touch of IB_LOW from below, in [startIdx, endIdx)
    for (let i = startIdx + 1; i < endIdx; i++) {
      const b = allBars[i], prev = allBars[i - 1];
      if (Math.abs(b.close - lv.IB_LOW) > 15) continue;
      if (!(prev.close < lv.IB_LOW)) continue; // must be approaching from below for LONG
      const entry = b.close;
      const r = resolve(allBars, i, 'LONG', entry, entry - STOP, entry + TARGET, 240);
      results.IB_LOW_LONG.push({ date: d, ...r });
      break;
    }
  }

  for (const [name, rows] of Object.entries(results)) {
    const n = rows.length;
    const wins = rows.filter(r => r.result === 'TARGET_HIT').length;
    const ev = rows.reduce((s, r) => s + r.pnl, 0) / (n || 1);
    console.log(`\n${name}: N=${n} WR=${(100 * wins / (n || 1)).toFixed(1)}% EV=$${ev.toFixed(2)}`);
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
