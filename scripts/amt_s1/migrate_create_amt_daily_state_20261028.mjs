// New table only; no existing data touched. One row per eligible RTH session: pre-open covariates, S1/S2/S3 states, outcomes. See PASSIVE_TRACKER_PREREG.md.
import { query } from '../../server/db.js';
await query(`CREATE TABLE IF NOT EXISTS amt_daily_state (
  trade_date DATE PRIMARY KEY, symbol TEXT NOT NULL DEFAULT 'NQ', is_forward BOOLEAN NOT NULL,
  atr20 NUMERIC NOT NULL, prior_vah NUMERIC NOT NULL, prior_val NUMERIC NOT NULL, prior_close NUMERIC NOT NULL,
  open_0930 NUMERIC NOT NULL, ib_high NUMERIC NOT NULL, ib_low NUMERIC NOT NULL, ib_va_high NUMERIC, ib_va_low NUMERIC, open_1030 NUMERIC NOT NULL,
  s1_state TEXT NOT NULL CHECK (s1_state IN ('ABOVE','BELOW','INSIDE')),
  s2_state TEXT CHECK (s2_state IN ('MIGRATE_UP','MIGRATE_DN','OVERLAP')),
  s3_state TEXT NOT NULL CHECK (s3_state IN ('MIGRATE_UP','MIGRATE_DN','OVERLAP')),
  gap_atr NUMERIC, onr_atr NUMERIC, prng_atr NUMERIC, ibr_atr NUMERIC, ib_ret_atr NUMERIC,
  y_oc NUMERIC NOT NULL, y_1030 NUMERIC NOT NULL, built_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
await query(`CREATE INDEX IF NOT EXISTS idx_amt_daily_state_fwd ON amt_daily_state (is_forward, trade_date)`);
console.log('amt_daily_state ready'); process.exit(0);
