import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'roster_context_20261102', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 4, label: 'P1b (Amendment 1, post-hoc descriptive): E_30 contrasts for tell_now, tell_any_5m, tell_any_30m inside clock-hour x pace-tercile strata', script: 'scripts/amt_context/run_p1b.py', prereg: 'scripts/amt_context/PREREG_ROSTER_CONTEXT.md', ref: 'roster_context_p1b_20261102' });
console.log('look logged id', id); process.exit(0);
