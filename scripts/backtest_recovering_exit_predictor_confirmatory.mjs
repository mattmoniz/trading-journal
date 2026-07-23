// scripts/backtest_recovering_exit_predictor_confirmatory.mjs
// Pre-registered confirmatory test of the ONE finding from
// backtest_recovering_exit_predictor.mjs (target distance fraction predicts EXIT_BETTER
// vs HOLD_BETTER for RECOVERING bar-6 touches) — built per explicit user direction to do
// the "doesn't require waiting" validation track before the live-data track.
//
// Design, deliberately more conservative than the exploratory pass:
// 1. The rule is FROZEN, not re-derived: targetDistFraction < 0.873 -> take the bar-6 exit
//    (Arm B); otherwise hold to the original outcome (Arm A). This exact cutoff and
//    direction come from the prior exploratory run's own train-set search — not
//    re-searched here, which is the whole point of a confirmatory test.
// 2. NO per-setup_type cherry-picking. The prior test's second selection layer (pick which
//    setup_types show a train advantage, then only credit the rule for those) is gone here
//    -- the rule is applied UNIFORMLY to every single qualifying touch, setup_type
//    irrelevant. This removes one full layer of the two-layer selection risk flagged in
//    OPEN_DECISION confirm_target_distance_fraction_exit_predictor.
// 3. HONEST LIMITATION, stated directly rather than glossed over: this is NOT calendar-
//    fresh data. Every historical touch here was already touched in some way by the prior
//    exploratory pass (used for feature search, cutoff search, or read as part of the
//    pooled test-set summary). This test removes the cherry-picking risk, not the "have I
//    already seen this data" risk -- the only way to fully resolve that is the live-data
//    track (bar6_checkpoint accumulating real, non-BACKFILL touches from here forward).
//
// RESULT: see the console output / RESEARCH_CLAIM this script's run produces.

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { loadPairProximityThresholds, PROXIMITY, COMMISSION, PNL_PER_POINT } from './backtest_confluence.js';

const FROZEN_CUTOFF = 0.873; // pre-registered, from the exploratory pass -- do not re-search

async function main() {
  const pairsRes = await query(`SELECT signal_name FROM performance_audit WHERE signal_type='CONFLUENCE_AUDIT' AND recommendation='VALIDATED_PAIR'`);
  const validPairs = new Set();
  const validLevels = new Set();
  for (const row of pairsRes.rows) {
    const pairStr = row.signal_name.replace('PAIR:', '');
    validPairs.add(pairStr);
    const [a, b] = pairStr.split('+');
    validLevels.add(a); validLevels.add(b);
  }
  const pairThresholds = await loadPairProximityThresholds();

  const levelPricesRes = await query(`SELECT trade_date::text as trade_date, level_name, price::float as price FROM level_prices WHERE price IS NOT NULL`);
  const levelPricesByDate = new Map();
  for (const r of levelPricesRes.rows) {
    const d = r.trade_date.slice(0, 10);
    if (!levelPricesByDate.has(d)) levelPricesByDate.set(d, new Map());
    levelPricesByDate.get(d).set(r.level_name, r.price);
  }

  const setupsRes = await query(`
    SELECT id, trade_date::text as trade_date, fired_at, resolution, actual_pnl::float, setup_type,
           entry_zone_low::float, entry_zone_high::float, stop_level::float, t1_level::float
    FROM active_setups
    WHERE resolution IN ('STOP_HIT', 'TARGET_HIT', 'TIME_EXPIRED') AND actual_pnl IS NOT NULL
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
      AND mae_points IS NOT NULL AND mae_points <= 300 AND mfe_points IS NOT NULL AND mfe_points <= 300
    ORDER BY trade_date, fired_at
  `);

  const setupsByDate = new Map();
  for (const s of setupsRes.rows) {
    const d = s.trade_date.slice(0, 10);
    if (!setupsByDate.has(d)) setupsByDate.set(d, []);
    setupsByDate.get(d).push(s);
  }

  const touches = [];
  for (const [date, dateSetups] of setupsByDate) {
    const barsRes = await query(`SELECT ts, high::float, low::float, close::float, COALESCE(volume,0)::int as volume FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1 ORDER BY ts`, [date]);
    const allBars = barsRes.rows;
    if (allBars.length < 25) continue;
    const lp = levelPricesByDate.get(date) || new Map();

    for (const s of dateSetups) {
      const direction = directionFromType(s.setup_type);
      if (!direction) continue;
      let entryIdx = -1;
      for (let i = allBars.length - 1; i >= 0; i--) { if (allBars[i].ts <= s.fired_at) { entryIdx = i; break; } }
      if (entryIdx < 20) continue;

      const underlying = s.setup_type.replace('_FADE_LONG', '').replace('_FADE_SHORT', '');
      let hasConfluence = false;
      const myPrice = lp.get(underlying);
      if (myPrice != null) {
        for (const partner of validLevels) {
          if (partner === underlying) continue;
          const k1 = `${underlying}+${partner}`, k2 = `${partner}+${underlying}`;
          if (validPairs.has(k1) || validPairs.has(k2)) {
            const partnerPrice = lp.get(partner);
            if (partnerPrice != null) {
              const key = underlying < partner ? k1 : k2;
              const threshold = pairThresholds.get(key) ?? (2 * PROXIMITY);
              if (Math.abs(myPrice - partnerPrice) <= threshold) { hasConfluence = true; break; }
            }
          }
        }
      }

      const forwardBars = allBars.slice(entryIdx);
      let resolutionBarIdx = -1;
      for (let i = 0; i < forwardBars.length; i++) {
        const bar = forwardBars[i];
        const stopHit = direction === 'LONG' ? bar.low <= s.stop_level : bar.high >= s.stop_level;
        const targetHit = direction === 'LONG' ? bar.high >= s.t1_level : bar.low <= s.t1_level;
        if (stopHit || targetHit) { resolutionBarIdx = i; break; }
      }
      if (resolutionBarIdx === -1) resolutionBarIdx = forwardBars.length - 1;
      if (resolutionBarIdx < 6) continue;

      const b0_6 = forwardBars.slice(0, 7);
      let worstPrice = direction === 'LONG' ? b0_6[0].low : b0_6[0].high;
      let worstBarIdx = 0;
      for (let i = 0; i <= 6; i++) {
        if (direction === 'LONG' && b0_6[i].low < worstPrice) { worstPrice = b0_6[i].low; worstBarIdx = i; }
        if (direction === 'SHORT' && b0_6[i].high > worstPrice) { worstPrice = b0_6[i].high; worstBarIdx = i; }
      }
      if (worstBarIdx > 2) continue; // RECOVERING only

      const hi = s.entry_zone_high != null ? s.entry_zone_high : s.entry_zone_low;
      const entry = (s.entry_zone_low + hi) / 2;
      const bar6Close = b0_6[6].close;

      const pnlA = s.actual_pnl;
      const pointsB = direction === 'LONG' ? (bar6Close - entry) : (entry - bar6Close);
      const pnlB = pointsB * PNL_PER_POINT - COMMISSION;

      const distToTarget = direction === 'LONG' ? (s.t1_level - bar6Close) : (bar6Close - s.t1_level);
      const distEntryToTarget = direction === 'LONG' ? (s.t1_level - entry) : (entry - s.t1_level);
      const targetDistFraction = distEntryToTarget !== 0 ? (distToTarget / distEntryToTarget) : 0;

      // Pre-registered rule applied uniformly, no per-setup_type selection.
      const gatedPnl = targetDistFraction < FROZEN_CUTOFF ? pnlB : pnlA;

      touches.push({ ...s, dateStr: date, direction, hasConfluence, pnlA, gatedPnl });
    }
  }

  function summarize(rows, field) {
    const n = rows.length;
    if (n === 0) return { n: 0 };
    const wins = rows.filter(r => r[field] > 0);
    const losses = rows.filter(r => r[field] <= 0);
    const avgWin = wins.length ? (wins.reduce((s, r) => s + r[field], 0) / wins.length).toFixed(2) : 'n/a';
    const avgLoss = losses.length ? (losses.reduce((s, r) => s + r[field], 0) / losses.length).toFixed(2) : 'n/a';
    const maxWin = wins.length ? Math.max(...wins.map(r => r[field])).toFixed(2) : 'n/a';
    const maxLoss = losses.length ? Math.min(...losses.map(r => r[field])).toFixed(2) : 'n/a';
    const wr = (wins.length / n * 100).toFixed(1);
    const ev = (rows.reduce((s, r) => s + r[field], 0) / n).toFixed(2);
    const rigor = n >= 20 ? computeRigor(rows, { dateField: 'dateStr', pnlFn: x => x[field] }) : { clean: false, clustered: false };
    return { n, avgWin, avgLoss, maxWin, maxLoss, wr, ev, clean: rigor.clean, clustered: rigor.clustered };
  }

  console.log(`Population: ${touches.length} RECOVERING touches (all history, no split -- this IS the full population, not a train/test partition, per the confirmatory design).`);
  console.log(`Frozen rule: targetDistFraction < ${FROZEN_CUTOFF} -> exit at bar 6; else hold to original outcome. Applied uniformly, no per-setup_type selection.\n`);

  for (const [label, subset] of [
    ['ALL', touches],
    ['CONFLUENCE', touches.filter(t => t.hasConfluence)],
    ['NON-CONFLUENCE', touches.filter(t => !t.hasConfluence)],
  ]) {
    const baseline = summarize(subset, 'pnlA');
    const gated = summarize(subset, 'gatedPnl');
    console.log(`-- ${label} --`);
    console.log('Baseline (Arm A, always hold):', baseline);
    console.log('Gated (frozen rule, uniform):', gated);
    console.log('');
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
