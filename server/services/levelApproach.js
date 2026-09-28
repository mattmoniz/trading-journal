// Setup-anticipation computation — extracted from scripts/backtest_level_approach.js
// 2026-09-27, during a real-data audit of "which setups are statistically likely to fire
// today" (the user's own question: "prepared stats from that evening... armed with
// statistical validation to fire"). This is a rebuild, not a relocation — the prior
// version had a disqualifying validity bug (see below), not just a missing extraction.
//
// Two real bugs found and fixed here, confirmed against live data before shipping:
//
// (1) SUPPRESSION-BLINDNESS: the prior version ranked every setup_type by raw all-time
// fire_rate x avg_pnl with ZERO awareness of the setup_type's CURRENT SETUP_STATUS
// verdict. Live-checked: IB_BULLISH and IB_BEARISH -- both explicitly killed 2026-08-31
// after a redesign investigation proved their real thesis was never implemented and a
// placebo test showed zero real edge (see CLAUDE.md's "Where to look" entry on this) --
// were the #1 and #2 ranked "best TREND-day picks" (76%/67% WR) the day this was found.
// This is not "unvalidated," it's actively wrong: it recommends setups already proven
// dead by a more rigorous investigation elsewhere in this same codebase, because a raw
// historical WR/EV number was exactly the trap that fooled everyone about IB_BULLISH/
// BEARISH before the placebo test. Fixed by filtering through computeSuppressionSets()
// (server/services/setupEligibility.js) -- deliberately NOT getCanonicalLiveStatus(),
// since that function's SUPPRESS_ALL_DISABLED override (enabled 2026-09-25, a deliberate
// temporary "trade everything live" flag) would report IB_BEARISH as "ACTIVE" right now --
// correct for the live-firing gate that flag exists to affect, wrong for "should this be
// recommended as a good idea," which needs the RAW, un-overridden SETUP_STATUS verdict.
//
// (2) NO RIGOR/DAY-CLUSTERING CHECK: the prior version had MIN_FIRES=5 (far below this
// codebase's own N>=20 "decisive" floor used everywhere else) and no day-independence or
// chronological-stability check at all -- a 5th major statistical pipeline in this
// codebase (after backtest_setup_status.mjs, mine_minutebar_conditions.mjs,
// patternScannerService.js, mine_tod_patterns.mjs) that had never had computeRigor()
// wired in, despite CLAUDE.md's own "rigor diagnostics are standing, not one-off"
// convention. Live-checked with computeRigor() wired in: ZERO setup_types currently clear
// N>=20 trades AND distinctDates>=20 AND rigor.clean (stable, not day-clustered) in ANY of
// BALANCE/TREND/TURBULENT, even at the coarsest day_type-only conditioning (no
// day-of-week slice on top). This is not a rigor-code gap to patch -- it's a real data-
// maturity ceiling matching the one already found independently for DAY_TYPE_ALPHA sizing
// 2026-09-13 ("most real per-day-type cells roster-wide are day-clustered... a data-
// maturity ceiling on day-type conditioning generally, not a bug in this one script").
// See RESEARCH_CLAIM setup_anticipation_zero_decisive_picks_20260927 for the full numbers.
//
// Net effect: `/api/level-approach/today` now returns nothing (or only genuinely
// clean rows, on the rare occasion one exists) rather than a confidently-ranked list of
// setups that don't actually clear this codebase's own bar. An honest empty result is the
// correct behavior here, not a failure -- see SessionForecastPanel.jsx's handling.

import { query } from '../db.js';
import { REAL_TRADE_FILTER } from '../../scripts/backtest_setup_status.mjs';
import { computeSuppressionSets } from './setupEligibility.js';
import { computeRigor } from './rigorDiagnostics.js';

const MIN_FIRES = 20; // this codebase's own standing N>=20 "decisive" floor -- was 5
const MIN_DISTINCT_DATES = 20; // "N counts trades, not independent days" -- both floors, together
const DOW_LABEL = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

// Computes setup-anticipation stats per (setup_type, day_type, dow), filtered to setup_types
// NOT currently suppressed/thin (raw SETUP_STATUS, not the live-firing override), with a real
// day-clustering/chronological-stability check on every row. Returns the full derived list
// (including non-decisive rows, so a caller can choose to surface them as "not yet decisive"
// rather than silently dropping them) plus the raw suppression/rigor context used to build it.
export async function computeSetupAnticipation() {
  const { suppressedSetups } = await computeSuppressionSets(0); // dowInt unused here (no DOW-suppress lookup needed)

  // 1. Total trading days per (day_type, dow) — denominator for fire_rate
  const daysRes = await query(`
    SELECT day_type, EXTRACT(dow FROM trade_date)::int AS dow, COUNT(*)::int AS total_days
    FROM acd_daily_log
    WHERE day_type IS NOT NULL AND trade_date < CURRENT_DATE
    GROUP BY day_type, dow
  `);
  const totalByDtDow = new Map();
  const totalByDt = new Map();
  const totalByDow = new Map();
  let totalAll = 0;
  for (const r of daysRes.rows) {
    const dow = DOW_LABEL[r.dow];
    totalByDtDow.set(`${r.day_type}|${dow}`, r.total_days);
    totalByDt.set(r.day_type, (totalByDt.get(r.day_type) || 0) + r.total_days);
    totalByDow.set(dow, (totalByDow.get(dow) || 0) + r.total_days);
    totalAll += r.total_days;
  }
  const getTotalDays = (ctxKey) => {
    const [dt, dow] = ctxKey.split('|');
    if (dt === 'ALL' && dow === 'ALL') return totalAll;
    if (dt === 'ALL') return totalByDow.get(dow) || 0;
    if (dow === 'ALL') return totalByDt.get(dt) || 0;
    return totalByDtDow.get(ctxKey) || 0;
  };

  // 2. Raw per-trade rows (not pre-aggregated) — needed for computeRigor()'s per-day/
  // per-third checks, which can't be reconstructed from grouped counts.
  const firesRes = await query(`
    SELECT a.setup_type, d.day_type,
           EXTRACT(dow FROM (a.fired_at AT TIME ZONE 'America/New_York'))::int AS dow,
           a.trade_date::text AS trade_date,
           a.resolution, a.actual_pnl::float AS pnl
    FROM active_setups a
    JOIN acd_daily_log d ON d.trade_date = (a.fired_at AT TIME ZONE 'America/New_York')::date
    WHERE a.status <> 'SHADOW'
      AND a.resolution IN ('TARGET_HIT', 'STOP_HIT')
      AND d.day_type IS NOT NULL
      AND ${REAL_TRADE_FILTER}
  `);

  // 3. Bucket raw rows by (setupType, ctxKey) for each of the 4 rollup granularities
  const buckets = {}; // setupType -> ctxKey -> [{date, pnl, win}]
  const addRow = (setupType, ctxKey, row) => {
    if (!buckets[setupType]) buckets[setupType] = {};
    if (!buckets[setupType][ctxKey]) buckets[setupType][ctxKey] = [];
    buckets[setupType][ctxKey].push({ date: row.trade_date, pnl: row.pnl, win: row.resolution === 'TARGET_HIT' });
  };
  for (const r of firesRes.rows) {
    const dowLabel = DOW_LABEL[r.dow];
    addRow(r.setup_type, `${r.day_type}|${dowLabel}`, r);
    addRow(r.setup_type, `${r.day_type}|ALL`, r);
    addRow(r.setup_type, `ALL|${dowLabel}`, r);
    addRow(r.setup_type, 'ALL|ALL', r);
  }

  // 4. Derive stats + rigor per bucket
  const derived = [];
  for (const [setupType, ctxMap] of Object.entries(buckets)) {
    const isSuppressed = suppressedSetups.has(setupType);
    for (const [ctxKey, events] of Object.entries(ctxMap)) {
      if (events.length < MIN_FIRES) continue; // still enforce SOME floor before even computing rigor
      const total_days = getTotalDays(ctxKey);
      const fires = events.length;
      const wins = events.filter(e => e.win).length;
      const total_pnl = events.reduce((s, e) => s + e.pnl, 0);
      const avg_pnl = total_pnl / fires;
      const cond_wr = wins / fires;
      const fire_rate = total_days > 0 ? fires / total_days : null;
      const exp_ev = fire_rate != null ? fire_rate * avg_pnl : null;
      const rigor = computeRigor(events, { dateField: 'date', pnlFn: e => e.pnl });
      const decisive = !isSuppressed && fires >= MIN_FIRES && rigor.distinctDates >= MIN_DISTINCT_DATES && rigor.clean === true;
      derived.push({
        setupType, ctxKey, fires, wins, avg_pnl, cond_wr, fire_rate, exp_ev, total_days,
        suppressed: isSuppressed, distinctDates: rigor.distinctDates, top5DayPct: rigor.top5DayPct,
        clustered: rigor.clustered, stable: rigor.stable, decisive,
      });
    }
  }
  return derived;
}
