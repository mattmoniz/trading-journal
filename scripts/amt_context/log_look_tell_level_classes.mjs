import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'tell_level_classes_20261102', dataWindow: 'explore<=2025-05-16 (already examined: reference only)', kind: 'EXPLORE', tests: 2, label: 'Part E: tell own direction, AGREE vs DISAGREE with the nearest level, user major/minor classes (minor = floor + Camarilla pivots), y30', script: 'scripts/amt_context/run_tell_level_classes.py', prereg: 'docs/TELL_PULLBACK_AND_LEVEL_DIRECTION_PREREG_20261102.md', ref: 'tell_level_classes_20261102' });
console.log('look logged id', id); process.exit(0);
