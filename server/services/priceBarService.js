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

// Decides which contract "owns" each date in [dateFrom, dateTo] for `symbol`, by majority
// bar count across ALL of price_bars (not just whatever triggered this call), and upserts
// price_bars_contract_calendar accordingly. price_bars_dedup_hist/price_bars_primary INNER
// JOIN against this table, so a wrong entry here doesn't mislabel a date's bars -- it makes
// them silently VANISH from every live query for that date.
//
// FIXED 2026-09-15 (OPEN_DECISION contract_calendar_roll_race_stale_price_20260915, DeepSeek
// design-critiqued): the old version had a `WHERE EXCLUDED.bar_count > existing.bar_count`
// guard that conflated "is this scan more complete" with "is this the right winner" -- during
// a real quarterly contract roll (confirmed: NQU26/NQZ26 both had bars on 09-03, 11 days
// before this codebase's own computed roll-week window even starts), the guard could freeze
// the calendar on the PRE-roll contract if the new contract's count at some intermediate poll
// was lower than the old contract's already-complete count -- a wrong flip that could never
// self-correct. This produced two real STOP_HIT losses (-$76 each) on 2026-09-14 when the
// live "get current price" query silently walked back to a stale Friday bar because the
// calendar pointed 09-14 at the wrong contract.
//
// The re-rank query itself is ALREADY a deterministic function of ALL of price_bars' current
// contents for each date in range (not just the just-ingested file's own contract) -- so the
// fix is smaller than a redesign: (1) delete the monotonic guard entirely (bar_count per
// (date, contract) is monotone non-decreasing under this upsert-only ingest, so the winner
// can cross at most once, in the correct direction -- removing the guard cannot cause thrash,
// it only lets a wrong flip converge to the true dominant contract on the next re-scan);
// (2) add a deterministic tie-break (`contract ASC`) for the one genuine non-determinism the
// old query had (an exact bar-count tie). Explicitly REJECTED a roll-week-calendar-aware
// special-case (option (c) in the design critique) -- the real dual-contract overlap window
// is wider and less predictable than a hardcoded quarterly calendar can model, so "does the
// data currently have 2+ contracts" is the only reliable signal, and this query already reads
// that directly. See scratch/deepseek_response.md (2026-09-15, "Design critique" pass) for
// the full stress-test (does removing the guard thrash? does a flip corrupt already-fired
// trades? no and no -- fired rows are immutable snapshots, only a fresh read of a wrong
// contract mapping is at risk, which this fix eliminates).
//
// Extracted into its own exported function 2026-09-15 (Tier 2 of the same fix, per DeepSeek's
// own recommendation) so scripts/refresh_price_bars_dedup_hist.mjs can call it over a WIDE
// date range immediately before the nightly REFRESH MATERIALIZED VIEW freezes whatever the
// calendar currently says -- this closes the separate, lower-urgency "matview vs live-branch
// disagree about which contract a boundary date belongs to" continuity gap (the matview only
// ever reflects the calendar as of its own last refresh), rather than leaving it to whichever
// bar file happens to be re-ingested next.
//
// RANKING FIXED 2026-09-15 (same day, OPUS_AUDIT_PROMPT_13 strategic review of this exact
// fix, scratch/opus_audit_13_results.md): ranking by COUNT(*) is a saturating, low-resolution
// proxy -- once the new contract is even modestly liquid it prints in nearly every minute of
// the session, so both contracts' bar counts converge toward the same ~full-session count and
// the real decision gets made on a residual difference of a handful of bars, dominated by
// file-ingestion timing rather than market reality. `volume` is ingested on every bar and is
// never used for contract selection anywhere else in this codebase -- it differs between front
// and back month by orders of magnitude through the whole overlap and crosses over once,
// sharply, at the real roll. Ranking on SUM(volume) first makes the tie-break below nearly
// unreachable instead of arbitrating it. Also flips the tie-break from `contract ASC` to
// `contract DESC`: Opus's audit found `contract ASC` (the original Tier 1 choice) is a pure
// alphabetic sort that happens to favor the EXPIRING contract in 3 of 4 NQ rolls per year
// (H<M<U<Z, and the roll sequence is H->M->U->Z->H) -- including the exact Sep->Dec roll that
// produced this whole incident. `contract DESC` gets that one right; note there is no single
// lexical tie-break that's correct across every year boundary (Dec->Mar wraps Z->H), which is
// itself the argument for making volume the primary key and leaving contract as a
// near-unreachable last resort. day_volume is stored alongside bar_count so the calendar is
// self-explaining (why this contract, by how much) without re-deriving it.
export async function reconcileContractCalendar(symbol, dateFrom, dateTo) {
  await query(`
    INSERT INTO price_bars_contract_calendar (symbol, trade_date, contract, bar_count, day_volume)
    SELECT symbol, trade_date, contract, bar_count, day_volume FROM (
      SELECT symbol, ts::date AS trade_date, contract,
        COUNT(*) AS bar_count, SUM(volume) AS day_volume,
        ROW_NUMBER() OVER (PARTITION BY symbol, ts::date ORDER BY SUM(volume) DESC, COUNT(*) DESC, contract DESC) AS rn
      FROM price_bars
      WHERE symbol = $1 AND ts::date >= $2::date AND ts::date <= $3::date
      GROUP BY symbol, ts::date, contract
    ) ranked WHERE rn = 1
    ON CONFLICT (symbol, trade_date) DO UPDATE
      SET contract = EXCLUDED.contract, bar_count = EXCLUDED.bar_count, day_volume = EXCLUDED.day_volume
      WHERE price_bars_contract_calendar.contract IS DISTINCT FROM EXCLUDED.contract
         OR price_bars_contract_calendar.bar_count IS DISTINCT FROM EXCLUDED.bar_count
         OR price_bars_contract_calendar.day_volume IS DISTINCT FROM EXCLUDED.day_volume
  `, [symbol, dateFrom, dateTo]);
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
  if (existing.rows.length > 0 && existing.rows[0].file_size != null && Number(existing.rows[0].file_size) === currentSize) {
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

  // Keep the contract calendar up to date so price_bars_primary view stays correct across
  // rollovers -- see reconcileContractCalendar()'s own header comment (below) for the full
  // 2026-09-15 fix writeup. Scoped to just this file's own date range here; the nightly
  // matview refresh calls the same function over a much wider window first (Tier 2 of the
  // same fix) so a still-settling roll never gets frozen mid-flip.
  await reconcileContractCalendar(symbol, dateFrom, dateTo);

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
    return storedSize == null || Number(storedSize) !== currentSize; // grown or never size-tracked
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

  // Contract rollover detection: warn if a new NQ contract appeared with few bars
  const nqResults = results.filter(r => !r.error && r.symbol === 'NQ');
  for (const r of nqResults) {
    if (!ingestedMap.has(r.filename) && r.bars_inserted < 100) {
      console.warn(`⚠️  CONTRACT ROLLOVER DETECTED: ${r.contract} appeared with only ${r.bars_inserted} bars. Old contract may have stopped updating. Monitor for data gaps.`);
      r.rolloverWarning = true;
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
      FROM price_bars_primary
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
    FROM price_bars_primary
    WHERE symbol = $1 AND ts >= $2 AND ts <= $3
    GROUP BY bar_ts
    ORDER BY bar_ts ASC
  `, [symbol.toUpperCase(), fromUtc, toUtc, intervalMins]);
  return result.rows;
}
