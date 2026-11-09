// Logs the ledger look for docs/TELL_RISK_CAP_COST_CURVE_PREREG_20261104.md BEFORE tell_risk_cap_curve.py reads any outcome (hr-023). Descriptive curve: 0 counted tests.
import { logLook } from '../../lib/look_ledger.mjs';
const id = await logLook({ family: 'tell_risk_cap_20261104', dataWindow: 'explore_1760_entries', kind: 'EXPLORE', tests: 0, label: 'Cost-of-risk curve: the tell stop capped at 40, 60, 80, 100, 150 and 200 points on the 1,760 V1 explore entries; profit given up, worst loss, percentile losses, worst day and drawdown per cap; descriptive, no verdict', script: 'scripts/tell_context/research_20261103/tell_risk_cap_curve.py', prereg: 'docs/TELL_RISK_CAP_COST_CURVE_PREREG_20261104.md', ref: 'tell_risk_cap_20261104_look1' });
console.log('look id', id); process.exit(0);
