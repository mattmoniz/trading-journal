import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'tell_level_direction_20261102', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 3, label: 'Tell as timing trigger, nearest market level chooses the side (fade it): TELL vs CONTROL at 15/30/60 minutes, 9 level types', script: 'scripts/amt_context/run_tell_level_direction.py', prereg: 'docs/TELL_PULLBACK_AND_LEVEL_DIRECTION_PREREG_20261102.md', ref: 'tell_level_direction_20261102' });
console.log('look logged id', id); process.exit(0);
