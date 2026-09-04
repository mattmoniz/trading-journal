import { query } from './server/db.js';
async function main() {
  const datesRes = await query("SELECT DISTINCT ts::date::text AS d FROM price_bars_primary WHERE symbol = 'NQ' AND ts >= '2026-01-01' AND ts < '2026-09-04'");
  console.log(datesRes.rows.length);
  process.exit(0);
}
main();
