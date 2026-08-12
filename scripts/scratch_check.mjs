import { query } from '../server/db.js';
async function run() {
  const { rows } = await query("SELECT ts FROM price_bars_primary WHERE symbol='NQ' AND ts::date = '2024-02-16' ORDER BY ts DESC LIMIT 10");
  console.log(rows);
}
run();
