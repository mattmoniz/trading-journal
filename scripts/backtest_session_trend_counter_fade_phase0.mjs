// Session-trend counter-fade gate -- Phase 0, NOT wired live.
//
// User's proposal (2026-09-16, grounded in a real live session: "price is coming into the
// next level which is why shorts keep firing but it keeps going up... turn off the shorts
// while the overall trend is moving up and vice versa"). Rather than inventing a new trend
// detector, this reuses the ALREADY-LIVE, already-displayed session character classifier --
// classifySessionChar() (server/routes/morningBrief.js), the exact function that feeds
// quick-check.html's "SESSION: TREND UP/DOWN" chip and GET /session-trend-history/:date's
// bar-by-bar replay. Exported for this reuse (2026-09-16), per this codebase's "export the
// real function, never reimplement live-derived classification logic inline in a backtest
// script" rule -- this script calls the SAME function with the SAME day-level trailing
// constants (atr20/rotStats/ibTightThreshold/ibWideThreshold), computed the same
// strictly-before-this-day way, not a hand-copied reimplementation.
//
// NOTE: this is a DIFFERENT, working classifier from the dtClass/isTrendCounterFade() gate
// documented as permanently broken in CLAUDE.md/docs/STRUCTURAL_BREAKOUT_RETEST_SPEC.md
// (dtClass reads acd_daily_log.day_type, which is null all day at decision time) -- do not
// confuse the two. sessionChar is RTH-only (IB-based thresholds, etMin>=630 required) and is
// walked bar-by-bar with no lookahead, exactly matching GET /session-trend-history/:date.
//
// Classification per real trade: AGAINST_TREND (SHORT while sessionChar=TREND_UP, or LONG
// while TREND_DOWN), WITH_TREND (the mirror), NEUTRAL (any other sessionChar: BALANCE/CHOP/
// EXTREME_CHOP/TIGHT_IB/WIDE_IB/DEVELOPING, or too early in the session to classify).

import { query } from '../server/db.js';
import { resolveDirection } from '../server/config/setupTypes.js';
import { classifySessionChar, getTrailingATR, getTrailingRotations } from '../server/routes/morningBrief.js';
import { rollingStats } from '../server/services/queries.js';
import { POOLED_TRADE_FILTER } from './backtest_setup_status.mjs';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const MIN_SAMPLES = 20; // matches morningBrief.js's own MIN_SAMPLES

async function loadRthTrades() {
  const r = await query(`
    SELECT setup_type, trade_date::text AS trade_date, fired_at, actual_pnl::float AS pnl,
           stop_level::float AS stop_level, t1_level::float AS t1_level
    FROM active_setups
    WHERE ${POOLED_TRADE_FILTER} AND actual_pnl IS NOT NULL AND is_rth = true
    ORDER BY trade_date ASC, fired_at ASC
  `);
  return r.rows;
}

async function getDayConstants(date) {
  const [atr20, trailingRots, ibRangePercQ] = await Promise.all([
    getTrailingATR(date, 20),
    getTrailingRotations(date, 90),
    query(`
      SELECT
        PERCENTILE_CONT(0.33) WITHIN GROUP (ORDER BY (ib_high - ib_low)) AS p33,
        PERCENTILE_CONT(0.67) WITHIN GROUP (ORDER BY (ib_high - ib_low)) AS p67
      FROM (
        SELECT MAX(high)::float AS ib_high, MIN(low)::float AS ib_low
        FROM price_bars_primary
        WHERE symbol='NQ' AND ts::date < $1
          AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 630
        GROUP BY ts::date ORDER BY ts::date DESC LIMIT 90
      ) t
    `, [date]).catch(() => ({ rows: [{}] })),
  ]);
  const rotStats = trailingRots.length >= MIN_SAMPLES ? rollingStats(trailingRots) : { mean: 10, std: 5 };
  const ibTightThreshold = Math.round(ibRangePercQ.rows[0]?.p33 ?? 146);
  const ibWideThreshold = Math.round(ibRangePercQ.rows[0]?.p67 ?? 229);
  return { atr20, rotStats, ibTightThreshold, ibWideThreshold };
}

async function classifyDay(date, dayTrades) {
  const barsRes = await query(
    `SELECT (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min,
            open::float, high::float, low::float, close::float, volume::bigint as vol, ts
     FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
     AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959 ORDER BY ts`, [date]);
  const bars = barsRes.rows;
  if (bars.length < 10) return dayTrades.map(t => ({ ...t, sessionChar: null }));

  const { atr20, rotStats, ibTightThreshold, ibWideThreshold } = await getDayConstants(date);

  // For each trade, find the last bar with et_min <= trade's own et_min (no lookahead --
  // matching this codebase's "floor timestamps to the minute before matching bars" convention).
  return dayTrades.map(t => {
    const firedEtMin = new Date(t.fired_at).getUTCHours() * 60 + new Date(t.fired_at).getUTCMinutes();
    const idx = bars.findLastIndex(b => b.et_min <= firedEtMin);
    if (idx < 0) return { ...t, sessionChar: null };
    const barsSoFar = bars.slice(0, idx + 1);
    const { sessionChar } = classifySessionChar({ bars: barsSoFar, atr20, rotStats, ibTightThreshold, ibWideThreshold });
    return { ...t, sessionChar };
  });
}

function bucketStats(rows) {
  const n = rows.length;
  const wins = rows.filter(t => t.pnl > 0).length;
  const pnl = rows.reduce((s, t) => s + t.pnl, 0);
  return { n, wr: n ? +(100 * wins / n).toFixed(1) : null, ev: n ? +(pnl / n).toFixed(2) : null };
}

async function main() {
  const todayR = await query(`SELECT CURRENT_DATE::text AS today`);
  const today = todayR.rows[0].today;

  const allTrades = await loadRthTrades();
  const classified = allTrades.map(t => ({ ...t, dir: resolveDirection(t) })).filter(t => t.dir != null);
  console.log(`Real RTH trades: ${allTrades.length}, classifiable by direction: ${classified.length}`);

  const byDate = new Map();
  for (const t of classified) {
    if (!byDate.has(t.trade_date)) byDate.set(t.trade_date, []);
    byDate.get(t.trade_date).push(t);
  }
  console.log(`Distinct RTH trade dates: ${byDate.size}`);

  const tagged = [];
  let processed = 0;
  for (const [date, dayTrades] of byDate) {
    const withChar = await classifyDay(date, dayTrades);
    tagged.push(...withChar);
    processed++;
    if (processed % 25 === 0) console.log(`  ...classified ${processed}/${byDate.size} days`);
  }

  const relevant = tagged.filter(t => ['TREND_UP', 'TREND_DOWN'].includes(t.sessionChar));
  const against = relevant.filter(t => (t.dir === 'SHORT' && t.sessionChar === 'TREND_UP') || (t.dir === 'LONG' && t.sessionChar === 'TREND_DOWN'));
  const withT = relevant.filter(t => (t.dir === 'LONG' && t.sessionChar === 'TREND_UP') || (t.dir === 'SHORT' && t.sessionChar === 'TREND_DOWN'));
  const neutral = tagged.filter(t => t.sessionChar != null && !['TREND_UP', 'TREND_DOWN'].includes(t.sessionChar));
  const noChar = tagged.filter(t => t.sessionChar == null).length;

  console.log(`\nsessionChar breakdown: TREND_UP/DOWN=${relevant.length}, other-classified=${neutral.length}, unclassifiable=${noChar}`);
  console.log(`\nAGAINST_TREND (SHORT in TREND_UP, LONG in TREND_DOWN): ${JSON.stringify(bucketStats(against))}`);
  console.log(`WITH_TREND    (LONG in TREND_UP, SHORT in TREND_DOWN): ${JSON.stringify(bucketStats(withT))}`);
  console.log(`NEUTRAL (all other sessionChar):                      ${JSON.stringify(bucketStats(neutral))}`);

  // Direction split -- does "against trend" mean the same thing in both directions?
  const againstShortInUp = against.filter(t => t.dir === 'SHORT');
  const againstLongInDown = against.filter(t => t.dir === 'LONG');
  const withLongInUp = withT.filter(t => t.dir === 'LONG');
  const withShortInDown = withT.filter(t => t.dir === 'SHORT');
  console.log(`\n  SHORT during TREND_UP (against):   ${JSON.stringify(bucketStats(againstShortInUp))}`);
  console.log(`  LONG during TREND_UP (with):       ${JSON.stringify(bucketStats(withLongInUp))}`);
  console.log(`  LONG during TREND_DOWN (against):  ${JSON.stringify(bucketStats(againstLongInDown))}`);
  console.log(`  SHORT during TREND_DOWN (with):    ${JSON.stringify(bucketStats(withShortInDown))}`);

  let rigor = { clustered: null, stable: null, top5DayPct: null, distinctDates: null };
  if (against.length >= 20) {
    rigor = computeRigor(against, { dateField: 'trade_date', pnlFn: t => t.pnl });
    console.log(`\nRigor on AGAINST_TREND bucket: clustered=${rigor.clustered} stable=${rigor.stable} top5DayPct=${rigor.top5DayPct}% distinctDates=${rigor.distinctDates}`);
  }

  const aStats = bucketStats(against), wStats = bucketStats(withT), nStats = bucketStats(neutral);
  const verdict = against.length < 20 ? 'THIN_N'
    : aStats.ev < wStats.ev && aStats.ev < nStats.ev ? 'AGAINST_TREND_WORST_SUPPORTS_GATE'
    : 'NOT_CLEARLY_WORST';
  console.log(`\nVerdict: ${verdict}`);

  await recordClaim({
    slug: 'session_trend_counter_fade_phase0_20260916',
    claimText: `User proposal (2026-09-16, grounded in a real live TREND_UP RTH session where SHORT fades ` +
      `kept firing and losing): suppress a fade AGAINST the already-live sessionChar classifier ` +
      `(classifySessionChar(), morningBrief.js -- SHORT while TREND_UP, LONG while TREND_DOWN), the same ` +
      `function that already feeds quick-check.html's SESSION chip. NOT the same as the already-documented-` +
      `broken dtClass/isTrendCounterFade() gate. Real RTH trades classified bar-by-bar, no lookahead, day-` +
      `level trailing constants computed the same way session-trend-history does. AGAINST_TREND: N=${aStats.n} ` +
      `WR=${aStats.wr}% EV=$${aStats.ev}/trade. WITH_TREND: N=${wStats.n} WR=${wStats.wr}% EV=$${wStats.ev}/trade. ` +
      `NEUTRAL (other sessionChar): N=${nStats.n} WR=${nStats.wr}% EV=$${nStats.ev}/trade. Direction split -- SHORT ` +
      `in TREND_UP: N=${bucketStats(againstShortInUp).n} EV=$${bucketStats(againstShortInUp).ev}; LONG in TREND_DOWN: ` +
      `N=${bucketStats(againstLongInDown).n} EV=$${bucketStats(againstLongInDown).ev}. Rigor on AGAINST_TREND: ` +
      `clustered=${rigor.clustered}, stable=${rigor.stable}, top5DayPct=${rigor.top5DayPct}%, distinctDates=${rigor.distinctDates}. ` +
      `Verdict: ${verdict}. Phase 0 only -- no placebo control, not wired anywhere.`,
    sourceFile: 'scripts/backtest_session_trend_counter_fade_phase0.mjs',
    sourceDate: today,
    sampleSize: aStats.n,
    evPerTrade: aStats.ev,
    rigorStatus: rigor.clustered ? 'day_clustered' : rigor.stable ? 'stable' : (aStats.n >= 20 ? 'stable' : 'not_checked'),
    status: 'PROVISIONAL',
  });
  console.log(`Recorded RESEARCH_CLAIM session_trend_counter_fade_phase0_20260916.`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
