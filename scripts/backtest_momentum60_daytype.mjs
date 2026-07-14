/**
 * backtest_momentum60_daytype.mjs
 *
 * Conditional-variant backtest for MOMENTUM_60m_60m, split by day-type (found stable
 * 2026-07-13, see scratch/claude_minute_bar_conditioning.mjs and docs/OPEN_THREADS.md):
 *   - MOMENTUM_60m_60m_TREND: on TREND days, trade the extreme reading as CONTINUATION.
 *   - MOMENTUM_60m_60m_BALANCE_FADE: on BALANCE days, trade the extreme reading as a FADE
 *     (opposite direction from the raw reading).
 *
 * The original scan only measured the point value at exactly bar+60 (a time-exit), which
 * has no stop/target and can't resolve through the same active_setups TARGET_HIT/STOP_HIT
 * mechanism every other live setup uses. This script derives a real stop/target from MAE/MFE
 * within that same 60-bar window (p75 MAE = stop, p50 MFE = target — same convention as
 * update_optimal_stops.mjs / the Unified Signal Table), then re-simulates each event as an
 * actual price-based trade (first-touched-wins, bar HLC only, resolved by the window's final
 * bar if neither level is touched — same convention as backtest_wpp_short_gap.mjs).
 *
 * Day-type timing: acd_daily_log.day_type reclassifies at IB close (10:30 ET) — only events
 * firing at/after 10:30 ET are eligible (matches the original conditioning audit).
 *
 * Writes SETUP_STATUS + OPTIMAL_STOP rows to performance_audit for both variants.
 * Run: node scripts/backtest_momentum60_daytype.mjs
 * Add to run_weekly_backtests.sh under "Conditional-variant backtests" per CLAUDE.md checklist.
 */
import { query } from '../server/db.js';

const THRESHOLD_WINDOW_DAYS = 20;
const EXTREME_PCTL = 0.20;
const LOOKBACK_MIN = 60;
const HORIZON_MIN = 60;
const PNL_PER_PT = 2; // 1 MNQ = $2/pt, this codebase's standard single-contract assumption

const { rows: bars } = await query(`
  WITH raw AS (
    SELECT
      (ts AT TIME ZONE 'America/New_York')::date AS td,
      (EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York')*60+EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York'))::int as et_min,
      ts, open::float, high::float, low::float, close::float, volume::float
    FROM price_bars_primary
    WHERE symbol='NQ'
      AND (ts AT TIME ZONE 'America/New_York')::date >= '2023-11-15'
      AND (ts AT TIME ZONE 'America/New_York')::date < CURRENT_DATE
      AND (EXTRACT(hour FROM ts AT TIME ZONE 'America/New_York')*60+EXTRACT(minute FROM ts AT TIME ZONE 'America/New_York')) BETWEEN 570 AND 959
  )
  SELECT td, et_min,
    (array_agg(open ORDER BY ts ASC))[1] as open,
    MAX(high) as high, MIN(low) as low,
    (array_agg(close ORDER BY ts DESC))[1] as close,
    SUM(volume) as volume
  FROM raw GROUP BY td, et_min ORDER BY td, et_min
`);
const days = [...new Set(bars.map(b => String(b.td)))].sort();
const dayStartGi = new Map(), dayEndGi = new Map();
{
  let prevDay = null;
  for (let gi = 0; gi < bars.length; gi++) {
    const d = String(bars[gi].td);
    if (d !== prevDay) { dayStartGi.set(d, gi); prevDay = d; }
    dayEndGi.set(d, gi);
  }
}
console.log(`Loaded ${bars.length} bars, ${days.length} days`);

function momentum(gi) { const gj = gi - LOOKBACK_MIN; if (gj < 0) return null; return bars[gi].close - bars[gj].close; }
const vals = new Array(bars.length);
for (let gi = 0; gi < bars.length; gi++) vals[gi] = momentum(gi);

function thresholdsForDay(dayIdx) {
  if (dayIdx < THRESHOLD_WINDOW_DAYS) return null;
  const collected = [];
  for (let k = dayIdx - THRESHOLD_WINDOW_DAYS; k < dayIdx; k++) {
    const d = days[k];
    for (let gi = dayStartGi.get(d); gi <= dayEndGi.get(d); gi++) { const v = vals[gi]; if (v != null) collected.push(v); }
  }
  if (collected.length < 100) return null;
  collected.sort((a, b) => a - b);
  return { lo: collected[Math.floor(collected.length * EXTREME_PCTL)], hi: collected[Math.floor(collected.length * (1 - EXTREME_PCTL))] };
}

// ── Fire-once event detection (identical to the original scanner) ──
const events = [];
for (let dayIdx = THRESHOLD_WINDOW_DAYS; dayIdx < days.length; dayIdx++) {
  const d = days[dayIdx];
  const th = thresholdsForDay(dayIdx);
  if (!th) continue;
  const startGi = dayStartGi.get(d), endGi = dayEndGi.get(d);
  let wasExtreme = false;
  for (let gi = startGi; gi <= endGi; gi++) {
    const v = vals[gi];
    if (v == null) { wasExtreme = false; continue; }
    const isHigh = v >= th.hi, isLow = v <= th.lo, isExtreme = isHigh || isLow;
    if (isExtreme && !wasExtreme) {
      const fwdGi = gi + HORIZON_MIN;
      if (fwdGi <= endGi) events.push({ gi, endGi, day: d, etMin: bars[gi].et_min, extremeDir: isHigh ? 1 : -1 });
    }
    wasExtreme = isExtreme;
  }
}
console.log(`Total fire-once MOMENTUM_60m/60m events: ${events.length}`);

const dayTypeRows = await query(`SELECT trade_date::text as td, day_type FROM acd_daily_log WHERE day_type IS NOT NULL`);
const dayTypeMap = new Map(dayTypeRows.rows.map(r => [r.td, r.day_type]));

// ── Simulate each event as a real trade with a real stop/target ──
// tradeDir: +1 = long, -1 = short. TREND = same as extreme direction (continuation).
// BALANCE_FADE = opposite of extreme direction (fade).
function simulate(evts, tradeDirFn, stop, target) {
  const results = [];
  for (const e of evts) {
    const tradeDir = tradeDirFn(e);
    const entry = bars[e.gi].close;
    const stopPx = tradeDir === 1 ? entry - stop : entry + stop;
    const targetPx = tradeDir === 1 ? entry + target : entry - target;
    const windowEnd = Math.min(e.gi + HORIZON_MIN, e.endGi);
    let resolution = null, barsToRes = 0;
    for (let gi = e.gi + 1; gi <= windowEnd; gi++) {
      barsToRes = gi - e.gi;
      const b = bars[gi];
      if (tradeDir === 1) {
        if (b.low <= stopPx) { resolution = 'STOP_HIT'; break; }
        if (b.high >= targetPx) { resolution = 'TARGET_HIT'; break; }
      } else {
        if (b.high >= stopPx) { resolution = 'STOP_HIT'; break; }
        if (b.low <= targetPx) { resolution = 'TARGET_HIT'; break; }
      }
    }
    if (!resolution) {
      // Neither hit within the validated window — resolve by the window's final bar vs entry,
      // matching the original scan's own EV convention (score by final position at horizon).
      const finalClose = bars[windowEnd].close;
      const finalMove = tradeDir === 1 ? finalClose - entry : entry - finalClose;
      resolution = finalMove > 0 ? 'TARGET_HIT' : 'STOP_HIT';
    }
    const win = resolution === 'TARGET_HIT';
    const pnl = (win ? target : -stop) * PNL_PER_PT;
    results.push({ day: e.day, resolution, win, pnl, barsToRes });
  }
  return results;
}

// MAE/MFE within the validated window, using the RAW extreme direction as a first pass to
// derive the stop/target (same for both variants since it's the same predictor — direction
// just flips which side is "favorable").
function maeMfe(evts, tradeDirFn) {
  const maes = [], mfes = [];
  for (const e of evts) {
    const tradeDir = tradeDirFn(e);
    const entry = bars[e.gi].close;
    const windowEnd = Math.min(e.gi + HORIZON_MIN, e.endGi);
    let mae = 0, mfe = 0;
    for (let gi = e.gi + 1; gi <= windowEnd; gi++) {
      const b = bars[gi];
      const favorable = tradeDir === 1 ? b.high - entry : entry - b.low;
      const adverse = tradeDir === 1 ? entry - b.low : b.high - entry;
      if (favorable > mfe) mfe = favorable;
      if (adverse > mae) mae = adverse;
    }
    maes.push(mae); mfes.push(mfe);
  }
  maes.sort((a, b) => a - b); mfes.sort((a, b) => a - b);
  const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  return { p50Mae: pct(maes, 0.50), p75Mae: pct(maes, 0.75), p50Mfe: pct(mfes, 0.50), p75Mfe: pct(mfes, 0.75) };
}

const trendEvts = events.filter(e => e.etMin >= 630 && dayTypeMap.get(e.day) === 'TREND');
const balanceEvts = events.filter(e => e.etMin >= 630 && dayTypeMap.get(e.day) === 'BALANCE');
console.log(`TREND-day events: ${trendEvts.length} | BALANCE-day events: ${balanceEvts.length}`);

const trendDirFn = e => e.extremeDir;        // continuation: trade WITH the extreme
const balanceDirFn = e => -e.extremeDir;      // fade: trade AGAINST the extreme

const trendMM = maeMfe(trendEvts, trendDirFn);
const balanceMM = maeMfe(balanceEvts, balanceDirFn);

const trendTrades = simulate(trendEvts, trendDirFn, trendMM.p75Mae, trendMM.p50Mfe);
const balanceTrades = simulate(balanceEvts, balanceDirFn, balanceMM.p75Mae, balanceMM.p50Mfe);

function summarize(label, trades, mm) {
  const n = trades.length;
  const wins = trades.filter(t => t.win).length;
  const wr = n ? wins / n : null;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const ev = n ? totalPnl / n : null;
  console.log(`\n${label}`);
  console.log(`  Stop=${mm.p75Mae.toFixed(1)}pt (p75 MAE)  Target=${mm.p50Mfe.toFixed(1)}pt (p50 MFE)`);
  console.log(`  N=${n}  WR=${wr ? (100 * wr).toFixed(1) : 'n/a'}%  EV=$${ev ? ev.toFixed(2) : 'n/a'}  Total=$${totalPnl.toFixed(0)}`);
  return { n, wr, ev, totalPnl };
}
const trendSummary = summarize('MOMENTUM_60m_60m_TREND (continuation, real stop/target)', trendTrades, trendMM);
const balanceSummary = summarize('MOMENTUM_60m_60m_BALANCE_FADE (fade, real stop/target)', balanceTrades, balanceMM);

// ─── PERSIST TO PERFORMANCE_AUDIT (SETUP_STATUS + OPTIMAL_STOP), same convention as
// backtest_wpp_short_gap.mjs / update_optimal_stops.mjs ───────────────────────────
async function persist(type, summary, mm) {
  if (summary.n === 0) return;
  const rec = summary.n < 20 ? 'THIN_N' : (summary.ev < -5 ? 'SUPPRESS' : 'ACTIVE');
  await query(`
    INSERT INTO performance_audit
      (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl, recommendation, notes)
    VALUES (CURRENT_DATE, 0, 'SETUP_STATUS', $1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
      sample_size=EXCLUDED.sample_size, win_rate=EXCLUDED.win_rate, ev_per_trade=EXCLUDED.ev_per_trade,
      total_pnl=EXCLUDED.total_pnl, recommendation=EXCLUDED.recommendation, notes=EXCLUDED.notes
  `, [type, summary.n, summary.wr, summary.ev, summary.totalPnl, rec,
      JSON.stringify({ source: 'backtest_momentum60_daytype.mjs', all_time_n: summary.n,
        all_time_wr: summary.wr != null ? +(summary.wr * 100).toFixed(1) : null,
        all_time_ev: summary.ev != null ? +summary.ev.toFixed(2) : null })]);

  await query(`
    INSERT INTO performance_audit
      (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade,
       p50_mae, p75_mae, p50_mfe, p75_mfe, optimal_stop, optimal_target)
    VALUES (CURRENT_DATE, 9999, 'OPTIMAL_STOP', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
      sample_size=EXCLUDED.sample_size, win_rate=EXCLUDED.win_rate, ev_per_trade=EXCLUDED.ev_per_trade,
      p50_mae=EXCLUDED.p50_mae, p75_mae=EXCLUDED.p75_mae, p50_mfe=EXCLUDED.p50_mfe, p75_mfe=EXCLUDED.p75_mfe,
      optimal_stop=EXCLUDED.optimal_stop, optimal_target=EXCLUDED.optimal_target
  `, [type, summary.n, summary.wr, summary.ev, mm.p50Mae, mm.p75Mae, mm.p50Mfe, mm.p75Mfe, mm.p75Mae, mm.p50Mfe]);

  console.log(`  Persisted ${type}: N=${summary.n} → ${rec} (stop=${mm.p75Mae.toFixed(1)}pt, target=${mm.p50Mfe.toFixed(1)}pt)`);
}

await persist('MOMENTUM_60m_60m_TREND', trendSummary, trendMM);
await persist('MOMENTUM_60m_60m_BALANCE_FADE', balanceSummary, balanceMM);

console.log('\n[backtest_momentum60_daytype] Done.');
process.exit(0);
