// Creates `regime_outlook` (2026-11-02, step 2 of the user's ML plan, docs/REGIME_GAUGE_20261102.md): one row per trade date holding the PRE-OPEN day outlook (expected RTH range from information known at 09:25 ET) and, once the day completes, the realized range.
// New table only, idempotent, no existing data touched (docs/DB_MIGRATION_PROTOCOL.md). trade_date is DATE; created_at TIMESTAMPTZ; nothing here parses a naive timestamp.
import { query } from '../server/db.js';
await query(`CREATE TABLE IF NOT EXISTS regime_outlook (
  trade_date DATE PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  model_version TEXT NOT NULL,
  features JSONB NOT NULL,
  pred_log DOUBLE PRECISION NOT NULL,
  atr20_pts DOUBLE PRECISION NOT NULL,
  expected_range_pts DOUBLE PRECISION NOT NULL,
  ratio_to_atr20 DOUBLE PRECISION NOT NULL,
  bucket TEXT NOT NULL CHECK (bucket IN ('QUIET','NORMAL','BUSY')),
  cutoffs JSONB NOT NULL,
  realized_range_pts DOUBLE PRECISION,
  realized_ratio DOUBLE PRECISION,
  realized_bucket TEXT
)`);
const r = await query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='regime_outlook' ORDER BY ordinal_position`); console.log('regime_outlook: ' + r.rows.map(x => `${x.column_name} ${x.data_type}`).join(', '));
process.exit(0);
