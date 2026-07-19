// Which levels/setups tend to "kick off" the largest continued moves when their fade
// fails? Reuses the exact bar-walk from backtest_post_resolution_sequence.mjs (same
// entry convention, same 240-bar extension window) but ranks by MAGNITUDE of continued
// adverse extension beyond the stop, not just timing/sequencing -- a level that gets
// broken and keeps running hard is a real "this level triggered something bigger"
// signal; a level that gets broken and just drifts a few points is noise.
//
// Run: node scripts/backtest_level_continuation_magnitude.mjs
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const EXTENSION_WINDOW_BARS = 240;

async function main() {
  const tradesRes = await query(`
    SELECT setup_type, fired_at, resolved_at, entry_zone_low::float as entry_zone_low,
      entry_zone_high::float as entry_zone_high, stop_level::float as stop_level,
      mae_points::float as mae_points
    FROM active_setups
    WHERE resolution = 'STOP_HIT' AND mae_points IS NOT NULL AND mfe_points IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300 AND resolved_at IS NOT NULL AND entry_zone_low IS NOT NULL
    ORDER BY resolved_at ASC
  `);
  const trades = tradesRes.rows;
  console.log(`${trades.length} STOP_HIT trades.`);

  const barsRes = await query(`SELECT ts, high::float as high, low::float as low FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low }));

  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  const bySetup = {};
  let processed = 0;
  for (const t of trades) {
    processed++;
    if (processed % 1000 === 0) console.log(`  ${processed}/${trades.length}`);
    const direction = inferDirection(t.setup_type);
    if (!direction) continue;
    const long = direction === 'LONG';
    const entry = t.entry_zone_high ?? t.entry_zone_low;
    const startIdx = firstIndexAfter(new Date(t.resolved_at).getTime());
    const endIdx = Math.min(allBars.length, startIdx + EXTENSION_WINDOW_BARS);

    let finalAdverse = t.mae_points;
    for (let i = startIdx; i < endIdx; i++) {
      const bar = allBars[i];
      const adverse = long ? entry - bar.low : bar.high - entry;
      if (adverse > finalAdverse) finalAdverse = adverse;
    }
    const extensionBeyondStop = finalAdverse - t.mae_points;
    (bySetup[t.setup_type] ||= []).push({ date: t.resolved_at, extension: extensionBeyondStop, finalAdverse });
  }

  const summary = [];
  for (const [setup, rows] of Object.entries(bySetup)) {
    if (rows.length < 20) continue;
    const avgExtension = rows.reduce((s, r) => s + r.extension, 0) / rows.length;
    const bigContinuation = rows.filter(r => r.extension >= 50).length; // 50pt+ further = a real, not-noise continuation
    const rigor = computeRigor(rows, { dateField: 'date', pnlFn: r => r.extension });
    summary.push({ setup_type: setup, n: rows.length, avgExtension: +avgExtension.toFixed(1), bigContinuationPct: +(100 * bigContinuation / rows.length).toFixed(1), rigorClean: rigor.clean });
  }
  summary.sort((a, b) => b.bigContinuationPct - a.bigContinuationPct);
  console.log('\n=== Setups/levels ranked by rate of a REAL (50pt+) continuation beyond the stop ===');
  console.log(JSON.stringify(summary.slice(0, 20), null, 2));

  const today = (await query(`SELECT CURRENT_DATE::text as d`)).rows[0].d;
  for (const s of summary) {
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, notes)
      VALUES ($1, 0, 'LEVEL_CONTINUATION', $2, $3, $4, $5)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
        SET sample_size=EXCLUDED.sample_size, ev_per_trade=EXCLUDED.ev_per_trade, notes=EXCLUDED.notes
    `, [today, s.setup_type, s.n, s.avgExtension, JSON.stringify(s)]);
  }
  console.log(`Persisted ${summary.length} rows (signal_type='LEVEL_CONTINUATION').`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
