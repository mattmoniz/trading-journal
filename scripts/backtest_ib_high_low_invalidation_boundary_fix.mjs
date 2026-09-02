/**
 * Walk-forward comparison: OR-High/Low invalidation boundary (old, buggy) vs the corrected
 * level-specific invalidation boundary (new, fixed 2026-09-02) for the 8 IB_HIGH, IB_LOW,
 * PD_IB_HIGH, PD_IB_LOW setup types.
 *
 * Context: structurallyInvalidateSetups() (server/routes/acd.js) used to kill a SHORT setup
 * the instant price closed above the day's Opening Range High (a 5-30min level), and a LONG
 * setup the instant price closed below OR Low. But these 8 setup types fade the Initial
 * Balance high/low (today's, for IB_HIGH/IB_LOW; PRIOR DAY's, for PD_IB_HIGH/PD_IB_LOW -- two
 * genuinely different levels), which is virtually always outside the narrower OR -- so entries
 * were routinely born already past their own kill-switch trigger.
 *
 * CORRECTED 2026-09-02 (DeepSeek code review of the first version of both the fix and this
 * script, self-verified against compute_levels.js/acd.js before accepting): the first version
 * got 2 of 8 types right (IB_HIGH_FADE_SHORT, IB_LOW_FADE_LONG) but was wrong for the other 6
 * two different ways -- (a) it recomputed TODAY's IB for the 4 PD_IB_* types instead of
 * reading their real PRIOR-DAY level from level_prices (the same source acd.js's own live
 * fire path reads, lp.PD_IB_HIGH/lp.PD_IB_LOW), and (b) it picked the boundary by DIRECTION
 * only (SHORT->high, LONG->low), but IB_HIGH/IB_LOW can each fire as either direction
 * depending on which side price approached from (approachDir), so IB_HIGH_FADE_LONG (defends
 * IB High as support) and IB_LOW_FADE_SHORT (defends IB Low as resistance) got the OPPOSITE,
 * effectively-unreachable-same-session extreme -- which is why they showed exactly $0 delta:
 * a symptom of the bug, not "no effect." Both fixed here: resolve the correct LEVEL first
 * (by setup_type name: which level, and today's-vs-prior-day), independent of direction, then
 * apply the universal rule SHORT invalidates above its level / LONG below.
 *
 * This script answers "how much would that have changed P&L" via a clean, deterministic
 * bar-by-bar re-walk of EVERY real (ACTIVE/SHADOW) historical trade of these 8 types -- not
 * just the ones that happened to get caught by the live poller (which depends on server
 * uptime/poll timing noise, not the logic itself). Two walks per trade, identical except for
 * which boundary triggers invalidation:
 *   OLD: invalidate SHORT when bar close > OR High; LONG when bar close < OR Low.
 *   NEW: invalidate SHORT when bar close > its own level; LONG when bar close < its own level.
 * Stop/target-hit priority within a bar mirrors server/services/maeMfeReplay.js's
 * replayBars() convention (same-bar stop+target conflict = stop wins, checked before the
 * invalidation close-check) -- reused import, not reimplemented, for the actual stop/target
 * arithmetic; the invalidation-boundary layer is new since replayBars() has no such concept.
 * Per DeepSeek's audit (Q4): "stop wins" is applied identically to both arms, so it cannot
 * bias the OLD-vs-NEW delta direction -- it only makes the reported delta mildly conservative.
 *
 * No lookahead: entry/stop/t1/fired_at are the setup's own real, already-fixed values (never
 * recomputed). Today's IB high/low for IB_HIGH_FADE and IB_LOW_FADE types is the FINAL
 * 9:30-10:29 ET range -- always already fully formed by the time those 4 types can fire (gate
 * 630/10:30 ET). Prior-day IB for the PD_IB_HIGH_FADE/PD_IB_LOW_FADE types (gate 570/9:30 ET, confirmed via
 * scripts/repair_ib_dependent_window_mismatch.mjs) is read from level_prices, which is
 * populated by an early-morning cron before either of these types can ever fire -- also not
 * lookahead. Bars are walked strictly forward from fired_at, session-bounded by the trade's
 * own real expires_at, sanity-floored to 16:00 ET same day if expires_at is missing OR
 * earlier than fired_at (a known stale-data issue this codebase has hit before -- an early/
 * bad expires_at would truncate the walk and asymmetrically cost the NEW arm, which is the one
 * more likely to ride to a later real target instead of an early premature invalidation).
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
// `level` is a single boundary (not a high/low pair) -- SHORT invalidates above it, LONG below
// it, correct regardless of which side price approached the level from.
function walk(bars, entry, stop, t1, direction, level) {
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
    const invalidated = direction === 'SHORT' ? bar.close > level : bar.close < level;
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
           expires_at::text as expires_at, origin_status,
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
  const pdIbCache = new Map();
  async function getOr(tradeDate) {
    if (!orCache.has(tradeDate)) {
      const r = await query(`SELECT or_high::float, or_low::float FROM acd_daily_log WHERE trade_date=$1`, [tradeDate]);
      orCache.set(tradeDate, r.rows[0] || { or_high: null, or_low: null });
    }
    return orCache.get(tradeDate);
  }
  // Today's IB (for IB_HIGH_FADE_*/IB_LOW_FADE_*) -- unchanged from the first version.
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
  // Prior-day IB (for PD_IB_HIGH_FADE_*/PD_IB_LOW_FADE_*) -- read from level_prices, the SAME
  // source acd.js's own live fire path reads (lp.PD_IB_HIGH/lp.PD_IB_LOW), not recomputed here.
  async function getPdIb(tradeDate) {
    if (!pdIbCache.has(tradeDate)) {
      const r = await query(`SELECT level_name, price::float FROM level_prices WHERE trade_date=$1 AND level_name IN ('PD_IB_HIGH','PD_IB_LOW')`, [tradeDate]);
      const high = r.rows.find(x => x.level_name === 'PD_IB_HIGH')?.price ?? null;
      const low  = r.rows.find(x => x.level_name === 'PD_IB_LOW')?.price ?? null;
      pdIbCache.set(tradeDate, { pd_ib_high: high, pd_ib_low: low });
    }
    return pdIbCache.get(tradeDate);
  }

  const results = [];
  let staleExpiresCount = 0;
  for (const c of candidates) {
    const direction = resolveDirection(c);
    if (!direction) { console.error(`[skip] id=${c.id} null direction`); continue; }
    const entry = c.entry_zone_high ?? c.entry_zone_low;

    const [or, ib, pdIb] = await Promise.all([getOr(c.trade_date), getIb(c.trade_date), getPdIb(c.trade_date)]);
    if (or.or_high == null || or.or_low == null) { console.error(`[skip] id=${c.id} no OR data`); continue; }

    // Resolve the correct LEVEL by setup_type name, independent of direction (DeepSeek review
    // finding: IB_HIGH/IB_LOW can each fire as either direction depending on approach side, so
    // a direction-only high/low pick is wrong for the "reversal" pairing).
    const isPriorDay = c.setup_type.startsWith('PD_IB_');
    const isHighLevel = c.setup_type.includes('IB_HIGH');
    const realLevel = isPriorDay
      ? (isHighLevel ? pdIb.pd_ib_high : pdIb.pd_ib_low)
      : (isHighLevel ? ib.ib_high : ib.ib_low);
    if (realLevel == null) { console.error(`[skip] id=${c.id} ${c.setup_type} no real level data (${isPriorDay ? 'prior-day IB missing from level_prices' : 'today IB not yet formed'})`); continue; }
    const orLevel = isHighLevel ? or.or_high : or.or_low;

    // Session boundary: real expires_at if present AND sane (not before fired_at -- a known
    // stale-data issue), else 16:00 ET same day.
    let upperBoundTs = `${c.trade_date} 16:00:00`;
    if (c.expires_at) {
      if (c.expires_at > c.fired_at) upperBoundTs = c.expires_at;
      else staleExpiresCount++;
    }
    const { rows: bars } = await query(`
      SELECT ts::text as ts, high::float, low::float, close::float
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts > $1 AND ts <= $2
      ORDER BY ts
    `, [c.fired_at, upperBoundTs]);

    const oldWalk = walk(bars, entry, c.stop_level, c.t1_level, direction, orLevel);
    const newWalk = walk(bars, entry, c.stop_level, c.t1_level, direction, realLevel);

    results.push({
      id: c.id, trade_date: c.trade_date, setup_type: c.setup_type, direction, fired_at: c.fired_at,
      origin_status: c.origin_status,
      historical_actual_pnl: c.historical_actual_pnl, historical_resolution: c.historical_resolution,
      old: oldWalk, new: newWalk, changed: oldWalk.outcome !== newWalk.outcome || oldWalk.pnl !== newWalk.pnl,
    });
  }
  console.log(`[backtest_ib_invalidation_fix] ${staleExpiresCount} rows had stale/missing expires_at, floored to 16:00 ET`);

  console.log(`[backtest_ib_invalidation_fix] Replayed ${results.length}/${candidates.length}`);

  const oldTotal = results.reduce((s, r) => s + (r.old.pnl ?? 0), 0);
  const newTotal = results.reduce((s, r) => s + (r.new.pnl ?? 0), 0);
  const delta = newTotal - oldTotal;
  const changedRows = results.filter(r => r.changed);

  console.log(`\n=== AGGREGATE (N=${results.length}) -- a mechanism-correctness counterfactual, NOT account P&L (pooled real+SHADOW) ===`);
  console.log(`OLD rule (OR-boundary, matches pre-fix live behavior) total: $${oldTotal.toFixed(2)}`);
  console.log(`NEW rule (own-level boundary, the corrected fix) total: $${newTotal.toFixed(2)}`);
  console.log(`DELTA: $${delta.toFixed(2)} across ${changedRows.length} trades whose outcome changed`);

  console.log(`\n=== REAL (ACTIVE) vs SHADOW split (DeepSeek Q1) ===`);
  for (const os of ['ACTIVE', 'SHADOW']) {
    const rows = results.filter(r => r.origin_status === os);
    const o = rows.reduce((s, r) => s + (r.old.pnl ?? 0), 0);
    const n = rows.reduce((s, r) => s + (r.new.pnl ?? 0), 0);
    console.log(`  ${os}: N=${rows.length} OLD=$${o.toFixed(2)} NEW=$${n.toFixed(2)} delta=$${(n - o).toFixed(2)}`);
  }

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
  const activeOnly = results.filter(r => r.origin_status === 'ACTIVE');
  const activeOldTotal = activeOnly.reduce((s, r) => s + (r.old.pnl ?? 0), 0);
  const activeNewTotal = activeOnly.reduce((s, r) => s + (r.new.pnl ?? 0), 0);
  const notes = {
    method: 'clean bar-by-bar re-walk (both scenarios) with the DeepSeek-corrected per-type level resolution (today IB for IB_HIGH/IB_LOW types, prior-day IB via level_prices for PD_IB_HIGH/PD_IB_LOW types, independent of direction) -- not a replay of what the live poller actually caught, and not account P&L (real+SHADOW pooled)',
    n_total: results.length, n_changed: changedRows.length,
    n_stale_expires_floored: staleExpiresCount,
    old_total: +oldTotal.toFixed(2), new_total: +newTotal.toFixed(2), delta: +delta.toFixed(2),
    active_only: { n: activeOnly.length, old_total: +activeOldTotal.toFixed(2), new_total: +activeNewTotal.toFixed(2), delta: +(activeNewTotal - activeOldTotal).toFixed(2) },
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
    claimText: `CORRECTED 2026-09-02 (DeepSeek code review caught 2 real bugs in the first version, both fixed and re-run): walk-forward re-simulation (clean bar-by-bar re-walk, not a replay of live-poller-caught outcomes) comparing the OLD structural-invalidation boundary (OR High/Low -- the pre-2026-09-02 bug) vs the CORRECTED per-type-level boundary (today's IB for IB_HIGH_FADE_*/IB_LOW_FADE_*; PRIOR-DAY IB via level_prices for PD_IB_HIGH_FADE_*/PD_IB_LOW_FADE_* -- the first version wrongly used today's IB for these; resolved by LEVEL NAME independent of direction, since IB_HIGH/IB_LOW can each fire as either direction depending on approach side -- the first version's direction-only pick was wrong for IB_HIGH_FADE_LONG/IB_LOW_FADE_SHORT) across all N=${results.length} real (ACTIVE/SHADOW pooled -- a mechanism-correctness counterfactual, NOT account P&L) historical trades of these 8 types. OLD total=$${oldTotal.toFixed(2)}, NEW total=$${newTotal.toFixed(2)}, DELTA=$${delta.toFixed(2)} across ${changedRows.length} trades whose outcome actually changed. ACTIVE-only (the 2 types that motivated this fix and are actually live): N=${activeOnly.length}, delta=$${(activeNewTotal - activeOldTotal).toFixed(2)}. Rigor on the pooled delta: ${JSON.stringify(rigor)}.`,
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
