#!/usr/bin/env node
/**
 * Cluster Touch Credit — Phase 3b historical backfill, REAL WRITE.
 *
 * docs/CLUSTER_TOUCH_CREDIT_SPEC.md Phase 3b. Writes a real, resolvable `active_setups` SHADOW
 * row for every real RTH confluence-cluster touch (2026-07-23 onward) where a level lost the
 * live pick and never got its own row. Reconstruction/normalization logic verified against a
 * corrected Gemini-authored dry run (`scratch/backfill_cluster_touch_credit_dryrun.mjs`,
 * `reports/cluster_touch_credit_correction.md`) — Claude independently re-derived and matched
 * two sample counts via separately-written SQL before trusting it (RTH_VWAP_FADE_LONG: 74/74
 * exact match; IB_MID_SCALP_FADE_LONG: 26 reported vs 27 independently counted — the 1-row gap
 * traced to 4 winner rows sharing one identical `fired_at` instant on 2026-09-03, which does not
 * change the distinct-day count that actually drives the N>=20 promotion floor, and is harmless
 * regardless since the real write is protected by `idx_as_unique_touch_instant`).
 *
 * DeepSeek code-reviewed this script before it was run for real (scratch/deepseek_response.md) and
 * found 3 real HIGH-severity bugs in the first draft, all fixed here: (H1/M1) the no-hit branch
 * wrote resolution='MARK_TO_MARKET', a value this schema only ever uses in resolution_method, not
 * resolution -- would have either silently vanished from every real-N/WR/EV query or been
 * miscounted as a real win/loss depending on which field was wrong; fixed to
 * resolution='TIME_EXPIRED' + resolution_method='MARK_TO_MARKET', matching live. (H2) the bar-walk
 * used a flat 4-calendar-day cap instead of the spec's "session-end mark-to-market" -- gave a
 * touch that would have expired flat at 16:00 ET extra days to reach its target, systematically
 * inflating backfilled WR/EV; fixed to bound at the touch day's own 16:00 ET session end, matching
 * how every live RTH fade actually expires. (H3, the big one) the winners query had no
 * setup_type LIKE '%_FADE_%' filter, so 21 real STACK_VOL_BREAK_LIVE_* winners (a structurally
 * different engine whose confluence_levels_at_detection means breakout context, not competing fade
 * candidates) got misread as fade winners, producing ~93 spurious raw sibling instances (40 of
 * which survived every other filter to become insertable candidates -- DeepSeek pass 2 confirmed
 * the 93-vs-40 gap is accounted for by the downstream dedup/optByType/levelPrices/roster gates,
 * not a remaining bug); fixed by scoping the query
 * to '%_FADE_%' setup_types only. Also fixed 2 medium findings: (M2) a bare 'IB_MID' confluence
 * name wasn't aliased to IB_MID_SCALP_FADE_*; (L1) '3M VAL' was missing from SPACE_NAME_MAP.
 *
 * Scope: RTH-origin winners only (bet_class != 'GLOBEX_LEVEL'). Globex-origin siblings use a
 * structurally different naming convention (levelBase/_OVERNIGHT/shared bare names) and are
 * deliberately deferred to a second pass, same as this spec's existing deferral of the 2
 * gap-conditioned RTH types.
 *
 * Idempotent: safe to re-run. Every insert is `ON CONFLICT DO NOTHING` against the existing
 * `idx_as_unique_touch_instant` unique index on (trade_date, setup_type, fired_at) — a second run
 * will insert zero new rows for anything already backfilled.
 */
import { query } from '../server/db.js';
import { resolveSetupType } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { getBetClass } from '../server/config/setupTypes.js';

const START_DATE = '2026-07-23';
const DEDUP_WINDOW_MIN = 20;

// Step 1 — the 2 gap-conditioned resolveSetupType() overrides, excluded entirely from this pass
// (the other 7 of the spec's "9 override types" are the unconditional _TRAIL diversions, caught
// separately below via `candType.endsWith('_TRAIL')` once resolveSetupType() has run — NOT
// listed in this Set, which covers only the 2 gap-conditioned ones by design).
const GAP_CONDITIONED_EXCLUDE = new Set(['WPP_FADE_SHORT', 'OR5_LOW_FADE_LONG']);

// Step 2 — verified normalization table (docs/CLUSTER_TOUCH_CREDIT_SPEC.md Phase 3b, built after
// auditing acd.js's "FIXED 2026-08-20" and "FIXED 2026-08-31
// (confluence_levels_naming_canonicalization_4_sites)" comments plus a direct DISTINCT query
// against real confluence_levels_at_detection data).
const VALID_RTH_FADE_BASES = new Set([
  '10D_IB_MID', '2D_POC', '3M_POC', '3M_VAL', '5D_OR_MID', 'CAM_R1', 'CAM_R2', 'CAM_R3', 'CAM_R4',
  'CAM_S1', 'CAM_S2', 'CAM_S3', 'CAM_S4', 'DAILY_OPEN', 'FLOOR_PIVOT', 'FLOOR_R1', 'FLOOR_R2',
  'FLOOR_R3', 'FLOOR_S1', 'FLOOR_S2', 'FLOOR_S3', 'IB_HIGH', 'IB_LOW', 'IB_MID_SCALP',
  'MONTHLY_OPEN', 'MONTHLY_VWAP', 'MPP', 'MR1', 'MR2', 'MS1', 'MS2', 'ONH', 'ONL', 'OR10_HIGH',
  'OR10_LOW', 'OR10_MID', 'OR15_HIGH', 'OR15_LOW', 'OR15_MID', 'OR30_HIGH', 'OR30_LOW',
  'OR30_MID', 'OR5_HIGH', 'OR5_LOW', 'OR5_MID', 'PD2_VAH', 'PD2_VAL', 'PD_CLOSE', 'PD_HIGH',
  'PD_IB_HIGH', 'PD_IB_LOW', 'PD_IB_MID', 'PD_LOW', 'PD_OR_MID', 'PD_POC', 'PD_SESSION_MID',
  'PD_VAH', 'PD_VAL', 'PM_HIGH', 'PM_LOW', 'PM_POC', 'PM_VAH', 'PM_VAL', 'PW_HIGH', 'PW_LOW',
  'PW_POC', 'PW_VAH', 'PW_VAL', 'PY_POC', 'PY_VAH', 'PY_VAL', 'RTH_VWAP', 'WEEKLY_OPEN',
  'WEEKLY_VWAP', 'WPP', 'WR1', 'WR2', 'WS1', 'WS2',
]);
const NOT_RECONSTRUCTABLE_BASES = new Set(['2D_POC', 'PD2_VAH', 'PD2_VAL']);
const LEVEL_PRICES_ALIAS = { IB_MID_SCALP: 'IB_MID' };
const SPACE_NAME_MAP = {
  '10D IB Mid': '10D_IB_MID', '3M POC': '3M_POC', '3M VAL': '3M_VAL', 'Monthly VWAP': 'MONTHLY_VWAP',
  'PD POC': 'PD_POC', 'PD VAH': 'PD_VAH', 'PD VAL': 'PD_VAL', 'PM POC': 'PM_POC',
  'PW Low': 'PW_LOW', 'PW POC': 'PW_POC', 'PW VAH': 'PW_VAH', 'PW VAL': 'PW_VAL',
  'Weekly Open': 'WEEKLY_OPEN', 'Weekly VWAP': 'WEEKLY_VWAP',
  'Globex 24hr VWAP': null, 'Globex VWAP': null,
};
// DeepSeek review (M2): the bare 'IB_MID' spelling (distinct from 'IB_MID_SCALP') appears in
// real confluence_levels_at_detection data — without this alias it's silently dropped as
// unrecognized rather than credited to IB_MID_SCALP_FADE_*.
const LEGACY_OR_RENAME = { OR_HIGH: 'OR5_HIGH', OR_LOW: 'OR5_LOW', OR_MID_AFTER_IB: 'OR5_MID', IB_MID: 'IB_MID_SCALP' };

// DeepSeek review pass 2 (H2, confirmed real): expires_at is a PER-setup_type value, not a flat
// 16:00 ET session end -- acd.js's EXPIRY_WINDOW (~line 10446) gives these 4 level-fade base
// types a 30-minute window instead. Reusing the WINNER's own expires_at (this script's first H2
// "fix") is only correct when winner and sibling share an expiry class -- when they differ, a
// 30-min sibling under a session-end winner gets extra hours to reach target (reintroducing the
// exact WR/EV inflation H2 exists to remove), or a session-end sibling under a 30-min winner gets
// truncated (deflating it). Only the subset of EXPIRY_WINDOW that overlaps VALID_RTH_FADE_BASES
// is reproduced here -- that table has 30+ entries spanning many non-fade setup_types (RSI_DIV,
// TRT, BRACKET_BREAKOUT, ABSORPTION, ...) entirely out of this backfill's scope; every other fade
// type correctly falls through to the session-end default below, matching computeExpiry().
const FADE_EXPIRY_WINDOW_MIN = {
  PD_POC_FADE_LONG: 30, PD_POC_FADE_SHORT: 30,
  FLOOR_S1_FADE_LONG: 30, FLOOR_S1_FADE_SHORT: 30,
  OR5_HIGH_FADE_LONG: 30, OR5_HIGH_FADE_SHORT: 30,
  IB_HIGH_FADE_LONG: 30, IB_HIGH_FADE_SHORT: 30,
};

// Sibling's OWN session-end bound, mirroring acd.js's computeExpiry() exactly (30-min window for
// the 4 types above, else 16:00 ET rolled to next day if fired_at is already past it) -- computed
// from the CANDIDATE's own candType and fired_at (== the winner's fired_at, since a sibling touch
// is the same real-world moment as its winner), never from the winner's own setup_type/expires_at.
// Internal arithmetic treats the naive ET wall-clock string as if it were UTC (consistent with
// this file's other Date usage) purely so add/compare/round-trip stays self-consistent -- never
// mixed with a real UTC value.
function computeSiblingSessionEnd(candType, firedAtStr) {
  const firedAtMs = new Date(firedAtStr.replace(' ', 'T') + 'Z').getTime();
  const sessionEndET = new Date(firedAtMs);
  sessionEndET.setUTCHours(16, 0, 0, 0);
  if (sessionEndET.getTime() <= firedAtMs) sessionEndET.setUTCDate(sessionEndET.getUTCDate() + 1);
  const windowMins = FADE_EXPIRY_WINDOW_MIN[candType];
  const byWindow = windowMins ? new Date(firedAtMs + windowMins * 60000) : sessionEndET;
  const chosen = byWindow.getTime() < sessionEndET.getTime() ? byWindow : sessionEndET;
  return chosen.toISOString().slice(0, 19).replace('T', ' ');
}

function normalizeToBase(raw) {
  if (!raw) return null;
  if (raw.endsWith('_SWEEP_REVERSAL')) return null;
  if (raw in SPACE_NAME_MAP) return SPACE_NAME_MAP[raw];
  let base = raw.replace(/_FADE$/, '');
  if (base in LEGACY_OR_RENAME) base = LEGACY_OR_RENAME[base];
  if (base === 'VWAP') base = 'RTH_VWAP';
  if (base === 'GLOBEX_VWAP') return null;
  if (!VALID_RTH_FADE_BASES.has(base)) return null;
  return base;
}

const DRY_RUN = process.argv.includes('--dry-run');
const stats = { winnerRowsScanned: 0, siblingInstances: 0, backfillableConsidered: 0, inserted: 0, conflictSkipped: 0 };
const insertedByType = {};

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN (--dry-run passed, zero writes) ===' : '=== REAL WRITE ===');

  const winners = await query(`
    SELECT id, trade_date::text as trade_date, setup_type, fired_at::text as fired_at,
           confluence_levels_at_detection, bet_class
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND trade_date >= $1
      AND confluence_levels_at_detection IS NOT NULL
      AND array_length(confluence_levels_at_detection, 1) >= 2
      AND (bet_class IS DISTINCT FROM 'GLOBEX_LEVEL')
      -- DeepSeek review (H3): this spec is specifically about the level-fade engine
      -- (keepLevelsAll) -- one cluster winner, siblings get nothing. STACK_VOL_BREAK_LIVE_*
      -- is a DIFFERENT engine (computeStackVolSignal); its confluence_levels_at_detection is
      -- the volume-stack density map (breakout context), not competing fade candidates, and
      -- its LONG/SHORT suffix is the break direction, not a fade direction. Without this
      -- filter, every level in a STACK_VOL_BREAK_LIVE winner's array gets misread as a fade
      -- sibling (confirmed live: ~93 spurious raw sibling instances across 21 such winners, 40 of
      -- which would have survived to become real inserted rows). This keeps every
      -- genuine fade winner in scope, including _TRAIL/_GAP diverted ones (all still end in
      -- '_FADE_LONG'/'_FADE_SHORT' plus a suffix) -- only the non-fade engine is excluded.
      AND setup_type LIKE '%\_FADE\_%'
    ORDER BY trade_date, fired_at
  `, [START_DATE]);
  stats.winnerRowsScanned = winners.rows.length;

  const optRows = await query(`
    SELECT DISTINCT ON (signal_name) signal_name, optimal_stop, optimal_target
    FROM performance_audit WHERE signal_type='OPTIMAL_STOP'
    ORDER BY signal_name, run_date DESC
  `);
  const optByType = {};
  for (const r of optRows.rows) {
    if (r.optimal_stop != null && r.optimal_target != null) {
      optByType[r.signal_name] = { stop: +r.optimal_stop, target: +r.optimal_target };
    }
  }

  const lpRows = await query(`SELECT trade_date::text as trade_date, level_name, price::float as price FROM level_prices WHERE trade_date >= $1`, [START_DATE]);
  const levelPricesByDate = {};
  for (const r of lpRows.rows) (levelPricesByDate[r.trade_date] ??= {})[r.level_name] = r.price;

  const rosterRows = await query(`SELECT DISTINCT setup_type FROM active_setups`);
  const realRoster = new Set(rosterRows.rows.map(r => r.setup_type));

  // Real rows (for the dedup check), refreshed once up front. Within-batch duplicates are still
  // safe because of the unique index + ON CONFLICT DO NOTHING below, but checking here too avoids
  // wasting a bar-walk simulation on something we already know will be a no-op.
  const existingRows = await query(`SELECT trade_date::text as trade_date, setup_type, fired_at::text as fired_at FROM active_setups WHERE origin_status IN ('ACTIVE','SHADOW')`);
  const existingByDate = {};
  for (const r of existingRows.rows) (existingByDate[r.trade_date] ??= []).push({ setup_type: r.setup_type, fired_at: r.fired_at });

  const candidates = [];
  for (const w of winners.rows) {
    // Direction as a substring match, not endsWith — a winner whose OWN setup_type is a
    // diverted variant (e.g. 'CAM_S2_FADE_LONG_TRAIL', 'WPP_FADE_SHORT_GAP_UP') doesn't end in
    // a bare _LONG/_SHORT suffix. endsWith() silently dropped 55 of 1102 RTH-only winner rows
    // (5%) — every one of their confluence siblings along with them — found via an independent
    // audit before this script was ever run for real (compared against a separately-written SQL
    // check using `setup_type LIKE '%_LONG%'`, which doesn't have this gap).
    const dirMatch = w.setup_type.match(/_(LONG|SHORT)(?:_|$)/);
    const dir = dirMatch ? dirMatch[1] : null;
    if (!dir) continue;
    for (const raw of w.confluence_levels_at_detection) {
      stats.siblingInstances++;
      const base = normalizeToBase(raw);
      if (!base) continue;

      const rawType = `${base}_FADE_${dir}`;
      if (rawType === w.setup_type) continue; // the winner's own level
      if (GAP_CONDITIONED_EXCLUDE.has(rawType)) continue;

      const candType = resolveSetupType(rawType, { level: 0 }, {});
      if (candType.endsWith('_TRAIL')) continue;
      if (!realRoster.has(candType)) continue;
      if (NOT_RECONSTRUCTABLE_BASES.has(base)) continue;

      const lpName = LEVEL_PRICES_ALIAS[base] ?? base;
      const level = levelPricesByDate[w.trade_date]?.[lpName];
      if (level == null) continue;

      const opt = optByType[candType];
      if (!opt) continue;

      const existing = existingByDate[w.trade_date] || [];
      const winFiredMs = new Date(w.fired_at.replace(' ', 'T') + 'Z').getTime();
      const alreadyCovered = existing.some(e => {
        if (e.setup_type !== candType) return false;
        const eMs = new Date(e.fired_at.replace(' ', 'T') + 'Z').getTime();
        return Math.abs(eMs - winFiredMs) <= DEDUP_WINDOW_MIN * 60 * 1000;
      });
      if (alreadyCovered) continue;

      candidates.push({ tradeDate: w.trade_date, firedAt: w.fired_at, candType, dir, level, opt });
      // Deliberately NOT self-chained against other candidates generated within this same run —
      // the spec's dedup rule (Phase 3b Step 3.2) only protects against a touch already covered
      // by a PRE-EXISTING real row (a real winner-fire, early-touch-backfill, or a prior run of
      // this script), not against a genuinely different winner touch elsewhere in this same
      // batch. Two winner touches on the same day, more than 20min apart, that each happen to
      // list the same sibling base ARE two separate real touches and both earn their own row.
      // A within-run chain-suppression variant was tried and reverted (found before this script
      // was ever run for real): it cut the total from 1328 to 748 -- a real behavior change the
      // spec never asked for, not a refinement. Literal duplicate-instant collisions (the one
      // real risk, confirmed live: 4 winner rows sharing one identical fired_at on 2026-09-03)
      // are still fully protected by the DB's own `idx_as_unique_touch_instant` unique index +
      // the bare ON CONFLICT DO NOTHING below.
    }
  }
  stats.backfillableConsidered = candidates.length;
  console.log(`${stats.winnerRowsScanned} winner rows, ${stats.siblingInstances} sibling instances, ${stats.backfillableConsidered} candidates to resolve+insert`);

  for (const c of candidates) {
    const isLong = c.dir === 'LONG';
    const stopLevel = isLong ? c.level - c.opt.stop : c.level + c.opt.stop;
    const t1Level = isLong ? c.level + c.opt.target : c.level - c.opt.target;

    // Bounded at the SIBLING'S OWN session end/expiry, not an arbitrary multi-day cap and not the
    // winner's expires_at. DeepSeek review pass 1 (H2): the spec requires "session-end
    // mark-to-market," matching how every live fade actually expires -- a multi-day walk gives a
    // touch that would have expired flat extra days to reach its target, systematically inflating
    // backfilled WR/EV (the distortion only runs one direction: extra time can only convert a
    // would-be TIME_EXPIRED into a TARGET_HIT, never the reverse). Pass 1's own first fix (reuse
    // the WINNER's expires_at) was itself wrong (DeepSeek pass 2, confirmed): expires_at is a
    // PER-setup_type value (30min for 4 fade bases, else session-end -- see
    // FADE_EXPIRY_WINDOW_MIN/computeSiblingSessionEnd() above), so a sibling in a different expiry
    // class than its winner got the wrong window either direction. computeSiblingSessionEnd()
    // derives the bound from the CANDIDATE's own candType instead, correctly handling the 4-6PM
    // dead-zone case (fired_at past 16:00 same trade_date -> rolls to next day) the same way
    // acd.js's own computeExpiry() does.
    const sessionEnd = computeSiblingSessionEnd(c.candType, c.firedAt);
    const bars = await query(`
      SELECT ts::text as ts, high::float, low::float, close::float
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts > $1::timestamp AND ts <= $2::timestamp
      ORDER BY ts
    `, [c.firedAt, sessionEnd]);

    let resolution = null, resolutionMethod = 'SIBLING_BACKFILL', resolvedAt = null, exitPrice = null;
    for (const b of bars.rows) {
      if (isLong) {
        if (b.low <= stopLevel) { resolution = 'STOP_HIT'; exitPrice = stopLevel; resolvedAt = b.ts; break; }
        if (b.high >= t1Level) { resolution = 'TARGET_HIT'; exitPrice = t1Level; resolvedAt = b.ts; break; }
      } else {
        if (b.high >= stopLevel) { resolution = 'STOP_HIT'; exitPrice = stopLevel; resolvedAt = b.ts; break; }
        if (b.low <= t1Level) { resolution = 'TARGET_HIT'; exitPrice = t1Level; resolvedAt = b.ts; break; }
      }
    }
    if (resolution === null) {
      const last = bars.rows[bars.rows.length - 1];
      if (!last) continue; // no price data at all -- skip rather than guess
      // DeepSeek review (H1+M1): 'MARK_TO_MARKET' is a `resolution_method` value in this schema
      // (server/routes/acd.js:1190,1225,1496), never a `resolution` value -- the real
      // `resolution` vocabulary for a no-hit row is 'TIME_EXPIRED'. Using resolution_method here
      // (not resolution) also means REAL_TRADE_FILTER's `resolution_method NOT IN
      // ('MARK_TO_MARKET','RECOVERY_MTM')` correctly excludes these rows from real N/WR/EV, same
      // as it excludes live TIME_EXPIRED/MARK_TO_MARKET rows -- getting this backwards (as the
      // pre-review version did) would have either silently dropped these rows from every
      // aggregate (wrong resolution string matches no query) or wrongly counted them as real
      // wins/losses (wrong resolution_method), depending on which field was mismatched.
      resolution = 'TIME_EXPIRED';
      resolutionMethod = 'MARK_TO_MARKET';
      exitPrice = last.close;
      resolvedAt = last.ts;
    }
    const pnlPts = isLong ? exitPrice - c.level : c.level - exitPrice;
    const actualPnl = Math.round((pnlPts * LIVE_INSTRUMENT.dollarsPerPoint - LIVE_INSTRUMENT.commissionPerRoundTrip) * 100) / 100;

    if (DRY_RUN) {
      stats.inserted++;
      insertedByType[c.candType] = (insertedByType[c.candType] || 0) + 1;
      continue;
    }

    const res = await query(`
      INSERT INTO active_setups (
        trade_date, setup_type, fired_at, status, origin_status, suppression_reason,
        entry_zone_low, entry_zone_high, stop_level, t1_level,
        resolution, resolution_method, actual_pnl, price_at_resolution, resolved_at, bet_class
      ) VALUES ($1,$2,$3::timestamp,'RESOLVED','SHADOW','CLUSTER_SIBLING_TOUCH_CREDIT_BACKFILL',
        $4,$4,$5,$6,$7,$12,$8,$9,$10::timestamp,$11)
      ON CONFLICT DO NOTHING
      RETURNING id
    `, [c.tradeDate, c.candType, c.firedAt, c.level, stopLevel, t1Level, resolution, actualPnl, exitPrice, resolvedAt, getBetClass(c.candType), resolutionMethod]);

    if (res.rows[0]) {
      stats.inserted++;
      insertedByType[c.candType] = (insertedByType[c.candType] || 0) + 1;
    } else {
      stats.conflictSkipped++;
    }
  }

  console.log('\n=== Result ===');
  console.log(JSON.stringify(stats, null, 2));
  console.log('\nInserted by setup_type:');
  for (const t of Object.keys(insertedByType).sort()) console.log(`  ${t}: ${insertedByType[t]}`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
