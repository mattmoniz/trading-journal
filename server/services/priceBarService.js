import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { query } from '../db.js';

// Map a raw filename to { symbol, contract }
// Handles all the naming variants Sierra Chart uses:
//   NQU5.CME.scid_BarData-1m.txt
//   NQM24-CME.scid_BarData-1m.txt
//   NQU24_FUT_CME.scid_BarData-1m.txt
//   ESH5.CME.scid_BarData-1m.txt  etc.
export function parseContractFromFilename(filename) {
  const base = path.basename(filename);

  // Strip everything after (and including) ".scid" or just use the bare name
  // e.g. "NQU5.CME.scid_BarData-1m.txt" → "NQU5.CME"
  const withoutScid = base.replace(/\.scid.*$/i, '');

  // Extract the raw contract token before the first dot or dash or underscore
  // "NQU5.CME" → "NQU5"
  // "NQM24-CME" → "NQM24"
  // "NQU24_FUT_CME" → "NQU24"
  const token = withoutScid.split(/[.\-_]/)[0].toUpperCase();

  // Normalize: strip the root symbol to get the base (NQ, MNQ, ES, MES, etc.)
  // Contract codes end with MonthLetter + 1-2 digit year
  // Month letters: H=Mar, M=Jun, U=Sep, Z=Dec
  const contractMatch = token.match(/^([A-Z]+?)([HMUZ])(\d{1,2})$/);
  if (!contractMatch) {
    return { symbol: token, contract: token };
  }

  const [, rootSymbol, monthCode, yearShort] = contractMatch;

  // Normalize year: '5' → '2025', '25' → '2025', '24' → '2024'
  const year = yearShort.length === 1
    ? 2020 + parseInt(yearShort)
    : 2000 + parseInt(yearShort);

  const MONTH_NAMES = { H: 'Mar', M: 'Jun', U: 'Sep', Z: 'Dec' };
  const contract = `${rootSymbol}${monthCode}${year.toString().slice(2)}`; // e.g. NQU25

  return {
    symbol: rootSymbol,       // NQ, MNQ, ES, MES
    contract,                  // NQU25, NQH26, etc.
    year,
    monthCode,
    monthName: MONTH_NAMES[monthCode],
  };
}

// Parse Sierra Chart's exported bar data CSV format.
// Handles two variants:
//   Old (manual export):  "2025/5/27, 18:00:00, O, H, L, C, Vol, Trades, BidVol, AskVol"
//   New (study export):   "2026-4-8, 16:15:00.000000, O, H, L, Last, Vol, Trades, OHLCAvg, HLCAvg, HLAvg, BidVol, AskVol"
function parseLine(line, contract, symbol) {
  const parts = line.split(',').map(s => s.trim());
  if (parts.length < 6) return null;

  const [datePart, timePart, open, high, low, close, volume, numTrades] = parts;

  // Parse date — accept both "2025/5/27" and "2026-4-8"
  const [yr, mo, dy] = datePart.split(/[\/\-]/).map(Number);
  if (!yr || !mo || !dy) return null;

  // Parse time — accept "18:00:00" and "18:00:54.015000" (sub-seconds)
  const timeParts = timePart.split(':');
  const hh = parseInt(timeParts[0]);
  const mm = parseInt(timeParts[1]);
  const ss = parseInt(timeParts[2]) || 0;

  const utcTs = new Date(yr, mo - 1, dy, hh, mm, ss);
  if (isNaN(utcTs.getTime())) return null;

  const o  = parseFloat(open);
  const h  = parseFloat(high);
  const l  = parseFloat(low);
  const c  = parseFloat(close);
  const v  = parseInt(volume) || 0;
  const nt = parseInt(numTrades) || 0;

  // Bid/Ask: column positions differ by format.
  // Old: BidVol at index 8, AskVol at index 9
  // New: BidVol at index 11, AskVol at index 12 (extra avg columns in between)
  let bv = 0, av = 0;
  if (parts.length >= 13) {
    bv = parseInt(parts[11]) || 0;
    av = parseInt(parts[12]) || 0;
  } else if (parts.length >= 10) {
    bv = parseInt(parts[8]) || 0;
    av = parseInt(parts[9]) || 0;
  }

  if (isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c)) return null;
  if (h <= 0 || l <= 0 || c <= 0) return null;

  return { ts: utcTs, open: o, high: h, low: l, close: c, volume: v, num_trades: nt, bid_volume: bv, ask_volume: av };
}

export async function ingestBarFile(filePath) {
  const filename = path.basename(filePath);
  console.log(`📊 Ingesting price bars: ${filename}`);

  // Check current file size to detect new bars appended since last ingest
  const currentSize = fs.statSync(filePath).size;
  const existing = await query(
    'SELECT id, bars_inserted, file_size FROM price_bar_ingests WHERE filename = $1',
    [filename]
  );
  if (existing.rows.length > 0 && existing.rows[0].file_size === currentSize) {
    console.log(`⏭️  No changes: ${filename} (${existing.rows[0].bars_inserted} bars, same file size)`);
    return { skipped: true, bars_inserted: existing.rows[0].bars_inserted, filename };
  }
  if (existing.rows.length > 0) {
    console.log(`🔄 File grew: ${filename} — re-ingesting to pick up new bars`);
  }

  const { symbol, contract } = parseContractFromFilename(filename);
  console.log(`  Symbol: ${symbol}, Contract: ${contract}`);

  const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let lineNum = 0;
  let barsInserted = 0;
  let dateFrom = null;
  let dateTo = null;

  // Batch inserts for performance
  const COLS = 11; // symbol, contract, ts, open, high, low, close, volume, num_trades, bid_volume, ask_volume
  const BATCH_SIZE = 400; // 400 × 11 = 4400 params, well under PG's 65535 limit
  let batch = [];

  const flushBatch = async () => {
    if (!batch.length) return;

    const values = [];
    const placeholders = batch.map((bar, i) => {
      const base = i * COLS;
      values.push(symbol, contract, bar.ts, bar.open, bar.high, bar.low, bar.close,
        bar.volume, bar.num_trades, bar.bid_volume, bar.ask_volume);
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11})`;
    });

    // ON CONFLICT DO UPDATE only when values actually changed — prevents dead tuple explosion
    // from re-ingesting unchanged historical bars every time SC appends a new bar to the file.
    const sql = `
      INSERT INTO price_bars (symbol, contract, ts, open, high, low, close, volume, num_trades, bid_volume, ask_volume)
      VALUES ${placeholders.join(',')}
      ON CONFLICT (contract, ts) DO UPDATE SET
        open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
        volume = EXCLUDED.volume, num_trades = EXCLUDED.num_trades,
        bid_volume = EXCLUDED.bid_volume, ask_volume = EXCLUDED.ask_volume
      WHERE price_bars.close != EXCLUDED.close
         OR price_bars.high  != EXCLUDED.high
         OR price_bars.low   != EXCLUDED.low
         OR price_bars.volume != EXCLUDED.volume
    `;
    const result = await query(sql, values);
    barsInserted += result.rowCount;
    batch = [];
  };

  for await (const line of rl) {
    lineNum++;
    const trimmed = line.trim();
    if (!trimmed || lineNum === 1) continue; // skip header

    const bar = parseLine(trimmed, contract, symbol);
    if (!bar) continue;

    if (!dateFrom || bar.ts < dateFrom) dateFrom = bar.ts;
    if (!dateTo   || bar.ts > dateTo)   dateTo   = bar.ts;

    batch.push(bar);
    if (batch.length >= BATCH_SIZE) await flushBatch();
  }
  await flushBatch();

  // Record ingest — store file_size so future scans can detect new bars
  await query(`
    INSERT INTO price_bar_ingests (filename, contract, symbol, bars_inserted, date_from, date_to, file_size)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (filename) DO UPDATE SET
      bars_inserted = $4, date_from = $5, date_to = $6, file_size = $7, ingested_at = NOW()
  `, [filename, contract, symbol, barsInserted, dateFrom, dateTo, currentSize]);

  console.log(`✅ ${filename}: ${barsInserted.toLocaleString()} bars upserted`);
  return { skipped: false, bars_inserted: barsInserted, filename, contract, symbol, date_from: dateFrom, date_to: dateTo };
}

// Scan the Sierra Chart Data directory for any *_BarData-1m.txt files
// that haven't been ingested yet
export async function scanAndIngestNewBarFiles(dataDir) {
  if (!fs.existsSync(dataDir)) {
    console.warn(`⚠️  Price bar data dir not found: ${dataDir}`);
    return [];
  }

  // Only ingest plain 1-min bar exports: *_BarData.txt or *_BarData-Nm.txt
  // Exclude volume-bar exports (750V, studies, etc.)
  const files = fs.readdirSync(dataDir)
    .filter(f => /[_-]BarData(-\d+m?)?\.txt$/i.test(f))
    .map(f => path.join(dataDir, f));

  // Check which are already ingested and at what file size
  const ingestedRes = await query('SELECT filename, file_size FROM price_bar_ingests');
  const ingestedMap = new Map(ingestedRes.rows.map(r => [r.filename, r.file_size]));

  // Include new files AND files whose on-disk size differs from the stored size
  const filesToProcess = files.filter(f => {
    const name = path.basename(f);
    if (!ingestedMap.has(name)) return true; // new file
    const storedSize = ingestedMap.get(name);
    const currentSize = fs.statSync(f).size;
    return storedSize === null || storedSize !== currentSize; // grown or never size-tracked
  });

  if (!filesToProcess.length) {
    console.log('📊 No new or updated price bar files to ingest');
    return [];
  }

  const newCount = filesToProcess.filter(f => !ingestedMap.has(path.basename(f))).length;
  const updatedCount = filesToProcess.length - newCount;
  console.log(`📊 Found ${filesToProcess.length} bar file(s) to ingest (${newCount} new, ${updatedCount} updated)`);
  const results = [];
  for (const f of filesToProcess) {
    try {
      results.push(await ingestBarFile(f));
    } catch (err) {
      console.error(`❌ Failed to ingest ${f}:`, err.message);
      results.push({ error: err.message, filename: path.basename(f) });
    }
  }
  return results;
}

// Fetch 1-min bars for a symbol between two UTC timestamps
// Automatically finds the right contract(s) — handles rolls
export async function getBars(symbol, fromUtc, toUtc, intervalMins = 1) {
  if (intervalMins === 1) {
    const result = await query(`
      SELECT ts, open, high, low, close, volume, num_trades, bid_volume, ask_volume, contract
      FROM price_bars
      WHERE symbol = $1 AND ts >= $2 AND ts <= $3
      ORDER BY ts ASC
    `, [symbol.toUpperCase(), fromUtc, toUtc]);
    return result.rows;
  }

  // Aggregate to larger intervals using time bucketing
  const result = await query(`
    SELECT
      date_trunc('hour', ts) +
        (EXTRACT(MINUTE FROM ts)::int / $4 * $4 || ' minutes')::interval AS bar_ts,
      (array_agg(open ORDER BY ts))[1]  AS open,
      MAX(high)                          AS high,
      MIN(low)                           AS low,
      (array_agg(close ORDER BY ts DESC))[1] AS close,
      SUM(volume)                        AS volume,
      SUM(num_trades)                    AS num_trades,
      MIN(contract)                      AS contract
    FROM price_bars
    WHERE symbol = $1 AND ts >= $2 AND ts <= $3
    GROUP BY bar_ts
    ORDER BY bar_ts ASC
  `, [symbol.toUpperCase(), fromUtc, toUtc, intervalMins]);
  return result.rows;
}
