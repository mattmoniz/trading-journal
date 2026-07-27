// scripts/verify_ib_mid_direction_mismatch_20260727.mjs
// Follow-up to OPEN_DECISION level_fade_direction_convention_needs_verification.
// Investigates the one concrete, promising lead from the 2026-07-20 pass: PD_IB_MID_FADE_LONG
// and OR_MID_AFTER_IB_FADE_LONG each mismatched Method 1 (the real RTH nearLevels direction
// formula, confirmed live in acd.js: `approachDir = last5[0].close < currentPrice ?
// FROM_BELOW : FROM_ABOVE; isLong = approachDir === FROM_ABOVE`) on both prior spot-checked
// instances. This checks ALL real (ACTIVE/SHADOW) rows of both types, not just 2 each.
//
// CRITICAL: select fired_at::text directly, never round-trip through `new Date()` before
// using it as a query parameter (the documented, repeated timezone bug in this codebase).
import { query } from '../server/db.js';

async function main() {
  const rows = (await query(`
    SELECT id, setup_type, trade_date::text, fired_at::text as fired_at_str,
           entry_zone_low::float, entry_zone_high::float
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND setup_type IN ('PD_IB_MID_FADE_LONG','OR_MID_AFTER_IB_FADE_LONG')
    ORDER BY setup_type, fired_at
  `)).rows;

  console.log(`Total real rows: ${rows.length}`);
  let agree = 0, disagree = 0;
  const details = [];

  for (const row of rows) {
    const recordedDir = row.setup_type.endsWith('_LONG') ? 'LONG' : 'SHORT';
    // 6 bars ending at (and including) the touch bar — need bars[len-6] as "5 bars ago" and
    // bars[len-1] as "current" (the touch bar itself), matching last5[0]/currentPrice in the
    // live code (last5 = the 5 bars immediately before the touch bar, per acd.js's own
    // rolling window construction — verified by reading the surrounding context, not assumed).
    const barsRes = await query(`
      SELECT ts::text, close::float
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts <= $1::timestamp
      ORDER BY ts DESC
      LIMIT 6
    `, [row.fired_at_str]);
    const bars = barsRes.rows.reverse(); // oldest -> newest, bars[5] = touch bar (current), bars[0] = 5 bars ago
    if (bars.length < 6) { console.log(`  SKIP id=${row.id}: only ${bars.length} bars available`); continue; }

    const currentPrice = bars[5].close;
    const price5BarsAgo = bars[0].close;
    const approachDir = price5BarsAgo < currentPrice ? 'FROM_BELOW' : 'FROM_ABOVE';
    const method1Dir = approachDir === 'FROM_ABOVE' ? 'LONG' : 'SHORT';

    const match = method1Dir === recordedDir;
    if (match) agree++; else disagree++;
    details.push({ id: row.id, setup_type: row.setup_type, fired_at: row.fired_at_str, recordedDir, method1Dir, match, currentPrice, price5BarsAgo });
  }

  console.log(`\nAgree: ${agree}, Disagree: ${disagree}, N=${agree + disagree}`);
  console.log('\nDetails:');
  for (const d of details) {
    console.log(`  id=${d.id} ${d.setup_type} fired=${d.fired_at} recorded=${d.recordedDir} method1=${d.method1Dir} ${d.match ? 'MATCH' : 'MISMATCH'} (5barsAgo=${d.price5BarsAgo} current=${d.currentPrice})`);
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
