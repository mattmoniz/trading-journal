// Stage 1 (research/backtest only, nothing live touched): empirical study of how price
// actually approaches each level, to replace the entry-price-realism bug found tonight
// (assuming a fill at the exact stored level price, regardless of whether the touch bar's
// own open/close ever traded there) with a real, data-derived entry tolerance per level.
//
// Core question: when a "touch" is detected (existing live convention: bar range overlaps
// level +/- 15pt), how far was price ACTUALLY from the level at a realistic decision point
// (the touch bar's own open -- the price you'd have seen before that bar's outcome was
// known)? The distribution of that distance, per level type, is the honest basis for a
// tolerance zone -- not a blanket 15pt guess and not the naive "assume you got filled
// exactly at the level" assumption.
//
// This is Stage 1 only (pure geometry -- how far price actually is from the level at a
// realistic decision point, no volume/EV yet). Stage 2 (cross-reference against
// server/services/touchQuality.js's existing z-score volume-spike classification, and an
// EV comparison via scripts/update_optimal_stops.mjs's sweepOptimalStopAndTarget) is a
// deliberate follow-on, not done in this script -- keeping this pass narrowly scoped to
// what was actually asked for and confirmed before expanding.
import { query } from '../server/db.js';
import fs from 'fs';

const TOUCH_WINDOW = 15; // matches acd.js's existing nearLevels convention
const REACTION_BARS = 5; // bars examined after touch for the volume-spike cross-reference

// Level types with real, audited historical price data (from level_prices, full ~2.5yr
// coverage) -- a representative cross-section spanning different "families" (prior-day,
// prior-week, floor pivots, camarilla, overnight) rather than all 60+, to keep this a
// tractable first pass. Each of these is a real, live-consumed level (not one of tonight's
// never-fired thin ones) so the approach-distance distribution reflects genuine trading
// history, not a synthetic backtest artifact layered on top of another one.
const LEVELS_TO_STUDY = [
  'PD_VAH', 'PD_VAL', 'PD_POC', 'PD_HIGH', 'PD_LOW',
  'FLOOR_PIVOT', 'FLOOR_R1', 'FLOOR_S1',
  'CAM_R1', 'CAM_S1', 'CAM_R4', 'CAM_S4',
  'WPP', 'WR1', 'WS1',
  'ONH', 'ONL',
];

async function main() {
  const datesRes = await query(`
    SELECT DISTINCT trade_date::text AS td FROM acd_daily_log
    WHERE trade_date <= '2026-07-16' AND trade_date >= '2024-01-01' ORDER BY td ASC
  `);
  const dates = datesRes.rows.map(r => r.td);
  console.log(`Studying ${LEVELS_TO_STUDY.length} level types across ${dates.length} dates...`);

  const lpRes = await query(`
    SELECT trade_date::text as td, level_name, price::float as price
    FROM level_prices WHERE level_name = ANY($1)
  `, [LEVELS_TO_STUDY]);
  const lpByDate = {};
  for (const row of lpRes.rows) (lpByDate[row.td] ||= {})[row.level_name] = row.price;

  const approaches = []; // one row per (level, date) touch event
  let dateN = 0;
  for (const date of dates) {
    dateN++;
    if (dateN % 100 === 0) console.log(`  ...${dateN}/${dates.length} dates`);

    const levelsToday = LEVELS_TO_STUDY.filter(n => lpByDate[date]?.[n] != null)
      .map(n => ({ name: n, val: lpByDate[date][n] }));
    if (levelsToday.length === 0) continue;

    const barsRes = await query(`
      SELECT ts, open::float, high::float, low::float, close::float,
        COALESCE(bid_volume,0)::int as bid_volume, COALESCE(ask_volume,0)::int as ask_volume,
        (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as mod
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date = $1 AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
      ORDER BY ts
    `, [date]);
    const bars = barsRes.rows;
    if (bars.length === 0) continue;

    const touched = new Set();
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      for (const lv of levelsToday) {
        if (touched.has(lv.name)) continue;
        if (bar.low <= lv.val + TOUCH_WINDOW && bar.high >= lv.val - TOUCH_WINDOW) {
          touched.add(lv.name);
          const isLong = bar.open > lv.val; // approaching from above -> fade LONG
          // Realistic reference distance: how far was price from the level at the bar's
          // OWN OPEN (before this bar's outcome was knowable) -- signed so positive means
          // "already past the level at bar open" (a gap-through) and negative means "still
          // approaching, hadn't reached the level yet at bar open."
          const barOpenDist = isLong ? (bar.open - lv.val) : (lv.val - bar.open);
          // Did price actually trade AT the level within this bar (not just come within
          // the 15pt window)? true cross vs. "close but didn't quite reach it."
          const actuallyReachedLevel = bar.low <= lv.val && bar.high >= lv.val;
          // How far past the level did price go within the touch bar itself (the real,
          // bar-open-referenced adverse excursion for THIS bar only)?
          const barOwnAdverse = isLong ? Math.max(0, bar.open - bar.low) : Math.max(0, bar.high - bar.open);

          approaches.push({
            level: lv.name, date, isLong, barOpenDist, actuallyReachedLevel, barOwnAdverse,
          });
        }
      }
    }
  }

  console.log(`Found ${approaches.length} touch events across ${LEVELS_TO_STUDY.length} level types.`);

  // Per-level-type percentiles of |barOpenDist| -- the honest basis for a tolerance zone.
  const byLevel = {};
  for (const a of approaches) (byLevel[a.level] ||= []).push(a);

  const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

  const results = {};
  for (const [level, rows] of Object.entries(byLevel)) {
    const n = rows.length;
    const absDist = rows.map(r => Math.abs(r.barOpenDist)).sort((a, b) => a - b);
    const crossRate = rows.filter(r => r.actuallyReachedLevel).length / n;
    const ownAdverseSorted = rows.map(r => r.barOwnAdverse).sort((a, b) => a - b);

    results[level] = {
      n,
      crossRate: Math.round(crossRate * 1000) / 1000,
      barOpenDist_p25: pct(absDist, 0.25),
      barOpenDist_p50: pct(absDist, 0.50),
      barOpenDist_p75: pct(absDist, 0.75),
      barOpenDist_p90: pct(absDist, 0.90),
      barOwnAdverse_p50: pct(ownAdverseSorted, 0.50),
      barOwnAdverse_p75: pct(ownAdverseSorted, 0.75),
      barOwnAdverse_p90: pct(ownAdverseSorted, 0.90),
    };
  }

  fs.writeFileSync('scratch/level_approach_tolerance_results.json', JSON.stringify(results, null, 2));
  console.log('\nWrote scratch/level_approach_tolerance_results.json\n');
  console.log('LEVEL'.padEnd(14), 'N'.padStart(5), 'CROSS%'.padStart(7), 'p25'.padStart(6), 'p50'.padStart(6), 'p75'.padStart(6), 'p90'.padStart(6), '| ownAdv p50/p75/p90');
  for (const [level, r] of Object.entries(results).sort((a, b) => b[1].n - a[1].n)) {
    console.log(
      level.padEnd(14), String(r.n).padStart(5), (r.crossRate * 100).toFixed(0).padStart(6) + '%',
      r.barOpenDist_p25.toFixed(1).padStart(6), r.barOpenDist_p50.toFixed(1).padStart(6),
      r.barOpenDist_p75.toFixed(1).padStart(6), r.barOpenDist_p90.toFixed(1).padStart(6),
      '|', r.barOwnAdverse_p50.toFixed(1), r.barOwnAdverse_p75.toFixed(1), r.barOwnAdverse_p90.toFixed(1)
    );
  }
}

main().catch(console.error).finally(() => process.exit(0));
