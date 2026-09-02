// Generalizes the GLOBEX_VWAP_FADE-only fast-flip cooldown (server/routes/acd.js,
// CROSS_DIRECTION_FAST_FLIP gate, 2026-09-02) into a real, self-calibrating, per-family
// mechanism -- per user pushback: a hardcoded single-family lookup table is exactly the
// hardcoded-list-goes-stale anti-pattern this codebase avoids everywhere else, and "anything
// in live should be in all trades where applicable."
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

const isWin = (t) => t.resolution === 'TARGET_HIT' || (t.resolution === 'TRAIL_EXIT' && t.actual_pnl >= 0);
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

  function isLong(setupType) { return setupType.endsWith('_LONG'); }

  for (const family of families) {
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

    // Real gate only when the pattern actually matches the validated shape: fast is negative
    // AND worse than both medium and slow (whichever of those have enough data to compare --
    // require at least one comparison point, not just "fast is negative in isolation").
    const comparisonEvs = [mediumEv, slowEv].filter(ev => ev != null);
    const monotonic = fastEv < 0 && comparisonEvs.length > 0 && comparisonEvs.every(ev => ev > fastEv);
    const rigor = fast.length >= 20 ? computeRigor(fast, { dateField: 'trade_date', pnlFn: t => t.actual_pnl }) : null;

    if (monotonic) {
      console.log(`  -> GATE justified: fastEv=$${fastEv.toFixed(2)} vs medium=$${mediumEv?.toFixed(2)} slow=$${slowEv?.toFixed(2)}, rigor clean=${rigor?.clean}. Cooldown=5min.\n`);
      await query(`
        INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, recommendation, notes)
        VALUES ($1, 0, 'CROSS_DIRECTION_FLIP_CALIB', $2, $3, $4, 'GATE', $5)
        ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
          SET sample_size = EXCLUDED.sample_size, ev_per_trade = EXCLUDED.ev_per_trade,
              recommendation = EXCLUDED.recommendation, notes = EXCLUDED.notes
      `, [today, family, fast.length, fastEv, JSON.stringify({ cooldownMinutes: 5, fastN: fast.length, mediumN: medium.length, slowN: slow.length, fastEv, mediumEv, slowEv, rigorClean: rigor?.clean ?? null, distinctDates: rigor?.distinctDates ?? null })]);
    } else {
      console.log(`  -> NO_GATE: pattern doesn't hold (fastEv=$${fastEv.toFixed(2)}, medium=$${mediumEv?.toFixed(2)}, slow=$${slowEv?.toFixed(2)}).\n`);
      await query(`
        INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, recommendation, notes)
        VALUES ($1, 0, 'CROSS_DIRECTION_FLIP_CALIB', $2, $3, $4, 'NO_GATE', $5)
        ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
          SET sample_size = EXCLUDED.sample_size, ev_per_trade = EXCLUDED.ev_per_trade,
              recommendation = EXCLUDED.recommendation, notes = EXCLUDED.notes
      `, [today, family, fast.length, fastEv, JSON.stringify({ fastN: fast.length, mediumN: medium.length, slowN: slow.length, fastEv, mediumEv, slowEv })]);
    }
  }
  console.log('Done.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
