// Prints {decisionMinute: {reversalSize: confirmedLegs}} for one trade date, using the REAL detectRotationLegs (hr-022) on the DB 1-minute RTH bars before each decision minute (60, 120, 210, 300 minutes after 09:30), sizes 20..200 step 10.
// Features only: no outcome is read. Both time bounds on the query (cv-009). Usage: node scripts/structure_model/legs_helper.mjs YYYY-MM-DD
import { query } from '../../server/db.js';
import { detectRotationLegs } from '../../server/services/rotationDetector.js';
const d = process.argv[2]; const r = await query(`SELECT high::float AS high, low::float AS low FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::timestamp + interval '9 hours 30 minutes' AND ts < $1::timestamp + interval '15 hours' ORDER BY ts`, [d]); const out = {};
for (const T of [60, 120, 210, 300]) { out[T] = {}; for (let R = 20; R <= 200; R += 10) out[T][R] = detectRotationLegs(r.rows.slice(0, T), R).length; }
process.stdout.write(JSON.stringify(out)); process.exit(0);
