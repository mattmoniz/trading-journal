// Setup lifecycle cleanup: expiry (time-based) and structural invalidation (price-based).
// Extracted from server/routes/acd.js 2026-09-05 (DeepSeek-planned extraction, Candidate D --
// see docs/OPEN_THREADS.md's 2026-09-05 entry and OPEN_DECISION
// acdjs_deferred_cleanup_from_deepseek_audit_20260905). Pure relocation, behavior-identical --
// verified line-for-line before moving. Both functions are called together on every
// setup-detection poll (server/routes/acd.js) and are also imported directly by
// server/index.js's own 30-min self-healing cron.

import { query } from '../db.js';
import { LIVE_INSTRUMENT } from '../config/instruments.js';
import { resolveDirection } from '../config/setupTypes.js';
import { dropToTimeline } from './acdShared.js';

// Expires any ACTIVE/SHADOW setups past their expires_at; emits socket events.
export async function expireStaleSetups(io) {
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  // FIXED 2026-07-17 (Opus Audit #3): this used to unconditionally DELETE every prior-day
  // SHADOW row, regardless of whether it had real entry/stop/target that just hadn't been
  // given a chance to resolve to a terminal state -- a second, silent data-destruction point
  // alongside the resolution UPDATEs overwriting `status`. A SHADOW row's real forward
  // outcome (did the suppression decision that created it turn out to be right?) is exactly
  // the data a closed-loop validation needs, and this was destroying it with zero trace.
  // Fixed: SHADOW rows with real levels now go through the SAME expire-to-EXPIRED path as
  // ACTIVE rows below (origin_status, added the same day, survives untouched since this
  // UPDATE never references it). Only rows with no expires_at at all (the CASCADE_BREAKER /
  // suppressed-near-level-audit inserts, which log a suppressed level touch as evidence with
  // no entry/stop/target to resolve against -- genuinely un-scoreable) get a terminal mark
  // instead of physical deletion, per Opus's "prefer a terminal state over delete" recommendation.
  const abandoned = await query(`
    UPDATE active_setups
    SET status = 'EXPIRED', resolution = 'NO_EXPIRY_SET', resolved_at = NOW(), updated_at = NOW()
    WHERE status = 'SHADOW' AND trade_date < $1 AND expires_at IS NULL
    RETURNING id
  `, [todayET]);

  // This is the backstop for whatever resolveSetupsByPrice()'s own mark-to-market
  // (added 2026-07-20, see the comment there) couldn't reach: rows with no entry/stop/t1
  // to walk against, or genuinely zero price_bars_primary rows since fired_at. Those are
  // rare, but "rare" isn't the same as "leave actual_pnl null forever" -- fall back to the
  // single most recent known close (same live-price lookup ABSORPTION_LONG/COIL_SURGE
  // already use above) rather than a blunt no-pnl status flip. Only genuinely un-scoreable
  // rows (no entry price recorded, or no price data has EVER arrived) stay null.
  // stop_level/t1_level added 2026-08-17 (OPEN_DECISION islongsetup_gap_variant_direction_bug)
  // -- resolveDirection() below needs both for its price-derived direction fallback; this
  // SELECT previously omitted them entirely, so the fallback silently never ran here.
  const candidates = await query(`
    SELECT id, setup_type, trade_date::text as trade_date, entry_zone_low, entry_zone_high,
           stop_level, t1_level
    FROM active_setups
    WHERE status IN ('ACTIVE', 'SHADOW') AND expires_at IS NOT NULL AND expires_at < NOW()
  `);
  let lastKnownClose = null;
  if (candidates.rows.length) {
    const pxRow = await query(`SELECT close::float as close FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts DESC LIMIT 1`);
    lastKnownClose = pxRow.rows[0]?.close ?? null;
  }
  const expiredRows = [];
  for (const row of candidates.rows) {
    // Null direction (name/price disagreement, or missing price levels) leaves pnl null --
    // resolution_method below already falls to 'NO_PRICE_DATA' for a null pnl, the existing
    // convention for un-scoreable rows here. No separate logging needed at this call site:
    // the main resolveSetupsByPrice() loop already logs every disagreement loudly when it
    // first encounters the row; this backstop just inherits the same null outcome.
    const direction = resolveDirection(row);
    const entry = row.entry_zone_high ?? row.entry_zone_low;
    let pnl = null;
    if (direction != null && lastKnownClose != null && entry != null) {
      const long = direction === 'LONG';
      pnl = Math.round(((long ? (lastKnownClose - entry) : (entry - lastKnownClose))
        * LIVE_INSTRUMENT.dollarsPerPoint - LIVE_INSTRUMENT.commissionPerRoundTrip) * 100) / 100;
    }
    const upd = await query(`
      UPDATE active_setups
      SET status='EXPIRED', resolution='TIME_EXPIRED', resolution_method=$2, actual_outcome='TIME_EXPIRED',
          actual_pnl=$3, price_at_resolution=$4, resolved_at=NOW(), updated_at=NOW()
      WHERE id=$1
      RETURNING *
    `, [row.id, pnl != null ? 'MARK_TO_MARKET' : 'NO_PRICE_DATA', pnl, pnl != null ? lastKnownClose : null]);
    if (upd.rows[0]) expiredRows.push(upd.rows[0]);
  }
  for (const row of expiredRows) {
    try { await dropToTimeline(row); } catch (_) {}
    if (io) io.emit('setup-expired', { setupId: row.id, setupType: row.setup_type, tradeDate: row.trade_date });
  }
  return expiredRows.length + abandoned.rows.length;
}

// Structural invalidation: expire SHORT setups when price > OR High, LONG when price < OR Low.
// Called alongside expireStaleSetups on every setup-detection poll.
//
// IB_HIGH/IB_LOW exception (found live 2026-09-02, user flagged 3x same-morning
// IB_HIGH_FADE_SHORT "inv." fires on quick-check.html): the 8 IB_HIGH_*/IB_LOW_*/
// PD_IB_HIGH_*/PD_IB_LOW_* setup types fade the 60-min Initial Balance high/low, which is
// virtually always outside the much narrower Opening Range (OR forms in the first ~5-30min,
// IB in the first 60) -- confirmed live that day: OR High 29102.75 vs IB High 29193, with
// price never once closing back at/below OR High between 10:15am-1:10pm, so every
// IB_HIGH_FADE_SHORT entry (which by construction fires near IB High, ~29180-29193) was
// already "invalidated" by the OR-High check from the moment it fired, regardless of what
// price did afterward. Historically 13 real (ACTIVE/SHADOW) IB_HIGH/IB_LOW fades were cut
// short this way (35% of all real POST_ENTRY structural invalidations). Fix: these 8 types
// use the setup's own IB level as the invalidation boundary instead of OR high/low -- every
// other setup type's OR-based invalidation is unchanged.
//
// CORRECTED 2026-09-02 (DeepSeek code review, self-verified against compute_levels.js and
// acd.js's own live level sources before accepting): the first version of this fix got 2 of
// the 8 types genuinely right (IB_HIGH_FADE_SHORT, IB_LOW_FADE_LONG -- confirmed live-ACTIVE,
// the two that motivated the fix) but the other 6 were wrong two different ways:
// (a) PD_IB_HIGH_FADE_*/PD_IB_LOW_FADE_* fade the PRIOR DAY's IB (acd.js ~7534:
//     `lp.PD_IB_HIGH`/`lp.PD_IB_LOW`, read from level_prices; gate 570/9:30 ET per
//     scripts/repair_ib_dependent_window_mismatch.mjs), not today's IB -- the first version
//     recomputed TODAY's IB for these too, a different level entirely with no containment
//     relationship to today's OR (unlike today's IB, which structurally contains today's OR).
// (b) IB_HIGH/IB_LOW can each fire as BOTH directions (approachDir at ~7038: price can
//     approach IB High from below -> SHORT fading resistance, or from above -> LONG
//     defending it as support), so a direction-only boundary pick (SHORT->high, LONG->low)
//     is only correct for the "natural" pairing and picks the wrong (opposite, effectively
//     unreachable same-session) extreme for IB_HIGH_FADE_LONG/IB_LOW_FADE_SHORT -- which is
//     why the walk-forward backtest showed exactly $0 delta for those two, a symptom of the
//     bug, not evidence of "no effect." Fixed: resolve the correct LEVEL first (today's IB
//     high/low for IB_HIGH_FADE_*/IB_LOW_FADE_*, prior-day IB high/low via level_prices for
//     PD_IB_HIGH_FADE_*/PD_IB_LOW_FADE_*), independent of direction, then apply the universal
//     rule SHORT invalidates above ITS level / LONG invalidates below ITS level -- correct
//     regardless of which side price approached from.
export async function structurallyInvalidateSetups(io) {
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const [priceRow, acdRow, ibRow, pdIbRow] = await Promise.all([
    query(`SELECT close::float FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= CURRENT_DATE - 5 ORDER BY ts DESC LIMIT 1`),
    query(`SELECT or_high::float, or_low::float FROM acd_daily_log WHERE trade_date=$1`, [todayET]),
    query(`
      SELECT MAX(high)::float as ib_high, MIN(low)::float as ib_low
      FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 629
    `, [todayET]),
    // Same source acd.js's live fire path itself reads (lp.PD_IB_HIGH/lp.PD_IB_LOW,
    // ~7534) -- prior-day IB, already fully formed and available from the 8am cron, not
    // recomputed here (would risk drifting from compute_levels.js's own logic).
    query(`SELECT level_name, price::float FROM level_prices WHERE trade_date=$1 AND level_name IN ('PD_IB_HIGH','PD_IB_LOW')`, [todayET]),
  ]);

  const currentPrice = priceRow.rows[0]?.close;
  const orHigh = acdRow.rows[0]?.or_high;
  const orLow  = acdRow.rows[0]?.or_low;
  const ibHigh = ibRow.rows[0]?.ib_high;
  const ibLow  = ibRow.rows[0]?.ib_low;
  const pdIbHigh = pdIbRow.rows.find(r => r.level_name === 'PD_IB_HIGH')?.price;
  const pdIbLow  = pdIbRow.rows.find(r => r.level_name === 'PD_IB_LOW')?.price;
  if (!currentPrice || !orHigh || !orLow) return 0;

  // isBearish/isBullish + the dead bearishPattern/bullishPattern arrays removed 2026-08-17
  // (OPEN_DECISION isbearish_isbullish_heuristic_zone_edge_fade_gap) -- a third hand-rolled
  // direction heuristic, replaced below with the same resolveDirection(row) this function
  // already computes for the pnl calc (previously two separate calls per row; now hoisted
  // to one, reused for both the invalidation gate and the pnl calc, per DeepSeek's
  // code-review). Closes a real coverage gap: ZONE_EDGE_FADE matched neither isBearish nor
  // isBullish, so it was NEVER structurally invalidated by this function.

  // Need fired_at and stop_level to compute how long the setup was active when invalidated.
  // minutes_active computed SQL-side (naive ET fired_at vs. naive-ET-converted NOW()) —
  // doing this in JS via `Date.now() - new Date(row.fired_at).getTime()` mixed a real UTC
  // instant with a fake-UTC Date (db.js's parser relabels raw ET wall-clock as UTC), which
  // inflated minutesActive by the ET/UTC offset (4hrs in EDT) and made POST_ENTRY/PRE_ENTRY
  // classification always resolve to POST_ENTRY. Same root cause as the resolveSetupsByPrice
  // fix above. Found 2026-06-30.
  // t1_level added 2026-08-17 (OPEN_DECISION islongsetup_gap_variant_direction_bug) --
  // resolveDirection() below needs it alongside stop_level for its price-derived fallback;
  // this SELECT previously had stop_level but not t1_level, so the fallback couldn't run.
  const activeWithTime = await query(`
    SELECT id, setup_type, trade_date, stop_level, t1_level, entry_zone_low, entry_zone_high,
      EXTRACT(epoch FROM ((NOW() AT TIME ZONE 'America/New_York') - fired_at)) / 60 as minutes_active
    FROM active_setups
    WHERE trade_date=$1 AND status='ACTIVE'
  `, [todayET]);

  let count = 0;
  for (const row of activeWithTime.rows) {
    const isBracket = row.setup_type.includes('BRACKET_BREAKOUT');
    let shouldInvalidate = false;
    // Hoisted: one resolveDirection(row) call per row, reused below for both the
    // non-bracket invalidation gate and the pnl calc further down (2026-08-17,
    // OPEN_DECISION isbearish_isbullish_heuristic_zone_edge_fade_gap, DeepSeek
    // code-review) -- previously two separate calls per row; avoids any future
    // divergence between "the direction the gate used" and "the direction the pnl
    // used." Computed for every row, including bracket ones, since the pnl calc below
    // has always used it regardless of isBracket (only the shouldInvalidate GATE has a
    // separate bracket-specific path, unchanged, see below). Null (name/price
    // disagreement, or missing price levels) leaves the non-bracket shouldInvalidate
    // false -- the same "exclude, don't guess" convention this function already uses
    // for the pnl side (an ambiguous row isn't abandoned forever; it still resolves via
    // its own stop/t1 in resolveSetupsByPrice() or via expireStaleSetups()).
    const direction = resolveDirection(row);

    if (isBracket) {
      // BRACKET_BREAKOUT only ships as _LONG/_SHORT with no _GAP_* suffix (setupTypes.js),
      // so this name-only check is reliable and unaffected by the _GAP_* bug class --
      // deliberately left as-is, not part of this fix (DeepSeek design-critique, 2026-08-17).
      const isLong = row.setup_type.includes('LONG');
      shouldInvalidate = isLong
        ? (row.stop_level != null && currentPrice <= row.stop_level)
        : (row.stop_level != null && currentPrice >= row.stop_level);
    } else if (row.setup_type.includes('IB_HIGH') || row.setup_type.includes('IB_LOW')) {
      // Use the setup's own level, not the narrower OR high/low -- see header comment.
      // Resolve WHICH level first (today's IB for IB_HIGH_FADE_*/IB_LOW_FADE_*, prior-day IB
      // via level_prices for PD_IB_HIGH_FADE_*/PD_IB_LOW_FADE_* -- these are genuinely
      // different levels on different days, not interchangeable), independent of direction --
      // then apply the universal rule (SHORT invalidates above its level, LONG below), since
      // IB_HIGH/IB_LOW can each fire as either direction depending on which side price
      // approached from (approachDir, ~line 7038) and a direction-only high/low pick is wrong
      // for the "reversal" pairing (IB_HIGH_FADE_LONG defends IB High as support -- it should
      // invalidate on a break BELOW IB High, not on price crossing all the way down to IB Low).
      const isPriorDay = row.setup_type.startsWith('PD_IB_');
      const isHighLevel = row.setup_type.includes('IB_HIGH');
      // Falls back to OR only if the real level truly isn't available (e.g. today's IB
      // bars not formed yet, or the level_prices PD row missing) rather than skipping the check.
      const level = isPriorDay
        ? (isHighLevel ? (pdIbHigh ?? orHigh) : (pdIbLow ?? orLow))
        : (isHighLevel ? (ibHigh ?? orHigh) : (ibLow ?? orLow));
      shouldInvalidate = direction === 'SHORT' ? currentPrice > level : currentPrice < level;
    } else {
      shouldInvalidate =
        (direction === 'SHORT' && currentPrice > orHigh) ||
        (direction === 'LONG'  && currentPrice < orLow);
    }

    if (!shouldInvalidate) continue;

    const minutesActive = row.minutes_active != null
      ? row.minutes_active
      : 0;
    const invalidationTiming = minutesActive >= 2 ? 'POST_ENTRY' : 'PRE_ENTRY';

    // Mark-to-market actual_pnl for POST_ENTRY invalidations only (a real trader could have
    // been in the trade — "the premise broke" after entry is a real, scoreable outcome, same
    // convention as the TIME_EXPIRED fix above). PRE_ENTRY stays null on purpose: no real
    // entry ever happened, so there's nothing to mark to market. User-confirmed design
    // decision 2026-07-20 (OPEN_DECISION invalidated_session_closed_setups_never_get_actual_pnl).
    let pnl = null;
    const entry = row.entry_zone_high ?? row.entry_zone_low;
    // Null direction (name/price disagreement, or missing price levels) leaves pnl null --
    // resolution_method below already falls to null for a null pnl, the existing convention
    // here (matches expireStaleSetups' NO_PRICE_DATA-equivalent posture).
    if (invalidationTiming === 'POST_ENTRY' && entry != null && direction != null) {
      const long = direction === 'LONG';
      pnl = Math.round(((long ? (currentPrice - entry) : (entry - currentPrice))
        * LIVE_INSTRUMENT.dollarsPerPoint - LIVE_INSTRUMENT.commissionPerRoundTrip) * 100) / 100;
    }

    const updated = await query(`
      UPDATE active_setups
      SET status='EXPIRED', resolution='INVALIDATED', resolved_at=NOW(),
          updated_at=NOW(), invalidation_timing=$2,
          actual_pnl=$3, price_at_resolution=$4,
          resolution_method=$5, actual_outcome='INVALIDATED'
      WHERE id=$1 AND status='ACTIVE'
      RETURNING *
    `, [row.id, invalidationTiming, pnl, pnl != null ? currentPrice : null,
        pnl != null ? 'MARK_TO_MARKET' : null]);

    if (updated.rows.length) {
      try { await dropToTimeline(updated.rows[0]); } catch (_) {}
      if (io) io.emit('setup-expired', {
        setupId: row.id, setupType: row.setup_type, tradeDate: row.trade_date,
        resolution: 'INVALIDATED', invalidationTiming,
      });
      count++;
    }
  }
  return count;
}
