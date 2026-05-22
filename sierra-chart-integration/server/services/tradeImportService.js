import pool from '../db/pool.js';

export async function importSierraTrades(trades) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (const trade of trades) {
      try {
        const orderId = trade.custom_fields?.order_id;
        const tradeId = trade.custom_fields?.trade_id;
        
        if (orderId || tradeId) {
          const existingCheck = await client.query(
            `SELECT id FROM trades 
             WHERE custom_fields->>'order_id' = $1 
             OR custom_fields->>'trade_id' = $2`,
            [orderId, tradeId]
          );

          if (existingCheck.rows.length > 0) {
            console.log(`⏭️  Skipping duplicate: OrderID=${orderId}, TradeID=${tradeId}`);
            skipped++;
            continue;
          }
        }

        await ensureDailyLog(client, trade.log_date);

        const result = await client.query(
          `INSERT INTO trades (
            log_date,
            entry_time,
            exit_time,
            symbol,
            direction,
            quantity,
            entry_price,
            exit_price,
            pnl,
            fees,
            custom_fields,
            created_at,
            updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
          RETURNING id`,
          [
            trade.log_date,
            trade.entry_time,
            trade.exit_time,
            trade.symbol,
            trade.direction,
            trade.quantity,
            trade.entry_price,
            trade.exit_price,
            trade.pnl,
            trade.fees,
            JSON.stringify(trade.custom_fields)
          ]
        );

        console.log(`✅ Imported: ${trade.symbol} ${trade.direction} @ ${trade.entry_price}`);
        imported++;

      } catch (error) {
        console.error(`❌ Error importing trade:`, error.message);
        errors.push({ trade, error: error.message });
      }
    }

    await client.query('COMMIT');

    return { imported, skipped, errors, total: trades.length };

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function ensureDailyLog(client, logDate) {
  const exists = await client.query(
    'SELECT log_date FROM daily_logs WHERE log_date = $1',
    [logDate]
  );

  if (exists.rows.length === 0) {
    await client.query(
      `INSERT INTO daily_logs (log_date, daily_notes)
       VALUES ($1, 'Auto-created from Sierra Chart import')
       ON CONFLICT (log_date) DO NOTHING`,
      [logDate]
    );
  }
}

export async function getImportHistory(limit = 50) {
  const result = await pool.query(
    `SELECT 
      DATE(created_at) as import_date,
      COUNT(*) as trade_count,
      SUM(pnl) as total_pl,
      MIN(created_at) as first_import,
      MAX(created_at) as last_import
     FROM trades
     WHERE custom_fields->>'sierra_import' = 'true'
     GROUP BY DATE(created_at)
     ORDER BY import_date DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows;
}

export async function manualImportFromFile(filePath) {
  const fs = await import('fs');
  const { parseSierraTradeLog } = await import('../parsers/sierraParser.js');

  const content = fs.readFileSync(filePath, 'utf8');
  const trades = parseSierraTradeLog(content);
  
  return await importSierraTrades(trades);
}

export default { importSierraTrades, getImportHistory, manualImportFromFile };
