// Logs the ledger look for docs/HAR_WIDTH_BENCHMARK_PREREG_20261104.md BEFORE har_width_benchmark.py computes any HAR number (hr-023). 2 counted tests.
import { logLook } from '../../lib/look_ledger.mjs';
const id = await logLook({ family: 'har_width_benchmark_20261104', dataWindow: 'explore_498_sessions', kind: 'EXPLORE', tests: 2, label: 'HAR-X (daily/weekly/monthly realized range + overnight) vs the stage-0 day-width forecast, and HAR-X + stage-0 vs HAR-X, walk-forward squared error of the log range ratio; week-block CI, circular-shift placebo', script: 'scripts/tell_context/research_20261103/har_width_benchmark.py', prereg: 'docs/HAR_WIDTH_BENCHMARK_PREREG_20261104.md', ref: 'har_width_benchmark_20261104_look1' });
console.log('look id', id); process.exit(0);
