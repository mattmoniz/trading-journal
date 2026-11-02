// Creates research_looks: the global ledger of every contact with a data window's outcome labels (docs/AGENTIC_SYSTEM_SCOPE_20261101.md section 9, DeepSeek review).
// New table only, no existing data touched, idempotent. The partial unique index makes a SEALED look spendable once per (family, data_window), enforced by the database.
import { query } from '../server/db.js';
await query(`CREATE TABLE IF NOT EXISTS research_looks (
  id SERIAL PRIMARY KEY,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  family TEXT NOT NULL,
  data_window TEXT NOT NULL,
  window_kind VARCHAR(10) NOT NULL CHECK (window_kind IN ('EXPLORE','SEALED','FORWARD')),
  tests INTEGER NOT NULL DEFAULT 1 CHECK (tests >= 0),
  label TEXT NOT NULL,
  script TEXT,
  prereg TEXT,
  claim_slug TEXT,
  outcome TEXT,
  ref TEXT UNIQUE,
  notes JSONB
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_research_looks_family_window ON research_looks (family, data_window, logged_at)`);
await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_research_looks_sealed_once ON research_looks (family, data_window) WHERE window_kind = 'SEALED'`);
const r = await query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='research_looks' ORDER BY ordinal_position`);
console.log('research_looks columns:', r.rows.map(x => `${x.column_name}:${x.data_type}`).join(', '));
process.exit(0);
