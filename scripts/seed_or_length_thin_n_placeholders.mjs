// Seeds a THIN_N SETUP_STATUS placeholder row for each of the 18 new OR10/15/30
// HIGH/LOW/MID FADE LONG/SHORT setup_types, added 2026-08-12 alongside
// docs/OR_LENGTH_SEASONALITY_SPEC.md's Phase 1 wiring.
//
// Why this matters (CLAUDE.md's "New setup type checklist" item 11): a setup_type
// with literally zero rows in active_setups is ABSENT from backtest_setup_status.mjs's
// GROUP BY setup_type population, so it can never get even a THIN_N row from the
// normal pipeline. Since the live candidates-array insert gate treats "absent from
// _suppressedSetups" as "not suppressed," a level with zero history would fire fully
// unsuppressed ACTIVE on its very first real touch. Seeding a THIN_N row here closes
// that gap from the start. Each row self-heals to a real backtest_setup_status.mjs
// row (recommendation recomputed from real data) the moment N>=1 real touch occurs --
// confirmed live precedent: 3M_VAL_FADE_SHORT_OVERNIGHT's identical 2026-07-20 seed
// was correctly superseded within days once real touches started.
import { query } from '../server/db.js';

const WINDOWS = [10, 15, 30];
const LEVELS = ['HIGH', 'LOW', 'MID'];
const DIRECTIONS = ['LONG', 'SHORT'];

async function main() {
  const { rows } = await query(`SELECT CURRENT_DATE::text as today`);
  const today = rows[0].today;
  let seeded = 0, skipped = 0;

  for (const w of WINDOWS) {
    for (const l of LEVELS) {
      for (const d of DIRECTIONS) {
        const setupType = `OR${w}_${l}_FADE_${d}`;
        const existing = await query(
          `SELECT 1 FROM performance_audit WHERE signal_type='SETUP_STATUS' AND signal_name=$1 LIMIT 1`,
          [setupType]
        );
        if (existing.rows.length) { skipped++; continue; }

        const notes = JSON.stringify({
          manual_seed: true,
          reason: 'zero real touches ever -- OR-length wiring newly added 2026-08-12, self-heals to a real row once backtest_setup_status.mjs sees N>=1',
        });
        await query(`
          INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl, recommendation, notes)
          VALUES ($1, 9999, 'SETUP_STATUS', $2, 0, NULL, NULL, NULL, 'THIN_N', $3)
          ON CONFLICT (run_date, window_days, signal_type, signal_name) DO NOTHING
        `, [today, setupType, notes]);
        seeded++;
        console.log(`Seeded THIN_N: ${setupType}`);
      }
    }
  }
  console.log(`\nDone. Seeded ${seeded}, skipped ${skipped} (already had a SETUP_STATUS row).`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
