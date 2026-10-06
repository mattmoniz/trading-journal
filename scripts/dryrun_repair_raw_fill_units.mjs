// DRY RUN (2026-10-06): shows what converting the raw-unit fill prices would store. Writes nothing.
// Uses the broker's own DisplayPriceMultiplier for MNQZ6.CME (0.00999999776482582, priceMultiplier.js).
import { query } from '../server/db.js';
import { applyPriceMultiplier } from '../server/services/sierraChart/priceMultiplier.js';
const MULT = 0.00999999776482582;
const rows = (await query(`SELECT id, setup_id, purpose, avg_fill_price::float AS avg FROM order_placements
  WHERE avg_fill_price > 1000000 AND submitted_at >= '2026-09-28' ORDER BY id`)).rows;
console.log('id  setup    purpose  stored(raw)     would store');
for (const r of rows) console.log(`${String(r.id).padEnd(4)}${String(r.setup_id).padEnd(9)}${r.purpose.padEnd(9)}${String(r.avg).padEnd(16)}${applyPriceMultiplier(r.avg, MULT).toFixed(2)}`);
console.log(`\n${rows.length} row(s) would be converted. Nothing written.`);
process.exit(0);
