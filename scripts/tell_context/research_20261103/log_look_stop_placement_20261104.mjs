// Logs the ledger look for docs/TELL_STOP_PLACEMENT_ARMS_PREREG_20261104.md BEFORE tell_stop_placement_arms.py reads any outcome (hr-023).
import { logLook } from '../../lib/look_ledger.mjs';
const id = await logLook({ family: 'tell_stop_placement_20261104', dataWindow: 'explore_1760_entries', kind: 'EXPLORE', tests: 4, label: 'Paired stop-placement arms on the same 1,760 V1 explore entries: stop behind node 3, node 4, beyond the running RTH extreme, and V1 on 4-tick (Sierra-style) coarse nodes; day-block CI at 98.75 percent (4 counted tests)', script: 'scripts/tell_context/research_20261103/tell_stop_placement_arms.py', prereg: 'docs/TELL_STOP_PLACEMENT_ARMS_PREREG_20261104.md', ref: 'tell_stop_placement_20261104_look1' });
console.log('look id', id); process.exit(0);
