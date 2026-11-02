// Creates live_attestations: one row per (trade_date, check) written by the nightly scripts/attest_live_day.py (docs/G0_GAP_AUDIT_20261101.md items 6 and 7). New table only, idempotent.
import { query } from '../server/db.js';
await query(`CREATE TABLE IF NOT EXISTS live_attestations (
  id SERIAL PRIMARY KEY,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  trade_date DATE NOT NULL,
  check_name VARCHAR(40) NOT NULL,
  status VARCHAR(12) NOT NULL CHECK (status IN ('OK','DIVERGENCE','ERROR','SKIPPED')),
  detail JSONB,
  UNIQUE (trade_date, check_name)
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_live_attestations_status ON live_attestations (status, trade_date)`);
console.log('live_attestations ready'); process.exit(0);
