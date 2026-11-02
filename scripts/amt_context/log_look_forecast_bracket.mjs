import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'roster_context_20261102', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 4, label: 'Option 3: no-direction bracket after the V1 tell, k = c x forecast E_30; S-STOP and S-LIMIT x c 0.25/0.5 (4 counted cells); forecast-third split and best-case ambiguity uncounted', script: 'scripts/amt_context/run_forecast_bracket.py', prereg: 'scripts/amt_context/PREREG_FORECAST_BRACKET.md', ref: 'forecast_bracket_20261102' });
console.log('look logged id', id); process.exit(0);
