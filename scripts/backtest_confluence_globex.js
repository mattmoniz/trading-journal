// backtest_confluence_globex.js
// Globex/overnight counterpart to backtest_confluence.js (2026-07-22, user directive:
// "as we find new setups they need to be considered for both rth and globex").
//
// Mirrors backtest_confluence.js's touch-detection/dedup/pairing/rigor pipeline as
// closely as possible (same constants, same win/loss definition, same calibrated
// per-pair proximity via the SHARED loadPairProximityThresholds() -- level spacing is a
// property of the levels themselves, not the session window, so it doesn't need its own
// calibration pass). Two real differences from the RTH version, both required to avoid
// lookahead and to match how detectGlobexSetup() (server/routes/acd.js) actually fires
// live: (1) the bar window is the overnight Globex session (6PM ET through 8:30AM ET,
// spanning a calendar-date boundary) instead of RTH; (2) level values are looked up as of
// the PRIOR trading day (strictly before the session being tested), not the session's own
// date -- conservative on purpose: some levels in level_prices (WEEKLY_VWAP, MONTHLY_VWAP,
// RTH_VWAP) live-accumulate through their own date and are only guaranteed lookahead-safe
// once that date's RTH session has fully closed, and same-day-forming levels (OR/IB) plus
// ONH/ONL (circularly defined by the very overnight session being tested) are excluded
// entirely rather than reasoned about case-by-case under time pressure.
//
// Writes CONFLUENCE_AUDIT_OVERNIGHT rows to performance_audit -- a distinctly-named
// signal_type, not mixed with the RTH CONFLUENCE_AUDIT rows, matching this codebase's
// established convention of keeping overnight-specific calibration separate from its RTH
// sibling (see WIDER_WINDOW_OVERNIGHT_LEVELS / detectGlobexSetup() in acd.js).

import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import {
  PNL_PER_POINT, COMMISSION, FADE_STOP, PROXIMITY, LOOK_FORWARD,
  PAIR_MIN_DISTINCT_DAYS, loadPairProximityThresholds, pct, fmt,
} from './backtest_confluence.js';

// Same-day-forming (OR/IB -- don't exist yet during the overnight session leading into
// that day's RTH open) or circularly-defined-by-the-window-itself (ONH/ONL) or
// live-accumulating-through-their-own-date (RTH_VWAP) -- excluded rather than guessed at.
const EXCLUDED_GLOBEX_LEVELS = new Set([
  'OR_HIGH', 'OR_LOW', 'OR_MID', 'IB_HIGH', 'IB_LOW', 'IB_MID', 'RTH_VWAP', 'ONH', 'ONL',
]);

const WINDOW_DAYS = 100000; // full available history, matching the RTH version

async function getGlobexSessionDates() {
  // Session date S = the RTH date this overnight window leads INTO (matches
  // detectGlobexSetup()'s own sessionDate convention). Requires level_prices coverage
  // (for the prior-day level lookup) AND overnight bar coverage for the window ending at S.
  const r = await query(`
    SELECT lp.trade_date::text as trade_date
    FROM level_prices lp
    WHERE lp.trade_date <= CURRENT_DATE
      AND EXISTS (
        SELECT 1 FROM price_bars_primary p
        WHERE p.symbol = 'NQ'
          AND (
            (p.ts::date = lp.trade_date - 1 AND EXTRACT(hour FROM p.ts)*60+EXTRACT(minute FROM p.ts) >= 1080)
            OR
            (p.ts::date = lp.trade_date AND EXTRACT(hour FROM p.ts)*60+EXTRACT(minute FROM p.ts) < 510)
          )
      )
    GROUP BY lp.trade_date
    HAVING COUNT(DISTINCT lp.level_name) >= 5
    ORDER BY lp.trade_date DESC
    LIMIT $1
  `, [WINDOW_DAYS]);
  return r.rows.map(row => row.trade_date).sort();
}

async function getPriorTradingDayLevelPrices(sessionDate) {
  // Latest known level_prices row strictly BEFORE sessionDate (conservative -- see file
  // header comment). DISTINCT ON handles gaps (weekends/holidays) automatically.
  const r = await query(`
    SELECT DISTINCT ON (level_name) level_name, price::float
    FROM level_prices
    WHERE trade_date < $1 AND price IS NOT NULL
    ORDER BY level_name, trade_date DESC
  `, [sessionDate]);
  const map = {};
  for (const row of r.rows) {
    if (EXCLUDED_GLOBEX_LEVELS.has(row.level_name)) continue;
    map[row.level_name] = row.price;
  }
  return map;
}

async function getGlobexBars(sessionDate) {
  // 6PM ET (1080min) on the prior calendar date through 8:30AM ET (510min) on sessionDate.
  const r = await query(`
    SELECT
      ts,
      EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) as tod,
      open::float, high::float, low::float, close::float,
      volume::int, bid_volume::int, ask_volume::int
    FROM price_bars_primary
    WHERE symbol = 'NQ'
      AND (
        (ts::date = $1::date - 1 AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) >= 1080)
        OR
        (ts::date = $1::date AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) < 510)
      )
    ORDER BY ts
  `, [sessionDate]);
  return r.rows;
}

async function run() {
  console.log('=== CONFLUENCE AUDIT — GLOBEX/OVERNIGHT ===');

  const sessionDates = await getGlobexSessionDates();
  console.log(`Found ${sessionDates.length} overnight sessions with complete data\n`);

  const pairProximityThresholds = await loadPairProximityThresholds();
  console.log(`Calibrated per-pair proximity thresholds for ${pairProximityThresholds.size} pairs (shared with RTH — level spacing doesn't depend on session window)\n`);

  const allTouches = [];
  let skippedSessions = 0;

  for (let di = 0; di < sessionDates.length; di++) {
    const sessionDate = sessionDates[di];
    if (di % 30 === 0) console.log(`Processing session ${di + 1}/${sessionDates.length}: ${sessionDate}`);

    const [levelPrices, bars] = await Promise.all([
      getPriorTradingDayLevelPrices(sessionDate),
      getGlobexBars(sessionDate),
    ]);

    if (Object.keys(levelPrices).length < 5 || bars.length < 60) {
      skippedSessions++;
      continue;
    }

    const touchedLevels = new Set();
    let cumDelta = 0;

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      const barDelta = (bar.ask_volume || 0) - (bar.bid_volume || 0);
      cumDelta += barDelta;

      const nearbyHigh = [], nearbyLow = [];
      for (const [name, level] of Object.entries(levelPrices)) {
        if (level == null || !isFinite(level)) continue;
        const distToHigh = Math.abs(bar.high - level);
        const distToLow  = Math.abs(bar.low - level);
        if (distToHigh <= PROXIMITY && bar.high >= level) nearbyHigh.push({ name, level, dist: distToHigh });
        if (distToLow  <= PROXIMITY && bar.low  <= level) nearbyLow.push({ name, level, dist: distToLow });
      }

      if (nearbyHigh.length > 0 && i + LOOK_FORWARD < bars.length) {
        const primary = nearbyHigh.sort((a, b) => a.dist - b.dist)[0];
        const entryPrice = bar.close;
        let mfe = 0, mae = 0;
        for (let j = i + 1; j <= Math.min(i + LOOK_FORWARD, bars.length - 1); j++) {
          mfe = Math.max(mfe, entryPrice - bars[j].low);
          mae = Math.min(mae, entryPrice - bars[j].high);
        }
        mae = Math.abs(mae);
        const hasDeltaExhaustion = cumDelta > 500;
        const touchKey = `HIGH_${primary.name}`;
        const isFirstTouch = !touchedLevels.has(touchKey);
        touchedLevels.add(touchKey);
        allTouches.push({
          date: sessionDate, barIdx: i, tod: bar.tod, price: entryPrice, direction: 'SHORT',
          confluenceCount: nearbyHigh.length,
          nearbyLevelNames: nearbyHigh.map(l => l.name).sort(),
          primaryLevel: primary.name, isFirstTouch, hasDeltaExhaustion, mae, mfe,
          levelPricesAtTouch: Object.fromEntries(nearbyHigh.map(l => [l.name, l.level])),
        });
      }

      if (nearbyLow.length > 0 && i + LOOK_FORWARD < bars.length) {
        const primary = nearbyLow.sort((a, b) => a.dist - b.dist)[0];
        const entryPrice = bar.close;
        let mfe = 0, mae = 0;
        for (let j = i + 1; j <= Math.min(i + LOOK_FORWARD, bars.length - 1); j++) {
          mfe = Math.max(mfe, bars[j].high - entryPrice);
          mae = Math.min(mae, bars[j].low - entryPrice);
        }
        mae = Math.abs(mae);
        const hasDeltaExhaustion = cumDelta < -500;
        const touchKey = `LOW_${primary.name}`;
        const isFirstTouch = !touchedLevels.has(touchKey);
        touchedLevels.add(touchKey);
        allTouches.push({
          date: sessionDate, barIdx: i, tod: bar.tod, price: entryPrice, direction: 'LONG',
          confluenceCount: nearbyLow.length,
          nearbyLevelNames: nearbyLow.map(l => l.name).sort(),
          primaryLevel: primary.name, isFirstTouch, hasDeltaExhaustion, mae, mfe,
          levelPricesAtTouch: Object.fromEntries(nearbyLow.map(l => [l.name, l.level])),
        });
      }
    }
  }

  console.log(`\nSkipped ${skippedSessions} sessions (missing data)`);
  console.log(`Total touch events: ${allTouches.length}\n`);

  // Dedup: 1 touch per level-cluster per 5 bars, same as RTH version.
  const deduped = [];
  const recentTouches = new Map();
  for (const t of allTouches) {
    const key = `${t.date}_${t.direction}_${t.nearbyLevelNames.join('+')}`;
    const last = recentTouches.get(key);
    if (last !== undefined && t.barIdx - last < 5) continue;
    recentTouches.set(key, t.barIdx);
    deduped.push(t);
  }
  console.log(`After dedup (5-bar spacing): ${deduped.length} touches\n`);

  // Pairs, with the calibrated proximity gate (identical logic to the RTH version).
  const pairStats = new Map();
  let pairsRejectedByCalibration = 0;
  for (const t of deduped) {
    if (t.nearbyLevelNames.length < 2) continue;
    const names = t.nearbyLevelNames;
    for (let a = 0; a < names.length; a++) {
      for (let b = a + 1; b < names.length; b++) {
        const pairKey = `${names[a]}+${names[b]}`;
        const isCalibrated = pairProximityThresholds.has(pairKey);
        const priceA = t.levelPricesAtTouch?.[names[a]];
        const priceB = t.levelPricesAtTouch?.[names[b]];
        const threshold = pairProximityThresholds.get(pairKey) ?? (2 * PROXIMITY);
        if (priceA != null && priceB != null && Math.abs(priceA - priceB) > threshold) {
          pairsRejectedByCalibration++;
          continue;
        }
        if (!pairStats.has(pairKey)) pairStats.set(pairKey, { touches: [], isCalibrated });
        pairStats.get(pairKey).touches.push(t);
      }
    }
  }
  console.log(`Pair-touches rejected by calibrated proximity gate: ${pairsRejectedByCalibration}\n`);

  const qualifiedPairs = [];
  for (const [pairName, data] of pairStats) {
    if (data.touches.length < 10) continue;
    const t = data.touches;
    const wr30 = t.filter(x => x.mfe >= 30 && x.mae < FADE_STOP).length / t.length;
    const w = t.filter(x => x.mfe >= 30 && x.mae < 90).length;
    const l = t.filter(x => x.mae >= 90).length;
    const ev = (w * (30 * PNL_PER_POINT - COMMISSION) - l * (90 * PNL_PER_POINT + COMMISSION)) / t.length;
    const maeP50 = pct(t.map(x => x.mae)).p50;
    const mfeP50 = pct(t.map(x => x.mfe)).p50;
    qualifiedPairs.push({ pair: pairName, n: t.length, wr30, ev, maeP50, mfeP50, touches: t, isCalibrated: data.isCalibrated });
  }
  qualifiedPairs.sort((a, b) => b.ev - a.ev);
  console.log(`Qualified pairs (N>=10): ${qualifiedPairs.length}\n`);

  const pairsWithRigor = qualifiedPairs.map(p => {
    const dateCounts = new Map();
    for (const t of p.touches) dateCounts.set(t.date, (dateCounts.get(t.date) || 0) + 1);
    const distinctDays = dateCounts.size;
    const rigor = computeRigor(p.touches, {
      dateField: 'date',
      pnlFn: t => (t.mfe >= 30 && t.mae < FADE_STOP) ? (30 * PNL_PER_POINT - COMMISSION)
        : (t.mae >= FADE_STOP ? -(FADE_STOP * PNL_PER_POINT + COMMISSION) : 0),
    });
    return { ...p, distinctDays, rigor };
  });
  pairsWithRigor.sort((a, b) => b.distinctDays - a.distinctDays);
  const validated = pairsWithRigor.filter(p =>
    p.distinctDays >= PAIR_MIN_DISTINCT_DAYS && p.isCalibrated && p.rigor.clean && p.ev > 0);
  const toPersist = validated.concat(
    pairsWithRigor.filter(p => !validated.includes(p)).slice(0, 10));

  console.log(`Pairs clearing distinctDays>=${PAIR_MIN_DISTINCT_DAYS} + calibrated + clean + EV>0: ${validated.length} of ${pairsWithRigor.length} qualified pairs\n`);
  console.log('Rank | Pair | N | distinctDays | EV | isCalibrated');
  for (const p of validated.slice(0, 30)) {
    console.log(`  ${p.pair.padEnd(30)} n=${String(p.n).padStart(5)}  days=${String(p.distinctDays).padStart(3)}  ev=$${p.ev.toFixed(2).padStart(7)}`);
  }

  await query(`DELETE FROM performance_audit WHERE signal_type = 'CONFLUENCE_AUDIT_OVERNIGHT'`);
  for (const p of toPersist) {
    const maes = p.touches.map(t => t.mae);
    const mfes = p.touches.map(t => t.mfe);
    const maeS = pct(maes);
    const mfeS = pct(mfes);
    await query(`
      INSERT INTO performance_audit (
        run_date, window_days, signal_type, signal_name, sample_size,
        win_rate, ev_per_trade, total_pnl,
        avg_mfe, p50_mfe, p75_mfe,
        avg_mae, p50_mae, p75_mae, p90_mae,
        current_stop, current_target,
        recommendation, notes
      ) VALUES (
        CURRENT_DATE, $1, 'CONFLUENCE_AUDIT_OVERNIGHT', $2, $3,
        $4, $5, $6,
        $7, $8, $9,
        $10, $11, $12, $13,
        $14, $15,
        $16, $17
      )
    `, [
      WINDOW_DAYS, `PAIR:${p.pair}`, p.n,
      p.wr30, p.ev, p.ev * p.n,
      mfeS.mean, mfeS.p50, mfeS.p75,
      maeS.mean, maeS.p50, maeS.p75, maeS.p90,
      FADE_STOP, 30,
      (p.distinctDays >= PAIR_MIN_DISTINCT_DAYS && p.isCalibrated && p.rigor.clean && p.ev > 0)
        ? 'VALIDATED_PAIR' : 'NEAR_MISS_MONITOR',
      JSON.stringify({
        summary: `WR: ${(p.wr30*100).toFixed(1)}%, MAE P50: ${fmt(p.maeP50)}, MFE P50: ${fmt(p.mfeP50)}`,
        distinctDays: p.distinctDays,
        isCalibrated: p.isCalibrated,
        rigor: p.rigor,
      }),
    ]);
  }

  console.log('\nResults stored successfully.');
  process.exit(0);
}

run().catch(err => {
  console.error('Globex confluence audit failed:', err);
  process.exit(1);
});
