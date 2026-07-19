// Layer-2 trigger candidate #2: does the distance from a trade's target to the NEXT known
// level beyond it (in the favorable direction) predict how far price actually extends past
// target? Structural "room to run" signal, using level_prices data already computed for
// every trading day -- if there's a big gap before the next resistance/support past target,
// that's a real reason to expect more room; if another level sits right on top of the
// target, that's a real reason to expect a cap. Candidate #1 (GARCH_VOL_SCALE) tested
// negative (see RESEARCH_CLAIM garch_vol_predicts_target_extension_size) -- this is #2.
//
// Uses the full level_prices set for the trade's date (not restricted to the PIT-safe
// subset used for the Globex test) -- this is a live, same-day, in-progress-trade decision
// question, not a cross-day lookahead-sensitive backtest, so same-day-forming levels
// (IB_HIGH/OR_HIGH/etc.) are legitimately part of "what's the next known level" once a
// trade has already fired. Minor caveat: a handful of levels solidify late in the session,
// so this is a reasonable first-pass approximation, not a perfectly point-in-time-exact one.
//
// Run: node scripts/test_extension_vs_next_level_distance.mjs
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

  console.log('Loading level_prices...');
  const levelsRes = await query(`SELECT trade_date::text as trade_date, level_name, price::float FROM level_prices`);
  const levelsByDate = new Map();
  for (const r of levelsRes.rows) {
    if (!levelsByDate.has(r.trade_date)) levelsByDate.set(r.trade_date, []);
    levelsByDate.get(r.trade_date).push(r);
  }

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
    const targetPrice = t.t1_level;

    const tradeDate = new Date(t.fired_at).toISOString().slice(0, 10);
    const dayLevels = levelsByDate.get(tradeDate) || [];
    // Nearest level BEYOND target in the favorable direction (further from entry than target).
    const beyond = dayLevels
      .map(l => ({ name: l.level_name, price: l.price, dist: long ? l.price - targetPrice : targetPrice - l.price }))
      .filter(l => l.dist > 0.5); // strictly beyond, not right at/behind target
    if (!beyond.length) continue; // no known level beyond target this day -- skip (can't classify "room")
    beyond.sort((a, b) => a.dist - b.dist);
    const nextLevelDist = beyond[0].dist;

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
    rows.push({ setup_type: t.setup_type, date: tradeDate, extension, nextLevelDist });
  }
  console.log(`${rows.length} trades with a known next-level distance.`);

  const n = rows.length;
  const meanX = rows.reduce((s, r) => s + r.nextLevelDist, 0) / n;
  const meanY = rows.reduce((s, r) => s + r.extension, 0) / n;
  let cov = 0, varX = 0, varY = 0;
  for (const r of rows) {
    cov += (r.nextLevelDist - meanX) * (r.extension - meanY);
    varX += (r.nextLevelDist - meanX) ** 2;
    varY += (r.extension - meanY) ** 2;
  }
  const pearsonR = cov / Math.sqrt(varX * varY);
  console.log(`\nPooled Pearson r (next-level distance vs extension-beyond-target), N=${n}: ${pearsonR.toFixed(4)}`);

  // Quartile comparison -- does a bigger gap to the next level predict a bigger extension?
  const sorted = [...rows].sort((a, b) => a.nextLevelDist - b.nextLevelDist);
  const qSize = Math.floor(n / 4);
  const quartiles = [sorted.slice(0, qSize), sorted.slice(qSize, 2 * qSize), sorted.slice(2 * qSize, 3 * qSize), sorted.slice(3 * qSize)];
  console.log('\nExtension-beyond-target by next-level-gap quartile (Q1=tightest room, Q4=most room):');
  const qLabels = ['Q1 (tightest)', 'Q2', 'Q3', 'Q4 (most room)'];
  quartiles.forEach((q, i) => {
    const mean = q.reduce((s, r) => s + r.extension, 0) / q.length;
    const gapRange = `${q[0].nextLevelDist.toFixed(0)}-${q[q.length - 1].nextLevelDist.toFixed(0)}pt gap`;
    console.log(`  ${qLabels[i]} (${gapRange}): N=${q.length} mean extension=${mean.toFixed(1)}pt`);
  });

  const rigor = computeRigor(rows, { pnlFn: r => r.extension });
  console.log('\nRigor:', rigor);

  const today = (await query(`SELECT CURRENT_DATE::text as d`)).rows[0].d;
  const verdict = Math.abs(pearsonR) > 0.15
    ? `POSITIVE candidate: r=${pearsonR.toFixed(4)} is a real (if modest) correlation -- worth pursuing as a live layer-2 trigger.`
    : `NEGATIVE: r=${pearsonR.toFixed(4)} is too weak to serve as a standalone live trigger.`;
  console.log(`\nVerdict: ${verdict}`);

  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes)
    VALUES ($1, 0, 'RESEARCH_CLAIM', 'next_level_gap_predicts_target_extension_size', $2, $3)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET sample_size=EXCLUDED.sample_size, notes=EXCLUDED.notes
  `, [today, n, JSON.stringify({
    claim_text: `${verdict} Pooled Pearson r=${pearsonR.toFixed(4)} between distance-to-next-known-level-beyond-target and actual post-target extension size (N=${n}). Quartile means (tightest-room to most-room): ${quartiles.map((q,i) => `Q${i+1}=${(q.reduce((s,r)=>s+r.extension,0)/q.length).toFixed(1)}pt`).join(', ')}.`,
    source_file: 'scripts/test_extension_vs_next_level_distance.mjs', source_date: today,
    rigor_status: rigor.clean ? 'clean' : 'flagged', status: Math.abs(pearsonR) > 0.15 ? 'PROVISIONAL' : 'CONFIRMED',
    last_verified_date: today, next_recheck_due: today,
  })]);
  console.log('Persisted RESEARCH_CLAIM: next_level_gap_predicts_target_extension_size');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
