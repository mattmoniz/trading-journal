/**
 * Safety-net price-bar ingestion, run as its own short-lived process via system cron.
 *
 * Found 2026-10-11: the live server's own 60s-interval scanAndIngestNewBarFiles() call
 * (server/index.js) stopped detecting growth in the active NQ bar-export file around
 * 2026-10-09 16:59 and never recovered on its own, even across a full server restart --
 * a fresh restart (new PID, confirmed via systemctl status) showed the IDENTICAL staleness
 * within minutes of boot. An isolated one-off script (this exact function, run standalone)
 * correctly saw the growing file every time, with zero staleness across repeated checks in
 * the same process over 100+ seconds. Ruled out: SierraWatcher cache-poisoning (it's
 * instantiated but .start() is never called), systemd mount/namespace isolation (no
 * ProtectSystem/PrivateMounts on the unit), and generic WSL2 DrvFs staleness for this path
 * in general. The actual mechanism inside the long-running server process was NOT found --
 * see OPEN_DECISION live_server_pricebars_ingestion_stuck_20261011 for the full trail of
 * what was ruled out, in case a future session wants to keep digging.
 *
 * This script is the practical workaround, not the fix: a genuinely separate, short-lived
 * process (new PID every run, no inherited state) that re-runs the exact same ingestion
 * logic as the live server's own poll. If the live server's own loop is working fine, this
 * finds nothing to do and exits in well under a second (ON CONFLICT DO UPDATE ... WHERE
 * changed in the underlying INSERT makes concurrent/duplicate runs against the live
 * server's own loop safe by construction -- no lock needed). If the live server's loop has
 * gone stale again, this catches it within its own cron interval regardless.
 *
 * Run: node scripts/catchup_price_bars.mjs
 * Cron: every minute (see crontab -l) -- cheap enough (a no-op short-circuits on an
 * unchanged file size before any parsing) to run this often, and the live server's own
 * loop already polls at the same cadence, so this isn't adding meaningfully more database
 * load than already exists.
 */
import { scanAndIngestNewBarFiles } from '../server/services/priceBarService.js';
import pool from '../server/db.js';

const SIERRA_DATA_DIR = process.env.SIERRA_DATA_PATH || '/mnt/c/SierraChart/Data';
const LOG_PREFIX = () => `[${new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false })} ET]`;

async function run() {
  const results = await scanAndIngestNewBarFiles(SIERRA_DATA_DIR);
  const updated = results.filter(r => !r.error && r.bars_inserted > 0);
  if (updated.length > 0) {
    const totalBars = updated.reduce((s, r) => s + r.bars_inserted, 0);
    console.log(`${LOG_PREFIX()} caught up ${totalBars} bar(s) across ${updated.length} file(s): ${updated.map(r => r.filename).join(', ')}`);
  }
  const errors = results.filter(r => r.error);
  if (errors.length > 0) {
    console.error(`${LOG_PREFIX()} ${errors.length} file(s) failed: ${JSON.stringify(errors)}`);
  }
  await pool.end();
}

run().catch(e => {
  console.error(`${LOG_PREFIX()} ERROR:`, e.message);
  process.exit(1);
});
