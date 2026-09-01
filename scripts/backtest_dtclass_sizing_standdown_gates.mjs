import { query } from '../server/db.js';
import pool from '../server/db.js';
import { computeCase } from '../server/services/caseEngine.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const SIGNAL_TYPE = 'DTCLASS_GATES';

// FIXED (lookahead bug found by Claude audit, 2026-09-01): the original filtered
// `fired_at < $2` -- but a trade that FIRED before this candidate yet only RESOLVED
// after it fired was still open (outcome not yet known) at the candidate's own fire
// moment. Filtering on `resolved_at < $2` instead ensures only trades whose outcome
// was genuinely knowable by the candidate's fire time are counted -- matches the
// live query's own real-time semantics (acd.js ~6237: `status='RESOLVED'` naturally
// only contains already-decided trades at live poll time; a backtest replaying full
// history needs this explicit boundary since the table already contains the future
// relative to any given historical candidate).
async function getLfConsecLosses(tradeDate, firedAt) {
  const { rows } = await query(`
    SELECT resolution FROM active_setups
    WHERE trade_date=$1
      AND origin_status='ACTIVE'
      AND status='RESOLVED'
      AND resolved_at < $2
    ORDER BY fired_at DESC LIMIT 3
  `, [tradeDate, firedAt]);
  let losses = 0, wins = 0;
  for (const r of rows) {
    if (r.resolution === 'STOP_HIT') { if (wins === 0) losses++; else break; }
    else if (r.resolution === 'TARGET_HIT') { if (losses === 0) wins++; else break; }
    else break;
  }
  return losses;
}

const orExpandedCache = new Map();
async function getOrExpanded(tradeDate, firedAt) {
  if (!orExpandedCache.has(tradeDate)) {
    const { rows } = await query(`SELECT a_up_time, a_down_time FROM acd_daily_log WHERE trade_date=$1`, [tradeDate]);
    orExpandedCache.set(tradeDate, rows[0] || { a_up_time: null, a_down_time: null });
  }
  const log = orExpandedCache.get(tradeDate);
  const getMins = t => {
    if (!t) return null;
    const [h,m] = t.split(':');
    return parseInt(h)*60 + parseInt(m);
  };
  const upMins = getMins(log.a_up_time);
  const downMins = getMins(log.a_down_time);
  
  const fDate = new Date(firedAt);
  const firedMins = fDate.getHours() * 60 + fDate.getMinutes();
  
  return (upMins && upMins <= firedMins) || (downMins && downMins <= firedMins);
}

async function getCaseForMoment(cache, tradeDate, firedAtText) {
  const key = `${tradeDate}|${firedAtText}`;
  if (cache.has(key)) return cache.get(key);
  const result = await computeCase(tradeDate, firedAtText);
  cache.set(key, result);
  return result;
}

async function run() {
  console.log(`[backtest_dtclass_gates] Building candidate population...`);
  const { rows: candidates } = await query(`
    SELECT id, trade_date::text as trade_date, setup_type,
           fired_at::text as fired_at, actual_pnl::float as actual_pnl,
           size_multiplier::float as size_multiplier
    FROM active_setups
    WHERE setup_type LIKE '%_FADE_%'
      AND origin_status IN ('ACTIVE','SHADOW')
      AND resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED')
      AND actual_pnl IS NOT NULL
      AND (resolution_method IS NULL OR resolution_method NOT IN ('MARK_TO_MARKET','RECOVERY_MTM'))
    ORDER BY fired_at
  `);
  console.log(`[backtest_dtclass_gates] N=${candidates.length} candidates`);

  const caseCache = new Map();
  const results = [];
  let trendCount = 0;

  for (const c of candidates) {
    let finalRead = null;
    try {
      const caseResult = await getCaseForMoment(caseCache, c.trade_date, c.fired_at);
      finalRead = caseResult?.dayTypeReassessment?.read ?? caseResult?.dayType?.classification ?? null;
    } catch (e) {
      console.error(`computeCase failed: ${e.message}`);
      continue;
    }
    if (!finalRead) continue;

    if (finalRead === 'TREND') trendCount++;

    const lfConsecLosses = await getLfConsecLosses(c.trade_date, c.fired_at);
    const orExpanded = await getOrExpanded(c.trade_date, c.fired_at);

    let deltaA = 0;
    if (finalRead === 'TREND') deltaA = -0.25 * c.actual_pnl;

    let deltaB = 0;
    if (!orExpanded && (finalRead === 'BALANCE' || finalRead === 'TURBULENT')) deltaB = 0.10 * c.actual_pnl;

    let suppressedC = false;
    if (lfConsecLosses >= 2 || (finalRead === 'TREND' && lfConsecLosses >= 1)) suppressedC = true;

    results.push({ ...c, finalRead, lfConsecLosses, orExpanded, deltaA, deltaB, suppressedC });
  }

  // Evaluate Gate A
  const eventsA = results.filter(r => r.finalRead === 'TREND').map(r => ({ date: r.trade_date, contribution: r.deltaA }));
  const rigorA = computeRigor(eventsA, { dateField: 'date', pnlFn: e => e.contribution });
  const totalA = eventsA.reduce((sum, e) => sum + e.contribution, 0);

  // Evaluate Gate B
  const eventsB = results.filter(r => !r.orExpanded && (r.finalRead === 'BALANCE' || r.finalRead === 'TURBULENT')).map(r => ({ date: r.trade_date, contribution: r.deltaB }));
  const rigorB = computeRigor(eventsB, { dateField: 'date', pnlFn: e => e.contribution });
  const totalB = eventsB.reduce((sum, e) => sum + e.contribution, 0);

  // Evaluate Gate C
  const eventsC = results.filter(r => r.suppressedC).map(r => ({ date: r.trade_date, contribution: -r.actual_pnl }));
  const rigorC = computeRigor(eventsC, { dateField: 'date', pnlFn: e => e.contribution });
  const totalC = eventsC.reduce((sum, e) => sum + e.contribution, 0);

  console.log(`\n=== GENERAL ===`);
  console.log(`Total candidates: ${results.length}`);
  console.log(`TREND reads: ${trendCount} (${((trendCount/results.length)*100).toFixed(1)}%)`);

  console.log(`\n=== GATE A (TREND penalty -0.25) ===`);
  console.log(`N=${eventsA.length} Net Delta: $${totalA.toFixed(2)}`);
  console.log(`Rigor:`, JSON.stringify(rigorA));

  console.log(`\n=== GATE B (BALANCE/TURBULENT no OR-expand bonus +0.10) ===`);
  console.log(`N=${eventsB.length} Net Delta: $${totalB.toFixed(2)}`);
  console.log(`Rigor:`, JSON.stringify(rigorB));

  console.log(`\n=== GATE C (STAND DOWN: TREND + loss) ===`);
  console.log(`N=${eventsC.length} suppressed rows, Net Delta (avoided losses minus missed wins): $${totalC.toFixed(2)}`);
  console.log(`Rigor:`, JSON.stringify(rigorC));

  const runDate = new Date().toISOString().split('T')[0];

  // Helper to process claims
  const processClaim = async (gateName, total, events, rigor, rigorStatus) => {
    let verdict = 'NEGATIVE_OR_ZERO';
    if (events.length < 10) verdict = 'TOO_THIN_TO_CONCLUDE';
    else if (total > 0 && rigor.clean) verdict = 'POSITIVE_CLEAN';
    else if (total > 0) verdict = 'POSITIVE_UNSTABLE';

    await recordClaim({
      slug: `dtclass_gate_${gateName.toLowerCase()}`,
      claimText: `Replaying ${gateName} size/filter gate with real-time day-type. Net delta $${total.toFixed(2)} on N=${events.length}.`,
      sourceFile: 'scripts/backtest_dtclass_sizing_standdown_gates.mjs',
      sourceDate: runDate,
      sampleSize: events.length,
      winRate: null,
      evPerTrade: events.length ? total / events.length : null,
      rigorStatus,
      status: 'PROVISIONAL'
    });
    
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, total_pnl, recommendation, notes)
      VALUES ($1, 9999, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
        SET sample_size=EXCLUDED.sample_size, total_pnl=EXCLUDED.total_pnl, recommendation=EXCLUDED.recommendation, notes=EXCLUDED.notes
    `, [runDate, 'DTCLASS_GATES', gateName, events.length, total, verdict, JSON.stringify({ rigor })]);
  };

  await processClaim('A', totalA, eventsA, rigorA, rigorA.clean === true ? 'clean' : rigorA.clean === false ? 'unstable_or_clustered' : 'too_thin');
  await processClaim('B', totalB, eventsB, rigorB, rigorB.clean === true ? 'clean' : rigorB.clean === false ? 'unstable_or_clustered' : 'too_thin');
  await processClaim('C', totalC, eventsC, rigorC, rigorC.clean === true ? 'clean' : rigorC.clean === false ? 'unstable_or_clustered' : 'too_thin');

  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
