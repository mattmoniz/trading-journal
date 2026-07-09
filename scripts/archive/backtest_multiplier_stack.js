/**
 * Multiplier Stack Backtest: Old system vs New system
 * Reconstructs what sizeMultiplier each historical fade would have received
 * under old (streak depth=1, firstOfDay penalty) vs new (streak depth=3, firstOfDay boost).
 * Computes P&L delta at $2/pt MNQ.
 *
 * Focus: only streak depth + firstOfDay change. Does NOT reconstruct approach_delta,
 * elite_zone, recency, day_type, pair_bonus (require real-time bar data).
 */

import { query as dbQuery } from '../server/db.js';

const PNL_PER_POINT = 2;

// Load all resolved fades with mae/mfe + ev tier + overnight alignment
async function loadTrades() {
  const res = await dbQuery(`
    SELECT
      a.id,
      a.trade_date,
      a.setup_type,
      a.resolution,
      a.resolved_at,
      a.fired_at,
      a.mae_points,
      a.mfe_points,
      -- ev tier: pull from performance_audit for base mult decision
      COALESCE(pa.ev_per_trade, 25) AS ev,
      -- overnight alignment: derive direction vs inventory
      CASE
        WHEN ar.overnight_inventory = 'LONG_TRAPPED'  AND a.setup_type LIKE '%_SHORT' THEN 'COUNTER'
        WHEN ar.overnight_inventory = 'SHORT_TRAPPED' AND a.setup_type LIKE '%_LONG'  THEN 'COUNTER'
        WHEN ar.overnight_inventory = 'LONG_TRAPPED'  AND a.setup_type LIKE '%_LONG'  THEN 'ALIGNED'
        WHEN ar.overnight_inventory = 'SHORT_TRAPPED' AND a.setup_type LIKE '%_SHORT' THEN 'ALIGNED'
        ELSE 'NEUTRAL'
      END AS overnight_alignment
    FROM active_setups a
    LEFT JOIN performance_audit pa ON (
      pa.signal_name = a.setup_type
      AND pa.signal_type IN ('UNIFIED_BACKTEST', 'SYSTEM_BACKTEST', 'LEVEL_FADE_AUDIT')
      AND pa.run_date = (
        SELECT MAX(pa2.run_date) FROM performance_audit pa2
        WHERE pa2.signal_name = a.setup_type
          AND pa2.signal_type IN ('UNIFIED_BACKTEST', 'SYSTEM_BACKTEST', 'LEVEL_FADE_AUDIT')
      )
    )
    LEFT JOIN auction_reads ar ON ar.trade_date = a.trade_date
    WHERE a.status = 'RESOLVED'
      AND a.resolution IN ('TARGET_HIT', 'STOP_HIT')
      AND a.setup_type LIKE '%FADE%'
      AND a.mae_points IS NOT NULL
      AND a.mfe_points IS NOT NULL
      AND a.mae_points > 0
      AND a.mfe_points > 0
    ORDER BY a.trade_date, a.resolved_at
  `);
  return res.rows;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function applyOldRules({ ev, overnightAlignment, priorSameDay, firstOfDay }) {
  // base: no confluence count available historically — use ev tier
  let mult = ev >= 30 ? 1.0 : 0.75;

  // single prior trade streak
  if (priorSameDay?.resolution === 'STOP_HIT')   mult = clamp(mult * 0.25, 0.25, 1.5);
  else if (priorSameDay?.resolution === 'TARGET_HIT') mult = clamp(mult + 0.25, 0.25, 1.5);
  else if (firstOfDay)                             mult = clamp(mult - 0.15, 0.5,  1.5);

  // overnight neutral penalty
  if (overnightAlignment === 'NEUTRAL') mult = clamp(mult - 0.10, 0.5, 1.5);

  return clamp(mult, 0.10, 1.5);
}

function applyNewRules({ ev, overnightAlignment, priorSameDay3, firstOfDay }) {
  let mult = ev >= 30 ? 1.0 : 0.75;

  // compute consec streak from up to 3 prior
  let consecLosses = 0, consecWins = 0;
  for (const r of priorSameDay3) {
    if (r.resolution === 'STOP_HIT') {
      if (consecWins === 0) consecLosses++;
      else break;
    } else if (r.resolution === 'TARGET_HIT') {
      if (consecLosses === 0) consecWins++;
      else break;
    } else break;
  }

  if      (consecLosses >= 3)  mult = 0.10;
  else if (consecLosses === 2) mult = clamp(mult * 0.10, 0.10, 1.5);
  else if (consecLosses === 1) mult = clamp(mult * 0.25, 0.25, 1.5);
  else if (consecWins   >= 3)  mult = clamp(mult + 0.50, 0.10, 1.5);
  else if (consecWins   === 2) mult = clamp(mult + 0.35, 0.10, 1.5);
  else if (consecWins   === 1) mult = clamp(mult + 0.25, 0.10, 1.5);
  else if (firstOfDay)          mult = clamp(mult + 0.10, 0.10, 1.5);  // was -0.15

  // overnight neutral penalty
  if (overnightAlignment === 'NEUTRAL') mult = clamp(mult - 0.10, 0.5, 1.5);

  return clamp(mult, 0.10, 1.5);
}

function tradePnl(trade, mult) {
  if (trade.resolution === 'TARGET_HIT') {
    return mult * parseFloat(trade.mfe_points) * PNL_PER_POINT;
  } else {
    return mult * -parseFloat(trade.mae_points) * PNL_PER_POINT;
  }
}

async function run() {
  const trades = await loadTrades();
  console.log(`Loaded ${trades.length} resolved fades with mae/mfe`);

  // Group by trade_date for streak computation
  const byDate = {};
  for (const t of trades) {
    const d = t.trade_date instanceof Date ? t.trade_date.toISOString().slice(0, 10) : String(t.trade_date).slice(0, 10);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(t);
  }

  let oldTotal = 0, newTotal = 0;
  let nBetter = 0, nWorse = 0, nSame = 0;
  const fod = [], deepStreak = [];
  const multBuckets = { heavy: 0, normal: 0, boosted: 0 };
  let totalTrades = 0;
  const tradeDates = new Set();

  for (const [date, dayTrades] of Object.entries(byDate)) {
    tradeDates.add(date);
    // sort by resolved_at within day
    dayTrades.sort((a, b) => new Date(a.resolved_at) - new Date(b.resolved_at));

    for (let i = 0; i < dayTrades.length; i++) {
      const t = dayTrades[i];
      const priorToday = dayTrades.slice(0, i); // resolved before this one
      const firstOfDay = priorToday.length === 0;

      const priorSameDay  = priorToday.length > 0 ? priorToday[priorToday.length - 1] : null;
      const priorSameDay3 = priorToday.slice(-3).reverse(); // most recent first

      const oldMult = applyOldRules({ ev: parseFloat(t.ev), overnightAlignment: t.overnight_alignment, priorSameDay, firstOfDay });
      const newMult = applyNewRules({ ev: parseFloat(t.ev), overnightAlignment: t.overnight_alignment, priorSameDay3, firstOfDay });

      const oldPnl = tradePnl(t, oldMult);
      const newPnl = tradePnl(t, newMult);
      const delta = newPnl - oldPnl;

      oldTotal += oldPnl;
      newTotal += newPnl;
      totalTrades++;

      if (delta > 0.01) nBetter++;
      else if (delta < -0.01) nWorse++;
      else nSame++;

      // categorize
      if (firstOfDay && priorSameDay3.length === 0) {
        // purely firstOfDay trades
        fod.push({ old: oldPnl, new: newPnl, delta });
      }

      // deep streak trades (consec >= 2)
      let consecL = 0, consecW = 0;
      for (const r of priorSameDay3) {
        if (r.resolution === 'STOP_HIT') { if (consecW === 0) consecL++; else break; }
        else if (r.resolution === 'TARGET_HIT') { if (consecL === 0) consecW++; else break; }
        else break;
      }
      if (consecL >= 2 || consecW >= 2) {
        deepStreak.push({ old: oldPnl, new: newPnl, delta, consecL, consecW });
      }

      // new mult distribution
      if (newMult < 0.5) multBuckets.heavy++;
      else if (newMult <= 1.0) multBuckets.normal++;
      else multBuckets.boosted++;
    }
  }

  const nDates = tradeDates.size;
  const annualFactor = 252 / nDates;

  console.log('\n=== MULTIPLIER STACK BACKTEST ===\n');
  console.log(`Trades analyzed: ${totalTrades} fades over ${nDates} trading days`);
  console.log(`Annualization factor: ${annualFactor.toFixed(2)}× (${nDates} days → 252 days)\n`);

  console.log('--- Summary ---');
  console.log(`Old system total P&L:  $${oldTotal.toFixed(0)}`);
  console.log(`New system total P&L:  $${newTotal.toFixed(0)}`);
  console.log(`Delta P&L:             $${(newTotal - oldTotal).toFixed(0)}`);
  console.log(`Annualized delta:      $${((newTotal - oldTotal) * annualFactor).toFixed(0)}/yr`);
  console.log(`New better: ${nBetter} | Old better: ${nWorse} | Unchanged: ${nSame}\n`);

  console.log('--- Breakdown: firstOfDay flip ---');
  const fodOld = fod.reduce((s, r) => s + r.old, 0);
  const fodNew = fod.reduce((s, r) => s + r.new, 0);
  console.log(`N=${fod.length} first-of-day trades`);
  console.log(`Old: $${fodOld.toFixed(0)}  New: $${fodNew.toFixed(0)}  Delta: $${(fodNew - fodOld).toFixed(0)}  Annualized: $${((fodNew - fodOld) * annualFactor).toFixed(0)}/yr\n`);

  console.log('--- Breakdown: deep streak (consec >= 2) ---');
  const dsOld = deepStreak.reduce((s, r) => s + r.old, 0);
  const dsNew = deepStreak.reduce((s, r) => s + r.new, 0);
  console.log(`N=${deepStreak.length} deep streak trades`);
  console.log(`Old: $${dsOld.toFixed(0)}  New: $${dsNew.toFixed(0)}  Delta: $${(dsNew - dsOld).toFixed(0)}  Annualized: $${((dsNew - dsOld) * annualFactor).toFixed(0)}/yr\n`);

  console.log('--- New system mult distribution ---');
  console.log(`Heavy penalty (<0.5×): ${multBuckets.heavy} trades (${(100*multBuckets.heavy/totalTrades).toFixed(1)}%)`);
  console.log(`Normal (0.5-1.0×):     ${multBuckets.normal} trades (${(100*multBuckets.normal/totalTrades).toFixed(1)}%)`);
  console.log(`Boosted (>1.0×):       ${multBuckets.boosted} trades (${(100*multBuckets.boosted/totalTrades).toFixed(1)}%)`);

}


run().catch(e => { console.error(e); process.exit(1); });
