// Creates the live busy-or-quiet forecast tables (docs/FORECAST_SERVICE_20261102.md; study scripts/amt_context/PREREG_ROSTER_CONTEXT.md). New tables only, idempotent (docs/DB_MIGRATION_PROTOCOL.md).
//   forecast_models : versioned model registry (CHAMPION / CHALLENGER / RETIRED), coefficients stored so any forecast can be re-derived.
//   forecast_points : one row per forward decision-grid bar (features + every model's forecast + realized travel once the window has completed). The training/evaluation set of the learning loop.
//   forecast_tags   : the forecast beside every roster fire / tell trade, written OUTCOME-BLIND (no P&L column anywhere in this table).
import { query } from '../server/db.js';
await query(`CREATE TABLE IF NOT EXISTS forecast_models (
  id SERIAL PRIMARY KEY,
  version VARCHAR(40) NOT NULL UNIQUE,
  horizon_min INTEGER NOT NULL,
  role VARCHAR(12) NOT NULL CHECK (role IN ('CHAMPION','CHALLENGER','RETIRED')),
  trained_through DATE NOT NULL,
  train_n INTEGER NOT NULL,
  feature_names JSONB NOT NULL,
  params JSONB NOT NULL,
  notes JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);
await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_forecast_models_one_champion ON forecast_models (horizon_min) WHERE role = 'CHAMPION'`);
await query(`CREATE TABLE IF NOT EXISTS forecast_points (
  trade_date DATE NOT NULL,
  bar_idx INTEGER NOT NULL,
  ts_sec DOUBLE PRECISION NOT NULL,
  features JSONB NOT NULL,
  preds JSONB NOT NULL DEFAULT '{}'::jsonb,
  realized JSONB,
  validated BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (trade_date, bar_idx)
)`);
await query(`CREATE TABLE IF NOT EXISTS forecast_tags (
  kind VARCHAR(12) NOT NULL CHECK (kind IN ('ROSTER_FIRE','TELL_TRADE')),
  ref_id BIGINT NOT NULL,
  trade_date DATE NOT NULL,
  setup_type VARCHAR(80),
  fired_at TIMESTAMP,
  ts_sec DOUBLE PRECISION NOT NULL,
  bar_idx INTEGER NOT NULL,
  in_primary_window BOOLEAN NOT NULL,
  features JSONB NOT NULL,
  preds JSONB NOT NULL,
  validated BOOLEAN NOT NULL DEFAULT false,
  tagged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, ref_id)
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_forecast_tags_date ON forecast_tags (trade_date)`);
for (const t of ['forecast_models', 'forecast_points', 'forecast_tags']) {
  const r = await query(`SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`, [t]); console.log(t + ': ' + r.rows.map(x => x.column_name).join(', '));
}
process.exit(0);
