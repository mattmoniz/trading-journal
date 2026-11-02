import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'tell_level_families_20261102', dataWindow: 'explore<=2025-05-16 (stored levels 2023-04..2025-05)', kind: 'EXPLORE', tests: 11, label: 'Part D: the stored level set as 11 families, tell near the nearest level of the family, fade it, TELL vs CONTROL at 30 minutes (15/60 uncounted)', script: 'scripts/amt_context/run_tell_level_families.py', prereg: 'docs/TELL_PULLBACK_AND_LEVEL_DIRECTION_PREREG_20261102.md', ref: 'tell_level_families_20261102' });
console.log('look logged id', id); process.exit(0);
