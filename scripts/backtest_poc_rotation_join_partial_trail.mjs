// Partial-scale-out + trail test for POC_ROTATION_JOIN_LONG (2026-09-24, DeepSeek: "run the
// partial + trail test this week, one hour -- if it fails, accept your current exits are as
// good as mechanical fixes get"). Distinct from the earlier full-position exit-variant sweep
// (backtest_poc_rotation_join_exit_variants.mjs, which tested wider-stop/longer-timeout/
// breakeven-trail-ALL and found nothing clears baseline) -- this splits the position: bank
// HALF at a real, cheap checkpoint (1R favorable, matching the setup's own real risk
// distance) and let the OTHER half ride the best runner config already found
// (breakeven-arm@20pt, trail 30pt behind peak, no time cap -- BE_TRAIL_arm20_trail30 was the
// single best-performing full-position variant in the earlier sweep, mean $54.19 vs
// baseline's $50.69, just not distinguishable from noise as a FULL-position swap).
//
// Exploratory/theoretical: the user trades 1 MNQ contract at a time in practice, so a literal
// "2-lot" scale-out isn't directly executable today -- this establishes whether there's real
// value being left on the table by a scale-out SHAPE at all (worth knowing regardless, per
// the already-existing TWOLOT_SCALEOUT_BREAKEVEN_MINUS5_SPEC.md precedent for exactly this
// question on a different setup family), not a claim this can be traded as-is on 1 contract.
//
// Same entry/stop as the real baseline (no structural-advantage confound -- only the EXIT
// shape differs), same real bars, same day-blocked bootstrap CI discipline as the earlier
// sweep. Unit 1 (half): banks at 1R, else follows the same 20pt-stop/60min-timeout baseline.
// Unit 2 (other half): breakeven-armed at 1R (20pt), trails 30pt behind the running peak, NO
// time cap once armed (a genuine trail doesn't need one, matching the earlier sweep's design).
import { query } from '../server/db.js';
import { dayBlockedBootstrapDeltaCI } from '../server/services/rigorDiagnostics.js';

const PNL_PER_POINT = 2; // MNQ $2/pt, per unit
const COMMISSION = 2; // $2 round-trip, per unit
const MAX_HORIZON_MIN = 600; // wide enough for an uncapped trail to fully resolve
const STOP_DIST = 20, TIMEOUT_MIN = 60, ARM_DIST = 20, TRAIL_DIST = 30;

async function loadRealTrades() {
  const { rows } = await query(`
    SELECT id, trade_date::text as trade_date, fired_at::text as fired_at,
           COALESCE(entry_zone_high, entry_zone_low)::float as entry, actual_pnl::float as real_pnl
    FROM active_setups
    WHERE setup_type = 'POC_ROTATION_JOIN_LONG'
      AND origin_status IN ('ACTIVE','SHADOW')
      AND (is_cluster_primary IS NULL OR is_cluster_primary = true)
      AND resolution IS NOT NULL AND entry_zone_low IS NOT NULL
    ORDER BY fired_at ASC
  `);
  return rows;
}

async function loadBars(firedAt) {
  const { rows } = await query(`
    SELECT ts::text as ts, high::float, low::float, close::float
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts > $1 AND ts <= $1::timestamp + ($2 || ' minutes')::interval
    ORDER BY ts ASC
  `, [firedAt, MAX_HORIZON_MIN]);
  return rows;
}

function minutesBetween(a, b) { return (new Date(b + 'Z') - new Date(a + 'Z')) / 60000; }
function dollarPnl(entry, exitPrice) { return Math.round(((exitPrice - entry) * PNL_PER_POINT - COMMISSION) * 100) / 100; }

// Unit 1: banks at 1R (entry+STOP_DIST for LONG), else the baseline 20pt-stop/60min-timeout.
function simBankHalf(entry, bars) {
  const stopPrice = entry - STOP_DIST;
  const targetPrice = entry + STOP_DIST; // 1R, same distance as the real risk
  let lastBar = null;
  for (const bar of bars) {
    if (minutesBetween(bars.firedAt, bar.ts) > TIMEOUT_MIN) break;
    if (bar.low <= stopPrice) return dollarPnl(entry, stopPrice);
    if (bar.high >= targetPrice) return dollarPnl(entry, targetPrice);
    lastBar = bar;
  }
  return lastBar ? dollarPnl(entry, lastBar.close) : null;
}

// Unit 2: breakeven-armed at 1R, trails TRAIL_DIST behind the peak, no time cap once armed.
function simTrailHalf(entry, bars) {
  const stopPrice0 = entry - STOP_DIST;
  let armed = false, peak = entry, stop = stopPrice0, lastBar = null;
  for (const bar of bars) {
    lastBar = bar;
    if (bar.low <= stop) return dollarPnl(entry, stop);
    if (bar.high > peak) peak = bar.high;
    const excursion = peak - entry;
    if (!armed && excursion >= ARM_DIST) armed = true;
    if (armed) stop = Math.max(stop, peak - TRAIL_DIST, entry);
  }
  return lastBar ? dollarPnl(entry, lastBar.close) : null;
}

async function main() {
  const trades = await loadRealTrades();
  console.log(`Real POC_ROTATION_JOIN_LONG trades: ${trades.length}, distinct days: ${new Set(trades.map(t => t.trade_date)).size}`);

  const events = [];
  for (const t of trades) {
    const bars = await loadBars(t.fired_at);
    bars.firedAt = t.fired_at;
    const unit1 = simBankHalf(t.entry, bars);
    const unit2 = simTrailHalf(t.entry, bars);
    if (unit1 == null || unit2 == null) continue;
    const partialTrailTotal = unit1 + unit2; // 2-unit total, comparable to a 2x-baseline for a fair $ comparison
    const baselineTotal = t.real_pnl * 2; // 2 units at the real (already-verified) baseline exit, for an apples-to-apples 2-unit comparison
    events.push({ date: t.trade_date, group: 'PARTIAL_TRAIL', pnl: partialTrailTotal });
    events.push({ date: t.trade_date, group: 'BASELINE_2UNIT', pnl: baselineTotal });
  }

  const partial = events.filter(e => e.group === 'PARTIAL_TRAIL');
  const baseline = events.filter(e => e.group === 'BASELINE_2UNIT');
  const meanPartial = partial.reduce((a, e) => a + e.pnl, 0) / partial.length;
  const meanBaseline = baseline.reduce((a, e) => a + e.pnl, 0) / baseline.length;
  const ci = dayBlockedBootstrapDeltaCI(events, 'poc_rotation_partial_trail', { groupA: 'BASELINE_2UNIT', groupB: 'PARTIAL_TRAIL' });

  console.log(`\nN=${partial.length} trades (2-unit comparison, same entries/stops, only exit shape differs)`);
  console.log(`Baseline (2x real exit):     mean=$${meanBaseline.toFixed(2)}`);
  console.log(`Partial (1R bank) + Trail:   mean=$${meanPartial.toFixed(2)}`);
  console.log(`Day-blocked delta CI (Partial - Baseline): [$${ci.lo?.toFixed(2)}, $${ci.hi?.toFixed(2)}]`);
  const excludesZero = ci.lo != null && (ci.lo > 0 || ci.hi < 0);
  console.log(`\nVERDICT: ${excludesZero ? (ci.lo > 0 ? 'REAL IMPROVEMENT' : 'REAL WORSE') : 'INCONCLUSIVE -- CI crosses zero, indistinguishable from the current baseline at this N'}`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
