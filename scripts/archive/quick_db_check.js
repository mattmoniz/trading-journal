import { query } from '../server/db.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

async function main() {
  const bars = await query(`SELECT COUNT(DISTINCT ts::date) as count FROM price_bars WHERE symbol='NQ'`);
  const dvLog = await query(`SELECT COUNT(*) as count FROM developing_value_log`);
  const activeSetups = await query(`SELECT COUNT(*) as count FROM active_setups`);
  const winrates = await query(`SELECT COUNT(*) as count FROM setup_daytype_winrates`);
  
  console.log({
    price_bars_days: bars.rows[0].count,
    developing_value_log: dvLog.rows[0].count,
    active_setups: activeSetups.rows[0].count,
    setup_daytype_winrates: winrates.rows[0].count
  });
}

main().catch(console.error);
