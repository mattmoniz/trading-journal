// Unified Setup/Edge Table — single source of truth for all tradeable signals.
// Extracted from server/routes/acd.js 2026-09-20 (Phase B of
// docs/ACDJS_FILE_SIZE_REDUCTION_SPEC.md), backing GET /api/performance-audit/unified.
//
// Unlike Phase A's buildAllCandidates()/computeLevelFadeFactors() (which turned out to
// share a cluster of acd.js-local module-level helpers), this handler was confirmed
// genuinely self-contained before moving it: grepped every acd.js-local module-level
// function/const (the REFIRE_COOLDOWN_MINUTES/isInRefireCooldown/logGatedCandidate/etc.
// family, the Globex detection functions, buildAllCandidates/computeLevelFadeFactors
// themselves) against the handler body -- zero hits. It also never reads `req` (no query
// params) and only ever calls `res.json()`/`res.status()` at its two exit points, both
// converted to plain `return` here. Only 2 of acd.js's ~30 top-level imports were
// actually used (`query`, `getLatestBars`) -- confirmed by grep, then by ESLint's
// no-undef on this file with only those two imports present (0 errors, first try).
//
// Behavior-identical extraction: `if (!runDate) return res.json({...})` -> `return {...}`,
// the final `res.json({...})` -> `return {...}`. The route handler in acd.js now just
// awaits this function and does res.json()/the try-catch/res.status(500) exactly as
// before -- error handling intentionally stayed in the thin route wrapper, not moved
// here, so a thrown error's console.error/500-response shape is unchanged.
import { query } from '../db.js';
import { getLatestBars } from './priceRetrieval.js';

export async function computeUnifiedPerformanceAudit() {
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  // Every query in this first batch depends only on `todayET` (or nothing at all) —
  // none depend on each other's results. Was ~18 sequential awaits (several wrapped
  // in their own try/catch, several inside a for-loop); confirmed via profiling
  // (2026-07-15) this was the dominant remaining cost of this endpoint even after
  // the earlier 18s->3.1s fix (which addressed a different bottleneck — the 30-date
  // replay's N+1/LATERAL-vs-partitioned-view issue, see the comment further below).
  // Collapsed into one Promise.all with per-query .catch() fallbacks matching each
  // original try/catch's silent-failure behavior — total wait is now the max of the
  // slowest single query, not the sum of ~18.
  const [
    latestRunQ, auditQ, priceQ, atrQ, pdVaQ, pdDvQ, acdQ, ibQ, pdIbQ, pdOrQ, or5Q,
    pdSessQ, trQ, last30Days, moQ, pmVaFull, m1VaQ, m3VaQ,
    pairsBaseQ, pairsSubQ, pairsWinQ, optStopLatestQ,
  ] = await Promise.all([
    // 1. Latest results per signal_type — each signal type has its own run cadence,
    // so a single global MAX(run_date) hides older signal types whenever any
    // fast-cycling type (e.g. ON_INVENTORY) runs and bumps the global max.
    query(`SELECT MAX(run_date)::text as d FROM performance_audit`),
    query(`
      WITH latest_per_type AS (
        SELECT signal_type, MAX(run_date) as latest_date
        FROM performance_audit GROUP BY signal_type
      )
      SELECT pa.signal_type, pa.signal_name, pa.sample_size,
             pa.win_rate::float, pa.ev_per_trade::float, pa.total_pnl::float,
             pa.avg_mfe::float, pa.p50_mfe::float, pa.p75_mfe::float,
             pa.avg_mae::float, pa.p50_mae::float, pa.p75_mae::float, pa.p90_mae::float,
             pa.current_stop::float, pa.current_target::float,
             pa.optimal_stop::float, pa.optimal_target::float,
             pa.recommendation, pa.notes
      FROM performance_audit pa
      JOIN latest_per_type l ON pa.signal_type = l.signal_type AND pa.run_date = l.latest_date
      ORDER BY pa.signal_type, pa.ev_per_trade DESC NULLS LAST
    `),
    // 2. Current price
    getLatestBars('NQ', { limit: 1, columns: 'close::float as close' }, 'setup-reference.currentPrice').then(rows => ({ rows })),
    // 3. ATR(20) from daily true ranges
    query(`
      WITH daily AS (
        SELECT ts::date as d, MAX(high)::float as hi, MIN(low)::float as lo
        FROM price_bars_primary WHERE symbol='NQ'
          AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
        GROUP BY ts::date ORDER BY d DESC LIMIT 21
      ),
      trs AS (
        SELECT hi - lo as tr FROM daily ORDER BY d DESC LIMIT 20
      )
      SELECT AVG(tr)::float as atr20 FROM trs
    `).catch(() => ({ rows: [] })),
    // 4. Compute level prices — PD VA levels
    query(`
      SELECT poc::float, vah::float, val::float FROM developing_value_log
      WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 1
    `, [todayET]),
    // Floor pivots from prior day H/L/C
    query(`
      SELECT session_high::float as hi, session_low::float as lo, session_close::float as cl
      FROM developing_value_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 1
    `, [todayET]),
    // OR High/Low from today's ACD log
    query(`SELECT or_high::float, or_low::float FROM acd_daily_log WHERE trade_date=$1`, [todayET]),
    // IB High/Low from today's bars (9:30-10:30)
    query(`
      SELECT MAX(high)::float as ib_high, MIN(low)::float as ib_low
      FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 629
    `, [todayET]),
    // PD IB Mid (and individual PD IB High/Low) — bounded lower end (2026-07-15,
    // same fix as the level-fade candidates block's pdIbQ): unbounded ts::date < $1
    // in the inner MAX(ts::date) lookback forced a full historical scan (288ms->126ms).
    // BETWEEN 570 AND 629 (not 630) — this copy inherited the same off-by-one-minute
    // bug as the original pdIbQ (see that query's comment, ~line 4547, for the full
    // writeup); fixed both together 2026-07-16.
    query(`
      SELECT MAX(high)::float as ibh, MIN(low)::float as ibl
      FROM price_bars_primary WHERE symbol='NQ'
        AND ts::date = (SELECT MAX(ts::date) FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1 AND ts::date >= $1::date - 30
          AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 629)
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 629
    `, [todayET]).catch(() => ({ rows: [] })),
    // PD OR Mid (and individual PD OR High/Low)
    query(`SELECT or_high::float, or_low::float FROM acd_daily_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 1`, [todayET]).catch(() => ({ rows: [] })),
    // 5D OR Mid (rolling composite)
    query(`
      SELECT MAX(orh) as hi, MIN(orl) as lo FROM (
        SELECT or_high::float as orh, or_low::float as orl FROM acd_daily_log
        WHERE trade_date < $1 AND or_high IS NOT NULL ORDER BY trade_date DESC LIMIT 5
      ) t
    `, [todayET]).catch(() => ({ rows: [] })),
    // PD Session Mid
    query(`
      SELECT session_high::float as hi, session_low::float as lo
      FROM developing_value_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 1
    `, [todayET]).catch(() => ({ rows: [] })),
    // 5. Current regime raw data (vol/dir/range) — same methodology as the backtest script
    query(`
      WITH daily AS (
        SELECT ts::date as d,
          MAX(high)::float as hi, MIN(low)::float as lo, MAX(close)::float as cl
        FROM price_bars_primary WHERE symbol='NQ'
          AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
        GROUP BY ts::date ORDER BY d DESC LIMIT 25
      )
      SELECT d, hi - lo as tr, cl FROM daily ORDER BY d ASC
    `).catch(() => ({ rows: [] })),
    // 7. Last 30 trading dates (drives the replay batch below)
    query(`
      SELECT DISTINCT ts::date::text as d FROM price_bars_primary
      WHERE symbol='NQ' AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
      ORDER BY d DESC LIMIT 30
    `).catch(() => ({ rows: [] })),
    // Monthly levels
    query(`
      SELECT open::float as mo FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date = (
        SELECT MIN(ts::date) FROM price_bars_primary
        WHERE symbol='NQ' AND date_trunc('month', ts) = date_trunc('month', CURRENT_DATE)
          AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 960
      ) ORDER BY ts LIMIT 1
    `).catch(() => ({ rows: [] })),
    query(`
      WITH vp AS (
        SELECT ROUND(close::float / 25)::int * 25 as bk, SUM(volume)::float as vol
        FROM price_bars_primary WHERE symbol='NQ'
          AND date_trunc('month', ts) = date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
          AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
        GROUP BY 1
      ), tot AS (SELECT SUM(vol)::float as t FROM vp),
      cum AS (SELECT bk, vol, SUM(vol) OVER (ORDER BY vol DESC) as cv, t FROM vp, tot)
      SELECT MAX(bk) FILTER (WHERE cv - vol < t * 0.7) as vah,
             MIN(bk) FILTER (WHERE cv - vol < t * 0.7) as val FROM cum
    `).catch(() => ({ rows: [] })),
    query(`
      WITH vp AS (
        SELECT ROUND(close::float / 25)::int * 25 as bk, SUM(volume)::float as vol
        FROM price_bars_primary WHERE symbol='NQ'
          AND ts::date >= ($1::date - 30 * INTERVAL '1 day') AND ts::date < $1
          AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
        GROUP BY 1
      ), tot AS (SELECT SUM(vol)::float as t FROM vp),
      cum AS (SELECT bk, vol, SUM(vol) OVER (ORDER BY vol DESC) as cv, t FROM vp, tot)
      SELECT MAX(bk) FILTER (WHERE cv - vol < t * 0.7) as vah,
             MIN(bk) FILTER (WHERE cv - vol < t * 0.7) as val FROM cum
    `, [todayET]).catch(() => ({ rows: [] })),
    query(`
      WITH vp AS (
        SELECT ROUND(close::float / 25)::int * 25 as bk, SUM(volume)::float as vol
        FROM price_bars_primary WHERE symbol='NQ'
          AND ts::date >= ($1::date - 90 * INTERVAL '1 day') AND ts::date < $1
          AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
        GROUP BY 1
      ), tot AS (SELECT SUM(vol)::float as t FROM vp),
      cum AS (SELECT bk, vol, SUM(vol) OVER (ORDER BY vol DESC) as cv, t FROM vp, tot)
      SELECT MAX(bk) FILTER (WHERE cv - vol < t * 0.7) as vah,
             MIN(bk) FILTER (WHERE cv - vol < t * 0.7) as val FROM cum
    `, [todayET]).catch(() => ({ rows: [] })),
    // Confluence pairs (base/sub/rolling-window) — independent reads of performance_audit.
    // FIXED 2026-09-20 (OPEN_DECISION unified_pairs_query_missing_run_date_filter_20260920):
    // none of these 3 queries filtered by run_date -- performance_audit accumulates one row
    // per (signal_name, window_days) per weekly recalibration run (confirmed live: 16
    // distinct run_dates per pair), so every one of these was reading ALL 16 historical
    // copies, not just the latest. pairsBaseQ (this first query) fed `pairs` directly via a
    // 1:1 .map() with no dedup at all -- confirmed live this inflated the real 778 distinct
    // confluence pairs into 9,267 array entries (mostly stale duplicates). pairsSubQ/pairsWinQ
    // didn't duplicate rows the same way (their JS consumers key by signal_name/window_days
    // into a plain object), but which of the 16 historical values won was whichever row
    // Postgres happened to return last for a tied ORDER BY sort key -- non-deterministic,
    // confirmed live via two consecutive identical-code calls returning different values for
    // 7,853 of 9,267 pairs. All 3 now wrap DISTINCT ON (matching this codebase's own
    // latest-per-signal_name pattern used everywhere else, e.g. OPTIMAL_STOP/SETUP_STATUS
    // readers) in a subquery so the outer ORDER BY (needed for display ranking, not just
    // dedup) can stay independent of the DISTINCT ON columns.
    query(`
      SELECT signal_name, sample_size, wr_pct, ev, recommendation FROM (
        SELECT DISTINCT ON (signal_name) signal_name, sample_size,
          ROUND(win_rate*100, 2)::float AS wr_pct,
          ROUND(ev_per_trade::numeric, 2)::float AS ev,
          recommendation
        FROM performance_audit
        WHERE signal_type='CONTEXT_ANALYSIS'
          AND signal_name LIKE 'PAIR_%'
          AND window_days = 9999
          AND signal_name NOT LIKE '%_DOW_%'
          AND signal_name NOT LIKE '%_TOD_%'
          AND signal_name NOT LIKE '%_DT_%'
        ORDER BY signal_name, run_date DESC
      ) latest
      ORDER BY ev DESC NULLS LAST
    `),
    query(`
      SELECT signal_name, wr_pct, ev, sample_size, recommendation FROM (
        SELECT DISTINCT ON (signal_name) signal_name,
          ROUND(win_rate*100, 2)::float AS wr_pct,
          ROUND(ev_per_trade::numeric, 2)::float AS ev,
          sample_size, recommendation
        FROM performance_audit
        WHERE signal_type='CONTEXT_ANALYSIS'
          AND window_days = 9999
          AND (signal_name LIKE 'PAIR_%_DOW_%'
            OR signal_name LIKE 'PAIR_%_TOD_%'
            OR signal_name LIKE 'PAIR_%_DT_%')
        ORDER BY signal_name, run_date DESC
      ) latest
      ORDER BY signal_name, ev DESC NULLS LAST
    `),
    query(`
      SELECT signal_name, window_days, sample_size, wr_pct, ev FROM (
        SELECT DISTINCT ON (signal_name, window_days) signal_name, window_days,
          sample_size,
          ROUND(win_rate*100, 2)::float AS wr_pct,
          ROUND(ev_per_trade::numeric, 2)::float AS ev
        FROM performance_audit
        WHERE signal_type='CONTEXT_ANALYSIS'
          AND signal_name LIKE 'PAIR_%'
          AND window_days IN (365, 182, 20)
          AND signal_name NOT LIKE '%_DOW_%'
          AND signal_name NOT LIKE '%_TOD_%'
          AND signal_name NOT LIKE '%_DT_%'
        ORDER BY signal_name, window_days, run_date DESC
      ) latest
      ORDER BY signal_name, window_days
    `),
    // Real per-setup calibration, correctly latest-per-signal_name (2026-07-20).
    // auditQ's own `latest_per_type` join (query 2 above) filters by MAX(run_date)
    // GROUPed BY signal_type alone -- fine for signal_types where every signal_name
    // is rewritten in lockstep on the same run, but OPTIMAL_STOP is not one of those:
    // update_optimal_stops.mjs's own population query can skip a signal_name on a
    // given run (thin data, direction inference failure, etc — see
    // /api/acd/target-calibration-coverage's own "stale_no_notes" bucket, currently
    // 7 signal_names), leaving that ONE row at an older run_date while every other
    // OPTIMAL_STOP row advances — auditQ's join then excludes it entirely, not just
    // shows it stale. Confirmed live: IB_HIGH_FADE_LONG (real optimal_stop=53,
    // optimal_target=35) was silently absent from auditQ.rows for exactly this
    // reason. This dedicated DISTINCT ON (signal_name) query is the same
    // latest-per-signal_name pattern CLAUDE.md's own OPTIMAL_STOP hard rule already
    // documents as correct — used here instead of trusting auditQ's per-type join.
    query(`
      SELECT DISTINCT ON (signal_name) signal_name, optimal_stop::float, optimal_target::float, notes
      FROM performance_audit WHERE signal_type='OPTIMAL_STOP'
      ORDER BY signal_name, run_date DESC
    `),
  ]);

  const runDate = latestRunQ.rows[0]?.d;
  if (!runDate) return { setups: [], runDate: null, currentPrice: null };

  const currentPrice = priceQ.rows[0]?.close || null;

  let atr20 = atrQ.rows[0]?.atr20 ? Math.round(atrQ.rows[0].atr20) : null;

  let pdPOC = null, pdVAH = null, pdVAL = null;
  if (pdVaQ.rows[0]) {
    pdPOC = pdVaQ.rows[0].poc;
    pdVAH = pdVaQ.rows[0].vah;
    pdVAL = pdVaQ.rows[0].val;
  }

  let floorP = null, floorR1 = null, floorS1 = null;
  if (pdDvQ.rows[0]) {
    const pdDv = pdDvQ.rows[0];
    floorP = (pdDv.hi + pdDv.lo + pdDv.cl) / 3;
    floorR1 = 2 * floorP - pdDv.lo;
    floorS1 = 2 * floorP - pdDv.hi;
  }

  let orH = null, orL = null;
  if (acdQ.rows[0]) {
    orH = acdQ.rows[0].or_high;
    orL = acdQ.rows[0].or_low;
  }

  let ibHigh = null, ibLow = null;
  if (ibQ.rows[0]) {
    ibHigh = ibQ.rows[0].ib_high;
    ibLow = ibQ.rows[0].ib_low;
  }

  let pdIbMid = null, pdIbHigh = null, pdIbLow = null;
  if (pdIbQ.rows[0]?.ibh) {
    pdIbHigh = pdIbQ.rows[0].ibh;
    pdIbLow  = pdIbQ.rows[0].ibl;
    pdIbMid  = (pdIbHigh + pdIbLow) / 2;
  }

  let pdOrMid = null, pdOrHigh = null, pdOrLow = null;
  if (pdOrQ.rows[0]?.or_high) {
    pdOrHigh = pdOrQ.rows[0].or_high;
    pdOrLow  = pdOrQ.rows[0].or_low;
    pdOrMid  = (pdOrHigh + pdOrLow) / 2;
  }

  let or5Mid = null;
  if (or5Q.rows[0]?.hi) or5Mid = (or5Q.rows[0].hi + or5Q.rows[0].lo) / 2;

  // IB Mid (today)
  const ibMid = ibHigh && ibLow ? (ibHigh + ibLow) / 2 : null;
  // OR Mid (today)
  const orMid = orH && orL ? (orH + orL) / 2 : null;

  let pdSessMid = null;
  if (pdSessQ.rows[0]?.hi) pdSessMid = (pdSessQ.rows[0].hi + pdSessQ.rows[0].lo) / 2;

  // 5. Current regime (vol/dir/range)
  let currentRegime = { vol: 'NORMAL', dir: 'NEUTRAL', range: 'NORMAL' };
  try {
    const days = trQ.rows;
    if (days.length >= 21) {
      const trs = days.map(d => d.tr);
      const closes = days.map(d => d.cl);
      const atr20v = trs.slice(-20).reduce((s, v) => s + v, 0) / 20;
      const atr5 = trs.slice(-5).reduce((s, v) => s + v, 0) / 5;
      const volZ = atr20v > 0 ? (atr5 / atr20v - 1) * 3 : 0; // simplified z-score
      currentRegime.vol = volZ > 0.5 ? 'EXPANDING' : volZ < -0.5 ? 'CONTRACTING' : 'NORMAL';

      // Direction from close drift
      const close5 = closes.slice(-5);
      const close20 = closes.slice(-20);
      const drift5 = close5.length >= 2 ? (close5[close5.length - 1] - close5[0]) / atr20v : 0;
      currentRegime.dir = drift5 > 0.5 ? 'BULLISH' : drift5 < -0.5 ? 'BEARISH' : 'NEUTRAL';

      // Range
      const lastTR = trs[trs.length - 1];
      const rangeRatio = atr20v > 0 ? lastTR / atr20v : 1;
      currentRegime.range = rangeRatio > 1.3 ? 'WIDE' : rangeRatio < 0.7 ? 'NARROW' : 'NORMAL';
    }
  } catch (_) {}

  const all30Dates = last30Days.rows.map(r => r.d);
  const recentDates = all30Dates.slice(0, 10);

  // 6. Regime fit + 7. recent replay batch — both independent of each other, and only
  // depend on values computed synchronously above (currentRegime, recentDates/all30Dates).
  const replayEligible = recentDates.length >= 5;
  const [regimeQ, recentSetups, priorAsOfQ, allBarsQ] = await Promise.all([
    query(`
      SELECT level_name, vs_overall, sample_size, win_rate::float, ev_per_trade::float
      FROM level_regime_performance
      WHERE vol_regime = $1 AND dir_regime = $2 AND range_regime = $3
        AND sample_size >= 5
    `, [currentRegime.vol, currentRegime.dir, currentRegime.range]),
    replayEligible ? query(`
      SELECT setup_type, resolution FROM active_setups
      WHERE trade_date = ANY($1::date[]) AND resolution IN ('TARGET_HIT','STOP_HIT')
    `, [recentDates]) : Promise.resolve({ rows: [] }),
    // 2026-07-15: was an N+1 pattern (4 sequential queries × 30 dates ≈ 120 round
    // trips, the confirmed dominant cost of this endpoint's ~18s response time). A
    // first batching attempt (LATERAL join for ALL of dv/ib/or against
    // price_bars_primary) was reverted the same session — EXPLAIN ANALYZE showed
    // ~114s, because the correlated IB lookback against price_bars_primary (a view
    // over ~40 monthly partitions) defeated partition pruning under LATERAL and
    // forced a sequential scan of every partition per outer date row. Fixed properly
    // below by sourcing IB high/low from `level_prices` instead — precomputed nightly
    // by scripts/compute_levels.js (already using the canonical 60-min IB window,
    // corrected in an earlier session), on a plain non-partitioned indexed table, so
    // no partition-pruning risk. Independently verified via Gemini (EXPLAIN ANALYZE:
    // <1ms; full 30-date correctness check) before wiring in — Gemini's pass also
    // caught a real, pre-existing gap (level_prices had zero rows for 2026-06-18,
    // a silent compute_levels.js --backfill skip under load, same known failure mode
    // documented elsewhere in this codebase) — backfilled that date before trusting
    // this as the new source. developing_value_log/acd_daily_log lookups were never
    // the slow part (neither is partitioned) — batched here too since it's free once
    // the dangerous IB lookup no longer forces a per-date correlated subquery. See
    // docs/OPEN_THREADS.md for the full incident writeup.
    replayEligible ? query(`
      WITH d AS (SELECT unnest($1::date[]) as dt)
      SELECT d.dt::text as date,
             dv.trade_date as dv_found,
             dv.poc::float, dv.vah::float, dv.val::float,
             dv.session_high::float as hi, dv.session_low::float as lo, dv.session_close::float as cl,
             ib.h::float as ib_h, ib.l::float as ib_l,
             o.or_high::float as or_h, o.or_low::float as or_l
      FROM d
      LEFT JOIN LATERAL (
        SELECT trade_date, poc, vah, val, session_high, session_low, session_close
        FROM developing_value_log WHERE trade_date < d.dt ORDER BY trade_date DESC LIMIT 1
      ) dv ON true
      LEFT JOIN LATERAL (
        SELECT MAX(price) FILTER (WHERE level_name='IB_HIGH') as h,
               MAX(price) FILTER (WHERE level_name='IB_LOW') as l
        FROM level_prices
        WHERE trade_date = (SELECT MAX(trade_date) FROM level_prices WHERE trade_date < d.dt AND level_name IN ('IB_HIGH','IB_LOW'))
          AND level_name IN ('IB_HIGH','IB_LOW')
      ) ib ON true
      LEFT JOIN LATERAL (
        SELECT or_high, or_low FROM acd_daily_log WHERE trade_date < d.dt ORDER BY trade_date DESC LIMIT 1
      ) o ON true
    `, [all30Dates]) : Promise.resolve({ rows: [] }),
    replayEligible ? query(`
      SELECT ts::date::text as date,
             (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min,
             close::float, high::float, low::float
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date = ANY($1::date[])
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 720
      ORDER BY ts
    `, [all30Dates]) : Promise.resolve({ rows: [] }),
  ]);
  const regimeFitMap = {};
  for (const r of regimeQ.rows) {
    regimeFitMap[r.level_name] = r.vs_overall;
  }

  // Recent 10-day and 30-day per-level performance (quick replay)
  const recent10d = {}, recent30d = {};
  try {
    if (replayEligible) {
      // Group by setup_type
      for (const r of recentSetups.rows) {
        const name = r.setup_type.replace(/_FADE_(LONG|SHORT)$/, '').replace(/_FADE$/, '');
        if (!recent10d[name]) recent10d[name] = { wins: 0, total: 0 };
        recent10d[name].total++;
        if (r.resolution === 'TARGET_HIT') recent10d[name].wins++;
      }
      // Replay ALL levels for each of the last 30 days (10d is a subset).
      // priorAsOfQ/allBarsQ already fetched in the Promise.all batch above (see the
      // comment there for the 2026-07-15 N+1/LATERAL-vs-partitioned-view incident
      // this replay design fixed) — no re-query needed here.
      const priorAsOfByDate = {};
      for (const r of priorAsOfQ.rows) priorAsOfByDate[r.date] = r;

      const barsByDate = {};
      for (const r of allBarsQ.rows) {
        if (!barsByDate[r.date]) barsByDate[r.date] = [];
        barsByDate[r.date].push(r);
      }

      for (const date of all30Dates) {
        const dv = priorAsOfByDate[date];
        if (!dv || !dv.dv_found) continue; // no prior developing_value_log row — matches original dvQ.rows[0] undefined check
        const dayBars = { rows: barsByDate[date] || [] };
        if (dayBars.rows.length < 30) continue;

        // Compute all levels for this day
        const fp = dv.hi && dv.lo && dv.cl ? (dv.hi + dv.lo + dv.cl) / 3 : null;
        const fr1 = fp ? 2 * fp - dv.lo : null;
        const fs1 = fp ? 2 * fp - dv.hi : null;
        const orBars10 = dayBars.rows.filter(b => b.et_min < 575);
        const orH10 = orBars10.length ? Math.max(...orBars10.map(b => b.high)) : null;
        const ibBars10 = dayBars.rows.filter(b => b.et_min < 630);
        const ibH10 = ibBars10.length ? Math.max(...ibBars10.map(b => b.high)) : null;
        const ibL10 = ibBars10.length ? Math.min(...ibBars10.map(b => b.low)) : null;
        const pdIbMid10 = dv.ib_h ? (dv.ib_h + dv.ib_l) / 2 : null;
        const pdOrMid10 = dv.or_h ? (dv.or_h + dv.or_l) / 2 : null;
        const pdSessMid10 = dv.hi && dv.lo ? (dv.hi + dv.lo) / 2 : null;

        const allLevels = {
          PD_POC: dv.poc, PD_VAL: dv.val, PD_VAH: dv.vah,
          FLOOR_PIVOT: fp, FLOOR_R1: fr1, FLOOR_S1: fs1,
          OR5_HIGH: orH10, IB_HIGH: ibH10, IB_LOW: ibL10,
          PD_IB_MID: pdIbMid10, PD_OR_MID: pdOrMid10, PD_SESSION_MID: pdSessMid10,
          PD_OR_HIGH: dv.or_h, PD_OR_LOW: dv.or_l,
          PD_IB_HIGH: dv.ib_h, PD_IB_LOW: dv.ib_l,
        };

        const isIn10d = recentDates.includes(date);
        for (const [name, price] of Object.entries(allLevels)) {
          if (!price) continue;
          let touched = false;
          // Start at i=1 so we can always read the previous bar to determine approach direction
          for (let i = 1; i < dayBars.rows.length && !touched; i++) {
            if (Math.abs(dayBars.rows[i].close - price) <= 10) {
              touched = true;
              if (!recent30d[name]) recent30d[name] = { wins: 0, total: 0 };
              recent30d[name].total++;
              if (isIn10d) {
                if (!recent10d[name]) recent10d[name] = { wins: 0, total: 0 };
                recent10d[name].total++;
              }
              // Directional fade logic: determine approach direction from prior bar
              const fromAbove = dayBars.rows[i - 1].close > price;
              const horizon = Math.min(i + 30, dayBars.rows.length);
              let won = false;
              for (let j = i + 1; j < horizon; j++) {
                const cl = dayBars.rows[j].close;
                // Win: price bounces back in approach direction (20pt target)
                if (fromAbove && cl > price + 20) { won = true; break; }
                if (!fromAbove && cl < price - 20) { won = true; break; }
                // Loss: price breaks through (30pt stop)
                if (fromAbove && cl < price - 30) break;
                if (!fromAbove && cl > price + 30) break;
              }
              if (won) {
                recent30d[name].wins++;
                if (isIn10d) recent10d[name].wins++;
              }
            }
          }
        }
      }
    }
  } catch (_) {}

  // Monthly levels — moQ/pmVaFull/m1VaQ/m3VaQ already fetched in the batch above
  const monthOpen = moQ.rows[0]?.mo || null;
  const pmVAHaudit = pmVaFull.rows[0]?.vah || null;
  const pmVALaudit = pmVaFull.rows[0]?.val || null;
  const m1VAHaudit = m1VaQ.rows[0]?.vah || null;
  const m1VALaudit = m1VaQ.rows[0]?.val || null;
  const m3VAHaudit = m3VaQ.rows[0]?.vah || null;
  const m3VALaudit = m3VaQ.rows[0]?.val || null;

  // Map signal names to level prices and metadata.
  // bestCtx here is a purely qualitative fallback label (no %/N/$ claims) — used only
  // when a row has no live win_rate/sample_size/ev_per_trade to describe it from.
  // Found 2026-07-13: this map used to hardcode specific WR%/N/$ literals per level
  // (e.g. 'IB_HIGH': '90% WR level fade') that directly violated this file's own
  // documented hard rule ("Never write a stop, target, or WR claim as a literal
  // number in acd.js — always read from liveStats._opt[type] or performance_audit")
  // — and rendered live in BacktestView.jsx's Setups guide/table. describeLevel()
  // below now builds this text from each row's own live performance_audit fields
  // instead; the literal numbers here are gone, not just relabeled.
  const levelMap = {
    'PD_POC':       { price: pdPOC,    bestCtx: 'System anchor level', freq: '~1/day' },
    '5D_OR_MID':    { price: or5Mid,   bestCtx: 'Rolling composite', freq: '~0.5/day' },
    'PD_VAL':       { price: pdVAL,    bestCtx: 'Consistent performer, support fade', freq: '~0.8/day' },
    'PD_VAH':       { price: pdVAH,    bestCtx: 'High frequency level', freq: '~1.2/day' },
    'PD_IB_MID':    { price: pdIbMid,  bestCtx: 'PD midpoint fade', freq: '~0.5/day' },
    'FLOOR_PIVOT':  { price: floorP,   bestCtx: 'Structural reference', freq: '~0.8/day' },
    'OR5_HIGH':     { price: orH,      bestCtx: 'AM session strong', freq: '~0.7/day' },
    'FLOOR_R1':     { price: floorR1,  bestCtx: 'Thursday 1PM specialist', freq: '~0.5/day' },
    'PD_OR_MID':    { price: pdOrMid,  bestCtx: 'Good midpoint fade', freq: '~0.5/day' },
    // FLOOR_S1 removed from keepLevels 2026-07-03 (12+ backtest runs all negative EV)
    // 'FLOOR_S1':  { price: floorS1,  bestCtx: 'Support level', freq: '~0.5/day' },
    'IB_HIGH':      { price: ibHigh,   bestCtx: 'IB level fade', freq: '~0.8/day' },
    'IB_LOW':       { price: ibLow,    bestCtx: 'IB level fade', freq: '~0.8/day' },
    'IB_MID':       { price: ibMid,    bestCtx: 'Midpoint reference', freq: '~1/day' },
    'ON_HIGH':      { price: null,     bestCtx: 'Overnight high', freq: '~0.5/day' },
    'PD_IB_LOW':    { price: pdIbLow,  bestCtx: 'PD IB Low', freq: '~0.5/day' },
    'PD_IB_HIGH':   { price: pdIbHigh, bestCtx: 'PD IB High', freq: '~0.5/day' },
    'PD_OR_HIGH':   { price: pdOrHigh, bestCtx: 'PD OR High', freq: '~0.5/day' },
    'PD_OR_LOW':    { price: pdOrLow,  bestCtx: 'PD OR Low', freq: '~0.5/day' },
    'PD_SESSION_MID': { price: pdSessMid, bestCtx: 'PD session midpoint', freq: '~0.5/day' },
    '10D_IB_MID':   { price: null,     bestCtx: '10-day IB composite', freq: '~0.3/day' },
    'IB_MID_SCALP': { price: ibMid,    bestCtx: 'Tight-target scalp fade', freq: '~1.5/day' },
    'OR5_MID':      { price: orMid,    bestCtx: '5-min OR midpoint (tradeable as soon as OR completes)', freq: '~1/day' },
    'TRT_LONG':     { price: null,     bestCtx: 'Trend resumption', freq: '~0.3/day' },
    'IB_BEARISH_DIRECTION': { price: null, bestCtx: 'Directional context (IB break)', freq: '~0.4/day' },
    'IB_BULLISH_DIRECTION': { price: null, bestCtx: 'Directional context (IB break)', freq: '~0.5/day' },
    'MONTH_OPEN':  { price: monthOpen,   bestCtx: 'Monthly open fade', freq: '~1/month' },
    'PM_VAH':      { price: pmVAHaudit,  bestCtx: 'Prior-month VAH fade', freq: '~monthly' },
    'PM_VAL':      { price: pmVALaudit,  bestCtx: 'Prior-month VAL fade', freq: '~monthly' },
    'M1_VAH':      { price: m1VAHaudit,  bestCtx: '1-month rolling VAH fade', freq: '~daily' },
    'M1_VAL':      { price: m1VALaudit,  bestCtx: '1-month rolling VAL fade', freq: '~daily' },
    'M3_VAH':      { price: m3VAHaudit,  bestCtx: '3-month rolling VAH fade', freq: '~daily' },
    'M3_VAL':      { price: null,        bestCtx: '3-month rolling VAL fade', freq: '~daily' },
    // Directional display cards sourced from UNIFIED_BACKTEST (replaces CONTEXT/SCALP legacy orphan types)
    'IB_BULLISH':           { price: null,  bestCtx: 'IB breakout direction context (all-day-type blended)', freq: '~0.4/day' },
    'IB_BEARISH':           { price: null,  bestCtx: 'IB breakdown direction context (all-day-type blended)', freq: '~0.4/day' },
    'IB_MID_SCALP_LONG':   { price: ibMid, bestCtx: 'Scalp fade LONG from IB midpoint', freq: '~1.5/day' },
    'IB_MID_SCALP_SHORT':  { price: ibMid, bestCtx: 'Scalp fade SHORT from IB midpoint', freq: '~1.5/day' },
    'OR5_MID_LONG':  { price: orMid, bestCtx: 'Scalp fade LONG from 5-min OR midpoint', freq: '~1/day' },
    'OR5_MID_SHORT': { price: orMid, bestCtx: 'Scalp fade SHORT from 5-min OR midpoint', freq: '~1/day' },
  };

  // Builds the level's context description from its OWN live performance_audit
  // fields (win_rate/sample_size/ev_per_trade, already fetched into `row` above) —
  // falls back to the qualitative levelMap label only when no numeric stat exists.
  function describeLevel(row, fallbackLabel) {
    const parts = [];
    if (row.win_rate != null) parts.push(`${Math.round(row.win_rate * 100)}% WR`);
    if (row.sample_size != null) parts.push(`N=${row.sample_size}`);
    if (row.ev_per_trade != null) parts.push(`$${Math.round(row.ev_per_trade)}/trade`);
    if (row.sample_size != null && row.sample_size < 20) parts.push('(thin sample)');
    return parts.length ? parts.join(', ') : fallbackLabel;
  }

  // Build unified setups array
  const setups = [];
  // Removed 2026-07-20: a 14-entry hand-typed stop/t1/t2 override map — the exact
  // "never hand-type a WR%/N/$ literal" anti-pattern CLAUDE.md has caught 7 other
  // times, an 8th instance sitting unnoticed here. Checked directly before removing:
  // 13 of 14 entries were already fully redundant (a real OPTIMAL_STOP row exists for
  // every signal_name they covered, and `optByName` above already takes priority over
  // this map, so the hardcoded values were silently dead — never actually reached).
  // Only TRT_LONG (N=16, below the N>=20 calibration floor) still lacked real data;
  // per the same hard rule ("never hand-type... even as a placeholder"), it now
  // correctly shows `--` (honestly uncalibrated) instead of a stale guess, and will
  // pick up real data automatically the moment update_optimal_stops.mjs can compute
  // one — same self-healing pattern as everything else in this file.

  // Priority order for dedup: SETUP_STATUS > LEVEL_FADE_AUDIT / MIDPOINT_FADE_AUDIT > SYSTEM_BACKTEST
  // UNIFIED_BACKTEST: shown only for the specific signal_names that replace CONTEXT/SCALP legacy orphan types.
  //
  // FOUND 2026-07-18 (while verifying unified_display_allowlist_vs_dynamic_criteria's new
  // dynamic UNIFIED_BACKTEST filter actually deduplicated anything): displayPrimary listed
  // signal_types ('LEVEL_FADE', 'PD_LEVEL', 'SCALP', 'ROLLING') that don't exist ANYWHERE in
  // the live database (confirmed via direct query, 0 rows for all four) -- this codebase's
  // current primary calibration source is 'SETUP_STATUS', evidently the successor to
  // whatever produced those four signal_types before a past refactor, which never updated
  // this Set to match. hasPrimary() has been silently returning false for every call this
  // whole time, meaning its OTHER two use sites below (SYSTEM_BACKTEST and the 3 audit
  // types) have also never actually deduplicated against a real primary source, despite
  // their own comments saying they should. Also fixed a second, independent mismatch found
  // in the same investigation: SETUP_STATUS's own naming always includes "_FADE" before the
  // direction suffix (PD_HIGH_FADE_SHORT) while UNIFIED_BACKTEST/SYSTEM_BACKTEST/the audit
  // types never do (PD_HIGH_SHORT) -- an exact-string match would still fail to find a
  // SETUP_STATUS row for the same level even with the signal_type fixed. normalizeSetupName
  // strips "_FADE_" so both conventions compare equal; a name that never had "_FADE" (e.g.
  // TRT_LONG, IB_BULLISH) is unaffected by the strip.
  const normalizeSetupName = (name) => name.replace('_FADE_', '_');
  const displayPrimary = new Set(['SETUP_STATUS']);
  const hasPrimary = (name) => {
    const norm = normalizeSetupName(name);
    return auditQ.rows.some(r => displayPrimary.has(r.signal_type) && normalizeSetupName(r.signal_name) === norm);
  };
  const hasSystemBacktest = (name) => auditQ.rows.some(r => r.signal_name === name && r.signal_type === 'SYSTEM_BACKTEST');

  // UNIFIED_BACKTEST rows shown in the table (replaces CONTEXT/SCALP/SETUP legacy orphan
  // types) — dynamic as of 2026-07-18, replacing a hand-curated Set. See OPEN_DECISION
  // unified_display_allowlist_vs_dynamic_criteria for the full investigation: a naive
  // "N>=20 and EV>=-$5" filter alone would have flooded this table with dozens of thin/
  // duplicate directional facets of levels already shown via their own LEVEL_FADE/
  // SETUP_STATUS row (confirmed directly — 66 of 158 all-time UNIFIED_BACKTEST rows
  // classify ACTIVE, most of them exactly these duplicates, e.g. CAM_R1_SHORT/
  // FLOOR_PIVOT_LONG/CAM_R2_LONG). scripts/backtest_unified.js now writes a real
  // SUPPRESS/THIN_N/ACTIVE/PROMOTE recommendation onto every UNIFIED_BACKTEST row (same
  // thresholds as backtest_setup_status.mjs, not re-derived) — combined with the
  // already-existing hasPrimary() check below (previously only used to gate
  // LEVEL_FADE_AUDIT/SYSTEM_BACKTEST rows), that's enough to replace the hardcoded list:
  // show a row only if it independently clears the same bar every other setup_type does
  // AND isn't just re-surfacing a level already shown elsewhere. ACTIVE and PROMOTE both
  // count as "clears the bar" — PROMOTE is a narrower recovery-from-suppression state in
  // backtest_setup_status.mjs's own vocabulary, but on a UNIFIED_BACKTEST row's first-ever
  // classification pass nothing has suppression history yet, so requiring PROMOTE alone
  // (as literally read from the original decision text) would show almost nothing;
  // ACTIVE is the correct "good enough to trust, no exception involved" state.
  // 2D_POC_LONG/SHORT, PD2_VAH_LONG/SHORT, PD2_VAL_LONG/SHORT used to classify ACTIVE
  // under this backtest_unified.js pass (wrong entry-price convention + the old volume-
  // bucketing bug — confirmed via Gemini audit, independently re-verified by reading
  // detectLevelFades()/buildTwoDayPOC() directly), directly contradicting the CONFIRMED
  // RESEARCH_CLAIM 2d_poc_fade_no_edge (scripts/backtest_pd2_2dpoc_complete.mjs). A
  // hand-maintained CONFIRMED_NO_EDGE_OVERRIDE Set used to live here as a display-only
  // patch. Removed 2026-07-19: fixed at the root instead — the real gap wasn't the
  // display, it was that this CONFIRMED finding had never been wired into the live
  // unified suppression pipeline at all (these types had ~0 real active_setups history,
  // so backtest_setup_status.mjs had nothing to suppress). backtest_pd2_2dpoc_complete.mjs
  // now writes real SETUP_STATUS rows (SUPPRESS for the 3 N>=20 LONG variants, THIN_N for
  // the thin SHORT ones) using its own validated simulation — hasPrimary() below already
  // excludes any UNIFIED_BACKTEST row with a matching SETUP_STATUS row, so this override
  // is now redundant AND the underlying live-candidate-construction gap (server/routes/
  // acd.js's keepLevelsAll reads UNIFIED_BACKTEST stats directly, with no display-only
  // override applying there) is actually closed, not just hidden from this one table.
  const isUnifiedDisplayWorthy = (row) =>
    (row.recommendation === 'ACTIVE' || row.recommendation === 'PROMOTE')
    && !hasPrimary(row.signal_name);

  // Real live-used stop/target, keyed by signal_name — added 2026-07-20. Before this,
  // the stop/t1/t2 shown for a SETUP_STATUS-sourced row (the overwhelming majority of
  // this table) never read the real OPTIMAL_STOP calibration at all — the values shown
  // instead came from a hand-typed `overrides` literal (the exact "never hand-type a
  // WR%/N/$ literal" anti-pattern CLAUDE.md has caught 7 other times, removed) or a raw
  // MAE/MFE percentile fallback with no relationship to what's actually live. Sourced
  // from the dedicated optStopLatestQ (see its own query comment above) rather than
  // auditQ.rows — auditQ's per-signal_type latest-run join silently drops any
  // OPTIMAL_STOP signal_name that wasn't touched by the single most recent run.
  const optByName = new Map();
  for (const r of optStopLatestQ.rows) {
    let notes = null;
    try { notes = typeof r.notes === 'string' ? JSON.parse(r.notes) : r.notes; } catch (_) {}
    optByName.set(r.signal_name, { stop: r.optimal_stop, target: r.optimal_target, method: notes?.method || null });
  }

  for (const row of auditQ.rows) {
    if (row.signal_type === 'SYSTEM_SUMMARY') continue;
    if (row.signal_type === 'ROLLING_IB_AUDIT') continue;
    // TOUCH_QUALITY: a secondary per-setup_type dimension (order-flow classification of
    // HOW a touch resolved), not a tradeability verdict on its own — the setup_type's real
    // ACTIVE/CONTEXT/REMOVED status already comes from its SETUP_STATUS row above. Forcing
    // OVERRUN_BAD/ABSORBED_BEST/QUIET_BEST/NO_CLEAR_PATTERN into that status vocabulary would
    // misrepresent it as a suppression signal. Deliberately excluded (was previously an
    // undocumented silent fallthrough to the generic `else continue` below — the exact class
    // of bug CLAUDE.md's "New setup type checklist" item 8 exists to prevent). Shown instead
    // via the live ACDView.jsx badge (touchQualityStats on /api/antigravity/edges-context).
    // Found in code review 2026-07-15.
    if (row.signal_type === 'TOUCH_QUALITY') continue;
    // UNIFIED_BACKTEST: only show the specific signal_names above; everything else feeds keepLevels only
    if (row.signal_type === 'UNIFIED_BACKTEST' && !isUnifiedDisplayWorthy(row)) continue;
    // SYSTEM_BACKTEST is fallback only when no primary source (LEVEL_FADE etc.) exists
    if (row.signal_type === 'SYSTEM_BACKTEST' && hasPrimary(row.signal_name)) continue;
    // Audit types are suppressed when a primary source or SYSTEM_BACKTEST exists for the same signal
    if ((row.signal_type === 'LEVEL_FADE_AUDIT' || row.signal_type === 'MIDPOINT_FADE_AUDIT' || row.signal_type === 'PD_IB_AUDIT') && (hasPrimary(row.signal_name) || hasSystemBacktest(row.signal_name))) continue;

    // Normalize win_rate: PD_IB_AUDIT and some older audit scripts stored on 0-100 scale instead of 0-1
    const winRate = row.win_rate > 1 && (row.signal_type === 'LEVEL_FADE_AUDIT' || row.signal_type === 'MIDPOINT_FADE_AUDIT' || row.signal_type === 'PD_IB_AUDIT')
      ? row.win_rate / 100 : row.win_rate;

    const meta = levelMap[row.signal_name] || {};
    const levelPrice = meta.price != null ? Math.round(meta.price * 100) / 100 : null;
    const dist = levelPrice != null && currentPrice != null ? Math.round(Math.abs(currentPrice - levelPrice)) : null;

    // Determine status
    let status;
    if (row.signal_type === 'UNIFIED_BACKTEST') {
      // IB_BULLISH/BEARISH: always CONTEXT — EV is blended across day types (good on TREND, bad on BALANCE)
      if (row.signal_name === 'IB_BULLISH' || row.signal_name === 'IB_BEARISH') {
        status = 'CONTEXT';
      } else {
        const ev = row.ev_per_trade || 0;
        const wr = row.win_rate || 0;
        if (ev > 0 && wr >= 0.52) status = 'ACTIVE';
        else if (ev < -5)          status = 'REMOVED';
        else                       status = 'CONTEXT';
      }
    } else if (row.recommendation === 'KEEP' || row.recommendation === 'ACTIVE' || row.recommendation === 'PROMOTE') {
      status = 'ACTIVE';
    } else if (row.recommendation === 'DIRECTIONAL' || row.recommendation === 'CONTEXT' || row.recommendation === 'DLL_TRADEABLE' || row.recommendation === 'THIN' || row.recommendation === 'THIN_N' || row.recommendation === 'DAY_TYPE_MANAGED') {
      status = 'CONTEXT';
    } else if (row.recommendation === 'CUT' || row.recommendation === 'SUPPRESS') {
      status = 'REMOVED';
    } else {
      continue; // skip analytical rows with no display status (null, non-standard)
    }

    // Determine type
    let type;
    if (row.signal_type === 'SCALP' ||
        (row.signal_type === 'UNIFIED_BACKTEST' && (row.signal_name.includes('_SCALP_') || row.signal_name.startsWith('OR5_MID')))) {
      type = 'SCALP';
    } else if (row.signal_type === 'CONTEXT' ||
        (row.signal_type === 'UNIFIED_BACKTEST' && (row.signal_name === 'IB_BULLISH' || row.signal_name === 'IB_BEARISH'))) {
      type = 'CONTEXT';
    } else if (row.signal_type === 'SETUP') {
      type = 'SETUP';
    } else {
      type = 'LEVEL_FADE';
    }

    // Next 2 day probability based on ATR distance
    let next2DayProb = null;
    if (dist != null && atr20 != null) {
      if (dist <= atr20 * 0.5) next2DayProb = 'VERY_HIGH';
      else if (dist <= atr20) next2DayProb = 'HIGH';
      else if (dist <= atr20 * 1.5) next2DayProb = 'MEDIUM';
      else next2DayProb = 'LOW';
    }

    // Regime fit
    const regimeFit = regimeFitMap[row.signal_name] || null;

    // Stability/trend classification from backtest_setup_status.mjs's rigor diagnostics
    // (day-clustering + 3-way chronological EV-sign stability, added 2026-07-14). Only
    // meaningful for SETUP_STATUS rows — other signal_types don't write this field.
    // realN: the same all_time_real_n distinction setups.js's /setups/reference already
    // exposes -- a blended `n` here can be almost entirely synthetic BACKFILL (~80% of
    // active_setups per CLAUDE.md's own hard rule). This table previously showed only
    // the blended count with no way to tell, which is exactly the "found a high-N setup
    // that turned out to be N=3 real" pattern flagged 2026-08-25 -- surface it here too.
    let stabilityTrend = null, stabilityStable = null, realN = null;
    if (row.signal_type === 'SETUP_STATUS' && row.notes) {
      try {
        const parsed = JSON.parse(row.notes);
        stabilityTrend = parsed.rigor?.trend || null;
        stabilityStable = parsed.rigor?.three_way_stable;
        realN = parsed.all_time_real_n ?? null;
      } catch (_) {}
    }

    // Tests applied
    const tests = [];
    if (row.signal_type === 'SYSTEM_BACKTEST') tests.push(`180d system backtest (N=${row.sample_size})`);
    else if (row.signal_type === 'LEVEL_FADE') tests.push(`Level fade audit (N=${row.sample_size})`);
    else if (row.signal_type === 'SCALP' || row.signal_type === 'UNIFIED_BACKTEST') tests.push(`Unified backtest (N=${row.sample_size})`);
    else if (row.signal_type === 'CONTEXT') tests.push(`Context analysis (N=${row.sample_size})`);
    else tests.push(`${row.signal_type} (N=${row.sample_size})`);
    if (regimeFit) tests.push('regime analysis');
    if (row.avg_mae != null) tests.push('MAE/MFE audit');

    const opt = optByName.get(row.signal_name);
    setups.push({
      name: row.signal_name.replace(/_/g, ' '),
      rawName: row.signal_name,
      type,
      signalType: row.signal_type,
      wr: winRate,
      ev: row.ev_per_trade,
      totalPnl: status === 'ACTIVE' ? row.total_pnl : null,
      n: row.sample_size,
      stop: opt?.stop ?? row.current_stop ?? (row.p75_mae ? Math.round(row.p75_mae) : null),
      t1: opt?.target ?? row.current_target ?? (row.p50_mfe ? Math.round(row.p50_mfe) : null),
      t2: row.p75_mfe ? Math.round(row.p75_mfe) : null,
      targetMethod: opt?.method || null,
      runner: !!(row.p75_mfe && row.p50_mfe && row.p75_mfe > row.p50_mfe * 1.2),
      mae: row.avg_mae,
      mfe: row.avg_mfe,
      p50mae: row.p50_mae,
      p75mae: row.p75_mae,
      p90mae: row.p90_mae,
      p50mfe: row.p50_mfe,
      bestContext: describeLevel(row, meta.bestCtx) || row.notes || '',
      regimeFit,
      frequency: meta.freq || null,
      levelPrice,
      distFromPrice: dist,
      next2DayProb,
      wr10d: recent10d[row.signal_name]?.total >= 2 ? recent10d[row.signal_name].wins / recent10d[row.signal_name].total : null,
      n10d: recent10d[row.signal_name]?.total || 0,
      wr30d: recent30d[row.signal_name]?.total >= 3 ? recent30d[row.signal_name].wins / recent30d[row.signal_name].total : null,
      n30d: recent30d[row.signal_name]?.total || 0,
      trend10d: (() => {
        const r10 = recent10d[row.signal_name];
        if (!r10 || r10.total < 2) return null;
        const wr10 = r10.wins / r10.total;
        const diff = wr10 - (winRate || 0);
        return diff > 0.05 ? 'UP' : diff < -0.05 ? 'DOWN' : 'FLAT';
      })(),
      testsApplied: tests.join(', '),
      status,
      recommendation: row.recommendation,
      notes: row.notes,
      stabilityTrend,
      stabilityStable,
      realN,
    });
  }

  // Sort: ACTIVE first (by EV desc), then CONTEXT, then REMOVED
  const statusOrder = { ACTIVE: 0, CONTEXT: 1, REMOVED: 2 };
  setups.sort((a, b) => {
    const so = (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3);
    if (so !== 0) return so;
    return (b.ev || 0) - (a.ev || 0);
  });

  // Final-pass dedup by rawName — after sort so highest-status entry wins.
  // Prevents duplicates when the same signal appears in multiple signal types
  // (e.g. a level in LEVEL_FADE_AUDIT but not the current LEVEL_FADE run, plus SYSTEM_BACKTEST).
  const seenNames = new Set();
  const dedupedSetups = setups.filter(s => {
    if (seenNames.has(s.rawName)) return false;
    seenNames.add(s.rawName);
    return true;
  });

  // ── Confluence pairs ──────────────────────────────────────────────
  // pairsBaseQ/pairsSubQ/pairsWinQ already fetched in the batch above (all-time
  // reads of performance_audit, no dependency on anything else in this handler).

  // Index sub-conditions: pick best and worst per category per pair
  const subBest = {}, subWorst = {};
  pairsSubQ.rows.forEach(r => {
    const isDOW = /_DOW_\w+$/.test(r.signal_name);
    const isTOD = /_TOD_\w+$/.test(r.signal_name);
    const isDT  = /_DT_\w+$/.test(r.signal_name);
    const cat = isDOW ? 'DOW' : isTOD ? 'TOD' : isDT ? 'DT' : null;
    if (!cat) return;
    const base = r.signal_name.replace(/_DOW_\w+$/, '').replace(/_TOD_\w+$/, '').replace(/_DT_\w+$/, '');
    const key = base + '_' + cat;
    const suffix = isDOW ? r.signal_name.match(/_DOW_(\w+)$/)?.[1]
                 : isTOD ? r.signal_name.match(/_TOD_(\w+)$/)?.[1]
                 : r.signal_name.match(/_DT_(\w+)$/)?.[1];
    const entry = { label: suffix, n: r.sample_size, wr: r.wr_pct, ev: r.ev, rec: r.recommendation };
    if (!subBest[key])  subBest[key]  = entry;
    if (!subWorst[key]) subWorst[key] = entry;
    else if (r.ev < subWorst[key].ev) subWorst[key] = entry;
  });

  // Build rolling windows index
  const pairWins = {};
  pairsWinQ.rows.forEach(r => {
    if (!pairWins[r.signal_name]) pairWins[r.signal_name] = {};
    pairWins[r.signal_name][r.window_days] = { n: r.sample_size, wr: r.wr_pct, ev: r.ev };
  });

  const pairs = pairsBaseQ.rows.map(r => {
    const base = r.signal_name;
    const pairKey = base.replace(/^PAIR_/, '');
    const wins = pairWins[base] || {};
    const wr20  = wins[20]?.wr,  ev20  = wins[20]?.ev,  n20  = wins[20]?.n;
    const trend = (wr20 != null && r.wr_pct != null)
      ? (wr20 > r.wr_pct + 5 ? 'UP' : wr20 < r.wr_pct - 5 ? 'DOWN' : 'FLAT') : null;
    return {
      pair: pairKey,
      n: r.sample_size,
      wr: r.wr_pct,
      ev: r.ev,
      recommendation: r.recommendation,
      status: r.recommendation === 'TRADE' ? 'ACTIVE'
            : r.recommendation === 'CUT'   ? 'REMOVED'
            : 'CONTEXT',
      trend,
      wr20, ev20, n20,
      wr6m: wins[182]?.wr, ev6m: wins[182]?.ev,
      wr1y: wins[365]?.wr, ev1y: wins[365]?.ev,
      best_dow:  subBest[base + '_DOW']  || null,
      worst_dow: subWorst[base + '_DOW'] || null,
      best_tod:  subBest[base + '_TOD']  || null,
      worst_tod: subWorst[base + '_TOD'] || null,
      best_dt:   subBest[base + '_DT']   || null,
      worst_dt:  subWorst[base + '_DT']  || null,
    };
  });

  // Get SYSTEM_SUMMARY for the header
  const summary = auditQ.rows.find(r => r.signal_type === 'SYSTEM_SUMMARY');

  return {
    currentPrice,
    atr20,
    currentRegime,
    runDate,
    systemSummary: summary ? {
      totalPnl: summary.total_pnl,
      totalTrades: summary.sample_size,
      wr: summary.win_rate,
      ev: summary.ev_per_trade,
      notes: summary.notes,
    } : null,
    setups: dedupedSetups,
    pairs,
  };
}
