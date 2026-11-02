import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'event_snapshot_allmoments_20261102', dataWindow: 'depth-era 2026-06..2026-10 (RTH, 95 sessions)', kind: 'EXPLORE', tests: 48, label: 'Part B all-moments direction screen with depth: 11 signed features x 4 horizons (44 correlations, BH) + 4 walk-forward ridge models', script: 'scripts/event_snapshots/run_allmoments.py', prereg: 'docs/EVENT_SNAPSHOT_STUDY_20261102.md', ref: 'event_snapshot_allmoments_20261102' });
console.log('look logged id', id); process.exit(0);
