// Mirror of scripts/backtest_post_stop_recovery.mjs, for the winning side: for every
// TARGET_HIT setup, re-walks price bars PAST the point the target was hit (ignoring
// that the position "closed" there) to see how much further price continued favorably.
// Same motivation as the stop-side version: active_setups.mfe_points stops updating
// the instant target is hit (server/routes/acd.js resolveSetupsByPrice, ~line 299-332
// `break`s on t1Hit) -- so the current data can't show whether a target is leaving
// real money on the table, only whether it was reached.
//
// Method: identical convention to backtest_post_stop_recovery.mjs -- same entry-price
// definition (entry_zone_high ?? entry_zone_low), same favorable/adverse formulas, same
// RECOVERY_WINDOW_BARS=240 extension window (kept identical on purpose so the two
// analyses are directly comparable, not just individually reasonable).
//
// Persisted to performance_audit as signal_type='POST_TARGET_RUNUP'.
//
// Run: node scripts/backtest_post_target_runup.mjs
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const RUNUP_WINDOW_BARS = 240; // matches backtest_post_stop_recovery.mjs's RECOVERY_WINDOW_BARS

async function main() {
  console.log('Loading TARGET_HIT trades with clean MAE/MFE...');
  const tradesRes = await query(`
    SELECT id, setup_type, fired_at, resolved_at, entry_zone_low::float as entry_zone_low,
      entry_zone_high::float as entry_zone_high, stop_level::float as stop_level,
      t1_level::float as t1_level, mae_points::float as mae_points, mfe_points::float as mfe_points
    FROM active_setups
    WHERE resolution = 'TARGET_HIT' AND mae_points IS NOT NULL AND mfe_points IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300 AND resolved_at IS NOT NULL
      AND entry_zone_low IS NOT NULL AND t1_level IS NOT NULL
    ORDER BY resolved_at ASC
  `);
  const trades = tradesRes.rows;
  console.log(`${trades.length} TARGET_HIT trades to re-walk.`);

  console.log('Loading NQ price bars...');
  const barsRes = await query(`SELECT ts, high::float as high, low::float as low FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low }));
  console.log(`${allBars.length} bars loaded.`);

  function firstIndexAfter(targetTime) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= targetTime) lo = mid + 1; else hi = mid; }
    return lo;
  }

  const results = [];
  let processed = 0;
  for (const t of trades) {
    processed++;
    if (processed % 500 === 0) console.log(`  ${processed}/${trades.length}`);

    const direction = inferDirection(t.setup_type);
    if (!direction) continue;
    const long = direction === 'LONG';
    const entry = t.entry_zone_high ?? t.entry_zone_low;
    const resolvedTime = new Date(t.resolved_at).getTime();
    const targetDistance = Math.abs(t.t1_level - entry);

    const startIdx = firstIndexAfter(resolvedTime);
    const endIdx = Math.min(allBars.length, startIdx + RUNUP_WINDOW_BARS);

    let postTargetMaxFavorable = t.mfe_points; // starts from the already-known at-target MFE
    let postTargetMaxAdverse = t.mae_points;   // does the "already a winner" trade ever round-trip back to a loss-sized move afterward?

    for (let i = startIdx; i < endIdx; i++) {
      const bar = allBars[i];
      const favorable = long ? bar.high - entry : entry - bar.low;
      const adverse = long ? entry - bar.low : bar.high - entry;
      if (favorable > postTargetMaxFavorable) postTargetMaxFavorable = favorable;
      if (adverse > postTargetMaxAdverse) postTargetMaxAdverse = adverse;
    }

    results.push({
      setup_type: t.setup_type,
      resolved_at: t.resolved_at,
      original_target_distance: +targetDistance.toFixed(2),
      original_mfe_at_target: t.mfe_points,
      post_target_max_favorable: +postTargetMaxFavorable.toFixed(2),
      extra_runup_beyond_target: +(postTargetMaxFavorable - t.mfe_points).toFixed(2),
      // how much of the eventual extra run-up was already "at risk" of round-tripping
      // back down -- if post_target_max_adverse grows a lot too, the extra room came
      // with real give-back risk, not free money.
      post_target_max_adverse: +postTargetMaxAdverse.toFixed(2),
    });
  }

  console.log(`Processed ${results.length} trades with a known direction.`);

  const bySetup = {};
  for (const r of results) (bySetup[r.setup_type] ||= []).push(r);

  const summary = [];
  for (const [setup, rows] of Object.entries(bySetup)) {
    if (rows.length < 20) continue;
    const avgExtraRunup = rows.reduce((s, r) => s + r.extra_runup_beyond_target, 0) / rows.length;
    const avgTargetDist = rows.reduce((s, r) => s + r.original_target_distance, 0) / rows.length;
    const pctExtra = avgTargetDist ? (avgExtraRunup / avgTargetDist) * 100 : null;
    const avgPostAdverse = rows.reduce((s, r) => s + r.post_target_max_adverse, 0) / rows.length;
    const rigor = computeRigor(rows, { dateField: 'resolved_at', pnlFn: r => r.extra_runup_beyond_target });
    summary.push({
      setup_type: setup, n: rows.length,
      avgTargetDist: +avgTargetDist.toFixed(1),
      avgExtraRunup: +avgExtraRunup.toFixed(1),
      pctExtraVsTarget: pctExtra ? +pctExtra.toFixed(1) : null,
      avgPostTargetMaxAdverse: +avgPostAdverse.toFixed(1),
      rigor,
    });
  }
  summary.sort((a, b) => b.pctExtraVsTarget - a.pctExtraVsTarget);

  console.log('\n=== Per-setup post-target run-up summary (N>=20) ===');
  console.log(JSON.stringify(summary, null, 2));

  const overallAvgExtra = results.reduce((s, r) => s + r.extra_runup_beyond_target, 0) / results.length;
  console.log(`\nOVERALL: avg extra favorable run-up beyond target, across all ${results.length} TARGET_HIT trades = ${overallAvgExtra.toFixed(1)}pt (within ${RUNUP_WINDOW_BARS} bars after target).`);

  const today = (await query(`SELECT CURRENT_DATE::text as d`)).rows[0].d;
  for (const s of summary) {
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, notes)
      VALUES ($1, 0, 'POST_TARGET_RUNUP', $2, $3, $4, $5)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
        SET sample_size=EXCLUDED.sample_size, ev_per_trade=EXCLUDED.ev_per_trade, notes=EXCLUDED.notes
    `, [today, s.setup_type, s.n, s.avgExtraRunup, JSON.stringify({ runup_window_bars: RUNUP_WINDOW_BARS, ...s })]);
  }
  console.log(`Persisted ${summary.length} setup_type rows to performance_audit (signal_type='POST_TARGET_RUNUP').`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
