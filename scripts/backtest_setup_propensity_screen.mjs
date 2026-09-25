// Roster-wide "does this setup have a real travel propensity" screen (2026-09-24, user
// request + DeepSeek design critique of the first draft). Two separate metric families,
// never mixed into one column:
//
//   - CALIBRATED-EXIT setups (stop/target from the same OPTIMAL_STOP-style process): median
//     R-multiple (MFE / that trade's own real risk distance), %>=2x, %>=3x. R-multiple is a
//     fair, comparable metric here because stop and target come from one process.
//   - LEVEL-ANCHORED-EXIT setups (server/config/setupTypes.js's LEVEL_ANCHORED_EXIT_TYPES --
//     stop/target each anchored to their OWN independent real structural level, e.g.
//     A_UP_STRONG/C_PAIRED/TRT family): target-hit rate / stop-hit rate / timeout rate among
//     resolved trades. R-multiple is meaningless here (a real check found it ranging 0.01 to
//     105.50 on the same setup's own trades) -- see CLAUDE.md's Conventions entry.
//
// STABILITY, not a naive Spearman(date, metric) -- DeepSeek correctly flagged that as weak
// (low power at this N, only detects monotonic trend, driven by endpoint outliers). Instead:
// split each setup's real trades chronologically into two halves, compute the metric in each
// half, and put dayBlockedBootstrapDeltaCI() (already built, server/services/rigorDiagnostics.js)
// on the difference. CI excludes zero -> a real, measured change. CI includes zero -> can't
// distinguish stable from noise at this N -- reported honestly as such, not as "stable."
//
// CALIBRATION-DRIFT CHECK (DeepSeek's own flagged gap): for calibrated-exit setups, also
// compare each half's own average risk (stop distance) -- if it moved materially between
// halves (>20% relative), flag the stability read as CONFOUNDED, since a widening/narrowing
// OPTIMAL_STOP calibration can shift the R-multiple average independent of any real edge
// change. Each trade's reach_R already uses ITS OWN point-in-time stop_level (not a current
// value applied retroactively), so this doesn't corrupt any single trade's ratio -- but it
// can still make an early-vs-late COMPARISON misleading if the denominator itself shifted.
//
// N>=20 floor applied to both families; setups below it are still listed (so nothing goes
// silently missing) but flagged THIN_N rather than given a real verdict, matching the
// roster-wide N>=20 significance convention used everywhere else in this codebase.
import { query } from '../server/db.js';
import { dayBlockedBootstrapDeltaCI } from '../server/services/rigorDiagnostics.js';
import { LEVEL_ANCHORED_EXIT_TYPES } from '../server/config/setupTypes.js';
import { recordClaim } from './record_claim.mjs';

const MIN_N = 20;
const CALIB_DRIFT_THRESHOLD = 0.20; // 20% relative change in average risk between halves

async function loadAllRealTrades() {
  const { rows } = await query(`
    SELECT setup_type, trade_date::text as trade_date,
           COALESCE(entry_zone_high, entry_zone_low)::float as entry,
           stop_level::float as stop, mfe_points::float as mfe, resolution
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND (is_cluster_primary IS NULL OR is_cluster_primary = true)
      AND resolution IS NOT NULL
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL
    ORDER BY setup_type, trade_date ASC
  `);
  const byType = new Map();
  for (const r of rows) {
    if (!byType.has(r.setup_type)) byType.set(r.setup_type, []);
    byType.get(r.setup_type).push(r);
  }
  return byType;
}

function median(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
}

function splitHalves(trades) {
  const mid = Math.floor(trades.length / 2);
  return { early: trades.slice(0, mid), late: trades.slice(mid) };
}

function screenCalibratedExit(setupType, trades, atrVerdicts) {
  const withRisk = trades
    .map(t => ({ ...t, risk: Math.abs(t.entry - t.stop) }))
    .filter(t => t.risk > 0 && t.mfe != null);
  if (withRisk.length === 0) return null;
  const withR = withRisk.map(t => ({ ...t, r: t.mfe / t.risk }));
  const rs = withR.map(t => t.r);
  const distinctDays = new Set(withR.map(t => t.trade_date)).size;
  const n = withR.length;
  const thin = n < MIN_N;

  const { early, late } = splitHalves(withR);
  const events = [
    ...early.map(t => ({ date: t.trade_date, group: 'EARLY', pnl: t.r })),
    ...late.map(t => ({ date: t.trade_date, group: 'LATE', pnl: t.r })),
  ];
  let stability = null;
  if (early.length >= 5 && late.length >= 5) {
    const ci = dayBlockedBootstrapDeltaCI(events, `propensity_${setupType}`, { groupA: 'EARLY', groupB: 'LATE' });
    const excludesZero = ci.lo != null && (ci.lo > 0 || ci.hi < 0);
    stability = { lo: ci.lo, hi: ci.hi, excludesZero, direction: excludesZero ? (ci.lo > 0 ? 'IMPROVING' : 'DEGRADING') : 'INCONCLUSIVE_AT_THIS_N' };
  }

  const earlyRisk = early.length ? early.reduce((a, t) => a + t.risk, 0) / early.length : null;
  const lateRisk = late.length ? late.reduce((a, t) => a + t.risk, 0) / late.length : null;
  let calibrationDrift = false;
  if (earlyRisk != null && lateRisk != null && earlyRisk > 0) {
    calibrationDrift = Math.abs(lateRisk - earlyRisk) / earlyRisk > CALIB_DRIFT_THRESHOLD;
  }
  // Refined 2026-09-24 per DeepSeek's own correction: a raw >20% stop-distance shift alone
  // conflates "volatility legitimately widened" (calibration doing its job, fine) with "stops
  // changed for unrelated reasons" (a real confound). check_calibration_drift_vs_atr.mjs
  // regresses each flagged setup's stop distance against contemporaneous ATR and classifies
  // it -- only a real CALIBRATION_CHURN verdict keeps the drift flag; VOLATILITY_DRIVEN
  // clears it, since the R-multiple normalization already absorbs a volatility-driven stop
  // change. A setup not yet run through that check keeps the raw flag (conservative default).
  if (calibrationDrift && atrVerdicts.has(setupType) && atrVerdicts.get(setupType) === 'VOLATILITY_DRIVEN') {
    calibrationDrift = false;
  }

  return {
    setupType, family: 'CALIBRATED_EXIT', n, distinctDays, thin,
    medianR: median(rs), meanR: rs.reduce((a, v) => a + v, 0) / rs.length,
    pct2x: 100 * rs.filter(v => v >= 2).length / rs.length,
    pct3x: 100 * rs.filter(v => v >= 3).length / rs.length,
    stability, calibrationDrift, earlyAvgRisk: earlyRisk, lateAvgRisk: lateRisk,
  };
}

function screenLevelAnchored(setupType, trades) {
  const n = trades.length;
  const distinctDays = new Set(trades.map(t => t.trade_date)).size;
  const thin = n < MIN_N;
  const targetHitRate = 100 * trades.filter(t => t.resolution === 'TARGET_HIT').length / n;
  const stopHitRate = 100 * trades.filter(t => t.resolution === 'STOP_HIT').length / n;
  const timeoutRate = 100 * trades.filter(t => t.resolution === 'TIME_EXPIRED').length / n;

  const { early, late } = splitHalves(trades);
  const events = [
    ...early.map(t => ({ date: t.trade_date, group: 'EARLY', pnl: t.resolution === 'TARGET_HIT' ? 1 : 0 })),
    ...late.map(t => ({ date: t.trade_date, group: 'LATE', pnl: t.resolution === 'TARGET_HIT' ? 1 : 0 })),
  ];
  let stability = null;
  if (early.length >= 5 && late.length >= 5) {
    const ci = dayBlockedBootstrapDeltaCI(events, `propensity_${setupType}`, { groupA: 'EARLY', groupB: 'LATE' });
    const excludesZero = ci.lo != null && (ci.lo > 0 || ci.hi < 0);
    stability = { lo: ci.lo, hi: ci.hi, excludesZero, direction: excludesZero ? (ci.lo > 0 ? 'IMPROVING' : 'DEGRADING') : 'INCONCLUSIVE_AT_THIS_N' };
  }

  return {
    setupType, family: 'LEVEL_ANCHORED', n, distinctDays, thin,
    targetHitRate, stopHitRate, timeoutRate, stability,
  };
}

async function loadAtrVerdicts() {
  const { rows } = await query(`
    SELECT DISTINCT ON (signal_name) signal_name, notes
    FROM performance_audit WHERE signal_type = 'CALIBRATION_DRIFT_ATR_CHECK'
    ORDER BY signal_name, run_date DESC
  `);
  const map = new Map();
  for (const r of rows) {
    const n = typeof r.notes === 'string' ? JSON.parse(r.notes) : r.notes;
    map.set(r.signal_name, n.verdict);
  }
  return map;
}

async function main() {
  const byType = await loadAllRealTrades();
  const atrVerdicts = await loadAtrVerdicts();
  const calibratedResults = [];
  const levelAnchoredResults = [];

  for (const [setupType, trades] of byType) {
    if (LEVEL_ANCHORED_EXIT_TYPES.has(setupType)) {
      const r = screenLevelAnchored(setupType, trades);
      if (r) levelAnchoredResults.push(r);
    } else {
      const r = screenCalibratedExit(setupType, trades, atrVerdicts);
      if (r) calibratedResults.push(r);
    }
  }

  calibratedResults.sort((a, b) => b.medianR - a.medianR);
  levelAnchoredResults.sort((a, b) => b.targetHitRate - a.targetHitRate);

  console.log('\n=== CALIBRATED-EXIT setups (R-multiple), N>=20 only ===');
  for (const r of calibratedResults.filter(r => !r.thin)) {
    const stab = r.stability ? `${r.stability.direction} [${r.stability.lo?.toFixed(2)},${r.stability.hi?.toFixed(2)}]` : 'n/a';
    console.log(`${r.setupType.padEnd(30)} N=${r.n} days=${r.distinctDays} medianR=${r.medianR.toFixed(2)} pct2x=${r.pct2x.toFixed(1)}% stability=${stab}${r.calibrationDrift ? ' [CALIB_DRIFT_FLAG]' : ''}`);
  }
  console.log(`\n(${calibratedResults.filter(r => r.thin).length} more setup_types below N=20, not shown)`);

  console.log('\n=== LEVEL-ANCHORED-EXIT setups (target-hit rate), N>=20 only ===');
  for (const r of levelAnchoredResults.filter(r => !r.thin)) {
    const stab = r.stability ? `${r.stability.direction} [${r.stability.lo?.toFixed(2)},${r.stability.hi?.toFixed(2)}]` : 'n/a';
    console.log(`${r.setupType.padEnd(30)} N=${r.n} days=${r.distinctDays} targetHit=${r.targetHitRate.toFixed(1)}% stopHit=${r.stopHitRate.toFixed(1)}% timeout=${r.timeoutRate.toFixed(1)}% stability=${stab}`);
  }
  console.log(`\n(${levelAnchoredResults.filter(r => r.thin).length} more setup_types below N=20, not shown)`);

  // Persist all results (including thin ones, so nothing is silently missing) for the
  // quick-check.html Models section's new "Propensity" tab to read.
  for (const r of [...calibratedResults, ...levelAnchoredResults]) {
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes)
      VALUES (CURRENT_DATE, 0, 'SETUP_PROPENSITY_SCREEN', $1, $2, $3)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
        sample_size = EXCLUDED.sample_size, notes = EXCLUDED.notes
    `, [r.setupType, r.n, JSON.stringify(r)]);
  }
  console.log(`\nPersisted ${calibratedResults.length + levelAnchoredResults.length} setup_type rows to performance_audit (SETUP_PROPENSITY_SCREEN).`);

  const driftFlagged = calibratedResults.filter(r => r.calibrationDrift && !r.thin);
  await recordClaim({
    slug: 'setup_propensity_screen_20260924',
    claimText: `Roster-wide travel-propensity screen (${calibratedResults.length} calibrated-exit + ${levelAnchoredResults.length} level-anchored setup_types scanned). ${calibratedResults.filter(r => !r.thin).length} calibrated-exit and ${levelAnchoredResults.filter(r => !r.thin).length} level-anchored setups clear N>=20. Stability measured via period-split + day-blocked-delta-CI (not Spearman-vs-date, per DeepSeek design critique). ${driftFlagged.length} calibrated-exit setups show a >20% average-risk shift between halves (calibration drift), flagged rather than trusted at face value: ${driftFlagged.map(r => r.setupType).join(', ') || 'none'}.`,
    sourceFile: 'scripts/backtest_setup_propensity_screen.mjs',
    sourceDate: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    sampleSize: calibratedResults.length + levelAnchoredResults.length,
    winRate: null, evPerTrade: null,
    rigorStatus: 'period_split_day_blocked_ci',
    status: 'PROVISIONAL',
  });

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
