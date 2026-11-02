import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'tell_stop_reverse_20261102', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 4, label: 'Tell with a tight stop (k x median bar range, k=1,2), single leg vs stop-and-reverse up to 3 legs, TELL vs CONTROL net per signal', script: 'scripts/amt_context/run_tell_stop_reverse.py', prereg: 'docs/TELL_STOP_AND_REVERSE_PREREG_20261102.md', ref: 'tell_stop_reverse_20261102' });
console.log('look logged id', id); process.exit(0);
