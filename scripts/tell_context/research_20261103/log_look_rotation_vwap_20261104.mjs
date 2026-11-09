// Logs the ledger look for docs/TELL_ROTATION_VWAP_PREREG_20261104.md BEFORE tell_rotation_vwap.py reads any outcome (hr-023).
import { logLook } from '../../lib/look_ledger.mjs';
const id = await logLook({ family: 'tell_rotation_vwap_20261104', dataWindow: 'explore_1760_entries', kind: 'EXPLORE', tests: 4, label: 'Current 65-point rotation leg direction (T1), rotational VWAP side (T2), VWAP side within agreeing fires (T3) and a static stop beyond the leg pivot (T4) on the 1,760 V1 explore entries before 11:30 ET; day-block CI 98.75 percent (4 counted tests)', script: 'scripts/tell_context/research_20261103/tell_rotation_vwap.py', prereg: 'docs/TELL_ROTATION_VWAP_PREREG_20261104.md', ref: 'tell_rotation_vwap_20261104_look1' });
console.log('look id', id); process.exit(0);
