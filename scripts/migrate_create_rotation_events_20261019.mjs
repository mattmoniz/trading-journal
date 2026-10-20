// Creates rotation_events (one row per confirmed 65pt rotation pivot with context + outcomes). New table only -- no existing data touched. See server/services/rotationEvents.js.
import { query } from '../server/db.js';
await query(`CREATE TABLE IF NOT EXISTS rotation_events (
  id BIGSERIAL PRIMARY KEY, symbol TEXT NOT NULL DEFAULT 'NQ', session TEXT NOT NULL CHECK (session IN ('RTH','GLOBEX')), trade_date DATE NOT NULL, leg_no INT NOT NULL,
  pivot_type TEXT NOT NULL CHECK (pivot_type IN ('HIGH','LOW')), pivot_ts TIMESTAMP NOT NULL, confirm_ts TIMESTAMP NOT NULL, pivot_price NUMERIC NOT NULL, confirm_price NUMERIC NOT NULL, minutes_to_confirm INT,
  atr20 NUMERIC, tod_min INT, dow INT, roll_gap_day BOOLEAN NOT NULL DEFAULT false,
  prior_leg_pts NUMERIC, prior_leg_minutes INT, vol_win_sum NUMERIC, vol_z NUMERIC, flow12 NUMERIC, prior_leg_flow NUMERIC, vwap_dist_atr NUMERIC, stack_n INT, stack_long INT, near_levels JSONB,
  out_ret_15 NUMERIC, out_ret_30 NUMERIC, out_ret_60 NUMERIC, out_ret_120 NUMERIC, out_ret_240 NUMERIC, out_mfe_240 NUMERIC, out_mae_240 NUMERIC, out_full_240 BOOLEAN,
  out_leg_pts NUMERIC, out_leg_minutes INT, out_leg_complete BOOLEAN, built_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (symbol, session, trade_date, pivot_ts, pivot_type))`);
await query(`CREATE INDEX IF NOT EXISTS idx_rotation_events_date ON rotation_events (trade_date, session)`);
console.log('rotation_events ready'); process.exit(0);
