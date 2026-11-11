#!/usr/bin/env node
// One-time idempotent migration (docs/DB_MIGRATION_PROTOCOL.md; Fable audit F34/F12, docs/FABLE_AUDIT_REVIEW_20261110.md). ADDITIVE ONLY: three views, no table or data change, nothing
// reads them yet. They give the rules hr-006 / hr-007 / hr-009 one definition each instead of ~150 hand-copied filters:
//   real_setups               = active_setups rows passing REAL_TRADE_FILTER exactly as scripts/backtest_setup_status.mjs defines it (ACTIVE/SHADOW origin, MARK_TO_MARKET and
//                               RECOVERY_MTM resolutions excluded, the five *_basis flags not TRUE). It does NOT exclude the 2026-07-09..09-16 16:00-18:00 ET flood (cv-051);
//                               that exclusion was never part of REAL_TRADE_FILTER and callers that need it still apply it. Equality with the filter is what scripts/test_real_views.mjs checks.
//   real_primary_setups       = real_setups AND is_cluster_primary (hr-007: cluster siblings double count).
//   performance_audit_latest  = the newest row per (signal_type, signal_name): DISTINCT ON ... ORDER BY run_date DESC, id DESC (hr-009), served by idx_pa_type_name_run_id.
// Undo: DROP VIEW real_primary_setups; DROP VIEW real_setups; DROP VIEW performance_audit_latest;
import { query } from '../server/db.js';
const FILTER = `origin_status IN ('ACTIVE','SHADOW') AND (resolution_method IS NULL OR resolution_method NOT IN ('MARK_TO_MARKET','RECOVERY_MTM')) AND ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE AND stale_levels_basis IS NOT TRUE`;
await query(`CREATE OR REPLACE VIEW real_setups AS SELECT * FROM active_setups WHERE ${FILTER}`);
await query(`CREATE OR REPLACE VIEW real_primary_setups AS SELECT * FROM real_setups WHERE is_cluster_primary IS TRUE`);
await query(`CREATE OR REPLACE VIEW performance_audit_latest AS SELECT DISTINCT ON (signal_type, signal_name) * FROM performance_audit ORDER BY signal_type, signal_name, run_date DESC, id DESC`);
await query(`COMMENT ON VIEW real_setups IS 'active_setups passing REAL_TRADE_FILTER (scripts/backtest_setup_status.mjs). Fable audit F34, 2026-11-10. Does not exclude the cv-051 flood window.'`);
await query(`COMMENT ON VIEW real_primary_setups IS 'real_setups restricted to is_cluster_primary rows (hr-007). Fable audit F34, 2026-11-10.'`);
await query(`COMMENT ON VIEW performance_audit_latest IS 'Newest performance_audit row per (signal_type, signal_name), hr-009. Filter on signal_type/signal_name; apply value filters AFTER this view. Fable audit F12, 2026-11-10.'`);
console.log('views created'); process.exit(0);
