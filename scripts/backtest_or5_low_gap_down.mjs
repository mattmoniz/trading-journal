/**
 * backtest_or5_low_gap_down.mjs
 *
 * Conditional-variant calibration script for OR5_LOW_FADE_LONG_GAP_DOWN.
 *
 * Origin: docs/OPEN_THREADS.md 2026-08-18. OR5_LOW_FADE_LONG (fading the 5-min
 * opening-range low, going LONG) was suppressed by the generic weekly scan despite
 * a positive blended EV. A conditional-fade mining pass (scripts/mine_or_conditional_fade.mjs)
 * tested 6 fire-time-knowable bar-state conditions against the OR family's real
 * bar-history population and found one that survived: whether the session gapped
 * DOWN into the level (today's 9:30 open below the prior session's RTH close).
 * Gap-aligned touches: N=147, EV=$7.77/trade, rigor CLEAN. Gap-against touches:
 * N=194, EV=-$2.08/trade. Replication PASS (caveat: only checked against other
 * OR-family cells, not the full ~110-type roster).
 *
 * DETECTION LOGIC IS DELIBERATELY LIFTED FROM mine_or_conditional_fade.mjs, NOT
 * backtest_wpp_short_gap.mjs. DeepSeek review (2026-08-18) caught that WPP's script
 * uses a different touch definition (5pt high/low crossing, price_bars, no
 * first-touch/gateMin/from-above logic) that would reproduce a DIFFERENT population
 * than the one actually validated. This script must reproduce ~147/194 (aligned/
 * against) or the persisted SETUP_STATUS/OPTIMAL_STOP row doesn't reflect what was
 * tested. Only the PERSISTENCE pattern (the INSERT ... ON CONFLICT DO UPDATE shape)
 * is borrowed from backtest_wpp_short_gap.mjs.
 *
 * DELIBERATE DEVIATION FROM THE WPP PRECEDENT: this script does NOT let the
 * recommendation compute naturally from the backtest N/EV. WPP_FADE_SHORT_GAP_UP's
 * script does (rows.length>=20 && ev>-5 -> ACTIVE), and that variant is currently
 * ACTIVE (real capital) on a historical-backtest-only basis with ZERO real
 * origin_status='ACTIVE' trades ever -- confirmed live 2026-08-18 as an open
 * INVARIANT_WARN (scratch/gemini_alerts.txt), i.e. this codebase's own safety net
 * already flags that pattern as anomalous, not something to replicate. This script
 * hardcodes recommendation='THIN_N' regardless of what the backtest N/EV would
 * imply, so the variant fires SHADOW-only until REAL forward trades (origin_status
 * IN ('ACTIVE','SHADOW')) accumulate to N>=20 -- consistent with this codebase's
 * standing "never fire live before N>=20 resolved trades" rule for a brand-new
 * setup_type. sample_size in the persisted row is the historical backtest N (147),
 * NOT a real-trade count -- notes.forced_thin_n_reason documents this explicitly
 * so a future session doesn't mistake THIN_N-with-N=147 for the ordinary N<20 case.
 * Promotion to ACTIVE must be a deliberate manual step once real forward N>=20
 * clears with acceptable EV (mirrors the _TRAIL variants' manual-promotion model,
 * not WPP's backtest-only-ACTIVE-forever pattern).
 */

import pool from '../server/db.js';
import { getOpeningRange } from '../server/services/acdBacktest.js';
import { precomputeCrossovers } from './update_optimal_stops.mjs';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { findTradingDayGaps } from '../server/services/queries.js';

const STOP_DPP = LIVE_INSTRUMENT.dollarsPerPoint;
const TARGET_DPP = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const TOUCH_BAND = 15; // standard nearLevels proximity convention used throughout acd.js
const OR_WINDOW = 5;
const GATE_MIN = 570 + OR_WINDOW; // 9:35am ET, matches mining script's gateMin = 570 + w

async function main() {
  console.log('Loading OR5_LOW_FADE_LONG live OPTIMAL_STOP...');
  const optRes = await pool.query(`
    SELECT optimal_stop, optimal_target FROM performance_audit
    WHERE signal_type='OPTIMAL_STOP' AND signal_name='OR5_LOW_FADE_LONG'
    ORDER BY run_date DESC LIMIT 1
  `);
  if (!optRes.rows.length) throw new Error('No OPTIMAL_STOP row for OR5_LOW_FADE_LONG -- cannot derive stop/target for the gap-down variant');
  const STOP_DIST = parseFloat(optRes.rows[0].optimal_stop);
  const TARGET_DIST = parseFloat(optRes.rows[0].optimal_target);
  console.log(`Using OR5_LOW_FADE_LONG's live calibration: stop=${STOP_DIST}pt target=${TARGET_DIST}pt`);

  console.log('Loading NQ RTH bars...');
  const barsRes = await pool.query(`
    SELECT ts::date::text as date,
           to_char(ts, 'HH24:MI') as time,
           EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) as tod,
           open::float, high::float, low::float, close::float
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts::time >= '09:30' AND ts::time < '16:00'
    ORDER BY ts ASC
  `);
  console.log(`Loaded ${barsRes.rows.length} bars.`);

  const allBars = barsRes.rows;
  const barsByDateMap = new Map();
  for (let i = 0; i < allBars.length; i++) {
    const b = allBars[i];
    b.absIdx = i;
    if (!barsByDateMap.has(b.date)) barsByDateMap.set(b.date, []);
    barsByDateMap.get(b.date).push(b);
  }
  const dates = Array.from(barsByDateMap.keys()).sort();

  // FIXED 2026-08-31 (OPEN_DECISION audit_remaining_positional_dategap_scripts_20260831):
  // dates[i-1] below is treated as "the prior trading session" -- silently wrong on the
  // handful of dates that are the FIRST real day after one of the real ~63-day NQ
  // contract-rollover gaps in price_bars_dedup_hist (Dec2023-May2025, see
  // server/services/queries.js's header comment), where dates[i-1] is actually ~2 months in
  // the past. This is the most exposed of the positional-indexing scripts flagged in this
  // decision -- the whole premise here is measuring distance from the IMMEDIATELY preceding
  // close, so a stale multi-month-old close would silently produce a huge, meaningless
  // "gap down" reading on those specific dates instead of being excluded like any other
  // missing-data case already is (the `if (prevRthClose == null) continue;` check below).
  const gapAfterIndex = new Set(findTradingDayGaps(dates, 5).map(g => g.fromIndex));

  // Prior-session RTH close per date -- same definition the mining script used
  // (prior day's last RTH bar close), matching lp.PD_CLOSE's live source
  // (developing_value_log.session_close) so the backtest population matches what
  // the live resolveSetupType() override will classify.
  const prevRthCloseByDate = new Map();
  for (let i = 1; i < dates.length; i++) {
    if (gapAfterIndex.has(i - 1)) continue; // dates[i-1] is not really "yesterday" -- leave prevRthCloseByDate unset, same as any other missing-data date
    const prevBars = barsByDateMap.get(dates[i - 1]);
    prevRthCloseByDate.set(dates[i], prevBars[prevBars.length - 1].close);
  }

  const trades = [];
  for (const date of dates) {
    const bars = barsByDateMap.get(date);
    const prevRthClose = prevRthCloseByDate.get(date);
    if (prevRthClose == null) continue;
    const openBar = bars[0].open;
    const gapDown = openBar < prevRthClose; // aligned for a LONG fade at OR5 low

    const orInfo = getOpeningRange(bars, OR_WINDOW);
    if (!orInfo) continue;
    const lvl = orInfo.low;
    if (lvl == null) continue;

    let fired = false;
    for (let i = 5; i < bars.length; i++) {
      const b = bars[i];
      if (b.tod < GATE_MIN) continue;
      if (fired) break; // first-touch-only, matches mining script's `fired` Set for this single level

      const isWithin = Math.abs(b.close - lvl) <= TOUCH_BAND;
      if (!isWithin) continue;
      fired = true;

      // from-above direction check (mining script's `fromAbove`) -- only keep touches
      // approaching from above, i.e. the LONG-fade-at-a-low shape.
      const fromAbove = !(bars[i - 5].close < b.close);
      if (!fromAbove) continue;

      const maxBars = bars.length - i; // day-bounded walk, no cross-day lookahead
      trades.push({
        date: b.date,
        entry: b.close,
        barIdx: b.absIdx,
        maxBars,
        gapDown,
        direction: 'LONG', // fading a low = LONG; precomputeCrossovers reads this for MAE/MFE sign
      });
    }
  }

  console.log(`Generated ${trades.length} OR5_LOW_FADE_LONG touch instances (all directions/gap-states).`);

  function evaluate(t) {
    const cx = precomputeCrossovers(t, allBars, [STOP_DIST], [TARGET_DIST], t.maxBars);
    let pnl = 0;
    let win = false;
    if (cx) {
      const stopBar = cx.stopHitAt[STOP_DIST];
      const tgtBar = cx.targetHitAt[TARGET_DIST];
      if (stopBar != null && (tgtBar == null || stopBar <= tgtBar)) {
        pnl = -STOP_DIST * STOP_DPP - COMMISSION;
      } else if (tgtBar != null) {
        pnl = TARGET_DIST * TARGET_DPP - COMMISSION;
        win = true;
      } else {
        pnl = cx.mtmPts * STOP_DPP - COMMISSION;
        win = pnl > 0;
      }
    }
    return { pnl, win };
  }

  const gapDownTrades = trades.filter(t => t.gapDown).map(t => ({ ...t, ...evaluate(t) }));
  const gapAgainstTrades = trades.filter(t => !t.gapDown).map(t => ({ ...t, ...evaluate(t) }));

  const summarize = (rows) => {
    if (!rows.length) return { n: 0, wr: 0, ev: 0, totalPnl: 0 };
    const wins = rows.filter(r => r.win).length;
    const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);
    return { n: rows.length, wr: wins / rows.length, ev: totalPnl / rows.length, totalPnl };
  };

  const gapDownStats = summarize(gapDownTrades);
  const gapAgainstStats = summarize(gapAgainstTrades);
  console.log(`\nGap-down (aligned): N=${gapDownStats.n} WR=${(gapDownStats.wr * 100).toFixed(1)}% EV=$${gapDownStats.ev.toFixed(2)}`);
  console.log(`Gap-against:        N=${gapAgainstStats.n} WR=${(gapAgainstStats.wr * 100).toFixed(1)}% EV=$${gapAgainstStats.ev.toFixed(2)}`);

  // ─── PERSIST ────────────────────────────────────────────────────────────
  // recommendation is HARDCODED to THIN_N regardless of gapDownStats -- see file
  // header. Do not change this to a computed threshold without a deliberate,
  // separate decision to promote based on real forward trades.
  const type = 'OR5_LOW_FADE_LONG_GAP_DOWN';
  const rec = 'THIN_N';

  await pool.query(`
    INSERT INTO performance_audit
      (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl, recommendation, notes)
    VALUES (CURRENT_DATE, 0, 'SETUP_STATUS', $1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
      sample_size=EXCLUDED.sample_size, win_rate=EXCLUDED.win_rate, ev_per_trade=EXCLUDED.ev_per_trade,
      total_pnl=EXCLUDED.total_pnl, recommendation=EXCLUDED.recommendation, notes=EXCLUDED.notes
  `, [type, gapDownStats.n, gapDownStats.wr, gapDownStats.ev, gapDownStats.totalPnl, rec,
      JSON.stringify({
        source: 'backtest_or5_low_gap_down.mjs',
        filter: 'gap_down_into_or5_low',
        all_time_n: gapDownStats.n, all_time_wr: +(gapDownStats.wr * 100).toFixed(1),
        all_time_ev: +gapDownStats.ev.toFixed(2), total_pnl: +gapDownStats.totalPnl.toFixed(0),
        complement_n: gapAgainstStats.n, complement_ev: +gapAgainstStats.ev.toFixed(2),
        forced_thin_n_reason: 'brand-new setup_type, real forward N=0 -- SHADOW-only until real origin_status IN (ACTIVE,SHADOW) trades reach N>=20; recommendation is deliberately NOT computed from this historical backtest EV (see file header, DeepSeek review 2026-08-18). Promotion to ACTIVE requires a deliberate manual step once real forward N clears the floor with acceptable EV, never automatic.',
      })]);

  // optimal_stop/optimal_target here are INHERITED from OR5_LOW_FADE_LONG's own live
  // calibration (loaded above), not re-derived from this variant's 147-trade sample --
  // correct methodology (the mining pass itself used the base type's calibrated stop/
  // target), but note for a future reader: sample_size=147 describes the variant's own
  // backtest population, not the population the stop/target were actually optimized on.
  await pool.query(`
    INSERT INTO performance_audit
      (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade,
       optimal_stop, optimal_target)
    VALUES (CURRENT_DATE, 9999, 'OPTIMAL_STOP', $1, $2, $3, $4, $5, $6)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
      sample_size=EXCLUDED.sample_size, win_rate=EXCLUDED.win_rate, ev_per_trade=EXCLUDED.ev_per_trade,
      optimal_stop=EXCLUDED.optimal_stop, optimal_target=EXCLUDED.optimal_target
  `, [type, gapDownStats.n, gapDownStats.wr, gapDownStats.ev, STOP_DIST, TARGET_DIST]);

  console.log(`\nPersisted ${type}: N=${gapDownStats.n} WR=${(gapDownStats.wr * 100).toFixed(1)}% EV=$${gapDownStats.ev.toFixed(1)} -> ${rec} (forced, see notes)`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
