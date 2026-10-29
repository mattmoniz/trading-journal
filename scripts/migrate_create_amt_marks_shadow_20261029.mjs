// WRITTEN, NOT RUN (2026-10-29): creates the shadow table for the marks shadow system (docs/MARKS_BUILD_FRAMEWORK_20261029.md). Idempotent. Run only after the user approves the shadow phase; follow docs/DB_MIGRATION_PROTOCOL.md.
// Shadow rows live HERE, never in active_setups, so orderSweep/sweepExits can never see them (the hard no-order boundary).
import { query } from '../server/db.js';
async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS amt_marks_shadow (
      id SERIAL PRIMARY KEY,
      trade_date DATE NOT NULL,
      fired_at TIMESTAMP NOT NULL,                 -- naive ET timestamp of the ENTRY bar (u+1), same convention as active_setups.fired_at
      bar_index INT NOT NULL,                      -- confirmation bar u (0..389)
      direction SMALLINT NOT NULL,                 -- +1 long / -1 short: the with-trend trade
      rule VARCHAR(30) NOT NULL,                   -- e.g. SPIKE_COUNTER_TREND
      spike_t INT NOT NULL, spike_ext NUMERIC(10,2) NOT NULL,
      stop_price NUMERIC(10,2) NOT NULL, entry_price NUMERIC(10,2),
      features JSONB NOT NULL,                     -- the context feature vector at u (context.features_at)
      calib_version VARCHAR(16),                   -- params_hash of the MARKS_CTX_CALIB rows used
      gates JSONB,                                 -- G1..G5 decisions logged as tags (ungated shadow)
      detector_version VARCHAR(40) NOT NULL,       -- git sha of spike.py / context.py at fire time
      status VARCHAR(10) NOT NULL DEFAULT 'OPEN',  -- OPEN / CLOSED (completion pass)
      exit_at TIMESTAMP, exit_price NUMERIC(10,2), exit_reason VARCHAR(20), net_dollars NUMERIC(10,2),
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_amt_marks_shadow_touch ON amt_marks_shadow (trade_date, fired_at, direction, rule)`);
  console.log('amt_marks_shadow ready');
}
if (process.argv[1] && process.argv[1].endsWith('migrate_create_amt_marks_shadow_20261029.mjs') && process.argv.includes('--apply')) { migrate().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); }); }
else console.log('NOT RUN: pass --apply after the user approves the shadow phase.');
