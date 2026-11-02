import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'roster_context_20261102', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 4, label: 'Tell-target test: forecast at the V1 tell entry vs favorable/adverse 30-min excursion (T1, T2 counted; MAE and thirds uncounted)', script: 'scripts/amt_context/run_tell_target.py', prereg: 'scripts/amt_context/PREREG_TELL_TARGET.md', ref: 'tell_target_20261102' });
console.log('look logged id', id); process.exit(0);
