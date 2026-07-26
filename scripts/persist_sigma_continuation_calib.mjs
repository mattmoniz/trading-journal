// Persists the live calibration cutoffs for the sigma-continuation signal
// (RESEARCH_CLAIM sigma_continuation_down_moves) -- reads directly from the already-verified
// TEST-split numbers in scratch/sigma_continuation_RESULTS.md's "Sigma Window: 100, Trailing
// Move Window: 60m" section (sigma-window=100 bars, H=60min lookback -- matches the live
// computation in server/routes/acd.js) at the 60-minute forward horizon. TEST split used
// deliberately, not train, per this codebase's own "report held-out numbers, not train"
// discipline. The 3.0 sigma bucket's 95% CI crosses zero at this specific forward window
// (test N=31, too thin) -- NOT included as a reliable calibrated bucket; the live code falls
// back to "insufficient data" rather than quoting a number for that regime.
import { query } from '../server/db.js';

const CUTOFFS = [
  { sigma: 1.0, extraPts: 6.8, ctrlMedPts: 35.8, n: 1538, days: 89 },
  { sigma: 1.5, extraPts: 16.3, ctrlMedPts: 35.8, n: 781, days: 80 },
  { sigma: 2.0, extraPts: 24.8, ctrlMedPts: 35.8, n: 357, days: 70 },
  { sigma: 2.5, extraPts: 44.5, ctrlMedPts: 35.8, n: 100, days: 32 },
  // 3.0 deliberately omitted -- CI [-0.5, 74.8] crosses zero at this forward window/config,
  // not reliable enough to quote a specific number live.
];

async function main() {
  await query(`DELETE FROM performance_audit WHERE signal_type = 'SIGMA_CONTINUATION_CALIB'`);
  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes)
    VALUES (CURRENT_DATE, 9999, 'SIGMA_CONTINUATION_CALIB', 'LIVE_CUTOFFS', $1, $2)
  `, [CUTOFFS.reduce((s, c) => s + c.n, 0), JSON.stringify({ cutoffs: CUTOFFS, sigmaWindow: 100, lookbackMin: 60, forwardMin: 60, source: 'sigma_continuation_down_moves TEST split' })]);
  console.log('Persisted SIGMA_CONTINUATION_CALIB LIVE_CUTOFFS.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
