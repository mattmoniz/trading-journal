#!/usr/bin/env node
// One-time migration: add ml_models.is_checkpoint. Part of the 2026-09-29 fix for
// "ML verdict instability from daily retrain" (RESEARCH_CLAIM
// ml_verdict_instability_from_daily_retrain_20260929) -- 26.2% of real scored trades
// (1,381 of 5,276) had their TAKE/VETO flip depending on which model_version happened to
// be live, because every read site (mlSiloService.js's getLatestModel(), score_one.py,
// run_silo_scoring.py, mlFireTimeScoring.js) picked `ORDER BY trained_at DESC LIMIT 1` --
// and train.py retrains a genuinely new model_version every night (scripts/
// run_daily_calibration.sh, a deliberate 2026-09-21 design choice, see that script's own
// comment), so "the current verdict" silently changed underneath already-scored trades.
//
// This does NOT stop the nightly retrain -- train.py keeps running exactly as before, and
// its own persisted trained_at/test_auc history in ml_models IS the drift-tracking signal
// the reworked design relies on (CLAUDE.md's own "freeze a canonical checkpoint... keep
// the daily retrain running only as informational drift-tracking" convention, previously
// applied only to the tick_microstructure thread, now generalized here). Only ONE row can
// ever be true at a time (the partial unique index enforces this at the DB level, same
// idiom as active_setups' own touch-instant dedup) -- promote_weekly_checkpoint.mjs is the
// only thing that ever flips it, once a week.
//
// Checked first (per docs/DB_MIGRATION_PROTOCOL.md): no existing column serves this
// purpose -- confirmed via information_schema.columns before writing this.
import { query } from '../server/db.js';

async function main() {
  await query(`ALTER TABLE ml_models ADD COLUMN IF NOT EXISTS is_checkpoint boolean NOT NULL DEFAULT false`);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ml_models_one_checkpoint
    ON ml_models (is_checkpoint) WHERE is_checkpoint = true
  `);

  // Bootstrap: mark whatever is currently latest-trained as the checkpoint, so every read
  // site's `ORDER BY is_checkpoint DESC, trained_at DESC LIMIT 1` fallback has a real row
  // to pick immediately rather than silently falling through to "no model" on the first
  // read after this migration runs.
  const existing = await query(`SELECT model_version FROM ml_models WHERE is_checkpoint = true`);
  if (existing.rows.length > 0) {
    console.log(`Checkpoint already set: ${existing.rows[0].model_version}. No bootstrap needed.`);
  } else {
    const latest = await query(`SELECT model_version FROM ml_models ORDER BY trained_at DESC LIMIT 1`);
    if (latest.rows.length === 0) {
      console.log('No trained models exist yet -- nothing to bootstrap. The next train.py + promote_weekly_checkpoint.mjs run will set the first checkpoint.');
    } else {
      await query(`UPDATE ml_models SET is_checkpoint = true WHERE model_version = $1`, [latest.rows[0].model_version]);
      console.log(`Bootstrapped checkpoint to current latest: ${latest.rows[0].model_version}`);
    }
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
