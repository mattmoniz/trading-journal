import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'tell_burst_confirmation_20261102', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 6, label: 'Tell then follow a large aggressive-volume burst in the next 1-3 bars (variant A) and burst plus break of the signal bar (variant B), TELL vs CONTROL at 15/30/60 minutes', script: 'scripts/amt_context/run_tell_burst.py', prereg: 'docs/TELL_BURST_CONFIRMATION_PREREG_20261102.md', ref: 'tell_burst_confirmation_20261102' });
console.log('look logged id', id); process.exit(0);
