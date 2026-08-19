// One-off validation script for the Regime Intelligence Spec's "Balance Area" Mid/Edge
// classifier (docs/REGIME_INTELLIGENCE_SPEC.md). Written 2026-07-31 because Gemini's phase-1
// re-validation (scratch/antigravity_response.md) fixed the real symbol-filter + timezone
// bugs and re-ran the raw backtests, but never actually imported/called this codebase's real
// rigorDiagnostics functions despite being asked to -- it reasoned about cherry-picking risk
// narratively instead. This closes that gap directly: real computeRigor (day-clustering +
// chronological stability) and computeReplication (does the Mid>Edge relationship generalize
// across the setup roster, or is IB_BEARISH cherry-picked from ~100 setup_types x 7 lookbacks)
// on the corrected, NQ-only, 60-day balance area.
//
// Population is ALL resolved active_setups touches (real + BACKFILL), matching the same scope
// Gemini's corrected re-run used -- real-only counts are reported alongside for comparison,
// per the standing "check origin_status before trusting an active_setups figure" rule.
import pg from 'pg';
import { computeRigor, computeReplication } from '../server/services/rigorDiagnostics.js';

const pool = new pg.Pool({
  user: process.env.PGUSER || 'trader',
  host: process.env.PGHOST || 'localhost',
  database: process.env.PGDATABASE || 'trading_journal',
  password: process.env.PGPASSWORD || 'trader123',
  port: process.env.PGPORT || 5432,
});

async function run() {
  console.log('Loading NQ-only daily bars...');
  const daily = (await pool.query(`
    SELECT date_trunc('day', ts)::date as day, MAX(high)::float as high, MIN(low)::float as low
    FROM price_bars_primary WHERE symbol='NQ' GROUP BY 1 ORDER BY 1
  `)).rows;
  console.log(`${daily.length} daily bars`);

  function balance60(d) {
    const prev = daily.filter(b => new Date(b.day) < d);
    if (prev.length < 60) return null;
    const slice = prev.slice(-60);
    const hi = Math.max(...slice.map(b => b.high));
    const lo = Math.min(...slice.map(b => b.low));
    return { hi, lo, range: hi - lo };
  }

  console.log('Loading resolved active_setups touches...');
  const setups = (await pool.query(`
    SELECT setup_type, fired_at, trade_date::text as trade_date, actual_pnl::float,
           price_at_detection::float, origin_status
    FROM active_setups
    WHERE actual_pnl IS NOT NULL AND price_at_detection IS NOT NULL AND fired_at >= '2023-06-01'
  `)).rows;
  console.log(`${setups.length} resolved touches`);

  for (const s of setups) {
    const ba = balance60(new Date(s.fired_at));
    if (!ba || ba.range === 0) { s.regime = null; continue; }
    const pos = (s.price_at_detection - ba.lo) / ba.range;
    s.regime = (pos >= 0.25 && pos <= 0.75) ? 'Mid' : 'Edge';
  }

  const bySetup = {};
  for (const s of setups) {
    if (!s.regime) continue;
    bySetup[s.setup_type] = bySetup[s.setup_type] || { Mid: [], Edge: [] };
    bySetup[s.setup_type][s.regime].push(s);
  }

  const REAL = x => x.origin_status === 'ACTIVE' || x.origin_status === 'SHADOW';

  const results = [];
  for (const [type, buckets] of Object.entries(bySetup)) {
    if (buckets.Mid.length < 10 || buckets.Edge.length < 10) continue;
    // Fixed 2026-08-19 (validate_balance_area_regime_2x_actual_pnl_bug): active_setups.
    // actual_pnl is already a real dollar value -- the *2 double-counted it, inflating
    // every EV figure this script prints/records by exactly 2x.
    const ev = list => list.reduce((a, x) => a + x.actual_pnl, 0) / list.length;
    const midEv = ev(buckets.Mid), edgeEv = ev(buckets.Edge);
    const midRigor = computeRigor(buckets.Mid, { dateField: 'trade_date', pnlFn: x => x.actual_pnl });
    const edgeRigor = computeRigor(buckets.Edge, { dateField: 'trade_date', pnlFn: x => x.actual_pnl });
    results.push({
      type, midN: buckets.Mid.length, edgeN: buckets.Edge.length,
      midRealN: buckets.Mid.filter(REAL).length, edgeRealN: buckets.Edge.filter(REAL).length,
      midEv: +midEv.toFixed(2), edgeEv: +edgeEv.toFixed(2), gap: +(midEv - edgeEv).toFixed(2),
      midClean: midRigor.clean, midStable: midRigor.stable, midTop5Pct: midRigor.top5DayPct,
      edgeClean: edgeRigor.clean, edgeStable: edgeRigor.stable, edgeTop5Pct: edgeRigor.top5DayPct,
    });
  }

  results.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  console.log(`\n${results.length} setup_types with N>=10 in both Mid60 and Edge60 buckets:\n`);
  console.log('type'.padEnd(30), 'midN/realN', 'edgeN/realN', 'midEV', 'edgeEV', 'gap', 'midClean', 'edgeClean');
  for (const r of results) {
    console.log(
      r.type.padEnd(30),
      `${r.midN}/${r.midRealN}`.padEnd(10),
      `${r.edgeN}/${r.edgeRealN}`.padEnd(11),
      `$${r.midEv}`.padEnd(8), `$${r.edgeEv}`.padEnd(8), `$${r.gap}`.padEnd(8),
      String(r.midClean).padEnd(8), String(r.edgeClean)
    );
  }

  console.log('\n=== IB_BEARISH detail ===');
  console.log(JSON.stringify(results.find(r => r.type === 'IB_BEARISH'), null, 2));

  // Replication: does "Mid EV > Edge EV" generalize across the setup roster, or is IB_BEARISH
  // cherry-picked? Treat IB_BEARISH as "selected" (the one spec'd for live gating), everything
  // else is held out.
  const repl = computeReplication(results, {
    idFn: r => r.type,
    metricFn: r => ({ value: r.gap, n: r.midN + r.edgeN }),
    selectedIds: ['IB_BEARISH'],
  });
  console.log('\n=== Replication check: does Mid>Edge (positive gap) generalize beyond IB_BEARISH? ===');
  console.log(JSON.stringify(repl, null, 2));

  const positiveGapCount = results.filter(r => r.gap > 0).length;
  console.log(`\nOf ${results.length} setup_types tested, ${positiveGapCount} show Mid EV > Edge EV (${(100 * positiveGapCount / results.length).toFixed(0)}%). 50% would be pure chance.`);

  await pool.end();
}
run().catch(e => { console.error(e); process.exit(1); });
