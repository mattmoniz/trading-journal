// Layer-2 trigger candidate #1 (cheapest to test -- both datasets already exist, this is
// a pure join + correlation, no new data collection): does the day's GARCH_VOL_SCALE
// (already live, performance_audit signal_type='GARCH_VOL_SCALE', a rolling-baseline
// vol-elevation signal, not a static threshold) predict a bigger post-target extension?
//
// If yes, this is a real, already-existing, zero-new-infrastructure candidate for a live
// "hold past target on high-vol days" trigger. If no, don't build on it -- move to the
// next candidate (distance to next known level beyond target).
//
// Extension = TRUE post-resolution favorable extreme (walked EXTENSION_WINDOW_BARS past
// original resolution, same convention as backtest_post_resolution_sequence.mjs) MINUS
// the original target distance -- i.e. how much further price ran than the trade actually
// captured. This is exactly the corrected, untruncated metric the OPEN_DECISION
// (optimal_target_blind_to_post_resolution_continuation) flagged as missing.
//
// Run: node scripts/test_extension_vs_garch_vol.mjs
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const EXTENSION_WINDOW_BARS = 240;

async function main() {
  console.log('Loading TARGET_HIT trades...');
  const tradesRes = await query(`
    SELECT setup_type, fired_at, resolved_at, entry_zone_low::float as entry_zone_low,
      entry_zone_high::float as entry_zone_high, t1_level::float as t1_level, mfe_points::float as mfe_points
    FROM active_setups
    WHERE resolution = 'TARGET_HIT' AND mae_points IS NOT NULL AND mfe_points IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300 AND resolved_at IS NOT NULL
      AND entry_zone_low IS NOT NULL AND t1_level IS NOT NULL
    ORDER BY resolved_at ASC
  `);
  const trades = tradesRes.rows;
  console.log(`${trades.length} TARGET_HIT trades.`);

  console.log('Loading GARCH_VOL_SCALE (daily)...');
  // NOTE: run_date on these rows is the date the backfill SCRIPT ran (all 317 rows share
  // one run_date), not the trading day the scale describes -- that's notes.trade_date.
  const garchRes = await query(`
    SELECT notes FROM performance_audit WHERE signal_type='GARCH_VOL_SCALE'
  `);
  const garchByDate = new Map();
  for (const r of garchRes.rows) {
    try { const n = JSON.parse(r.notes); garchByDate.set(n.trade_date, n.scale); } catch { /* skip malformed */ }
  }
  console.log(`${garchByDate.size} days with a GARCH scale.`);

  console.log('Loading NQ price bars...');
  const barsRes = await query(`SELECT ts, high::float as high, low::float as low FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low }));

  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  const rows = [];
  for (const t of trades) {
    const direction = inferDirection(t.setup_type);
    if (!direction) continue;
    const long = direction === 'LONG';
    const entry = t.entry_zone_high ?? t.entry_zone_low;
    const targetDist = Math.abs(t.t1_level - entry);
    const resolvedTime = new Date(t.resolved_at).getTime();
    const startIdx = firstIndexAfter(resolvedTime);
    const endIdx = Math.min(allBars.length, startIdx + EXTENSION_WINDOW_BARS);
    let finalFavorable = t.mfe_points;
    for (let i = startIdx; i < endIdx; i++) {
      const bar = allBars[i];
      const fav = long ? bar.high - entry : entry - bar.low;
      if (fav > finalFavorable) finalFavorable = fav;
    }
    const extension = finalFavorable - targetDist;
    const tradeDate = new Date(t.fired_at).toISOString().slice(0, 10);
    const garchScale = garchByDate.get(tradeDate);
    if (garchScale == null) continue; // no GARCH row for this date, skip
    rows.push({ setup_type: t.setup_type, date: tradeDate, extension, garchScale });
  }
  console.log(`${rows.length} trades with both extension + GARCH scale available.`);

  // Pearson correlation between garchScale and extension (pooled, all setups)
  const n = rows.length;
  const meanX = rows.reduce((s, r) => s + r.garchScale, 0) / n;
  const meanY = rows.reduce((s, r) => s + r.extension, 0) / n;
  let cov = 0, varX = 0, varY = 0;
  for (const r of rows) {
    cov += (r.garchScale - meanX) * (r.extension - meanY);
    varX += (r.garchScale - meanX) ** 2;
    varY += (r.extension - meanY) ** 2;
  }
  const pearsonR = cov / Math.sqrt(varX * varY);
  console.log(`\nPooled Pearson r (GARCH scale vs extension-beyond-target), N=${n}: ${pearsonR.toFixed(4)}`);

  // Bucket comparison: LOW (scale<0.9) / NORMAL (0.9-1.1) / HIGH (scale>1.1) vol days
  const buckets = { LOW: [], NORMAL: [], HIGH: [] };
  for (const r of rows) {
    if (r.garchScale < 0.9) buckets.LOW.push(r.extension);
    else if (r.garchScale <= 1.1) buckets.NORMAL.push(r.extension);
    else buckets.HIGH.push(r.extension);
  }
  console.log('\nExtension-beyond-target by GARCH vol bucket:');
  for (const [name, exts] of Object.entries(buckets)) {
    if (!exts.length) { console.log(`  ${name}: N=0`); continue; }
    const mean = exts.reduce((a, b) => a + b, 0) / exts.length;
    const sorted = [...exts].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log(`  ${name}: N=${exts.length} mean=${mean.toFixed(1)}pt median=${median.toFixed(1)}pt`);
  }

  // Rigor: day-clustering + 3-way chronological stability on the pooled correlation sign
  // (use extension as pnlFn since that's the metric whose stability we care about)
  const rigor = computeRigor(rows, { pnlFn: r => r.extension });
  console.log('\nRigor (day-clustering/stability of extension distribution):', rigor);

  const today = (await query(`SELECT CURRENT_DATE::text as d`)).rows[0].d;
  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes)
    VALUES ($1, 0, 'RESEARCH_CLAIM', 'garch_vol_predicts_target_extension_size', $2, $3)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET sample_size=EXCLUDED.sample_size, notes=EXCLUDED.notes
  `, [today, n, JSON.stringify({
    claim_text: `Pearson r=${pearsonR.toFixed(4)} between that day's GARCH_VOL_SCALE and post-target extension size (N=${n}). Bucket means: LOW=${(buckets.LOW.reduce((a,b)=>a+b,0)/(buckets.LOW.length||1)).toFixed(1)}pt (N=${buckets.LOW.length}), NORMAL=${(buckets.NORMAL.reduce((a,b)=>a+b,0)/(buckets.NORMAL.length||1)).toFixed(1)}pt (N=${buckets.NORMAL.length}), HIGH=${(buckets.HIGH.reduce((a,b)=>a+b,0)/(buckets.HIGH.length||1)).toFixed(1)}pt (N=${buckets.HIGH.length}).`,
    source_file: 'scripts/test_extension_vs_garch_vol.mjs', source_date: today,
    rigor_status: rigor.clean ? 'clean' : 'flagged', status: 'PROVISIONAL', last_verified_date: today,
    next_recheck_due: today,
  })]);
  console.log('\nPersisted preliminary RESEARCH_CLAIM: garch_vol_predicts_target_extension_size');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
