// Logs the ledger look for docs/TELL_FLOOR_TARGET_PREREG_20261105.md BEFORE tell_floor_target.py computes any floor-target outcome (hr-023). 3 counted tests.
import { logLook } from '../../lib/look_ledger.mjs';
const id = await logLook({ family: 'tell_floor_target_20261105', dataWindow: 'tell_explore_1760_entries_not_sealed', kind: 'EXPLORE', tests: 3, label: 'Tell: profit target at the nearest structure level at least F points ahead (F = causal median MFE of earlier V1 winners) vs V1 and vs a pure distance-F target; paired dollars, day-block CI; hold-out unspent', script: 'scripts/tell_context/research_20261103/tell_floor_target.py', prereg: 'docs/TELL_FLOOR_TARGET_PREREG_20261105.md', ref: 'tell_floor_target_20261105_look1' });
console.log('look id', id); process.exit(0);
