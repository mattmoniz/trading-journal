/**
 * Background freshness check for the live NQ price-bar feed, run every 10 minutes via cron.
 *
 * Built 2026-10-11 after a real incident: SIERRA_DATA_PATH's configured export file stopped
 * updating for 4 days (2026-10-07 to 2026-10-11) with zero alerting -- the dashboard's own
 * live-flags banner (GET /api/setups/live-flags, extended the same day to carry a
 * priceBarsStale field) only helps someone actually looking at quick-check.html. This script
 * is the second layer: it logs to scratch/server_errors.jsonl using the exact same schema
 * server/index.js's own recordError() writes, so a stale feed shows up in the standing
 * self-check routine (CLAUDE.md's "Self check" procedure already tails this file) and in
 * anything else already watching it, with no one needing to have the dashboard open.
 *
 * Deliberately does NOT try to fix the underlying cause -- the 2026-10-11 incident's root
 * cause lived on the Windows/Sierra Chart side (a chart that stopped exporting), which no
 * amount of re-running ingestion code here can repair. This script's only job is making sure
 * a recurrence gets noticed within ~10-20 minutes instead of days.
 *
 * Run: node scripts/check_price_bars_freshness.mjs
 * Cron: every 10 minutes (see crontab -l)
 */
import { query } from '../server/db.js';
import pool from '../server/db.js';
import { isGlobexWeekClosed } from '../server/routes/acd.js';
import { etNaiveTimestampToMs } from '../server/services/acdShared.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STALE_MINUTES = 10; // matches server/routes/setups.js's PRICE_BARS_STALE_MINUTES

function logAlert(message) {
  const filePath = path.join(__dirname, '../scratch/server_errors.jsonl');
  const line = JSON.stringify({ ts: new Date().toISOString(), type: 'SERVER_ERROR', message, detail: null }) + '\n';
  try {
    fs.appendFileSync(filePath, line);
  } catch (_) { /* best-effort, matches recordError()'s own silent-catch convention */ }
}

async function run() {
  // ts is naive ET wall-clock (timestamp without time zone) -- must go through
  // etNaiveTimestampToMs() before comparing to Date.now(), same fix as setups.js's
  // live-flags endpoint. A raw new Date(lastBar) vs new Date(nowUtc) diff reads every
  // fresh bar as ~4-5h stale (EDT/EST-dependent) -- caught 2026-10-11 before this ever ran
  // unattended in cron.
  const r = await query(`SELECT MAX(ts)::text AS last_bar FROM price_bars_primary WHERE symbol='NQ'`);
  const lastBar = r.rows[0]?.last_bar;
  if (!lastBar) {
    await pool.end();
    return;
  }
  const staleMinutes = Math.round((Date.now() - etNaiveTimestampToMs(lastBar)) / 60000);
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  if (!isGlobexWeekClosed(nowET) && staleMinutes > STALE_MINUTES) {
    console.error(`PRICE_BARS_STALE: last NQ bar ${staleMinutes}min old (${lastBar})`);
    logAlert(`Price bar feed stale: last NQ bar is ${staleMinutes} minutes old (${lastBar}) during active Globex hours. Check SIERRA_DATA_PATH's configured export file and whether Sierra Chart is still writing to it.`);
  }
  await pool.end();
}

run().catch(e => {
  console.error('[check_price_bars_freshness] ERROR:', e.message);
  process.exit(1);
});
