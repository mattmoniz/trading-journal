// One definition of "how old is the NQ price feed" for the entry gate (orderSweep.js), the boot self-test and the
// live-flags banner (routes/setups.js). Before 2026-11-02 there were three unrelated numbers for the same quantity:
// the shared helper's 15 minutes (priceRetrieval.js, no closure guard), the banner's 10 (with a closure guard) and
// nothing at all on the order path (DeepSeek G0 review, docs/G0_ENTRY_GATE_AND_BOOT_SELFTEST_DESIGN_20261102.md s5).
import { query } from '../db.js';
import { etNaiveTimestampToMs } from './acdShared.js';

// Plumbing parameters, not trading thresholds (same exception as FRESHNESS_MINUTES in priceRetrieval.js): BLOCK equals the
// helper's tolerance so an order is never refused on data the detector that created the setup was happy with; WARN is the
// earlier banner threshold. Static on purpose, a recorded deviation from hr-003 (an infrastructure alarm, not a cutoff).
export const FEED_BLOCK_MINUTES = 15;
export const FEED_WARN_MINUTES = 10;

// Pure: age in minutes from a naive-ET bar timestamp string (null/NaN when unparseable). Always goes through
// etNaiveTimestampToMs; a plain Date.parse would read every fresh bar as 4-5 hours old.
export function feedAgeMinutes(lastBarTs, nowMs = Date.now()) {
  if (typeof lastBarTs !== 'string') return null;
  const ms = etNaiveTimestampToMs(lastBarTs);
  if (!Number.isFinite(ms)) return null;
  return (nowMs - ms) / 60000;
}

// Pure decision. Fails closed on an unknown age; a bar stamped in the future (clock skew) counts as fresh only within a
// small tolerance so a wildly wrong clock cannot pass silently.
export function entryFeedDecision(ageMinutes, blockMinutes = FEED_BLOCK_MINUTES) {
  if (!Number.isFinite(ageMinutes)) return { ok: false, ageMinutes: null, reason: 'FEED_STALE: latest NQ bar age unknown (no bar or unparseable timestamp), failing closed' };
  if (ageMinutes < -2) return { ok: false, ageMinutes, reason: `FEED_STALE: latest NQ bar is ${(-ageMinutes).toFixed(1)} min in the future (clock or timestamp problem), failing closed` };
  if (ageMinutes > blockMinutes) return { ok: false, ageMinutes, reason: `FEED_STALE: latest NQ bar is ${ageMinutes.toFixed(1)} min old (limit ${blockMinutes}), market entry blocked` };
  return { ok: true, ageMinutes, reason: null };
}

// Reads the freshest NQ bar (bounded, same shape as priceRetrieval.getLatestBars) and decides. Never throws.
export async function entryFeedGate({ queryFn = query, nowMs = Date.now() } = {}) {
  try {
    const { rows } = await queryFn(`SELECT ts::text AS ts FROM price_bars_primary WHERE symbol='NQ' AND ts >= CURRENT_DATE - 5 ORDER BY ts DESC LIMIT 1`);
    return entryFeedDecision(rows.length ? feedAgeMinutes(rows[0].ts, nowMs) : null);
  } catch (err) {
    return { ok: false, ageMinutes: null, reason: `FEED_STALE: freshness query failed (${err.message}), failing closed` };
  }
}
