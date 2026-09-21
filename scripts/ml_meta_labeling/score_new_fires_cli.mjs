// Manual CLI entry point for server/services/mlFireTimeScoring.js's scoreNewFires() --
// the live app calls the function directly (server/index.js's 60s interval); this is just
// for manual testing/debugging from the command line.
// Run: node scripts/ml_meta_labeling/score_new_fires_cli.mjs [minutes]
import { scoreNewFires } from '../../server/services/mlFireTimeScoring.js';

const minutes = parseInt(process.argv[2], 10) || 15;
const result = await scoreNewFires(minutes);
console.log(JSON.stringify(result, null, 2));
process.exit(0);
