#!/usr/bin/env node
// One-time idempotent migration (docs/DB_MIGRATION_PROTOCOL.md; Fable audit F12, docs/FABLE_AUDIT_REVIEW_20261110.md): the standard "latest row per (signal_type, signal_name)" read of performance_audit
// (DISTINCT ON (signal_name) ... ORDER BY signal_name, run_date DESC, id DESC, rule hr-009) had no usable index (only the primary key and a unique index led by run_date): a sequential scan of ~390k rows.
// CREATE INDEX CONCURRENTLY IF NOT EXISTS: additive, no table lock on writes, no data change. Undo: DROP INDEX CONCURRENTLY idx_pa_type_name_run_id.
import { query } from '../server/db.js';
const probe = `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT DISTINCT ON (signal_name) signal_name, run_date, id FROM performance_audit WHERE signal_type = 'SETUP_STATUS' ORDER BY signal_name, run_date DESC, id DESC`;
const tail = (r) => r.rows.map(x => x['QUERY PLAN']).filter(l => /Scan|Execution Time|Buffers: shared/.test(l)).slice(0, 4).join(' | ');
console.log('BEFORE:', tail(await query(probe)));
await query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pa_type_name_run_id ON performance_audit (signal_type, signal_name, run_date DESC, id DESC)`);
await query(`ANALYZE performance_audit`);
console.log('AFTER:', tail(await query(probe)));
const v = await query(`SELECT indisvalid FROM pg_index WHERE indexrelid = 'idx_pa_type_name_run_id'::regclass`); console.log('valid:', v.rows[0].indisvalid); process.exit(0);
