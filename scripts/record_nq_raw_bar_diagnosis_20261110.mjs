// Records the 2026-11-10 night Phase A diagnosis of the NQ raw minute-bar contamination (docs/NQ_RAW_BAR_REPAIR_20261110.md).
// Read-only diagnosis: price, volume and row counts only, no outcome label, so no ledger look. Nothing in price_bars was changed.
import { recordClaim } from './record_claim.mjs';
import { flagDecision } from './flag_decision.mjs';

async function main() {
  const c = await recordClaim({
    slug: 'nq_minute_bars_five_minute_overwrite_20261110',
    claimText: 'MEASURED 2026-11-10 against tick-built 1-minute bars (NQM25, NQU25, NQM26 .scid files). On 2025-05-29..2025-08-20 (72 dates) every on-the-minute raw price_bars row whose minute is a multiple of 5 is the 5-minute bar STARTING there (276 of 276 equal the five tick minutes on OHLC and volume on 2025-07-15 and 2025-08-12), so 20 percent of minutes are wrong (OHLC-equal 80.0-85.9 percent per date) and on-minute volume is 1.73-1.79x the tick volume before any off-minute row. On 2025-05-29..06-13 the rows labelled NQU25 carry NQM25 prices (NQM25-labelled rows match ticks exactly), and the contract calendar switched to NQU25 18 days early because the copy has 1.8x the volume (day-volume ranking). Dates 2025-08-21..29 and 2026-04-27..29 have exact on-minute rows. The off-minute rows (56,092 on 76 dates) are never the only row of a minute. Deleting the off-minute rows alone therefore repairs only 6 dates (2025-08-21, 22, 24, 25 and 2026-04-28, 29).',
    sourceFile: 'docs/NQ_RAW_BAR_REPAIR_20261110.md', sourceDate: '2026-11-10', sampleSize: 72, rigorStatus: 'not_checked', status: 'CONFIRMED',
    extra: { off_minute_rows: 56092, off_minute_dates: 76, overwritten_dates: 72, regime_A_dates: 6, tick_sources: 'NQM5.CME.scid, NQU25.scid (price_scale 1), NQM6.CME.scid', repair_changed_nothing: true },
  });
  console.log('claim', c.slug);
  const d = await flagDecision({
    slug: 'nq_raw_volume_rows_repair_20261110', priority: 'MEDIUM',
    decisionText: 'USER GO NEEDED (data repair; Phase A diagnosis done 2026-11-10, NOTHING changed). The earlier plan (delete 56,092 off-minute rows) would NOT repair the bars: on 72 dates (2025-05-29..2025-08-20) every minute that is a multiple of 5 holds a 5-minute bar (20 percent of minutes wrong, volume 1.77x ticks) and 2025-05-29..06-13 carry NQM25 prices under the label NQU25 (calendar switched 18 days early). Proposed repair = backup, delete off-minute rows, rebuild the :x0 minutes from the Sierra ticks (NQU25.scid), delete the mislabelled NQU25 rows 05-29..06-13 and reconcile the calendar to NQM25, refresh the matviews, verify against ticks, re-derive level tables, flag BACKFILL rows (steps in docs/NQ_RAW_BAR_REPAIR_20261110.md). Minimum safe subset: delete the off-minute rows on the 6 dates whose on-minute rows are exact (2025-08-21, 22, 24, 25 and 2026-04-28, 29; 4,401 rows). Needs: the broker flat, outside RTH and the nightly window, the user\'s go for the tick-rebuild upsert (about 20,000 rows).',
    sourceFile: 'docs/NQ_RAW_BAR_REPAIR_20261110.md', sourceDate: '2026-11-10',
  });
  console.log('flagged', d.slug);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
