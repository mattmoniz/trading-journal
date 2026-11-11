// Records the 2026-11-10 night results of the data-derived NQ stitch list (scripts/lib/nqRollStitch.mjs) and closes its decision.
// Price-only work: no outcome label was read to build the list, so no ledger look. One real row is flagged bad_bars_basis (cv-001).
import { query } from '../server/db.js';
import { recordClaim } from './record_claim.mjs';
import { flagDecision, resolveDecision } from './flag_decision.mjs';

async function main() {
  const c = await recordClaim({
    slug: 'nq_minute_bars_mixed_volume_rows_20261110',
    claimText: 'MEASURED 2026-11-10 (price and row counts only, no outcome labels). (1) price_bars_primary has 15 contract stitches 2023-03..2026-09 with steps of 165 to 513 points; 8 are not covered by the calendar helper getNqRollWeekDates (2023-03-03, 2023-09-10 18:00, 2023-12-11, 2024-03-11, 2024-12-17, 2025-03-18, 2025-05-29, 2025-09-28). (2) ROOT CAUSE OF hr-070: raw price_bars holds 500-volume bars with off-second timestamps (volume exactly 500) under the calendar contract label on 74 dates 2025-06-01..2025-08-25 (55,260 extra rows) and on 2026-04-28/29 (832 extra rows). The view takes the minute close from the LAST raw row of the minute, so the minute close is the close of a volume bar that ends later (look-ahead in close; high/low can leak; volume inflated). 2025-05-29/30 hold mixed-contract prices (adjacent-minute steps of 40-90 points). 85 bad-bar dates in total, all in the hold-out era except 2023-03-06..09; the explore era 2023-04..2025-05-16 has no mixing. (3) Exposure in active_setups: 2,199 BACKFILL and 237 UNKNOWN rows fired on a bad-bar date, zero real rows; one real row (121094, SHADOW POC_ROTATION_JOIN_SHORT) was stopped out by the +296 point 2026-09-14 stitch and is now flagged bad_bars_basis. Tick-built 500-volume-bar studies (tell, vacuum, turn) do not read these minute bars.',
    sourceFile: 'scripts/lib/data/nq_roll_stitches.json', sourceDate: '2026-11-10', sampleSize: 85, rigorStatus: 'not_checked', status: 'CONFIRMED',
    extra: { stitches: 15, stitches_not_in_calendar_helper: 8, bad_bar_dates: 85, backfill_rows_on_bad_dates: 2199, unknown_rows_on_bad_dates: 237, real_rows_on_bad_dates: 0, rebuild: 'node scripts/build_nq_roll_stitches.mjs (weekly job)' },
  });
  console.log('claim', c.slug);
  const before = await query(`SELECT id, bad_bars_basis, actual_pnl FROM active_setups WHERE id = 121094`);
  console.log('row before', JSON.stringify(before.rows[0]));
  const u = await query(`UPDATE active_setups SET bad_bars_basis = TRUE WHERE id = 121094 AND bad_bars_basis IS DISTINCT FROM TRUE RETURNING id`);
  console.log('flagged rows', u.rowCount);
  const r = await resolveDecision('research_roll_exclusion_data_derived_20261110',
    'BUILT 2026-11-10 night (user: "make the most prudent decisions"). scripts/lib/nqRollStitch.mjs + scripts/build_nq_roll_stitches.mjs + scripts/lib/nq_roll_stitch.py + scripts/lib/data/nq_roll_stitches.json, rebuilt weekly. Live calendar helper untouched. 15 stitches (8 outside the calendar helper), 85 bad-bar dates. Claim nq_minute_bars_mixed_volume_rows_20261110. The raw-row repair it uncovered is tracked as nq_raw_volume_rows_repair_20261110 (member of hi_nq_bar_data_repairs_and_derived_tables).');
  console.log('resolved', r.slug);
  const d = await flagDecision({
    slug: 'nq_raw_volume_rows_repair_20261110', priority: 'MEDIUM',
    decisionText: 'USER GO NEEDED (data repair, nothing changed). Member of the umbrella hi_nq_bar_data_repairs_and_derived_tables. Raw price_bars holds 500-volume-bar rows with off-second timestamps under the calendar contract label on 74 dates 2025-06-01..2025-08-25 (55,260 extra rows) and 2026-04-28/29 (832 rows), plus mixed-contract prices on 2025-05-29/30. Effect: the minute close in price_bars_primary is taken from a bar that ends later (look-ahead), volume about 2.7x (hr-070). Proposed repair, per docs/DB_MIGRATION_PROTOCOL.md: back up and delete the off-minute rows (or rebuild those dates from the tick files), rebuild price_bars_dedup_hist, then re-derive level_prices / developing_value_log / acd_daily_log for those dates and flag the 2,199 BACKFILL rows fired there (hr-054, cv-041). Until then research scripts can skip them with unsafeDates() from scripts/lib/nqRollStitch.mjs. Also open: which minute-bar studies touched 2025-06..08 (hold-out era) and need a re-run; 636 files read minute bars, 44 carry any roll guard.',
    sourceFile: 'docs/FABLE_REVIEW_AUDIT_20261110.md', sourceDate: '2026-11-10',
  });
  console.log('flagged', d.slug);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
