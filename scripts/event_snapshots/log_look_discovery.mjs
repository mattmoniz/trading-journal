import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'event_snapshot_20261102', dataWindow: 'depth-era 2026-06..2026-10 (tell events)', kind: 'EXPLORE', tests: 15, label: 'Part A discovery: 15 bar-level snapshot features vs 30-minute continuation score on depth-era V1 tell events; BH, halves, explore confirmation to follow', script: 'scripts/event_snapshots/run_discovery.py', prereg: 'docs/EVENT_SNAPSHOT_STUDY_20261102.md', ref: 'event_snapshot_discovery_20261102' });
console.log('look logged id', id); process.exit(0);
