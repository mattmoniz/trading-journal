// Per-setup-type daily loss cap -- calibration/recheck only, NOT wired live.
//
// Tests a statistics-free circuit breaker: once a setup_type's running real intraday P&L on a
// given trade_date crosses -2x its own live OPTIMAL_STOP distance (in dollars), would force-
// SHADOW that setup_type for the rest of that day. Built 2026-09-04 during an overnight
// profitability review (user request: "keep digging... test it non stop").
//
// FULL-HISTORY RESULT (first run): NET HARMFUL -- the real trades that occur after the cap would
// trigger sum to a NET POSITIVE $1159 (would have blocked real recoveries, not just real losses),
// driven by 2 large recovery days (2026-07-29/30). This is the 4th independent "cut exposure
// after bad signs" idea this session to show the same reversion-trap signature (see
// [[feedback_reactive_exposure_cutting_reversion_trap]] in Claude's own memory) -- standDown loss-
// streak sizing and the sizeMultiplier stacking override both failed the same way on pooled data.
//
// BUT restricted to trade_date >= 2026-08-01 (the account's own real losing stretch), the sign
// REVERSES: net helpful. Thin (single-digit distinct days) -- not proven, not shipped. Instead of
// building a full live SHADOW-parallel tracking mechanism for a still-thin, previously-reversing
// finding, this script re-derives both windows on every run and updates one RESEARCH_CLAIM so the
// finding either firms up or fades as real data accumulates, rather than sitting as a dead,
// unrecoverable inline analysis. See OPEN_DECISION per_setup_daily_loss_cap_recent_regime_reversal
// for the live/shadow/shelve product decision this still needs once/if it firms up.
//
// No lookahead: for each (setup_type, trade_date), only real trades already fired that day are
// used to build the running P&L; the cap decision at trade N only ever looks at trades 1..N-1.

import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const CAP_MULTIPLE = 2; // cap at -2x the setup's own calibrated stop distance, in dollars
const RECENT_WINDOW_START = '2026-08-01';

async function loadStopByType() {
  const r = await query(`
    SELECT DISTINCT ON (signal_name) signal_name, optimal_stop
    FROM performance_audit WHERE signal_type='OPTIMAL_STOP'
    ORDER BY signal_name, run_date DESC
  `);
  const stopByType = {};
  for (const row of r.rows) if (row.optimal_stop != null) stopByType[row.signal_name] = Number(row.optimal_stop);
  return stopByType;
}

async function loadRealTrades() {
  const r = await query(`
    SELECT setup_type, trade_date::text AS trade_date, fired_at::text AS fired_at, actual_pnl::float AS pnl
    FROM active_setups
    WHERE origin_status='ACTIVE' AND resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED') AND actual_pnl IS NOT NULL
    ORDER BY setup_type, trade_date, fired_at
  `);
  return r.rows;
}

function simulate(trades, stopByType, dollarsPerPoint, commissionPerRoundTrip) {
  const byKey = {};
  for (const t of trades) (byKey[`${t.setup_type}|${t.trade_date}`] ??= []).push(t);

  let daysCapped = 0, daysNotCapped = 0;
  const postCap = []; // every real trade that occurred after a cap would have triggered
  for (const key of Object.keys(byKey)) {
    const [type] = key.split('|');
    const stopPts = stopByType[type];
    if (!stopPts) continue;
    const capDollars = -(CAP_MULTIPLE * stopPts * dollarsPerPoint - commissionPerRoundTrip);
    const dayTrades = byKey[key];
    let running = 0, capped = false;
    for (const t of dayTrades) {
      if (capped) { postCap.push(t); continue; }
      running += t.pnl;
      if (running <= capDollars) capped = true;
    }
    if (capped) daysCapped++; else daysNotCapped++;
  }
  const n = postCap.length;
  const netPnl = postCap.reduce((s, t) => s + t.pnl, 0);
  const wins = postCap.filter(t => t.pnl > 0).length;
  const byDate = {};
  for (const t of postCap) (byDate[t.trade_date] ??= { n: 0, pnl: 0 }), byDate[t.trade_date].n++, byDate[t.trade_date].pnl += t.pnl;
  const distinctDates = Object.keys(byDate).length;
  return { daysCapped, daysNotCapped, n, netPnl, wins, distinctDates, byDate, postCap };
}

async function main() {
  const { LIVE_INSTRUMENT } = await import('../server/config/instruments.js');
  const todayR = await query(`SELECT CURRENT_DATE::text AS today`);
  const today = todayR.rows[0].today;
  const stopByType = await loadStopByType();
  const trades = await loadRealTrades();

  const full = simulate(trades, stopByType, LIVE_INSTRUMENT.dollarsPerPoint, LIVE_INSTRUMENT.commissionPerRoundTrip);
  const recentTrades = trades.filter(t => t.trade_date >= RECENT_WINDOW_START);
  const recent = simulate(recentTrades, stopByType, LIVE_INSTRUMENT.dollarsPerPoint, LIVE_INSTRUMENT.commissionPerRoundTrip);

  // Chronological stability on the full-history post-cap (would-be-skipped) trade population.
  const rigor = full.postCap.length >= 15
    ? computeRigor(full.postCap, { dateField: 'trade_date', pnlFn: t => t.pnl })
    : null;

  console.log('=== Per-setup daily loss cap recheck ===');
  console.log(`Full history: ${full.daysCapped} setup-days would hit the cap, ${full.daysNotCapped} would not.`);
  console.log(`  Post-cap (would-be-skipped) trades: N=${full.n}, wins=${full.wins}, net P&L=$${full.netPnl.toFixed(2)}, distinct days=${full.distinctDates}`);
  console.log(`Since ${RECENT_WINDOW_START}: post-cap trades N=${recent.n}, net P&L=$${recent.netPnl.toFixed(2)}, distinct days=${recent.distinctDates}`);

  const verdict = full.netPnl > 0 && recent.netPnl <= 0
    ? 'RECENT_REGIME_REVERSAL_UNCHANGED'
    : full.netPnl <= 0 && recent.netPnl <= 0
    ? 'NOW_NET_HELPFUL_BOTH_WINDOWS'
    : full.netPnl > 0 && recent.netPnl > 0
    ? 'STILL_NET_HARMFUL_BOTH_WINDOWS'
    : 'MIXED';

  await recordClaim({
    slug: 'perSetup_daily_loss_cap_reversion_trap_20260904',
    claimText: `Per-setup-type daily loss cap (force-SHADOW rest of day past -${CAP_MULTIPLE}x calibrated OPTIMAL_STOP distance). ` +
      `Full history: ${full.daysCapped} setup-days would trigger; the ${full.n} real trades that occur after the trigger ` +
      `(${full.wins} wins) sum to a NET ${full.netPnl > 0 ? 'POSITIVE' : 'NEGATIVE'} $${full.netPnl.toFixed(2)} ` +
      `(${full.netPnl > 0 ? 'cap would have been net HARMFUL, blocking real recoveries' : 'cap would have been net HELPFUL'}), ` +
      `across ${full.distinctDates} distinct days` +
      (rigor ? ` (computeRigor: clustered=${rigor.clustered}, stable=${rigor.stable}, top5DayPct=${rigor.top5DayPct?.toFixed?.(1)}%)` : ' (too few days for rigor check)') +
      `. Since ${RECENT_WINDOW_START} (the account's own recent losing stretch): N=${recent.n} post-cap trades across ` +
      `${recent.distinctDates} distinct days, net $${recent.netPnl.toFixed(2)} -- verdict this run: ${verdict}. ` +
      `Not shipped (thin recent-window N, see OPEN_DECISION per_setup_daily_loss_cap_recent_regime_reversal for the ` +
      `live/shadow-log/shelve product decision). This script self-recalibrates weekly; do not act on any single run's ` +
      `recent-window number alone until distinct days there clears this codebase's own N>=20/20-day floor.`,
    sourceFile: 'scripts/backtest_per_setup_daily_loss_cap.mjs',
    sourceDate: today,
    sampleSize: full.n,
    evPerTrade: full.n ? full.netPnl / full.n : null,
    rigorStatus: rigor ? (rigor.clustered ? 'day_clustered' : rigor.stable ? 'stable' : 'unstable') : 'too_few_days',
    status: 'PROVISIONAL',
  });

  console.log(`Recorded RESEARCH_CLAIM perSetup_daily_loss_cap_reversion_trap_20260904 (verdict this run: ${verdict}).`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
