#!/usr/bin/env node
// Migration 2026-10-19 (v2 of the post-deploy watch): memory / pool columns on perf_snapshots, the EXPECT kind (an intended effect registered
// before a change: scripts/perf_expect.mjs), and job_timings (duration of each scheduled calibration step, compared with its own history).
// New columns/table only, nothing existing is touched. Idempotent.
import { query } from '../server/db.js';
async function main() {
  await query(`ALTER TABLE perf_snapshots ADD COLUMN IF NOT EXISTS rss_mb numeric, ADD COLUMN IF NOT EXISTS heap_used_mb numeric, ADD COLUMN IF NOT EXISTS pool_waiting integer`);
  await query(`ALTER TABLE perf_snapshots DROP CONSTRAINT IF EXISTS perf_snapshots_kind_check`);
  await query(`ALTER TABLE perf_snapshots ADD CONSTRAINT perf_snapshots_kind_check CHECK (kind IN ('SNAPSHOT','DEPLOY','INCIDENT','VERDICT','EXPECT'))`);
  await query(`CREATE TABLE IF NOT EXISTS job_timings (
    id bigserial PRIMARY KEY,
    job varchar(30) NOT NULL,
    step varchar(80) NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    duration_s numeric NOT NULL,
    exit_code integer,
    git_sha varchar(40),
    verdict jsonb
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_job_timings_step ON job_timings (job, step, started_at DESC)`);
  console.log('perf watch v2 schema ready');
}
main().then(() => process.exit(0)).catch((e) => { console.error('Migration failed:', e); process.exit(1); });
