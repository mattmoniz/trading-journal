import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'roster_context_20261102', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 4, label: 'Option 2: do first-break side (B1) and the move toward the nearer boundary (B2) sharpen when the forecast says busy; HIGH vs LOW expanding terciles; S60, quarters and lopsided/centered split uncounted', script: 'scripts/amt_context/run_busy_direction.py', prereg: 'scripts/amt_context/PREREG_BUSY_DIRECTION.md', ref: 'busy_direction_20261102' });
console.log('look logged id', id); process.exit(0);
