import pool from '../db.js';

export async function importSierraTrades(trades) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    let imported = 0;
    let skipped = 0;
    const errors = [];

    // Count-based dedup: track how many times each key has been seen in this batch
    // and how many already exist in the DB. This handles the case where the same
    // (entry_time, exit_time, price, qty) combination appears multiple times in a
    // session (e.g. scaling in at the same price) — only importing the delta.
    const seenCounts = {};    // key -> seen count in this batch
    const dbCountCache = {};  // key -> count already in DB (cached)

    for (const trade of trades) {
      try {
        const account = trade.custom_fields?.account ?? null;
        const key = `${trade.entry_time}|${trade.exit_time}|${trade.symbol}|${trade.direction}|${trade.quantity}|${trade.entry_price}|${trade.exit_price}|${account}`;

        seenCounts[key] = (seenCounts[key] || 0) + 1;

        if (!(key in dbCountCache)) {
          const countResult = await client.query(
            `SELECT COUNT(*) as cnt FROM trades
             WHERE entry_time = $1 AND exit_time = $2 AND symbol = $3
               AND direction = $4 AND quantity = $5
               AND entry_price = $6 AND exit_price = $7
               AND (custom_fields->>'account' = $8 OR ($8::text IS NULL AND custom_fields->>'account' IS NULL))`,
            [trade.entry_time, trade.exit_time, trade.symbol, trade.direction,
             trade.quantity, trade.entry_price, trade.exit_price, account]
          );
          dbCountCache[key] = parseInt(countResult.rows[0].cnt);
        }

        if (seenCounts[key] <= dbCountCache[key]) {
          skipped++;
          continue;
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
        dbCountCache[key]++; // reflect the new row so next identical fill is correctly evaluated

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
      `INSERT INTO daily_logs (log_date, pre_market_notes)
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

export async function manualImportFromFile(filePath, trigger = 'MANUAL') {
  const fs = await import('fs');
  const path = await import('path');
  const { parseSierraTradeLog } = await import('../parsers/sierraParser.js');

  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = parseSierraTradeLog(content);
  if (parsed.warning) console.warn('[import]', parsed.warning);

  const result = await importSierraTrades(parsed.trades);

  // Log to import_log (best-effort — never block the import result)
  try {
    const fileName = path.basename(filePath);
    await pool.query(`
      INSERT INTO import_log (import_time, file_used, imported, skipped, errors, trigger)
      VALUES (NOW(), $1, $2, $3, $4, $5)
    `, [fileName, result.imported, result.skipped, result.errors?.length ?? 0, trigger]);
  } catch (logErr) {
    console.warn('[import] import_log write failed:', logErr.message);
  }

  return result;
}

export default { importSierraTrades, getImportHistory, manualImportFromFile };
