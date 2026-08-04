// One-time backfill of pre-trade compression metrics onto historical active_setups rows,
// per docs/COMPRESSION_TAIL_MFE_SPEC.md Part 1. Read that spec doc first — it has the full
// lineage (two prior, rejected regime-classification attempts) and the reasoning for why
// this is a genuinely different test, not a third re-run of the same one.
//
// Three metrics, all data-derived (no static thresholds), all computed with no lookahead:
//   1. va_width_pctile_60d — the trade's own developing value-area width (VAH-VAL) as of
//      the ENTRY MOMENT (fired_at), percentile-ranked against the trailing 60 prior trading
//      days' developing width AT THE SAME ELAPSED SESSION TIME. This resolves the spec's
//      explicitly-flagged "open implementation decision" (same-day lookahead handling):
//      using each day's FINAL (full-session) width for comparison would (a) leak the rest
//      of the trade's own day into a "pre-trade" measure, and (b) bias every trade toward
//      looking artificially compressed, since a partial developing width is almost always
//      narrower than a full session's. Comparing developing-width-at-the-same-elapsed-time
//      across all 61 days (today + 60 trailing) is the only apples-to-apples, lookahead-safe
//      construction — "how does today's range-so-far compare to what range-so-far usually
//      looks like at this same point in the session, over the last 60 days."
//   2. va_overlap_streak — count of consecutive PRIOR sessions (strictly before trade_date)
//      whose value areas overlap, walked backward from the day before trade_date. Entirely
//      built from FINAL, fully-known prior-day profiles — no lookahead concern at all, since
//      it never touches the trade's own day.
//   3. ib_range_pctile_60d — the trade's own day's Initial Balance (60-min, RTH open to
//      10:30 ET — this codebase's established IB window, see CLAUDE.md's "New setup type
//      checklist" item 10) range, percentile-ranked against the trailing 60 prior days' IB
//      ranges. Only computed for trades firing AT OR AFTER IB close (fired_at ET-minute
//      >= 630) — for anything earlier, the day's own IB isn't formed yet and using it would
//      be a lookahead leak, so it's left NULL, same convention as every other same-day-
//      forming level in this codebase (OR_HIGH/IB_HIGH gate at etMin>=630 per CLAUDE.md).
//
// Scope: origin_status IN ('ACTIVE','SHADOW') (real touches only, never BACKFILL/UNKNOWN —
// the standing ~80%-synthetic caveat), is_rth=true (value-area/IB are RTH-native concepts —
// see docs/COMPRESSION_TAIL_MFE_SPEC.md, Globex is a known, explicitly-flagged gap, not a
// silent omission), resolved with a real mfe_points (matches exactly what Part 2's tail-MFE
// test will consume — no point backfilling rows that test can never use).
//
// Usage: node scripts/backfill_compression_metrics.mjs [--dry-run]
import { query } from '../server/db.js';
import { computeProfile } from '../server/services/developingValueService.js';

const RTH_START = 570;   // 9:30 ET
const RTH_END = 960;     // 16:00 ET (exclusive)
const IB_CLOSE = 630;    // 10:30 ET — this codebase's established 60-min IB window
const MIN_BARS_FOR_DEVELOPING_PROFILE = 10; // matches computeLiveSession()'s own floor
const TRAILING_WINDOW = 60;
const MIN_VALID_TRAILING_DAYS = 30; // half of the 60-day window, floor for a meaningful percentile

const dryRun = process.argv.includes('--dry-run');

function etMinuteOf(dateLike) {
  const d = new Date(dateLike);
  // fired_at/ts are naive ET timestamps re-labeled UTC by db.js's type parser (documented
  // convention — see breakevenTrailCore.mjs's identical bar.dateObj.getUTCHours() usage) —
  // getUTCHours()/getUTCMinutes() recovers the real ET wall-clock time, not a UTC one.
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function percentileRank(value, sortedArr) {
  // Standard midrank percentile: (count strictly below + 0.5*count equal) / n * 100.
  if (value == null || !sortedArr.length) return null;
  let below = 0, equal = 0;
  for (const v of sortedArr) {
    if (v < value) below++;
    else if (v === value) equal++;
  }
  return +(((below + 0.5 * equal) / sortedArr.length) * 100).toFixed(1);
}

function vaOverlap(a, b) {
  return a.val <= b.vah && a.vah >= b.val;
}

async function main() {
  console.log('Loading real RTH resolved trades needing compression backfill...');
  const tradesQ = await query(`
    SELECT id, setup_type, trade_date::text as trade_date, fired_at
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW') AND is_rth = true
      AND resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED')
      AND mfe_points IS NOT NULL
    ORDER BY trade_date ASC
  `);
  const trades = tradesQ.rows;
  console.log(`  ${trades.length} eligible rows.`);
  if (!trades.length) { console.log('Nothing to backfill.'); process.exit(0); }

  console.log('Loading all NQ RTH bars (this may take a moment)...');
  const barsQ = await query(`
    SELECT ts, ts::date::text as d, high::float as high, low::float as low, volume::float as volume
    FROM price_bars_primary
    WHERE symbol = 'NQ'
      AND (EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts)) BETWEEN ${RTH_START} AND ${RTH_END - 1}
    ORDER BY ts ASC
  `);
  const barsByDay = new Map(); // date string -> bars[] ascending, each bar tagged with its etMin
  for (const b of barsQ.rows) {
    const em = etMinuteOf(b.ts);
    if (!barsByDay.has(b.d)) barsByDay.set(b.d, []);
    barsByDay.get(b.d).push({ high: b.high, low: b.low, volume: b.volume, etMin: em });
  }
  const tradingDays = [...barsByDay.keys()].sort(); // ascending date strings
  const dayIndex = new Map(tradingDays.map((d, i) => [d, i]));
  console.log(`  ${tradingDays.length} distinct NQ RTH trading days loaded.`);

  // Precompute, once per day: final (full-session) profile + final IB range. Both are
  // fully-known, lookahead-free facts about a PRIOR day the moment that day has closed.
  console.log('Precomputing per-day final value-area profiles and IB ranges...');
  const finalProfileByDay = new Map();
  const ibRangeByDay = new Map();
  for (const d of tradingDays) {
    const bars = barsByDay.get(d);
    const profile = computeProfile(bars);
    if (profile) finalProfileByDay.set(d, { vah: profile.vah, val: profile.val });
    const ibBars = bars.filter(b => b.etMin < IB_CLOSE);
    if (ibBars.length >= MIN_BARS_FOR_DEVELOPING_PROFILE) {
      const ibHigh = Math.max(...ibBars.map(b => b.high));
      const ibLow = Math.min(...ibBars.map(b => b.low));
      ibRangeByDay.set(d, ibHigh - ibLow);
    }
  }

  // Cache of developing-profile-width at a given (day, cutoffEtMin) pair, since many trades
  // on the same day (or with the same time-of-day cutoff across days) will re-request it.
  const devWidthCache = new Map(); // key: `${day}|${cutoffEtMin}` -> width or null
  function developingWidth(day, cutoffEtMin) {
    const key = `${day}|${cutoffEtMin}`;
    if (devWidthCache.has(key)) return devWidthCache.get(key);
    const bars = barsByDay.get(day);
    if (!bars) { devWidthCache.set(key, null); return null; }
    const devBars = bars.filter(b => b.etMin <= cutoffEtMin);
    if (devBars.length < MIN_BARS_FOR_DEVELOPING_PROFILE) { devWidthCache.set(key, null); return null; }
    const profile = computeProfile(devBars);
    const width = profile ? profile.vah - profile.val : null;
    devWidthCache.set(key, width);
    return width;
  }

  let updated = 0, skippedNoDay = 0;
  const stats = { widthComputed: 0, streakComputed: 0, ibComputed: 0 };

  for (const t of trades) {
    const day = t.trade_date;
    const idx = dayIndex.get(day);
    if (idx == null) { skippedNoDay++; continue; }
    const etMin = etMinuteOf(t.fired_at);

    // ── Metric 1: va_width_pctile_60d ──────────────────────────────────────
    let vaWidthPctile = null;
    const todayWidth = developingWidth(day, etMin);
    if (todayWidth != null) {
      const trailingWidths = [];
      for (let back = 1; back <= TRAILING_WINDOW && idx - back >= 0; back++) {
        const priorDay = tradingDays[idx - back];
        const w = developingWidth(priorDay, etMin);
        if (w != null) trailingWidths.push(w);
      }
      if (trailingWidths.length >= MIN_VALID_TRAILING_DAYS) {
        vaWidthPctile = percentileRank(todayWidth, trailingWidths);
        stats.widthComputed++;
      }
    }

    // ── Metric 2: va_overlap_streak (entirely prior-day, no lookahead) ─────
    let overlapStreak = 0;
    let prev = idx - 1 >= 0 ? finalProfileByDay.get(tradingDays[idx - 1]) : null;
    if (prev) {
      for (let back = 2; back <= TRAILING_WINDOW + 1 && idx - back >= 0; back++) {
        const cur = finalProfileByDay.get(tradingDays[idx - back]);
        if (!cur || !vaOverlap(prev, cur)) break;
        overlapStreak++;
        prev = cur;
      }
      if (overlapStreak > 0) stats.streakComputed++;
    }

    // ── Metric 3: ib_range_pctile_60d (only once IB has closed for the day) ─
    let ibRangePctile = null;
    if (etMin >= IB_CLOSE) {
      const todayIbRange = ibRangeByDay.get(day);
      if (todayIbRange != null) {
        const trailingIb = [];
        for (let back = 1; back <= TRAILING_WINDOW && idx - back >= 0; back++) {
          const r = ibRangeByDay.get(tradingDays[idx - back]);
          if (r != null) trailingIb.push(r);
        }
        if (trailingIb.length >= MIN_VALID_TRAILING_DAYS) {
          ibRangePctile = percentileRank(todayIbRange, trailingIb);
          stats.ibComputed++;
        }
      }
    }

    if (!dryRun) {
      await query(`
        UPDATE active_setups
        SET va_width_pctile_60d = $1, va_overlap_streak = $2, ib_range_pctile_60d = $3
        WHERE id = $4
      `, [vaWidthPctile, overlapStreak, ibRangePctile, t.id]);
    }
    updated++;
    if (updated % 200 === 0) console.log(`  ...${updated}/${trades.length}`);
  }

  console.log(`Done. ${updated} rows ${dryRun ? 'would be updated (dry-run)' : 'updated'}, ${skippedNoDay} skipped (no matching trading day in bar history).`);
  console.log('Coverage:', stats, `of ${trades.length} total.`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
