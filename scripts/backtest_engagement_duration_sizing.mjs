// scripts/backtest_engagement_duration_sizing.mjs
// One-off (not scheduled) test of whether a longer, harder-fought engagement (a touch
// still active — not yet stopped or targeted — at bar K after first touch) predicts a
// BIGGER eventual winner than a fast-resolving touch. Direct follow-up to
// backtest_engagement_confirmation_entry.mjs (which found using engagement to GATE entry
// timing doesn't work) — this tests using engagement duration to CONDITION winner sizing
// instead, per the user's own framing: win rate isn't the success metric, contained
// losses + occasional large winners is.
//
// Bucketing is real-time-computable, not hindsight: "still active at bar K" only requires
// knowing whether stop/target has been hit in bars 0..K, which is genuinely knowable live.
// The forward-MFE-from-K number is a hindsight-permitted DESCRIPTIVE stat (same convention
// as the pivot-bar characterization in the sibling script), never used as a live input.
//
// RESULT (see RESEARCH_CLAIM engagement_duration_conditions_winner_size): the user's
// intuition is partially correct and partially not. Touches still active at bar K DO have
// a bigger average win size than the unconditional population (+$5 to +$17 across
// K=3/6/10), and this doesn't come from a data error — verified directly (unconditional
// TRAIN avg win $92.40 vs a raw independent SQL check of $92.87, max win $599 exact match
// both ways). But the ACTIVE bucket's overall EV is deeply negative (-$5 to -$18/trade
// depending on K and view) because win rate collapses hard (49-54% vs 57-64% baseline) —
// the bigger-winner effect is real but far too small to offset how much worse the whole
// bucket performs. The "avg win size advantage" also fails computeReplication() on held-out
// test data for every K value tried (replicates=false in all cases) — the specific
// setup_types that looked like winners on train don't hold on test.
//
// Practical takeaway: do NOT widen targets/trail wider just because a trade has lasted N
// bars — that population is dominated by grinding losers, not quietly-building winners.
// Open question, not tested here: does CANDLESTICK SHAPE at/around bar K (not just the
// raw fact of still being active) distinguish the minority of genuine still-building
// winners from the majority toxic population? Raised by the user 2026-07-23 immediately
// after this result. Worth noting: candlestick-shape-based entry confirmation has already
// been extensively tested elsewhere in this codebase and failed every variant tried (see
// docs/CANDLE_ORDERFLOW_RESEARCH_SPEC.md) — but none of those tests conditioned on "still
// active at bar K" specifically, so this would be a genuinely new angle, not a re-run of
// an already-debunked one. Not yet built.

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { computeRigor, computeReplication } from '../server/services/rigorDiagnostics.js';
import { loadPairProximityThresholds, PROXIMITY } from './backtest_confluence.js';
import fs from 'fs';

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summarizeDistribution(arr) {
  if (arr.length === 0) return { p25: null, p50: null, p75: null, p90: null, max: null };
  const sorted = [...arr].sort((a, b) => a - b);
  return { p25: percentile(sorted, 0.25), p50: percentile(sorted, 0.50), p75: percentile(sorted, 0.75), p90: percentile(sorted, 0.90), max: sorted[sorted.length - 1] };
}

function summarizeBucket(name, rows, unconditionalAvgEv) {
  const n = rows.length;
  if (n === 0) return { label: name, n: 0, wr: '0.0', ev: 'n/a' };
  const wins = rows.filter(r => r.actual_pnl > 0);
  const losses = rows.filter(r => r.actual_pnl <= 0);
  const wr = ((wins.length / n) * 100).toFixed(1);
  const ev = (rows.reduce((s, r) => s + r.actual_pnl, 0) / n).toFixed(2);
  const avgWin = wins.length ? (wins.reduce((s, r) => s + r.actual_pnl, 0) / wins.length).toFixed(2) : 'n/a';
  const avgLoss = losses.length ? (losses.reduce((s, r) => s + r.actual_pnl, 0) / losses.length).toFixed(2) : 'n/a';
  const winSizes = wins.map(r => r.actual_pnl).sort((a, b) => a - b);
  const maxWin = winSizes.length ? winSizes[winSizes.length - 1].toFixed(2) : 'n/a';
  const p75Win = winSizes.length ? percentile(winSizes, 0.75).toFixed(2) : 'n/a';
  const p90Win = winSizes.length ? percentile(winSizes, 0.90).toFixed(2) : 'n/a';
  const beatsAvg = unconditionalAvgEv !== undefined ? (parseFloat(ev) > unconditionalAvgEv ? 'YES' : 'NO') : 'N/A';
  const rigorStr = n >= 20
    ? (() => { const r = computeRigor(rows, { dateField: 'dateStr', pnlFn: x => x.actual_pnl }); return `clustered=${r.clustered} clean=${r.clean}`; })()
    : '(N<20)';
  return { label: name, n, wr, ev, avgWin, avgLoss, maxWin, p75Win, p90Win, beatsAvg, rigorStr };
}

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
           entry_zone_low::float, COALESCE(entry_zone_high, entry_zone_low)::float as entry_zone_high,
           stop_level::float, t1_level::float
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

  const allTouches = [];
  for (const [date, dateSetups] of setupsByDate) {
    const barsRes = await query(`
      SELECT ts, open::float, high::float, low::float, close::float, COALESCE(volume,0)::int AS volume,
             COALESCE(bid_volume,0)::int AS bid_volume, COALESCE(ask_volume,0)::int AS ask_volume
      FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1 ORDER BY ts
    `, [date]);
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

      allTouches.push({ ...s, dateStr: date, direction, hasConfluence, forwardBars, resolutionBarIdx });
    }
  }

  const K_VALUES = [3, 6, 10];
  const setupTypes = [...new Set(allTouches.map(x => x.setup_type))];

  for (const t of allTouches) {
    t.mfes = {};
    for (const k of K_VALUES) {
      if (t.resolutionBarIdx >= k) {
        const barK = t.forwardBars[k];
        let maxFavPrice = barK.close;
        for (let i = k; i <= t.resolutionBarIdx; i++) {
          const b = t.forwardBars[i];
          if (t.direction === 'LONG' && b.high > maxFavPrice) maxFavPrice = b.high;
          if (t.direction === 'SHORT' && b.low < maxFavPrice) maxFavPrice = b.low;
        }
        t.mfes[k] = t.direction === 'LONG' ? maxFavPrice - barK.close : barK.close - maxFavPrice;
      }
    }
  }

  const trainTouches = [], testTouches = [];
  for (const st of setupTypes) {
    const myTouches = allTouches.filter(x => x.setup_type === st).sort((a, b) => a.dateStr.localeCompare(b.dateStr));
    const splitIdx = Math.floor(myTouches.length * 0.8);
    trainTouches.push(...myTouches.slice(0, splitIdx));
    testTouches.push(...myTouches.slice(splitIdx));
  }

  const results = {};
  for (const k of K_VALUES) {
    results[k] = { ALL: {}, CONF: {}, NOCONF: {}, setupStats: {} };
    const processTouches = (touches) => {
      const unconditionalEv = touches.length ? touches.reduce((s, x) => s + x.actual_pnl, 0) / touches.length : 0;
      const active = touches.filter(x => x.resolutionBarIdx >= k);
      const resolved = touches.filter(x => x.resolutionBarIdx < k);
      return {
        UNCONDITIONAL: summarizeBucket('Unconditional', touches),
        ACTIVE: summarizeBucket(`Active @ ${k}`, active, unconditionalEv),
        RESOLVED: summarizeBucket(`Resolved @ ${k}`, resolved, unconditionalEv),
        mfes: summarizeDistribution(active.map(x => x.mfes[k])),
      };
    };
    results[k].ALL.train = processTouches(trainTouches);
    results[k].CONF.train = processTouches(trainTouches.filter(x => x.hasConfluence));
    results[k].NOCONF.train = processTouches(trainTouches.filter(x => !x.hasConfluence));
    results[k].ALL.test = processTouches(testTouches);
    results[k].CONF.test = processTouches(testTouches.filter(x => x.hasConfluence));
    results[k].NOCONF.test = processTouches(testTouches.filter(x => !x.hasConfluence));
    for (const st of setupTypes) {
      results[k].setupStats[st] = { train: processTouches(trainTouches.filter(x => x.setup_type === st)), test: processTouches(testTouches.filter(x => x.setup_type === st)) };
    }
  }

  for (const k of K_VALUES) {
    console.log(`\n-- K=${k}, ALL, TRAIN --`, results[k].ALL.train.UNCONDITIONAL, results[k].ALL.train.ACTIVE, results[k].ALL.train.RESOLVED);
    console.log(`-- K=${k}, ALL, TEST --`, results[k].ALL.test.UNCONDITIONAL, results[k].ALL.test.ACTIVE, results[k].ALL.test.RESOLVED);

    const selectedAvgWin = [];
    for (const st of setupTypes) {
      const tr = results[k].setupStats[st].train;
      if (tr.ACTIVE.n >= 10 && tr.UNCONDITIONAL.n >= 10) {
        const actWin = parseFloat(tr.ACTIVE.avgWin), uncWin = parseFloat(tr.UNCONDITIONAL.avgWin);
        if (!isNaN(actWin) && !isNaN(uncWin) && actWin > uncWin) selectedAvgWin.push(st);
      }
    }
    const testUnits = setupTypes.map(st => {
      const te = results[k].setupStats[st].test;
      const val = (!isNaN(parseFloat(te.ACTIVE.avgWin)) && !isNaN(parseFloat(te.UNCONDITIONAL.avgWin)))
        ? parseFloat(te.ACTIVE.avgWin) - parseFloat(te.UNCONDITIONAL.avgWin) : 0;
      return { setupType: st, n: te.ACTIVE.n, value: val };
    });
    if (selectedAvgWin.length) {
      const rep = computeReplication(testUnits, { idFn: x => x.setupType, metricFn: x => ({ n: x.n, value: x.value }), selectedIds: selectedAvgWin });
      console.log(`K=${k} replication: ${selectedAvgWin.length} setup_types selected on train, test selected-pool diff=$${rep.selectedPooled.value} vs held-out diff=$${rep.heldOutPooled.value}, replicates=${rep.replicates}`);
    }
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
