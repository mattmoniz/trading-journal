#!/usr/bin/env node
// STAGED, NOT RUN (needs the user's go; docs/DB_MIGRATION_PROTOCOL.md): repairs the outcome columns of vacuum_live_events rows finalized by the calc_outcome continuous-array bug (exit_note 'flat-clamped%' since 2026-11-09 ~00:00 ET:
// the outcome was written seconds after the fire instead of after the 30th bar). Steps: (1) copy the table to vacuum_live_events_backup_20261109 (add the entry to docs/DB_BACKUP_CATALOG.md in the same commit), (2) NULL the wrong outcome columns
// so the FIXED daemon recomputes them from the session's bars (events of a finished session need the session bar file or a daemon replay; unfilled ones stay NULL and are labelled). The linked order rows are NOT touched (syncExits only looks at ACTIVE rows).
import { query } from '../server/db.js';
const DRY = !process.argv.includes('--go');
const n = (await query(`SELECT count(*)::int n FROM vacuum_live_events WHERE exit_note LIKE 'flat-clamped%' AND trade_date >= '2026-11-09'`)).rows[0].n; console.log(`${n} events carry a premature outcome (flat-clamped) ${DRY ? '(dry run, nothing written; pass --go)' : ''}`);
if (!DRY) {
  await query(`CREATE TABLE IF NOT EXISTS vacuum_live_events_backup_20261109 AS SELECT * FROM vacuum_live_events`);
  const r = await query(`UPDATE vacuum_live_events SET fwd30 = NULL, net_nostop = NULL, net_stop25 = NULL, mfe30 = NULL, mae30 = NULL, outcome_at = NULL, exit_note = 'RESET_CLAMP_BUG' WHERE exit_note LIKE 'flat-clamped%' AND trade_date >= '2026-11-09' RETURNING id`);
  console.log('reset', r.rowCount, 'events; the fixed daemon refills them where the 30th bar exists');
}
process.exit(0);
