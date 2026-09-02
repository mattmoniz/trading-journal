/**
 * Tests whether OR5/OR10/OR15/OR30 HIGH/LOW/MID fade families should be POOLED together for
 * cross-direction-fast-flip purposes, instead of treated as fully separate families the way
 * scripts/backtest_cross_direction_fast_flip.mjs currently does (bare `_(LONG|SHORT)$` strip,
 * e.g. 'OR5_HIGH_FADE' and 'OR10_HIGH_FADE' are unrelated keys today).
 *
 * Motivation (user question, 2026-09-02): OR10's window always contains OR5's, and OR15's
 * always contains OR10's, so their High/Low boundaries are frequently the SAME price. Checked
 * directly against level_prices -- CORRECTED 2026-09-02 (DeepSeek review): N=13 is NOT a 90-day
 * subsample, it is the ENTIRE history of OR10/OR15/OR30 (recording only started 2026-08-12; OR5
 * itself has 425 days). Rates by pair (adjacent equality / 13): HIGH 5v10=69.2%, HIGH 10v15=69.2%,
 * LOW 5v10=38.5%, LOW 10v15=61.5%, MID 5v10=15.4% (MUCH weaker -- MID=(HIGH+LOW)/2 needs both
 * extremes unchanged and isn't even monotone across lengths). Structural containment (OR10_HIGH
 * >= OR5_HIGH, OR10_LOW <= OR5_LOW) holds with zero violations across all 13 days -- that nesting,
 * not literal price equality, is the robust justification, especially for LOW/MID. On days where
 * the price IS literally the same, OR5_HIGH_FADE_SHORT and OR10_HIGH_FADE_LONG fade the EXACT SAME
 * real-world level, but the current per-length-separate family scheme lets one fire
 * opposite-direction of the other, still open, completely unblocked by isCrossDirectionFastFlip --
 * the same whipsaw the gate exists to prevent, just hiding behind a naming difference.
 *
 * This script re-runs the EXACT same fast(<=5min)/medium(5-15min)/slow(>15min) EV-gradient
 * methodology as backtest_cross_direction_fast_flip.mjs, but with an alternate family key that
 * pools OR{5,10,15,30}_{HIGH,LOW,MID}_FADE into OR_POOLED_{HIGH,LOW,MID}_FADE for the purpose
 * of finding "was an opposite-direction trade in this pooled group still open." Every other
 * setup_type (non-OR-length families) is left on its normal bare-family key, unaffected --
 * this is scoped narrowly to the specific question asked, not a general re-architecture.
 *
 * Compares: (a) the CURRENT per-length-separate calibration for these OR families (already on
 * file in performance_audit, reprinted here for reference), vs (b) the POOLED alternative's own
 * fast/medium/slow EV gradient + rigor, computed fresh.
 *
 * Run: node scripts/backtest_or_length_pooled_cross_direction.mjs
 */

import { query } from '../server/db.js';
import pool from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const MIN_FAST_N = 20;
const MIN_DISTINCT_DATES = 10;

function isLong(setupType) { return setupType.endsWith('_LONG'); }

// Bare family (unchanged from the live calibration script) for every non-OR-length type;
// pooled family for OR{5,10,15,30}_{HIGH,LOW,MID}_FADE specifically.
function familyKey(setupType, pooled) {
  const bare = setupType.replace(/_(LONG|SHORT)$/, '');
  if (!pooled) return bare;
  const m = bare.match(/^OR\d+_(HIGH|LOW|MID)_FADE$/);
  return m ? `OR_POOLED_${m[1]}_FADE` : bare;
}

async function run() {
  const { rows: allTrades } = await query(`
    SELECT id, trade_date::text as trade_date, setup_type, fired_at::text as fired_at,
           resolved_at::text as resolved_at, resolution, actual_pnl::float as actual_pnl
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND resolution IN ('TARGET_HIT','STOP_HIT','TRAIL_EXIT')
      AND actual_pnl IS NOT NULL AND resolved_at IS NOT NULL
      AND (setup_type LIKE '%_LONG' OR setup_type LIKE '%_SHORT')
      AND setup_type ~ '^OR\\d+_(HIGH|LOW|MID)_FADE_(LONG|SHORT)$'
    ORDER BY fired_at
  `);
  console.log(`N=${allTrades.length} real OR-length fade trades (bare _LONG/_SHORT only, GAP variants excluded -- same scope as the live gate)\n`);

  function computeGradient(pooled) {
    const byBase = new Map();
    for (const t of allTrades) {
      const base = familyKey(t.setup_type, pooled);
      if (!byBase.has(base)) byBase.set(base, []);
      byBase.get(base).push(t);
    }
    const results = new Map();
    for (const [base, list] of byBase) {
      const sorted = [...list].sort((a, b) => a.fired_at.localeCompare(b.fired_at));
      for (const t of sorted) {
        let openOpposite = null;
        for (const cand of sorted) {
          if (cand === t) continue;
          if (isLong(cand.setup_type) !== isLong(t.setup_type) && cand.fired_at <= t.fired_at && cand.resolved_at > t.fired_at) {
            if (!openOpposite || cand.fired_at > openOpposite.fired_at) openOpposite = cand;
          }
        }
        t._mins = openOpposite
          ? (new Date(t.fired_at.replace(' ', 'T') + 'Z').getTime() - new Date(openOpposite.fired_at.replace(' ', 'T') + 'Z').getTime()) / 60000
          : null;
      }
      const overlap = sorted.filter(t => t._mins != null);
      const fast = overlap.filter(t => t._mins <= 5);
      const medium = overlap.filter(t => t._mins > 5 && t._mins <= 15);
      const slow = overlap.filter(t => t._mins > 15);
      const evOf = (b) => b.length ? b.reduce((s, t) => s + t.actual_pnl, 0) / b.length : null;
      results.set(base, {
        overlapN: overlap.length, fastN: fast.length, mediumN: medium.length, slowN: slow.length,
        fastEv: evOf(fast), mediumEv: evOf(medium), slowEv: evOf(slow), fast,
      });
    }
    return results;
  }

  const bareResults = computeGradient(false);
  const pooledResults = computeGradient(true);

  console.log('=== CURRENT (per-length-separate family) -- OR-length families only ===');
  for (const [base, r] of bareResults) {
    if (!/^OR\d+_/.test(base)) continue;
    console.log(`  ${base.padEnd(16)} overlap=${r.overlapN} (fast=${r.fastN}, med=${r.mediumN}, slow=${r.slowN})  fastEv=${r.fastEv?.toFixed(2) ?? 'n/a'} medEv=${r.mediumEv?.toFixed(2) ?? 'n/a'} slowEv=${r.slowEv?.toFixed(2) ?? 'n/a'}`);
  }

  console.log('\n=== POOLED (OR5/OR10/OR15/OR30 combined by HIGH/LOW/MID) ===');
  for (const [base, r] of pooledResults) {
    const monotonic = r.fastEv != null && r.mediumEv != null && r.slowEv != null && r.fastEv < r.mediumEv && r.mediumEv < r.slowEv && r.fastEv < 0;
    const rigor = r.fastN >= MIN_FAST_N ? computeRigor(r.fast, { dateField: 'trade_date', pnlFn: t => t.actual_pnl }) : null;
    const clearsN = r.fastN >= MIN_FAST_N;
    const clearsDates = (rigor?.distinctDates ?? 0) >= MIN_DISTINCT_DATES;
    const verdict = !clearsN ? `THIN_N (fast=${r.fastN} < ${MIN_FAST_N})` : monotonic && clearsDates ? 'GATE-justified' : `NO_GATE (${!monotonic ? 'pattern not monotonic' : 'fails distinct-dates floor'})`;
    console.log(`  ${base.padEnd(16)} overlap=${r.overlapN} (fast=${r.fastN}, med=${r.mediumN}, slow=${r.slowN})  fastEv=${r.fastEv?.toFixed(2) ?? 'n/a'} medEv=${r.mediumEv?.toFixed(2) ?? 'n/a'} slowEv=${r.slowEv?.toFixed(2) ?? 'n/a'}  distinctDates=${rigor?.distinctDates ?? 'n/a'}  -> ${verdict}`);
  }

  // How many additional overlap instances does pooling find that the bare scheme misses entirely?
  let bareOverlapTotal = 0, pooledOverlapTotal = 0;
  for (const [base, r] of bareResults) if (/^OR\d+_/.test(base)) bareOverlapTotal += r.overlapN;
  for (const [, r] of pooledResults) pooledOverlapTotal += r.overlapN;
  console.log(`\nTotal overlap instances: bare=${bareOverlapTotal}, pooled=${pooledOverlapTotal} (pooling finds ${pooledOverlapTotal - bareOverlapTotal} additional cross-length overlaps the bare scheme structurally cannot see)`);

  await pool.end();
}

run().catch(e => { console.error('[backtest_or_length_pooled_cross_direction] ERROR:', e.message, e.stack); process.exit(1); });
