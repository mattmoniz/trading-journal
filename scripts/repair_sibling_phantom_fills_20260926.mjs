// Historical repair for the confirmed sibling-fill-gate bug (OPEN_DECISION
// sibling_fill_gate_resolver_fix_20260925, RESEARCH_CLAIM
// sibling_phantom_fill_inflates_shadow_ev_20260925). Before the 2026-09-25 live fix
// (resolveSetups.js), a confluence-cluster sibling (is_cluster_primary=false) entering at
// its OWN level -- a resting limit, not a fill -- was walked for stop/target from
// fired_at regardless of whether price ever actually traded through that entry. This
// script finds every REAL (origin_status IN ACTIVE/SHADOW), already-resolved sibling row
// whose entry price NEVER traded (checked directly against price_bars_primary, using the
// exact same fill-gate rule the live fix now applies -- see resolveSetups.js's own
// "Cluster-sibling fill gate" comment) and corrects it to NOT_FILLED/null actual_pnl,
// matching what the live resolver would have done had the fix existed at the time.
//
// SCOPE, explicitly: this repairs ONLY the clear-cut "never filled at all" population --
// user request 2026-09-25 ("the erroneous trades that were phantom trades arent valid").
// It does NOT re-walk and re-price the siblings that DID eventually fill but later than
// fired_at (a real, smaller, separate correctness gap the OPEN_DECISION's remaining-work
// text also names -- "later-filled ones get a real re-outcome"). That refinement needs a
// full offline re-walk of the standard stop/target logic and is left for a follow-up,
// tracked under the same OPEN_DECISION slug.
//
// Usage: node scripts/repair_sibling_phantom_fills_20260926.mjs        (dry run, default)
//        node scripts/repair_sibling_phantom_fills_20260926.mjs --write (backs up then repairs)

import pg from 'pg';
import { config } from 'dotenv';
import { resolveDirection } from '../server/config/setupTypes.js';
config();

const WRITE = process.argv.includes('--write');
// Distinct name per run -- CREATE TABLE has no IF NOT EXISTS, so a fixed name across re-runs
// throws a confusing error rather than a clean "already applied" message (DeepSeek review
// finding #2, 2026-09-26). Pass BACKUP_SUFFIX to control it; defaults to today's date.
const BACKUP_TABLE = `active_setups_sibling_unfilled_repair_backup_${process.env.BACKUP_SUFFIX || '20260925'}`;

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost', port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'trading_journal', user: process.env.DB_USER || 'trader',
  password: process.env.DB_PASSWORD || 'trader123',
});

async function main() {
  // Defensive -- this repair's candidate query now reads late_fill_past_expiry_basis (see
  // below), a column the sibling backfill script normally creates. Ensures this script works
  // regardless of which of the two has run first.
  await pool.query(`ALTER TABLE active_setups ADD COLUMN IF NOT EXISTS late_fill_past_expiry_basis boolean`);

  // FIXED 2026-09-26 (self-caught while verifying the expires_at boundary fix above): a
  // re-run of this repair after backfill_sibling_late_fill_outcomes_20260926.mjs has already
  // run will find its own late-filled rows as "candidates" too -- those are DELIBERATELY
  // resolved using bars past expires_at (that is the entire point of the late-fill backfill),
  // so checking them against the narrower [fireMinute, expires_at] window here would always
  // find "no fill" and wrongly re-flag an already-correct row as phantom. Confirmed this
  // actually happened on this session's own round-2 run: all 55 "new phantom" rows found that
  // time were round 1's own correctly-resolved late-fill rows, not genuine newly-found
  // phantoms -- churned back through NOT_FILLED and re-backfilled to the SAME final value (no
  // real corruption, verified directly), but a real latent bug if the underlying bars had ever
  // disagreed on a second pass. A first fix excluded resolution_method='SIBLING_LATE_FILL'
  // only, which missed the backfill script's OWN same-bar branch (resolution_method=
  // 'SAME_BAR_STOP_FIRST', a value the LIVE resolver also produces normally for unrelated
  // rows -- so it can't be blanket-excluded by that string alone) -- caught the same way,
  // re-running this script and finding the identical row "phantom" a second time. The robust
  // marker is the flag column itself, set ONLY by the late-fill backfill and never by the
  // live resolver, regardless of which resolution_method string ends up on the row.
  const { rows: candidates } = await pool.query(`
    SELECT id, setup_type, fired_at::text as fired_at, expires_at::text as expires_at,
           resolved_at::text as resolved_at, entry_zone_low, entry_zone_high,
           stop_level, t1_level, resolution, actual_pnl
    FROM active_setups
    WHERE is_cluster_primary = false
      AND origin_status IN ('ACTIVE','SHADOW')
      AND resolution IS NOT NULL AND resolution != 'NOT_FILLED'
      AND actual_pnl IS NOT NULL
      AND late_fill_past_expiry_basis IS NOT TRUE
    ORDER BY fired_at
  `);
  console.log(`Candidate resolved real sibling rows to check: ${candidates.length}`);

  const phantomIds = [];
  let phantomPnlSum = 0;
  const byType = {};
  for (const row of candidates) {
    const entry = row.entry_zone_high ?? row.entry_zone_low;
    if (entry == null) continue;
    const dir = resolveDirection(row);
    if (dir == null) continue; // same anomaly-skip convention as the live resolver
    const long = dir === 'LONG';
    const fireMinute = row.fired_at.slice(0, 16) + ':00';
    // FIXED 2026-09-26 (DeepSeek code review, batch 1 week-QA pass): this used to be
    // `row.resolved_at || row.expires_at` -- resolved_at is always non-null for a resolved
    // row, so expires_at was dead code, and the fill-check window was wrongly bounded by
    // the PHANTOM resolution time (whenever the buggy pre-fix walk happened to declare a
    // fake stop/target hit) instead of the order's real life. Confirmed real impact: 55
    // additional rows with resolved_at > expires_at were left uncorrected (a fill the buggy
    // window "saw" only existed because it kept checking bars past the order's real expiry).
    // The real fill-check window is the order's actual life: [fireMinute, expires_at].
    const endBound = row.expires_at || row.resolved_at;
    const { rows: bars } = await pool.query(`
      SELECT high, low FROM price_bars_primary
      WHERE symbol='NQ' AND ts >= $1 AND ts <= $2
      ORDER BY ts
    `, [fireMinute, endBound]);
    const filled = bars.some(b => (long ? b.low <= entry : b.high >= entry));
    if (!filled) {
      phantomIds.push(row.id);
      phantomPnlSum += parseFloat(row.actual_pnl);
      byType[row.setup_type] = byType[row.setup_type] || { n: 0, pnl: 0 };
      byType[row.setup_type].n++;
      byType[row.setup_type].pnl += parseFloat(row.actual_pnl);
    }
  }

  console.log(`\nPhantom (never actually filled) rows: ${phantomIds.length} of ${candidates.length}`);
  console.log(`Fake actual_pnl currently attributed to them: $${phantomPnlSum.toFixed(2)}`);
  console.log('\nBy setup_type (top 15 by |pnl|):');
  Object.entries(byType).sort((a, b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl)).slice(0, 15)
    .forEach(([t, v]) => console.log(`  ${t}: n=${v.n} pnl=$${v.pnl.toFixed(2)}`));

  if (!WRITE) {
    console.log('\nDry run only -- no rows changed. Re-run with --write to apply.');
    await pool.end();
    return;
  }

  if (phantomIds.length === 0) {
    console.log('\nNothing to repair.');
    await pool.end();
    return;
  }

  console.log(`\n--write passed. Backing up ${phantomIds.length} rows to ${BACKUP_TABLE}, then correcting them.`);
  await pool.query(`
    CREATE TABLE ${BACKUP_TABLE} AS
    SELECT * FROM active_setups WHERE id = ANY($1::int[])
  `, [phantomIds]);
  const { rows: backupCount } = await pool.query(`SELECT COUNT(*) FROM ${BACKUP_TABLE}`);
  console.log(`Backup table row count: ${backupCount[0].count} (expected ${phantomIds.length})`);
  if (+backupCount[0].count !== phantomIds.length) {
    throw new Error('Backup row count mismatch -- aborting before touching active_setups.');
  }

  const { rowCount } = await pool.query(`
    UPDATE active_setups
    SET status='EXPIRED', resolution='NOT_FILLED', resolution_method='SIBLING_UNFILLED',
        actual_outcome='NOT_FILLED', actual_pnl=NULL, updated_at=NOW()
    WHERE id = ANY($1::int[])
  `, [phantomIds]);
  console.log(`Rows corrected: ${rowCount}`);

  const { rows: verify } = await pool.query(`
    SELECT COUNT(*) FROM active_setups WHERE id = ANY($1::int[]) AND (resolution != 'NOT_FILLED' OR actual_pnl IS NOT NULL)
  `, [phantomIds]);
  console.log(`Post-update rows still NOT matching NOT_FILLED/null (should be 0): ${verify[0].count}`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
