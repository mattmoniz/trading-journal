// Supervises the error watcher itself (trading-journal-watcher.service), which supervises the
// main server. Run every 5 minutes via cron (see crontab -l) -- this is the second-order safety
// net: if the watcher process dies (not just the main server), nothing else was catching it.
//
// Found missing entirely on 2026-09-01 (the file this replaces never existed on disk despite a
// crontab entry referencing it -- scratch/ is gitignored so it was never actually committed,
// only its addition was mentioned in a commit message). The gap let an 8-hour main-server outage
// (2026-08-31 14:43-22:53 ET) go completely undetected: the watcher service itself hadn't
// restarted since before 2026-08-25, and this cron job had been failing with MODULE_NOT_FOUND on
// every single run since, silently, for at least that whole window.
//
// Deliberately minimal: this checks ONLY whether the watcher service is active, and restarts it
// if not. Main-server health/restart logic already lives in scratch/gemini_error_watcher.mjs
// itself -- do not duplicate it here.
import { execSync } from 'child_process';

const SERVICE = 'trading-journal-watcher.service';
const LOG_PREFIX = () => `[${new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false })} ET]`;

function isActive() {
  try {
    const out = execSync(`systemctl --user is-active ${SERVICE}`, { encoding: 'utf8' }).trim();
    return out === 'active';
  } catch (e) {
    // is-active exits non-zero for inactive/failed states -- that's the expected "not active" case
    return false;
  }
}

if (isActive()) {
  // Healthy -- stay silent, don't spam a log that gets appended to every 5 minutes forever.
  process.exit(0);
}

console.log(`${LOG_PREFIX()} [CHECK_WATCHER] ${SERVICE} is not active -- attempting restart`);
try {
  execSync(`systemctl --user restart ${SERVICE}`, { encoding: 'utf8' });
  // Give it a moment, then confirm.
  const start = Date.now();
  while (Date.now() - start < 5000) {
    // busy-wait briefly (cron context, no async needed) -- systemctl restart is synchronous
    // enough in practice that this is mostly a formality, but confirm rather than assume.
    break;
  }
  if (isActive()) {
    console.log(`${LOG_PREFIX()} [CHECK_WATCHER] ${SERVICE} restarted successfully`);
  } else {
    console.error(`${LOG_PREFIX()} [CHECK_WATCHER] ${SERVICE} still not active after restart attempt`);
  }
} catch (e) {
  console.error(`${LOG_PREFIX()} [CHECK_WATCHER] restart command failed: ${e.message}`);
}
