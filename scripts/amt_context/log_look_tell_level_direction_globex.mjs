import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'tell_level_direction_globex_20261102', dataWindow: 'explore<=2025-05-16 (Globex 18:30-09:00)', kind: 'EXPLORE', tests: 3, label: 'Part C Globex: causal tell variant (no range gate), nearest causal level chooses the side (fade), TELL vs CONTROL at 15/30/60 minutes', script: 'scripts/amt_context/run_tell_level_direction_globex.py', prereg: 'docs/TELL_PULLBACK_AND_LEVEL_DIRECTION_PREREG_20261102.md', ref: 'tell_level_direction_globex_20261102' });
console.log('look logged id', id); process.exit(0);
