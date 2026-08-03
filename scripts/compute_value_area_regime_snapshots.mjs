// Nightly computation of the "Pure Measurement Layer" (Parts 1-2 only) from the
// Regime Intelligence work, 2026-07-31 — see docs/OPEN_THREADS.md's 2026-07-31 entry and
// docs/REGIME_INTELLIGENCE_SPEC.md (marked REJECTED, but the tagging idea survives in
// this narrower form). Explicitly NOT the gating/routing engine from that spec — this
// script and the columns it feeds do not suppress or authorize anything. Real forward
// data accumulates for months before anyone decides whether to act on it.
//
// User directive (2026-07-31): must be a TRUE volume-weighted value area, not a plain
// high-low range — the original spec's `MAX(high)/MIN(low)` "balance area" was a
// materially different, weaker construct than this codebase's own established value-area
// convention. This script imports the real computeVolumeProfileForRange() (never
// reimplements the volume-bucketing math) for every one of the 7 lookback windows.
//
// For a given snapshot_date, each lookback's value area is computed over the N most
// recent TRADING days strictly BEFORE snapshot_date (no lookahead — matches every other
// prior-period level in this codebase). Position/label of a live touch against these
// boundaries is computed separately, at fire time, in server/routes/acd.js.
//
// Usage: node scripts/compute_value_area_regime_snapshots.mjs [YYYY-MM-DD]
//   Defaults to today (ET). Safe to re-run (ON CONFLICT DO UPDATE).
import { query } from '../server/db.js';
import { computeVolumeProfileForRange } from '../server/services/developingValueService.js';

const LOOKBACKS = [10, 20, 30, 45, 60, 90, 180];

async function run() {
  const argDate = process.argv[2];
  const { rows: [{ today }] } = await query(
    argDate ? `SELECT $1::date::text as today` : `SELECT CURRENT_DATE::text as today`,
    argDate ? [argDate] : []
  );
  console.log(`Computing value-area regime snapshots for ${today}...`);

  const tradingDaysQ = await query(`
    SELECT DISTINCT ts::date::text as d FROM price_bars_primary
    WHERE symbol='NQ' AND ts::date < $1
    ORDER BY d DESC LIMIT $2
  `, [today, Math.max(...LOOKBACKS)]);
  const tradingDays = tradingDaysQ.rows.map(r => r.d);

  if (tradingDays.length < Math.min(...LOOKBACKS)) {
    console.log(`Only ${tradingDays.length} prior NQ trading days available — too early to compute even the smallest lookback (${Math.min(...LOOKBACKS)}). Exiting.`);
    process.exit(0);
  }

  for (const L of LOOKBACKS) {
    if (tradingDays.length < L) {
      console.log(`  ${L}d: only ${tradingDays.length} trading days available, skipping`);
      continue;
    }
    const window = tradingDays.slice(0, L); // most recent L days, descending
    const startDate = window[window.length - 1]; // oldest in window
    const endDate = window[0]; // most recent (yesterday relative to `today`)
    const profile = await computeVolumeProfileForRange(query, { symbol: 'NQ', startDate, endDate });
    if (!profile) {
      console.log(`  ${L}d: computeVolumeProfileForRange returned null (insufficient bars), skipping`);
      continue;
    }
    await query(`
      INSERT INTO value_area_regime_snapshots (snapshot_date, lookback_days, vah, val, poc, total_vol)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (snapshot_date, lookback_days) DO UPDATE
        SET vah = EXCLUDED.vah, val = EXCLUDED.val, poc = EXCLUDED.poc,
            total_vol = EXCLUDED.total_vol, computed_at = NOW()
    `, [today, L, profile.vah, profile.val, profile.poc, profile.totalVol]);
    console.log(`  ${L}d [${startDate}..${endDate}]: VAH=${profile.vah} VAL=${profile.val} POC=${profile.poc}`);
  }

  console.log('Done.');
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
