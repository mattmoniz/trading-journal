// Bar-by-bar MAE/MFE replay engine.
// Used by the backfill script and live resolution path so both stay in sync.

import { resolveDirection } from '../config/setupTypes.js';

// Minimal, signature-preserving fix (2026-08-17, OPEN_DECISION
// islongsetup_bug_survives_in_3_other_files): strips a trailing _GAP_(UP|DOWN) suffix
// before matching, same one-line pattern as the canonical inferDirection()
// (server/config/setupTypes.js) -- a setup like WPP_FADE_SHORT_GAP_UP is a real SHORT
// trade, _GAP_UP describes the entry condition, not the trade direction. Kept as a
// name-only, setupType-string-in function (not upgraded to the row-aware
// resolveDirection()) because it's imported by name-string-only in ~65 other files
// (44 backtest_*/pilot_* exploratory scripts, DeepSeek-verified count), and changing
// the signature would break all of them for no benefit to those read-only scripts.
// ZONE_EDGE_FADE still defaults to SHORT here (no direction keyword in the name at
// all) -- a known, documented limitation, not a silent guess: the two DB-writing real
// call sites in this codebase (computeMaeMfe() below, scripts/backfill_mae_mfe.mjs)
// are upgraded to the row-aware resolveDirection() instead, which correctly resolves
// ZONE_EDGE_FADE via its price levels rather than guessing.
function directionFromType(setupType) {
  const base = setupType.replace(/_GAP_(UP|DOWN)$/, '');
  const u = base.toUpperCase();
  if (u.includes('LONG') || u.includes('BULLISH') || u.includes('_UP')) return 'LONG';
  return 'SHORT';
}

/**
 * Replay a single setup against an ordered array of 1-min bars.
 * bars: [{ ts, open, high, low, close }]  — must start at or after entry bar
 * Returns null if levels are inverted or no bars available.
 */
function replayBars(bars, entry, stop, t1, direction) {
  const entryRisk = direction === 'LONG' ? entry - stop  : stop  - entry;
  const reward    = direction === 'LONG' ? t1    - entry : entry - t1;

  if (entryRisk <= 0 || reward <= 0) return null;
  if (!bars || bars.length === 0)    return null;

  let mfe = 0;
  let mae = 0;
  let resolution = 'EXPIRED';
  let resolutionBarTime = null;
  let barsToResolution = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    barsToResolution = i + 1;

    const favorable = direction === 'LONG' ? bar.high - entry : entry - bar.low;
    const adverse   = direction === 'LONG' ? entry - bar.low  : bar.high - entry;

    const stopHit   = direction === 'LONG' ? bar.low  <= stop : bar.high >= stop;
    const targetHit = direction === 'LONG' ? bar.high >= t1   : bar.low  <= t1;

    mfe = Math.max(mfe, favorable);
    mae = Math.max(mae, adverse);

    if (stopHit && targetHit) {
      // Same-bar conflict: conservative = stop wins
      resolution = 'STOP_HIT';
      resolutionBarTime = bar.ts;
      break;
    } else if (stopHit) {
      resolution = 'STOP_HIT';
      resolutionBarTime = bar.ts;
      break;
    } else if (targetHit) {
      resolution = 'TARGET_HIT';
      resolutionBarTime = bar.ts;
      break;
    }
  }

  if (resolution === 'EXPIRED') {
    resolutionBarTime = bars[bars.length - 1]?.ts ?? null;
    barsToResolution = bars.length;
  }

  return { mfe, mae, barsToResolution, resolutionBarTime, replayResolution: resolution };
}

/**
 * Fetch the 1-min bars for a setup from the DB and run the replay.
 * queryFn: (sql, params) => { rows } — pass server/db.js query
 * Returns same shape as replayBars(), or null on data gaps.
 */
async function computeMaeMfe(queryFn, setupRow) {
  const {
    entry_zone_low, entry_zone_high,
    stop_level, t1_level,
    fired_at, trade_date,
  } = setupRow;

  const hi    = entry_zone_high != null ? parseFloat(entry_zone_high) : parseFloat(entry_zone_low);
  const entry = (parseFloat(entry_zone_low) + hi) / 2;
  const stop  = parseFloat(stop_level);
  const t1    = parseFloat(t1_level);
  // resolveDirection() (server/config/setupTypes.js), not directionFromType() -- this is a
  // real DB-writing/live-adjacent path (2026-08-17, OPEN_DECISION
  // islongsetup_bug_survives_in_3_other_files), so it gets the row-aware version with the
  // price-derived fallback for name-directionless types (ZONE_EDGE_FADE) instead of a guess.
  const direction = resolveDirection(setupRow);
  if (direction == null) return null; // name/price disagreement or missing levels -- exclude, don't guess
  // Pre-existing gap, not introduced by this fix (DeepSeek code-review, 2026-08-17): if both
  // entry_zone_low/entry_zone_high are null, `entry` above is NaN, and replayBars()'s own
  // `entryRisk <= 0` guard doesn't catch it (`NaN <= 0` is false, so it doesn't short-circuit)
  // -- would silently produce mfe=mae=0/EXPIRED instead of excluding. Consistent with the
  // "exclude, don't guess" posture just established above for direction.
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(t1)) return null;

  // price_bars_primary.ts / active_setups.fired_at are both `timestamp without time zone`
  // storing naive ET wall-clock (server/db.js's custom OID-1114 parser reads them correctly
  // by appending 'Z'). But binding `fired_at` (a JS Date) directly as a query PARAMETER hits
  // the opposite bug: node-pg serializes the Date via its real UTC instant, and Postgres
  // casts that instant back to a naive timestamp using the session's America/New_York
  // timezone -- silently shifting the value by the UTC/ET offset (reproduced directly:
  // 2023-11-17 10:30:00 round-tripped as a Date param became 2023-11-17 05:30:00, a 5hr
  // shift). Confirmed this was a real, live-relevant bug: this function's own bar window
  // ended up starting hours before the real fired_at, silently pulling in unrelated
  // overnight price action -- the same failure shape as the documented VWAP_MAGNET_LONG
  // BACKFILL fired_at bug (targetCalibrationService.js's outlier-guard comment), except
  // self-inflicted by this function rather than bad source data. Fix: re-serialize fired_at
  // to its naive ET string before binding, so Postgres never re-derives a UTC instant from
  // it. Found + fixed 2026-08-16 before scripts/audit_worst_trades_maemfe.mjs (this
  // function's only real caller) had ever been run.
  const firedAtNaive = fired_at instanceof Date ? fired_at.toISOString().slice(0, 19).replace('T', ' ') : fired_at;
  const barsResult = await queryFn(`
    SELECT ts, open::float, high::float, low::float, close::float
    FROM price_bars_primary
    WHERE symbol = 'NQ'
      AND ts::date = $1
      AND ts >= $2::timestamp
      AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) <= 960
    ORDER BY ts
  `, [trade_date, firedAtNaive]);

  return replayBars(barsResult.rows, entry, stop, t1, direction);
}

// Bar-6 checkpoint (RECOVERING/DETERIORATING) + the frozen target-distance-fraction exit
// rule. Extracted 2026-07-26 after this exact logic had been independently rewritten at
// least 4 times across scripts this session (bar6_early_exit, the volatility-regime split,
// two versions of the 1yr-prop-challenge overlay) — CLAUDE.md's "share modules, don't
// reimplement" convention, applied here the same way computeReplication() was extracted
// for the replication-check logic and computeVolatilityRegimeByDate() for the regime split.
// Matches server/routes/acd.js's resolveSetupsByPrice() live computation exactly: bars 0-6,
// worst adverse excursion at bar index <=2 => RECOVERING, else DETERIORATING. The exit rule
// itself is frozen from scripts/backtest_recovering_exit_predictor_confirmatory.mjs's
// pre-registered cutoff (targetDistFraction < 0.873) — do not re-derive.
const BAR6_FROZEN_CUTOFF = 0.873;

// Extracted 2026-07-26 (same day as computeBar6Checkpoint itself) so server/routes/acd.js's
// live resolveSetupsByPrice() can compute the exit-rule recommendation without restructuring
// its own bar-by-bar resolution loop to call computeBar6Checkpoint() wholesale (that loop does
// double duty -- it's also the primary STOP_HIT/TARGET_HIT/trail-mechanism detector, not a
// simple fixed-window replay -- a full refactor would be much riskier surgery than adding one
// captured value). Live code tracks its own bar6Close/status inline (identical bar 0-6 /
// worstBarIdx<=2 convention) and calls this for the exit-rule math specifically, rather than
// re-deriving the targetDistFraction formula a second time.
function computeExitRuleAtBar6(entry, bar6Close, t1, direction, status) {
  const distToTarget = direction === 'LONG' ? (t1 - bar6Close) : (bar6Close - t1);
  const distEntryToTarget = direction === 'LONG' ? (t1 - entry) : (entry - t1);
  const targetDistFraction = distEntryToTarget !== 0 ? (distToTarget / distEntryToTarget) : 0;
  const ruleSaysExit = status === 'RECOVERING' && targetDistFraction < BAR6_FROZEN_CUTOFF;
  return { targetDistFraction, ruleSaysExit };
}

function computeBar6Checkpoint(forwardBars, entry, stop, t1, direction, pnlPerPoint, commission) {
  if (!forwardBars || forwardBars.length < 7) return null; // not enough bars to reach bar 6
  const b0_6 = forwardBars.slice(0, 7);
  let worstPrice = direction === 'LONG' ? b0_6[0].low : b0_6[0].high;
  let worstBarIdx = 0;
  for (let i = 0; i <= 6; i++) {
    if (direction === 'LONG' && b0_6[i].low < worstPrice) { worstPrice = b0_6[i].low; worstBarIdx = i; }
    if (direction === 'SHORT' && b0_6[i].high > worstPrice) { worstPrice = b0_6[i].high; worstBarIdx = i; }
  }
  const status = worstBarIdx <= 2 ? 'RECOVERING' : 'DETERIORATING';
  const bar6Close = b0_6[6].close;
  const pointsAtBar6 = direction === 'LONG' ? (bar6Close - entry) : (entry - bar6Close);
  const pnlAtBar6 = pointsAtBar6 * pnlPerPoint - commission;
  const { targetDistFraction, ruleSaysExit } = computeExitRuleAtBar6(entry, bar6Close, t1, direction, status);
  return { worstBarIdx, status, targetDistFraction, bar6Close, pnlAtBar6, ruleSaysExit };
}

export { directionFromType, replayBars, computeMaeMfe, computeBar6Checkpoint, computeExitRuleAtBar6, BAR6_FROZEN_CUTOFF };
