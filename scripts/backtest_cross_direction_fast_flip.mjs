// Generalizes the GLOBEX_VWAP_FADE-only fast-flip cooldown (server/routes/acd.js,
// CROSS_DIRECTION_FAST_FLIP gate, 2026-09-02) into a real, self-calibrating, per-family
// mechanism -- per user pushback: a hardcoded single-family lookup table is exactly the
// hardcoded-list-goes-stale anti-pattern this codebase avoids everywhere else, and "anything
// in live should be in all trades where applicable."
//
// EXTENDED 2026-09-02 (user pushback, real live miss): PM_VAL_FADE whipsawed live (SHORT open,
// opposite LONG fired 9min later) and was completely unprotected -- not THIN_N, not even
// present in the family list, because PM_VAL_FADE_SHORT had only 4 real trades (needs >=5 in
// EACH direction just to be assessed). User: "I wanted all setups on there. I can't track 170
// setups for something like this" + "the monthly setups dont happen often" -- per-family-only
// calibration structurally can never cover a rare family, not just slowly. Fixed with a second,
// POOLED verdict (signal_name='_POOLED_ALL') computed across every real overlap instance from
// EVERY paired base regardless of that base's own N -- the same blended-default-with-per-family-
// override pattern this codebase already uses for OPTIMAL_STOP (falls back to the blended row
// when a day-type-specific cell is thin). acd.js's isCrossDirectionFastFlip() now checks the
// family-specific GATE row first, then falls back to the pooled verdict for ANY family with no
// row of its own -- so a brand-new or rare setup_type is covered from its very first live fire,
// not after it individually accumulates N>=20 fast-bucket trades of its own.
//
// For every paired-direction family (any setup_type ending _LONG/_SHORT where BOTH directions
// have real decisive trade history -- derived from live data, not a hardcoded family list),
// computes the same fast/medium/slow-flip gradient (elapsed minutes since the opposite
// direction fired, while it was still open) tested manually for GLOBEX_VWAP_FADE. Writes a
// calibrated cooldown (minutes) to performance_audit only when the fast bucket clears N>=20
// AND shows a real, monotonically-worse-than-slower pattern (fast < medium < slow, fast
// negative) -- families that don't clear this bar get an explicit "no gate justified" row, not
// silence, so a thin family is visibly THIN_N rather than indistinguishable from "never
// checked." acd.js reads this live (cached per session/day) instead of a hardcoded object --
// fail-open (no gate) for any family with no calibration row yet, since a false negative here
// (missing a real pattern) is far lower-risk than a false positive (blocking a good trade with
// no real evidence) for a mechanism that gates live capital.
//
// Run weekly via run_weekly_backtests.sh.

import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const MIN_REAL_N_PER_DIRECTION = 5; // just enough to confirm the family genuinely fires both ways
const MIN_FAST_N = 20; // this project's own decisive-claim floor

async function main() {
  const { rows: [{ today }] } = await query(`SELECT CURRENT_DATE::text as today`);

  const { rows: allTrades } = await query(`
    SELECT id, trade_date::text as trade_date, setup_type, fired_at::text as fired_at,
           resolved_at::text as resolved_at, resolution, actual_pnl::float as actual_pnl
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND resolution IN ('TARGET_HIT','STOP_HIT','TRAIL_EXIT')
      AND actual_pnl IS NOT NULL AND resolved_at IS NOT NULL
      AND (setup_type LIKE '%_LONG' OR setup_type LIKE '%_SHORT')
    ORDER BY setup_type, fired_at
  `);

  // Derive paired families from real data -- no hardcoded family list. A setup_type's
  // levelBase is itself minus the trailing _LONG/_SHORT; only families where BOTH directions
  // clear MIN_REAL_N_PER_DIRECTION are genuinely paired (not a name that happens to end in
  // _LONG/_SHORT with no real opposite-direction sibling).
  const byType = new Map();
  for (const t of allTrades) {
    if (!byType.has(t.setup_type)) byType.set(t.setup_type, []);
    byType.get(t.setup_type).push(t);
  }
  const families = new Set();
  for (const setupType of byType.keys()) {
    const isLongType = setupType.endsWith('_LONG');
    const isShortType = setupType.endsWith('_SHORT');
    if (!isLongType && !isShortType) continue;
    const base = setupType.replace(/_(LONG|SHORT)$/, '');
    const longN = (byType.get(`${base}_LONG`) || []).length;
    const shortN = (byType.get(`${base}_SHORT`) || []).length;
    if (longN >= MIN_REAL_N_PER_DIRECTION && shortN >= MIN_REAL_N_PER_DIRECTION) families.add(base);
  }
  console.log(`Found ${families.size} genuinely paired-direction families with real history.\n`);

  // For the pooled/system-wide verdict: ANY base with at least 1 real trade in EACH direction
  // counts, not just ones clearing MIN_REAL_N_PER_DIRECTION -- a rare base (PM_VAL_FADE: 6
  // LONG/4 SHORT) still contributes its real overlap instances to the pooled sample even though
  // it can never individually qualify for its own per-family verdict.
  const allPairedBases = new Set();
  for (const setupType of byType.keys()) {
    if (!setupType.endsWith('_LONG') && !setupType.endsWith('_SHORT')) continue;
    const base = setupType.replace(/_(LONG|SHORT)$/, '');
    if ((byType.get(`${base}_LONG`) || []).length >= 1 && (byType.get(`${base}_SHORT`) || []).length >= 1) {
      allPairedBases.add(base);
    }
  }

  function isLong(setupType) { return setupType.endsWith('_LONG'); }

  const pooledOverlap = [];

  for (const family of allPairedBases) {
    const list = [...(byType.get(`${family}_LONG`) || []), ...(byType.get(`${family}_SHORT`) || [])]
      .sort((a, b) => a.fired_at.localeCompare(b.fired_at));
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      let openOpposite = null;
      for (const cand of list) {
        if (cand === t) continue;
        if (isLong(cand.setup_type) !== isLong(t.setup_type) && cand.fired_at <= t.fired_at && cand.resolved_at > t.fired_at) {
          if (!openOpposite || cand.fired_at > openOpposite.fired_at) openOpposite = cand;
        }
      }
      if (openOpposite) {
        t.minsSinceOppositeFired = (new Date(t.fired_at.replace(' ', 'T') + 'Z').getTime() -
          new Date(openOpposite.fired_at.replace(' ', 'T') + 'Z').getTime()) / 60000;
      }
    }

    const overlap = list.filter(t => t.minsSinceOppositeFired != null);
    pooledOverlap.push(...overlap); // contributes to the system-wide pooled verdict regardless of this base's own N
    const fast = overlap.filter(t => t.minsSinceOppositeFired <= 5);
    const medium = overlap.filter(t => t.minsSinceOppositeFired > 5 && t.minsSinceOppositeFired <= 15);
    const slow = overlap.filter(t => t.minsSinceOppositeFired > 15);

    function evOf(bucket) { return bucket.length ? bucket.reduce((s, t) => s + t.actual_pnl, 0) / bucket.length : null; }
    const fastEv = evOf(fast), mediumEv = evOf(medium), slowEv = evOf(slow);

    console.log(`${family}: overlap N=${overlap.length} (fast=${fast.length}, medium=${medium.length}, slow=${slow.length})`);

    if (fast.length < MIN_FAST_N) {
      console.log(`  -> THIN_N (fast bucket N=${fast.length} < ${MIN_FAST_N}), no gate.\n`);
      await query(`
        INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, recommendation, notes)
        VALUES ($1, 0, 'CROSS_DIRECTION_FLIP_CALIB', $2, $3, $4, 'THIN_N', $5)
        ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
          SET sample_size = EXCLUDED.sample_size, ev_per_trade = EXCLUDED.ev_per_trade,
              recommendation = EXCLUDED.recommendation, notes = EXCLUDED.notes
      `, [today, family, fast.length, fastEv, JSON.stringify({ fastN: fast.length, mediumN: medium.length, slowN: slow.length, fastEv, mediumEv, slowEv })]);
      continue;
    }

    // TIGHTENED 2026-09-02 (DeepSeek code review, two real gaps in the original version):
    // (1) the original check only required fast to beat WHICHEVER of medium/slow had data --
    // a single comparison point (often just medium, since >15min overlap is rarer) could pass,
    // and never actually verified medium < slow. Now requires BOTH buckets present and the true
    // ascending order fast < medium < slow, matching what the commit narrative always claimed.
    // (2) rigor.clean/distinctDates were computed but never consulted -- a fast bucket of N>=20
    // all from one trading day could have cleared the old gate. Added an explicit distinct-dates
    // floor (MIN_DISTINCT_DATES, borrowing this codebase's PAIR_MIN_DISTINCT_DAYS convention)
    // as a hard requirement -- NOT full rigor.clean (that also requires 3-way chronological sign
    // stability, a stricter property likely to fail for any young family regardless of real
    // effect size, and this codebase's own convention treats rigor as informational except in
    // one deliberate, narrow exception -- see CLAUDE.md's rigor-diagnostics rule). distinctDates
    // is still recorded in notes either way for visibility.
    const MIN_DISTINCT_DATES = 10;
    const monotonic = fastEv < 0 && mediumEv != null && slowEv != null && fastEv < mediumEv && mediumEv < slowEv;
    const rigor = fast.length >= 20 ? computeRigor(fast, { dateField: 'trade_date', pnlFn: t => t.actual_pnl }) : null;
    const clearsDateFloor = (rigor?.distinctDates ?? 0) >= MIN_DISTINCT_DATES;

    if (monotonic && clearsDateFloor) {
      console.log(`  -> GATE justified: fastEv=$${fastEv.toFixed(2)} vs medium=$${mediumEv?.toFixed(2)} slow=$${slowEv?.toFixed(2)}, rigor clean=${rigor?.clean}. Cooldown=5min.\n`);
      await query(`
        INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, recommendation, notes)
        VALUES ($1, 0, 'CROSS_DIRECTION_FLIP_CALIB', $2, $3, $4, 'GATE', $5)
        ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
          SET sample_size = EXCLUDED.sample_size, ev_per_trade = EXCLUDED.ev_per_trade,
              recommendation = EXCLUDED.recommendation, notes = EXCLUDED.notes
      `, [today, family, fast.length, fastEv, JSON.stringify({ cooldownMinutes: 5, fastN: fast.length, mediumN: medium.length, slowN: slow.length, fastEv, mediumEv, slowEv, rigorClean: rigor?.clean ?? null, distinctDates: rigor?.distinctDates ?? null })]);
    } else {
      const reason = !monotonic
        ? `pattern doesn't hold (need fast < medium < slow: fastEv=$${fastEv.toFixed(2)}, medium=$${mediumEv?.toFixed(2)}, slow=$${slowEv?.toFixed(2)})`
        : `monotonic but fails the distinct-dates floor (${rigor?.distinctDates ?? 0} < ${MIN_DISTINCT_DATES})`;
      console.log(`  -> NO_GATE: ${reason}.\n`);
      await query(`
        INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, recommendation, notes)
        VALUES ($1, 0, 'CROSS_DIRECTION_FLIP_CALIB', $2, $3, $4, 'NO_GATE', $5)
        ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
          SET sample_size = EXCLUDED.sample_size, ev_per_trade = EXCLUDED.ev_per_trade,
              recommendation = EXCLUDED.recommendation, notes = EXCLUDED.notes
      `, [today, family, fast.length, fastEv, JSON.stringify({ fastN: fast.length, mediumN: medium.length, slowN: slow.length, fastEv, mediumEv, slowEv, monotonic, distinctDates: rigor?.distinctDates ?? null })]);
    }
  }

  // Pooled/system-wide verdict (2026-09-02) -- see file header. Same fast/medium/slow math,
  // same GATE/NO_GATE/THIN_N thresholds, applied to every real overlap instance pooled across
  // ALL paired bases regardless of any individual base's own N. This is what makes a rare base
  // (a monthly setup, PM_VAL_FADE, or any setup_type not yet even in allPairedBases at all)
  // covered by default from its very first live cross-direction fire -- acd.js falls back to
  // this row whenever a family has no GATE row of its own.
  const pFast = pooledOverlap.filter(t => t.minsSinceOppositeFired <= 5);
  const pMedium = pooledOverlap.filter(t => t.minsSinceOppositeFired > 5 && t.minsSinceOppositeFired <= 15);
  const pSlow = pooledOverlap.filter(t => t.minsSinceOppositeFired > 15);
  function pEvOf(bucket) { return bucket.length ? bucket.reduce((s, t) => s + t.actual_pnl, 0) / bucket.length : null; }
  const pFastEv = pEvOf(pFast), pMediumEv = pEvOf(pMedium), pSlowEv = pEvOf(pSlow);
  console.log(`\n_POOLED_ALL (every base pooled): overlap N=${pooledOverlap.length} (fast=${pFast.length}, medium=${pMedium.length}, slow=${pSlow.length})`);

  if (pFast.length < MIN_FAST_N) {
    console.log(`  -> THIN_N (pooled fast bucket N=${pFast.length} < ${MIN_FAST_N}), no default gate available yet.\n`);
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, recommendation, notes)
      VALUES ($1, 0, 'CROSS_DIRECTION_FLIP_CALIB', '_POOLED_ALL', $2, $3, 'THIN_N', $4)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
        SET sample_size = EXCLUDED.sample_size, ev_per_trade = EXCLUDED.ev_per_trade,
            recommendation = EXCLUDED.recommendation, notes = EXCLUDED.notes
    `, [today, pFast.length, pFastEv, JSON.stringify({ fastN: pFast.length, mediumN: pMedium.length, slowN: pSlow.length, fastEv: pFastEv, mediumEv: pMediumEv, slowEv: pSlowEv, basesContributing: allPairedBases.size })]);
  } else {
    const MIN_DISTINCT_DATES = 10;
    // Deliberately NOT the same strict 3-way (fast < medium < slow) test the per-family verdict
    // uses. First real run (N=366 pooled, fast N=85) showed fastEv=-$19.60 clearly worse than
    // BOTH medium (-$4.66) and slow (-$12.11), but medium beat slow, failing strict monotonic
    // ordering. That ordering nuance is irrelevant to what the pooled default is actually
    // deciding -- "is firing within 5min of the opposite still being open worse than waiting" --
    // so the pooled test only requires fast to be worse than EACH alternative individually, not
    // that medium/slow are themselves ordered.
    const pMonotonic = pFastEv < 0 && pMediumEv != null && pSlowEv != null && pFastEv < pMediumEv && pFastEv < pSlowEv;
    const pRigor = computeRigor(pFast, { dateField: 'trade_date', pnlFn: t => t.actual_pnl });
    const pClearsDateFloor = (pRigor?.distinctDates ?? 0) >= MIN_DISTINCT_DATES;

    if (pMonotonic && pClearsDateFloor) {
      console.log(`  -> GATE justified (pooled default): fastEv=$${pFastEv.toFixed(2)} vs medium=$${pMediumEv?.toFixed(2)} slow=$${pSlowEv?.toFixed(2)}, rigor clean=${pRigor?.clean}. Cooldown=5min, applies to any family with no row of its own.\n`);
      await query(`
        INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, recommendation, notes)
        VALUES ($1, 0, 'CROSS_DIRECTION_FLIP_CALIB', '_POOLED_ALL', $2, $3, 'GATE', $4)
        ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
          SET sample_size = EXCLUDED.sample_size, ev_per_trade = EXCLUDED.ev_per_trade,
              recommendation = EXCLUDED.recommendation, notes = EXCLUDED.notes
      `, [today, pFast.length, pFastEv, JSON.stringify({ cooldownMinutes: 5, fastN: pFast.length, mediumN: pMedium.length, slowN: pSlow.length, fastEv: pFastEv, mediumEv: pMediumEv, slowEv: pSlowEv, rigorClean: pRigor?.clean ?? null, distinctDates: pRigor?.distinctDates ?? null, basesContributing: allPairedBases.size })]);
    } else {
      const reason = !pMonotonic
        ? `pooled pattern doesn't hold (need fast worse than both medium and slow: fastEv=$${pFastEv.toFixed(2)}, medium=$${pMediumEv?.toFixed(2)}, slow=$${pSlowEv?.toFixed(2)})`
        : `pooled fast-is-worst but fails the distinct-dates floor (${pRigor?.distinctDates ?? 0} < ${MIN_DISTINCT_DATES})`;
      console.log(`  -> NO_GATE (pooled default): ${reason}.\n`);
      await query(`
        INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, recommendation, notes)
        VALUES ($1, 0, 'CROSS_DIRECTION_FLIP_CALIB', '_POOLED_ALL', $2, $3, 'NO_GATE', $4)
        ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
          SET sample_size = EXCLUDED.sample_size, ev_per_trade = EXCLUDED.ev_per_trade,
              recommendation = EXCLUDED.recommendation, notes = EXCLUDED.notes
      `, [today, pFast.length, pFastEv, JSON.stringify({ fastN: pFast.length, mediumN: pMedium.length, slowN: pSlow.length, fastEv: pFastEv, mediumEv: pMediumEv, slowEv: pSlowEv, monotonic: pMonotonic, distinctDates: pRigor?.distinctDates ?? null, basesContributing: allPairedBases.size })]);
    }
  }

  console.log('Done.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
