import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'regime_gauge_20261102', dataWindow: 'all valid days 2023-03..2026-11 (walk-forward out-of-sample, descriptive)', kind: 'EXPLORE', tests: 1, label: 'Regime gauge day model: walk-forward out-of-sample Spearman vs the overnight-range-only baseline, and realized range by bucket (descriptive calibration)', script: 'scripts/regime/regime_report.py', prereg: 'docs/REGIME_GAUGE_20261102.md', ref: 'regime_gauge_report_20261102' });
console.log('look logged id', id); process.exit(0);
