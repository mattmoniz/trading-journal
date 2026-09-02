/**
 * Walk-forward comparison: OR-High/Low invalidation boundary (old, live) vs the CORRECTED
 * wider-of-two boundary (new) for the 7 additional fade families identified in
 * docs/ROSTER_WIDE_INVALIDATION_BOUNDARY_WHITELIST_SPEC.md as sharing the same underlying bug
 * shape as the already-shipped IB_HIGH/IB_LOW/PD_IB_HIGH/PD_IB_LOW fix
 * (scripts/backtest_ib_high_low_invalidation_boundary_fix.mjs, commit before this one).
 *
 * REDESIGNED 2026-09-02 (DeepSeek follow-up critique, round 2, after the first version's
 * unconditional own-level replacement was found to *tighten* the invalidation trigger for
 * several families/directions, destroying ~$770 of real TARGET_HIT winners across 7 trades --
 * see scratch/deepseek_response.md). The corrected rule is NOT "always use the own level" --
 * it's "never use a boundary looser than what's currently live, only ever relax it":
 *   SHORT: effectiveBoundary = Math.max(orHigh, ownLevel)  -- never invalidates earlier than
 *          today's live orHigh-based rule, only ever later (when ownLevel is wider).
 *   LONG:  effectiveBoundary = Math.min(orLow,  ownLevel)  -- symmetric.
 * This weakly dominates a per-family whitelist in the only sense that matters for live-risk
 * code: it can never introduce a per-trade REGRESSION vs. today's live behavior (it only ever
 * relaxes, on a trade-by-trade basis, never tightens) -- NOT per-trade P&L dominance, which
 * DeepSeek explicitly flagged as a non-sequitur (a relaxation can defer an early partial-loss
 * invalidation into a later full-stop loss on some individual trades; the aggregate/family-level
 * numbers below are the actual evidence, not the never-tighter property itself).
 *
 * Families covered (matched by setup_type PREFIX so TRAIL/GAP_UP/GAP_DOWN/OVERNIGHT suffix
 * variants are all included automatically, same lesson as the sibling-reversal gate bug this
 * session already found and fixed -- see docs/OPEN_THREADS.md's 2026-09-02 "sibling reversal"
 * entry):
 *   PD_VAH_FADE*, PD_VAL_FADE*, PD_POC_FADE*   -- level_prices.PD_VAH/PD_VAL/PD_POC
 *   PW_VAH_FADE*, PW_VAL_FADE*, PW_POC_FADE*   -- level_prices.PW_VAH/PW_VAL/PW_POC
 *   IB_MID_SCALP_FADE*                          -- (today's ib_high+ib_low)/2, same source as
 *                                                   the shipped IB fix's getIb()
 *   FLOOR_R1_FADE*                               -- level_prices.FLOOR_R1
 *   CAM_S2_FADE*                                 -- level_prices.CAM_S2
 *   ONH_FADE*, ONL_FADE*                          -- level_prices.ONH/ONL (both included
 *                                                   unconditionally -- DeepSeek confirmed the
 *                                                   worst case under wider-of-two is neutral,
 *                                                   not an untested tightening)
 *   PD_IB_MID_FADE*                              -- level_prices.PD_IB_MID (confirmed by
 *                                                   DeepSeek to belong in THIS group, not the
 *                                                   shipped IB fix -- MID was never in that
 *                                                   fix's scope, and has no natural high/low OR
 *                                                   side, exactly the case wider-of-two handles)
 *
 * Fallback semantics (spec's open question #1, now MOOT per DeepSeek): a missing own level
 * collapses to the OR boundary automatically (max(orHigh,orHigh)=orHigh), so there is no
 * separate fallback-vs-skip fork to design -- "missing level" and "never fixed" produce the
 * identical result by construction.
 *
 * Same methodology as the shipped IB-fix backtest: clean bar-by-bar re-walk of every real
 * (ACTIVE/SHADOW) historical trade of these families -- not a replay of what the live poller
 * happened to catch. Two walks per trade, identical except which boundary triggers invalidation.
 * Stop/target-hit priority mirrors maeMfeReplay.js's replayBars() convention (same-bar
 * stop+target conflict = stop wins, checked before the invalidation close-check), applied
 * identically to both arms so it cannot bias the delta direction.
 *
 * No lookahead: entry/stop/t1/fired_at are the setup's own real values. level_prices rows are
 * populated by an early-morning cron (compute_levels.js) well before any of these setup types
 * can fire. Today's IB (for IB_MID_SCALP_FADE*) is the final 9:30-10:29 ET range, already fully
 * formed by IB_MID_SCALP's own live fire gate (etMinNow >= 630, same convention CLAUDE.md
 * documents for the other IB-specific levels).
 *
 * Run: node scripts/backtest_roster_wide_invalidation_boundary_fix.mjs
 */

import { query } from '../server/db.js';
import pool from '../server/db.js';
import { resolveDirection } from '../server/config/setupTypes.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

// signal_type is VARCHAR(30) (verified against server/schema.sql directly -- CLAUDE.md's
// "VARCHAR(20)" hard-rule text is itself stale, per the project's own standing rule that a
// comment/doc claiming a width is not verification; the real column is 30 chars).
const SIGNAL_TYPE = 'ROSTER_INVALID_BOUNDARY_FIX';
const PPP = LIVE_INSTRUMENT.dollarsPerPoint;
const COMM = LIVE_INSTRUMENT.commissionPerRoundTrip;

const FAMILY_PREFIXES = [
  'PD_VAH_FADE', 'PD_VAL_FADE', 'PD_POC_FADE',
  'PW_VAH_FADE', 'PW_VAL_FADE', 'PW_POC_FADE',
  'IB_MID_SCALP_FADE', 'FLOOR_R1_FADE', 'CAM_S2_FADE',
  'ONH_FADE', 'ONL_FADE', 'PD_IB_MID_FADE',
];

// Resolves the correct fade level by setup_type PREFIX (independent of direction and of any
// TRAIL/GAP_UP/GAP_DOWN/OVERNIGHT suffix) -- mirrors the spec's resolveExtendedFadeLevel()
// sketch exactly, using startsWith against the un-stripped setup_type so every suffix variant
// (not just the ones this codebase happens to have real data for today) is covered.
function resolveExtendedFadeLevel(setupType, lp, ibHigh, ibLow) {
  if (setupType.startsWith('PD_VAH_FADE'))       return lp.PD_VAH ?? null;
  if (setupType.startsWith('PD_VAL_FADE'))       return lp.PD_VAL ?? null;
  if (setupType.startsWith('PD_POC_FADE'))       return lp.PD_POC ?? null;
  if (setupType.startsWith('PW_VAH_FADE'))       return lp.PW_VAH ?? null;
  if (setupType.startsWith('PW_VAL_FADE'))       return lp.PW_VAL ?? null;
  if (setupType.startsWith('PW_POC_FADE'))       return lp.PW_POC ?? null;
  if (setupType.startsWith('IB_MID_SCALP_FADE')) return (ibHigh != null && ibLow != null) ? (ibHigh + ibLow) / 2 : null;
  if (setupType.startsWith('FLOOR_R1_FADE'))     return lp.FLOOR_R1 ?? null;
  if (setupType.startsWith('CAM_S2_FADE'))       return lp.CAM_S2 ?? null;
  if (setupType.startsWith('ONH_FADE'))          return lp.ONH ?? null;
  if (setupType.startsWith('ONL_FADE'))          return lp.ONL ?? null;
  if (setupType.startsWith('PD_IB_MID_FADE'))    return lp.PD_IB_MID ?? null;
  return null;
}

// Identical shape to the shipped IB-fix backtest's walk() -- single boundary, SHORT invalidates
// above it / LONG below it, stop/target checked first (stop wins on same-bar conflict).
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
  console.log(`[backtest_roster_wide_invalidation_fix] Building population...`);
  const prefixRegex = '^(' + FAMILY_PREFIXES.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
  const { rows: candidates } = await query(`
    SELECT id, trade_date::text as trade_date, setup_type, fired_at::text as fired_at,
           expires_at::text as expires_at, origin_status,
           entry_zone_high::float as entry_zone_high, entry_zone_low::float as entry_zone_low,
           stop_level::float as stop_level, t1_level::float as t1_level,
           actual_pnl::float as historical_actual_pnl, resolution as historical_resolution
    FROM active_setups
    WHERE setup_type ~ $1
      AND origin_status IN ('ACTIVE','SHADOW')
      AND stop_level IS NOT NULL AND t1_level IS NOT NULL
      AND (entry_zone_high IS NOT NULL OR entry_zone_low IS NOT NULL)
    ORDER BY fired_at
  `, [prefixRegex]);
  console.log(`[backtest_roster_wide_invalidation_fix] N=${candidates.length} real candidates`);

  const orCache = new Map();
  const ibCache = new Map();
  const lpCache = new Map();
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
  async function getLevelPrices(tradeDate) {
    if (!lpCache.has(tradeDate)) {
      const r = await query(`
        SELECT level_name, price::float FROM level_prices WHERE trade_date=$1
          AND level_name IN ('PD_VAH','PD_VAL','PD_POC','PW_VAH','PW_VAL','PW_POC','FLOOR_R1','CAM_S2','ONH','ONL','PD_IB_MID')
      `, [tradeDate]);
      const lp = {};
      for (const row of r.rows) lp[row.level_name] = row.price;
      lpCache.set(tradeDate, lp);
    }
    return lpCache.get(tradeDate);
  }

  const results = [];
  let staleExpiresCount = 0;
  let fallbackToOrCount = 0;
  for (const c of candidates) {
    const direction = resolveDirection(c);
    if (!direction) { console.error(`[skip] id=${c.id} null direction`); continue; }
    const entry = c.entry_zone_high ?? c.entry_zone_low;

    const [or, ib, lp] = await Promise.all([getOr(c.trade_date), getIb(c.trade_date), getLevelPrices(c.trade_date)]);
    if (or.or_high == null || or.or_low == null) { console.error(`[skip] id=${c.id} no OR data`); continue; }

    const realLevel = resolveExtendedFadeLevel(c.setup_type, lp, ib.ib_high, ib.ib_low);
    if (realLevel == null) fallbackToOrCount++;
    // CORRECTED 2026-09-02 (DeepSeek follow-up critique, round 2): the first version of this
    // script unconditionally replaced the OR boundary with the own level, which DeepSeek's
    // own audit found *tightens* the invalidation trigger (vs. today's live OR-boundary rule)
    // for several families/directions -- destroying ~$770 of real TARGET_HIT winners across 7
    // trades (id=37888/58642/85868/106138/106185/109429/109435), because for these families
    // the own level is NOT always structurally wider than the OR the way IB High/Low is. The
    // corrected rule: SHORT never uses a boundary looser than orHigh (max), LONG never looser
    // than orLow (min) -- i.e. only ever RELAX the live rule, never tighten it. A missing own
    // level collapses to the OR boundary automatically (max(orHigh,orHigh)=orHigh), so there's
    // no separate fallback fork needed anymore.
    const effectiveNewLevel = direction === 'SHORT'
      ? Math.max(or.or_high, realLevel ?? or.or_high)
      : Math.min(or.or_low,  realLevel ?? or.or_low);

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

    const oldOrLevel = direction === 'SHORT' ? or.or_high : or.or_low;
    const oldWalk = walk(bars, entry, c.stop_level, c.t1_level, direction, oldOrLevel);
    const newWalk = walk(bars, entry, c.stop_level, c.t1_level, direction, effectiveNewLevel);

    results.push({
      id: c.id, trade_date: c.trade_date, setup_type: c.setup_type, direction, fired_at: c.fired_at,
      origin_status: c.origin_status, usedOrFallback: realLevel == null,
      historical_actual_pnl: c.historical_actual_pnl, historical_resolution: c.historical_resolution,
      old: oldWalk, new: newWalk, changed: oldWalk.outcome !== newWalk.outcome || oldWalk.pnl !== newWalk.pnl,
    });
  }
  console.log(`[backtest_roster_wide_invalidation_fix] ${staleExpiresCount} rows had stale/missing expires_at, floored to 16:00 ET`);
  console.log(`[backtest_roster_wide_invalidation_fix] ${fallbackToOrCount} rows had no named level for their trade_date, fell back to OR boundary in the NEW arm`);
  console.log(`[backtest_roster_wide_invalidation_fix] Replayed ${results.length}/${candidates.length}`);

  const oldTotal = results.reduce((s, r) => s + (r.old.pnl ?? 0), 0);
  const newTotal = results.reduce((s, r) => s + (r.new.pnl ?? 0), 0);
  const delta = newTotal - oldTotal;
  const changedRows = results.filter(r => r.changed);

  console.log(`\n=== AGGREGATE (N=${results.length}) -- a mechanism-correctness counterfactual, NOT account P&L (pooled real+SHADOW) ===`);
  console.log(`OLD rule (OR-boundary, matches pre-fix live behavior) total: $${oldTotal.toFixed(2)}`);
  console.log(`NEW rule (own-level boundary, proposed fix) total: $${newTotal.toFixed(2)}`);
  console.log(`DELTA: $${delta.toFixed(2)} across ${changedRows.length} trades whose outcome changed`);

  console.log(`\n=== REAL (ACTIVE) vs SHADOW split ===`);
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

  console.log(`\n=== PER-FAMILY (setup_type prefix, direction-agnostic) ===`);
  const byFamily = new Map();
  for (const r of results) {
    const fam = FAMILY_PREFIXES.find(p => r.setup_type.startsWith(p)) || 'UNKNOWN';
    if (!byFamily.has(fam)) byFamily.set(fam, []);
    byFamily.get(fam).push(r);
  }
  for (const [fam, rows] of byFamily) {
    const o = rows.reduce((s, r) => s + (r.old.pnl ?? 0), 0);
    const n = rows.reduce((s, r) => s + (r.new.pnl ?? 0), 0);
    const nRealActive = rows.filter(r => r.origin_status === 'ACTIVE').length;
    console.log(`  ${fam.padEnd(20)} N=${rows.length} (real ACTIVE=${nRealActive}) OLD=$${o.toFixed(2)} NEW=$${n.toFixed(2)} delta=$${(n - o).toFixed(2)}`);
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
    console.log(`  ${type.padEnd(28)} N=${rows.length} OLD=$${o.toFixed(2)} NEW=$${n.toFixed(2)} delta=$${(n - o).toFixed(2)}`);
  }

  console.log(`\n=== CHANGED TRADES (${changedRows.length}) ===`);
  for (const r of changedRows) {
    console.log(`  id=${r.id} ${r.setup_type} ${r.trade_date} ${r.direction} fired=${r.fired_at} | OLD: ${r.old.outcome} $${r.old.pnl?.toFixed(2)} | NEW: ${r.new.outcome} $${r.new.pnl?.toFixed(2)} | orFallback=${r.usedOrFallback} | historical actual_pnl was $${r.historical_actual_pnl ?? 'n/a'} (${r.historical_resolution ?? 'n/a'})`);
  }

  const deltaEvents = changedRows.map(r => ({ date: r.trade_date, contribution: (r.new.pnl ?? 0) - (r.old.pnl ?? 0) }));
  const rigor = computeRigor(deltaEvents, { dateField: 'date', pnlFn: e => e.contribution });
  console.log(`\n=== RIGOR ON DELTA (N=${deltaEvents.length}) ===`);
  console.log(JSON.stringify(rigor, null, 2));

  const runDate = (await query(`SELECT CURRENT_DATE::text as today`)).rows[0].today;
  const activeOnly = results.filter(r => r.origin_status === 'ACTIVE');
  const activeOldTotal = activeOnly.reduce((s, r) => s + (r.old.pnl ?? 0), 0);
  const activeNewTotal = activeOnly.reduce((s, r) => s + (r.new.pnl ?? 0), 0);
  const notes = {
    method: 'clean bar-by-bar re-walk (both scenarios); NEW arm uses the wider-of-two boundary (SHORT: max(orHigh, ownLevel), LONG: min(orLow, ownLevel)) -- never tighter than the live OR rule, only ever relaxed when the own level (resolved by setup_type PREFIX, covers TRAIL/GAP_UP/GAP_DOWN/OVERNIGHT variants) is genuinely wider; a missing own level collapses to the OR boundary automatically -- not a replay of what the live poller actually caught, and not account P&L (real+SHADOW pooled)',
    n_total: results.length, n_changed: changedRows.length,
    n_stale_expires_floored: staleExpiresCount, n_or_fallback: fallbackToOrCount,
    old_total: +oldTotal.toFixed(2), new_total: +newTotal.toFixed(2), delta: +delta.toFixed(2),
    active_only: { n: activeOnly.length, old_total: +activeOldTotal.toFixed(2), new_total: +activeNewTotal.toFixed(2), delta: +(activeNewTotal - activeOldTotal).toFixed(2) },
    by_family: Object.fromEntries([...byFamily.entries()].map(([fam, rows]) => {
      const o = rows.reduce((s, r) => s + (r.old.pnl ?? 0), 0);
      const n = rows.reduce((s, r) => s + (r.new.pnl ?? 0), 0);
      return [fam, { n: rows.length, old_total: +o.toFixed(2), new_total: +n.toFixed(2), delta: +(n - o).toFixed(2) }];
    })),
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
    slug: 'roster_wide_invalidation_boundary_fix_walk_forward',
    claimText: `Walk-forward re-simulation (clean bar-by-bar re-walk, not a replay of live-poller-caught outcomes) comparing the OLD structural-invalidation boundary (OR High/Low, today's live rule) vs the wider-of-two boundary (SHORT: max(orHigh, ownLevel); LONG: min(orLow, ownLevel) -- never tighter than live, only ever relaxed; DeepSeek-corrected 2026-09-02 after a first version's unconditional own-level replacement was found to tighten and destroy ~$770 of real winners) for 7 additional fade families (PD_VAH/PD_VAL/PD_POC, PW_VAH/PW_VAL/PW_POC, IB_MID_SCALP, FLOOR_R1, CAM_S2, ONH/ONL, PD_IB_MID) across N=${results.length} real (ACTIVE/SHADOW pooled -- a mechanism-correctness counterfactual, NOT account P&L) historical trades. OLD total=$${oldTotal.toFixed(2)}, NEW total=$${newTotal.toFixed(2)}, DELTA=$${delta.toFixed(2)} across ${changedRows.length} trades whose outcome actually changed. ACTIVE-only: N=${activeOnly.length}, delta=$${(activeNewTotal - activeOldTotal).toFixed(2)}. ${fallbackToOrCount} rows had no named level for their trade_date (collapses to the OR boundary automatically, no separate fallback fork). Rigor on the pooled delta: ${JSON.stringify(rigor)}. DeepSeek's IB_HIGH/IB_LOW retro-fit finding (deferred, separate follow-up): the wider-of-two rule is a no-op for 4 of the 8 already-shipped IB types (the primary pairings) but would REVERT the other 4 (the reversal pairings, e.g. IB_HIGH_FADE_LONG) from a tightening back to the OR boundary -- not touched in this change, needs its own IB backtest re-run + decision.`,
    sourceFile: 'scripts/backtest_roster_wide_invalidation_boundary_fix.mjs',
    sourceDate: runDate,
    sampleSize: results.length,
    winRate: null,
    evPerTrade: results.length ? delta / results.length : null,
    rigorStatus: rigor.clean === true ? 'clean' : rigor.clean === false ? 'unstable_or_clustered' : 'too_thin',
    status: 'PROVISIONAL',
  });

  console.log(`\n[backtest_roster_wide_invalidation_fix] Persisted performance_audit + RESEARCH_CLAIM roster_wide_invalidation_boundary_fix_walk_forward`);
  await pool.end();
}

run().catch(e => { console.error('[backtest_roster_wide_invalidation_fix] ERROR:', e.message, e.stack); process.exit(1); });
