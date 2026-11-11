#!/usr/bin/env node
// One-time idempotent migration (docs/DB_MIGRATION_PROTOCOL.md; Fable audit F04/F01, docs/FABLE_AUDIT_REVIEW_20261110.md).
// idx_order_placements_one_stop_per_setup allowed ONE STOP row per setup EVER, so a stop that was cancelled ahead of an exit that
// was then rejected (F04), or that the broker rejected (F05), could never be replaced: placeStopOrder() short-circuited on the
// dead row. The invariant that matters is ONE LIVE stop per setup. This swaps the index for a partial one that ignores dead rows
// (CANCELED / REJECTED / ERROR). FILLED and every working status still occupy the slot, so a second live stop is still impossible.
// Additive-first: the new index is built CONCURRENTLY BEFORE the old one is dropped, so there is never a moment without a guard.
// No data is changed, so no backup table is needed. Undo: DROP INDEX CONCURRENTLY idx_order_placements_one_live_stop_per_setup;
//   CREATE UNIQUE INDEX CONCURRENTLY idx_order_placements_one_stop_per_setup ON order_placements (setup_id) WHERE purpose = 'STOP';
// (the undo only succeeds while no setup has two STOP rows).
import { query } from '../server/db.js';
const NEW = 'idx_order_placements_one_live_stop_per_setup', OLD = 'idx_order_placements_one_stop_per_setup';
const have = async (n) => (await query(`SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)`, [n])).rows[0];
console.log('before:', { old: await have(OLD), new: await have(NEW) });
const bad = await have(NEW);
if (bad && !bad.indisvalid) { await query(`DROP INDEX CONCURRENTLY IF EXISTS ${NEW}`); }
await query(`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${NEW} ON order_placements (setup_id) WHERE purpose = 'STOP' AND status NOT IN ('CANCELED','REJECTED','ERROR')`);
const n = await have(NEW);
if (!n || !n.indisvalid) { console.error('new index missing or invalid; old index left in place'); process.exit(1); }
await query(`DROP INDEX CONCURRENTLY IF EXISTS ${OLD}`);
console.log('after:', { old: await have(OLD), new: await have(NEW) });
process.exit(0);
