#!/usr/bin/env node
// Migration 2026-10-19: perf_snapshots, the persisted performance/health record behind server/services/perfTelemetry.js.
// kind: SNAPSHOT (one per ~5 min), DEPLOY (written at each server start: marks which git sha is running from here on),
// INCIDENT (evidence bundle captured when a metric stays out of its pre-deploy range during the post-deploy watch), VERDICT (one per deploy, written when the watch ends: post-deploy vs pre-deploy medians per metric). Flat numeric columns for the
// metrics the regression check and per-deploy report compare; everything else in jsonb. New table -> no backup needed.
// Idempotent.
import { query } from '../server/db.js';
async function main() {
  await query(`CREATE TABLE IF NOT EXISTS perf_snapshots (
    id bigserial PRIMARY KEY,
    captured_at timestamptz NOT NULL DEFAULT now(),
    kind varchar(10) NOT NULL CHECK (kind IN ('SNAPSHOT','DEPLOY','INCIDENT','VERDICT')),
    deploy_sha varchar(40),
    boot_id varchar(30),
    session varchar(8),
    interval_s integer,
    db_time_pct numeric,
    query_calls integer,
    detect_calls integer,
    detect_avg_ms numeric,
    detect_max_ms numeric,
    loop_p99_ms numeric,
    poll_outages integer,
    entry_delay_p50_s numeric,
    entry_delay_p90_s numeric,
    metrics jsonb,
    regression jsonb
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_perf_snapshots_kind_time ON perf_snapshots (kind, captured_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_perf_snapshots_sha ON perf_snapshots (deploy_sha, session)`);
  // existing installs created before VERDICT was added
  await query(`ALTER TABLE perf_snapshots DROP CONSTRAINT IF EXISTS perf_snapshots_kind_check`);
  await query(`ALTER TABLE perf_snapshots ADD CONSTRAINT perf_snapshots_kind_check CHECK (kind IN ('SNAPSHOT','DEPLOY','INCIDENT','VERDICT'))`);
  console.log('perf_snapshots ready');
}
main().then(() => process.exit(0)).catch((e) => { console.error('Migration failed:', e); process.exit(1); });
