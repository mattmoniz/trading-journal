import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'roster_context_20261102', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 3, label: 'Stop-scale paired simulation on V1 tell trades: widen-only arm (counted), shuffled-scale placebo, symmetric arm and thirds (uncounted)', script: 'scripts/amt_context/run_stop_scale.py', prereg: 'scripts/amt_context/PREREG_STOP_SCALE.md', ref: 'stop_scale_20261102' });
console.log('look logged id', id); process.exit(0);
