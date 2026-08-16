import pg from 'pg';
import fs from 'fs';

const { Pool } = pg;

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'trading_journal',
  user: 'gemini_readonly',
  password: 'gemini_ro_2026'
});

async function extractLevels() {
  const query = `
    SELECT trade_date, level_name, price 
    FROM level_prices 
    WHERE trade_date >= '2025-08-01'
  `;
  try {
    const { rows } = await pool.query(query);
    const levelsByDate = {};
    for (const row of rows) {
      const dateStr = row.trade_date.toISOString().split('T')[0];
      if (!levelsByDate[dateStr]) {
        levelsByDate[dateStr] = [];
      }
      levelsByDate[dateStr].push({ name: row.level_name, price: parseFloat(row.price) });
    }
    fs.writeFileSync('/home/mmoniz/trading-journal/scratch/levels_1yr.json', JSON.stringify(levelsByDate, null, 2));
    console.log(`Extracted levels for ${Object.keys(levelsByDate).length} dates.`);
  } catch (err) {
    console.error('Error fetching levels:', err);
  } finally {
    pool.end();
  }
}

extractLevels();
