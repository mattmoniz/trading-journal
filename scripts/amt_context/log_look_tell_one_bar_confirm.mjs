import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'tell_one_bar_confirm_20261102', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 2, label: 'Tell one-bar close confirmation: original V1 net confirmed vs against, and delayed-entry (confirmed only) vs all original', script: 'scripts/amt_context/run_tell_one_bar_confirm.py', prereg: 'docs/TELL_ONE_BAR_CONFIRM_PREREG_20261102.md', ref: 'tell_one_bar_confirm_20261102' });
console.log('look logged id', id); process.exit(0);
