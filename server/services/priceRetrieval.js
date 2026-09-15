// Shared "get the current live price" helper — centralizes an idiom that used to be
// hand-copied ~16 times across server/routes/acd.js, resolveSetups.js, setupExpiry.js,
// confluence.js, auctionRead.js, antigravityEdges.js, momentumChaseDetector.js, and
// minuteBarSignalDetector.js: `SELECT close FROM price_bars_primary WHERE symbol='NQ' AND
// ts::date >= CURRENT_DATE - 5 ORDER BY ts DESC LIMIT N`.
//
// That idiom has no assertion the returned row is actually recent — DeepSeek's 3rd pass on
// OPEN_DECISION globex_vwap_fade_stale_price_after_restart_20260914 confirmed this is the
// shared "linchpin" vulnerability: whenever price_bars_primary's live branch fails to
// produce a current row for ANY reason (the price_bars_contract_calendar roll-race this
// same investigation fixed, a weekend closure, a future not-yet-seen cause), every one of
// those 16 copies silently returned the freshest bar within the last 5 days instead —
// exactly the "Friday's price handed back on Monday" bug that cost two real STOP_HIT losses
// on 2026-09-14 (see OPEN_DECISION contract_calendar_roll_race_stale_price_20260915).
//
// Per DeepSeek's design-critique pass (2026-09-15, Q4): this is a FRESHNESS assertion, not
// a naive `ts::date = CURRENT_DATE` equality — overnight Globex bars and a legitimate
// "market just reopened, no bar yet" state both need to keep working. A bounded staleness
// window (below) converts "silently wrong" into "loudly skipped," which is the correct
// tradeoff during active trading: a missed detection window beats a real trade firing
// against a fictitious price. This does NOT try to distinguish a real bug from a known
// closure window (weekend, the daily 5-6PM ET maintenance gap) — during those, every call
// site legitimately gets no candidate anyway, so returning [] is correct either way and
// the once-per-day log dedup below keeps that from ever being noisy.
import { query } from '../db.js';
import { etNaiveTimestampToMs } from './acdShared.js';

// Plumbing parameter, not a trading threshold (no entry/stop/target/signal math) — same
// exception this codebase already carries for GLOBEX_REFIRE_MIN_TRADE_DURATION_MINUTES.
// 15 minutes is generous slack over the ~60s bar-ingestion poll + ~1min bar-formation lag;
// it catches the multi-hour/multi-day staleness this bug class actually produces without
// spuriously firing on ordinary jitter.
const FRESHNESS_MINUTES = 15;

let _lastStaleLogDate = null;
function logStaleOnce(context, ageMinutes) {
  // ET calendar day, not JS's UTC toISOString() -- the two disagree once past 8PM ET, which
  // would otherwise let this fire twice in one real trading day right at that boundary.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (_lastStaleLogDate === today) return;
  _lastStaleLogDate = today;
  console.error(`[price-retrieval-stale] ${context}: latest price_bars_primary row for NQ is ${ageMinutes.toFixed(1)}min old (>${FRESHNESS_MINUTES}min threshold) — returning no bars rather than a stale price. Logged once/day; check price_bars_contract_calendar and price_bars_dedup_hist's refresh state if this persists.`);
}

// Returns up to `limit` most recent bars for `symbol`, newest first, or [] if the freshest
// available row is older than FRESHNESS_MINUTES (a real gap/closure/bug — the caller should
// treat this exactly like "no data," which every existing call site already does safely).
// `columns` is interpolated directly into the SQL, not parameterized -- every caller in this
// codebase passes a literal string, never user input. Keep it that way.
export async function getLatestBars(symbol, { limit = 1, columns = 'close::float as close' } = {}, context = 'getLatestBars') {
  const { rows } = await query(`
    SELECT ts::text as ts, ${columns} FROM price_bars_primary
    WHERE symbol=$1 AND ts::date >= CURRENT_DATE - 5
    ORDER BY ts DESC LIMIT $2
  `, [symbol, limit]);
  if (!rows.length) return [];
  const ageMinutes = (Date.now() - etNaiveTimestampToMs(rows[0].ts)) / 60000;
  if (!isFinite(ageMinutes) || ageMinutes > FRESHNESS_MINUTES) {
    logStaleOnce(context, ageMinutes);
    return [];
  }
  // Exposes the CORRECTLY-computed age (via etNaiveTimestampToMs, not a naive `new
  // Date(row.ts)` against Date.now()) so a caller that wants to display/log it doesn't
  // re-derive it by hand and risk the exact naive-timestamp-vs-Date.now() bug this
  // codebase already has a standing convention against.
  rows[0].ageMinutes = ageMinutes;
  return rows;
}

// Thin wrapper for the single-most-common case: "what is NQ trading at right now."
// Returns null (never a stale price) if no sufficiently-fresh bar exists.
export async function getCurrentPrice(symbol = 'NQ', context = 'getCurrentPrice') {
  const rows = await getLatestBars(symbol, { limit: 1, columns: 'close::float as close' }, context);
  return rows[0]?.close ?? null;
}
