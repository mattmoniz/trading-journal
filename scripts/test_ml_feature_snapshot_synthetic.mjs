// Synthetic (no-DB) unit test for mlFeatureSnapshot.js's computePriorDayLevelFeatures().
// Run manually: node scripts/test_ml_feature_snapshot_synthetic.mjs
import { computePriorDayLevelFeatures } from '../server/services/mlFeatureSnapshot.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

const pdRow = {
  trade_date: '2026-09-18',
  poc: '29735.00', vah: '29820.00', val: '29692.75',
  session_high: '29937.75', session_low: '29659.25', session_close: '29916.50',
  poc_delta_vs_prior: '-1.75', migration_dir_vs_prior: 'HOLDING', va_overlap_pct_vs_prior: '72.30',
};

const r = computePriorDayLevelFeatures(29800, pdRow);
check('distToPdHigh = entry - session_high', r.distToPdHigh === Math.round((29800 - 29937.75) * 10) / 10);
check('distToPdLow = entry - session_low', r.distToPdLow === Math.round((29800 - 29659.25) * 10) / 10);
check('distToPdClose = entry - session_close', r.distToPdClose === Math.round((29800 - 29916.50) * 10) / 10);
check('distToPdPoc = entry - poc', r.distToPdPoc === Math.round((29800 - 29735) * 10) / 10);
check('distToPdVah = entry - vah', r.distToPdVah === Math.round((29800 - 29820) * 10) / 10);
check('distToPdVal = entry - val', r.distToPdVal === Math.round((29800 - 29692.75) * 10) / 10);
check('pdRange = session_high - session_low', r.pdRange === Math.round((29937.75 - 29659.25) * 10) / 10);
check('pocDeltaVsPrior copied through, numeric', r.pocDeltaVsPrior === -1.75);
check('migrationDirVsPrior copied through, string', r.migrationDirVsPrior === 'HOLDING');
check('vaOverlapPctVsPrior copied through, numeric', r.vaOverlapPctVsPrior === 72.3);
check('pdTradeDate carried through', r.pdTradeDate === '2026-09-18');

// String numeric coercion (node-postgres returns NUMERIC as JS strings) handled correctly
const r2 = computePriorDayLevelFeatures(100, { poc: '95.5', vah: null, val: null, session_high: null, session_low: null, session_close: null });
check('null level fields produce null distances, not NaN/crash', r2.distToPdVah === null && r2.distToPdVal === null);
check('string-typed poc still computes correctly', r2.distToPdPoc === Math.round((100 - 95.5) * 10) / 10);
check('null pdRange when session_high/low missing', r2.pdRange === null);

// Edge cases
check('null entry -> null result', computePriorDayLevelFeatures(null, pdRow) === null);
check('null pdRow -> null result (no prior-day data exists yet)', computePriorDayLevelFeatures(100, null) === null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
