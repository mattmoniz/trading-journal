// "Post-stop recovery" diagnostic — for every STOP_HIT setup, re-walks price bars PAST
// the point the stop was hit (ignoring the stop, as if the position were never closed)
// to check: does price eventually reach the ORIGINAL target anyway? How much extra
// favorable excursion happens after the stop that active_setups.mae_points/mfe_points
// can never show, because that column's own bar-walk (server/routes/acd.js's
// resolveSetupsByPrice, ~line 299-332) terminates the instant the stop is hit?
//
// Motivated by a real, correct observation (2026-07-18): MFE as currently computed IS
// a proper running max() and correctly survives a retracement WITHIN an open trade --
// but for a trade that gets STOPPED OUT specifically because a retracement breached the
// stop, anything that happens after (including a full recovery + continuation) is
// structurally invisible to the existing data, because the simulated position "closes"
// at the stop. This script is the first attempt to actually see that invisible part.
//
// Method: same entry-price and favorable/adverse convention as the live resolution path
// (entry = entry_zone_high ?? entry_zone_low, matching acd.js exactly) -- reused, not
// reimplemented. For each STOP_HIT trade, continues the bar-walk from resolved_at
// forward up to RECOVERY_WINDOW_BARS additional 1-min bars (a disclosed, chosen cap --
// not derived from data, kept generous but bounded so a "recovery" 3 weeks later isn't
// conflated with the same-session/next-session phenomenon being asked about here).
//
// Persisted to performance_audit as signal_type='POST_STOP_RECOVERY' per the
// "no dead ends" hard rule -- this is exactly the kind of finding that should be
// queryable and re-checkable, not a one-off scratch result.
//
// Run: node scripts/backtest_post_stop_recovery.mjs
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const RECOVERY_WINDOW_BARS = 240; // ~4 hours of 1-min bars past the stop -- disclosed assumption, not data-derived

async function main() {
  console.log('Loading STOP_HIT trades with clean MAE/MFE...');
  const tradesRes = await query(`
    SELECT id, setup_type, fired_at, resolved_at, entry_zone_low::float as entry_zone_low,
      entry_zone_high::float as entry_zone_high, stop_level::float as stop_level,
      t1_level::float as t1_level, mae_points::float as mae_points, mfe_points::float as mfe_points
    FROM active_setups
    WHERE resolution = 'STOP_HIT' AND mae_points IS NOT NULL AND mfe_points IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300 AND resolved_at IS NOT NULL
      AND entry_zone_low IS NOT NULL AND t1_level IS NOT NULL
    ORDER BY resolved_at ASC
  `);
  const trades = tradesRes.rows;
  console.log(`${trades.length} STOP_HIT trades to re-walk.`);

  console.log('Loading NQ price bars (this may take a moment)...');
  const barsRes = await query(`
    SELECT ts, high::float as high, low::float as low FROM price_bars_primary
    WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low }));
  console.log(`${allBars.length} bars loaded.`);

  // Binary search for the first bar index with ts > targetTime
  function firstIndexAfter(targetTime) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (allBars[mid].ts <= targetTime) lo = mid + 1; else hi = mid;
    }
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

    const startIdx = firstIndexAfter(resolvedTime);
    const endIdx = Math.min(allBars.length, startIdx + RECOVERY_WINDOW_BARS);

    let postStopMaxFavorable = t.mfe_points; // start from the already-known pre-stop MFE
    let reachedOriginalTarget = false;
    let barsToRecovery = null;

    for (let i = startIdx; i < endIdx; i++) {
      const bar = allBars[i];
      const favorable = long ? bar.high - entry : entry - bar.low;
      if (favorable > postStopMaxFavorable) postStopMaxFavorable = favorable;

      const t1Hit = long ? bar.high >= t.t1_level : bar.low <= t.t1_level;
      if (t1Hit && !reachedOriginalTarget) {
        reachedOriginalTarget = true;
        barsToRecovery = i - startIdx + 1;
      }
    }

    results.push({
      setup_type: t.setup_type,
      resolved_at: t.resolved_at,
      original_mfe: t.mfe_points,
      original_mae: t.mae_points,
      post_stop_max_favorable: +postStopMaxFavorable.toFixed(2),
      extra_mfe_beyond_stop: +(postStopMaxFavorable - t.mfe_points).toFixed(2),
      reached_original_target_after_stop: reachedOriginalTarget,
      bars_to_recovery: barsToRecovery,
    });
  }

  console.log(`Processed ${results.length} trades with a known direction.`);

  // Aggregate per setup_type
  const bySetup = {};
  for (const r of results) {
    if (!bySetup[r.setup_type]) bySetup[r.setup_type] = [];
    bySetup[r.setup_type].push(r);
  }

  const summary = [];
  for (const [setup, rows] of Object.entries(bySetup)) {
    if (rows.length < 20) continue; // standing N>=20 floor
    const recovered = rows.filter(r => r.reached_original_target_after_stop);
    const recoveryRate = recovered.length / rows.length;
    const avgExtraMfe = rows.reduce((s, r) => s + r.extra_mfe_beyond_stop, 0) / rows.length;
    const avgBarsToRecovery = recovered.length ? recovered.reduce((s, r) => s + r.bars_to_recovery, 0) / recovered.length : null;
    const rigor = computeRigor(rows, { dateField: 'resolved_at', pnlFn: r => r.reached_original_target_after_stop ? 1 : -1 });
    summary.push({
      setup_type: setup, n: rows.length,
      recoveryRate: +(recoveryRate * 100).toFixed(1),
      avgExtraMfe: +avgExtraMfe.toFixed(1),
      avgBarsToRecovery: avgBarsToRecovery ? +avgBarsToRecovery.toFixed(1) : null,
      rigor,
    });
  }
  summary.sort((a, b) => b.recoveryRate - a.recoveryRate);

  console.log('\n=== Per-setup post-stop recovery summary (N>=20) ===');
  console.log(JSON.stringify(summary, null, 2));

  const overallRecovered = results.filter(r => r.reached_original_target_after_stop).length;
  console.log(`\nOVERALL: ${overallRecovered}/${results.length} (${(100*overallRecovered/results.length).toFixed(1)}%) of STOP_HIT trades would have reached their original target within ${RECOVERY_WINDOW_BARS} bars after the stop.`);

  // Persist
  const today = (await query(`SELECT CURRENT_DATE::text as d`)).rows[0].d;
  for (const s of summary) {
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, notes)
      VALUES ($1, 0, 'POST_STOP_RECOVERY', $2, $3, $4, $5, $6)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
        SET sample_size=EXCLUDED.sample_size, win_rate=EXCLUDED.win_rate, ev_per_trade=EXCLUDED.ev_per_trade, notes=EXCLUDED.notes
    `, [today, s.setup_type, s.n, s.recoveryRate, s.avgExtraMfe, JSON.stringify({ recovery_window_bars: RECOVERY_WINDOW_BARS, ...s })]);
  }
  console.log(`Persisted ${summary.length} setup_type rows to performance_audit (signal_type='POST_STOP_RECOVERY').`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
