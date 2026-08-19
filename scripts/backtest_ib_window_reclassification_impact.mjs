// Diagnostic for OPEN_DECISION ib_bullbear_window_fix_recalibration_needed.
// Read-only -- writes nothing to active_setups/performance_audit. See
// docs/IB_WINDOW_RECALIBRATION_SPEC.md (v2, post-DeepSeek-critique) for the full design.
//
// Question: IB_BULLISH/IB_BEARISH/STOP_SWEEP_LONG/STOP_SWEEP_SHORT real history was fired
// almost entirely under the OLD 30-min ibBars window (BETWEEN 570 AND 599) before the
// 2026-08-12 fix widened it to the real 60-min Initial Balance (BETWEEN 570 AND 629). How
// much of that history would classify differently under the corrected window?
//
// Run: node scripts/backtest_ib_window_reclassification_impact.mjs
import { query } from '../server/db.js';
import { computeIbBullBear } from '../server/services/caseEngine.js';
import { REAL_TRADE_FILTER } from './backtest_setup_status.mjs';

const OLD_WINDOW = [570, 599];
const NEW_WINDOW = [570, 629];
// ibBars widened this date (commit-documented at acd.js's ibBarsRow query) -- only trades
// fired BEFORE this date were actually classified under the OLD window; post-fix trades
// already reflect the corrected window and aren't part of "how much of history is stale."
const FIX_DATE = '2026-08-12';
const IB_GATE_MIN = 630; // etMin>=630 gate (since 2026-07-14) -- pre-10:30 fires used a partial window at fire time
const DIST_THRESHOLD = 5; // pre-registered STOP_SWEEP materiality bar, points
const FLIP_THRESHOLD_PCT = 20; // pre-registered IB_BULLISH/BEARISH materiality bar
const PNL_MATERIALITY = 5; // pre-registered $/trade override, regardless of count

async function reconstructIbBars(tradeDate, [loMin, hiMin]) {
  const r = await query(`
    SELECT high::float, low::float, close::float,
      COALESCE(ask_volume,0)::int as ask_vol, COALESCE(bid_volume,0)::int as bid_vol
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts::date=$1
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN $2 AND $3
    ORDER BY ts
  `, [tradeDate, loMin, hiMin]);
  return r.rows;
}

// ── IB_BULLISH / IB_BEARISH ──────────────────────────────────────────────────
async function analyzeIbDirectional(setupType, includeUnknown) {
  const expectedBull = setupType === 'IB_BULLISH';
  const originClause = includeUnknown ? `(${REAL_TRADE_FILTER} OR origin_status='UNKNOWN')` : REAL_TRADE_FILTER;
  const rows = (await query(`
    SELECT id, trade_date::text as trade_date, fired_at::text as fired_at, actual_pnl::float,
      EXTRACT(hour FROM fired_at)*60+EXTRACT(minute FROM fired_at) as et_min
    FROM active_setups
    WHERE setup_type=$1 AND ${originClause}
      AND resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED') AND actual_pnl IS NOT NULL
      AND trade_date < $2
    ORDER BY trade_date
  `, [setupType, FIX_DATE])).rows;

  const buckets = { preGateExcluded: [], reconstructionFailure: [], same: [], flipped: [], ineligible: [] };
  let oldWindowFidelityMatch = 0, oldWindowFidelityChecked = 0;

  for (const row of rows) {
    if (row.et_min < IB_GATE_MIN) { buckets.preGateExcluded.push(row); continue; }
    const [oldBars, newBars] = await Promise.all([
      reconstructIbBars(row.trade_date, OLD_WINDOW),
      reconstructIbBars(row.trade_date, NEW_WINDOW),
    ]);
    if (oldBars.length < 3 || newBars.length < 3) { buckets.reconstructionFailure.push(row); continue; }
    const oldClass = computeIbBullBear(oldBars);
    const newClass = computeIbBullBear(newBars);
    if (oldClass) {
      oldWindowFidelityChecked++;
      const oldMatchesFired = expectedBull ? oldClass.ibBullish : oldClass.ibBearish;
      if (oldMatchesFired) oldWindowFidelityMatch++;
    }
    const newMatchesFired = expectedBull ? newClass?.ibBullish : newClass?.ibBearish;
    const newOpposite = expectedBull ? newClass?.ibBearish : newClass?.ibBullish;
    if (newMatchesFired) buckets.same.push(row);
    else if (newOpposite) buckets.flipped.push({ ...row, actual_pnl: row.actual_pnl });
    else buckets.ineligible.push({ ...row, actual_pnl: row.actual_pnl });
  }

  const denom = buckets.same.length + buckets.flipped.length + buckets.ineligible.length;
  const affected = buckets.flipped.length + buckets.ineligible.length;
  const affectedPct = denom > 0 ? (100 * affected / denom) : null;
  const stablePnls = buckets.same.map(r => r.actual_pnl);
  const affectedPnls = [...buckets.flipped, ...buckets.ineligible].map(r => r.actual_pnl);
  const mean = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  const pnlDelta = (mean(affectedPnls) != null && mean(stablePnls) != null) ? mean(affectedPnls) - mean(stablePnls) : null;

  return {
    setupType, includeUnknown,
    totalConsidered: rows.length,
    preGateExcluded: buckets.preGateExcluded.length,
    reconstructionFailure: buckets.reconstructionFailure.length,
    denom, same: buckets.same.length, flipped: buckets.flipped.length, ineligible: buckets.ineligible.length,
    affectedPct: affectedPct != null ? +affectedPct.toFixed(1) : null,
    oldWindowFidelityPct: oldWindowFidelityChecked > 0 ? +(100 * oldWindowFidelityMatch / oldWindowFidelityChecked).toFixed(1) : null,
    oldWindowFidelityChecked,
    meanPnlStable: mean(stablePnls) != null ? +mean(stablePnls).toFixed(2) : null,
    meanPnlAffected: mean(affectedPnls) != null ? +mean(affectedPnls).toFixed(2) : null,
    pnlDelta: pnlDelta != null ? +pnlDelta.toFixed(2) : null,
    verdict: affectedPct == null ? 'INSUFFICIENT_DATA'
      : (affectedPct >= FLIP_THRESHOLD_PCT || (pnlDelta != null && Math.abs(pnlDelta) >= PNL_MATERIALITY)) ? 'OPTION_2_BACKFILL' : 'OPTION_1_REACCUMULATE',
  };
}

// ── STOP_SWEEP_LONG / STOP_SWEEP_SHORT ───────────────────────────────────────
async function analyzeStopSweep(setupType) {
  const rows = (await query(`
    SELECT id, trade_date::text as trade_date, fired_at::text as fired_at, t1_label,
      EXTRACT(hour FROM fired_at)*60+EXTRACT(minute FROM fired_at) as et_min
    FROM active_setups
    WHERE setup_type=$1 AND ${REAL_TRADE_FILTER}
      AND resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED') AND actual_pnl IS NOT NULL
      AND trade_date < $2
    ORDER BY trade_date
  `, [setupType, FIX_DATE])).rows;

  const ibSweeps = rows.filter(r => r.t1_label && (r.t1_label.startsWith('IB_LOW ') || r.t1_label.startsWith('IB_HIGH ')));
  const buckets = { preGateExcluded: [], reconstructionFailure: [], distances: [] };

  for (const row of ibSweeps) {
    // STOP_SWEEP has no 630 gate -- but a fire before the IB window fully closes (10:30)
    // still only had a partial window live; exclude the same way as the IB-directional check.
    if (row.et_min < IB_GATE_MIN) { buckets.preGateExcluded.push(row); continue; }
    const [oldBars, newBars] = await Promise.all([
      reconstructIbBars(row.trade_date, OLD_WINDOW),
      reconstructIbBars(row.trade_date, NEW_WINDOW),
    ]);
    if (oldBars.length < 3 || newBars.length < 3) { buckets.reconstructionFailure.push(row); continue; }
    const isLow = row.t1_label.startsWith('IB_LOW');
    const oldLevel = isLow ? Math.min(...oldBars.map(b => b.low)) : Math.max(...oldBars.map(b => b.high));
    const newLevel = isLow ? Math.min(...newBars.map(b => b.low)) : Math.max(...newBars.map(b => b.high));
    buckets.distances.push({ id: row.id, level: isLow ? 'IB_LOW' : 'IB_HIGH', dist: Math.abs(newLevel - oldLevel) });
  }

  const n = buckets.distances.length;
  const affected = buckets.distances.filter(d => d.dist >= DIST_THRESHOLD).length;
  const affectedPct = n > 0 ? +(100 * affected / n).toFixed(1) : null;
  const meanDist = n > 0 ? +(buckets.distances.reduce((s, d) => s + d.dist, 0) / n).toFixed(2) : null;
  const maxDist = n > 0 ? Math.max(...buckets.distances.map(d => d.dist)) : null;

  return {
    setupType,
    totalRealFires: rows.length,
    ibLevelSweeps: ibSweeps.length,
    ibLevelSweepPct: rows.length ? +(100 * ibSweeps.length / rows.length).toFixed(1) : null,
    preGateExcluded: buckets.preGateExcluded.length,
    reconstructionFailure: buckets.reconstructionFailure.length,
    n, affected, affectedPct, meanDist, maxDist,
    verdict: affectedPct == null ? 'INSUFFICIENT_DATA' : (affectedPct >= FLIP_THRESHOLD_PCT ? 'OPTION_2_BACKFILL' : 'OPTION_1_REACCUMULATE'),
  };
}

// ── Day-level sanity anchor (independent re-derivation of the lost 51%/12% claim) ──────
async function dayLevelAnchor() {
  const days = (await query(`
    SELECT DISTINCT ts::date::text as d FROM price_bars_primary
    WHERE symbol='NQ' AND ts::date < $1
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 629
    ORDER BY d
  `, [FIX_DATE])).rows.map(r => r.d);

  let bothClassified = 0, agree = 0, flip = 0, disagreeOther = 0;
  for (const d of days) {
    const [oldBars, newBars] = await Promise.all([reconstructIbBars(d, OLD_WINDOW), reconstructIbBars(d, NEW_WINDOW)]);
    if (oldBars.length < 3 || newBars.length < 3) continue;
    const o = computeIbBullBear(oldBars), n = computeIbBullBear(newBars);
    if (!o || !n) continue;
    const oLabel = o.ibBullish ? 'BULL' : o.ibBearish ? 'BEAR' : 'NEITHER';
    const nLabel = n.ibBullish ? 'BULL' : n.ibBearish ? 'BEAR' : 'NEITHER';
    if (oLabel === nLabel) { agree++; continue; }
    if ((oLabel === 'BULL' && nLabel === 'BEAR') || (oLabel === 'BEAR' && nLabel === 'BULL')) flip++;
    else disagreeOther++;
  }
  bothClassified = agree + flip + disagreeOther;
  return {
    totalDays: days.length, bothClassified,
    agreePct: bothClassified ? +(100 * agree / bothClassified).toFixed(1) : null,
    disagreePct: bothClassified ? +(100 * (flip + disagreeOther) / bothClassified).toFixed(1) : null,
    outrightFlipPct: bothClassified ? +(100 * flip / bothClassified).toFixed(1) : null,
  };
}

async function main() {
  console.log('=== Day-level sanity anchor (independent re-derivation, all days before fix) ===');
  console.log(await dayLevelAnchor());

  console.log('\n=== IB_BULLISH ===');
  console.log('(i) REAL_TRADE_FILTER population:', await analyzeIbDirectional('IB_BULLISH', false));
  console.log('(ii) + UNKNOWN population:       ', await analyzeIbDirectional('IB_BULLISH', true));

  console.log('\n=== IB_BEARISH ===');
  console.log('(i) REAL_TRADE_FILTER population:', await analyzeIbDirectional('IB_BEARISH', false));
  console.log('(ii) + UNKNOWN population:       ', await analyzeIbDirectional('IB_BEARISH', true));

  console.log('\n=== STOP_SWEEP_LONG ===');
  console.log(await analyzeStopSweep('STOP_SWEEP_LONG'));

  console.log('\n=== STOP_SWEEP_SHORT ===');
  console.log(await analyzeStopSweep('STOP_SWEEP_SHORT'));

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
