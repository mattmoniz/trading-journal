import { logLook } from '../lib/look_ledger.mjs';
const r = await logLook({ family: 'runner_flow_exit_20261110', dataWindow: 'explore_2023-03-07..2025-05-16 (sealed untouched)', kind: 'EXPLORE', tests: 0,
  label: 'Row 46 PHASE 1 outcome-blind counts: tell entries reaching x ADR20 and carrying a rolling-percentile flow-exhaustion trigger (Argon CTAPE); reads stored V1 MFE only, no P&L',
  script: 'scripts/vacuum_sim/runner_flow_count.py', prereg: 'docs/OPEN_THREADS.md', claimSlug: 'runner_flow_exit_20261110', outcome: 'RUN_PENDING', notes: { counts_only: true, p_and_l_read: false } });
console.log('LOOK_ID', r); process.exit(0);
