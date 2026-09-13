// Turns the manual chart-reading walkthrough from the 2026-09-09 overnight-flush
// investigation into a repeatable procedure, instead of a one-off scratch script.
//
// The manual process being encoded (session of 2026-09-09, user's own chart read plus
// the follow-up DB checks): (1) find the most recent swing pivot across a CONTINUOUS
// RTH+Globex bar sequence, not one session in isolation -- a pivot formed overnight can
// be the thing that matters during RTH and vice versa; (2) read its volume signature AT
// the touch; (3) separately read volume in the bars immediately AFTER it's confirmed --
// found empirically that the touch itself can be quiet while the real tell shows up
// several bars later, on the break away; (4) count how many independently-tracked levels
// (level_prices -- daily/weekly/IB/camarilla/floor-pivot/VWAP, every timeframe at once)
// cluster within a real proximity band of that price, using the SAME ATR-scaled band
// levelProximityService.js already uses for trade-entry proximity tagging, not a new
// definition; (5) synthesize a plain-language read from all four pieces together.
//
// UPDATED 2026-09-09 after the follow-up backtest (scratch/swing_pivot_confluence_
// breakwindow_backtest.mjs, RESEARCH_CLAIM pivot_zero_confluence_predicts_breakthrough_20260909
// / pivot_break_volume_window_sweep_20260909 / pivot_compound_signature_9_9_not_confirmed_20260909):
// the ORIGINAL hypothesis this file shipped with (elevated volume = defended level) was
// CONFIRMED BACKWARDS -- high volume at/after a pivot predicts a WORSE hold, stable across
// window widths and chronological thirds. The variable that actually turned out to matter,
// independent of volume, is CONFLUENCE COUNT: a pivot with ZERO nearby tracked levels
// reliably gets run through on a Globex-pivot/RTH-retest (N=976-1624, not day-clustered,
// stable across all 3 chronological thirds, both swingWidths). Confluence>=2 flipping the
// effect toward "holds" is only suggestive so far (not chronologically stable) -- treat that
// half as a lead, not a finding. The exact 9/9 compound pattern (quiet touch + confluence>=2
// + loud break) does NOT generalize once isolated (smaller N, higher day-clustering,
// unstable direction) -- it was the trigger for testing, not itself validated.
// `read` below is updated to foreground the ONE piece that's actually solid (zero
// confluence => unreliable) rather than the volume framing, which is now known backwards.
// Still informational only -- nothing here gates or sizes a live trade.
import { query } from '../db.js';
import { findSwingPoints } from './swingPivots.js';
import { getVolumeBaseline } from './touchQuality.js';
import { getRollingATR } from './levelProximityService.js';
import { getSessionVolumeElevation } from './sessionVolumeMonitor.js';

const CONFLUENCE_ATR_FRAC = 0.02; // matches levelProximityService.js's AT_LEVEL_ATR_FRAC
const BREAK_WINDOW_BARS = 6;      // bars examined right after confirmation, for the "does volume show up on the break" read
// 120h (5 days) chosen after measuring the actual cost, not guessed: fetch time is
// noise-level either way (93ms @ 42h vs 50ms @ 120h), and the ~1s of total analysis time
// is driven entirely by STACK_DEPTH's per-pivot lookups, not by how many bars are scanned
// -- so there's no real cost to looking back further. 42h was too narrow to ever find a
// pivot older than "yesterday" even when nothing more recent had formed (see the "does it
// reach a major pivot from a day or two ago" gap found 2026-09-09).
const DEFAULT_LOOKBACK_HOURS = 120;

// Builds the continuous RTH+Globex 5-min bar sequence analyzeMostRecentPivot() expects,
// for live/on-demand use (the backtest scripts build this same shape themselves from a
// bulk historical pull -- this is the single-poll live equivalent, not a duplicate of the
// backtest's logic, just the same target shape). ts is naive "timestamp without time zone"
// already storing ET wall-clock values directly (see CLAUDE.md's naive-timestamp entry) --
// bucket on the string's own date/time components, never round-trip through a JS Date's
// own timezone conversion.
export async function getRecentContinuousBars(hoursBack = DEFAULT_LOOKBACK_HOURS) {
  const { rows } = await query(`
    SELECT to_char(ts,'YYYY-MM-DD') as date_str,
           (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as mod,
           high::float, low::float, close::float,
           (COALESCE(bid_volume,0)+COALESCE(ask_volume,0))::int as volume
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= NOW() - INTERVAL '${Number(hoursBack)} hours' AND ts <= NOW()
    ORDER BY ts ASC
  `);
  const buckets = new Map();
  for (const r of rows) {
    const bucketMod5 = Math.floor(r.mod / 5) * 5;
    const key = `${r.date_str}_${bucketMod5}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        dateStr: r.date_str, mod: bucketMod5, mods: [r.mod],
        high: r.high, low: r.low, close: r.close, volume: r.volume,
        session: (bucketMod5 >= 570 && bucketMod5 < 960) ? 'RTH' : 'GLOBEX',
      });
    } else {
      const b = buckets.get(key);
      b.high = Math.max(b.high, r.high);
      b.low = Math.min(b.low, r.low);
      b.close = r.close;
      b.volume += r.volume;
      b.mods.push(r.mod);
    }
  }
  return [...buckets.values()];
}

// bars: [{ high, low, close, volume, dateStr, mod, mods: [minute-of-day per constituent 1-min bar] }]
// in chronological order, spanning RTH+Globex continuously (no session truncation) --
// same shape scripts/swing_pivot_volume_retest_backtest.mjs already builds.
//
// Tracks RESISTANCE (last confirmed swing high) and SUPPORT (last confirmed swing low)
// as two INDEPENDENT, parallel reads -- not "whichever pivot happened most recently."
// Found 2026-09-09: the original single-pivot version silently lost visibility into
// resistance entirely whenever the most recent event happened to be a swing low (or vice
// versa), which is wrong -- a trader watches both sides at once, not whichever side
// last moved. Each side also reports whether it's already been BROKEN (a later bar
// closed through it) -- a broken level isn't live resistance/support anymore, even if
// it's still the most recent confirmed pivot of its type.
// How many recent confirmed pivots per side to keep in the cascade stack. If the most
// recent one has already been pushed through, the next-older one becomes the active
// level automatically -- no waiting for a brand-new pivot to confirm from scratch.
//
// Raised 5 -> 25 (2026-09-09) after finding depth=5 was structurally too shallow: a
// single active RTH day alone produced 42 confirmed swing highs / 43 lows at
// swingWidth=5, so the stack was always fully consumed by TODAY's own noise and could
// never reach back to yesterday's pivots even with a 5-day data window -- widening the
// data window alone (42h -> 120h) did nothing, this was the actual bottleneck. 25 is
// enough headroom for ~2-3 typical days per side without the cost exploding, made
// affordable by the per-date cache below (most pivots on the same day now share ONE
// baseline/ATR/level_prices lookup instead of redundantly re-querying per pivot).
const STACK_DEPTH = 25;

// Per-invocation cache, keyed by dateStr, shared across every pivot in one buildBothRaw()
// call. Without this, raising STACK_DEPTH would multiply DB round-trips linearly even
// though most stack entries on a busy day share the exact same date.
//
// IMPORTANT: caches the in-flight PROMISE, not the awaited value. buildStackAndActive()
// fires all 25 pivots concurrently via Promise.all, so a naive "await then cache the
// result" pattern has a race -- every concurrent pivot on the same date checks
// has()/misses before the first one finishes awaiting and writes the cache, so they all
// fire the same expensive query anyway. Caught by measuring, not guessing: STACK_DEPTH=25
// with the naive version still took ~7s despite the stack spanning only 2 distinct dates.
// Storing the promise itself means every concurrent caller for the same date awaits the
// SAME in-flight request -- the same request-coalescing pattern this codebase already
// uses for setupDetectionInFlight/confluenceTodayInFlight, applied here per-key instead
// of globally. Fixed this brought a 2-distinct-date, 50-pivot call down to ~1.2s.
function makeDateCache() {
  return { baselines: new Map(), atrs: new Map(), levels: new Map() };
}
function getCachedBaseline(cache, dateStr) {
  if (!cache.baselines.has(dateStr)) cache.baselines.set(dateStr, getVolumeBaseline(query, dateStr));
  return cache.baselines.get(dateStr);
}
function getCachedATR(cache, dateStr) {
  if (!cache.atrs.has(dateStr)) cache.atrs.set(dateStr, getRollingATR(dateStr));
  return cache.atrs.get(dateStr);
}
function getCachedLevels(cache, dateStr) {
  if (!cache.levels.has(dateStr)) {
    cache.levels.set(dateStr, query(`SELECT level_name, price::float FROM level_prices WHERE trade_date=$1 AND price IS NOT NULL`, [dateStr]).then(r => r.rows));
  }
  return cache.levels.get(dateStr);
}

// _confirmIdx (internal ordering field) is stripped before returning to callers.
// Builds each side's stack MOST-RECENT-FIRST, then walks it for the first entry that
// hasn't been broken -- that's the "active" resistance/support after cascading past any
// already-broken ones. If every entry in the stack is broken (a real possibility in a
// fast trending move), falls back to the most recent one anyway with broken:true intact,
// rather than returning null and hiding that everything nearby has given way.
async function buildStackAndActive(bars, points, type, swingWidth, cache) {
  const recent = points.slice(-STACK_DEPTH).reverse(); // most-recent-first
  // `points` (ALL confirmed same-type pivots, not just the recent slice) is passed through
  // so buildLevelRead can look back for dormancy -- a stack entry near the start of the
  // recent slice still needs visibility into older same-type pivots to find its own prior
  // touch, which may fall outside STACK_DEPTH.
  const stack = await Promise.all(recent.map(p => buildLevelRead(bars, p, type, swingWidth, cache, points)));
  const active = stack.find(p => !p.broken) || stack[0] || null;
  return { active, stack };
}

async function buildBothRaw(bars, swingWidth) {
  const { highs, lows } = findSwingPoints(bars, swingWidth);
  const cache = makeDateCache();
  const [resistanceInfo, supportInfo] = await Promise.all([
    buildStackAndActive(bars, highs, 'HIGH', swingWidth, cache),
    buildStackAndActive(bars, lows, 'LOW', swingWidth, cache),
  ]);
  return {
    resistance: resistanceInfo.active, resistanceStack: resistanceInfo.stack,
    support: supportInfo.active, supportStack: supportInfo.stack,
  };
}

export async function analyzeSupportResistance(bars, { swingWidth = 5 } = {}) {
  const [{ resistance, resistanceStack, support, supportStack }, sessionVolume] = await Promise.all([
    buildBothRaw(bars, swingWidth),
    getSessionVolumeElevation().catch(() => null), // sustained/session-wide volume context (the "holding higher than normal" read) -- informational, never blocks the pivot read if it fails
  ]);
  const strip = r => r ? (({ _confirmIdx, ...rest }) => rest)(r) : null;
  return {
    resistance: strip(resistance), support: strip(support),
    resistanceStack: resistanceStack.map(strip), supportStack: supportStack.map(strip),
    sessionVolume,
  };
}

// Kept for the one existing caller (server/routes/pivotAnalysis.js's original shape) --
// returns whichever of resistance/support was confirmed more recently, same as before.
// Prefer analyzeSupportResistance() for anything new.
export async function analyzeMostRecentPivot(bars, { swingWidth = 5 } = {}) {
  const { resistance, support } = await buildBothRaw(bars, swingWidth);
  if (!resistance && !support) return null;
  const pivot = (!support || (resistance && resistance._confirmIdx > support._confirmIdx)) ? resistance : support;
  const { _confirmIdx, ...rest } = pivot;
  return rest;
}

// Days since an arbitrary fixed epoch, purely for relative time-gap arithmetic -- never
// converted back through Date/toLocaleString (same discipline as the naive-timestamp
// footgun this file's investigation already hit once). bars carry dateStr ('YYYY-MM-DD')
// and mod (minute-of-day) directly from the naive ET column, so this is pure arithmetic on
// already-correct components, not a timezone reinterpretation.
function barMinutesSinceEpoch(bar) {
  const [y, mo, d] = bar.dateStr.split('-').map(Number);
  const daysSinceEpoch = Math.floor(Date.UTC(y, mo - 1, d) / 86400000);
  return daysSinceEpoch * 1440 + bar.mod;
}

async function buildLevelRead(bars, pivotPoint, type, swingWidth, cache, allSameTypePoints) {
  const pivotBar = bars[pivotPoint.idx];
  const confirmIdx = pivotPoint.idx + swingWidth;
  const confirmBar = bars[confirmIdx];

  // Step 1: volume signature AT the touch.
  const baseline = await getCachedBaseline(cache, pivotBar.dateStr);
  const touchVolZ = zScoreForBar(pivotBar, baseline);

  // Step 2: volume signature in the bars right after confirmation (the break/reaction window).
  const breakBars = bars.slice(confirmIdx, Math.min(bars.length, confirmIdx + BREAK_WINDOW_BARS));
  const breakZs = breakBars.map(b => zScoreForBar(b, baseline)).filter(z => z != null);
  const breakVolZ = breakZs.length ? breakZs.reduce((a, b) => a + b, 0) / breakZs.length : null;

  // Step 3: known-level confluence, reusing the exact ATR-scaled band this codebase
  // already validated for proximity tagging (levelProximityService.js) rather than
  // inventing a new distance definition.
  const atr = await getCachedATR(cache, pivotBar.dateStr);
  const band = atr != null ? atr * CONFLUENCE_ATR_FRAC : null;
  let nearbyLevels = [];
  if (band != null) {
    const rows = await getCachedLevels(cache, pivotBar.dateStr);
    nearbyLevels = rows
      .map(r => ({ level: r.level_name, price: r.price, dist: Math.round(Math.abs(r.price - pivotPoint.price) * 100) / 100 }))
      .filter(r => r.dist <= band)
      .sort((a, b) => a.dist - b.dist);
  }

  // Step 4: has this level already been broken? A later bar's CLOSE beyond it (not just an
  // intrabar wick) means it's no longer live resistance/support, regardless of recency.
  let broken = false, brokenAt = null;
  for (let i = confirmIdx + 1; i < bars.length; i++) {
    if (type === 'HIGH' && bars[i].close > pivotPoint.price) { broken = true; brokenAt = bars[i]; break; }
    if (type === 'LOW' && bars[i].close < pivotPoint.price) { broken = true; brokenAt = bars[i]; break; }
  }

  // Step 5: dormancy -- hours since the most recent PRIOR confirmed pivot of the SAME TYPE
  // within the same confluence band (2026-09-09 backtest: real but modest effect, ~29%
  // bigger moves at 7+ days dormancy vs <1h, NOT a clean monotonic staircase -- a real dip
  // at 3-7 days. Report the number plainly, don't oversell it as a strong signal).
  let dormancyHours = null;
  if (band != null && allSameTypePoints) {
    const pivotMin = barMinutesSinceEpoch(pivotBar);
    for (let i = allSameTypePoints.length - 1; i >= 0; i--) {
      const p = allSameTypePoints[i];
      if (p.idx >= pivotPoint.idx) continue; // strictly before -- no lookahead
      if (Math.abs(p.price - pivotPoint.price) > band) continue;
      dormancyHours = (pivotMin - barMinutesSinceEpoch(bars[p.idx])) / 60;
      break; // allSameTypePoints is chronological, so this is the MOST RECENT qualifying prior touch
    }
  }

  // Step 6: synthesize a plain-language read -- an ATTENTION read (per user direction,
  // 2026-09-09: none of confluence/dormancy/volume individually clears the bar for a
  // directional call, but combined they flag which of the many pivots in a day are worth
  // watching at all), not a hold/break or direction prediction.
  const read = (broken
    ? `Already broken -- price closed ${type === 'HIGH' ? 'above' : 'below'} this level on ${brokenAt.dateStr}, so it is no longer live ${type === 'HIGH' ? 'resistance' : 'support'}. `
    : '') + synthesizeRead({ touchVolZ, breakVolZ, confluenceCount: nearbyLevels.length, dormancyHours });

  return {
    type, price: pivotPoint.price, dateStr: pivotBar.dateStr, session: pivotBar.session,
    confirmedAtDateStr: confirmBar?.dateStr ?? null,
    broken, brokenAtDateStr: brokenAt?.dateStr ?? null,
    touchVolZ: touchVolZ != null ? +touchVolZ.toFixed(2) : null,
    breakVolZ: breakVolZ != null ? +breakVolZ.toFixed(2) : null,
    dormancyHours: dormancyHours != null ? +dormancyHours.toFixed(1) : null,
    atr20: atr != null ? +atr.toFixed(1) : null,
    confluenceBandPts: band != null ? +band.toFixed(1) : null,
    confluenceCount: nearbyLevels.length,
    nearbyLevels,
    read,
    _confirmIdx: confirmIdx,
  };
}

function zScoreForBar(bar, baseline) {
  const mods = bar.mods || [bar.mod];
  let expVol = 0, expVar = 0, valid = 0;
  for (const m of mods) {
    const b = baseline.get(m);
    if (b && b.std_vol > 0) { expVol += b.avg_vol; expVar += b.std_vol ** 2; valid++; }
  }
  if (!valid) return null;
  return (bar.volume - expVol) / Math.sqrt(expVar);
}

// ATTENTION read (user direction, 2026-09-09): none of confluence, dormancy, or volume
// individually predicts DIRECTION or hold/break reliably enough to trade on alone -- every
// one of today's backtests came back real-but-modest or unstable when isolated. What they
// DO support is a filter for which of the many pivots in a day are even worth watching:
// proximity to known levels (confluence) + how long the level's gone undisturbed (dormancy)
// + whether volume is elevated right now (touch) and/or has been running hot all session
// (sustained, see sessionVolumeMonitor.js) together describe a moment with more of the real
// ingredients of a move than most -- not a call on which way it goes or whether it holds.
function synthesizeRead({ touchVolZ, breakVolZ, confluenceCount, dormancyHours }) {
  const parts = [];

  // Dormancy bucketed per the user's own stated thresholds (2026-09-09) and roughly
  // matching the backtest's real shape: <1h weakest (mean MFE/ATR 0.515), 6h-3days
  // strongest (0.616-0.628), a real (not glossed-over) dip at 3-7 days (0.577), 7+ days
  // highest (0.664) -- NOT a clean staircase, say so rather than oversimplifying.
  let dormancyPhrase;
  if (dormancyHours == null) {
    dormancyPhrase = 'no prior touch of this exact zone found in the lookback window (or none within the confluence band)';
  } else if (dormancyHours < 1) {
    dormancyPhrase = `only ${(dormancyHours * 60).toFixed(0)} minutes since this zone was last tested -- historically the weakest dormancy bucket, not much on its own`;
  } else if (dormancyHours < 4) {
    dormancyPhrase = `${dormancyHours.toFixed(1)} hours since last tested -- modest, below the range that showed a real effect`;
  } else if (dormancyHours < 168) {
    const days = dormancyHours / 24;
    dormancyPhrase = `${dormancyHours >= 24 ? days.toFixed(1) + ' days' : dormancyHours.toFixed(1) + ' hours'} since last tested -- this is the range (4h+ intraday through a few days) that showed a real, if inconsistent, bigger-reaction effect (note: the 3-7 day part of this range was actually one of the WEAKER points, not the strongest -- don't oversell it)`;
  } else {
    dormancyPhrase = `${(dormancyHours / 24).toFixed(1)} days since last tested -- the longest-dormancy bucket, which showed the biggest mean reaction in the backtest (0.664 vs 0.515 MFE/ATR for <1h), though N here is thinner than the shorter buckets`;
  }
  parts.push(`Dormancy: ${dormancyPhrase}.`);

  if (confluenceCount === 0) {
    parts.push(`Confluence: none -- no tracked level sits at this price, which on its own reliably predicts this level gets run through on retest (the one cleanly stable finding from today's research).`);
  } else if (confluenceCount === 1) {
    parts.push(`Confluence: 1 tracked level nearby -- some backing, but not enough alone to call this reliable.`);
  } else {
    parts.push(`Confluence: ${confluenceCount} independently-tracked levels cluster here -- real structural backing, though "more confluence holds better" itself wasn't confirmed as stable, treat as one ingredient, not a guarantee.`);
  }

  if (touchVolZ != null && breakVolZ != null) {
    parts.push(`Volume at this specific touch: z=${touchVolZ.toFixed(2)} (touch), z=${breakVolZ.toFixed(2)} (post-confirmation) -- elevated here has historically meant a WORSE hold, not reassurance, so read a high number as "something is happening," not "this will hold."`);
  }

  parts.push(`Net: this is an ATTENTION read (which pivots are worth watching), not a directional or hold/break call -- no single piece here has been validated strongly enough to trade on its own.`);
  return parts.join(' ');
}
