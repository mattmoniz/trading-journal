/**
 * Walk-forward comparison: OR-High/Low invalidation boundary (old, buggy) vs IB-High/Low
 * invalidation boundary (new, fixed 2026-09-02) for the 8 IB_HIGH, IB_LOW, PD_IB_HIGH,
 * PD_IB_LOW setup types.
 *
 * Context: structurallyInvalidateSetups() (server/routes/acd.js) used to kill a SHORT setup
 * the instant price closed above the day's Opening Range High (a 5-30min level), and a LONG
 * setup the instant price closed below OR Low. But these 8 setup types fade the 60-min
 * Initial Balance high/low, a level that's virtually always outside the narrower OR -- so
 * entries were routinely born already past their own kill-switch trigger. Fixed live
 * 2026-09-02 to use IB high/low (the setup's own actual level) instead of OR high/low for
 * just these 8 types.
 *
 * This script answers "how much would that have changed P&L" via a clean, deterministic
 * bar-by-bar re-walk of EVERY real (ACTIVE/SHADOW) historical trade of these 8 types -- not
 * just the ones that happened to get caught by the live poller (which depends on server
 * uptime/poll timing noise, not the logic itself). Two walks per trade, identical except for
 * which boundary triggers invalidation:
 *   OLD: invalidate SHORT when bar close > OR High; LONG when bar close < OR Low.
 *   NEW: invalidate SHORT when bar close > IB High; LONG when bar close < IB Low.
 * Stop/target-hit priority within a bar mirrors server/services/maeMfeReplay.js's
 * replayBars() convention (same-bar stop+target conflict = stop wins, checked before the
 * invalidation close-check) -- reused import, not reimplemented, for the actual stop/target
 * arithmetic; the invalidation-boundary layer is new since replayBars() has no such concept.
 *
 * No lookahead: entry/stop/t1/fired_at are the setup's own real, already-fixed values (never
 * recomputed). IB high/low for a trade's date is the FINAL 9:30-10:29 ET range -- always
 * already fully formed by the time any of these 8 types can fire (fire gate is
 * etMin>=630/10:30 ET), so using it for the whole post-entry walk is not lookahead. Bars are
 * walked strictly forward from fired_at, session-bounded by the trade's own real expires_at
 * (falls back to 16:00 ET / 960min same day if null, matching this codebase's standard RTH
 * fade lifecycle).
 *
 * Run: node scripts/backtest_ib_high_low_invalidation_boundary_fix.mjs
 */

import { query } from '../server/db.js';
import pool from '../server/db.js';
import { resolveDirection } from '../server/config/setupTypes.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

const SIGNAL_TYPE = 'IB_INVALIDATION_BOUNDARY_FIX';
const PPP = LIVE_INSTRUMENT.dollarsPerPoint;
const COMM = LIVE_INSTRUMENT.commissionPerRoundTrip;

// Walk one scenario: stop/target-hit priority matches maeMfeReplay.js's replayBars() (same-bar
// stop+target conflict = stop wins), checked before the invalidation close-check on each bar.
function walk(bars, entry, stop, t1, direction, boundaryHigh, boundaryLow) {
  for (const bar of bars) {
    const stopHit   = direction === 'LONG' ? bar.low  <= stop : bar.high >= stop;
    const targetHit = direction === 'LONG' ? bar.high >= t1   : bar.low  <= t1;
    if (stopHit) {
      const pnl = Math.round(((direction === 'LONG' ? stop - entry : entry - stop) * PPP - COMM) * 100) / 100;
      return { outcome: 'STOP_HIT', pnl, ts: bar.ts };
    }
    if (targetHit) {
      const pnl = Math.round(((direction === 'LONG' ? t1 - entry : entry - t1) * PPP - COMM) * 100) / 100;
      return { outcome: 'TARGET_HIT', pnl, ts: bar.ts };
    }
    const invalidated = direction === 'SHORT' ? bar.close > boundaryHigh : bar.close < boundaryLow;
    if (invalidated) {
      const pnl = Math.round(((direction === 'LONG' ? bar.close - entry : entry - bar.close) * PPP - COMM) * 100) / 100;
      return { outcome: 'INVALIDATED', pnl, ts: bar.ts };
    }
  }
  if (!bars.length) return { outcome: 'NO_BARS', pnl: null, ts: null };
  const last = bars[bars.length - 1];
  const pnl = Math.round(((direction === 'LONG' ? last.close - entry : entry - last.close) * PPP - COMM) * 100) / 100;
  return { outcome: 'TIME_EXPIRED', pnl, ts: last.ts };
}

async function run() {
  console.log(`[backtest_ib_invalidation_fix] Building population...`);
  const { rows: candidates } = await query(`
    SELECT id, trade_date::text as trade_date, setup_type, fired_at::text as fired_at,
           expires_at::text as expires_at,
           entry_zone_high::float as entry_zone_high, entry_zone_low::float as entry_zone_low,
           stop_level::float as stop_level, t1_level::float as t1_level,
           actual_pnl::float as historical_actual_pnl, resolution as historical_resolution
    FROM active_setups
    WHERE setup_type IN ('IB_HIGH_FADE_LONG','IB_HIGH_FADE_SHORT','IB_LOW_FADE_LONG','IB_LOW_FADE_SHORT',
                          'PD_IB_HIGH_FADE_LONG','PD_IB_HIGH_FADE_SHORT','PD_IB_LOW_FADE_LONG','PD_IB_LOW_FADE_SHORT')
      AND origin_status IN ('ACTIVE','SHADOW')
      AND stop_level IS NOT NULL AND t1_level IS NOT NULL
      AND (entry_zone_high IS NOT NULL OR entry_zone_low IS NOT NULL)
    ORDER BY fired_at
  `);
  console.log(`[backtest_ib_invalidation_fix] N=${candidates.length} real candidates`);

  const orCache = new Map();
  const ibCache = new Map();
  async function getOr(tradeDate) {
    if (!orCache.has(tradeDate)) {
      const r = await query(`SELECT or_high::float, or_low::float FROM acd_daily_log WHERE trade_date=$1`, [tradeDate]);
      orCache.set(tradeDate, r.rows[0] || { or_high: null, or_low: null });
    }
    return orCache.get(tradeDate);
  }
  async function getIb(tradeDate) {
    if (!ibCache.has(tradeDate)) {
      const r = await query(`
        SELECT MAX(high)::float as ib_high, MIN(low)::float as ib_low
        FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
          AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 629
      `, [tradeDate]);
      ibCache.set(tradeDate, r.rows[0] || { ib_high: null, ib_low: null });
    }
    return ibCache.get(tradeDate);
  }

  const results = [];
  for (const c of candidates) {
    const direction = resolveDirection(c);
    if (!direction) { console.error(`[skip] id=${c.id} null direction`); continue; }
    const entry = c.entry_zone_high ?? c.entry_zone_low;

    const [or, ib] = await Promise.all([getOr(c.trade_date), getIb(c.trade_date)]);
    if (or.or_high == null || or.or_low == null) { console.error(`[skip] id=${c.id} no OR data`); continue; }
    if (ib.ib_high == null || ib.ib_low == null) { console.error(`[skip] id=${c.id} no IB data`); continue; }

    // Session boundary: real expires_at if present, else 16:00 ET same day.
    const upperBoundTs = c.expires_at || `${c.trade_date} 16:00:00`;
    const { rows: bars } = await query(`
      SELECT ts::text as ts, high::float, low::float, close::float
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts > $1 AND ts <= $2
      ORDER BY ts
    `, [c.fired_at, upperBoundTs]);

    const oldWalk = walk(bars, entry, c.stop_level, c.t1_level, direction, or.or_high, or.or_low);
    const newWalk = walk(bars, entry, c.stop_level, c.t1_level, direction, ib.ib_high, ib.ib_low);

    results.push({
      id: c.id, trade_date: c.trade_date, setup_type: c.setup_type, direction, fired_at: c.fired_at,
      historical_actual_pnl: c.historical_actual_pnl, historical_resolution: c.historical_resolution,
      old: oldWalk, new: newWalk, changed: oldWalk.outcome !== newWalk.outcome || oldWalk.pnl !== newWalk.pnl,
    });
  }

  console.log(`[backtest_ib_invalidation_fix] Replayed ${results.length}/${candidates.length}`);

  const oldTotal = results.reduce((s, r) => s + (r.old.pnl ?? 0), 0);
  const newTotal = results.reduce((s, r) => s + (r.new.pnl ?? 0), 0);
  const delta = newTotal - oldTotal;
  const changedRows = results.filter(r => r.changed);

  console.log(`\n=== AGGREGATE (N=${results.length}) ===`);
  console.log(`OLD rule (OR-boundary, matches pre-fix live behavior) total: $${oldTotal.toFixed(2)}`);
  console.log(`NEW rule (IB-boundary, the fix) total: $${newTotal.toFixed(2)}`);
  console.log(`DELTA: $${delta.toFixed(2)} across ${changedRows.length} trades whose outcome changed`);

  console.log(`\n=== OUTCOME DISTRIBUTION ===`);
  for (const label of ['OLD', 'NEW']) {
    const key = label === 'OLD' ? 'old' : 'new';
    const counts = {};
    for (const r of results) counts[r[key].outcome] = (counts[r[key].outcome] || 0) + 1;
    console.log(`${label}:`, JSON.stringify(counts));
  }

  console.log(`\n=== CHANGED TRADES (${changedRows.length}) ===`);
  for (const r of changedRows) {
    console.log(`  id=${r.id} ${r.setup_type} ${r.trade_date} ${r.direction} fired=${r.fired_at} | OLD: ${r.old.outcome} $${r.old.pnl?.toFixed(2)} | NEW: ${r.new.outcome} $${r.new.pnl?.toFixed(2)} | historical actual_pnl was $${r.historical_actual_pnl ?? 'n/a'} (${r.historical_resolution ?? 'n/a'})`);
  }

  console.log(`\n=== PER-SETUP_TYPE ===`);
  const bySetup = new Map();
  for (const r of results) {
    if (!bySetup.has(r.setup_type)) bySetup.set(r.setup_type, []);
    bySetup.get(r.setup_type).push(r);
  }
  for (const [type, rows] of bySetup) {
    const o = rows.reduce((s, r) => s + (r.old.pnl ?? 0), 0);
    const n = rows.reduce((s, r) => s + (r.new.pnl ?? 0), 0);
    console.log(`  ${type.padEnd(24)} N=${rows.length} OLD=$${o.toFixed(2)} NEW=$${n.toFixed(2)} delta=$${(n - o).toFixed(2)}`);
  }

  // Rigor on the delta contribution per changed trade (new.pnl - old.pnl)
  const deltaEvents = changedRows.map(r => ({ date: r.trade_date, contribution: (r.new.pnl ?? 0) - (r.old.pnl ?? 0) }));
  const rigor = computeRigor(deltaEvents, { dateField: 'date', pnlFn: e => e.contribution });
  console.log(`\n=== RIGOR ON DELTA (N=${deltaEvents.length}) ===`);
  console.log(JSON.stringify(rigor, null, 2));

  const runDate = (await query(`SELECT CURRENT_DATE::text as today`)).rows[0].today;
  const notes = {
    method: 'clean bar-by-bar re-walk (both scenarios), not a replay of what the live poller actually caught',
    n_total: results.length, n_changed: changedRows.length,
    old_total: +oldTotal.toFixed(2), new_total: +newTotal.toFixed(2), delta: +delta.toFixed(2),
    changed_trades: changedRows.map(r => ({ id: r.id, setup_type: r.setup_type, trade_date: r.trade_date,
      old_outcome: r.old.outcome, old_pnl: r.old.pnl, new_outcome: r.new.outcome, new_pnl: r.new.pnl })),
    rigor,
  };
  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, total_pnl, recommendation, notes)
    VALUES ($1, 9999, $2, 'ALL', $3, $4, $5, $6)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
      SET sample_size=EXCLUDED.sample_size, total_pnl=EXCLUDED.total_pnl, recommendation=EXCLUDED.recommendation, notes=EXCLUDED.notes
  `, [runDate, SIGNAL_TYPE, results.length, delta, delta > 0 ? 'FIX_POSITIVE' : delta < 0 ? 'FIX_NEGATIVE' : 'FIX_NEUTRAL', JSON.stringify(notes)]);

  await recordClaim({
    slug: 'ib_high_low_invalidation_boundary_fix_walk_forward',
    claimText: `Walk-forward re-simulation (clean bar-by-bar re-walk, not a replay of live-poller-caught outcomes) comparing the OLD structural-invalidation boundary (OR High/Low -- the pre-2026-09-02 bug, where the 8 IB_HIGH_*/IB_LOW_*/PD_IB_HIGH_*/PD_IB_LOW_* setup types were invalidated against a narrower Opening Range boundary instead of their own Initial Balance level) vs the NEW boundary (IB High/Low, the fix shipped 2026-09-02) across all N=${results.length} real (ACTIVE/SHADOW) historical trades of these 8 types. OLD total=$${oldTotal.toFixed(2)}, NEW total=$${newTotal.toFixed(2)}, DELTA=$${delta.toFixed(2)} across ${changedRows.length} trades whose outcome actually changed. Rigor on the delta: ${JSON.stringify(rigor)}.`,
    sourceFile: 'scripts/backtest_ib_high_low_invalidation_boundary_fix.mjs',
    sourceDate: runDate,
    sampleSize: results.length,
    winRate: null,
    evPerTrade: results.length ? delta / results.length : null,
    rigorStatus: rigor.clean === true ? 'clean' : rigor.clean === false ? 'unstable_or_clustered' : 'too_thin',
    status: 'PROVISIONAL',
  });

  console.log(`\n[backtest_ib_invalidation_fix] Persisted performance_audit + RESEARCH_CLAIM ib_high_low_invalidation_boundary_fix_walk_forward`);
  await pool.end();
}

run().catch(e => { console.error('[backtest_ib_invalidation_fix] ERROR:', e.message, e.stack); process.exit(1); });
