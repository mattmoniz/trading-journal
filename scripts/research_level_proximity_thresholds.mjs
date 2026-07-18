// Research task for OPEN_DECISION level_proximity_static_pt_thresholds: does a
// volatility-scaled AT_LEVEL/LATE/CHASING cutoff (server/services/levelProximityService.js's
// flat AT_LEVEL_PT=5 / LATE_PT=15) produce a MEANINGFULLY DIFFERENT outcome-distribution
// separation than the current flat point split? This is a real backtest, not a rewrite --
// per the OPEN_DECISION's own framing, if the flat cutoff works fine empirically that's a
// legitimate finding too, not a foregone conclusion that it must change.
//
// METHODOLOGY / KNOWN APPROXIMATION: outcome is attributed at the ACCOUNT+DAY level via the
// standard CumPL-diff method (CLAUDE.md's "P&L must use the CumPL diff method" hard rule --
// never SUM(pnl)/SUM(FlatToFlat)), then that one day's real P&L is attached to every tagged
// BP fill for that account+day. On a day with multiple independent flat-to-flat round trips
// this over-attributes (the whole day's P&L to each fill), but for a distributional-shift
// question at N in the thousands per bucket, this is a reasonable approximation -- flagged
// here explicitly rather than hidden, not something to treat as per-trade-precise P&L.
//
// Volatility scale: rolling 20-day average of RTH session range (high-low, NQ, price_bars_primary),
// computed strictly from PRIOR days only (no lookahead) -- no existing live "ATR" classifier
// exists in this codebase to import (checked volatilityRegimeService.js: its exports are all
// morning-window-specific, not a full-session range measure), so this is a new, real
// computation, not a reimplementation of something that already exists elsewhere.
import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const RTH_START_MIN = 570, RTH_END_MIN = 959; // 9:30am-3:59pm ET
const ATR_WINDOW = 20;
const MIN_N = 20;

async function main() {
  // ── 1. Daily RTH range per date, then rolling 20-day average (prior days only) ──
  const { rows: rangeRows } = await query(`
    SELECT ts::date::text as d, (MAX(high) - MIN(low))::float as range
    FROM price_bars_primary
    WHERE symbol='NQ' AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN ${RTH_START_MIN} AND ${RTH_END_MIN}
    GROUP BY ts::date ORDER BY d
  `);
  const atr20ByDate = {};
  for (let i = 0; i < rangeRows.length; i++) {
    const priorWindow = rangeRows.slice(Math.max(0, i - ATR_WINDOW), i); // strictly before index i
    if (priorWindow.length < ATR_WINDOW) continue;
    atr20ByDate[rangeRows[i].d] = priorWindow.reduce((s, r) => s + r.range, 0) / priorWindow.length;
  }
  console.log(`Computed ATR20 for ${Object.keys(atr20ByDate).length} of ${rangeRows.length} trading days.`);

  // ── 2. Every account+day's real P&L via the standard CumPL-diff method ──────────
  const { rows: dailyPnlRows } = await query(`
    WITH ep_fills AS (
      SELECT log_date, custom_fields->>'account' as account, exit_time,
        CASE WHEN custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)?$'
        THEN (custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)')::numeric ELSE NULL END as cum_pl
      FROM trades WHERE custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP' AND exit_time IS NOT NULL
    ),
    last_ep_per_day AS (
      SELECT DISTINCT ON (log_date, account) log_date, account, cum_pl
      FROM ep_fills ORDER BY log_date, account, exit_time DESC
    )
    SELECT log_date::text as log_date, account,
      (cum_pl - COALESCE(LAG(cum_pl) OVER (PARTITION BY account ORDER BY log_date), 0))::float as session_pnl
    FROM last_ep_per_day WHERE cum_pl IS NOT NULL
  `);
  const pnlByAcctDay = {};
  for (const r of dailyPnlRows) pnlByAcctDay[`${r.account}|${r.log_date}`] = r.session_pnl;
  console.log(`Loaded ${dailyPnlRows.length} account-day P&L rows.\n`);

  // ── 3. Every tagged BP fill: reuse the stored nearest_dist, attach ATR20 + day P&L ──
  const { rows: fills } = await query(`
    SELECT id, log_date::text as log_date, custom_fields->>'account' as account,
      level_proximity->>'tag' as flat_tag,
      (level_proximity->>'nearest_dist')::float as dist
    FROM trades
    WHERE level_proximity IS NOT NULL AND custom_fields->'sierra_data'->>'Entry DateTime' LIKE '% BP'
    ORDER BY log_date ASC
  `);
  console.log(`${fills.length} tagged BP fills loaded.`);

  const events = [];
  for (const f of fills) {
    const atr = atr20ByDate[f.log_date];
    const pnl = pnlByAcctDay[`${f.account}|${f.log_date}`];
    if (atr == null || pnl == null || f.dist == null) continue;
    events.push({ dist: f.dist, atr, pnl, distFrac: f.dist / atr, flatTag: f.flat_tag, log_date: f.log_date });
  }
  console.log(`${events.length} fills have both an ATR20 and a matched account-day P&L (usable sample).\n`);

  // ── 4. Current flat-cutoff outcome distribution (baseline) ─────────────────────
  function bucketStats(items) {
    const n = items.length;
    if (n === 0) return null;
    const wins = items.filter(e => e.pnl > 0).length;
    const avgPnl = items.reduce((s, e) => s + e.pnl, 0) / n;
    return { n, wr: +(100 * wins / n).toFixed(1), avgPnl: +avgPnl.toFixed(2) };
  }

  console.log('--- BASELINE: current flat AT_LEVEL_PT=5 / LATE_PT=15 ---');
  for (const tag of ['AT_LEVEL', 'LATE', 'CHASING']) {
    const s = bucketStats(events.filter(e => e.flatTag === tag));
    console.log(`${tag.padEnd(10)} ${s ? `N=${s.n}  WR=${s.wr}%  avgPnL=$${s.avgPnl}` : 'no data'}`);
  }

  // ── 5. Sweep candidate volatility-scaled cutoffs (as a fraction of ATR20) ───────
  // Anchor the sweep range around what 5pt/15pt actually represent as a fraction of a
  // TYPICAL day's ATR20, so candidates are centered on the existing convention, not
  // arbitrary: median ATR20 this dataset, 5/medianATR and 15/medianATR.
  const atrValues = events.map(e => e.atr).sort((a, b) => a - b);
  const medianAtr = atrValues[Math.floor(atrValues.length / 2)];
  const currentAtFrac = 5 / medianAtr, currentLateFrac = 15 / medianAtr;
  console.log(`\nMedian ATR20 across usable sample: ${medianAtr.toFixed(1)}pt. Current flat 5pt/15pt ≈ ${(currentAtFrac * 100).toFixed(1)}%/${(currentLateFrac * 100).toFixed(1)}% of median ATR20.\n`);

  const atCandidates = [0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.10];
  const lateCandidates = [0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.25];

  console.log('--- VOLATILITY-SCALED SWEEP (distance as fraction of that day\'s own ATR20) ---');
  console.log('Scoring by separation: (CHASING avgPnL - AT_LEVEL avgPnL), more negative = AT_LEVEL more clearly outperforms CHASING (the hypothesis this tagging exists to support).');
  let best = null;
  for (const atFrac of atCandidates) {
    for (const lateFrac of lateCandidates) {
      if (lateFrac <= atFrac) continue;
      const atLevel = events.filter(e => e.distFrac <= atFrac);
      const late = events.filter(e => e.distFrac > atFrac && e.distFrac <= lateFrac);
      const chasing = events.filter(e => e.distFrac > lateFrac);
      const sAt = bucketStats(atLevel), sLate = bucketStats(late), sChase = bucketStats(chasing);
      if (!sAt || !sLate || !sChase || sAt.n < MIN_N || sLate.n < MIN_N || sChase.n < MIN_N) continue;
      const separation = sChase.avgPnl - sAt.avgPnl; // want AT_LEVEL >> CHASING, i.e. this very negative
      const monotonic = sAt.avgPnl >= sLate.avgPnl && sLate.avgPnl >= sChase.avgPnl;
      if (!best || separation < best.separation) {
        best = { atFrac, lateFrac, sAt, sLate, sChase, separation, monotonic };
      }
    }
  }
  if (best) {
    console.log(`\nBest separation found: AT_LEVEL<=${(best.atFrac * 100).toFixed(0)}%ATR, LATE<=${(best.lateFrac * 100).toFixed(0)}%ATR (monotonic=${best.monotonic})`);
    console.log(`  AT_LEVEL  N=${best.sAt.n}  WR=${best.sAt.wr}%  avgPnL=$${best.sAt.avgPnl}`);
    console.log(`  LATE      N=${best.sLate.n}  WR=${best.sLate.wr}%  avgPnL=$${best.sLate.avgPnl}`);
    console.log(`  CHASING   N=${best.sChase.n}  WR=${best.sChase.wr}%  avgPnL=$${best.sChase.avgPnl}`);
    console.log(`  Separation (CHASING - AT_LEVEL avgPnL): $${best.separation.toFixed(2)}`);
  } else {
    console.log('No candidate cleared the N>=20-per-bucket floor.');
  }

  // ── 6. Compare against the CURRENT flat-cutoff's own separation, apples-to-apples ──
  const sAtFlat = bucketStats(events.filter(e => e.flatTag === 'AT_LEVEL'));
  const sChaseFlat = bucketStats(events.filter(e => e.flatTag === 'CHASING'));
  const flatSeparation = sChaseFlat.avgPnl - sAtFlat.avgPnl;
  console.log(`\nCurrent flat-cutoff separation (CHASING - AT_LEVEL avgPnL): $${flatSeparation.toFixed(2)}`);
  if (best) {
    console.log(`Volatility-scaled best separation: $${best.separation.toFixed(2)}`);
    console.log(`Delta: $${(best.separation - flatSeparation).toFixed(2)} (more negative = scaled cutoff separates outcomes better)`);
  }

  // ── 7. Rigor check on the buckets driving the finding — is this a handful of days'
  // catastrophic losses dominating the average, or a real, stable pattern? ──────────
  console.log('\n--- RIGOR CHECK (day-clustering + chronological stability, informational) ---');
  function rigorReport(label, items) {
    const r = computeRigor(items, { dateField: 'log_date', pnlFn: (e) => e.pnl });
    console.log(`${label.padEnd(28)} N=${items.length}  top5DayPct=${r.top5DayPct}%  clustered=${r.clustered}  stable=${r.stable}  thirds=${JSON.stringify(r.thirds)}`);
  }
  rigorReport('FLAT AT_LEVEL', events.filter(e => e.flatTag === 'AT_LEVEL'));
  rigorReport('FLAT CHASING', events.filter(e => e.flatTag === 'CHASING'));
  if (best) {
    rigorReport('SCALED AT_LEVEL', events.filter(e => e.distFrac <= best.atFrac));
    rigorReport('SCALED CHASING', events.filter(e => e.distFrac > best.lateFrac));
  }
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
