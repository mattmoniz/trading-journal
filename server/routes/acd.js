// ACD Routes — full implementation extracted from server/index.js lines ~4759-7220
// Covers: /api/acd/*, /api/acd/backtest/*, /api/acd/weekly/*, weekly ACD computation

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { query } from '../db.js';
import { directionFromType, computeBar6Checkpoint } from '../services/maeMfeReplay.js';
import { classifyDeltaConfirmation, getDeltaConfirmationCategory } from '../services/deltaConfirmation.js';
import { getVolumeBaseline, classifyTouch } from '../services/touchQuality.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { getMarketStatus, getEarlyCloseMinute } from '../services/marketCalendar.js';
import { getGLine, getGLineDaysHeld, getConvictionData, computeDynamicConviction, getTrailingVwapStd, getTrailing24hrVwapStd, getGlobex24hrBars } from '../services/queries.js';
import {
  computeACDFromBars,
  getBestACDParams,
  saveSetupEvents,
  scanAndSaveSetupEvents,
  scanStructuralEvents,
  getStructuralLevels,
} from '../services/acdService.js';
import { runParameterSearch } from '../services/acdBacktest.js';
import { getLevelTouchLookup, getComboLookup, formatLevelTouchRate, formatComboRate } from '../services/engineReadHitRates.js';
import { computeLiveVolatilityRegime } from '../services/volatilityRegimeService.js';
import { matchPermissionSlips } from '../services/permissionSlip.js';
import { LIVE_INSTRUMENT } from '../config/instruments.js';
import { computeVolumeProfileForRange, computeRunningVwapSeries } from '../services/developingValueService.js';
import { UNCALIBRATED_SHADOW_TYPES, CONDITIONAL_VARIANTS, STACK_VOL_THRESHOLDS, getBetClass, BET_CLASS_STAGE, ROSTER_CAP, assertRosterCapNotExceeded } from '../config/setupTypes.js';
import { computeIbBullBear } from '../services/caseEngine.js';
import { computeVWAP } from '../../scripts/backtest_confluence.js';
import { stepBreakevenTrail } from '../services/breakevenTrailWalker.js';
import { classifyACDOpeningCall } from '../services/openingCallClassifier.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Rolling distribution helpers (σ-based, no static thresholds) ──────────
function rollingStats(arr) {
  if (!arr.length) return { mean: 0, std: 0 };
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const std = Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
  return { mean, std };
}
const MIN_SAMPLES = 20;

// Fetch trailing OR widths from acd_daily_log (90-day window)
async function getTrailingORWidths(date, days = 90) {
  const res = await query(
    `SELECT or_high::float - or_low::float as or_width
     FROM acd_daily_log
     WHERE trade_date >= $1::date - $2::int AND trade_date < $1
     AND or_high IS NOT NULL AND or_low IS NOT NULL
     ORDER BY trade_date DESC`, [date, days]).catch(() => ({ rows: [] }));
  return res.rows.map(r => r.or_width).filter(w => w > 0);
}

// Fetch trailing RTH close-vs-VWAP distances from session_analysis (30-day window)
// Used for σ-based VWAP Magnet threshold — same data as trade-alerts dailyVwapSigma

// In-memory backtest job state
let acdJob = { status: 'idle', progress: null, result: null, error: null };

// TEMPORARY DIAGNOSTIC (2026-08-12) — persists the cascade-breaker investigation's
// [cascade-diag] lines to a scratch file, since plain console.error only reaches
// nodemon's own stdout (not reliably tail-able from outside the running process, and
// not captured by server/index.js's recordError()/server_errors.jsonl, which only
// fires at explicit SERVER_ERROR/CLIENT_ERROR call sites). Remove alongside the
// diagnostic call sites once the real mechanism is found — see OPEN_DECISION
// cascade_breaker_reenable_redesign_scope.
function cascadeDiagLog(line) {
  console.error(line);
  try {
    fs.appendFileSync(path.join(__dirname, '../../scratch/cascade_diag.log'), `${new Date().toISOString()} ${line}\n`);
  } catch (_) {}
}

// ── Setup-detection level cache (structural data that changes at most daily) ──
// Keyed by trade date + cache key. Default TTL = 60 seconds for intraday stability;
// callers with a naturally-daily-scoped value (already keyed by date, so a stale-day
// read is impossible) can pass a longer ttl instead of reinventing a second cache —
// see getTouchQualityCalib/getTouchQualityBaseline below, which used to hand-roll
// their own module-level date-compare cache next to this one. Found in code review
// 2026-07-15, consolidated onto this existing helper instead.
const _levelCache = {};
const LEVEL_CACHE_TTL = 60000;
// Dedup for the dtaRow real-N-floor gate's console.error (see ~line 6800) — a
// persistently-thin SIZE_UP cell would otherwise log an identical line every 15s poll
// for the whole week between recalibrations, drowning scratch/server_errors.jsonl.
// Keyed by trade date so it naturally resets daily without extra cleanup logic; bounded
// size (setup_types × day_types × reasons, low hundreds at most).
const _dtaGateLogged = new Set();
const DAY_CACHE_TTL = 12 * 60 * 60 * 1000; // half a trading day+ — safe since the cache key already includes the date
function cacheKey(tradeDate, key) { return `${tradeDate}:${key}`; }
function getCached(tradeDate, key, ttl = LEVEL_CACHE_TTL) {
  const e = _levelCache[cacheKey(tradeDate, key)];
  if (e && Date.now() - e.ts < ttl) return e.val;
  return null;
}
function setCached(tradeDate, key, val) {
  _levelCache[cacheKey(tradeDate, key)] = { val, ts: Date.now() };
  return val;
}

// ── Value-area regime stamping (measurement layer only, 2026-07-31) ────────────────
// Tags every setup with its position relative to the TRUE volume-weighted value area
// (vah/val/poc from computeVolumeProfileForRange, computed nightly by
// scripts/compute_value_area_regime_snapshots.mjs into value_area_regime_snapshots) at
// 7 lookbacks. Deliberately informational-only -- see docs/OPEN_THREADS.md's 2026-07-31
// entry and docs/REGIME_INTELLIGENCE_SPEC.md (marked REJECTED): the original spec's
// gating/routing engine did not survive audit, but tagging every setup so real forward
// data can be judged over the next few months does not depend on that engine at all.
// Nothing reads these columns to suppress or size anything -- do not wire that until a
// real forward sample clears this codebase's actual rigor bar (computeRigor +
// computeReplication), not a backtest sweep.
const REGIME_LOOKBACKS = [10, 20, 30, 45, 60, 90, 180];
async function getValueAreaRegimeMap(tradeDate) {
  const cached = getCached(tradeDate, 'valueAreaRegimeMap', DAY_CACHE_TTL);
  if (cached) return cached;
  const rows = await query(`
    SELECT lookback_days, vah::float, val::float FROM value_area_regime_snapshots
    WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM value_area_regime_snapshots WHERE snapshot_date <= $1)
  `, [tradeDate]).catch(() => ({ rows: [] }));
  const map = {};
  for (const r of rows.rows) map[r.lookback_days] = { vah: r.vah, val: r.val };
  return setCached(tradeDate, 'valueAreaRegimeMap', map);
}
// price outside [val, vah] gives pos < 0 or > 1 (a real extension beyond the value area),
// not clamped -- the magnitude of the overshoot is itself informative, not noise to hide.
function computeRegimeStamp(price, vaMap) {
  const stamp = {};
  for (const L of REGIME_LOOKBACKS) {
    const va = vaMap[L];
    const width = va ? va.vah - va.val : null;
    const pos = (va && width > 0) ? (price - va.val) / width : null;
    stamp[`regime_pos_${L}d`] = pos != null ? +pos.toFixed(4) : null;
    stamp[`regime_label_${L}d`] = pos != null ? (pos >= 0 && pos <= 1 ? 'Mid' : 'Edge') : null;
  }
  return stamp;
}
const REGIME_STAMP_COLS = REGIME_LOOKBACKS.flatMap(L => [`regime_pos_${L}d`, `regime_label_${L}d`]);
function regimeStampValues(stamp) { return REGIME_STAMP_COLS.map(c => stamp[c] ?? null); }

// ── Fire-time regime tagging (roster-rebuild roadmap Phase 1, I1, 2026-08-10) ──────
// Tags every live INSERT with day_type_at_fire/vol_bucket_at_fire/session/
// minutes_from_open — the regime that was true AT FIRE TIME, populated at insert,
// never backfilled. Purely additive/informational, same posture as the value-area
// regime stamp above — nothing reads these columns to gate/size anything yet. Point
// of this: no census/analysis of the roster today can condition on regime at all; this
// is what lets a future bet_class-level calibration (I3) or correlation monitor (I5)
// group by "what was actually true when this fired" instead of pooling blind.
//
// day_type_at_fire is deliberately the SLOW, ground-truth acd_daily_log.day_type — NOT
// the live dayTypeReassessmentService.js estimate. That engine was tested as a live
// gate input and rejected (2026-08-03, OPEN_DECISION dtclass_null_all_day_neuters_
// multiple_live_gates / RESEARCH_CLAIM trend_gate_suppression): it's specifically
// UNRELIABLE at the exact moment a fade fires (70.6% FPR on that subpopulation, since a
// fade-touch moment by construction looks like a trend in progress). Tagging a column
// literally named "day_type_at_fire" with a known-unreliable live guess would silently
// misdirect any future bet_class analysis that assumes it's ground truth. The honest
// consequence: acd_daily_log.day_type isn't written until run_daily_calibration.sh's
// 20:20 ET derive_day_types.js run, so for the RTH majority of the roster this will
// read UNKNOWN nearly always — that itself is a real, useful finding (how much of the
// roster can't be regime-conditioned on ground-truth day-type at all), not a bug to
// paper over with a worse number. vol_bucket_at_fire/session/minutes_from_open are the
// three fields expected to carry the real weight for regime conditioning until/unless a
// future session deliberately re-opens the live-estimate question (tracked below).
const RTH_OPEN_MIN = 570;    // 9:30 ET
const GLOBEX_OPEN_MIN = 1080; // 18:00 ET

export async function getDayTypeAtFire(tradeDate) {
  const cached = getCached(tradeDate, 'dayTypeAtFire');
  if (cached) return cached;
  const r = await query(`SELECT day_type FROM acd_daily_log WHERE trade_date=$1`, [tradeDate]).catch(() => ({ rows: [] }));
  return setCached(tradeDate, 'dayTypeAtFire', r.rows[0]?.day_type || 'UNKNOWN');
}

// Trailing-30-trading-day median 1-min NQ bar range, strictly excluding tradeDate
// itself (every input row satisfies ts::date < $1 — the preflight guard this field's
// own spec item calls for). Excluding the WHOLE trade_date, not just bars before
// fired_at's own time-of-day, means this is safe for both RTH and Globex fires on that
// date with a single query, and is immune to any same-day reclassification. Bucketed
// into quintiles against its own trailing 250-trading-day distribution of the SAME
// rolling statistic — self-calibrating, no static threshold (matches the noise-floor/
// circuit-breaker convention in update_optimal_stops.mjs, not reimplemented from it
// since that one is a run-time script stat, not a per-tradeDate live lookup).
export async function getVolBucketAtFire(tradeDate) {
  // getCached/setCached can't distinguish "not cached" from "cached as a legitimate
  // null" (both return null) — use a sentinel so the insufficient-history case (below)
  // is actually cached instead of re-querying on every call.
  const cached = getCached(tradeDate, 'volBucketAtFire', DAY_CACHE_TTL);
  if (cached !== null) return cached === 'NONE' ? null : cached;
  const rows = await query(`
    WITH daily AS (
      SELECT ts::date AS d, AVG(high - low) AS rng
      FROM price_bars_primary
      WHERE symbol = 'NQ' AND ts::date < $1
      GROUP BY ts::date
    ), rolled AS (
      SELECT d,
        AVG(rng) OVER (ORDER BY d ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS roll30,
        COUNT(*) OVER (ORDER BY d ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS n_in_window
      FROM daily
    )
    SELECT d, roll30::float FROM rolled WHERE n_in_window >= 30 ORDER BY d DESC LIMIT 251
  `, [tradeDate]).catch(() => ({ rows: [] }));
  if (rows.rows.length < 51) { setCached(tradeDate, 'volBucketAtFire', 'NONE'); return null; } // too little history to bucket meaningfully
  const [today, ...hist] = rows.rows;
  const histVals = hist.map(r => r.roll30).sort((a, b) => a - b);
  const rank = histVals.filter(v => v <= today.roll30).length / histVals.length;
  const bucket = rank >= 0.8 ? 'HIGH' : rank >= 0.6 ? 'ABOVE_AVG' : rank >= 0.4 ? 'AVG' : rank >= 0.2 ? 'BELOW_AVG' : 'LOW';
  return setCached(tradeDate, 'volBucketAtFire', bucket);
}

// etMin: minutes-since-midnight ET at fire time. Session opens: RTH 9:30 ET (570),
// Globex 18:00 ET (1080), wrapping past midnight through the 8:30 ET Globex detector
// cutoff. Every call site derives etMin from "now" at insert time, never a stored/
// stale value — satisfies the strict-upper-time-bound guard by construction (there is
// no query here at all, just wall-clock arithmetic on the same instant fired_at=NOW()
// uses).
export function minutesFromSessionOpen(etMin, session) {
  if (etMin == null) return null;
  if (session === 'RTH') return etMin - RTH_OPEN_MIN;
  if (etMin >= GLOBEX_OPEN_MIN) return etMin - GLOBEX_OPEN_MIN;
  return etMin + (1440 - GLOBEX_OPEN_MIN);
}

export async function computeFireTags(tradeDate, session, etMin) {
  const [dayType, volBucket] = await Promise.all([
    getDayTypeAtFire(tradeDate),
    getVolBucketAtFire(tradeDate),
  ]);
  return {
    day_type_at_fire: dayType,
    vol_bucket_at_fire: volBucket,
    session,
    minutes_from_open: minutesFromSessionOpen(etMin, session),
  };
}
export const FIRE_TAG_COLS = ['day_type_at_fire', 'vol_bucket_at_fire', 'session', 'minutes_from_open'];
export function fireTagValues(tags) { return FIRE_TAG_COLS.map(c => tags[c] ?? null); }

// ── Non-fire logging (roster-rebuild roadmap Phase 1, I2, 2026-08-10) ──────────────
// A `gated_candidates` row for every candidate this codebase's own gates drop, null, or
// keep out of the ACTIVE path -- before this, the current census of what the system does
// was blind to everything filtered before a row was written (e.g. a PROMOTE-status type
// showing zero real attempts was invisible in every existing analysis, since a nulled
// candidate simply never produced any row anywhere). Explicitly NOT a duplicate of the
// existing SHADOW-row audit trail (the level-fade 6-way combo at ~line 6532, the
// forceShadow combo on the winning candidate, the overnight-level promotion gate) --
// those already persist their own row with their own reason and don't need this table;
// this table exists specifically for the gates a 2026-08-10 audit found had NO trace at
// all (a console.error, or nothing): the IB day-type real-N floor, the OPEN_TEST_DRIVE
// hardcoded kill-switch, both riskOk checks, the directional-conflict "stand aside", the
// C_STANDALONE death-sequence/POC-counter suppressions, and the Globex same-day dedup.
// Fire-and-forget, never allowed to affect detection -- same posture as the rest of this
// file's audit inserts.
async function logGatedCandidate({ tradeDate, setupType, gateName, gateReason, entry, stop, target }) {
  try {
    await query(`
      INSERT INTO gated_candidates (trade_date, setup_type, gate_name, gate_reason, would_have_entry, would_have_stop, would_have_target, bet_class)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [tradeDate, setupType, gateName, gateReason ?? null, entry ?? null, stop ?? null, target ?? null, getBetClass(setupType)]);
  } catch (_) { /* informational only, never block detection */ }
}

// Touch-quality (order-flow) calibration + volume-baseline lookups — informational
// only; see server/services/touchQuality.js and scripts/calibrate_touch_quality.mjs.
async function getTouchQualityCalib() {
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const cached = getCached(todayET, 'touchQualityCalib', DAY_CACHE_TTL);
  if (cached) return cached;
  const res = await query(`
    SELECT signal_name, notes FROM performance_audit
    WHERE signal_type='TOUCH_QUALITY' AND run_date=(SELECT MAX(run_date) FROM performance_audit WHERE signal_type='TOUCH_QUALITY')
  `).catch(() => ({ rows: [] }));
  const map = {};
  for (const row of res.rows) {
    try {
      const n = JSON.parse(row.notes);
      map[row.signal_name] = { windowBars: n.window_bars, highVolZCutoff: n.high_vol_z_cutoff };
    } catch (_) {}
  }
  return setCached(todayET, 'touchQualityCalib', map);
}

// tradeDate: the SETUP's own trade_date (not "today") — a SHADOW/overnight setup
// classified after midnight ET must exclude its own trade date from the 90-day
// trailing baseline the same way scripts/calibrate_touch_quality.mjs does, not
// silently fold that date's own volume into its baseline average. Previously this
// always used wall-clock "today", which only happened to be correct for the common
// same-day case. Found in code review 2026-07-15.
async function getTouchQualityBaseline(tradeDate) {
  const cached = getCached(tradeDate, 'touchQualityBaseline', DAY_CACHE_TTL);
  if (cached) return cached;
  const baseline = await getVolumeBaseline(query, tradeDate);
  return setCached(tradeDate, 'touchQualityBaseline', baseline);
}

// Rolling 20-day, per-minute-of-day baseline for trailing-5-bar net price movement
// ("pace") — same convention as getVolumeBaseline, just on |close - close_5| instead of
// volume. Backs the STACK_VOL_BREAK_LIVE pace factor (RESEARCH_CLAIM
// loose_confluence_pace_rth_promising_not_confirmed) — reused directly from
// scratch/pilot_loose_confluence_pace.mjs's getPaceBaseline(), not reimplemented.
export async function getPaceBaseline(tradeDate) {
  const cached = getCached(tradeDate, 'paceBaseline', DAY_CACHE_TTL);
  if (cached) return cached;
  const res = await query(`
    WITH raw_bars AS (
      SELECT ts, (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int AS mod, close,
        LAG(close, 5) OVER (PARTITION BY ts::date ORDER BY ts) as close_5
      FROM price_bars_primary
      WHERE ts::date >= $1::date - INTERVAL '20 days' AND ts::date < $1::date AND symbol = 'NQ'
    )
    SELECT mod, AVG(ABS(close - close_5))::float as avg_pace, STDDEV(ABS(close - close_5))::float as std_pace
    FROM raw_bars WHERE close_5 IS NOT NULL GROUP BY 1
  `, [tradeDate]);
  const baseline = new Map(res.rows.map(r => [r.mod, r]));
  return setCached(tradeDate, 'paceBaseline', baseline);
}

let structuralBackfillJob = { status: 'idle', done: 0, total: 0, eventsAdded: 0, error: null };
let acdBulkJob = { status: 'idle', done: 0, total: 0, error: null };
let weeklyBulkJob = { status: 'idle', done: 0, total: 0, error: null };

// Multer for CSV uploads
const csvDataDir = path.join(__dirname, '../data');
if (!fs.existsSync(csvDataDir)) fs.mkdirSync(csvDataDir, { recursive: true });
const csvUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, csvDataDir),
    filename: (req, file, cb) => cb(null, 'NQ_1min.csv'),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(csv|txt)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('CSV files only'));
  },
});

// ── Helpers for setup lifecycle ───────────────────────────────────────────────

function inferDirection(setupType) {
  if (/LONG|UP|BULLISH/.test(setupType)) return 'LONG';
  if (/SHORT|DOWN|BEARISH/.test(setupType)) return 'SHORT';
  return null;
}

// Drops an active_setups row into trade_timeline_events (idempotent via ON CONFLICT).
// event_time = fired_at (never current timestamp — per spec).
export async function dropToTimeline(setup) {
  await query(`
    INSERT INTO trade_timeline_events (
      trade_date, event_time, event_type, setup_type, setup_id,
      direction, entry_zone, stop_level, t1_level, t1_label,
      resolution, historical_win_rate, historical_sessions,
      window_duration_minutes
    ) VALUES ($1,$2,'SETUP',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (setup_id) DO NOTHING
  `, [
    setup.trade_date,
    setup.fired_at,
    setup.setup_type,
    setup.id,
    inferDirection(setup.setup_type),
    setup.entry_zone_low,
    setup.stop_level,
    setup.t1_level,
    setup.t1_label,
    setup.resolution || null,
    setup.historical_win_rate,
    setup.historical_sessions,
    setup.expires_at
      ? Math.round((new Date(setup.expires_at) - new Date(setup.fired_at)) / 60000)
      : null,
  ]);
}

function isLongSetup(setupType) {
  return setupType.includes('LONG') || setupType.includes('BULLISH') || setupType.includes('_UP');
}

// Fade-against-a-big-move-day exit check — DISABLED 2026-07-27, kept in place (not deleted)
// so the wiring/history is visible rather than silently vanishing. The 2026-07-26 validation
// (RESEARCH_CLAIM bigmove_fade_exit_2yr_robustness_confirmed, N=472, $37-46/trade) was never
// filtered by origin_status -- turned out to be 98.4% BACKFILL/UNKNOWN. Re-run filtered to
// real (ACTIVE/SHADOW) trades only found the fresh-trigger condition has occurred ZERO times
// in the entire 2-year real trade history -- not thin, genuinely never happened once. See
// RESEARCH_CLAIM bigmove_fade_exit_zero_real_occurrences for the full account. Returning
// false unconditionally until real occurrences actually accumulate enough to re-validate --
// do not re-enable by just reverting this line without re-checking origin_status first.
export async function checkFadeAgainstBigMoveExit(_setupRow, _currentSessionDate) {
  return false;
}

// Disabled logic preserved for reference (do not re-enable without re-validating on real
// origin_status='ACTIVE'/'SHADOW' data first -- see the disabled function's own comment above):
//
// if (!setupRow || setupRow.resolution != null || setupRow.entry_zone_low == null) return false;
// try {
//   const bigMoveActiveRow = await query(`
//     SELECT 1 FROM performance_audit WHERE signal_type='BIGMOVE_LIVE_SIGNAL' AND signal_name=$1
//   `, [currentSessionDate]);
//   if (bigMoveActiveRow.rows.length === 0) return false;
//
//   const direction = inferDirection(setupRow.setup_type);
//   if (!direction) return false;
//
//   const elapsedMin = (Date.now() - new Date(setupRow.fired_at).getTime()) / 60000;
//   if (elapsedMin < 13) return false; // matches the validated median fresh-trigger offset
//
//   const sessQ = await query(`
//     WITH recent AS (
//       SELECT ts, close::float, ts - LAG(ts) OVER (ORDER BY ts) AS gap
//       FROM price_bars_primary
//       WHERE symbol='NQ' AND ts >= (SELECT MAX(ts) FROM price_bars_primary WHERE symbol='NQ') - interval '30 hours'
//     ),
//     session_start AS (
//       SELECT COALESCE(MAX(ts), (SELECT MIN(ts) FROM recent)) AS start_ts FROM recent WHERE gap > interval '45 minutes'
//     )
//     SELECT
//       (SELECT start_ts FROM session_start) AS start_ts,
//       (SELECT close FROM recent, session_start WHERE ts >= session_start.start_ts ORDER BY ts ASC LIMIT 1) AS open_close,
//       (SELECT close FROM recent ORDER BY ts DESC LIMIT 1) AS latest_close
//   `);
//   const { start_ts, open_close, latest_close } = sessQ.rows[0] || {};
//   if (!start_ts || open_close == null || latest_close == null) return false;
//
//   const dayDir = Number(latest_close) >= Number(open_close) ? 'UP' : 'DOWN';
//   const isFadingAgainst = (dayDir === 'DOWN' && direction === 'LONG') || (dayDir === 'UP' && direction === 'SHORT');
//   if (!isFadingAgainst) return false;
//
//   const rngAtEntryQ = await query(`
//     SELECT MAX(high::float) - MIN(low::float) AS rng
//     FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1 AND ts <= $2
//   `, [start_ts, setupRow.fired_at]);
//   const rngAtEntry = rngAtEntryQ.rows[0]?.rng;
//   const wasActiveAtEntry = rngAtEntry != null && Number(rngAtEntry) >= 250;
//   return !wasActiveAtEntry;
// } catch (_) {
//   return false;
// }

// Price-based resolution: for each ACTIVE setup with defined entry/stop/T1, walk price
// bars since fired_at and resolve TARGET_HIT/STOP_HIT the moment either level is touched
// (whichever is touched first, chronologically — same logic as setupBacktestService.js
// and the historical backfill). Runs BEFORE expireStaleSetups/structurallyInvalidateSetups
// so a real T1/stop touch is never preempted by a timer or OR-break invalidation.
export async function resolveSetupsByPrice(io) {
  // fired_at is selected as ::text, not as a Date object: node-postgres serializes
  // JS Date params for "timestamp without time zone" columns using the server
  // process's LOCAL timezone, while these columns actually store raw ET wall-clock
  // values (per db.js's 'Z'-suffix parser convention). Rebinding a Date object as
  // the $1 param below silently shifted the bar-walk window by the ET/UTC offset
  // (4hrs in EDT), pulling in pre-market bars and causing false STOP_HIT resolutions.
  // Passing the raw text avoids the round-trip entirely. Found 2026-06-30.
  // runner_trail_width is the ONLY new column read as input here — it doubles as the
  // trail-eligibility flag (non-null = breakeven-then-trail mechanism applies) and the
  // trail distance itself. breakeven_armed_at/runner_peak_price/runner_trail_price are
  // NOT read here because this function already re-walks every bar from fired_at on
  // every single poll (same as the existing MAE/MFE computation below) rather than
  // resuming from a saved cursor — so the armed/peak/trail state is fully re-derived
  // from scratch each poll, deterministically, and only needs to be WRITTEN (for the
  // frontend card to display "armed, trailing" — see docs/SCALEOUT_RUNNER_SPEC.md §7),
  // never read back in as input.
  const active = await query(`
    SELECT id, setup_type, trade_date::text as trade_date, fired_at::text as fired_at, expires_at::text as expires_at,
           entry_zone_low, entry_zone_high, stop_level, t1_level, status, touch_quality,
           runner_trail_width::float as runner_trail_width, extend_target_level::float as extend_target_level
    FROM active_setups WHERE status IN ('ACTIVE', 'SHADOW')
  `);
  // Naive ET wall-clock text, same convention as fired_at/expires_at above (see the
  // comment atop this function) -- lets expiry be compared via plain string comparison,
  // avoiding the ET/UTC Date-parsing landmine already found twice in this file.
  const nowEtRow = await query(`SELECT (NOW() AT TIME ZONE 'America/New_York')::text as now_et`);
  const nowEt = nowEtRow.rows[0].now_et;

  // Was a real N+1: one "bars since fired_at" query per unresolved setup (up to ~20
  // on a normal day), each independently re-scanning price_bars_primary's full
  // partition set (its ts column is a date_trunc() expression, not the raw
  // partition key, so partition pruning doesn't trigger even though the row-level
  // filter does) — measured 2026-07-15 as the dominant cost of /api/acd/setup-detection
  // (13-24s). Every setup's needed bars are a suffix of the earliest setup's own
  // range (all queries run "from fired_at through now"), so fetching once from the
  // single earliest fired_at and filtering per-setup in JS is both correct (same
  // exact rows each setup would have gotten) and eliminates the redundant re-scans.
  // ts is fetched as ::text (not a Date object) to match fired_at's own ::text
  // convention above — avoids the exact ET/UTC Date-parsing landmine documented
  // where this function reads fired_at, since string comparison here needs to match
  // Postgres's own timestamp-text ordering, not JS's local-timezone Date parsing.
  const needsBars = active.rows.filter(row => {
    if (row.setup_type === 'ABSORPTION_LONG' || row.setup_type.startsWith('COIL_SURGE')) return false;
    const long = isLongSetup(row.setup_type);
    const entry = row.entry_zone_high ?? row.entry_zone_low;
    const { stop_level: stop, t1_level: t1 } = row;
    if (entry == null || stop == null || t1 == null) return false;
    if (long && t1 <= entry) return false;
    if (!long && t1 >= entry) return false;
    return true;
  });
  let sharedBarsRows = [];
  if (needsBars.length) {
    const earliestFiredAt = needsBars.reduce((min, r) => (r.fired_at < min ? r.fired_at : min), needsBars[0].fired_at);
    const sharedBars = await query(`
      SELECT ts::text as ts, open::float, high::float, low::float, close::float,
             COALESCE(bid_volume,0)::int AS bid_volume, COALESCE(ask_volume,0)::int AS ask_volume,
             (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int AS mod
      FROM price_bars_primary WHERE symbol='NQ' AND ts > $1 ORDER BY ts
    `, [earliestFiredAt]);
    sharedBarsRows = sharedBars.rows;
  }

  // Cumulative-delta-confirmation calibrated thresholds — read once per poll (cached,
  // matching the sharedBarsRows fetch-once-per-poll pattern above), never hardcoded.
  // Written weekly by scripts/calibrate_delta_confirmation.mjs (server/services/
  // deltaConfirmation.js's classifyDeltaConfirmation() is the shared classifier both
  // sides use). RESEARCH_CLAIM cumulative_delta_confirms_breakout_beyond_price_alone /
  // cumulative_delta_confirms_fades_stronger_than_breakout.
  const deltaCalibCached = getCached('_global', 'deltaConfirmationCalib', DAY_CACHE_TTL);
  const deltaCalib = deltaCalibCached ?? await (async () => {
    const r = await query(`
      SELECT DISTINCT ON (signal_name) signal_name, notes
      FROM performance_audit WHERE signal_type='DELTA_CONFIRMATION_CALIB'
      ORDER BY signal_name, run_date DESC
    `);
    const map = {};
    for (const row of r.rows) {
      try { map[row.signal_name] = JSON.parse(row.notes).threshold; } catch (_) {}
    }
    return setCached('_global', 'deltaConfirmationCalib', map, DAY_CACHE_TTL);
  })();

  let count = 0;
  for (const row of active.rows) {
    const long = isLongSetup(row.setup_type);
    const entry = row.entry_zone_high ?? row.entry_zone_low;
    const statusMatch = row.status; // 'ACTIVE' or 'SHADOW'

    // server/config/instruments.js is the single source of truth for this — found
    // 2026-07-16 that a wrong $/pt constant had independently drifted into 3 separate
    // places in this codebase (a backend script, a frontend modal, and this file's own
    // TRT_LONG trade-brief text), so this is deliberately imported, not redeclared.
    const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
    const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;

  // Custom resolution for ABSORPTION_LONG: "did price move up meaningfully?"
    if (row.setup_type === 'ABSORPTION_LONG') {
      const stop = row.stop_level;
      const t1 = row.t1_level;
      if (entry == null || stop == null) continue;
      const currentPxQ = await query(`SELECT close::float FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= CURRENT_DATE - 5 ORDER BY ts DESC LIMIT 1`);
      const px = currentPxQ.rows[0]?.close;
      if (!px) continue;
      const stopHit = px <= stop;
      const targetHit = t1 && px >= t1;
      if (stopHit) {
        const pnl = (stop - entry) * PNL_PER_POINT - COMMISSION;
        await query(`UPDATE active_setups SET status='RESOLVED', resolution='STOP_HIT', resolution_method='PRICE_CLEAN', actual_pnl=$2, resolved_at=NOW(), updated_at=NOW() WHERE id=$1 AND status=$3`, [row.id, Math.round(pnl * 100) / 100, statusMatch]);
        if (statusMatch === 'ACTIVE' && io) io.emit('setup-resolved', { setupId: row.id, setupType: row.setup_type, resolution: 'STOP_HIT' });
        count++;
      } else if (targetHit) {
        const pnl = (t1 - entry) * PNL_PER_POINT - COMMISSION;
        await query(`UPDATE active_setups SET status='RESOLVED', resolution='TARGET_HIT', resolution_method='PRICE_CLEAN', actual_pnl=$2, price_at_resolution=$3, resolved_at=NOW(), updated_at=NOW() WHERE id=$1 AND status=$4`, [row.id, Math.round(pnl * 100) / 100, px, statusMatch]);
        if (statusMatch === 'ACTIVE' && io) io.emit('setup-resolved', { setupId: row.id, setupType: row.setup_type, resolution: 'TARGET_HIT' });
        count++;
      }
      continue;
    }

    // Custom resolution for COIL_SURGE: "did price move toward VWAP?"
    if (row.setup_type.startsWith('COIL_SURGE')) {
      const stop = row.stop_level;
      const t1 = row.t1_level;
      if (entry == null || stop == null || t1 == null) continue;
      const targetDist = Math.abs(t1 - entry);
      const currentPxQ = await query(`SELECT close::float FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= CURRENT_DATE - 5 ORDER BY ts DESC LIMIT 1`);
      const px = currentPxQ.rows[0]?.close;
      if (!px) continue;
      const currentDist = Math.abs(px - t1);
      const reverted = currentDist < targetDist * 0.5;
      const stopHit = long ? px <= stop : px >= stop;
      if (stopHit) {
        const pnl = (long ? (stop - entry) : (entry - stop)) * PNL_PER_POINT - COMMISSION;
        await query(`UPDATE active_setups SET status='RESOLVED', resolution='STOP_HIT', resolution_method='PRICE_CLEAN', actual_pnl=$2, resolved_at=NOW(), updated_at=NOW() WHERE id=$1 AND status=$3`, [row.id, Math.round(pnl * 100) / 100, statusMatch]);
        if (statusMatch === 'ACTIVE' && io) io.emit('setup-resolved', { setupId: row.id, setupType: row.setup_type, resolution: 'STOP_HIT' });
        count++;
      } else if (reverted) {
        const revertPts = Math.abs(px - entry);
        const pnl = revertPts * PNL_PER_POINT - COMMISSION;
        await query(`UPDATE active_setups SET status='RESOLVED', resolution='TARGET_HIT', resolution_method='VWAP_REVERT', actual_pnl=$2, price_at_resolution=$3, resolved_at=NOW(), updated_at=NOW() WHERE id=$1 AND status=$4`, [row.id, Math.round(pnl * 100) / 100, px, statusMatch]);
        if (statusMatch === 'ACTIVE' && io) io.emit('setup-resolved', { setupId: row.id, setupType: row.setup_type, resolution: 'TARGET_HIT' });
        count++;
      }
      continue;
    }

    // Level scalps and VWAP magnet resolve via standard target/stop logic below
    const stop = row.stop_level;
    const t1 = row.t1_level;
    if (entry == null || stop == null || t1 == null) continue;
    if (long && t1 <= entry) continue;
    if (!long && t1 >= entry) continue;

    const bars = { rows: sharedBarsRows.filter(b => b.ts > row.fired_at) };

    // Breakeven-then-trail (docs/SCALEOUT_RUNNER_SPEC.md): a non-null runner_trail_width
    // marks this row as using the dynamic path-dependent exit instead of the plain
    // fixed-stop/fixed-target logic below. Only FLOOR_R1_FADE_SHORT_TRAIL sets this today.
    const trailWidth = row.runner_trail_width;
    // Bank-vs-extend (promote_stackvol_to_tracked_setup, 2026-07-27): a non-null
    // extend_target_level marks this row (STACK_VOL_BREAK_LIVE_LONG/SHORT only, as of
    // 2026-07-27) as using the dynamic bars-to-target exit below instead of the plain
    // fixed-stop/fixed-target logic. Mutually exclusive with trailWidth -- no setup_type
    // sets both columns.
    const extendTarget = row.extend_target_level;

    let resolution = null, resolvedAt = null, priceAtRes = null, method = null;
    let runMfe = 0, runMae = 0, barCount = 0;
    // Bar-6 checkpoint (RESEARCH_CLAIM engagement_bar6_worst_point_passed,
    // docs/OPEN_THREADS.md 2026-07-23): among touches still undecided (not stopped or
    // targeted) 6 bars after entry, whether the worst adverse excursion already happened
    // (bars 0-2, "recovering") vs is still fresh (bars 3-6, "deteriorating") cleanly
    // separates real outcomes on every payoff dimension. Informational only, same
    // convention as touch_quality just below — never affects resolution/pnl/entry. Does
    // NOT delay or gate the original entry alert (user explicitly did not want to risk
    // missing the fast, clean winners that make up most of the touch population).
    // Trail-mechanism state — recomputed from scratch on every poll (this function
    // already re-walks the full bar range from fired_at every call, same as MAE/MFE
    // above), never resumed from a saved cursor. Written back at the end regardless of
    // whether the row terminally resolves this poll, purely so the frontend card can
    // show "armed, trailing" (docs/SCALEOUT_RUNNER_SPEC.md §7) — never read as input.
    let armedAt = null, peakPrice = null, trailStopPrice = null;
    // Bank-vs-extend state -- same re-derive-from-scratch-every-poll convention as the
    // trail state above. `extending` flips true once the original t1 is reached in a
    // "grinding" 10-25 bar window (RESEARCH_CLAIM path_quality_bars_to_target_predicts_
    // continuation); false the whole way through for a fast (<=9 bar) bank or a slow
    // (>25 bar, unvalidated-to-extend) arrival, both of which just take t1 normally.
    let extending = false;

    for (const bar of bars.rows) {
      barCount++;
      const favorable = long ? bar.high - entry : entry - bar.low;
      const adverse   = long ? entry - bar.low  : bar.high - entry;
      runMfe = Math.max(runMfe, favorable);
      runMae = Math.max(runMae, adverse);

      if (extendTarget != null) {
        // bar.ts is ET wall-clock TEXT (see the fired_at comment atop this function).
        const isSessionEnd = bar.ts.slice(11, 13) >= '16';
        const stopHit = long ? bar.low <= stop : bar.high >= stop;

        if (!extending) {
          const t1Hit = long ? bar.high >= t1 : bar.low <= t1;
          if (t1Hit && stopHit) {
            // Conservative: assume stop hit first (worst case), same convention as the
            // plain branch below.
            resolution = 'STOP_HIT'; method = 'SAME_BAR_STOP_FIRST';
            resolvedAt = bar.ts; priceAtRes = stop;
          } else if (stopHit) {
            resolution = 'STOP_HIT'; method = 'PRICE_CLEAN';
            resolvedAt = bar.ts; priceAtRes = stop;
          } else if (t1Hit) {
            const barsToTarget = barCount - 1; // 0 = reached on the very first bar, matches
                                                // pilot_path_quality_at_target.mjs's own convention
            if (barsToTarget <= 9) {
              // Fast arrival = climax spike -- bank now, extending destroyed value on backtest
              // (median -$135/trade on the fastest quartile).
              resolution = 'TARGET_HIT'; method = 'BANKED_FAST_ARRIVAL';
              resolvedAt = bar.ts; priceAtRes = t1;
            } else if (barsToTarget <= 25) {
              // Grinding arrival = real trend, rigor-clean +$34.75/trade median to extend.
              // Original stop_level is NEVER moved once extending -- the validated
              // FLAT_WIDE_150 design keeps the same stop throughout, it does not ratchet
              // to breakeven (unlike the trailWidth mechanism above, which is a different
              // exit design entirely).
              extending = true;
            } else {
              // >25 bars: only thinly positive on backtest, not independently rigor-clean
              // (see RESEARCH_CLAIM path_quality_bars_to_target_predicts_continuation) --
              // the OPEN_DECISION this mechanism implements only validated the 10-25 bar
              // window as worth extending, so this defaults to banking like a fast arrival.
              resolution = 'TARGET_HIT'; method = 'BANKED_SLOW_ARRIVAL';
              resolvedAt = bar.ts; priceAtRes = t1;
            }
          }
          if (!resolution && isSessionEnd) {
            resolution = 'TIME_EXPIRED'; method = 'MARK_TO_MARKET';
            resolvedAt = bar.ts; priceAtRes = bar.close;
          }
        } else {
          const extHit = long ? bar.high >= extendTarget : bar.low <= extendTarget;
          if (stopHit) {
            resolution = 'STOP_HIT'; method = 'EXTEND_STOP_HIT';
            resolvedAt = bar.ts; priceAtRes = stop;
          } else if (extHit) {
            resolution = 'TARGET_HIT'; method = 'EXTENDED_TARGET_HIT';
            resolvedAt = bar.ts; priceAtRes = extendTarget;
          } else if (isSessionEnd) {
            resolution = 'TIME_EXPIRED'; method = 'EXTEND_TIME_EXPIRED';
            resolvedAt = bar.ts; priceAtRes = bar.close;
          }
        }
        if (resolution) break;
        continue;
      }

      if (trailWidth != null) {
        // bar.ts is ET wall-clock TEXT (see the fired_at comment atop this function).
        // Delegates to the shared step function (server/services/breakevenTrailWalker.js,
        // extracted 2026-08-10, roadmap Phase 3 I4) instead of an inline reimplementation
        // — the exact same function is exercised by
        // scripts/test_breakeven_trail_walker_synthetic.mjs's synthetic price paths, so
        // "the trail mechanism works" is now a provable, re-runnable claim about this
        // live code path itself, not just about scripts/backtest_breakeven_trail.mjs's
        // separate simulation. Byte-behavior-identical to the prior inline version
        // (matches backtest_breakeven_trail.mjs's own simulation exactly, including the
        // same-bar-arm-and-breach scratch case — resolution_method strings kept <=20
        // chars, see the shared module's own header for the VARCHAR(20) history).
        const step = stepBreakevenTrail(
          { armedAt, peakPrice, trailStopPrice },
          bar,
          { entry, stop, t1, trailWidth, long }
        );
        armedAt = step.state.armedAt;
        peakPrice = step.state.peakPrice;
        trailStopPrice = step.state.trailStopPrice;
        if (step.resolution) {
          resolution = step.resolution.resolution;
          method = step.resolution.method;
          resolvedAt = bar.ts;
          priceAtRes = step.resolution.priceAtRes;
        }
        if (resolution) break;
        continue;
      }

      const t1Hit = long ? bar.high >= t1 : bar.low <= t1;
      const stopHit = long ? bar.low <= stop : bar.high >= stop;
      if (t1Hit && stopHit) {
        // Conservative: assume stop hit first (worst case for the trader)
        resolution = 'STOP_HIT';
        method = 'SAME_BAR_STOP_FIRST';
        resolvedAt = bar.ts;
        priceAtRes = stop;
        break;
      } else if (t1Hit) {
        resolution = 'TARGET_HIT';
        method = 'PRICE_CLEAN';
        resolvedAt = bar.ts;
        priceAtRes = t1;
        break;
      } else if (stopHit) {
        resolution = 'STOP_HIT';
        method = 'PRICE_CLEAN';
        resolvedAt = bar.ts;
        priceAtRes = stop;
        break;
      }
    }

    // Persist the bar-6 checkpoint once bars 0-6 have actually been observed (the loop
    // above only reaches barCount>=7 for a touch that's genuinely still undecided at that
    // point — a fast STOP_HIT/TARGET_HIT breaks the loop earlier, which correctly means no
    // checkpoint is written, matching the research population exactly). Never overwritten
    // once set (WHERE bar6_checkpoint IS NULL), same convention as touch_quality below.
    //
    // Consolidated 2026-07-27 (formalize_trade_management_as_first_class_system): this used
    // to track worstAdverse6/worstAdverseBarIdx6/bar6Close inline, a second, independent
    // reimplementation of the exact same worst-bar-index-of-adverse-excursion logic already
    // in computeBar6Checkpoint() (maeMfeReplay.js, used by every backtest/verification
    // script). Both are mathematically equivalent (same argmax, same tie-break), but two
    // copies of one calculation is exactly the reimplementation-drift risk this codebase has
    // been burned by before — and in fact WAS the root cause of the persisted-vs-recomputed
    // mismatch found 2026-07-26 (bar6_checkpoint_persisted_vs_recomputed_mismatch, 3/121
    // rows, ~2.5%). `bars.rows` (the full bar array from fired_at) is already available
    // before this loop starts, so calling the shared function directly needs no restructure
    // of the main STOP_HIT/TARGET_HIT walk above — just one call after it, gated the same way
    // (barCount>=7 means the walk reached bar 7 without an early resolution breaking it).
    //
    // bar6_exit_recommended (added 2026-07-26) — RESEARCH_CLAIM
    // target_distance_predictor_real_data_validation_cleared: the frozen exit rule
    // (targetDistFraction < 0.873, computeExitRuleAtBar6 in maeMfeReplay.js) cleared its
    // N>=20 real-data validation bar (N=57, +$1,260 live-confirmed) — user asked for this to
    // become a distinct, more assertive "EXIT NOW" recommendation, not folded into the
    // existing passive RECOVERING/DETERIORATING badge. Still purely informational: this
    // system has no order/broker execution capability at all, so it can never auto-close a
    // position — only ever a stronger-worded recommendation than the existing checkpoint.
    if (barCount >= 7) {
      const bar6 = computeBar6Checkpoint(bars.rows, entry, stop, t1, long ? 'LONG' : 'SHORT', PNL_PER_POINT, COMMISSION);
      if (bar6) {
        await query(
          `UPDATE active_setups SET bar6_checkpoint=$2, bar6_exit_recommended=$3, updated_at=NOW() WHERE id=$1 AND bar6_checkpoint IS NULL`,
          [row.id, bar6.status, bar6.ruleSaysExit]
        ).catch(() => {});
      }
    }

    // Cumulative-delta-confirmation badge (added 2026-07-28) — purely informational,
    // same "compute once, never overwrite" convention as bar6_checkpoint above. Scoped
    // exactly to what's been validated (RESEARCH_CLAIM cumulative_delta_confirms_
    // breakout_beyond_price_alone / cumulative_delta_confirms_fades_stronger_than_
    // breakout) — getDeltaConfirmationCategory() returns null for every setup_type NOT
    // covered (the "OTHER" session-structure family, Globex/overnight variants), so this
    // is a silent no-op for those until they have their own validated category. Does NOT
    // gate entry or adjust the target — both tested separately and failed
    // (pre_entry_cumulative_delta_no_entry_edge, target_extension_on_confirmation_not_actionable).
    {
      const deltaCategory = getDeltaConfirmationCategory(row.setup_type);
      const deltaThreshold = deltaCategory ? deltaCalib[deltaCategory] : null;
      if (deltaCategory && deltaThreshold != null) {
        const dc = classifyDeltaConfirmation(bars.rows, long ? 'LONG' : 'SHORT', entry, deltaThreshold);
        if (dc) {
          await query(
            `UPDATE active_setups SET delta_confirmation_state=$2, updated_at=NOW() WHERE id=$1 AND delta_confirmation_state IS NULL`,
            [row.id, dc.state]
          ).catch(() => {});
        }
      }
    }

    // Mark-to-market TIME_EXPIRED for the plain (non-trail) case: the trail branch
    // above already handles its own timeout via isSessionEnd, but this general branch
    // had no equivalent -- a setup that never hit stop/target just fell through to
    // expireStaleSetups() (a separate, later call in the same poll cycle), which force-
    // closes it with resolution='TIME_EXPIRED' and NEVER sets actual_pnl, leaving a
    // permanent null. Found 2026-07-20 while recovering 341 historical rows with this
    // exact shape (TRT_LONG/SHORT and 16 other setup_types) -- confirmed still live via
    // 42 more null rows, some fired as recently as 2026-07-17, proving this wasn't a
    // one-off from a deleted script but an ongoing structural gap. Fixed at the source:
    // once expires_at has passed and at least one real bar was seen, mark-to-market at
    // the last available bar's close instead of leaving the row for expireStaleSetups()
    // to null out. Genuinely bar-data-less rows (fired but price_bars_primary never got
    // a bar after) are left for expireStaleSetups() -- there's no price to mark against.
    if (!resolution && trailWidth == null && bars.rows.length > 0 && row.expires_at && nowEt >= row.expires_at) {
      const lastBar = bars.rows[bars.rows.length - 1];
      resolution = 'TIME_EXPIRED';
      method = 'MARK_TO_MARKET';
      resolvedAt = lastBar.ts;
      priceAtRes = lastBar.close;
    }

    // Touch-quality (order-flow) — informational only, side-effect UPDATE, never
    // influences resolution/pnl above or below. Fires once per setup, once its
    // calibrated reaction window has elapsed (or the setup resolves first,
    // whichever comes first). See server/services/touchQuality.js and
    // docs/OPEN_THREADS.md "Touch-quality" thread. Wrapped defensively — this is
    // non-critical, must never block real setup resolution if it throws.
    if (!row.touch_quality) {
      try {
        const calib = (await getTouchQualityCalib())[row.setup_type];
        const availableBars = resolution ? barCount : bars.rows.length;
        // Classify once the full calibrated window has elapsed, OR once the setup
        // resolves early (using whatever bars it actually got) — matches
        // scripts/calibrate_touch_quality.mjs's own windowing exactly. Previously
        // required availableBars >= calib.windowBars even when resolution had
        // already happened, so any trade resolving faster than its own type's
        // calibrated window (~25% of trades by construction, since the window is
        // that type's own p25 bars-to-resolution) got skipped this cycle, then
        // flipped to status='RESOLVED' and dropped out of the `active` query
        // forever — touch_quality stayed permanently NULL. Found in code review
        // 2026-07-15.
        if (calib && (resolution || availableBars >= calib.windowBars)) {
          const win = bars.rows.slice(0, Math.min(calib.windowBars, availableBars));
          let mae = 0, maeAtBar1 = null, maeAtWindowEnd = 0;
          win.forEach((bar, i) => {
            const adverse = long ? entry - bar.low : bar.high - entry;
            mae = Math.max(mae, adverse);
            if (i === 0) maeAtBar1 = mae;
            maeAtWindowEnd = mae;
          });
          const gaveFurtherGround = maeAtWindowEnd > (maeAtBar1 ?? 0) + 0.01;
          const baseline = await getTouchQualityBaseline(row.trade_date);
          const tq = classifyTouch({
            windowBars: win, direction: long ? 'LONG' : 'SHORT', baseline,
            highVolZCutoff: calib.highVolZCutoff, gaveFurtherGround,
          });
          if (tq) {
            await query(
              `UPDATE active_setups SET touch_quality=$2, touch_quality_vol_z=$3, updated_at=NOW() WHERE id=$1 AND touch_quality IS NULL`,
              [row.id, tq.bucket, Math.round(tq.maxVolZ * 100) / 100]
            );
          }
        }
      } catch (e) {
        console.error('touch-quality classification error (non-critical):', e.message);
      }
    }

    if (!resolution) {
      // Trail-eligible and armed but not yet resolved this poll: persist the in-progress
      // state purely for display (docs/SCALEOUT_RUNNER_SPEC.md §7 — the card should show
      // "armed, trailing Npt" once armedAt is set). Never read back as input — see the
      // comment on the `active` SELECT above.
      if (trailWidth != null && armedAt != null) {
        const newPeak = Math.round(peakPrice * 100) / 100;
        const newTrail = Math.round(trailStopPrice * 100) / 100;
        // Found 2026-07-27 (answering "how do I tell if a setup was modified"): this used
        // to fire unconditionally every ~15s poll while a trail is armed, regardless of
        // whether peak/trail actually moved -- if updated_at were added blindly here (as
        // it should be, to make updated_at a real "has this row changed" signal) it would
        // just track "last polled," not "actually ratcheted." Guarded so it's a no-op
        // (and updated_at stays put) when nothing has genuinely moved.
        await query(
          `UPDATE active_setups SET breakeven_armed_at=$2, runner_peak_price=$3, runner_trail_price=$4, updated_at=NOW()
           WHERE id=$1 AND (runner_peak_price IS DISTINCT FROM $3 OR runner_trail_price IS DISTINCT FROM $4 OR breakeven_armed_at IS DISTINCT FROM $2)`,
          [row.id, armedAt, newPeak, newTrail]
        ).catch(() => {});
      }
      // Bank-vs-extend eligible and now extending but not yet resolved this poll: persist
      // purely for display (so a future card can show "extending toward the wider target"),
      // same never-read-back-as-input convention as the trail state just above.
      if (extendTarget != null && extending) {
        await query(
          `UPDATE active_setups SET extend_decision='EXTENDING', updated_at=NOW() WHERE id=$1 AND extend_decision IS DISTINCT FROM 'EXTENDING'`,
          [row.id]
        ).catch(() => {});
      }
      continue;
    }

    // priceAtRes already holds the correct exit price for every resolution type above
    // (t1 for TARGET_HIT, stop for STOP_HIT, the ratcheted trail/breakeven price for
    // TRAIL_EXIT, the session-close price for TIME_EXPIRED) — one formula covers all of
    // them; this is not a behavior change for the pre-existing TARGET_HIT/STOP_HIT cases,
    // just a generalization to also cover the new trail-mechanism outcomes.
    const pnl = (long ? (priceAtRes - entry) : (entry - priceAtRes)) * PNL_PER_POINT - COMMISSION;

    const updated = await query(`
      UPDATE active_setups
      SET status='RESOLVED', resolution=$2, resolution_method=$3, actual_outcome=$2,
          actual_pnl=$4, price_at_resolution=$5, resolved_at=$6, updated_at=NOW(),
          mae_points=$8, mfe_points=$9, bars_to_resolution=$10,
          resolution_bar_time=$6, replay_resolution=$2,
          breakeven_armed_at=COALESCE($11, breakeven_armed_at),
          runner_peak_price=COALESCE($12, runner_peak_price),
          runner_trail_price=COALESCE($13, runner_trail_price)
      WHERE id=$1 AND status=$7
      RETURNING *
    `, [row.id, resolution, method, Math.round(pnl * 100) / 100, priceAtRes, resolvedAt, statusMatch,
        Math.round(runMae * 100) / 100, Math.round(runMfe * 100) / 100, barCount,
        armedAt, peakPrice != null ? Math.round(peakPrice * 100) / 100 : null,
        trailStopPrice != null ? Math.round(trailStopPrice * 100) / 100 : null]);

    if (updated.rows.length) {
      try { await dropToTimeline(updated.rows[0]); } catch (_) {}
      if (io) io.emit('setup-resolved', {
        setupId: row.id, setupType: row.setup_type, tradeDate: row.trade_date,
        resolution, resolutionMethod: method, actualPnl: updated.rows[0].actual_pnl,
      });
      count++;
    }
  }
  return count;
}

// ── Globex helpers ────────────────────────────────────────────────────────────

function nextTradingDay(etDate) {
  const d = new Date(etDate);
  d.setDate(d.getDate() + 1);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1); // Sun → Mon
  if (d.getDay() === 6) d.setDate(d.getDate() + 2); // Sat → Mon
  return d.toLocaleDateString('en-CA');
}

// Detect a Globex-session level fade. Checks current price against PD VAH/VAL/POC.
// Returns a setup descriptor (same shape as RTH active) or null.
// First 4 (2026-07-20): prior-period levels whose wider (overnight-inclusive) window was
// independently verified (see docs/OPEN_THREADS.md / OPEN_DECISION
// wider_window_level_fade_backtest_findings_20260720): two separate backtest
// implementations agree these are net-positive in the SHORT direction specifically —
// no sign flip, unlike PM_HIGH_LONG (rejected) or DAILY_OPEN (rejected, pure lookahead
// artifact). Only SHORT was verified for those 4 originally.
// Next 4 (2026-07-22): scoped from a broader 51-setup THIN_N candidate pass, verified via
// scripts/check_19_levels.mjs (an independent reimplementation against the same
// docs/WIDER_WINDOW_BACKTEST_20260720.md table — first Gemini pass had a real bug, a
// stray direction filter that inflated touch counts 1.5-3x; found and fixed directly
// before trusting the result). MONTHLY_OPEN is LONG-direction — the first 4's "SHORT
// only, LONG never tested" note applied to THOSE 4 specifically, not as a blanket rule;
// each level's own verified direction is now tracked per-entry via `dir` below rather
// than hardcoded, since this batch mixes directions.
// New, distinct setup_type names (not reused from the existing RTH-only siblings of the
// same level) so each genuinely new overnight-fired population gets its own
// SETUP_STATUS/OPTIMAL_STOP calibration rather than silently contaminating the RTH-only
// history already on file (e.g. 3M_VAL_FADE_SHORT, MPP_FADE_SHORT).
const WIDER_WINDOW_OVERNIGHT_LEVELS = [
  { levelName: '3M_VAL',        type: '3M_VAL_FADE_SHORT_OVERNIGHT',        displayName: '3M VAL',        dir: 'SHORT' },
  { levelName: '3M_POC',        type: '3M_POC_FADE_SHORT_OVERNIGHT',        displayName: '3M POC',        dir: 'SHORT' },
  { levelName: 'WS1',           type: 'WS1_FADE_SHORT_OVERNIGHT',           displayName: 'WS1',           dir: 'SHORT' },
  { levelName: 'PM_POC',        type: 'PM_POC_FADE_SHORT_OVERNIGHT',        displayName: 'PM POC',        dir: 'SHORT' },
  { levelName: 'MPP',           type: 'MPP_FADE_SHORT_OVERNIGHT',           displayName: 'MPP',           dir: 'SHORT' },
  { levelName: 'MONTHLY_OPEN',  type: 'MONTHLY_OPEN_FADE_LONG_OVERNIGHT',   displayName: 'Monthly Open',  dir: 'LONG' },
  { levelName: '10D_IB_MID',    type: '10D_IB_MID_FADE_SHORT_OVERNIGHT',    displayName: '10D IB Mid',    dir: 'SHORT' },
  { levelName: 'WR1',           type: 'WR1_FADE_SHORT_OVERNIGHT',           displayName: 'WR1',           dir: 'SHORT' },
];

// Dynamic SHADOW->ACTIVE promotion for the 4 wider-window overnight types above —
// mirrors minuteBarSignalDetector.js's getLiveStatus() exactly (N>=20 real resolved
// trades + EV>=-$5 to graduate), since these start at N=0 and have never fired live
// before. Without this they'd sit in SHADOW forever — nothing else in the pipeline
// would ever flip them, same footgun the New Setup Type checklist (CLAUDE.md) warns
// about for any standalone-poller-style detector.
async function getOvernightLevelLiveStatus(type) {
  const { rows } = await query(`
    SELECT COUNT(*) as n, AVG(actual_pnl)::float as ev
    FROM active_setups
    WHERE setup_type=$1 AND resolution IN ('TARGET_HIT','STOP_HIT') AND actual_pnl IS NOT NULL
  `, [type]);
  const n = +rows[0].n, ev = rows[0].ev != null ? +rows[0].ev : null;
  if (n < 20) return { status: 'SHADOW', reason: 'NEW_SIGNAL_UNDER_LIVE_EVALUATION', liveN: n, liveEv: ev };
  if (ev != null && ev < -5) return { status: 'SHADOW', reason: 'PERFORMANCE_BELOW_THRESHOLD', liveN: n, liveEv: ev };
  return { status: 'ACTIVE', reason: null, liveN: n, liveEv: ev };
}

// Same dynamic SHADOW->ACTIVE promotion pattern for STACK_VOL_BREAK_LIVE_LONG/SHORT
// (promote_stackvol_to_tracked_setup, 2026-07-27) -- N=0 real trades confirmed at build
// time (verify_stack_vol_break_live_actual_fire_globex_reachable), so every row must
// insert as SHADOW today, but per the New Setup Type checklist's standalone-poller rule
// this MUST be a live re-check every fire, not a hardcoded 'SHADOW' literal -- otherwise
// it would sit in SHADOW forever even once real forward data clears the bar. Checked
// per exact setup_type (LONG/SHORT calibrations differ -- 70pt vs 40pt target, direction-
// specific per stackvol_target_direction_specific_calibration_2026_07_27), not a LIKE
// pattern combining both.
async function getStackVolBreakLiveStatus(setupType) {
  const { rows } = await query(`
    SELECT COUNT(*) as n, AVG(actual_pnl)::float as ev
    FROM active_setups
    WHERE setup_type=$1 AND resolution IN ('TARGET_HIT','STOP_HIT') AND actual_pnl IS NOT NULL
  `, [setupType]);
  const n = +rows[0].n, ev = rows[0].ev != null ? +rows[0].ev : null;
  if (n < 20) return { status: 'SHADOW', reason: 'NEW_SIGNAL_UNDER_LIVE_EVALUATION', liveN: n, liveEv: ev };
  if (ev != null && ev < -5) return { status: 'SHADOW', reason: 'PERFORMANCE_BELOW_THRESHOLD', liveN: n, liveEv: ev };
  return { status: 'ACTIVE', reason: null, liveN: n, liveEv: ev };
}

async function detectGlobexSetup(sessionDate, io) {
  try {
    const [priceRow, pdRow, auditRow, widerLevelsRow, widerOptRow, pairAuditRow] = await Promise.all([
      query(`SELECT close::float as price FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= CURRENT_DATE - 5 ORDER BY ts DESC LIMIT 1`),
      query(`SELECT vah::float, val::float, poc::float FROM developing_value_log ORDER BY trade_date DESC LIMIT 1`),
      // FIXED 2026-08-05 (RESEARCH_CLAIM globexparams_raw_percentile_bug_pd_poc_vah_val): this
      // used to be the LIVE stop/target source for PD_VAH/VAL/POC via globexParams() below --
      // raw p75_mae/p50_mfe from UNIFIED_BACKTEST, the exact same bug class as the optStopQ
      // bug the 2026-08-03 fix addressed elsewhere, just in a path that fix never touched (its
      // own commit message only verified widerOptMap "was already correct", never audited this
      // separate query). Confirmed live: PD_POC_LONG's p75_mae drifted 68.75->84.0625 across
      // weeks, landing on sixteenths (PERCENTILE_CONT interpolation), while real OPTIMAL_STOP
      // for the same type sat at a stable, round stop=29. No longer the stop/target source --
      // kept ONLY as a divergence check against the real widerOptMap value (see auditMap below).
      query(`SELECT signal_name, p75_mae, p50_mfe FROM performance_audit
             WHERE signal_type='UNIFIED_BACKTEST' AND window_days=9999
               AND signal_name IN ('PD_VAH_SHORT','PD_VAL_LONG','PD_POC_SHORT','PD_POC_LONG')
             ORDER BY sample_size DESC`),
      // level_prices doesn't necessarily have a row for TODAY's exact date yet (these are
      // prior-week/month/quarter levels that only change when their period rolls over) —
      // DISTINCT ON + trade_date<=$1 gets the latest known value, matching the "valid
      // until superseded" convention already used throughout this codebase for prior-
      // period levels rather than requiring an exact same-day match.
      query(`
        SELECT DISTINCT ON (level_name) level_name, price::float as price
        FROM level_prices
        WHERE level_name = ANY($1) AND trade_date <= $2
        ORDER BY level_name, trade_date DESC
      `, [WIDER_WINDOW_OVERNIGHT_LEVELS.map(l => l.levelName), sessionDate]),
      query(`
        SELECT DISTINCT ON (signal_name) signal_name, optimal_stop::float as stop, optimal_target::float as target
        FROM performance_audit WHERE signal_type='OPTIMAL_STOP'
          AND signal_name = ANY($1)
        ORDER BY signal_name, run_date DESC
      `, [[...WIDER_WINDOW_OVERNIGHT_LEVELS.map(l => l.type), 'GLOBEX_VWAP_MAGNET_LONG', 'GLOBEX_VWAP_MAGNET_SHORT', 'GLOBEX_VWAP_FADE_LONG', 'GLOBEX_VWAP_FADE_SHORT',
          // Added 2026-08-05: the 3 original PD candidates now read the same real, EV-swept
          // calibration every other overnight level already uses -- see the auditRow comment
          // above for why they didn't before.
          'PD_VAH_FADE_SHORT', 'PD_VAL_FADE_LONG', 'PD_POC_FADE_SHORT', 'PD_POC_FADE_LONG']]),
      query(`SELECT signal_name, recommendation FROM performance_audit
             WHERE signal_type='CONFLUENCE_AUDIT_OVERNIGHT' AND signal_name LIKE 'PAIR:%'`),
    ]);
    if (!priceRow.rows[0] || !pdRow.rows[0]) return null;
    const px = priceRow.rows[0].price;
    const { vah, val, poc } = pdRow.rows[0];

    // Divergence assertion (2026-08-05): auditMap/globexParams are NO LONGER the live stop/
    // target source (see the auditRow query comment above) -- kept only to catch, loudly, if
    // this independent UNIFIED_BACKTEST-derived estimate and the real OPTIMAL_STOP sweep ever
    // drift far apart, which is either a sign one of the two pipelines broke, or a sign this
    // divergence check itself needs revisiting. DIVERGENCE_WARN_PCT=0.5 (50%) is a deliberately
    // loose plausibility bound, not a trading threshold -- the two are computed by genuinely
    // different methods (raw percentile vs EV-swept grid) and are not expected to match
    // closely, only to stay in the same neighborhood.
    const auditMap = {};
    for (const r of auditRow.rows) if (!auditMap[r.signal_name]) auditMap[r.signal_name] = r;
    const DIVERGENCE_WARN_PCT = 0.5;
    // Once-per-day-per-key dedup (2026-08-05): all 4 original PD types are KNOWN to diverge
    // right now (PD_POC_LONG ~190% apart -- that's the whole reason they were shadowed the
    // same night, see the PAUSED_UNTIL_ORIGIN_FILTER comment below). Logging that on every
    // ~15-60s poll from day one would bury the signal this check exists to surface -- if
    // every fire screams, the scream gets ignored within a week. Reuses the existing day-
    // scoped cache helper (getCached/setCached, already used throughout this file) rather
    // than a new mechanism. This does NOT silence a genuinely NEW divergence on a different
    // type -- that still logs the first time it's seen each day.
    function checkCalibrationDivergence(auditKey, liveStop, liveTarget) {
      const a = auditMap[auditKey];
      if (!a || liveStop == null) return;
      const auditStop = parseFloat(a.p75_mae);
      if (!auditStop || !isFinite(auditStop)) return;
      const pctDiff = Math.abs(liveStop - auditStop) / auditStop;
      if (pctDiff > DIVERGENCE_WARN_PCT) {
        const dedupKey = `globexDivergenceLogged:${auditKey}`;
        if (getCached(sessionDate, dedupKey, DAY_CACHE_TTL)) return;
        setCached(sessionDate, dedupKey, true);
        console.error(`[globex-calib-divergence] ${auditKey}: live OPTIMAL_STOP stop=${liveStop} vs UNIFIED_BACKTEST p75_mae=${auditStop} (${(pctDiff * 100).toFixed(0)}% apart, warn threshold ${DIVERGENCE_WARN_PCT * 100}%) -- one of these two independently-computed calibrations may be stale or wrong, investigate before trusting either. (logged once per day per key)`);
      }
    }

    // Live confluence pair-bonus lookup for Globex — same convention as the RTH
    // liveStats._pairBonus (server/routes/acd.js ~line 5202), just built fresh per poll
    // here since detectGlobexSetup() has no persistent per-day cache the way the RTH path
    // does. Reads backtest_confluence_globex.js's real CONFLUENCE_AUDIT_OVERNIGHT
    // recommendation='VALIDATED_PAIR' rows (5 pairs as of 2026-07-27: PD_IB_LOW+PD_LOW,
    // FLOOR_PIVOT+PD_SESSION_MID, PD_HIGH+PD_IB_HIGH, PD_CLOSE+PD_POC, CAM_S4+FLOOR_S1) —
    // resolves OPEN_DECISION globex_confluence_pair_bonus_needs_sizing_mechanism.
    const globexPairBonus = {}; // levelBase -> Set of partner levelBase names
    for (const r of pairAuditRow.rows) {
      if (r.recommendation !== 'VALIDATED_PAIR') continue;
      const [a, b] = r.signal_name.replace(/^PAIR:/, '').split('+');
      if (!a || !b) continue;
      (globexPairBonus[a] ??= new Set()).add(b);
      (globexPairBonus[b] ??= new Set()).add(a);
    }

    const TOUCH = 15; // proximity window — consistent with RTH level detection system-wide

    const pocDir = px >= poc ? 'SHORT' : 'LONG';
    const widerLevelPrices = {};
    for (const r of widerLevelsRow.rows) widerLevelPrices[r.level_name] = r.price;
    const widerOptMap = {};
    for (const r of widerOptRow.rows) widerOptMap[r.signal_name] = r;
    // Monday's overnight span (Sun 6PM ET open) is longer than a normal weekday's —
    // same stop/target split used by the wider-window verification backtest that
    // validated these 4 types, reused here rather than picking new numbers.
    const sessionIsMonday = new Date(sessionDate + 'T12:00:00').getDay() === 1;
    const flatStop = 45, flatTarget = 90;

    // ── Globex 24hr VWAP Magnet: sigma-based fade off the 24hr-spanning VWAP ──────────
    // The Globex sibling of the RTH VWAP_MAGNET_LONG/SHORT setup (~line 5310 below,
    // earlyVwap/getTrailingVwapStd) -- built 2026-07-28 directly from a user request that
    // the 24hr VWAP be tracked as a real, historical setup "like every other level," not
    // just the passive morningBrief.js text alert it was before (OPEN_DECISION
    // globex_24hr_vwap_never_tracked_as_real_setup). Reuses computeRunningVwapSeries
    // (developingValueService.js) and getTrailing24hrVwapStd/getGlobex24hrBars (queries.js,
    // themselves a relocation of morningBrief.js's already-validated 24hr-VWAP logic) --
    // no math re-derived here. Structurally different from every other candidate in this
    // array (not a fixed level_prices level -- a sigma-distance-from-a-moving-average
    // trigger), so it's computed separately and appended after the proximity filter below
    // rather than forced through the level/TOUCH shape. Resolves as a plain single T1/stop
    // trade via the standard resolveSetupsByPrice() path, matching what VWAP_MAGNET_LONG/
    // SHORT's own live rows already do (its "scale out" trade-brief text has never been
    // mechanically enforced -- the live INSERT never sets runner_trail_width/
    // extend_target_level, so it always resolves flat).
    // vwap24 is shared by both the magnet (sigma-distance) and fade (ordinary proximity)
    // candidates below -- computed once here rather than twice.
    let vwap24 = null;
    {
      const vwapBars = await getGlobex24hrBars(sessionDate);
      if (vwapBars.length > 50) {
        const vwapSeries = computeRunningVwapSeries(vwapBars);
        vwap24 = vwapSeries[vwapSeries.length - 1];
      }
    }

    let globexVwapCandidate = null;
    if (vwap24 != null) {
      const std24 = await getTrailing24hrVwapStd(sessionDate, 30);
      const dist = px - vwap24;
      if (Math.abs(dist) >= std24.threshold) {
        const dir = dist < 0 ? 'LONG' : 'SHORT';
        const vwapType = `GLOBEX_VWAP_MAGNET_${dir}`;
        globexVwapCandidate = {
          level: px, name: 'Globex 24hr VWAP', type: vwapType, dir,
          widerWindowNew: true,
          widerStop: widerOptMap[vwapType]?.stop ?? 30,
          widerTarget: widerOptMap[vwapType]?.target ?? 20,
          levelBase: 'GLOBEX_VWAP',
        };
      }
    }

    // Ordinary close-range VWAP touch (within the standard 15pt TOUCH window, same as every
    // other candidate below) -- distinct from the magnet's far-away sigma trigger just
    // above. Added 2026-07-28 per direct user pushback ("what about fades off the vwap?
    // those are trades too"). Direction is dynamic from current price side (matching PD
    // POC's own pocDir convention just below, the established pattern for a symmetric
    // central-tendency level with no inherent support/resistance bias), not a hardcoded
    // per-level direction like PD_VAH/PD_VAL.
    const globexVwapFadeDir = vwap24 != null ? (px >= vwap24 ? 'SHORT' : 'LONG') : null;

    const candidates = [
      // FIXED 2026-08-05: these 3 now carry widerStop/widerTarget from the real OPTIMAL_STOP
      // source too (widerOptMap, extended above), matching every other candidate here --
      // auditKey is kept only so checkCalibrationDivergence() below can still compare against
      // the old UNIFIED_BACKTEST estimate as a sanity check, not as the value actually used.
      { level: vah, name: 'PD VAH', type: 'PD_VAH_FADE_SHORT', dir: 'SHORT', auditKey: 'PD_VAH_SHORT', levelBase: 'PD_VAH',
        widerWindowNew: true, widerStop: widerOptMap['PD_VAH_FADE_SHORT']?.stop ?? flatStop, widerTarget: widerOptMap['PD_VAH_FADE_SHORT']?.target ?? flatTarget },
      { level: val, name: 'PD VAL', type: 'PD_VAL_FADE_LONG',  dir: 'LONG',  auditKey: 'PD_VAL_LONG',  levelBase: 'PD_VAL',
        widerWindowNew: true, widerStop: widerOptMap['PD_VAL_FADE_LONG']?.stop ?? flatStop, widerTarget: widerOptMap['PD_VAL_FADE_LONG']?.target ?? flatTarget },
      { level: poc, name: 'PD POC', type: `PD_POC_FADE_${pocDir}`, dir: pocDir, auditKey: `PD_POC_${pocDir}`, levelBase: 'PD_POC',
        widerWindowNew: true, widerStop: widerOptMap[`PD_POC_FADE_${pocDir}`]?.stop ?? flatStop, widerTarget: widerOptMap[`PD_POC_FADE_${pocDir}`]?.target ?? flatTarget },
      ...WIDER_WINDOW_OVERNIGHT_LEVELS.map(l => ({
        level: widerLevelPrices[l.levelName] ?? null, name: l.displayName, type: l.type, dir: l.dir,
        widerWindowNew: true,
        widerStop: widerOptMap[l.type]?.stop ?? flatStop,
        widerTarget: widerOptMap[l.type]?.target ?? flatTarget,
        levelBase: l.levelName,
      })),
      {
        level: vwap24, name: 'Globex VWAP', type: `GLOBEX_VWAP_FADE_${globexVwapFadeDir}`, dir: globexVwapFadeDir,
        widerWindowNew: true,
        widerStop: widerOptMap[`GLOBEX_VWAP_FADE_${globexVwapFadeDir}`]?.stop ?? flatStop,
        widerTarget: widerOptMap[`GLOBEX_VWAP_FADE_${globexVwapFadeDir}`]?.target ?? flatTarget,
        levelBase: 'GLOBEX_VWAP_FADE',
      },
    ].filter(c => c.level != null && Math.abs(px - c.level) <= TOUCH)
     .concat(globexVwapCandidate ? [globexVwapCandidate] : []);

    for (const c of candidates) {
      const existing = await query(
        `SELECT 1 FROM active_setups WHERE trade_date=$1 AND setup_type=$2 LIMIT 1`,
        [sessionDate, c.type]
      );
      if (existing.rows.length) {
        logGatedCandidate({ tradeDate: sessionDate, setupType: c.type, gateName: 'GLOBEX_ALREADY_FIRED_TODAY', gateReason: 'active_setups already has a row for this (trade_date, setup_type) today', entry: px });
        continue;
      }

      // Every candidate now carries widerStop/widerTarget from the real OPTIMAL_STOP source
      // (see the candidates array above) -- the old widerWindowNew-vs-globexParams() branch
      // is gone, this is unconditional now.
      const STOP = c.widerStop, T1 = c.widerTarget;
      if (c.auditKey) checkCalibrationDivergence(c.auditKey, STOP, T1);
      const isLong = c.dir === 'LONG';
      const entry  = px;
      const stop   = isLong ? px - STOP  : px + STOP;
      const target = isLong ? px + T1    : px - T1;

      // The 3 original PD candidates fire straight to ACTIVE unconditionally (existing,
      // unchanged behavior). The 4 wider-window candidates are brand new (N=0 live history)
      // — dynamically SHADOW-gated via getOvernightLevelLiveStatus(), same discipline as
      // minuteBarSignalDetector.js, until N>=20 real resolutions clear the bar.
      //
      // UN-PAUSED 2026-08-09: was shadowed 2026-08-05-through-08-09 via
      // PAUSED_UNTIL_ORIGIN_FILTER pending the stop-side origin_status re-baseline
      // (rawByType_origin_status_filter) -- that re-baseline landed today (see
      // docs/DECISIONS_LOG.md), so these 4 now read a stop computed from real
      // (origin_status-filtered), noise-floor-guarded data instead of the 79-89%-BACKFILL-
      // contaminated population that caused the pause. Reviewed by hand before re-enabling:
      // only PD_VAH_FADE_SHORT is actually SETUP_STATUS=ACTIVE right now (new stop=32,
      // volatility-scaled-default -- real N<20 for this type, so a safe default rather than
      // a real sweep result, but no longer contaminated); the other 3
      // (PD_VAL_FADE_LONG/PD_POC_FADE_SHORT/PD_POC_FADE_LONG) are independently gated
      // SUPPRESS/SUPPRESS/THIN_N by the unified SETUP_STATUS pipeline regardless of this
      // code-level flag, so un-pausing them here doesn't put them live -- verified directly,
      // not assumed.
      const live = c.widerWindowNew
        ? await getOvernightLevelLiveStatus(c.type)
        : { status: 'ACTIVE', reason: null };

      // Minimal Globex sizeMultiplier: just the validated pair-bonus factor, matching
      // RTH's +0.15x convention exactly (single check, doesn't stack across multiple
      // partners). `candidates` is already this poll's full within-TOUCH set, so any
      // OTHER candidate here IS a same-instant confluence partner by construction.
      const otherLevelBases = new Set(candidates.filter(x => x !== c).map(x => x.levelBase));
      const pairPartners = globexPairBonus[c.levelBase];
      const confluencePairPartner = pairPartners ? [...pairPartners].find(p => otherLevelBases.has(p)) ?? null : null;
      const sizeMultiplier = confluencePairPartner ? 1.15 : 1.0;

      // Globex setups expire at next RTH open (9:30 AM ET, next calendar day)
      const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const expDate = new Date(etNow);
      if (etNow.getHours() >= 18) expDate.setDate(expDate.getDate() + 1);
      expDate.setHours(9, 30, 0, 0);
      const expiresAt = `${expDate.getFullYear()}-${String(expDate.getMonth()+1).padStart(2,'0')}-${String(expDate.getDate()).padStart(2,'0')} 09:30:00`;

      // idx_as_unique_setup is a PARTIAL unique index (WHERE status IN ('ACTIVE','SHADOW'))
      // as of 2026-07-16 -- was a blanket index on every status value, which meant a
      // re-touch's second row (the fix that lets a genuine re-touch open a fresh ACTIVE
      // row after an earlier one on the same day already closed, see docs/OPEN_THREADS.md)
      // could never itself resolve: its UPDATE to status='RESOLVED'/'EXPIRED' collided
      // with the FIRST row already occupying that exact (trade_date, setup_type, status)
      // slot, throwing "duplicate key value violates unique constraint" on every single
      // 15s poll for any type that had re-touched that day. Confirmed live via
      // journalctl -- three call sites (resolveSetupsByPrice, expireStaleSetups,
      // structurallyInvalidateSetups) were all hitting it. Scoping the index to only
      // ACTIVE/SHADOW preserves the original anti-duplicate-insert guarantee (still only
      // one open row per type per day) while allowing unlimited RESOLVED/EXPIRED rows to
      // accumulate, which is what real re-touches actually produce. Every ON CONFLICT
      // clause against this table must repeat the same WHERE predicate as an inference
      // clause (Postgres requires this to match a partial index) -- all 6 updated together.
      // confluenceLevels: `candidates` is already the full set of levels within TOUCH of
      // px this poll (the .filter() above) -- no separate nearLevels computation needed,
      // unlike the RTH engine. Persisted 2026-07-22 (same fields as the RTH INSERT) so
      // overnight confluence combinations become queryable the same way RTH ones are.
      // size_multiplier now fed by the pair-bonus check above (2026-07-27, resolves
      // OPEN_DECISION globex_confluence_pair_bonus_needs_sizing_mechanism) — informational
      // only, same as RTH, since this app has no broker execution capability.
      const regimeStamp = computeRegimeStamp(entry, await getValueAreaRegimeMap(sessionDate));
      const fireTags = await computeFireTags(sessionDate, 'GLOBEX', etNow.getHours() * 60 + etNow.getMinutes());
      const ins = await query(`
        INSERT INTO active_setups (
          trade_date, setup_type, fired_at, expires_at, status, origin_status,
          entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label,
          price_at_detection, historical_win_rate, historical_sessions, suppression_reason,
          confluence_score_at_detection, confluence_levels_at_detection, size_multiplier,
          ${REGIME_STAMP_COLS.join(', ')}, ${FIRE_TAG_COLS.join(', ')}, bet_class
        ) VALUES ($1,$2,NOW(),$3,$10,$10,$4,$5,$6,$7,$8,$9,NULL,NULL,$11,$12,$13,$14,
          ${REGIME_STAMP_COLS.map((_, i) => `$${15 + i}`).join(', ')},
          ${FIRE_TAG_COLS.map((_, i) => `$${15 + REGIME_STAMP_COLS.length + i}`).join(', ')},
          $${15 + REGIME_STAMP_COLS.length + FIRE_TAG_COLS.length})
        ON CONFLICT DO NOTHING
        RETURNING id, trade_date, fired_at::text as fired_at, setup_type, entry_zone_low, entry_zone_high,
                  stop_level, t1_level, t1_label, historical_win_rate, historical_sessions, expires_at
      `, [sessionDate, c.type, expiresAt, entry, entry, stop, target, `T1: ${Math.round(T1)}pt (${c.name})`, entry,
          live.status, live.reason,
          candidates.length,
          candidates.map(x => x.name),
          sizeMultiplier,
          ...regimeStampValues(regimeStamp),
          ...fireTagValues(fireTags),
          // 'GLOBEX_LEVEL' hardcoded directly (roadmap Phase 7, Setup F consolidation,
          // 2026-08-11) rather than getBetClass(c.type) -- this function only ever inserts
          // rows it KNOWS are Globex fires, but 4 of its own setup_type names
          // (PD_VAH_FADE_SHORT/PD_VAL_FADE_LONG/PD_POC_FADE_SHORT/PD_POC_FADE_LONG) are
          // IDENTICAL strings to their RTH siblings -- getBetClass() has no way to tell
          // them apart by name alone and was silently classifying every Globex fire of
          // these 4 types as 'VALUE_FADE' (confirmed live: 300/304 historical rows across
          // these 4 types). Since this insert site already has ground truth (it's Globex,
          // unconditionally), skip the name-based inference entirely rather than trying to
          // teach getBetClass() session-awareness it doesn't have data to support for the
          // other ~180 setup_types that call it. See OPEN_DECISION
          // globex_ambiguous_names_need_session_backfill for the
          // still-open historical-data side of this (existing rows' bet_class not yet
          // corrected retroactively -- this fix only affects future fires).
          'GLOBEX_LEVEL']);

      if (!ins.rows[0]) continue; // ON CONFLICT — already exists

      // Every other insert path in this file drops a copy into trade_timeline_events —
      // detectGlobexSetup was the one exception (pre-existing gap, not introduced here,
      // flagged separately). Adding it for every candidate this function inserts (not
      // just the new wider-window ones) since it's a pure additive fix with no risk to
      // existing behavior.
      try { await dropToTimeline(ins.rows[0]); } catch (_) {}

      const rr = (Math.abs(target - entry) / Math.abs(entry - stop)).toFixed(1);
      if (live.status !== 'ACTIVE') continue; // SHADOW: logged for calibration, no live alert, keep checking other candidates

      if (io) io.emit('setup-detected', {
        type: c.type, direction: c.dir, entry, stop, target, rr,
        targetLabel: `T1: ${Math.round(T1)}pt (${c.name})`, globexMode: true,
        detectedAt: etNow.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true }),
      });

      return {
        type: c.type, direction: c.dir, entry, stop, target, rr,
        targetLabel: `T1: ${Math.round(T1)}pt (${c.name})`, globexMode: true,
        detectedAt: new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
          .toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
      };
    }
    return null;
  } catch (e) {
    console.error('[detectGlobexSetup]', e.message);
    return null;
  }
}

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
  const candidates = await query(`
    SELECT id, setup_type, trade_date::text as trade_date, entry_zone_low, entry_zone_high
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
    const long = isLongSetup(row.setup_type);
    const entry = row.entry_zone_high ?? row.entry_zone_low;
    let pnl = null;
    if (lastKnownClose != null && entry != null) {
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
export async function structurallyInvalidateSetups(io) {
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const [priceRow, acdRow] = await Promise.all([
    query(`SELECT close::float FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= CURRENT_DATE - 5 ORDER BY ts DESC LIMIT 1`),
    query(`SELECT or_high::float, or_low::float FROM acd_daily_log WHERE trade_date=$1`, [todayET]),
  ]);

  const currentPrice = priceRow.rows[0]?.close;
  const orHigh = acdRow.rows[0]?.or_high;
  const orLow  = acdRow.rows[0]?.or_low;
  if (!currentPrice || !orHigh || !orLow) return 0;

  // Bearish setups invalidated when price closes above OR High
  const bearishPattern = '%SHORT%,IB_BEARISH,C_STANDALONE_DOWN,FAILED_AUCTION_SHORT,VALUE_AREA_RESPONSIVE_SHORT'.split(',');
  const bullishPattern = '%LONG%,IB_BULLISH,C_STANDALONE_UP,FAILED_AUCTION_LONG,VALUE_AREA_RESPONSIVE_LONG'.split(',');

  const isBearish = (t) => t.includes('SHORT') || t.includes('BEARISH') || t === 'C_STANDALONE_DOWN' || t.includes('A_DOWN');
  const isBullish = (t) => t.includes('LONG')  || t.includes('BULLISH') || t === 'C_STANDALONE_UP' || t.includes('A_UP');

  // Need fired_at and stop_level to compute how long the setup was active when invalidated.
  // minutes_active computed SQL-side (naive ET fired_at vs. naive-ET-converted NOW()) —
  // doing this in JS via `Date.now() - new Date(row.fired_at).getTime()` mixed a real UTC
  // instant with a fake-UTC Date (db.js's parser relabels raw ET wall-clock as UTC), which
  // inflated minutesActive by the ET/UTC offset (4hrs in EDT) and made POST_ENTRY/PRE_ENTRY
  // classification always resolve to POST_ENTRY. Same root cause as the resolveSetupsByPrice
  // fix above. Found 2026-06-30.
  const activeWithTime = await query(`
    SELECT id, setup_type, trade_date, stop_level, entry_zone_low, entry_zone_high,
      EXTRACT(epoch FROM ((NOW() AT TIME ZONE 'America/New_York') - fired_at)) / 60 as minutes_active
    FROM active_setups
    WHERE trade_date=$1 AND status='ACTIVE'
  `, [todayET]);

  let count = 0;
  for (const row of activeWithTime.rows) {
    const isBracket = row.setup_type.includes('BRACKET_BREAKOUT');
    let shouldInvalidate = false;

    if (isBracket) {
      const isLong = row.setup_type.includes('LONG');
      shouldInvalidate = isLong
        ? (row.stop_level != null && currentPrice <= row.stop_level)
        : (row.stop_level != null && currentPrice >= row.stop_level);
    } else {
      shouldInvalidate =
        (isBearish(row.setup_type) && currentPrice > orHigh) ||
        (isBullish(row.setup_type) && currentPrice < orLow);
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
    if (invalidationTiming === 'POST_ENTRY' && entry != null) {
      const long = isLongSetup(row.setup_type);
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

// Factory: needs io for socket events
export default function createACDRouter(io) {
  const router = express.Router();

  // GET /api/acd/volatility-regime
  // Phase 2 of the volatility-regime backtest (report-only Phase 1 confirmed
  // setups perform meaningfully better in HIGH-VOL-DIRECTIONAL mornings and
  // flat-to-worse in HIGH-VOL-CHOP). Live read-only monitor — does not affect
  // setup detection/resolution/classification.
  router.get('/acd/volatility-regime', async (req, res) => {
    try {
      const result = await computeLiveVolatilityRegime();
      res.json(result);
    } catch (e) {
      res.status(500).json({ available: false, reason: e.message });
    }
  });

  // GET /api/acd/gap-context
  // Detects open RTH-to-RTH gaps from the last 30 sessions and returns gap zones,
  // fill status, and current price relation. Read-only, no DB writes.
  router.get('/acd/gap-context', async (req, res) => {
    try {
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

      const rangesQ = await query(`
        SELECT d, rth_low, rth_high FROM (
          SELECT ts::date::text as d,
            MIN(low)::float as rth_low,
            MAX(high)::float as rth_high
          FROM price_bars_primary
          WHERE symbol='NQ'
            AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
            AND ts::date <= $1
          GROUP BY ts::date
          ORDER BY ts::date DESC
          LIMIT 40
        ) sub ORDER BY d ASC
      `, [todayET]);
      const sessions = rangesQ.rows;

      const priceQ = await query(`
        SELECT close::float as price FROM price_bars_primary
        WHERE symbol='NQ' AND ts::date = $1
        ORDER BY ts DESC LIMIT 1
      `, [todayET]);
      const currentPrice = priceQ.rows[0]?.price ?? null;

      if (sessions.length < 2) {
        return res.json({ gaps: [], currentPrice });
      }

      const gaps = [];
      for (let i = 1; i < sessions.length; i++) {
        const prev = sessions[i - 1];
        const curr = sessions[i];
        if (curr.rth_low > prev.rth_high) {
          gaps.push({ type: 'up', fromDate: prev.d, toDate: curr.d, gapLow: prev.rth_high, gapHigh: curr.rth_low });
        } else if (curr.rth_high < prev.rth_low) {
          gaps.push({ type: 'down', fromDate: prev.d, toDate: curr.d, gapLow: curr.rth_high, gapHigh: prev.rth_low });
        }
      }

      const openGaps = [];
      for (const gap of gaps) {
        const gapIdx = sessions.findIndex(s => s.d === gap.toDate);
        const gapSize = gap.gapHigh - gap.gapLow;
        let filled = false;
        let partialFillLow = gap.gapHigh; // lowest price reached inside gap (for up gaps)
        let partialFillHigh = gap.gapLow; // highest price reached inside gap (for down gaps)

        for (let i = gapIdx + 1; i < sessions.length; i++) {
          const s = sessions[i];
          if (gap.type === 'up') {
            partialFillLow = Math.min(partialFillLow, s.rth_low);
            if (s.rth_low <= gap.gapLow) { filled = true; break; }
          } else {
            partialFillHigh = Math.max(partialFillHigh, s.rth_high);
            if (s.rth_high >= gap.gapHigh) { filled = true; break; }
          }
        }

        if (!filled) {
          const sessionAge = sessions.length - 1 - gapIdx;
          let pctFilled = 0;
          if (gap.type === 'up' && partialFillLow < gap.gapHigh) {
            pctFilled = Math.min(100, (gap.gapHigh - partialFillLow) / gapSize * 100);
          } else if (gap.type === 'down' && partialFillHigh > gap.gapLow) {
            pctFilled = Math.min(100, (partialFillHigh - gap.gapLow) / gapSize * 100);
          }

          const priceInGap = currentPrice != null && currentPrice > gap.gapLow && currentPrice < gap.gapHigh;
          const priceAboveGap = currentPrice != null && currentPrice >= gap.gapHigh;
          const priceBelowGap = currentPrice != null && currentPrice <= gap.gapLow;
          const priceRelation = currentPrice == null ? null
            : priceAboveGap ? 'above' : priceBelowGap ? 'below' : 'inside';

          openGaps.push({
            type: gap.type,
            fromDate: gap.fromDate,
            toDate: gap.toDate,
            gapLow: gap.gapLow,
            gapHigh: gap.gapHigh,
            gapSize: Math.round(gapSize * 100) / 100,
            sessionAge,
            pctFilled: Math.round(pctFilled),
            ptsRemaining: Math.round((gapSize * (1 - pctFilled / 100)) * 100) / 100,
            priceRelation,
          });
        }
      }

      res.json({ gaps: openGaps, currentPrice });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/acd/vol-backtest-stats
  // Returns latest cached results from vol_backtest_cache (written by scripts/volatility_predictive_backtest.mjs).
  // Used by VolatilityRegimeCard to show expansion targets and continuation probability.
  router.get('/acd/vol-backtest-stats', async (req, res) => {
    try {
      const r = await query(
        `SELECT results, run_at FROM vol_backtest_cache ORDER BY id DESC LIMIT 1`
      );
      if (!r.rows.length) return res.json(null);
      res.json({ ...r.rows[0].results, cachedAt: r.rows[0].run_at });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/acd/trend-watch
  // Returns a 6-condition stack score predicting major directional moves.
  // Conditions: overnight_inventory, open_vs_value, prior day not TREND,
  // A signal aligned, IB range medium, cumulative delta aligned.
  // Score 4+/6 = alert. Includes historical context (range distributions) for each direction.
  router.get('/acd/trend-watch', async (req, res) => {
    try {
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

      const [arQ, priorQ, acdQ, ibQ, deltaQ] = await Promise.all([
        // 1. Auction reads — overnight inventory + open vs value
        query(`SELECT overnight_inventory, open_vs_prior_value FROM auction_reads WHERE trade_date = $1`, [todayET]),
        // 2. Prior day type
        query(`SELECT day_type FROM acd_daily_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 1`, [todayET]),
        // 3. Today's A signal
        query(`SELECT a_up_fired, a_down_fired,
          TO_CHAR(a_up_time, 'HH24:MI') AS a_up_et,
          TO_CHAR(a_down_time, 'HH24:MI') AS a_down_et
          FROM acd_daily_log WHERE trade_date = $1`, [todayET]),
        // 4. IB range today + rolling p33/p67 from last 60 sessions
        query(`
          WITH ib_hist AS (
            SELECT (ts AT TIME ZONE 'America/New_York')::date AS d,
              MAX(high::float) - MIN(low::float) AS ib_range
            FROM price_bars WHERE symbol='NQ'
              AND (EXTRACT(hour FROM ts AT TIME ZONE 'America/New_York')*60 +
                   EXTRACT(minute FROM ts AT TIME ZONE 'America/New_York')) BETWEEN 570 AND 629
              AND (ts AT TIME ZONE 'America/New_York')::date <= $1::date
            GROUP BY 1 ORDER BY 1 DESC LIMIT 61
          )
          SELECT
            (SELECT ib_range FROM ib_hist WHERE d = $1::date) AS today_ib,
            PERCENTILE_CONT(0.33) WITHIN GROUP (ORDER BY ib_range) AS p33,
            PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ib_range) AS p50,
            PERCENTILE_CONT(0.67) WITHIN GROUP (ORDER BY ib_range) AS p67
          FROM ib_hist WHERE d < $1::date
        `, [todayET]),
        // 5. Cumulative delta today + rolling p25/p75 from last 60 sessions
        query(`
          WITH delta_hist AS (
            SELECT (ts AT TIME ZONE 'America/New_York')::date AS d,
              SUM(COALESCE(ask_volume,0) - COALESCE(bid_volume,0)) AS cum_delta
            FROM price_bars WHERE symbol='NQ'
              AND (EXTRACT(hour FROM ts AT TIME ZONE 'America/New_York')*60 +
                   EXTRACT(minute FROM ts AT TIME ZONE 'America/New_York')) BETWEEN 570 AND 959
              AND (ts AT TIME ZONE 'America/New_York')::date <= $1::date
            GROUP BY 1 ORDER BY 1 DESC LIMIT 61
          )
          SELECT
            (SELECT cum_delta FROM delta_hist WHERE d = $1::date) AS today_delta,
            PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY cum_delta) AS p25,
            PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY cum_delta) AS p75
          FROM delta_hist WHERE d < $1::date
        `, [todayET]),
      ]);

      const ar = arQ.rows[0] || {};
      const priorDayType = priorQ.rows[0]?.day_type ?? null;
      const acd = acdQ.rows[0] || {};
      const ib = ibQ.rows[0] || {};
      const dl = deltaQ.rows[0] || {};

      const onInv = ar.overnight_inventory;
      const ovv = ar.open_vs_prior_value;

      // Determine direction: both pre-market conditions pointing same way = strong;
      // single condition or A signal only = weak
      let direction = null;
      if (onInv === 'LONG_TRAPPED' && ovv === 'BELOW_VALUE') direction = 'BEAR';
      else if (onInv === 'SHORT_TRAPPED' && ovv === 'ABOVE_VALUE') direction = 'BULL';
      else if (onInv === 'LONG_TRAPPED') direction = 'BEAR';
      else if (onInv === 'SHORT_TRAPPED') direction = 'BULL';
      if (!direction && acd.a_down_fired) direction = 'BEAR';
      if (!direction && acd.a_up_fired) direction = 'BULL';

      const todayIb   = ib.today_ib  != null ? parseFloat(ib.today_ib)  : null;
      const ibP33     = parseFloat(ib.p33), ibP67 = parseFloat(ib.p67), ibP50 = parseFloat(ib.p50);
      const cumDelta  = dl.today_delta != null ? parseFloat(dl.today_delta) : null;
      const dlP25     = parseFloat(dl.p25), dlP75 = parseFloat(dl.p75);

      const ibTierMedium = todayIb != null && todayIb >= ibP33 && todayIb <= ibP67;
      const ibTierLabel  = todayIb == null ? 'forming'
        : todayIb < ibP33 ? 'TIGHT' : todayIb > ibP67 ? 'WIDE' : 'MEDIUM';

      const deltaAligned   = cumDelta != null && ((direction === 'BEAR' && cumDelta < dlP25) || (direction === 'BULL' && cumDelta > dlP75));
      const deltaDiverging = cumDelta != null && ((direction === 'BEAR' && cumDelta > dlP75) || (direction === 'BULL' && cumDelta < dlP25));

      const conditions = [
        {
          key: 'inventoryAligned',
          label: 'Overnight inventory',
          met: direction === 'BEAR' ? onInv === 'LONG_TRAPPED' : direction === 'BULL' ? onInv === 'SHORT_TRAPPED' : false,
          value: onInv ?? 'unknown',
          when: 'pre-market',
          detail: onInv === 'LONG_TRAPPED' ? 'Longs trapped — forced sellers at open'
            : onInv === 'SHORT_TRAPPED' ? 'Shorts trapped — forced buyers at open'
            : 'Neutral inventory — no structural pressure',
        },
        {
          key: 'valueAligned',
          label: 'Open vs prior value',
          met: direction === 'BEAR' ? ovv === 'BELOW_VALUE' : direction === 'BULL' ? ovv === 'ABOVE_VALUE' : false,
          value: ovv ?? 'unknown',
          when: 'pre-market',
          detail: ovv === 'BELOW_VALUE' ? 'Opens below value — structure confirms bearish bias'
            : ovv === 'ABOVE_VALUE' ? 'Opens above value — structure confirms bullish bias'
            : 'Opens inside value — no structural edge',
        },
        {
          key: 'priorNotTrend',
          label: 'Prior day not Trend',
          met: priorDayType != null && priorDayType !== 'TREND',
          value: priorDayType ?? 'unknown',
          when: 'pre-market',
          detail: priorDayType === 'TREND' ? 'Prior TREND day — directional exhaustion likely, fades favored today'
            : priorDayType === 'TURBULENT' ? 'Prior TURBULENT — momentum can persist, p75 range 522pt follow-through'
            : priorDayType === 'BALANCE' ? 'Prior BALANCE — compression, directional follow-through 47%'
            : 'Unknown prior day',
        },
        {
          key: 'aSignal',
          label: 'A signal confirmed',
          met: direction === 'BEAR' ? !!acd.a_down_fired : direction === 'BULL' ? !!acd.a_up_fired : false,
          value: acd.a_down_fired ? `A Down ${acd.a_down_et || ''}` : acd.a_up_fired ? `A Up ${acd.a_up_et || ''}` : 'not fired',
          when: 'live',
          detail: (direction === 'BEAR' && acd.a_down_fired) ? `A Down fired${acd.a_down_et ? ` at ${acd.a_down_et}` : ''} — market accepted bearish extension`
            : (direction === 'BULL' && acd.a_up_fired) ? `A Up fired${acd.a_up_et ? ` at ${acd.a_up_et}` : ''} — market accepted bullish extension`
            : 'A signal not yet fired in expected direction',
        },
        {
          key: 'ibMedium',
          label: 'IB range medium',
          met: ibTierMedium,
          value: todayIb != null ? `${Math.round(todayIb)}pt (${ibTierLabel})` : 'IB forming',
          when: '10:30 AM',
          detail: ibTierMedium ? `Medium IB ${Math.round(todayIb)}pt — unresolved tension, directional break expected post-IB (49% hist dir close)`
            : ibTierLabel === 'TIGHT' ? `Tight IB ${Math.round(todayIb)}pt — smaller absolute moves, ${Math.round(ibP33)}pt threshold`
            : ibTierLabel === 'WIDE' ? `Wide IB ${Math.round(todayIb)}pt — volatile but often non-directional close (37% hist dir close). Watch for reversal.`
            : 'IB not yet closed',
        },
        {
          key: 'deltaConfirmed',
          label: 'Delta confirmed',
          met: deltaAligned,
          warning: deltaDiverging,
          value: cumDelta != null ? `${cumDelta > 0 ? '+' : ''}${Math.round(cumDelta).toLocaleString()}` : 'no data',
          when: 'live',
          detail: deltaAligned
            ? `Cumulative delta ${cumDelta > 0 ? 'strongly positive' : 'strongly negative'} — institutional flow confirms direction. Historical: ${direction === 'BEAR' ? 'p75 range 598pt on neg-delta bear days' : '60.7% bull-close rate on pos-delta days'}`
            : deltaDiverging
              ? `⚠ DELTA DIVERGING: flow contradicts price (${cumDelta > 0 ? 'buyers absorbing selling' : 'sellers absorbing rally'}) — potential reversal, not runner`
              : cumDelta != null ? 'Delta neutral — no institutional conviction yet'
              : 'No delta data for today',
        },
      ];

      const score = conditions.filter(c => c.met).length;

      // Historical context from backtests (hardcoded from empirical results)
      const hist = direction === 'BEAR'
        ? { dirRate: 45, deltaConfirmedDirRate: 60, p50Range: 371, p75Range: 522,
            deltaP75Range: 598, note: 'BEAR_CLOSE: p50=371pt, p75=522pt. Neg delta + bear context → p75=598pt' }
        : direction === 'BULL'
        ? { dirRate: 55, deltaConfirmedDirRate: 61, p50Range: 275, p75Range: 428,
            deltaP75Range: 353, note: 'BULL_CLOSE: p50=275pt, p75=428pt. Strong pos delta alone → 60.7% bull-close rate' }
        : { dirRate: 44, p50Range: 291, p75Range: 419, note: 'No direction signal yet — base rate 44% directional' };

      res.json({
        direction,
        score,
        maxScore: conditions.length,
        alert: score >= 4,
        conditions,
        historicalContext: hist,
        ibTierLabel,
        ibRaw: { today: todayIb != null ? Math.round(todayIb) : null, p33: Math.round(ibP33), p67: Math.round(ibP67) },
        deltaRaw: { today: cumDelta != null ? Math.round(cumDelta) : null, p25: Math.round(dlP25), p75: Math.round(dlP75) },
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/acd/today
  router.get('/acd/today', async (req, res) => {
    try {
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const today = await query('SELECT * FROM acd_daily_log WHERE trade_date = $1', [todayET]);

      const nlRow = await query(`
        SELECT COALESCE(SUM(daily_score), 0) as sum30,
               COALESCE(SUM(CASE WHEN rn <= 10 THEN daily_score ELSE 0 END), 0) as sum10
        FROM (SELECT daily_score, ROW_NUMBER() OVER (ORDER BY trade_date DESC) as rn FROM acd_daily_log ORDER BY trade_date DESC LIMIT 30) sub
      `);

      const recent = await query(`SELECT trade_date::text as trade_date, daily_score, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed FROM acd_daily_log ORDER BY trade_date DESC LIMIT 4`);
      let systemFailureWarning = null;
      for (const row of recent.rows.slice(1, 4)) {
        if ((row.a_up_fired && !row.c_up_confirmed) || (row.a_down_fired && !row.c_down_confirmed)) {
          const dir = row.a_up_fired ? 'A Up' : 'A Down';
          systemFailureWarning = `System failure check: ${dir} signal from ${row.trade_date} has not confirmed. Fisher's rule: if no follow-through within 2–3 sessions, exit immediately.`;
          break;
        }
      }

      const settings = await query('SELECT * FROM risk_settings ORDER BY id LIMIT 1');
      const aMultiplier = parseFloat(settings.rows[0]?.a_multiplier || 0.33);

      res.json({
        today: today.rows[0] || null,
        numberLine: { sum30: parseInt(nlRow.rows[0]?.sum30) || 0, sum10: parseInt(nlRow.rows[0]?.sum10) || 0 },
        systemFailureWarning,
        aMultiplier,
        todayDate: todayET,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/acd/daily
  router.post('/acd/daily', async (req, res) => {
    try {
      const { trade_date, or_high, or_low, a_multiplier = 0.33, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed, session_close, notes, profile_shape } = req.body;
      const aUpLevel   = or_high && or_low ? parseFloat(or_high) + (parseFloat(or_high) - parseFloat(or_low)) * a_multiplier : null;
      const aDownLevel = or_high && or_low ? parseFloat(or_low)  - (parseFloat(or_high) - parseFloat(or_low)) * a_multiplier : null;

      let score = 0;
      if (a_up_fired   && c_up_confirmed)   score =  4;
      else if (a_up_fired)                  score =  1;
      else if (a_down_fired && c_down_confirmed) score = -4;
      else if (a_down_fired)                score = -1;

      const r = await query(`
        INSERT INTO acd_daily_log (trade_date, or_high, or_low, a_multiplier, a_up_level, a_down_level, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed, daily_score, session_close, notes, profile_shape)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (trade_date) DO UPDATE SET
          or_high=$2, or_low=$3, a_multiplier=$4, a_up_level=$5, a_down_level=$6,
          a_up_fired=$7, a_down_fired=$8, c_up_confirmed=$9, c_down_confirmed=$10,
          daily_score=$11, session_close=$12, notes=$13,
          profile_shape=COALESCE($14, acd_daily_log.profile_shape)
        RETURNING *
      `, [trade_date, or_high, or_low, a_multiplier, aUpLevel, aDownLevel, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed, score, session_close, notes, profile_shape || null]);
      res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/daily
  router.get('/acd/daily', async (req, res) => {
    try {
      const days = parseInt(req.query.days) || 60;
      const r = await query(`SELECT *, trade_date::text as trade_date_str FROM acd_daily_log ORDER BY trade_date DESC LIMIT $1`, [days]);
      res.json(r.rows.map(row => ({ ...row, trade_date: row.trade_date_str })));
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/numberline
  router.get('/acd/numberline', async (req, res) => {
    try {
      const r = await query(`
        SELECT trade_date, daily_score,
               SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as sum30,
               SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 9 PRECEDING AND CURRENT ROW) as sum10
        FROM acd_daily_log
        ORDER BY trade_date DESC
        LIMIT 90
      `);
      const rows = r.rows;
      const latest = rows[0];
      const sum30 = parseInt(latest?.sum30) || 0;
      const sum10 = parseInt(latest?.sum10) || 0;
      const trend = sum30 > 9 ? 'TRENDING_UP' : sum30 < -9 ? 'TRENDING_DOWN' : 'RANGING';
      const quality = (trend !== 'RANGING' && Math.abs(sum30) > 15) ? 'HIGH' : (trend !== 'RANGING') ? 'MODERATE' : 'LOW';
      const momentumWarning = sum30 > 9 && sum10 < 5 ? 'Momentum weakening — trend may be losing conviction' :
                              sum30 < -9 && sum10 > -5 ? 'Bearish momentum weakening' : null;
      res.json({ sum30, sum10, trend, quality, momentumWarning, history: rows.slice(0, 30).reverse() });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/pivot/current
  router.get('/acd/pivot/current', async (req, res) => {
    try {
      const nowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
      const d = new Date(nowET);
      const monthYear = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const r = await query('SELECT * FROM acd_monthly_pivot WHERE month_year = $1', [monthYear]);
      res.json(r.rows[0] || null);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/acd/pivot
  router.post('/acd/pivot', async (req, res) => {
    try {
      const { month_year, prior_month_high, prior_month_low, prior_month_close } = req.body;
      const ph = parseFloat(prior_month_high), pl = parseFloat(prior_month_low), pc = parseFloat(prior_month_close);
      const pivot = (ph + pl + pc) / 3;
      const r1 = 2 * pivot - pl;
      const s1 = 2 * pivot - ph;
      const r = await query(`
        INSERT INTO acd_monthly_pivot (month_year, prior_month_high, prior_month_low, prior_month_close, pivot_level, pivot_r1, pivot_s1)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (month_year) DO UPDATE SET prior_month_high=$2, prior_month_low=$3, prior_month_close=$4, pivot_level=$5, pivot_r1=$6, pivot_s1=$7
        RETURNING *
      `, [month_year, ph, pl, pc, pivot, r1, s1]);
      res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/backtest/results
  router.get('/acd/backtest/results', async (req, res) => {
    try {
      const period = req.query.period || 'all-time';
      const r = await query('SELECT * FROM acd_backtest_results WHERE period=$1 ORDER BY ev_per_signal DESC NULLS LAST LIMIT 100', [period]);
      const lastRun = await query('SELECT MAX(run_date) as last_run FROM acd_backtest_results WHERE period=$1', [period]);
      res.json({ results: r.rows, lastRun: lastRun.rows[0]?.last_run || null });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/backtest/status
  router.get('/acd/backtest/status', (req, res) => {
    res.json({ status: acdJob.status, progress: acdJob.progress, error: acdJob.error });
  });

  // POST /api/acd/backtest/run

  router.post('/acd/backtest/run', csvUpload.single('csv'), async (req, res) => {
    if (acdJob.status === 'running') return res.status(409).json({ error: 'Backtest already running' });

    const csvPath  = req.file ? req.file.path : null;
    const useDB    = !csvPath;
    const days     = req.body?.days ? parseInt(req.body.days) : null;
    const startDate = days ? new Date(Date.now() - days * 86400000).toISOString().split('T')[0] : null;

    acdJob = { status: 'running', progress: { done: 0, total: 360, source: useDB ? 'db' : 'csv', days: days || 'all' }, result: null, error: null };
    res.json({ message: `Backtest started from ${useDB ? 'price bar database' : 'CSV'}${days ? ` (last ${days} days)` : ''}`, status: 'running' });

    setImmediate(async () => {
      try {
        const results = await runParameterSearch(csvPath, (p) => { acdJob.progress = { ...p, source: useDB ? 'db' : 'csv', days: days || 'all' }; }, startDate);

        const period = days ? `last-${days}d` : 'all-time';
        await query('DELETE FROM acd_backtest_results WHERE period=$1', [period]);
        const top = results.slice(0, 360);
        if (top.length > 0) {
          const cols = 18;
          const vals = [];
          const placeholders = top.map((r, i) => {
            const b = i * cols;
            const filterLabel = [
              r.params.nlAligned ? 'NL-aligned' : null,
              r.params.orRangeMax ? `OR<${r.params.orRangeMax}` : null,
              r.params.cConfirmedOnly ? 'C-only' : null,
            ].filter(Boolean).join('+') || 'baseline';
            vals.push(
              r.params.orMinutes, r.params.aMultiplier, r.params.sustainMinutes,
              r.totalSignals, r.winRate, r.avgWinR, r.avgLossR, r.payoffRatio,
              r.evPerTrade, r.profitFactor,
              r.nlAbove9?.winRate ?? null, r.nlBelow9?.winRate ?? null, r.nlRanging?.winRate ?? null,
              r.params.nlAligned ?? false, r.params.orRangeMax ?? null,
              r.params.cConfirmedOnly ?? false, filterLabel, period
            );
            return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},$${b+14},$${b+15},$${b+16},$${b+17},$${b+18})`;
          });
          await query(`INSERT INTO acd_backtest_results (or_minutes,a_multiplier,sustain_minutes,total_signals,win_rate,avg_win_r,avg_loss_r,payoff_ratio,ev_per_signal,profit_factor,win_rate_nl_above_9,win_rate_nl_below_9,win_rate_nl_ranging,nl_aligned,or_range_max,c_confirmed_only,filter_label,period) VALUES ${placeholders.join(',')}`, vals);
        }
        const bestPeriodPriority = ['last-30d', 'last-60d', 'all-time'];
        const bestPeriodToUse = bestPeriodPriority.includes(period) ? period : 'all-time';
        const bestResult = top[0];
        if (bestResult) {
          await query(`
            UPDATE risk_settings SET
              acd_or_minutes=$1, acd_a_multiplier=$2, acd_sustain_minutes=$3,
              acd_best_params_period=$4, acd_best_params_ev=$5
          `, [bestResult.params.orMinutes, bestResult.params.aMultiplier, bestResult.params.sustainMinutes,
              bestPeriodToUse, bestResult.evPerTrade]);
          console.log(`ACD best params auto-saved: OR=${bestResult.params.orMinutes}m A=${bestResult.params.aMultiplier} sus=${bestResult.params.sustainMinutes} (${bestPeriodToUse}, EV=${bestResult.evPerTrade.toFixed(3)}R)`);
        }
        acdJob = { status: 'complete', progress: { done: top.length, total: results.length }, error: null };
      } catch(e) {
        acdJob = { status: 'error', progress: acdJob.progress, result: null, error: e.message };
      }
    });
  });

  // GET /api/acd/context
  router.get('/acd/context', async (req, res) => {
    try {
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

      const prevRes = await query(`
        SELECT DISTINCT ts::date::text as d FROM price_bars_primary
        WHERE symbol='NQ' AND ts::date < $1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        ORDER BY d DESC LIMIT 1
      `, [todayET]);
      if (!prevRes.rows.length) return res.json(null);
      const prevDate = prevRes.rows[0].d;

      const bars = await query(`
        SELECT high::float, low::float, volume::bigint
        FROM price_bars_primary
        WHERE symbol='NQ' AND ts::date = $1
          AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        ORDER BY ts
      `, [prevDate]);
      if (!bars.rows.length) return res.json(null);

      const TICK = 0.25;
      const volMap = {};
      for (const bar of bars.rows) {
        const h = Math.round(bar.high / TICK) * TICK;
        const l = Math.round(bar.low  / TICK) * TICK;
        const v = bar.volume || 1;
        const steps = Math.round((h - l) / TICK) + 1;
        const vPerStep = v / steps;
        for (let i = 0; i < steps; i++) {
          const p = Math.round((l + i * TICK) * 100) / 100;
          volMap[p] = (volMap[p] || 0) + vPerStep;
        }
      }
      const levels = Object.keys(volMap).map(Number).sort((a, b) => a - b);
      if (!levels.length) return res.json(null);

      const poc = levels.reduce((best, p) => volMap[p] > volMap[best] ? p : best, levels[0]);
      const pocIdx = levels.indexOf(poc);
      const totalVol = Object.values(volMap).reduce((s, v) => s + v, 0);
      const target = totalVol * 0.70;
      let vaVol = volMap[poc], lo = pocIdx, hi = pocIdx;
      while (vaVol < target) {
        const upVol = hi + 1 < levels.length ? volMap[levels[hi + 1]] : 0;
        const dnVol = lo - 1 >= 0 ? volMap[levels[lo - 1]] : 0;
        if (upVol >= dnVol && hi + 1 < levels.length) { hi++; vaVol += upVol; }
        else if (lo - 1 >= 0) { lo--; vaVol += dnVol; }
        else break;
      }
      const vah = levels[hi];
      const val = levels[lo];

      const sessionHigh  = Math.max(...bars.rows.map(b => b.high));
      const sessionLow   = Math.min(...bars.rows.map(b => b.low));

      // cacheSet imported at top
      const cacheKey = `acd-context-${todayET}`;
      const result = { prevDate, poc, vah, val, sessionHigh, sessionLow };
      cacheSet(cacheKey, result, 4 * 60 * 60 * 1000);
      res.json(result);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/acd/autocompute
  router.post('/acd/autocompute', async (req, res) => {
    try {
      const { date, or_minutes, a_multiplier, sustain_minutes } = req.body;
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const targetDate = date || todayET;
      const best = await getBestACDParams();
      const orMins   = or_minutes   ? parseInt(or_minutes)    : best.orMins;
      const aMult    = a_multiplier ? parseFloat(a_multiplier): best.aMult;
      const sustainM = sustain_minutes ? parseInt(sustain_minutes) : best.sustainMins;

      const result = await computeACDFromBars(targetDate, orMins, aMult, sustainM);
      if (!result) return res.status(404).json({ error: `No NQ bars found for ${targetDate}` });

      const r = await query(`
        INSERT INTO acd_daily_log (trade_date, or_high, or_low, a_multiplier, a_up_level, a_down_level, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed, daily_score, session_close)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (trade_date) DO UPDATE SET
          or_high=$2, or_low=$3, a_multiplier=$4, a_up_level=$5, a_down_level=$6,
          a_up_fired=$7, a_down_fired=$8, c_up_confirmed=$9, c_down_confirmed=$10,
          daily_score=$11, session_close=$12
        RETURNING *
      `, [targetDate, result.orHigh, result.orLow, aMult, result.aUpLevel, result.aDownLevel, result.aUpFired, result.aDownFired, result.cUpConfirmed, result.cDownConfirmed, result.score, result.sessionClose]);

      res.json({ ...result, saved: r.rows[0] });
    } catch(e) { console.error('autocompute error:', e); res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/structural-events/backfill/status
  router.get('/acd/structural-events/backfill/status', (req, res) => res.json(structuralBackfillJob));

  // POST /api/acd/structural-events/backfill
  router.post('/acd/structural-events/backfill', async (req, res) => {
    if (structuralBackfillJob.status === 'running')
      return res.status(409).json({ error: 'Backfill already running' });

    res.json({ message: 'Structural events backfill started' });
    structuralBackfillJob = { status: 'running', done: 0, total: 0, eventsAdded: 0, error: null };

    (async () => {
      try {
        const datesQ = await query(`
          SELECT al.trade_date::text as d
          FROM acd_daily_log al
          WHERE al.or_high IS NOT NULL
          ORDER BY al.trade_date ASC
        `);
        const dates = datesQ.rows.map(r => r.d);
        structuralBackfillJob.total = dates.length;
        console.log(`Structural events backfill: ${dates.length} dates to process`);

        const pmVaCache = {};

        for (const date of dates) {
          try {
            const [yr, mo] = date.split('-').map(Number);
            const monthKey = `${yr}-${String(mo).padStart(2,'0')}`;

            if (!pmVaCache[monthKey]) {
              const pmStart = new Date(Date.UTC(yr, mo - 2, 1)).toISOString().split('T')[0];
              const pmEndInclusive = new Date(Date.UTC(yr, mo - 1, 0)).toISOString().split('T')[0];
              const pmProfile = await computeVolumeProfileForRange(query, { startDate: pmStart, endDate: pmEndInclusive });
              pmVaCache[monthKey] = {
                pmVAH: pmProfile?.vah ?? null,
                pmVAL: pmProfile?.val ?? null,
              };
            }
            const { pmVAH, pmVAL } = pmVaCache[monthKey];

            const gLine = await getGLine(date);

            const pwQ = await query(`
              SELECT MAX(high)::float as pw_high, MIN(low)::float as pw_low
              FROM price_bars_primary WHERE symbol='NQ'
                AND ts::date >= date_trunc('week', ($1::text)::date) - INTERVAL '7 days'
                AND ts::date <  date_trunc('week', ($1::text)::date)
                AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) >= 570
                AND EXTRACT(hour FROM ts) < 16
            `, [date]);
            const pwHigh = pwQ.rows[0]?.pw_high || null;
            const pwLow  = pwQ.rows[0]?.pw_low  || null;

            const acdRow = await query(`
              SELECT or_high::float, or_low::float, a_up_level::float, a_down_level::float
              FROM acd_daily_log WHERE trade_date=$1
            `, [date]);
            if (!acdRow.rows.length) { structuralBackfillJob.done++; continue; }
            const { or_high: orH, or_low: orL, a_up_level: aUp, a_down_level: aDown } = acdRow.rows[0];

            const bars = await query(`
              SELECT ts, high::float, low::float, close::float
              FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
                AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 575 AND 959
              ORDER BY ts
            `, [date]);
            if (!bars.rows.length) { structuralBackfillJob.done++; continue; }

            const sessionHigh = Math.max(...bars.rows.map(b => b.high));
            const sessionLow  = Math.min(...bars.rows.map(b => b.low));
            const timeline = [];

            let gLineTouched=false, gLineLost=false, gLineReclaimed=false;
            let pwHighTouched=false, pwHighBroken=false;
            let pwLowTouched=false,  pwLowBroken=false;
            let pmVAHTouched=false,  pmVAHBroken=false;
            let pmVALTouched=false,  pmVALBroken=false;

            for (const bar of bars.rows) {
              const t = new Date(bar.ts).toISOString().slice(11, 16);
              const { high: hi, low: lo, close: cl } = bar;

              if (gLine) {
                if (!gLineTouched && lo <= gLine && hi >= gLine)
                  { gLineTouched = true; timeline.push({ time: t, event: 'G-Line tested', price: gLine }); }
                if (!gLineLost && cl < gLine)
                  { gLineLost = true; timeline.push({ time: t, event: 'G-Line lost', price: cl }); }
                if (gLineLost && !gLineReclaimed && cl > gLine)
                  { gLineReclaimed = true; timeline.push({ time: t, event: 'G-Line reclaimed', price: cl }); }
              }
              if (pwHigh) {
                if (!pwHighTouched && hi >= pwHigh)
                  { pwHighTouched = true; timeline.push({ time: t, event: 'PW High tested', price: pwHigh }); }
                if (!pwHighBroken && cl > pwHigh)
                  { pwHighBroken = true; timeline.push({ time: t, event: 'PW High broken', price: cl }); }
              }
              if (pwLow) {
                if (!pwLowTouched && lo <= pwLow)
                  { pwLowTouched = true; timeline.push({ time: t, event: 'PW Low tested', price: pwLow }); }
                if (!pwLowBroken && cl < pwLow)
                  { pwLowBroken = true; timeline.push({ time: t, event: 'PW Low broken', price: cl }); }
              }
              if (pmVAH) {
                if (!pmVAHTouched && hi >= pmVAH)
                  { pmVAHTouched = true; timeline.push({ time: t, event: 'PM VAH tested', price: pmVAH }); }
                if (!pmVAHBroken && cl > pmVAH)
                  { pmVAHBroken = true; timeline.push({ time: t, event: 'PM VAH broken', price: cl }); }
              }
              if (pmVAL) {
                if (!pmVALTouched && lo <= pmVAL)
                  { pmVALTouched = true; timeline.push({ time: t, event: 'PM VAL tested', price: pmVAL }); }
                if (!pmVALBroken && cl < pmVAL)
                  { pmVALBroken = true; timeline.push({ time: t, event: 'PM VAL broken', price: cl }); }
              }
            }

            if (timeline.length > 0) {
              await saveSetupEvents(date, timeline, orH, orL, aUp, aDown, sessionHigh, sessionLow);
              structuralBackfillJob.eventsAdded += timeline.length;
            }
          } catch(e) {
            console.error(`Structural backfill error for ${date}:`, e.message);
          }
          structuralBackfillJob.done++;
          if (structuralBackfillJob.done % 10 === 0) await new Promise(r => setTimeout(r, 0));
        }

        structuralBackfillJob.status = 'complete';
        console.log(`Structural events backfill complete — ${structuralBackfillJob.eventsAdded} events added across ${structuralBackfillJob.done} dates`);
      } catch(e) {
        structuralBackfillJob.status = 'error';
        structuralBackfillJob.error = e.message;
        console.error('Structural backfill fatal error:', e);
      }
    })();
  });

  // GET /api/acd/autocompute/bulk/status
  router.get('/acd/autocompute/bulk/status', (req, res) => res.json(acdBulkJob));

  // POST /api/acd/autocompute/bulk
  router.post('/acd/autocompute/bulk', async (req, res) => {
    if (acdBulkJob.status === 'running') return res.status(409).json({ error: 'Bulk job already running' });

    const { or_minutes, a_multiplier, sustain_minutes } = req.body;
    const orMins   = parseInt(or_minutes)    || 5;
    const aMult    = parseFloat(a_multiplier) || 0.33;
    const sustainM = parseInt(sustain_minutes) || 3;

    res.json({ message: 'Bulk backfill started' });

    setImmediate(async () => {
      try {
        const datesRes = await query(`
          SELECT DISTINCT ts::date::text as d FROM price_bars_primary
          WHERE symbol = 'NQ'
            AND EXTRACT(hour FROM ts) = 9 AND EXTRACT(minute FROM ts) = 30
          ORDER BY d
        `);
        const dates = datesRes.rows.map(r => r.d);
        acdBulkJob = { status: 'running', done: 0, total: dates.length, error: null };

        for (let i = 0; i < dates.length; i++) {
          const d = dates[i];
          try {
            const result = await computeACDFromBars(d, orMins, aMult, sustainM);
            if (result) {
              await query(`
                INSERT INTO acd_daily_log (trade_date, or_high, or_low, a_multiplier, a_up_level, a_down_level, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed, daily_score, session_close)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                ON CONFLICT (trade_date) DO UPDATE SET
                  or_high=$2, or_low=$3, a_multiplier=$4, a_up_level=$5, a_down_level=$6,
                  a_up_fired=$7, a_down_fired=$8, c_up_confirmed=$9, c_down_confirmed=$10,
                  daily_score=$11, session_close=$12
              `, [d, result.orHigh, result.orLow, aMult, result.aUpLevel, result.aDownLevel, result.aUpFired, result.aDownFired, result.cUpConfirmed, result.cDownConfirmed, result.score, result.sessionClose]);
            }
          } catch(e) { /* skip individual date errors */ }
          acdBulkJob.done = i + 1;
        }
        acdBulkJob = { status: 'complete', done: acdBulkJob.total, total: acdBulkJob.total, error: null };
      } catch(e) {
        acdBulkJob = { status: 'error', done: acdBulkJob.done, total: acdBulkJob.total, error: e.message };
      }
    });
  });

  // POST /api/acd/pivot/autocompute
  router.post('/acd/pivot/autocompute', async (req, res) => {
    try {
      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const currentYear = nowET.getFullYear();
      const currentMonth = nowET.getMonth();
      const priorMonth = currentMonth === 0 ? 12 : currentMonth;
      const priorYear  = currentMonth === 0 ? currentYear - 1 : currentYear;
      const monthYear  = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`;

      const priorFrom = `${priorYear}-${String(priorMonth).padStart(2, '0')}-01`;
      const priorTo   = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-01`;

      const r = await query(`
        SELECT
          MAX(high)   as prior_month_high,
          MIN(low)    as prior_month_low,
          (SELECT close FROM price_bars_primary WHERE symbol='NQ'
            AND ts >= $1::date AND ts < $2::date
            AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
            ORDER BY ts DESC LIMIT 1) as prior_month_close
        FROM price_bars_primary
        WHERE symbol = 'NQ'
          AND ts >= $1::date AND ts < $2::date
          AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      `, [priorFrom, priorTo]);

      const { prior_month_high: ph, prior_month_low: pl, prior_month_close: pc } = r.rows[0];
      if (!ph || !pl || !pc) return res.status(404).json({ error: 'Insufficient bar data for prior month' });

      const pivot = (parseFloat(ph) + parseFloat(pl) + parseFloat(pc)) / 3;
      const r1 = 2 * pivot - parseFloat(pl);
      const s1 = 2 * pivot - parseFloat(ph);

      const saved = await query(`
        INSERT INTO acd_monthly_pivot (month_year, prior_month_high, prior_month_low, prior_month_close, pivot_level, pivot_r1, pivot_s1)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (month_year) DO UPDATE SET
          prior_month_high=$2, prior_month_low=$3, prior_month_close=$4,
          pivot_level=$5, pivot_r1=$6, pivot_s1=$7
        RETURNING *
      `, [monthYear, ph, pl, pc, pivot, r1, s1]);

      res.json(saved.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/correlation
  router.get('/acd/correlation', async (req, res) => {
    try {
      const accounts = req.query.accounts ? req.query.accounts.split(',') : null;
      const acctFilter = accounts?.length ? `AND t.custom_fields->>'account' = ANY($1::text[])` : '';
      const params = accounts?.length ? [accounts] : [];

      const trades = await query(`
        SELECT t.id, t.entry_time, t.exit_time, t.pnl, t.setup_type,
               t.entry_time::date::text as trade_date
        FROM trades t
        WHERE t.exit_time IS NOT NULL AND t.pnl IS NOT NULL
          ${acctFilter}
        ORDER BY t.entry_time
      `, params);

      const acdDays = await query('SELECT trade_date::text as trade_date, daily_score, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed FROM acd_daily_log');

      const acdMap = {};
      for (const d of acdDays.rows) { acdMap[d.trade_date] = d; }

      const tagged = trades.rows.map(t => {
        const rawDate = t.trade_date;
        const dateKey = typeof rawDate === 'string' ? rawDate : rawDate?.toISOString?.()?.split('T')[0] ?? '';
        const acd = acdMap[dateKey];
        const signal = acd?.a_up_fired ? 'A_UP' : acd?.a_down_fired ? 'A_DOWN' : acd ? 'NO_SIGNAL' : null;
        const confirmed = acd?.c_up_confirmed || acd?.c_down_confirmed;
        const pnl = parseFloat(t.pnl);
        return { ...t, pnl, acdSignal: signal, acdConfirmed: confirmed, acdScore: acd?.daily_score ?? null };
      });

      const withSignal  = tagged.filter(t => t.acdSignal === 'A_UP' || t.acdSignal === 'A_DOWN');
      const noSignal    = tagged.filter(t => t.acdSignal === 'NO_SIGNAL');
      const untagged    = tagged.filter(t => t.acdSignal === null);
      const aUpTrades   = tagged.filter(t => t.acdSignal === 'A_UP');
      const aDownTrades = tagged.filter(t => t.acdSignal === 'A_DOWN');
      const confirmed   = tagged.filter(t => t.acdConfirmed);

      const stats = (arr) => arr.length === 0 ? { count: 0, winRate: null, avgPnl: null } : {
        count: arr.length,
        winRate: arr.filter(t => t.pnl > 0).length / arr.length,
        avgPnl: arr.reduce((s, t) => s + t.pnl, 0) / arr.length,
      };

      res.json({
        totalTrades: tagged.length,
        acdLogDays: acdDays.rows.length,
        withSignal:  stats(withSignal),
        noSignal:    stats(noSignal),
        aUp:         stats(aUpTrades),
        aDown:       stats(aDownTrades),
        confirmed:   stats(confirmed),
        untagged: untagged.length,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Weekly ACD ──────────────────────────────────────────────────────────────

  async function computeWeeklyACD(weekStart, aMultiplier = 0.33, sustainMinutes = 5) {
    const bars = await query(`
      SELECT ts::date::text as date, to_char(ts, 'HH24:MI') as time,
             high::float, low::float, close::float
      FROM price_bars_primary
      WHERE symbol = 'NQ'
        AND ts::date >= $1::date
        AND ts::date < $1::date + interval '7 days'
        AND EXTRACT(dow FROM ts::date) BETWEEN 1 AND 5
        AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      ORDER BY ts
    `, [weekStart]);

    if (bars.rows.length === 0) return null;

    const byDay = {};
    for (const b of bars.rows) {
      if (!byDay[b.date]) byDay[b.date] = [];
      byDay[b.date].push(b);
    }
    const days = Object.keys(byDay).sort();
    if (days.length < 2) return null;

    const orDay = days[0];
    const orBars = byDay[orDay];
    const orHigh = Math.max(...orBars.map(b => b.high));
    const orLow  = Math.min(...orBars.map(b => b.low));
    const orRange = orHigh - orLow;
    if (orRange === 0) return null;

    const aUp   = orHigh + orRange * aMultiplier;
    const aDown = orLow  - orRange * aMultiplier;

    const restDays = days.slice(1);
    let aUpFired = false, aUpDay = null;
    let aDownFired = false, aDownDay = null;
    let aUpTime = null, aDownTime = null;

    outer: for (const day of restDays) {
      for (const bar of byDay[day]) {
        if (!aDownTime) {
          if (!aUpTime && bar.high >= aUp) aUpTime = `${day} ${bar.time}`;
          if (aUpTime) {
            const [td, tt] = aUpTime.split(' ');
            const minsHeld = td === day
              ? (parseInt(bar.time.split(':')[0]) * 60 + parseInt(bar.time.split(':')[1])) -
                (parseInt(tt.split(':')[0]) * 60 + parseInt(tt.split(':')[1]))
              : 999;
            if (bar.low < orHigh) { aUpTime = null; }
            else if (minsHeld >= sustainMinutes) {
              aUpFired = true; aUpDay = day; break outer;
            }
          }
        }
        if (!aUpTime) {
          if (!aDownTime && bar.low <= aDown) aDownTime = `${day} ${bar.time}`;
          if (aDownTime) {
            const [td, tt] = aDownTime.split(' ');
            const minsHeld = td === day
              ? (parseInt(bar.time.split(':')[0]) * 60 + parseInt(bar.time.split(':')[1])) -
                (parseInt(tt.split(':')[0]) * 60 + parseInt(tt.split(':')[1]))
              : 999;
            if (bar.high > orLow) { aDownTime = null; }
            else if (minsHeld >= sustainMinutes) {
              aDownFired = true; aDownDay = day; break outer;
            }
          }
        }
      }
      if (aUpTime && !aUpFired) aUpTime = `${day} 999`;
      if (aDownTime && !aDownFired) aDownTime = `${day} 999`;
    }

    let cUpConfirmed = false, cDownConfirmed = false;
    for (const day of restDays) {
      const dayBars = byDay[day];
      const lastClose = dayBars[dayBars.length - 1]?.close;
      if (lastClose === undefined) continue;
      if (aUpFired   && lastClose > orHigh) { cUpConfirmed   = true; break; }
      if (aDownFired && lastClose < orLow)  { cDownConfirmed = true; break; }
    }

    let score = 0;
    if (aUpFired   && cUpConfirmed)   score =  4;
    else if (aUpFired)                score =  1;
    else if (aDownFired && cDownConfirmed) score = -4;
    else if (aDownFired)              score = -1;

    const weekClose = byDay[days[days.length - 1]]?.slice(-1)[0]?.close ?? null;

    return {
      weekStart, orDay, orHigh, orLow, aMultiplier,
      aUpLevel: Math.round(aUp * 100) / 100,
      aDownLevel: Math.round(aDown * 100) / 100,
      aUpFired, aUpDay, aDownFired, aDownDay,
      cUpConfirmed, cDownConfirmed, score, weekClose,
    };
  }

  async function saveWeeklyACD(r) {
    await query(`
      INSERT INTO acd_weekly_log
        (week_start, or_day, or_high, or_low, a_multiplier, a_up_level, a_down_level,
         a_up_fired, a_up_day, a_down_fired, a_down_day,
         c_up_confirmed, c_down_confirmed, daily_score, week_close)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (week_start) DO UPDATE SET
        or_day=$2, or_high=$3, or_low=$4, a_multiplier=$5, a_up_level=$6, a_down_level=$7,
        a_up_fired=$8, a_up_day=$9, a_down_fired=$10, a_down_day=$11,
        c_up_confirmed=$12, c_down_confirmed=$13, daily_score=$14, week_close=$15
    `, [r.weekStart, r.orDay, r.orHigh, r.orLow, r.aMultiplier,
        r.aUpLevel, r.aDownLevel, r.aUpFired, r.aUpDay, r.aDownFired, r.aDownDay,
        r.cUpConfirmed, r.cDownConfirmed, r.score, r.weekClose]);
  }

  // GET /api/acd/weekly
  router.get('/acd/weekly', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 52;
      const r = await query(`
        SELECT *, week_start::text, or_day::text, a_up_day::text, a_down_day::text
        FROM acd_weekly_log ORDER BY week_start DESC LIMIT $1
      `, [limit]);
      res.json(r.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/weekly/numberline
  router.get('/acd/weekly/numberline', async (req, res) => {
    try {
      const r = await query(`
        SELECT
          week_start::text as date,
          daily_score as score,
          SUM(daily_score) OVER (ORDER BY week_start ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as nl30,
          SUM(daily_score) OVER (ORDER BY week_start ROWS BETWEEN 9  PRECEDING AND CURRENT ROW) as nl10
        FROM acd_weekly_log
        ORDER BY week_start ASC
      `);
      const rows = r.rows.map(row => ({ date: row.date, score: parseInt(row.score), nl30: parseInt(row.nl30), nl10: parseInt(row.nl10) }));
      const latest = rows[rows.length - 1];
      const nl30 = latest?.nl30 || 0;
      const trend = nl30 > 9 ? 'TRENDING_UP' : nl30 < -9 ? 'TRENDING_DOWN' : 'RANGING';
      res.json({ nl30, nl10: latest?.nl10 || 0, trend, history: rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/confluence
  router.get('/acd/confluence', async (req, res) => {
    try {
      const dNL = await query(`
        SELECT COALESCE(SUM(daily_score), 0) as nl30
        FROM (SELECT daily_score FROM acd_daily_log ORDER BY trade_date DESC LIMIT 30) s
      `);
      const dailyNL30 = parseInt(dNL.rows[0]?.nl30) || 0;
      const dailyTrend = dailyNL30 > 9 ? 'up' : dailyNL30 < -9 ? 'down' : 'ranging';

      const wNL = await query(`
        SELECT COALESCE(SUM(daily_score), 0) as nl30
        FROM (SELECT daily_score FROM acd_weekly_log ORDER BY week_start DESC LIMIT 30) s
      `);
      const weeklyNL30 = parseInt(wNL.rows[0]?.nl30) || 0;
      const weeklyTrend = weeklyNL30 > 9 ? 'up' : weeklyNL30 < -9 ? 'down' : 'ranging';

      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const monthYear = `${nowET.getFullYear()}-${String(nowET.getMonth()+1).padStart(2,'0')}`;
      const pivot = await query('SELECT pivot_level FROM acd_monthly_pivot WHERE month_year=$1', [monthYear]);
      const latestBar = await query(`SELECT close::float as close FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= CURRENT_DATE - 5 ORDER BY ts DESC LIMIT 1`);
      const nqClose = latestBar.rows[0]?.close || 0;
      const pivotLevel = parseFloat(pivot.rows[0]?.pivot_level) || null;
      const pivotBias = pivotLevel ? (nqClose > pivotLevel ? 'up' : 'down') : null;

      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const todayACD = await query(`SELECT a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed FROM acd_daily_log WHERE trade_date=$1`, [todayET]);
      const today = todayACD.rows[0];

      let score = 0, maxScore = 0, details = [];
      const dir = dailyTrend;

      if (dailyTrend !== 'ranging') {
        maxScore++;
        if (true) { score++; details.push({ label: 'Daily NL', state: dailyTrend, aligned: true }); }
      } else {
        details.push({ label: 'Daily NL', state: 'ranging', aligned: false });
      }

      if (weeklyTrend !== 'ranging') {
        maxScore++;
        const aligned = weeklyTrend === dir;
        if (aligned) score++;
        details.push({ label: 'Weekly NL', state: weeklyTrend, aligned });
      } else {
        details.push({ label: 'Weekly NL', state: 'ranging', aligned: false });
      }

      if (pivotBias) {
        maxScore++;
        const aligned = pivotBias === dir;
        if (aligned) score++;
        details.push({ label: 'Monthly Pivot', state: pivotBias, aligned });
      } else {
        details.push({ label: 'Monthly Pivot', state: null, aligned: false });
      }

      let holdRec, holdColor;
      if (score >= 3) { holdRec = 'Multi-day hold'; holdColor = '#22c55e'; }
      else if (score === 2) { holdRec = '1–2 day hold'; holdColor = '#86efac'; }
      else if (score === 1) { holdRec = 'Day trade only'; holdColor = '#fbbf24'; }
      else { holdRec = 'Stand aside'; holdColor = '#ef4444'; }

      res.json({
        score, maxScore, dir, holdRec, holdColor,
        dailyNL30, weeklyNL30, pivotLevel, nqClose, pivotBias,
        dailyTrend, weeklyTrend, details,
        todaySignal: today ? (today.a_up_fired ? 'A_UP' : today.a_down_fired ? 'A_DOWN' : null) : null,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/acd/weekly/autocompute/bulk
  router.get('/acd/weekly/bulk/status', (req, res) => res.json(weeklyBulkJob));

  router.post('/acd/weekly/autocompute/bulk', async (req, res) => {
    if (weeklyBulkJob.status === 'running') return res.status(409).json({ error: 'Already running' });
    const aMultiplier = parseFloat(req.body?.a_multiplier) || 0.33;
    const sustainMinutes = parseInt(req.body?.sustain_minutes) || 5;
    res.json({ message: 'Weekly ACD backfill started' });

    setImmediate(async () => {
      try {
        const weeksRes = await query(`
          SELECT DISTINCT date_trunc('week', ts::date)::date::text as week_start
          FROM price_bars_primary
          WHERE symbol='NQ' AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
          ORDER BY week_start
        `);
        const weeks = weeksRes.rows.map(r => r.week_start);
        weeklyBulkJob = { status: 'running', done: 0, total: weeks.length, error: null };
        for (let i = 0; i < weeks.length; i++) {
          try {
            const r = await computeWeeklyACD(weeks[i], aMultiplier, sustainMinutes);
            if (r) await saveWeeklyACD(r);
          } catch(e) {}
          weeklyBulkJob.done = i + 1;
        }
        weeklyBulkJob = { status: 'complete', done: weeks.length, total: weeks.length, error: null };
        console.log(`Weekly ACD backfill complete: ${weeks.length} weeks`);
      } catch(e) {
        weeklyBulkJob = { status: 'error', done: weeklyBulkJob.done, total: weeklyBulkJob.total, error: e.message };
      }
    });
  });

  // GET /api/acd/nq/latest
  router.get('/acd/nq/latest', async (req, res) => {
    try {
      const r = await query(`SELECT ts, close, high, low, open FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= CURRENT_DATE - 5 ORDER BY ts DESC LIMIT 1`);
      if (r.rows.length === 0) return res.json(null);
      const bar = r.rows[0];
      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const todayET = nowET.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const monthYear = `${nowET.getFullYear()}-${String(nowET.getMonth() + 1).padStart(2, '0')}`;
      const [pivot, arQ] = await Promise.all([
        query('SELECT * FROM acd_monthly_pivot WHERE month_year = $1', [monthYear]),
        query('SELECT opening_call_type FROM auction_reads WHERE trade_date=$1', [todayET]),
      ]);
      const pivotRow = pivot.rows[0];
      let pivotBias = null;
      if (pivotRow) {
        const price = parseFloat(bar.close);
        const pLevel = parseFloat(pivotRow.pivot_level);
        const r1 = parseFloat(pivotRow.pivot_r1);
        const s1 = parseFloat(pivotRow.pivot_s1);
        pivotBias = price > r1 ? 'ABOVE_R1' : price > pLevel ? 'ABOVE_PIVOT' : price > s1 ? 'BELOW_PIVOT' : 'BELOW_S1';
      }
      const opening_call_type = arQ.rows[0]?.opening_call_type || null;
      res.json({ ts: bar.ts, close: parseFloat(bar.close), pivot: pivotRow || null, pivotBias, barAgeMinutes: Math.round((Date.now() - new Date(bar.ts).getTime()) / 60000), opening_call_type });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/numberline/history
  router.get('/acd/numberline/history', async (req, res) => {
    try {
      const r = await query(`
        SELECT
          trade_date::text as date,
          daily_score,
          SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as nl30,
          SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 9  PRECEDING AND CURRENT ROW) as nl10,
          SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 4  PRECEDING AND CURRENT ROW) as nl5
        FROM acd_daily_log
        ORDER BY trade_date ASC
      `);
      res.json(r.rows.map(row => ({
        date: row.date,
        score: parseInt(row.daily_score),
        nl30: parseInt(row.nl30),
        nl10: parseInt(row.nl10),
        nl5:  parseInt(row.nl5),
      })));
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/setup-events/day
  router.get('/acd/setup-events/day', async (req, res) => {
    try {
      const { date } = req.query;
      if (!date) return res.status(400).json({ error: 'date required' });
      const r = await query(`
        SELECT setup_type, TO_CHAR(fired_time,'HH24:MI') as fired_time,
               fired_price::numeric(8,2), minutes_from_or
        FROM acd_setup_events WHERE trade_date=$1
        ORDER BY fired_time
      `, [date]);
      res.json(r.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/setup-events/stats
  router.get('/acd/setup-events/stats', async (req, res) => {
    try {
      const r = await query(`
        SELECT
          setup_type,
          COUNT(*) as occurrences,
          ROUND(AVG(minutes_from_or)) as avg_minutes_from_or,
          MIN(minutes_from_or) as earliest_minutes,
          MAX(minutes_from_or) as latest_minutes,
          TO_CHAR(MIN(fired_time), 'HH24:MI') as earliest_time,
          TO_CHAR(MAX(fired_time), 'HH24:MI') as latest_time,
          TO_CHAR(TIME '09:35' + (ROUND(AVG(minutes_from_or)) || ' minutes')::INTERVAL, 'HH24:MI') as avg_fire_time
        FROM acd_setup_events
        GROUP BY setup_type
        ORDER BY occurrences DESC
      `);
      const dist = await query(`
        SELECT
          setup_type,
          FLOOR(minutes_from_or / 30) * 30 as bucket_minutes,
          TO_CHAR(TIME '09:35' + (FLOOR(minutes_from_or / 30) * 30 || ' minutes')::INTERVAL, 'HH24:MI') as bucket_label,
          COUNT(*) as count
        FROM acd_setup_events
        WHERE minutes_from_or >= 0
        GROUP BY setup_type, bucket_minutes
        ORDER BY setup_type, bucket_minutes
      `);
      res.json({ stats: r.rows, distribution: dist.rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/setup-events
  router.get('/acd/setup-events', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 100;
      const r = await query(`
        SELECT trade_date::text, setup_type, TO_CHAR(fired_time, 'HH24:MI') as fired_time,
               fired_price::numeric(8,2), minutes_from_or
        FROM acd_setup_events
        ORDER BY trade_date DESC, fired_time ASC
        LIMIT $1
      `, [limit]);
      res.json(r.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/acd/level-confidence
  router.get('/acd/level-confidence', async (req, res) => {
    try {
      // cacheGet imported at top of file
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

      const latestBar = await query(`SELECT close::float as close FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= CURRENT_DATE - 5 ORDER BY ts DESC LIMIT 1`);
      const currentPrice = latestBar.rows[0]?.close;
      if (!currentPrice) return res.json({ levels: [] });

      const nlQ = await query(`
        SELECT SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as nl30
        FROM acd_daily_log WHERE daily_score IS NOT NULL ORDER BY trade_date DESC LIMIT 1
      `);
      const nl30Val = parseInt(nlQ.rows[0]?.nl30) || 0;
      const nl30State = nl30Val > 9 ? 'BULLISH' : nl30Val < -9 ? 'BEARISH' : 'RANGING';

      const arQ = await query(`SELECT opening_call_type FROM auction_reads WHERE trade_date=$1`, [todayET]);
      const openingCall = arQ.rows[0]?.opening_call_type || null;

      const acdQ = await query(`SELECT or_high, or_low, a_up_level, a_down_level FROM acd_daily_log WHERE trade_date=$1`, [todayET]);
      const orH = parseFloat(acdQ.rows[0]?.or_high || 0);
      const orL = parseFloat(acdQ.rows[0]?.or_low || 0);

      const ibQ = await query(`
        SELECT MAX(high)::float as ib_high, MIN(low)::float as ib_low
        FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
          AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 629
      `, [todayET]);
      const ibHigh = ibQ.rows[0]?.ib_high;
      const ibLow  = ibQ.rows[0]?.ib_low;
      const ibRange = ibHigh && ibLow ? ibHigh - ibLow : null;

      const pdQ = await query(`
        SELECT acd_daily_log.or_high, acd_daily_log.or_low FROM acd_daily_log
        WHERE trade_date < $1 AND or_high IS NOT NULL ORDER BY trade_date DESC LIMIT 1
      `, [todayET]);

      const prevDay = pdQ.rows[0];
      let pdVAH = null, pdVAL = null;
      if (prevDay) {
        const vaQ = await query(`
          SELECT vah::float as vah, val::float as val
          FROM developing_value_log
          WHERE trade_date = (SELECT MAX(trade_date) FROM acd_daily_log WHERE trade_date < $1)
        `, [todayET]);
        if (vaQ.rows[0]) {
          pdVAH = vaQ.rows[0].vah;
          pdVAL = vaQ.rows[0].val;
        } else {
          // fallback to pdBars calculation
          const pdBars = await query(`
            SELECT high::float as high, low::float as low, close::float as close, volume::integer as volume
            FROM price_bars_primary WHERE symbol='NQ' AND ts::date=(SELECT MAX(trade_date) FROM acd_daily_log WHERE trade_date < $1)
              AND (EXTRACT(hour FROM ts)=9 AND EXTRACT(minute FROM ts)>=30 OR EXTRACT(hour FROM ts) BETWEEN 10 AND 15)
          `, [todayET]);
          if (pdBars.rows.length) {
            const priceMap = {};
            let totalV = 0;
            for (const b of pdBars.rows) {
              const v = b.volume || 0;
              for (let p = Math.round(b.low / 0.25) * 0.25; p <= b.high + 0.01; p += 0.25) {
                const k = p.toFixed(2);
                priceMap[k] = (priceMap[k] || 0) + v / Math.max(1, Math.round((b.high - b.low) / 0.25) + 1);
                totalV += v / Math.max(1, Math.round((b.high - b.low) / 0.25) + 1);
              }
            }
            const poc = parseFloat(Object.entries(priceMap).sort((a,b) => b[1]-a[1])[0]?.[0]);
            if (poc && totalV > 0) {
              const sorted70 = Object.entries(priceMap).filter(([p]) => parseFloat(p) >= poc)
                .sort((a,b) => b[1]-a[1]);
              let cumVah = 0;
              pdVAH = poc;
              for (const [p,v] of sorted70) { cumVah += v; pdVAH = Math.max(pdVAH, parseFloat(p)); if (cumVah >= totalV * 0.35) break; }
              const sorted70dn = Object.entries(priceMap).filter(([p]) => parseFloat(p) <= poc)
                .sort((a,b) => b[1]-a[1]);
              let cumVal = 0;
              pdVAL = poc;
              for (const [p,v] of sorted70dn) { cumVal += v; pdVAL = Math.min(pdVAL, parseFloat(p)); if (cumVal >= totalV * 0.35) break; }
            }
          }
        }
      }

      const candidates = [
        { key: 'ibh',    price: ibHigh, label: 'IB High',         side: 'resistance' },
        { key: 'ibl',    price: ibLow,  label: 'IB Low',          side: 'support'    },
        { key: 'ibhExt', price: ibHigh && ibRange ? ibHigh + ibRange : null, label: 'IB High +1×', side: 'resistance' },
        { key: 'iblExt', price: ibLow  && ibRange ? ibLow  - ibRange : null, label: 'IB Low -1×',  side: 'support'    },
        { key: 'pdvah',  price: pdVAH,  label: 'PD VAH',          side: 'resistance' },
        { key: 'pdval',  price: pdVAL,  label: 'PD VAL',          side: 'support'    },
      ].filter(c => c.price != null);

      const klCacheKey = `kl||||2.5|`;
      let klData = cacheGet(klCacheKey) || cacheGet(`kl||||10|`) || cacheGet(`kl||||5|`);

      const getCondRate = (levelKey, side, condKey, condVal) => {
        if (!klData) return null;
        const levelData = klData.byLevel?.find(l => l.key === levelKey);
        if (!levelData) return null;
        const sideData = levelData[side];
        if (!sideData?.conditionBreakdown) return null;
        const dim = sideData.conditionBreakdown[condKey];
        return dim?.[condVal] || null;
      };

      const PROX = 60;
      const nearLevels = candidates
        .map(c => {
          const dist = Math.abs(c.price - currentPrice);
          if (dist > PROX) return null;
          const rawRate = getCondRate(c.key, c.side, 'byNL30', nl30State);
          const ocRate  = openingCall ? getCondRate(c.key, c.side, 'byOpeningCall', openingCall) : null;
          const unfiltered = (() => {
            if (!klData) return null;
            const ld = klData.byLevel?.find(l => l.key === c.key);
            return ld?.[c.side]?.respectRate ?? null;
          })();
          return {
            key: c.key, label: c.label, price: +c.price.toFixed(2),
            side: c.side, dist: +dist.toFixed(1),
            approaching: c.side === 'resistance' ? currentPrice < c.price : currentPrice > c.price,
            respectRate: unfiltered,
            nl30Filtered: rawRate ? { rate: rawRate.respectRate, touches: rawRate.touches, condition: nl30State } : null,
            openCallFiltered: ocRate ? { rate: ocRate.respectRate, touches: ocRate.touches, condition: openingCall } : null,
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.dist - b.dist);

      res.json({ currentPrice, nl30State, openingCall, nl30: nl30Val, nearLevels });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/auction-read/day-setups lived here too, unreachable dead code (shadowed by
  // auctionRead.js's copy, mounted before acd.js) — removed 2026-07-17 dead-routes audit.
  // The live copy in auctionRead.js has been fixed to use the same corrected
  // computeVolumeProfileForRange() method this dead copy already had.

      router.get('/acd/live', async (req, res) => {
    try {
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

      // Check market calendar before DB queries
      const mktStatus = getMarketStatus(todayET);
      if (mktStatus?.type === 'HOLIDAY') {
        return res.json({ setup: null, reason: `Market Holiday — ${mktStatus.name}`, marketHoliday: true });
      }

      // Get today's logged OR and A levels
      const logged = await query(`SELECT or_high, or_low, a_multiplier, a_up_level, a_down_level, a_up_fired, a_down_fired FROM acd_daily_log WHERE trade_date=$1`, [todayET]);
      if (!logged.rows.length || !logged.rows[0].or_high) return res.json({ setup: null, reason: 'No OR data for today' });

      // G-Line: CME weekly open — defined once in services/queries.js
      const todayForGLine = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const gLine = await getGLine(todayForGLine);

      // G-Line days held (prior sessions this week only — today not yet closed)
      let gLineDaysHeld = 0;
      if (gLine) {
        try {
          const weeklyQ = await query(`
            SELECT ts::date as session_date,
                   (array_agg(close ORDER BY ts DESC))[1]::float as session_close
            FROM price_bars_primary
            WHERE symbol='NQ'
              AND ts::date >= date_trunc('week', ($1::text)::date)
              AND ts::date < ($1::text)::date
              AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 960
            GROUP BY ts::date ORDER BY ts::date ASC
          `, [todayET]);
          for (const s of weeklyQ.rows) { if (s.session_close > gLine) gLineDaysHeld++; }
        } catch (_) {}
      }

      // Prior week RTH high/low
      const pwQ = await query(`
        SELECT MAX(high)::float as pw_high, MIN(low)::float as pw_low
        FROM price_bars_primary WHERE symbol='NQ'
          AND ts::date >= date_trunc('week', CURRENT_DATE) - INTERVAL '7 days'
          AND ts::date <  date_trunc('week', CURRENT_DATE)
          AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      `);
      const pwHigh = pwQ.rows[0]?.pw_high || null;
      const pwLow  = pwQ.rows[0]?.pw_low  || null;

      // Prior month value area (VAH/POC/VAL from volume profile)
      const pmMonthStartQ = await query(`SELECT (date_trunc('month', CURRENT_DATE) - INTERVAL '1 month')::date::text as s, (date_trunc('month', CURRENT_DATE) - INTERVAL '1 day')::date::text as e`);
      const pmVaProfile = await computeVolumeProfileForRange(query, { startDate: pmMonthStartQ.rows[0].s, endDate: pmMonthStartQ.rows[0].e });
      const pmVAH = pmVaProfile?.vah ?? null;
      const pmVAL = pmVaProfile?.val ?? null;
      const pmPOC = pmVaProfile?.poc ?? null;

      // Monthly open: first RTH bar of current calendar month
      let monthOpen = null;
      try {
        const moQ = await query(`
          SELECT open::float as mo FROM price_bars_primary
          WHERE symbol='NQ' AND ts::date = (
            SELECT MIN(ts::date) FROM price_bars_primary
            WHERE symbol='NQ' AND date_trunc('month', ts) = date_trunc('month', CURRENT_DATE)
              AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 960
          ) ORDER BY ts LIMIT 1
        `);
        monthOpen = moQ.rows[0]?.mo || null;
      } catch (_) {}

      const { or_high, or_low, a_multiplier, a_up_level, a_down_level, a_up_fired, a_down_fired } = logged.rows[0];
      const orH = parseFloat(or_high), orL = parseFloat(or_low);
      const aUp = parseFloat(a_up_level), aDown = parseFloat(a_down_level);
      const orRange = orH - orL;
      const orEndMin = 9 * 60 + 35; // 09:35 ET

      // Get today's post-OR bars — RTH only (9:35–16:00)
      // After-hours bars would give false signals since ACD is a morning-session framework
      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const rthEndMin = 16 * 60; // 16:00

      const bars = await query(`
        SELECT ts, open::float, high::float, low::float, close::float, volume::bigint,
               EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) as bar_min
        FROM price_bars_primary
        WHERE symbol='NQ' AND ts::date=$1
          AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) >= $2
          AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) <= $3
        ORDER BY ts
      `, [todayET, orEndMin, rthEndMin]);

      if (!bars.rows.length) return res.json({ setup: null, reason: 'No post-OR bars yet' });

      const postOR = bars.rows;
      const sessionHigh = Math.max(...postOR.map(b => b.high));
      const sessionLow  = Math.min(...postOR.map(b => b.low));
      const latestBar   = postOR[postOR.length - 1];
      const currentPrice = latestBar.close;
      const barTime = new Date(latestBar.ts).toISOString().slice(11, 16);

      // G-Line status vs current price
      let gLineStatus = null;
      if (gLine) {
        const TESTING_THRESHOLD = 15;
        if (Math.abs(currentPrice - gLine) <= TESTING_THRESHOLD) gLineStatus = 'testing';
        else if (currentPrice > gLine) gLineStatus = 'held';
        else gLineStatus = 'broken';
      }

      // Weis effort-vs-result warning: volume AND body declining on last 3 bars while signal active
      let weisWarning = false;
      if ((a_up_fired || a_down_fired) && postOR.length >= 3) {
        const last3 = postOR.slice(-3); // [oldest, middle, newest]
        const [b0, b1, b2] = last3;     // b2 = most recent
        const vol0 = Number(b0.volume), vol1 = Number(b1.volume), vol2 = Number(b2.volume);
        const body0 = Math.abs(b0.close - b0.open);
        const body1 = Math.abs(b1.close - b1.open);
        const body2 = Math.abs(b2.close - b2.open);
        const volDeclining  = vol2  < vol1  && vol1  < vol0;
        const bodyDeclining = body2 < body1 && body1 < body0;
        weisWarning = volDeclining && bodyDeclining;
      }

      // Detect all 6 setups
      const reachedAUp   = sessionHigh >= aUp;
      const reachedADown = sessionLow  <= aDown;
      const cUp   = postOR.some(b => b.close > orH);
      const cDown = postOR.some(b => b.close < orL);

      // Failed A: reached level but price has since fallen back inside OR (or below OR High / above OR Low)
      const failedAUp   = reachedAUp   && !a_up_fired   && currentPrice < orH;
      const failedADown = reachedADown && !a_down_fired  && currentPrice > orL;

      // Determine active setup (priority order)
      let setup = null, color = '#94a3b8', description = '';

      if (a_up_fired && cUp) {
        setup = 'A Up + C Confirmed'; color = '#22c55e';
        description = `A Up fired and C Up confirmed. Strong continuation long. Price ${currentPrice.toFixed(2)}, above OR High ${orH.toFixed(2)}.`;
      } else if (a_up_fired && !cUp) {
        setup = 'A Up (no C yet)'; color = '#86efac';
        description = `A Up fired. Waiting for C Up confirmation (close above OR High ${orH.toFixed(2)}). Still valid long.`;
      } else if (a_down_fired && cDown) {
        setup = 'A Down + C Confirmed'; color = '#ef4444';
        description = `A Down fired and C Down confirmed. Strong continuation short. Price ${currentPrice.toFixed(2)}, below OR Low ${orL.toFixed(2)}.`;
      } else if (a_down_fired && !cDown) {
        setup = 'A Down (no C yet)'; color = '#fca5a5';
        description = `A Down fired. Waiting for C Down confirmation (close below OR Low ${orL.toFixed(2)}). Still valid short.`;
      } else if (failedAUp) {
        setup = 'Failed A Up'; color = '#f97316';
        description = `Price reached A Up (${aUp.toFixed(2)}) but failed to sustain — fell back below OR High (${orH.toFixed(2)}). Short setup. Entry near OR High, stop above session high (${sessionHigh.toFixed(2)}).`;
      } else if (failedADown) {
        setup = 'Failed A Down'; color = '#a78bfa';
        description = `Price reached A Down (${aDown.toFixed(2)}) but failed to sustain — rose back above OR Low (${orL.toFixed(2)}). Long setup. Entry near OR Low, stop below session low (${sessionLow.toFixed(2)}).`;
      } else if (reachedAUp) {
        setup = 'Testing A Up'; color = '#fbbf24';
        description = `Price reached A Up level (${aUp.toFixed(2)}). Watching for 5-minute sustain above OR High for long entry, or failure for short entry.`;
      } else if (reachedADown) {
        setup = 'Testing A Down'; color = '#fbbf24';
        description = `Price reached A Down level (${aDown.toFixed(2)}). Watching for 5-minute sustain below OR Low for short entry, or failure for long entry.`;
      } else if (cUp && !a_up_fired) {
        setup = 'C Up (no A)'; color = '#6ee7b7';
        description = `A bar closed above OR High (${orH.toFixed(2)}) without A Up firing first. Weaker signal — price accepted above OR but didn't break the A level.`;
      } else if (cDown && !a_down_fired) {
        setup = 'C Down (no A)'; color = '#fda4af';
        description = `A bar closed below OR Low (${orL.toFixed(2)}) without A Down firing first. Weaker signal.`;
      } else {
        const distToAUp   = aUp - currentPrice;
        const distToADown = currentPrice - aDown;
        setup = 'No signal'; color = '#64748b';
        description = `No setup yet. Price ${currentPrice.toFixed(2)} — ${distToAUp.toFixed(0)} pts from A Up (${aUp.toFixed(2)}), ${distToADown.toFixed(0)} pts from A Down (${aDown.toFixed(2)}).`;
      }

      // Build session timeline — with cooldown flags to prevent re-triggering on same touch
      const timeline = [];
      let aUpTouchTime = null, aDownTouchTime = null;
      let aUpFiredTimeline = false, aDownFiredTimeline = false;
      // aUpHeld: true while A Up is active after firing; set false if price reverses below OR High
      let aUpHeld = false;
      let failedAUpCount = 0, failedADownCount = 0;
      let aUpCooldown2 = 0, aDownCooldown2 = 0;
      let cUpLogged = false, cDownLogged = false;

      for (const bar of postOR) {
        const t = new Date(bar.ts).toISOString().slice(11, 16);
        const barMinutes = bar.bar_min;

        if (aUpCooldown2 > 0) aUpCooldown2--;
        if (aDownCooldown2 > 0) aDownCooldown2--;

        // Track A Up path — keep tracking even after fire to catch reversals and re-tests
        if (!aDownFiredTimeline) {
          // Pre-fire: detect initial test and sustained fire
          if (!aUpFiredTimeline) {
            if (!aUpTouchTime && aUpCooldown2 === 0 && bar.high >= aUp) {
              aUpTouchTime = t;
              const testLabel = failedAUpCount > 0 ? ` (re-test ${failedAUpCount + 1})` : '';
              timeline.push({ time: t, event: `A Up tested${testLabel}`, price: aUp, color: '#fbbf24',
                note: `Price reached the A Up level (${aUp.toFixed(2)})${failedAUpCount > 0 ? ' again after a prior failure' : ''}. The 5-minute sustain clock has started — if price holds above OR High (${orH.toFixed(2)}) without pulling back inside the OR, A Up fires and a long entry is valid.` });
            }
            if (aUpTouchTime) {
              if (bar.low < orH) {
                failedAUpCount++;
                const attemptLabel = failedAUpCount > 1 ? ` (attempt ${failedAUpCount})` : '';
                timeline.push({ time: t, event: `Failed A Up${attemptLabel}`, price: bar.close, color: '#f97316',
                  note: `Price reached the A Up level${failedAUpCount > 1 ? ' again' : ''} but fell back below OR High (${orH.toFixed(2)}) before sustaining 5 minutes. ${failedAUpCount > 1 ? 'Second failure — stronger conviction that bulls cannot hold this level. ' : ''}Short setup: entry near OR High on the reversal, stop above session high (${sessionHigh.toFixed(2)}).` });
                aUpTouchTime = null; aUpCooldown2 = 15;
              } else if (barMinutes - (parseInt(aUpTouchTime.split(':')[0])*60 + parseInt(aUpTouchTime.split(':')[1])) >= 5) {
                aUpFiredTimeline = true; aUpHeld = true;
                timeline.push({ time: t, event: 'A Up fired', price: aUp, color: '#22c55e',
                  note: `A Up confirmed — price held above OR High (${orH.toFixed(2)}) for 5 consecutive minutes. Long entry at ${aUp.toFixed(2)}, stop at OR Low (${orL.toFixed(2)}). Hold duration depends on confluence score.` });
                aUpTouchTime = null;
              }
            }
          } else {
            // Post-fire: track if price reverses below OR High (Failed to hold) then re-tests
            if (bar.low < orH && aUpTouchTime !== 'reversed') {
              aUpTouchTime = 'reversed'; aUpHeld = false;
              failedAUpCount++;
              const attemptLabel = failedAUpCount > 1 ? ` (attempt ${failedAUpCount})` : '';
              timeline.push({ time: t, event: `Failed A Up${attemptLabel}`, price: bar.close, color: '#f97316',
                note: `A Up had fired but price reversed back below OR High (${orH.toFixed(2)}). The breakout failed to hold — short setup. Entry near OR High, stop above session high (${sessionHigh.toFixed(2)}).` });
            } else if (aUpTouchTime === 'reversed' && bar.high >= aUp) {
              // Price re-tested A Up after reversal — reset for next failure detection
              aUpTouchTime = t;
              timeline.push({ time: t, event: `A Up tested (re-test ${failedAUpCount + 1})`, price: aUp, color: '#fbbf24',
                note: `Price returned to the A Up level (${aUp.toFixed(2)}) after a prior failure. Watching for sustained hold or another rejection.` });
            } else if (aUpTouchTime !== null && aUpTouchTime !== 'reversed' && bar.low < orH) {
              failedAUpCount++;
              timeline.push({ time: t, event: `Failed A Up (attempt ${failedAUpCount})`, price: bar.close, color: '#f97316',
                note: `Price reached A Up again but failed to hold above OR High (${orH.toFixed(2)}). Repeated failure strengthens the short case.` });
              aUpTouchTime = 'reversed';
            }
          }
        }

        // Track A Down path — allowed if A Up never fired, or if A Up fired but reversed (no longer held)
        if (!aUpHeld) {
          if (!aDownTouchTime && aDownCooldown2 === 0 && bar.low <= aDown) {
            aDownTouchTime = t;
            timeline.push({ time: t, event: failedADownCount > 0 ? `A Down tested (re-test ${failedADownCount+1})` : 'A Down tested', price: aDown, color: '#fbbf24',
              note: `Price reached the A Down level (${aDown.toFixed(2)}) for the first time. The 5-minute sustain clock has started — if price holds below OR Low (${orL.toFixed(2)}) without pulling back inside the OR, A Down fires and a short entry is valid.` });
          }
          if (aDownTouchTime && !aDownFiredTimeline) {
            if (bar.high > orL) {
              failedADownCount++;
              const attemptLabelD = failedADownCount > 1 ? ` (attempt ${failedADownCount})` : '';
              timeline.push({ time: t, event: `Failed A Down${attemptLabelD}`, price: bar.close, color: '#a78bfa',
                note: `Price reached the A Down level${failedADownCount > 1 ? ' again' : ''} but rose back above OR Low (${orL.toFixed(2)}) before sustaining 5 minutes. ${failedADownCount > 1 ? 'Second failure — stronger conviction bears cannot hold. ' : ''}Long setup: entry near OR Low on the bounce, stop below the session low (${sessionLow.toFixed(2)}).` });
              aDownTouchTime = null; aDownCooldown2 = 15;
            } else if (barMinutes - (parseInt(aDownTouchTime.split(':')[0])*60 + parseInt(aDownTouchTime.split(':')[1])) >= 5) {
              aDownFiredTimeline = true;
              timeline.push({ time: t, event: 'A Down fired', price: aDown, color: '#ef4444',
                note: `A Down confirmed — price held below OR Low (${orL.toFixed(2)}) for 5 consecutive minutes without pulling back inside the OR. Short entry at ${aDown.toFixed(2)}, stop at OR High (${orH.toFixed(2)}). Hold duration depends on confluence score.` });
            }
          }
        }

        // C confirmations
        // G-Line (weekly open) — first touch, first close below (lost), first close above after lost (reclaimed)
        if (gLine) {
          if (!timeline.some(e => e.event.startsWith('G-Line')) && bar.low <= gLine && bar.high >= gLine) {
            timeline.push({ time: t, event: 'G-Line tested', price: gLine, color: '#f59e0b',
              note: `Price tested the G-Line (${gLine.toFixed(2)}) — the weekly open from Monday's session.\n\nAbove G-Line = week is positive / buyers in control. Below = week is negative / sellers in control. First test of this level is the key tell: does it hold or break?` });
          }
          if (!timeline.some(e => e.event === 'G-Line lost') && bar.close < gLine) {
            timeline.push({ time: t, event: 'G-Line lost', price: bar.close, color: '#f59e0b',
              note: `Price closed below the G-Line (${gLine.toFixed(2)}) — the weekly open. The week has turned negative. Sellers are in control of the weekly timeframe. A Down signals and short setups now have structural weekly tailwind.` });
          }
          if (timeline.some(e => e.event === 'G-Line lost') && !timeline.some(e => e.event === 'G-Line reclaimed') && bar.close > gLine) {
            timeline.push({ time: t, event: 'G-Line reclaimed', price: bar.close, color: '#f59e0b',
              note: `Price reclaimed the G-Line (${gLine.toFixed(2)}) after losing it — closed back above the weekly open. Bullish recovery. Week has turned positive again. A Up signals now have structural weekly tailwind.` });
          }
        }

        // Prior month VAH — first touch and first close-through
        if (pmVAH) {
          if (!timeline.some(e => e.event.startsWith('PM VAH')) && bar.high >= pmVAH) {
            timeline.push({ time: t, event: 'PM VAH tested', price: pmVAH, color: '#10b981',
              note: `Price touched the prior month value area high (${pmVAH.toFixed(0)}) — the top of where 70% of last month's volume was accepted.\n\nAbove PM VAH = price is above monthly accepted value — buyers accepting prices beyond last month's range. Strongly initiative on the monthly timeframe.\nBelow PM VAH = still within or below monthly value — responsive territory.` });
          }
          if (!timeline.some(e => e.event === 'PM VAH broken') && bar.close > pmVAH) {
            timeline.push({ time: t, event: 'PM VAH broken', price: bar.close, color: '#10b981',
              note: `A bar closed above the prior month value area high (${pmVAH.toFixed(0)}) — price accepted above the monthly range. Multi-timeframe bullish structural shift. Prior month VAH flips to support on the monthly timeframe.` });
          }
        }
        // Prior month VAL — first touch and first close-through
        if (pmVAL) {
          if (!timeline.some(e => e.event.startsWith('PM VAL')) && bar.low <= pmVAL) {
            timeline.push({ time: t, event: 'PM VAL tested', price: pmVAL, color: '#10b981',
              note: `Price touched the prior month value area low (${pmVAL.toFixed(0)}) — the bottom of where 70% of last month's volume was accepted.\n\nBelow PM VAL = price accepted below monthly value — sellers pushing below last month's range. Strongly initiative bearish.\nAbove PM VAL = still within monthly value — responsive territory.` });
          }
          if (!timeline.some(e => e.event === 'PM VAL broken') && bar.close < pmVAL) {
            timeline.push({ time: t, event: 'PM VAL broken', price: bar.close, color: '#10b981',
              note: `A bar closed below the prior month value area low (${pmVAL.toFixed(0)}) — price accepted below the monthly range. Bearish multi-timeframe structural shift.` });
          }
        }

        // PW High — first touch and first close-through
        if (pwHigh) {
          if (!timeline.some(e => e.event === 'PW High tested' || e.event === 'PW High broken') && bar.high >= pwHigh) {
            timeline.push({ time: t, event: 'PW High tested', price: pwHigh, color: '#c084fc',
              note: `Price touched the prior week high (${pwHigh.toFixed(2)}). Key resistance — the highest price traded during last week's RTH session. A close above confirms acceptance at a new weekly high; rejection here is a short lean.` });
          }
          if (!timeline.some(e => e.event === 'PW High broken') && bar.close > pwHigh) {
            timeline.push({ time: t, event: 'PW High broken', price: bar.close, color: '#c084fc',
              note: `A bar closed above the prior week high (${pwHigh.toFixed(2)}) — price is being accepted above last week's range. Bullish structural shift. Dalton: new value is being established above the prior reference. Prior week high now acts as support.` });
          }
        }
        // PW Low — first touch and first close-through
        if (pwLow) {
          if (!timeline.some(e => e.event === 'PW Low tested' || e.event === 'PW Low broken') && bar.low <= pwLow) {
            timeline.push({ time: t, event: 'PW Low tested', price: pwLow, color: '#c084fc',
              note: `Price touched the prior week low (${pwLow.toFixed(2)}). Key support — the lowest price traded during last week's RTH session. A close below confirms acceptance at a new weekly low; bounce here is a long lean.` });
          }
          if (!timeline.some(e => e.event === 'PW Low broken') && bar.close < pwLow) {
            timeline.push({ time: t, event: 'PW Low broken', price: bar.close, color: '#c084fc',
              note: `A bar closed below the prior week low (${pwLow.toFixed(2)}) — price is being accepted below last week's range. Bearish structural shift. Dalton: new value being established lower. Prior week low now acts as resistance.` });
          }
        }

        if (!cUpLogged && bar.close > orH) {
          cUpLogged = true;
          timeline.push({ time: t, event: aUpFiredTimeline ? 'C Up confirmed' : 'C Up (no A)', price: bar.close, color: aUpFiredTimeline ? '#22c55e' : '#6ee7b7',
            note: aUpFiredTimeline
              ? `A bar closed above OR High (${orH.toFixed(2)}) after A Up already fired. C confirmation means price is being accepted above the opening range — the breakout has follow-through. Strengthens the long case and supports holding the position.`
              : aDownFiredTimeline
                ? `A bar closed above OR High (${orH.toFixed(2)}) after A Down had fired. A Down sellers are now trapped — price above OR High invalidates the short premise and forces short covering.`
                : `A bar closed above OR High (${orH.toFixed(2)}) without A Up firing first. Weaker signal — price accepted above OR but didn't break the A level (${aUp.toFixed(2)}) with sustained conviction. Can still lean long but treat as lower confidence.` });
          // A Down fired earlier but price is now above OR High → TRT Long alert
          if (aDownFiredTimeline && !aUpFiredTimeline) {
            timeline.push({ time: t, event: 'TRT Long potential', price: bar.close, color: '#f59e0b',
              note: `C Up after A Down — potential TRT Long. A Down sellers trapped above OR High (${orH.toFixed(2)}). Short thesis invalidated. Trapped shorts covering fuels upside squeeze. Watch for entry on reclaim/hold of OR High as support. Stop below OR Low (${orL.toFixed(2)}).` });
          }
        }
        if (!cDownLogged && bar.close < orL) {
          cDownLogged = true;
          timeline.push({ time: t, event: aDownFiredTimeline ? 'C Down confirmed' : 'C Down (no A)', price: bar.close, color: aDownFiredTimeline ? '#ef4444' : '#fda4af',
            note: aDownFiredTimeline
              ? `A bar closed below OR Low (${orL.toFixed(2)}) after A Down already fired. C confirmation means price is being accepted below the opening range — the breakdown has follow-through. Strengthens the short case.`
              : `A bar closed below OR Low (${orL.toFixed(2)}) without A Down firing first. Weaker signal — price dipped below OR but didn't reach the A Down level (${aDown.toFixed(2)}). Likely a probe that lacked conviction. Lower confidence short lean.` });
        }
      }

      // Generate plain-English narrative of the session
      const narrative = [];

      // Opening
      narrative.push(`NQ opened with a ${orRange.toFixed(0)}-point opening range: high ${orH.toFixed(2)}, low ${orL.toFixed(2)}. A Up level: ${aUp.toFixed(2)}, A Down level: ${aDown.toFixed(2)}.`);

      // Walk through timeline events
      for (const ev of timeline) {
        if (ev.event === 'A Up tested') {
          narrative.push(`At ${ev.time}, price reached the A Up level (${aUp.toFixed(2)}). The 5-minute sustain clock started.`);
        } else if (ev.event === 'A Up fired') {
          narrative.push(`At ${ev.time}, A Up confirmed — price held above OR High for 5 minutes. Long signal active. Entry ${aUp.toFixed(2)}, stop at OR Low ${orL.toFixed(2)}.`);
        } else if (ev.event === 'Failed A Up') {
          narrative.push(`At ${ev.time}, the A Up attempt failed — price pulled back inside the OR (below ${orH.toFixed(2)}) before sustaining 5 minutes. This failure is a short setup: the bulls showed up, couldn't hold it. Entry near OR High on the way down, stop above the session high (${sessionHigh.toFixed(2)}).`);
        } else if (ev.event === 'A Down tested') {
          narrative.push(`At ${ev.time}, price reached the A Down level (${aDown.toFixed(2)}). The 5-minute sustain clock started.`);
        } else if (ev.event === 'A Down fired') {
          narrative.push(`At ${ev.time}, A Down confirmed — price held below OR Low for 5 minutes. Short signal active. Entry ${aDown.toFixed(2)}, stop at OR High ${orH.toFixed(2)}.`);
        } else if (ev.event === 'Failed A Down') {
          narrative.push(`At ${ev.time}, the A Down attempt failed — price recovered back inside the OR (above ${orL.toFixed(2)}). Long setup: the bears failed. Entry near OR Low on the bounce, stop below session low (${sessionLow.toFixed(2)}).`);
        } else if (ev.event === 'C Up confirmed') {
          narrative.push(`At ${ev.time}, C Up confirmed (close at ${ev.price.toFixed(2)}, above OR High ${orH.toFixed(2)}). Price is being accepted above the opening range — confirms the A Up signal and strengthens the long case.`);
        } else if (ev.event === 'C Down confirmed') {
          narrative.push(`At ${ev.time}, C Down confirmed (close at ${ev.price.toFixed(2)}, below OR Low ${orL.toFixed(2)}). Price accepted below the opening range — confirms the A Down signal.`);
        } else if (ev.event === 'C Up (no A)') {
          narrative.push(`At ${ev.time}, a bar closed above OR High (${ev.price.toFixed(2)}) but A Up never fired — price never reached the A Up level (${aUp.toFixed(2)}) with sustained conviction. Weaker signal, price explored above the OR without committing to a breakout.`);
        } else if (ev.event === 'C Down (no A)') {
          narrative.push(`At ${ev.time}, a bar closed below OR Low (${ev.price.toFixed(2)}) but A Down never fired — price dipped below the OR without reaching the A Down level (${aDown.toFixed(2)}). Weaker signal, likely a probe that faded.`);
        }
      }

      // Current state
      const distToAUp = aUp - currentPrice;
      const distToADown = currentPrice - aDown;
      if (timeline.length === 0) {
        narrative.push(`No setups have fired yet. Price (${currentPrice.toFixed(2)}) is ${distToAUp.toFixed(0)} points from A Up and ${distToADown.toFixed(0)} points from A Down. Watching both levels.`);
      } else {
        if (!a_up_fired && !a_down_fired) {
          if (currentPrice > orH) {
            narrative.push(`Currently price (${currentPrice.toFixed(2)}) is above OR High (${orH.toFixed(2)}) — ${distToAUp.toFixed(0)} points from A Up. Watching for a sustained push through ${aUp.toFixed(2)} or a rejection back inside the OR.`);
          } else if (currentPrice < orL) {
            narrative.push(`Currently price (${currentPrice.toFixed(2)}) is below OR Low (${orL.toFixed(2)}) — ${distToADown.toFixed(0)} points from A Down. Watching for sustained breakdown below ${aDown.toFixed(2)} or a recovery.`);
          } else {
            narrative.push(`Currently price (${currentPrice.toFixed(2)}) is back inside the OR (${orL.toFixed(2)}–${orH.toFixed(2)}). No active A signal. Ranging.`);
          }
        }
      }

      // ── Phase 3 auto-suggestions ──────────────────────────────────────────────
      // Bias: A signal overrides structure; fall back to overnight_inventory/open_vs_prior_value
      const todayRead = await query(`SELECT overnight_inventory, open_vs_prior_value FROM auction_reads WHERE trade_date=$1`, [todayET]);
      const inv2 = todayRead.rows[0]?.overnight_inventory;
      const val2 = todayRead.rows[0]?.open_vs_prior_value;
      const strLong  = (inv2==='SHORT_TRAPPED'&&val2!=='BELOW_VALUE')||(inv2==='NEUTRAL'&&val2==='ABOVE_VALUE');
      const strShort = (inv2==='LONG_TRAPPED'&&val2!=='ABOVE_VALUE')||(inv2==='NEUTRAL'&&val2==='BELOW_VALUE');
      const biasDir = a_up_fired ? 'LONG' : a_down_fired ? 'SHORT' : strLong ? 'LONG' : strShort ? 'SHORT' : 'NEUTRAL';

      // VWAP (volume-weighted close across all post-OR bars)
      const totalVol = postOR.reduce((s, b) => s + (Number(b.volume) || 1), 0);
      const vwap = postOR.reduce((s, b) => s + b.close * (Number(b.volume) || 1), 0) / totalVol;

      // 1. VWAP holding: current price on correct side of VWAP
      const p3_vwap_holding = biasDir === 'LONG' ? currentPrice > vwap
                            : biasDir === 'SHORT' ? currentPrice < vwap : false;

      // 2. Value migrating: VWAP now vs VWAP 20 bars ago (session weighted trend)
      const split = Math.max(1, postOR.length - 20);
      const earlyBars = postOR.slice(0, split);
      const earlyVol = earlyBars.reduce((s, b) => s + (Number(b.volume) || 1), 0);
      const earlyVwap = earlyBars.reduce((s, b) => s + b.close * (Number(b.volume) || 1), 0) / earlyVol;
      const p3_value_migrating = biasDir === 'LONG' ? vwap > earlyVwap
                               : biasDir === 'SHORT' ? vwap < earlyVwap : false;

      // 3. Delta confirming: close-position proxy (close near high = buy pressure)
      const last10 = postOR.slice(-10);
      const avgClosePos = last10.reduce((s, b) => {
        const rng = b.high - b.low;
        return s + (rng > 0 ? (b.close - b.low) / rng : 0.5);
      }, 0) / last10.length;
      const p3_delta_confirming = biasDir === 'LONG' ? avgClosePos > 0.55
                                : biasDir === 'SHORT' ? avgClosePos < 0.45 : false;

      // 4. Auction accepted: ≥40% of last 20 bars closing beyond OR in bias direction
      const last20 = postOR.slice(-20);
      const acceptCount = last20.filter(b =>
        biasDir === 'LONG' ? b.close > orH : biasDir === 'SHORT' ? b.close < orL : false
      ).length;
      const p3_auction_accepted = last20.length > 0 && acceptCount / last20.length >= 0.4;

      // 5. Rotations increasing: recent bar ranges expanding (balance/two-sided trade forming)
      const last16 = postOR.slice(-16);
      let p3_rotations_increasing = false;
      if (last16.length >= 8) {
        const half = Math.floor(last16.length / 2);
        const firstHalf = last16.slice(0, half);
        const secondHalf = last16.slice(half);
        const rng1 = Math.max(...firstHalf.map(b => b.high)) - Math.min(...firstHalf.map(b => b.low));
        const rng2 = Math.max(...secondHalf.map(b => b.high)) - Math.min(...secondHalf.map(b => b.low));
        p3_rotations_increasing = rng2 > rng1 * 1.15;
      }

      const p3Suggested = { p3_vwap_holding, p3_value_migrating, p3_delta_confirming, p3_auction_accepted, p3_rotations_increasing, vwap: Math.round(vwap * 100) / 100, biasDir };

      // ── Opening call auto-detection from first 15 min of bars (9:30–9:45) ──
      // Also include the OR bars (bm 570–574) for the first-bar open price
      const allBarsQ = await query(`
        SELECT high::float, low::float, close::float, open::float,
               EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) as bm
        FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
          AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 585
        ORDER BY ts
      `, [todayET]);
      const first15 = allBarsQ.rows;
      let opening_call_type = null;
      if (first15.length >= 5 && orH && orL) {
        const h15    = Math.max(...first15.map(b => b.high));
        const l15    = Math.min(...first15.map(b => b.low));
        const openPx = first15[0].open;
        const lastPx = first15[first15.length-1].close;
        const orRng  = orH - orL;
        const ext    = orRng * 0.3;   // 30% extension = meaningful push
        const ext50  = orRng * 0.5;   // 50% extension = drive territory
        const aboveOR = h15 - orH;    // how far above OR High
        const belowOR = orL - l15;    // how far below OR Low

        if (aboveOR > ext && belowOR > ext) {
          // Tested both sides — Open Test Drive
          opening_call_type = 'OPEN_TEST_DRIVE';
        } else if (aboveOR > ext50 && belowOR < ext * 0.3) {
          // Strong upside extension, no downside test — Open Drive
          opening_call_type = 'OPEN_DRIVE';
        } else if (belowOR > ext50 && aboveOR < ext * 0.3) {
          // Strong downside extension, no upside test — Open Drive
          opening_call_type = 'OPEN_DRIVE';
        } else if ((aboveOR > ext || belowOR > ext) && Math.abs(lastPx - (orH+orL)/2) < orRng * 0.4) {
          // Extended one side but price came back toward midpoint — ORR
          opening_call_type = 'OPEN_REJECTION_REVERSE';
        } else {
          // Stayed within or near OR — Open Auction
          opening_call_type = 'OPEN_AUCTION';
        }
      }

      // Derive setup and signal flags from live bar analysis (timeline), not stale DB values
      let liveSetup = setup, liveColor = color, liveDescription = description;
      if (aUpFiredTimeline && cUp) {
        liveSetup = 'A Up + C Confirmed'; liveColor = '#22c55e';
        liveDescription = `A Up fired and C Up confirmed. Strong continuation long. Price ${currentPrice.toFixed(2)}, above OR High ${orH.toFixed(2)}.`;
      } else if (aUpFiredTimeline) {
        liveSetup = 'A Up (no C yet)'; liveColor = '#86efac';
        liveDescription = `A Up fired. Waiting for C Up confirmation (close above OR High ${orH.toFixed(2)}). Still valid long.`;
      } else if (aDownFiredTimeline && cDown) {
        liveSetup = 'A Down + C Confirmed'; liveColor = '#ef4444';
        liveDescription = `A Down fired and C Down confirmed. Strong continuation short. Price ${currentPrice.toFixed(2)}, below OR Low ${orL.toFixed(2)}.`;
      } else if (aDownFiredTimeline) {
        liveSetup = 'A Down (no C yet)'; liveColor = '#fca5a5';
        liveDescription = `A Down fired. Waiting for C Down confirmation (close below OR Low ${orL.toFixed(2)}).`;
      } else if (timeline.some(e => e.event?.startsWith('Failed A Up') && !e.event.includes('attempt'))) {
        liveSetup = 'Failed A Up'; liveColor = '#f97316';
      } else if (timeline.some(e => e.event?.startsWith('Failed A Down') && !e.event.includes('attempt'))) {
        liveSetup = 'Failed A Down'; liveColor = '#a78bfa';
      }

      // NL30 for dynamic conviction (reuse cache from setup-detection when available)
      let liveNL30 = 0, liveStructState = null;
      const cachedNL30 = getCached(todayET, 'nl30');
      if (cachedNL30) {
        liveNL30 = cachedNL30.nl30;
        liveStructState = cachedNL30.nl30State === 'BULLISH' ? 'TRENDING_UP' : cachedNL30.nl30State === 'BEARISH' ? 'TRENDING_DOWN' : 'BALANCE';
      } else {
        try {
          const nlQ = await query(`SELECT SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as nl30 FROM acd_daily_log WHERE daily_score IS NOT NULL ORDER BY trade_date DESC LIMIT 1`);
          liveNL30 = parseInt(nlQ.rows[0]?.nl30) || 0;
          liveStructState = liveNL30 > 9 ? 'TRENDING_UP' : liveNL30 < -9 ? 'TRENDING_DOWN' : 'BALANCE';
        } catch (_) {}
      }

      const rawConviction = await getConvictionData().catch(() => null);
      const conviction = rawConviction
        ? Object.fromEntries(Object.entries(rawConviction).map(([k, v]) => [
            k, v ? { ...v, dynamic: computeDynamicConviction(v, k, { nl30: liveNL30, structuralState: liveStructState }) } : null
          ]))
        : null;

      // Day type classification (available after IB close at 10:00 AM, updates at 10:30 and 11:00)
      // Use timeline-based failure detection — simple failedAUp is false when a_up_fired=true in DB
      const etMinLive = nowET.getHours() * 60 + nowET.getMinutes();
      let dayType = null;
      if (etMinLive >= 10 * 60) {
        const tlFailedAUp   = timeline.some(e => e.event?.startsWith('Failed A Up'));
        const tlFailedADown = timeline.some(e => e.event?.startsWith('Failed A Down'));
        const hasA  = aUpFiredTimeline || aDownFiredTimeline;
        const hasFA = tlFailedAUp || tlFailedADown;
        const trendLong  = aUpFiredTimeline   && cUp   && !tlFailedAUp;
        const trendShort = aDownFiredTimeline && cDown && !tlFailedADown;
        if (trendLong || trendShort) {
          dayType = { label: 'TREND DAY', color: trendLong ? '#22c55e' : '#ef4444', detail: 'Directional — go with the drive' };
        } else if ((hasA && hasFA) || (aUpFiredTimeline && cDown) || (aDownFiredTimeline && cUp) || (tlFailedAUp && tlFailedADown)) {
          dayType = { label: 'NEUTRAL DAY', color: '#94a3b8', detail: 'Both sides rejected — wait for extremes' };
        } else if (hasA && !hasFA) {
          dayType = { label: 'NORMAL DAY', color: '#f59e0b', detail: 'Responsive at extremes' };
        } else if ((cUp || cDown) && !hasA) {
          dayType = { label: 'NORMAL DAY', color: '#f59e0b', detail: 'C signal — responsive probe' };
        } else {
          dayType = { label: 'BRACKET DAY', color: '#6366f1', detail: 'Fade value area extremes' };
        }
      }

      res.json({
        setup: liveSetup, color: liveColor, description: liveDescription, currentPrice, barTime,
        orHigh: orH, orLow: orL, aUpLevel: aUp, aDownLevel: aDown,
        gLine, gLineDaysHeld, gLineStatus,
        pwHigh, pwLow, pmVAH, pmVAL, pmPOC, monthOpen,
        sessionHigh, sessionLow,
        aUpFired: aUpFiredTimeline, aDownFired: aDownFiredTimeline,
        reachedAUp, reachedADown, failedAUp, failedADown, cUp, cDown,
        barsAnalyzed: postOR.length,
        weisWarning,
        timeline, narrative, p3Suggested, opening_call_type,
        nl30: liveNL30,
        conviction,
        dayType,
        dayOfWeek: new Date(todayET + 'T12:00:00').getDay(), // 1=Mon … 5=Fri
        earlyClose: getEarlyCloseMinute(todayET) ? { rthCloseEtMin: getEarlyCloseMinute(todayET), label: getMarketStatus(todayET)?.name } : null,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/engine-reads/hit-rates — historical hit rates from engine_reads table
  // Used by dashboard to show calibrated conviction next to A signals and pre-market bias reads.
  // N<20 decisive outcomes = not confident; never display a percentage as reliable below this threshold.
  router.get('/engine-reads/hit-rates', async (req, res) => {
    try {
      // Compute overall and by-bias-context hit rates for each signal type+value
      const rows = await query(`
        SELECT read_type, signal_value, session_bias_context,
          COUNT(*) FILTER (WHERE outcome IN ('CORRECT','WRONG')) AS decisive,
          COUNT(*) FILTER (WHERE outcome = 'CORRECT')            AS correct,
          COUNT(*) FILTER (WHERE outcome = 'WRONG')              AS wrong,
          COUNT(*)                                               AS n
        FROM engine_reads
        WHERE outcome IS NOT NULL
        GROUP BY read_type, signal_value, session_bias_context
        ORDER BY read_type, signal_value, session_bias_context
      `);

      // Build structured result
      // Keys: 'A_UP', 'A_DOWN', 'BIAS_LONG', 'BIAS_SHORT', 'BIAS_NEUTRAL'
      const result = {};
      for (const r of rows.rows) {
        const decisive = parseInt(r.decisive), correct = parseInt(r.correct), wrong = parseInt(r.wrong), n = parseInt(r.n);
        const hitRate  = decisive > 0 ? correct / decisive : null;
        const confident = decisive >= 20;
        const entry = { n, decisive, correct, wrong, hitRate, confident };

        const key = r.read_type === 'A_SIGNAL' ? r.signal_value : `BIAS_${r.signal_value}`;
        if (!result[key]) result[key] = { overall: null, byBias: {} };
        if (r.session_bias_context) result[key].byBias[r.session_bias_context] = entry;
      }

      // Overall (all bias contexts combined) per signal type+value
      const overall = await query(`
        SELECT read_type, signal_value,
          COUNT(*) FILTER (WHERE outcome IN ('CORRECT','WRONG')) AS decisive,
          COUNT(*) FILTER (WHERE outcome = 'CORRECT')            AS correct,
          COUNT(*) FILTER (WHERE outcome = 'WRONG')              AS wrong,
          COUNT(*)                                               AS n
        FROM engine_reads
        WHERE outcome IS NOT NULL
        GROUP BY read_type, signal_value
      `);
      for (const r of overall.rows) {
        const decisive = parseInt(r.decisive), correct = parseInt(r.correct), wrong = parseInt(r.wrong), n = parseInt(r.n);
        const hitRate  = decisive > 0 ? correct / decisive : null;
        const confident = decisive >= 20;
        const key = r.read_type === 'A_SIGNAL' ? r.signal_value : `BIAS_${r.signal_value}`;
        if (!result[key]) result[key] = { overall: null, byBias: {} };
        result[key].overall = { n, decisive, correct, wrong, hitRate, confident };
      }

      // NEW: level-touch (IB/PD/VWAP reversal-bounce rates) and combo (level-confluence)
      // hit rates from setup_correlation_cache / combo_stats — same N>=20 confidence rule.
      const [levelTouches, combos] = await Promise.all([getLevelTouchLookup(), getComboLookup()]);

      res.json({ rates: result, levelTouches, combos, computedAt: new Date().toISOString() });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Per-level cooldown for APPROACHING alerts — prevents spam on balance days.
  // Map: levelName → timestamp of last emit. Cleared at session close.
  const _approachCooldown = new Map();
  const APPROACH_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes per level
  const APPROACH_MIN_EV = 20; // only PRIME/SOLID tiers ($20+ EV)

  // GET /api/acd/setup-detection — detect the highest-priority intraday setup
  // Returns one setup card at a time. Priority: IB_CONFIRMATION > OPEN_DRIVE_CONT >
  // FAILED_AUCTION > BRACKET_BREAKOUT > VALUE_AREA_RESP
  //
  // Genuinely expensive (~5-8s of real DB/CPU work, profiled 2026-07-15 — see
  // docs/OPEN_THREADS.md) yet polled every 15s by SizeChip (MarketPulseBar.jsx) plus
  // fetched by several other Morning Prep cards on mount. A response slower than the
  // poll interval means overlapping requests pile up indefinitely — each new one
  // competes with still-running ones for the same DB connections, making every one
  // progressively slower (this project's own OPEN_THREADS already flagged "no lock
  // against overlapping invocations" as a known risk here, never fixed until now).
  // runSetupDetection is unchanged from before; only the request-coalescing wrapper
  // below is new. Only `res.json`/`res.status` are called anywhere in this handler
  // (checked), so a minimal fake res capturing just those two is a safe substitute
  // for concurrent callers that share this same in-flight computation.
  // Extracted 2026-07-27 so this runs in BOTH the RTH and Globex branches of
  // runSetupDetection below -- originally written with isGlobexNow branches baked
  // in throughout (different volZ/OSR/cluster-size cutoffs, RTH-only pace/stop/
  // target fields), but physically placed after the Globex early-return, so those
  // branches were dead code in practice: during the 6PM-8:30AM ET window the route
  // always exited before ever reaching this block. Per the standing rule (never
  // ship RTH-only and call it done without checking Globex), this now actually
  // runs in both.
  async function computeStackVolSignal(todayET) {
    let stackVolSignal = { active: false, direction: null, sigma: null, oneSidedRatio: null, levelDensity: 0, levels: [], paceZ: null, consecutiveCount: null, calibratedStop: null, calibratedStopType: null, calibratedTarget: null, manageGuidance: null };
    try {
      const svBarsQ = await query(`
        SELECT ts, close::float, high::float, low::float, open::float,
               EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) as tod,
               bid_volume::int, ask_volume::int,
               EXTRACT(EPOCH FROM (ts - LAG(ts) OVER (ORDER BY ts))) / 60 AS gap
        FROM price_bars_primary
        WHERE symbol='NQ' AND ts >= (SELECT MAX(ts) FROM price_bars_primary WHERE symbol='NQ') - interval '3 hours'
        ORDER BY ts ASC
      `);
      const svBars = svBarsQ.rows;
      if (svBars.length > 31) {
        const i = svBars.length - 1;
        const bar = svBars[i];
        const isGlobexNow = bar.tod < 570 || bar.tod >= 960;
        const svThresholds = isGlobexNow ? STACK_VOL_THRESHOLDS.GLOBEX : STACK_VOL_THRESHOLDS.RTH;
        const { volZCutoff, osrCutoff, minClusterSize } = svThresholds;

        // Levels: same daily-cached level_prices batch as the rest of this handler,
        // plus real-time OR/IB (not from level_prices, which may lag same-day formation)
        // plus live developing VWAP (never in level_prices at all -- a per-bar value).
        // RTH_VWAP excluded: it's a full-RTH-session average (compute_levels.js sums bars
        // 570-959 with no "as of now" cap), only actually correct once RTH closes for that
        // date -- backtest_confluence.js already excludes it for exactly this reason ("a
        // real lookahead risk in a bar sim"). Live, the same value is just as wrong for a
        // different reason: found 2026-07-27 that today's row was written mid-session
        // (computed_at 14:40 ET) by a manual/testing invocation of compute_levels.js, so it
        // was a PARTIAL-session sum through 2:40pm masquerading as the full session's VWAP --
        // and DAY_CACHE_TTL (12h) would have frozen that wrong number in svLevelsRaw for the
        // rest of the day. The live developing `VWAP` key below (computeVWAP, bounded to
        // bars seen so far) is the correct live equivalent -- RTH_VWAP is redundant with it
        // at best and actively wrong at worst.
        const svLevelsRaw = getCached(todayET, 'stackVolLevels', DAY_CACHE_TTL) || await (async () => {
          const lpQ = await query(`SELECT level_name, price::float FROM level_prices WHERE trade_date=$1 AND price IS NOT NULL AND level_name != 'RTH_VWAP'`, [todayET]);
          const map = {};
          for (const r of lpQ.rows) map[r.level_name] = r.price;
          // 3 meta-levels the main RTH fade engine (keepLevelsAll) tracks that aren't
          // stored in level_prices directly -- computed inline there via developing_value_log
          // / computeVolumeProfileForRange, same real functions reused here, own cache keys
          // so this doesn't duplicate work if the main RTH path already computed them this
          // session (getCached checks the shared per-request cache map regardless of key
          // namespace, so a cache hit here is free even on first call if the RTH path ran
          // first in the same poll).
          const pd2 = getCached(todayET, 'pd2VA') || await (async () => {
            const pd2Q = await query(`
              SELECT vah::float, val::float FROM developing_value_log
              WHERE trade_date < (SELECT MAX(trade_date) FROM developing_value_log WHERE trade_date < $1)
              ORDER BY trade_date DESC LIMIT 1
            `, [todayET]).catch(() => ({ rows: [] }));
            const v = pd2Q.rows[0] ? { pd2VAH: pd2Q.rows[0].vah, pd2VAL: pd2Q.rows[0].val } : { pd2VAH: null, pd2VAL: null };
            return setCached(todayET, 'pd2VA', v);
          })();
          if (pd2.pd2VAH != null) map.PD2_VAH = pd2.pd2VAH;
          if (pd2.pd2VAL != null) map.PD2_VAL = pd2.pd2VAL;
          const cached2DPOC = getCached(todayET, '2dPOC');
          const twoDayPOC = cached2DPOC !== undefined ? cached2DPOC : await (async () => {
            const last2Q = await query(`
              SELECT DISTINCT ts::date::text as d FROM price_bars_primary
              WHERE symbol='NQ' AND ts::date < $1
                AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
              ORDER BY d DESC LIMIT 2
            `, [todayET]).then(r => r.rows.map(x => x.d)).catch(() => []);
            if (last2Q.length < 2) return setCached(todayET, '2dPOC', null);
            const profile = await computeVolumeProfileForRange(query, { startDate: last2Q[last2Q.length - 1], endDate: last2Q[0] }).catch(() => null);
            return setCached(todayET, '2dPOC', profile ? profile.poc : null);
          })();
          if (twoDayPOC != null) map['2D_POC'] = twoDayPOC;
          return setCached(todayET, 'stackVolLevels', map);
        })();
        const svLevels = { ...svLevelsRaw };
        if (bar.tod < 630) { delete svLevels.IB_HIGH; delete svLevels.IB_LOW; delete svLevels.IB_MID; }
        if (bar.tod < 575) { delete svLevels.OR5_HIGH; delete svLevels.OR5_LOW; }
        if (!isGlobexNow) svLevels.VWAP = computeVWAP(svBars, i);

        const levelsArr = Object.entries(svLevels).filter(([, p]) => p != null && isFinite(p)).map(([name, price]) => ({ name, price })).sort((a, b) => a.price - b.price);
        const clusters = [];
        let cur = levelsArr.length ? [levelsArr[0]] : [];
        for (let j = 1; j < levelsArr.length; j++) {
          if (levelsArr[j].price - levelsArr[j - 1].price <= 15) cur.push(levelsArr[j]);
          else { clusters.push(cur); cur = [levelsArr[j]]; }
        }
        if (cur.length) clusters.push(cur);

        const totalVol = (bar.bid_volume || 0) + (bar.ask_volume || 0);
        const svBaseline = await getTouchQualityBaseline(todayET);
        const bl = svBaseline.get(Number(bar.tod));
        const volZ = (bl && bl.std_vol > 0) ? (totalVol - bl.avg_vol) / bl.std_vol : 0;

        // Pace/no-countermovement (RTH only) -- consecutiveCount = how many of the last 5
        // bars closed the same direction as the candidate break; paceZ = trailing-5-bar net
        // move vs a real 20-day per-minute-of-day baseline (getPaceBaseline), not a static
        // point cutoff.
        let consecutiveCount = 0, paceZ = 0;
        if (!isGlobexNow) {
          const paceBaseline = await getPaceBaseline(todayET);
          const pBl = paceBaseline.get(Number(bar.tod));
          const prev5Close = i >= 5 ? svBars[i - 5].close : svBars[0].close;
          const netPace = Math.abs(bar.close - prev5Close);
          paceZ = (pBl && pBl.std_pace > 0) ? (netPace - pBl.avg_pace) / pBl.std_pace : 0;
        }

        for (const cluster of clusters) {
          if (cluster.length < minClusterSize) continue;
          const clusterMin = cluster[0].price, clusterMax = cluster[cluster.length - 1].price;
          let direction = null;
          // Gap guard: a bar whose OWN gap (distance from its predecessor) exceeds ~5min
          // (the measured real small-gap ceiling in this codebase's own RTH/Globex data,
          // see the barsAdjacent() precedent in pilot_level_agnostic_touch_battle_quality.mjs)
          // means everything before it is on the OTHER side of a real discontinuity (most
          // commonly the daily 5-6PM ET maintenance halt, which this 3-hour lookback window
          // can span) -- stop the backward scan there rather than comparing pre/post-gap
          // price as if it were one continuous sequence.
          if (bar.close < clusterMin) {
            let foundAbove = false, validBreak = true;
            for (let k = 1; k <= 30; k++) {
              const pb = svBars[i - k]; if (!pb) break;
              if (pb.gap == null || pb.gap > 5) { validBreak = false; break; }
              if (pb.close >= clusterMax) { foundAbove = true; break; }
              if (pb.close < clusterMin) { validBreak = false; break; }
            }
            if (foundAbove && validBreak) direction = 'SHORT';
          } else if (bar.close > clusterMax) {
            let foundBelow = false, validBreak = true;
            for (let k = 1; k <= 30; k++) {
              const pb = svBars[i - k]; if (!pb) break;
              if (pb.gap == null || pb.gap > 5) { validBreak = false; break; }
              if (pb.close <= clusterMin) { foundBelow = true; break; }
              if (pb.close > clusterMax) { validBreak = false; break; }
            }
            if (foundBelow && validBreak) direction = 'LONG';
          }
          if (!direction) continue;

          if (!isGlobexNow) {
            consecutiveCount = 0;
            for (let k = Math.max(0, i - 4); k <= i; k++) {
              const b = svBars[k];
              if (direction === 'SHORT' && b.close < b.open) consecutiveCount++;
              if (direction === 'LONG' && b.close > b.open) consecutiveCount++;
            }
          }

          // Structural stop placement (RTH only): RESEARCH_CLAIM
          // structural_next_level_stop_beats_fixed_and_median_control -- a stop placed at
          // the NEXT real level beyond the one just broken (not the immediate cluster edge,
          // and not a fixed 40pt) beat both the fixed-40 baseline AND a FIXED_AT_MEDIAN
          // control (same avg width, not level-informed) at target=40pt, clean on rigor.
          // levelsArr is already sorted by price. Falls back to the fixed 40pt if no level
          // exists within 200pt (matches the backtest's own fallback population, which
          // excluded those ~2% of cases rather than guessing a distance for them).
          let nextLevelBeyondDist = null;
          if (!isGlobexNow) {
            if (direction === 'SHORT') {
              for (const l of levelsArr) {
                if (l.price > clusterMax) { nextLevelBeyondDist = l.price - bar.close; break; }
              }
            } else {
              for (let j = levelsArr.length - 1; j >= 0; j--) {
                if (levelsArr[j].price < clusterMin) { nextLevelBeyondDist = bar.close - levelsArr[j].price; break; }
              }
            }
            if (nextLevelBeyondDist != null && nextLevelBeyondDist > 200) nextLevelBeyondDist = null;
          }

          const favorableVol = direction === 'LONG' ? (bar.ask_volume || 0) : (bar.bid_volume || 0);
          const adverseVol = direction === 'LONG' ? (bar.bid_volume || 0) : (bar.ask_volume || 0);
          const oneSidedRatio = (favorableVol + adverseVol) > 0 ? favorableVol / (favorableVol + adverseVol) : 0.5;

          const paceOk = isGlobexNow ? true : (consecutiveCount >= 4 && paceZ >= 1);
          if (volZ >= volZCutoff && oneSidedRatio >= osrCutoff && paceOk) {
            const levelDensity = levelsArr.filter(l => Math.abs(l.price - bar.close) <= 40).length;
            stackVolSignal = {
              active: true, direction, sigma: +volZ.toFixed(2), oneSidedRatio: +oneSidedRatio.toFixed(2),
              levelDensity, levels: levelsArr.filter(l => Math.abs(l.price - bar.close) <= 40).map(l => l.name),
              paceZ: isGlobexNow ? null : +paceZ.toFixed(2), consecutiveCount: isGlobexNow ? null : consecutiveCount,
              calibratedStop: isGlobexNow ? null : +(nextLevelBeyondDist ?? 40).toFixed(1),
              calibratedStopType: isGlobexNow ? null : (nextLevelBeyondDist != null ? 'LEVEL_NEXT' : 'FIXED_FALLBACK'),
              // Direction-specific, via computeCorrectedTarget() (the real, already-audited
              // target-calibration pipeline every other setup_type in this codebase uses --
              // thin-tail gate, chronological OOS split, plateau check, must beat baseline
              // both in-sample and OOS, rigor-clean), NOT a raw best-EV grid pick.
              // RESEARCH_CLAIM stackvol_target_direction_specific_calibration_2026_07_27:
              // LONG clears every guardrail at 70pt (N=215, oosEv=+$1.74 thin but positive,
              // rigor-clean, though the most recent chronological third shows the edge
              // thinning to $0.15/trade -- worth re-checking as more data accumulates).
              // SHORT FAILED calibration (oosEv=-$24.73 despite a positive in-sample read)
              // -- widening would have been a real mistake, stays at the original 40pt.
              calibratedTarget: isGlobexNow ? null : (direction === 'LONG' ? 70 : 40),
              // Informational only, not a mechanism this signal can enforce itself (it's a
              // momentary, fire-once flag, not a tracked position walked bar-by-bar the way
              // real active_setups rows are for bar6_checkpoint) -- surfaces the synthesized
              // finding from this arc's full research pass (RESEARCH_CLAIMs
              // path_quality_bars_to_target_predicts_continuation,
              // capture_ratio_flat_wide_beats_trailing_on_tail_moves,
              // combined_system_volz_climax_hurts_grinding_cohort): tested volume-climax
              // exits, arm-a-trail mechanisms, and direct volume exits as ways to extend a
              // winning trade -- ALL of them underperformed a plain wide (~150pt) target on
              // capturing the biggest moves, because trailing/volume logic gets shaken out
              // by normal chop that a patient fixed level doesn't react to. Separately: HOW
              // FAST a trade reaches its initial target matters more than any volume signal
              // -- reaching target in <=9 bars is a climax pattern (extending it loses money,
              // median -$135/trade on the fastest arrivals); reaching it in 10-25 bars (a
              // grinding pace) is a real trend worth extending toward a wider target instead
              // of taking the original one. Now a real, dynamically-updating mechanism (below
              // + resolveSetupsByPrice()'s extend_target_level branch), not just this string --
              // promote_stackvol_to_tracked_setup, resolved 2026-07-27.
              manageGuidance: isGlobexNow ? null : 'If this reaches its target FAST (roughly under 10 bars), take it -- that\'s usually a climax, not a trend, and holding past it has lost money on backtest. If it grinds there gradually (10-25 bars), that\'s a real trend -- consider riding to a much wider target (~150pt) instead of the original one, rather than trailing tightly.',
            };
            const dedupeKey = `${todayET}_${Math.floor(bar.tod / 5)}_${direction}`;
            query(`
              INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes)
              VALUES ($1, 0, 'STACK_VOL_BREAK_LIVE', $2, 1, $3)
              ON CONFLICT (run_date, window_days, signal_type, signal_name) DO NOTHING
            `, [todayET, dedupeKey, JSON.stringify({ direction, volZ: stackVolSignal.sigma, oneSidedRatio: stackVolSignal.oneSidedRatio, levelDensity, levels: stackVolSignal.levels, paceZ: stackVolSignal.paceZ, consecutiveCount: stackVolSignal.consecutiveCount, calibratedStop: stackVolSignal.calibratedStop, calibratedStopType: stackVolSignal.calibratedStopType, calibratedTarget: stackVolSignal.calibratedTarget, definitionVersion: 3, triggeredAt: new Date().toISOString() })]).catch(() => {});

            // Real active_setups tracking (promote_stackvol_to_tracked_setup, 2026-07-27):
            // RTH only -- the bank-vs-extend research (path_quality_bars_to_target_predicts_
            // continuation) was validated specifically against the RTH loose-confluence+pace
            // population with a LEVEL_NEXT/fixed-40 stop and a direction-specific calibrated
            // target; the Globex fire above has no calibratedStop/calibratedTarget at all (a
            // different, unvalidated-for-this-mechanism recipe), so it stays informational-only
            // via the performance_audit row above until its own stop/target get calibrated.
            // extend_target_level (entry +/-150pt) is set unconditionally here -- non-null
            // flags this row for the bank-vs-extend branch in resolveSetupsByPrice(), the same
            // "one column is both the eligibility flag and the value" convention already used
            // by runner_trail_width for the breakeven-trail mechanism.
            if (!isGlobexNow) {
              const svSetupType = `STACK_VOL_BREAK_LIVE_${direction}`;
              const svEntry = bar.close;
              const svStop = direction === 'LONG' ? svEntry - stackVolSignal.calibratedStop : svEntry + stackVolSignal.calibratedStop;
              const svT1 = direction === 'LONG' ? svEntry + stackVolSignal.calibratedTarget : svEntry - stackVolSignal.calibratedTarget;
              const svExtendTarget = direction === 'LONG' ? svEntry + 150 : svEntry - 150;
              const svExpiresAt = `${todayET} 16:00:00`;
              getStackVolBreakLiveStatus(svSetupType).then(async (live) => {
                const svRegimeStamp = computeRegimeStamp(svEntry, await getValueAreaRegimeMap(todayET).catch(() => ({})));
                const svFireTags = await computeFireTags(todayET, 'RTH', bar.tod);
                const ins = await query(`
                  INSERT INTO active_setups (
                    trade_date, setup_type, fired_at, expires_at, status, origin_status,
                    entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label,
                    extend_target_level, price_at_detection, confluence_score_at_detection,
                    confluence_levels_at_detection, suppression_reason, ${REGIME_STAMP_COLS.join(', ')}, ${FIRE_TAG_COLS.join(', ')}, bet_class
                  ) VALUES ($1,$2,NOW(),$3,$4,$4,$5,$5,$6,$7,$8,$9,$5,$10,$11,$12,
                    ${REGIME_STAMP_COLS.map((_, i) => `$${13 + i}`).join(', ')},
                    ${FIRE_TAG_COLS.map((_, i) => `$${13 + REGIME_STAMP_COLS.length + i}`).join(', ')},
                    $${13 + REGIME_STAMP_COLS.length + FIRE_TAG_COLS.length})
                  ON CONFLICT DO NOTHING
                  RETURNING id, trade_date, fired_at::text as fired_at, entry_zone_low, stop_level, t1_level, t1_label
                `, [todayET, svSetupType, svExpiresAt, live.status, svEntry, svStop, svT1,
                    `${stackVolSignal.calibratedTarget}pt (bank <=9 bars / extend 10-25 bars to 150pt)`,
                    svExtendTarget, levelDensity, stackVolSignal.levels, live.reason,
                    ...regimeStampValues(svRegimeStamp),
                    ...fireTagValues(svFireTags),
                    getBetClass(svSetupType)]);
                if (ins.rows[0]) {
                  try { await dropToTimeline(ins.rows[0]); } catch (_) {}
                  if (live.status === 'ACTIVE' && io) {
                    io.emit('setup-fired', { setupId: ins.rows[0].id, setupType: svSetupType, entry: svEntry, stop: svStop, target: svT1, direction });
                  }
                }
              }).catch(() => {});
            }
            break;
          }
        }
      }
    } catch (_) { /* informational only, never block the response */ }
    return stackVolSignal;
  }

  const runSetupDetection = async (req, res) => {
    try {
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const nowET   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const etMin   = nowET.getHours() * 60 + nowET.getMinutes();
      const etHour  = nowET.getHours();

      // No-new-entries dead zone: 4:00–6:00 PM ET (user directive, 2026-07-31 — "seems to be
      // noise and bad trades"). Deliberately the FULL 4-6pm window even though 5-6pm is
      // already fully dark via the hard-close gate below — this flag is the actual source of
      // truth for the user's stated rule, so it stays correct on its own if that separate
      // gate's boundary ever changes. Does NOT force-close any already-open position (that
      // remains the 5-6pm hard-close gate's job) — resolveSetupsByPrice/expireStaleSetups
      // above already run unconditionally every poll, so an open trade still manages/resolves
      // normally through this window; this only blocks NEW candidates from firing ACTIVE.
      const inNewEntryDeadZone = etMin >= 16 * 60 && etMin < 18 * 60;

      // Resolve/expire existing setups on every poll regardless of window
      await resolveSetupsByPrice(io).catch(() => {});
      await expireStaleSetups(io).catch(() => {});
      await structurallyInvalidateSetups(io).catch(() => {});

      // 5–6 PM ET: hard close / reset gap — expire RTH setups, dark until Globex opens
      if (etMin >= 17 * 60 && etMin < 18 * 60) {
        const closedRows = await query(`
          UPDATE active_setups SET status='EXPIRED', resolution='SESSION_CLOSED',
            resolved_at=NOW(), updated_at=NOW()
          WHERE trade_date=$1 AND status='ACTIVE'
          RETURNING *
        `, [todayET]).catch(() => ({ rows: [] }));
        // Found 2026-07-27 (setup_log_sidebar_recording_audit): this UPDATE never dropped
        // a timeline event — the only resolution path in this file that didn't. Confirmed
        // live: every real (origin_status='ACTIVE') SESSION_CLOSED row in the last 3 months
        // (6, all IB_BULLISH/IB_BEARISH — the long-lived DAY_TYPE_MANAGED types most likely
        // to still be open at 5PM) had no trade_timeline_events row at all, so the sidebar
        // never showed how they actually ended.
        for (const row of closedRows.rows ?? []) {
          try { await dropToTimeline(row); } catch (_) {}
        }
        return res.json({ setup: null, sessionClosed: true });
      }

      // Globex window: 6 PM–8:30 AM ET — fire level fades against PD VAH/VAL/POC only
      const inGlobex = etHour >= 18 || etMin < 8 * 60 + 30;
      if (inGlobex) {
        const sessionDate = etHour >= 18 ? nextTradingDay(nowET) : todayET;
        const globexSetup = await detectGlobexSetup(sessionDate, io);
        const stackVolSignal = await computeStackVolSignal(todayET);
        return res.json({ setup: globexSetup, sessionClosed: false, globexMode: true, stackVolSignal });
      }

      // Was a hardcoded `false` (never wired to anything — confirmed zero frontend consumers
      // of this field) until 2026-07-31, when it became the real flag for the 4-6pm
      // no-new-entries dead zone above. Distinct from dll.js's own noNewEntries concept
      // (daily-loss-limit-driven) — this one is purely time-of-day.
      const noNewEntries = inNewEntryDeadZone;

      // RTH detection — same as before (8:30 AM–5 PM ET)
      const isRTH = true; // already gated above

      // ── Fetch all data sources in parallel ────────────────────────────────────
      const [acdRow, arRow, ltRow, ibBarsRow, latestBarRow, volumeCtxRow, timelineRow, sessionHiLoRow, first15Row, allRthBarsRow] = await Promise.all([
        // Today's OR levels + ACD/C state
        query(`SELECT or_high::float, or_low::float, a_up_fired, a_up_level::float, c_up_confirmed, a_down_fired, a_down_level::float, c_down_confirmed FROM acd_daily_log WHERE trade_date=$1`, [todayET]),
        // Auction reads for today
        query(`SELECT opening_call_type, open_vs_prior_value FROM auction_reads WHERE trade_date=$1`, [todayET]),
        // Prior 5 bracket states using actual session High/Low (9:30–16:00)
        query(`
          WITH dates AS (
            SELECT DISTINCT ts::date as dt FROM price_bars_primary
            WHERE symbol='NQ' AND ts::date < $1
            ORDER BY dt DESC LIMIT 5
          )
          SELECT ts::date::text as trade_date, 
                 MAX(high)::float as or_high, 
                 MIN(low)::float as or_low
          FROM price_bars_primary
          WHERE symbol='NQ' AND ts::date IN (SELECT dt FROM dates)
            AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 960
          GROUP BY ts::date
          ORDER BY trade_date DESC
        `, [todayET]),
        // IB bars (9:30–10:30, the real 60-min Initial Balance, matching ibHighToday/
        // ibLowToday's own BETWEEN 570 AND 629 elsewhere in this file) with bid/ask
        // volume, fed to computeIbBullBear() for the IB_BULLISH/IB_BEARISH read.
        // FIXED 2026-08-12: this previously queried BETWEEN 570 AND 599 (only the
        // first 30 min) with a comment mislabeling it "30-min OR period" — conflating
        // IB with the separate, genuinely-30-min Opening Range concept (acd_daily_log.
        // or_high/or_low). A direct test (scratch/backtest_ib_window_30v60.mjs,
        // RESEARCH_CLAIM ib_bullbear_30min_vs_60min_window_test) found the 30-min vs
        // 60-min window disagrees on bullish/bearish/neither 51% of the time (12% is an
        // outright opposite call), and the correct 60-min window produces more signals
        // at a better raw EV. See docs/OPEN_THREADS.md for the recalibration follow-up
        // this fix requires (existing SETUP_STATUS/OPTIMAL_STOP rows for IB_BULLISH/
        // IB_BEARISH were calibrated under the old, buggy 30-min classification).
        query(`
          SELECT high::float, low::float, close::float, open::float,
                 COALESCE(ask_volume,0)::int as ask_vol, COALESCE(bid_volume,0)::int as bid_vol, volume::int
          FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
            AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 629
          ORDER BY ts
        `, [todayET]),
        // Current price + volume + bar timestamp
        query(`SELECT ts, close::float, volume::int FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= CURRENT_DATE - 5 ORDER BY ts DESC LIMIT 1`),
        // 20-bar average volume (last 20 RTH bars)
        query(`
          SELECT AVG(volume)::float as avg_vol
          FROM (SELECT volume FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
                AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) >= 575 ORDER BY ts DESC LIMIT 20) v
        `, [todayET]),
        // Live timeline events
        query(`SELECT setup_type, fired_time FROM acd_setup_events WHERE trade_date=$1 ORDER BY fired_time`, [todayET]),
        // Session high/low so far today (for TRT stop calculation)
        query(`SELECT MAX(high)::float as h, MIN(low)::float as l FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959`, [todayET]),
        // First 15 min of bars (9:30-9:45) for live opening-type classification
        query(`
          SELECT high::float, low::float, close::float, open::float
          FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
            AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 585
          ORDER BY ts
        `, [todayET]),
        query(`
          SELECT (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min,
                 high::float, low::float, close::float, open::float, COALESCE(volume,0)::int as volume,
                 COALESCE(ask_volume,0)::int as ask_vol, COALESCE(bid_volume,0)::int as bid_vol
          FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
            AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
          ORDER BY ts
        `, [todayET]),
      ]);

      // Prior day value area — cached (changes only between days)
      let pdVAH = null, pdVAL = null, pdPOC = null;
      const cachedPdVA = getCached(todayET, 'pdVA');
      if (cachedPdVA) {
        ({ pdVAH, pdVAL, pdPOC } = cachedPdVA);
      } else {
        const priorDayQ = await query(`SELECT MAX(ts::date)::text as d FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [todayET]);
        const priorDay = priorDayQ.rows[0]?.d;
        if (priorDay) {
          const vaQ = await query(`
            SELECT poc::float as poc, vah::float as vah, val::float as val
            FROM developing_value_log
            WHERE trade_date = $1
          `, [priorDay]);
          if (vaQ.rows[0]) {
            pdVAH = vaQ.rows[0].vah;
            pdVAL = vaQ.rows[0].val;
            pdPOC = vaQ.rows[0].poc;
          } else {
            // fallback
            const fallbackProfile = await computeVolumeProfileForRange(query, { startDate: priorDay, endDate: priorDay });
            if (fallbackProfile) {
              pdVAH = fallbackProfile.vah;
              pdVAL = fallbackProfile.val;
              pdPOC = fallbackProfile.poc;
            }
          }
        }
        setCached(todayET, 'pdVA', { pdVAH, pdVAL, pdPOC });
      }

      // Floor pivots from prior day VA — cached
      let floorP = null, floorR1 = null, floorS1 = null;
      const cachedFloor = getCached(todayET, 'floorPivots');
      if (cachedFloor) {
        ({ floorP, floorR1, floorS1 } = cachedFloor);
      } else if (pdVAH && pdVAL && pdPOC) {
        const pdDvRes = await query(`SELECT session_high::float as hi, session_low::float as lo, session_close::float as cl FROM developing_value_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 1`, [todayET]);
        const pdDv = pdDvRes.rows[0];
        if (pdDv) {
          floorP = (pdDv.hi + pdDv.lo + pdDv.cl) / 3;
          floorR1 = 2 * floorP - pdDv.lo;
          floorS1 = 2 * floorP - pdDv.hi;
        }
        setCached(todayET, 'floorPivots', { floorP, floorR1, floorS1 });
      }

      // PD-2 VA levels (2-day-prior value area) — strong confluence filter
      let pd2VAH = null, pd2VAL = null;
      const cachedPD2 = getCached(todayET, 'pd2VA');
      if (cachedPD2) {
        ({ pd2VAH, pd2VAL } = cachedPD2);
      } else {
        const pd2Q = await query(`
          SELECT vah::float, val::float FROM developing_value_log
          WHERE trade_date < (SELECT MAX(trade_date) FROM developing_value_log WHERE trade_date < $1)
          ORDER BY trade_date DESC LIMIT 1
        `, [todayET]);
        if (pd2Q.rows[0]) { pd2VAH = pd2Q.rows[0].vah; pd2VAL = pd2Q.rows[0].val; }
        setCached(todayET, 'pd2VA', { pd2VAH, pd2VAL });
      }

      // Prior-month VA + month open — cached (changes only between months)
      let pmVAH = null, pmVAL = null, pmPOC = null, monthOpen = null;
      const cachedPmVA = getCached(todayET, 'pmVA');
      if (cachedPmVA) {
        ({ pmVAH, pmVAL, pmPOC, monthOpen } = cachedPmVA);
      } else {
        try {
          const pmMonthBoundsQ = await query(`SELECT (date_trunc('month', CURRENT_DATE) - INTERVAL '1 month')::date::text as s, (date_trunc('month', CURRENT_DATE) - INTERVAL '1 day')::date::text as e`);
          const pmProfile = await computeVolumeProfileForRange(query, { startDate: pmMonthBoundsQ.rows[0].s, endDate: pmMonthBoundsQ.rows[0].e });
          if (pmProfile) { pmVAH = pmProfile.vah; pmVAL = pmProfile.val; pmPOC = pmProfile.poc; }
          const moQ = await query(`
            SELECT open::float as mo FROM price_bars_primary
            WHERE symbol='NQ' AND ts::date = (
              SELECT MIN(ts::date) FROM price_bars_primary
              WHERE symbol='NQ' AND date_trunc('month', ts) = date_trunc('month', CURRENT_DATE)
                AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 960
            ) ORDER BY ts LIMIT 1
          `);
          monthOpen = moQ.rows[0]?.mo || null;
        } catch (_) {}
        setCached(todayET, 'pmVA', { pmVAH, pmVAL, pmPOC, monthOpen });
      }

      // NL30 state — cached
      let nl30, nl30State, isMahBull, isMahBear;
      const cachedNL = getCached(todayET, 'nl30');
      if (cachedNL) {
        ({ nl30, nl30State, isMahBull, isMahBear } = cachedNL);
      } else {
        const nlQ = await query(`SELECT SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as nl30 FROM acd_daily_log WHERE daily_score IS NOT NULL ORDER BY trade_date DESC LIMIT 1`);
        nl30 = parseInt(nlQ.rows[0]?.nl30) || 0;
        nl30State = nl30 > 9 ? 'BULLISH' : nl30 < -9 ? 'BEARISH' : 'RANGING';
        const mahQ = await query(`
          WITH nl AS (
            SELECT trade_date,
                   SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as nl30_val,
                   ROW_NUMBER() OVER (ORDER BY trade_date DESC) as rn
            FROM acd_daily_log WHERE daily_score IS NOT NULL AND trade_date <= $1
          )
          SELECT
            SUM(CASE WHEN nl30_val > 9  THEN 1 ELSE 0 END) as bull_sessions,
            SUM(CASE WHEN nl30_val < -9 THEN 1 ELSE 0 END) as bear_sessions
          FROM nl WHERE rn <= 10
        `, [todayET]);
        isMahBull = nl30 > 15 && parseInt(mahQ.rows[0]?.bull_sessions || 0) >= 10;
        isMahBear = nl30 < -15 && parseInt(mahQ.rows[0]?.bear_sessions || 0) >= 10;
        setCached(todayET, 'nl30', { nl30, nl30State, isMahBull, isMahBear });
      }

      // Extract data
      const orH = acdRow.rows[0]?.or_high, orL = acdRow.rows[0]?.or_low;
      const orRange = orH && orL ? orH - orL : null;
      const openingCall = arRow.rows[0]?.opening_call_type;
      const currentPrice = latestBarRow.rows[0]?.close || 0;
      const nearPD2VA = currentPrice && (
        (pd2VAH && Math.abs(currentPrice - pd2VAH) <= 25) ||
        (pd2VAL && Math.abs(currentPrice - pd2VAL) <= 25)
      );
      const avgVol = parseFloat(volumeCtxRow.rows[0]?.avg_vol) || 0;
      const ibBars = ibBarsRow.rows;
      const ibHigh = ibBars.length >= 3 ? Math.max(...ibBars.map(b => b.high)) : null;
      const ibLow = ibBars.length >= 3 ? Math.min(...ibBars.map(b => b.low)) : null;
      const timelineEvents = timelineRow.rows.map(r => r.setup_type);

      // Live opening-type classification (first 15 min of bars, 9:30-9:45) — replaces
      // the empty auction_reads.opening_call_type for OPEN_DRIVE/VALUE_AREA_RESPONSIVE
      // gating below. Mirrors /acd/live's classifier (~line 1895) without persisting.
      const first15 = first15Row.rows;
      let liveOpeningCallType = null;
      if (first15.length >= 5 && orH && orL) {
        const h15 = Math.max(...first15.map(b => b.high));
        const l15 = Math.min(...first15.map(b => b.low));
        const lastPx = first15[first15.length - 1].close;
        const orRng = orH - orL;
        const ext = orRng * 0.3;
        const ext50 = orRng * 0.5;
        const aboveOR = h15 - orH;
        const belowOR = orL - l15;

        if (aboveOR > ext && belowOR > ext) {
          liveOpeningCallType = 'OPEN_TEST_DRIVE';
        } else if (aboveOR > ext50 && belowOR < ext * 0.3) {
          liveOpeningCallType = 'OPEN_DRIVE';
        } else if (belowOR > ext50 && aboveOR < ext * 0.3) {
          liveOpeningCallType = 'OPEN_DRIVE';
        } else if ((aboveOR > ext || belowOR > ext) && Math.abs(lastPx - (orH + orL) / 2) < orRng * 0.4) {
          liveOpeningCallType = 'OPEN_REJECTION_REVERSE';
        } else {
          liveOpeningCallType = 'OPEN_AUCTION';
        }
      }

      // Live open-vs-prior-value classification — replaces empty auction_reads.open_vs_prior_value
      const orMid = (orH != null && orL != null) ? (orH + orL) / 2 : null;
      const liveOpenVsPrior = (orMid != null && pdVAH != null && pdVAL != null)
        ? (orMid > pdVAH ? 'ABOVE_VALUE' : orMid < pdVAL ? 'BELOW_VALUE' : 'INSIDE_VALUE')
        : null;

      // ACD/C state for TRT and C detection
      const aUpFired   = !!acdRow.rows[0]?.a_up_fired;
      const aUpLevel   = acdRow.rows[0]?.a_up_level;
      const cUpConf    = !!acdRow.rows[0]?.c_up_confirmed;
      const aDownFired = !!acdRow.rows[0]?.a_down_fired;
      const aDownLevel = acdRow.rows[0]?.a_down_level;
      const cDownConf  = !!acdRow.rows[0]?.c_down_confirmed;
      const sessionHigh = sessionHiLoRow.rows[0]?.h;
      const sessionLow  = sessionHiLoRow.rows[0]?.l;

      // C already fired today? (prevents duplicate C_STANDALONE per day)
      const cFiredRow = await query(
        `SELECT 1 FROM active_setups WHERE trade_date=$1 AND setup_type LIKE 'C_%' LIMIT 1`,
        [todayET]
      ).catch(() => ({ rows: [] }));
      const hasCFiredToday = cFiredRow.rows.length > 0 || timelineEvents.some(e => e.startsWith('C '));

      // Helper: look up condition_memory win rate for current conditions
      const getHistory = async (structState) => {
        const nlBucket = nl30 > 9 ? 'BULLISH' : nl30 < -9 ? 'BEARISH' : 'RANGING';
        const oc = openingCall || 'NO_SIGNAL';
        const r = await query(`
          SELECT occurrences, win_rate, avg_pnl, t1_hit_rate
          FROM condition_memory WHERE structural_state=$1 AND nl30_bucket=$2
            AND opening_call=$3 AND sufficient_data=true
          LIMIT 1
        `, [structState, nlBucket, oc]).catch(() => ({ rows: [] }));
        return r.rows[0] ? {
          occurrences: r.rows[0].occurrences,
          winRate: r.rows[0].win_rate != null ? parseFloat(r.rows[0].win_rate) : null,
          avgPnl: r.rows[0].avg_pnl != null ? parseFloat(r.rows[0].avg_pnl) : null,
          t1HitRate: r.rows[0].t1_hit_rate != null ? parseFloat(r.rows[0].t1_hit_rate) : null,
        } : null;
      };

      // Returns the nearest valid T1 candidate in the correct direction vs entry.
      // Candidates are checked in priority order; first valid one wins.
      // Returns null if no candidate is on the right side — prevents wrong-direction targets.
      const t1Guard = (direction, entry, ...candidates) => {
        const isLong = direction === 'LONG';
        for (const c of candidates) {
          if (c != null && isFinite(c) && (isLong ? c > entry : c < entry)) return Math.round(c);
        }
        return null;
      };

      // Same direction-guard as t1Guard, but candidates are { value, label } pairs
      // and the matching label travels with the chosen value — so the displayed
      // target and its label can never disagree about which structural level was used.
      // Used by the TRT family, where every candidate must be a REAL structural level
      // (no arbitrary price+multiple fallbacks) — falls through to NO_VIABLE_TARGET
      // rather than inventing an unanchored number.
      const t1GuardLabeled = (direction, entry, ...candidates) => {
        const isLong = direction === 'LONG';
        for (const cand of candidates) {
          const c = cand?.value;
          if (c != null && isFinite(c) && (isLong ? c > entry : c < entry)) {
            return { value: Math.round(c), label: cand.label };
          }
        }
        return { value: null, label: 'NO_VIABLE_TARGET' };
      };

      // ── SETUP 0a: TRT V2 (LONG) ──────────────────────────────────────────────
      // Early trigger: A Down fired, NO C confirmation in either direction, price crosses
      // back above OR Low. A Down sellers are trapped before any C fires — earlier entry
      // than classic TRT which requires C Down + C Up failure through OR High.
      let trtLongV2 = null;
      if (aDownFired && !cDownConf && !cUpConf && currentPrice && orL &&
          currentPrice > orL &&
          !timelineEvents.some(e => e === 'TRT_LONG_V2' || e === 'TRT_LONG')) {
        const trtLongV2Stop = +(aDownLevel - 12).toFixed(0);
        const trtLongV2T1 = t1GuardLabeled('LONG', currentPrice,
          { value: pdVAH, label: 'Prior Day VAH' },
          { value: (orH != null && orRange != null) ? orH + orRange : null, label: 'OR Measured Move' },
        );
        trtLongV2 = {
          type: 'TRT_LONG_V2', label: 'TRT V2 — EARLY REVERSAL (LONG)',
          direction: 'LONG',
          entry: +currentPrice.toFixed(0),
          stop: trtLongV2Stop,
          target: trtLongV2T1.value,
          targetLabel: trtLongV2T1.label,
          keyLevel: +orL.toFixed(0), keyLevelLabel: 'OR Low (A Down trapped)',
          description: `A Down fired at ${aDownLevel?.toFixed(0)} but C Down never confirmed. Price reclaimed OR Low (${orL?.toFixed(0)}) — A Down sellers are trapped early. No C opposite required (earlier entry than classic TRT). Stop below A Down level (${trtLongV2Stop}).`,
          history: await getHistory('TRANSITIONAL'),
        };
      }

      // ── SETUP 0b: TRT V2 (SHORT) ─────────────────────────────────────────────
      // Early trigger: A Up fired, NO C confirmation in either direction, price drops
      // back below OR High. A Up buyers are trapped before any C fires.
      let trtShortV2 = null;
      if (aUpFired && !cUpConf && !cDownConf && currentPrice && orH &&
          currentPrice < orH &&
          !timelineEvents.some(e => e === 'TRT_SHORT_V2' || e === 'TRT_SHORT')) {
        const trtShortV2Stop = +(aUpLevel + 12).toFixed(0);
        const trtShortV2T1 = t1GuardLabeled('SHORT', currentPrice,
          { value: pdVAL, label: 'Prior Day VAL' },
          { value: (orL != null && orRange != null) ? orL - orRange : null, label: 'OR Measured Move' },
        );
        trtShortV2 = {
          type: 'TRT_SHORT_V2', label: 'TRT V2 — EARLY REVERSAL (SHORT)',
          direction: 'SHORT',
          entry: +currentPrice.toFixed(0),
          stop: trtShortV2Stop,
          target: trtShortV2T1.value,
          targetLabel: trtShortV2T1.label,
          keyLevel: +orH.toFixed(0), keyLevelLabel: 'OR High (A Up trapped)',
          description: `A Up fired at ${aUpLevel?.toFixed(0)} but C Up never confirmed. Price fell back below OR High (${orH?.toFixed(0)}) — A Up buyers are trapped early. No C opposite required (earlier entry than classic TRT). Stop above A Up level (${trtShortV2Stop}).`,
          history: await getHistory('TRANSITIONAL'),
        };
      }

      // ── SETUP 0c: OPEN TEST DRIVE (OTD) ──────────────────────────────────────
      // Within first 15 bars (9:30–9:44): price probes one direction 10+ pts, then reverses
      // through OR in opposite direction with larger magnitude. Stop = probe extreme.
      let otdSetup = null;
      {
        const otdBars = ibBars.slice(0, 15);
        if (otdBars.length >= 3 && orH && orL && currentPrice &&
            !timelineEvents.some(e => e === 'OPEN_TEST_DRIVE_SHORT' || e === 'OPEN_TEST_DRIVE_LONG')) {
          const openPx    = otdBars[0].open;
          const upProbe   = Math.max(...otdBars.map(b => b.high)) - openPx;
          const downProbe = openPx - Math.min(...otdBars.map(b => b.low));
          const probeHigh = Math.max(...otdBars.map(b => b.high));
          const probeLow  = Math.min(...otdBars.map(b => b.low));

          const otdShortSignaled = upProbe >= 10 && otdBars.some(b => b.close < orL);
          const otdLongSignaled  = downProbe >= 10 && otdBars.some(b => b.close > orH);

          // FIXED 2026-07-17: SHORT's description hand-typed "-5.6% directional edge... 73% WR
          // (+23%, N=11)... 69% WR" — already known-dead per the comment below (KILL, real EV
          // -$74 to -$100) so this was actively misleading on an already-suppressed setup. Also
          // fixed the same "unbounded structural-level target" bug found across this session
          // (docs/OPEN_THREADS.md) — target/stop now read the real OPTIMAL_STOP calibration.
          const _otdOpt = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._opt;
          if (otdShortSignaled && currentPrice < orL) {
            const _otdStopPts = _otdOpt?.OPEN_TEST_DRIVE_SHORT?.stop ?? 89;
            const _otdTargetPts = _otdOpt?.OPEN_TEST_DRIVE_SHORT?.target ?? 33;
            otdSetup = {
              type: 'OPEN_TEST_DRIVE_SHORT', label: 'OPEN TEST DRIVE (SHORT)',
              direction: 'SHORT',
              entry: +currentPrice.toFixed(0),
              stop: +(currentPrice + _otdStopPts).toFixed(0),
              target: +(currentPrice - _otdTargetPts).toFixed(0),
              targetLabel: `T1: ${_otdTargetPts}pt sweep-optimal · Stop: ${_otdStopPts}pt`,
              keyLevel: +orL.toFixed(0), keyLevelLabel: 'OR Low (reversal confirmed)',
              description: `Open Test Drive short. Price probed up ${upProbe.toFixed(0)}pts to ${probeHigh.toFixed(0)} then reversed through OR Low (${orL?.toFixed(0)}).\n\nEDGE: ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('OPEN_TEST_DRIVE_SHORT') ?? 'not yet calibrated'} overall — this setup is currently suppressed (confirmed negative EV).`,
              history: await getHistory('TRANSITIONAL'),
            };
          } else if (otdLongSignaled && currentPrice > orH) {
            const _otdStopPts = _otdOpt?.OPEN_TEST_DRIVE_LONG?.stop ?? 112;
            const _otdTargetPts = _otdOpt?.OPEN_TEST_DRIVE_LONG?.target ?? 21;
            otdSetup = {
              type: 'OPEN_TEST_DRIVE_LONG', label: 'OPEN TEST DRIVE (LONG)',
              direction: 'LONG',
              entry: +currentPrice.toFixed(0),
              stop: +(currentPrice - _otdStopPts).toFixed(0),
              target: +(currentPrice + _otdTargetPts).toFixed(0),
              targetLabel: `T1: ${_otdTargetPts}pt sweep-optimal · Stop: ${_otdStopPts}pt`,
              keyLevel: +orH.toFixed(0), keyLevelLabel: 'OR High (reversal confirmed)',
              description: `Open Test Drive long. Price probed down ${downProbe.toFixed(0)}pts to ${probeLow.toFixed(0)} in the opening, then reversed through OR High (${orH?.toFixed(0)}) — initiative buyers dominated.\n\nEDGE: ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('OPEN_TEST_DRIVE_LONG') ?? 'not yet calibrated'} overall — this setup is currently suppressed (confirmed negative EV).`,
              history: await getHistory('TRANSITIONAL'),
            };
          }
        }
      }
      // OPEN_TEST_DRIVE suppressed 2026-07-05: LONG=31.8% WR N=44 EV=-$100 (KILL), SHORT=26.7% WR N=45 EV=-$74 (KILL).
      // Code gates (nearPD2VA) described in description but not enforced — base rate is catastrophic.
      // The "shadow tracking continues" comment above was FALSE (2026-08-10 audit, roadmap I2) --
      // this unconditionally nulled a fully-built candidate with zero trace anywhere. Now logged
      // to gated_candidates (informational only, doesn't restore shadow firing) so a future PD-2
      // VA gate revisit has real gated-population data to check, not just this comment's claim.
      if (otdSetup) {
        logGatedCandidate({ tradeDate: todayET, setupType: otdSetup.type, gateName: 'OTD_HARDCODED_KILL', gateReason: 'OPEN_TEST_DRIVE unconditionally suppressed 2026-07-05 (confirmed negative EV both directions)', entry: otdSetup.entry, stop: otdSetup.stop, target: otdSetup.target });
      }
      otdSetup = null;

      // ── SETUP 0d: A UP STRONG (LONG) ─────────────────────────────────────────
      let aUpStrong = null;
      if (aUpFired && nl30 >= -9 &&
          !timelineEvents.some(e => e === 'A_UP_STRONG' || e === 'A_UP_WEAK' || e === 'TRT_LONG' || e === 'TRT_LONG_V2')) {
        const aUpStrongT1 = t1GuardLabeled('LONG', currentPrice,
          { value: pdVAH, label: 'Prior Day VAH' },
          { value: (orH != null && orRange != null) ? orH + orRange : null, label: 'OR Measured Move' }
        );
        aUpStrong = {
          type: 'A_UP_STRONG', label: 'A UP STRONG (LONG)',
          direction: 'LONG',
          entry: +currentPrice.toFixed(0),
          stop: orL ? +orL.toFixed(0) : null,
          target: aUpStrongT1.value,
          targetLabel: aUpStrongT1.label,
          keyLevel: orH ? +orH.toFixed(0) : null, keyLevelLabel: 'OR High',
          description: `A Up fired at ${aUpLevel?.toFixed(0)} under a supportive trend (NL30 is at +${nl30}). Bullish momentum holds above OR High. Stop below OR Low (${orL?.toFixed(0)}).`,
          history: await getHistory('TRENDING_UP'),
        };
      }

      // ── SETUP 0e: A DOWN STRONG (SHORT) ──────────────────────────────────────
      let aDownStrong = null;
      if (aDownFired && nl30 <= 9 &&
          !timelineEvents.some(e => e === 'A_DOWN_STRONG' || e === 'A_DOWN_WEAK' || e === 'TRT_SHORT' || e === 'TRT_SHORT_V2')) {
        const aDownStrongT1 = t1GuardLabeled('SHORT', currentPrice,
          { value: pdVAL, label: 'Prior Day VAL' },
          { value: (orL != null && orRange != null) ? orL - orRange : null, label: 'OR Measured Move' }
        );
        aDownStrong = {
          type: 'A_DOWN_STRONG', label: 'A DOWN STRONG (SHORT)',
          direction: 'SHORT',
          entry: +currentPrice.toFixed(0),
          stop: orH ? +orH.toFixed(0) : null,
          target: aDownStrongT1.value,
          targetLabel: aDownStrongT1.label,
          keyLevel: orL ? +orL.toFixed(0) : null, keyLevelLabel: 'OR Low',
          description: `A Down fired at ${aDownLevel?.toFixed(0)} under a supportive trend (NL30 is at ${nl30}). Bearish momentum holds below OR Low. Stop above OR High (${orH?.toFixed(0)}).`,
          history: await getHistory('TRENDING_DOWN'),
        };
      }

      // ── SETUP 0f: A UP WEAK (LONG) ───────────────────────────────────────────
      let aUpWeak = null;
      if (aUpFired && nl30 < -9 &&
          !timelineEvents.some(e => e === 'A_UP_STRONG' || e === 'A_UP_WEAK' || e === 'TRT_LONG' || e === 'TRT_LONG_V2')) {
        const aUpWeakT1 = t1GuardLabeled('LONG', currentPrice,
          { value: pdVAH, label: 'Prior Day VAH' },
          { value: (orH != null && orRange != null) ? orH + orRange * 0.5 : null, label: 'OR Half Measured Move' }
        );
        aUpWeak = {
          type: 'A_UP_WEAK', label: 'A UP WEAK (LONG)',
          direction: 'LONG',
          entry: +currentPrice.toFixed(0),
          stop: orL ? +orL.toFixed(0) : null,
          target: aUpWeakT1.value,
          targetLabel: aUpWeakT1.label,
          keyLevel: orH ? +orH.toFixed(0) : null, keyLevelLabel: 'OR High',
          description: `A Up fired at ${aUpLevel?.toFixed(0)} but against a bearish trend (NL30 is at ${nl30}). High failure/reversal risk. Stop below OR Low (${orL?.toFixed(0)}).`,
          history: await getHistory('TRANSITIONAL'),
        };
      }

      // ── SETUP 0g: A DOWN WEAK (SHORT) ────────────────────────────────────────
      let aDownWeak = null;
      if (aDownFired && nl30 > 9 &&
          !timelineEvents.some(e => e === 'A_DOWN_STRONG' || e === 'A_DOWN_WEAK' || e === 'TRT_SHORT' || e === 'TRT_SHORT_V2')) {
        const aDownWeakT1 = t1GuardLabeled('SHORT', currentPrice,
          { value: pdVAL, label: 'Prior Day VAL' },
          { value: (orL != null && orRange != null) ? orL - orRange * 0.5 : null, label: 'OR Half Measured Move' }
        );
        aDownWeak = {
          type: 'A_DOWN_WEAK', label: 'A DOWN WEAK (SHORT)',
          direction: 'SHORT',
          entry: +currentPrice.toFixed(0),
          stop: orH ? +orH.toFixed(0) : null,
          target: aDownWeakT1.value,
          targetLabel: aDownWeakT1.label,
          keyLevel: orL ? +orL.toFixed(0) : null, keyLevelLabel: 'OR Low',
          description: `A Down fired at ${aDownLevel?.toFixed(0)} but against a bullish trend (NL30 is at +${nl30}). High failure/reversal risk. Stop above OR High (${orH?.toFixed(0)}).`,
          history: await getHistory('TRANSITIONAL'),
        };
      }

      // ── SETUP 1: TRT + MAH ────────────────────────────────────────────────────
      // "Mad As Hell" — extended trend exhaustion: TRT conditions + NL30 extreme for 10+ sessions
      let trtMah = null;
      if (isMahBull || isMahBear) {
        if (isMahBull && aUpFired && cUpConf && currentPrice && orL && aUpLevel &&
            currentPrice < orL && currentPrice < aUpLevel) {
          const trtMahShortStop = +(aUpLevel + 12).toFixed(0);
          const trtMahShortT1 = t1GuardLabeled('SHORT', currentPrice,
            { value: pdVAL, label: 'Prior Day VAL' },
            { value: (orL != null && orRange != null) ? orL - orRange : null, label: 'OR Measured Move' },
          );
          trtMah = {
            type: 'TRT_MAH_SHORT', label: 'TRT + MAH (SHORT)',
            direction: 'SHORT',
            entry: +currentPrice.toFixed(0),
            stop: trtMahShortStop,
            target: trtMahShortT1.value,
            targetLabel: trtMahShortT1.label,
            keyLevel: +orL.toFixed(0), keyLevelLabel: 'OR Low (failed support)',
            description: `A Up + C Up both failed. NL30 at +${nl30} with 10+ consecutive extreme sessions. MAH: trapped buyers fuel a larger-than-normal reversal. Price below OR Low (${orL?.toFixed(0)}) and A Up level (${aUpLevel?.toFixed(0)}).`,
            history: await getHistory('TRENDING_UP'),
          };
        } else if (isMahBear && aDownFired && cDownConf && currentPrice && orH && aDownLevel &&
                   currentPrice > orH && currentPrice > aDownLevel) {
          const trtMahLongStop = +(aDownLevel - 12).toFixed(0);
          const trtMahLongT1 = t1GuardLabeled('LONG', currentPrice,
            { value: pdVAH, label: 'Prior Day VAH' },
            { value: (orH != null && orRange != null) ? orH + orRange : null, label: 'OR Measured Move' },
          );
          trtMah = {
            type: 'TRT_MAH_LONG', label: 'TRT + MAH (LONG)',
            direction: 'LONG',
            entry: +currentPrice.toFixed(0),
            stop: trtMahLongStop,
            target: trtMahLongT1.value,
            targetLabel: trtMahLongT1.label,
            keyLevel: +orH.toFixed(0), keyLevelLabel: 'OR High (failed resistance)',
            description: `A Down + C Down both failed. NL30 at ${nl30} with 10+ consecutive extreme sessions. MAH: trapped sellers fuel a larger-than-normal reversal. Price above OR High (${orH?.toFixed(0)}) and A Down level (${aDownLevel?.toFixed(0)}).`,
            history: await getHistory('TRENDING_DOWN'),
          };
        }
      }

      // ── SETUP 2: TRT ──────────────────────────────────────────────────────────
      // Trend Reversal Trade: A + C both failed, price confirms reversal through OR
      let trt = null;
      if (aUpFired && cUpConf && currentPrice && orL && aUpLevel &&
          currentPrice < orL && currentPrice < aUpLevel) {
        const trtShortStop = +(aUpLevel + 12).toFixed(0);
        const trtShortT1 = t1GuardLabeled('SHORT', currentPrice,
          { value: pdVAL, label: 'Prior Day VAL' },
          { value: (orL != null && orRange != null) ? orL - orRange : null, label: 'OR Measured Move' },
        );
        trt = {
          type: 'TRT_SHORT', label: 'TRT — TREND REVERSAL (SHORT)',
          direction: 'SHORT',
          entry: +currentPrice.toFixed(0),
          stop: trtShortStop,
          target: trtShortT1.value,
          targetLabel: trtShortT1.label,
          keyLevel: +orL.toFixed(0), keyLevelLabel: 'OR Low (failed support)',
          description: `A Up + C Up both failed. Price is now below OR Low (${orL?.toFixed(0)}) and A Up level (${aUpLevel?.toFixed(0)}). Trapped longs fuel the reversal — stop above A Up level (${trtShortStop}).`,
          history: await getHistory('TRANSITIONAL'),
        };
      } else if (aDownFired && cDownConf && currentPrice && orH && aDownLevel &&
                 currentPrice > orH && currentPrice > aDownLevel) {
        const trtLongStop = +(aDownLevel - 12).toFixed(0);
        const trtLongT1 = t1GuardLabeled('LONG', currentPrice,
          { value: pdVAH, label: 'Prior Day VAH' },
          { value: (orH != null && orRange != null) ? orH + orRange : null, label: 'OR Measured Move' },
        );
        trt = {
          type: 'TRT_LONG', label: 'TRT — TREND REVERSAL (LONG)',
          direction: 'LONG',
          entry: +currentPrice.toFixed(0),
          stop: trtLongStop,
          target: trtLongT1.value,
          targetLabel: trtLongT1.label,
          keyLevel: +orH.toFixed(0), keyLevelLabel: 'OR High (failed resistance)',
          description: `A Down + C Down both failed. Price is now above OR High (${orH?.toFixed(0)}) and A Down level (${aDownLevel?.toFixed(0)}). Trapped shorts fuel the reversal — it's a slow-burn reversal, not a spike.\n\nEDGE: TRT_LONG ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('TRT_LONG') ?? 'not yet calibrated'} overall. EXECUTION: This trade needs TIME. Don't cut early. Expiry is 120 min. Target PD VAH or OR measured move. Stop below A Down level (${trtLongStop}).${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — higher conviction zone.' : ''}`,
          history: await getHistory('TRANSITIONAL'),
        };
      }

      // Day type — fetched early so IB tier and all downstream gates can use it
      const dtClassRow = await query(`SELECT day_type FROM acd_daily_log WHERE trade_date=$1`, [todayET]).catch(() => ({ rows: [] }));
      const dtClass = dtClassRow.rows[0]?.day_type || null;

      // Session-bias conflict check (2026-07-14) — see docs/OPEN_THREADS.md's IB_BULLISH
      // incident writeup: today's IB_BULLISH fired LONG while every session-bias signal on
      // the dashboard (Permission Slip, session signals) read SHORT, and nothing cross-checked
      // that before firing. Reuses the exact same PERMISSION_SLIP matching antigravityEdges.js
      // uses for the dashboard banner (server/services/permissionSlip.js, shared, not a second
      // copy). Cached via setCached the same way liveStats escapes this block's scoping, so the
      // candidates-array section (~line 5300) can read it without re-querying.
      let sessionBiasMatch = getCached(todayET, 'permissionSlipMatch');
      if (!sessionBiasMatch) {
        const openBar = ibBars[0], closeBar = ibBars[ibBars.length - 1];
        const firstHourDir = (openBar && closeBar)
          ? (closeBar.close > openBar.open ? 'UP' : closeBar.close < openBar.open ? 'DOWN' : 'FLAT')
          : null;
        const permSlipRows = await query(`
          SELECT signal_name, sample_size, win_rate::float, recommendation, notes
          FROM performance_audit
          WHERE signal_type = 'PERMISSION_SLIP'
            AND run_date = (SELECT MAX(run_date) FROM performance_audit WHERE signal_type = 'PERMISSION_SLIP')
        `).catch(() => ({ rows: [] }));
        sessionBiasMatch = matchPermissionSlips(
          { dayType: dtClass, aUpFired, aDownFired, cUpConfirmed: cUpConf, cDownConfirmed: cDownConf, firstHourDir },
          permSlipRows.rows
        );
        setCached(todayET, 'permissionSlipMatch', sessionBiasMatch);
      }
      // MIN_PCT=0.65 matches backtest_permission_slips.mjs's own bar for what counts as a
      // real permission slip — only flag a conflict against a signal that clears that bar,
      // not any thin/weak match.
      const sessionConflictFor = (direction) => {
        const opposing = direction === 'LONG' ? sessionBiasMatch.SHORT : direction === 'SHORT' ? sessionBiasMatch.LONG : null;
        return (opposing && opposing.winRate >= 0.65) ? opposing : null;
      };

      // ── SETUP 3: IB CONFIRMATION ──────────────────────────────────────────────
      // ibBars itself is still the 30-min window (9:30-10:00, spec) — only the fire
      // gate moved to 10:30 (etMin>=630). Found 2026-07-14: gating fire at 10:00
      // meant dtClass (line 3341) was always null at decision time (day_type isn't
      // classified until IB close at 10:30 — see CLAUDE.md's day-type classifier
      // timing fix), so the day-type suppression checks below (dtClass==='BALANCE'
      // etc.) were a guaranteed no-op every single time this fired — confirmed live:
      // IB_BULLISH fired blind at 09:58 ET with dtClass=null, went on to lose
      // (-$159), and its all-time blended EV is -$27.81/trade (N=106) specifically
      // because the BALANCE-day case this check exists to filter out was never
      // actually being filtered. Moving the gate here (not changing the 30-min
      // level definition) lets the existing checks below actually run.
      let ibSetup = null;
      if (etMin >= 630 && ibBars.length >= 3) {
        // Shared with scripts/backtest_trend_gate_suppression.mjs — see caseEngine.js's
        // computeIbBullBear() header for why this was extracted 2026-08-03.
        const { ibMid, ibClose, totalAsk, totalBid, ibBullish, ibBearish } = computeIbBullBear(ibBars);
        if ((ibBullish || ibBearish) && currentPrice) {
          const isBull = ibBullish;
          const priceSide = isBull ? currentPrice > ibMid : currentPrice < ibMid;
          if (priceSide) {
            // Conflicting signal: A Up tested and failed (for bullish IB) or A Down tested and failed (for bearish IB)
            // Both aUpLevel/aDownLevel are from acd_daily_log; ibBars is the 9:30–10:00 window
            // WEAK WR = 33.3% (N=9 decided, 20 fired) — not yet suppressed because N<20 threshold.
            // Revisit when forward-test accumulates 20 decided WEAK trades. (replay_ib_setups.js 2026-07-01)
            const aUpTestedInIB   = aUpLevel   && ibBars.some(b => b.high >= aUpLevel);
            const aDownTestedInIB = aDownLevel  && ibBars.some(b => b.low  <= aDownLevel);
            const conflicting = isBull ? (aUpTestedInIB && !aUpFired) : (aDownTestedInIB && !aDownFired);

            // Session-bias conflict (2026-07-14) — see the sessionConflictFor definition above.
            // Informational flag only, does not suppress; full suppression of a mechanical
            // fade based on this is a bigger, unvalidated behavior change reserved for a future
            // pass (docs/OPEN_THREADS.md tracks it as still-open).
            const sessionConflict = sessionConflictFor(isBull ? 'LONG' : 'SHORT');

            // Stop geometry: data-derived via stop sweep in update_optimal_stops.mjs → performance_audit.
            // Read from liveStats._opt[type].stop (sweep-optimal, not p75_mae).
            // Fallback 50/80pt from 2026-07-05 sweep research if _opt is unavailable.
            // _ibLS: read the level-fade stats cache directly here (liveStats is declared later in the level-fade block)
            const _ibLS = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL);
            const ibTypeName = isBull ? 'IB_BULLISH' : 'IB_BEARISH';
            // Day-type-conditioned calibration (2026-08-03, OPEN_DECISION
            // ib_bearish_optimal_stop_not_day_type_conditioned) — the execution-efficiency
            // audit found IB_BEARISH's real realized EV sat well above its blended
            // OPTIMAL_STOP row, and its own SETUP_STATUS day-type breakdown already shows
            // a real BALANCE/TREND/TURBULENT split. scripts/backtest_ib_daytype_stop_target.mjs
            // sweeps stop/target SEPARATELY per (setup_type, day_type) via the same real,
            // imported sweepOptimalStopAndTarget(), writing rows keyed
            // `{setup_type}_{day_type}` (matching backtest_day_type_alpha.js's convention)
            // whenever that cell clears the usual MIN_N=20 floor. Try the day-type-specific
            // row first; fall back to the blended `{setup_type}` row if the cell doesn't
            // exist or is still thin — dtClass (~line 4284) is already required to fire
            // this whole block, so no extra dependency introduced.
            const ibDayTypeKey = dtClass ? `${ibTypeName}_${dtClass}` : null;
            const ibOpt = (ibDayTypeKey && _ibLS?._opt?.[ibDayTypeKey]) || _ibLS?._opt?.[ibTypeName];
            const ibStopPts = ibOpt?.stop ?? 50; // sweep-optimal 50pt for both BULLISH and BEARISH
            const stop = isBull ? +(currentPrice - ibStopPts).toFixed(0) : +(currentPrice + ibStopPts).toFixed(0);
            // FIXED 2026-07-17 (user noticed an 8:1 R:R / 630pt target on a real STOP_HIT trade and
            // asked whether targets are actually calibrated — they weren't). Stop already correctly
            // read the sweep-optimal ibOpt.stop, but target ignored ibOpt.target entirely and used
            // raw, uncapped PD VAH/VAL structural distance instead — real calibration shows p50-MFE-
            // sweep-optimal targets of 30.5pt (IB_BULLISH) / 45.8pt (IB_BEARISH), nowhere near the
            // hundreds of points PD VAH/VAL can sit at. See docs/OPEN_THREADS.md for the full incident.
            const ibTargetPts = ibOpt?.target ?? 35;
            const target = isBull
              ? +(currentPrice + ibTargetPts).toFixed(0)
              : +(currentPrice - ibTargetPts).toFixed(0);
            ibSetup = {
              type: isBull ? 'IB_BULLISH' : 'IB_BEARISH',
              label: conflicting
                ? (isBull ? 'IB Bullish — A Up failed (reduced)' : 'IB Bearish — A Down failed (reduced)')
                : (isBull ? 'IB BULLISH' : 'IB BEARISH'),
              signalQuality: conflicting ? 'WEAK' : 'NORMAL',
              direction: isBull ? 'LONG' : 'SHORT',
              entry: +currentPrice.toFixed(0),
              stop,
              target,
              targetLabel: `T1: ${ibTargetPts}pt sweep-optimal (half off) · Stop: ${ibStopPts}pt from entry (${stop})`,
              keyLevel: +ibMid.toFixed(0),
              keyLevelLabel: 'IB Midpoint',
              description: conflicting
                ? (isBull
                  ? `IB closed bullish but A Up was tested and rejected before 10:00 — conflicting signals. Half conviction only: smaller size, wider stop tolerance.`
                  : `IB closed bearish but A Down was tested and rejected before 10:00 — conflicting signals. Half conviction only.\n\nEDGE: IB_BEARISH ${_ibLS?._edgeText?.('IB_BEARISH') ?? 'not yet calibrated'} overall. On TURBULENT: strongest. EXECUTION: Lean short on rallies to IB midpoint (${Math.round(ibMid)}). Stop ${ibStopPts}pt above entry (${stop}). Target ${ibTargetPts}pt sweep-optimal.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — higher conviction.' : ''}`)
                : (isBull
                  ? `IB closed ${(ibClose - ibMid).toFixed(0)}pts above midpoint with ask volume dominating (${totalAsk.toLocaleString()} vs ${totalBid.toLocaleString()} bid). Buyers controlled the initial balance.\n\nEDGE: IB_BULLISH ${_ibLS?._edgeText?.('IB_BULLISH') ?? 'not yet calibrated'} overall. TREND days: strongest. BALANCE: suppressed (below breakeven). EXECUTION: Buy pullbacks to IB midpoint (${Math.round(ibMid)}). Stop ${ibStopPts}pt below entry (${stop}). Target ${ibTargetPts}pt sweep-optimal.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — higher conviction.' : ''}`
                  : `IB closed ${(ibMid - ibClose).toFixed(0)}pts below midpoint with bid volume dominating (${totalBid.toLocaleString()} vs ${totalAsk.toLocaleString()} ask). Sellers controlled the initial balance.\n\nEDGE: IB_BEARISH ${_ibLS?._edgeText?.('IB_BEARISH') ?? 'not yet calibrated'} overall. TURBULENT: strongest. BALANCE: suppressed. EXECUTION: Short rallies to IB midpoint (${Math.round(ibMid)}). Stop ${ibStopPts}pt above entry (${stop}). Target ${ibTargetPts}pt sweep-optimal.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — higher conviction.' : ''}`),
              history: await getHistory(nl30State === 'BULLISH' ? 'TRENDING_UP' : nl30State === 'BEARISH' ? 'TRENDING_DOWN' : 'BALANCE'),
              // Verified live 2026-07-14 (docs/OPEN_THREADS.md has the incident writeup) — the
              // previous comment here claiming IB_BULLISH TREND was "+$20 EV solid" was stale/
              // wrong; real numbers are BALANCE N=53 EV=-$47, TREND N=34 EV=-$16, TURBULENT
              // N=19 EV=+$4 (thin). No day-type clears the bar — IB_BULLISH is now fully
              // SUPPRESSed via backtest_setup_status.mjs's DAY_TYPE_CONDITIONAL check, so this
              // tier label is moot for it (ibSetup gets nulled before use either way).
              // IB_BEARISH: BALANCE N=53 EV=-$15, TREND N=18 EV=-$64, TURBULENT N=30 EV=+$78
              // (genuinely strong) — correctly gated to fire only on TURBULENT.
              tier: isBull
                ? (dtClass === 'TREND' ? 'SOLID' : dtClass === 'TURBULENT' ? 'MARGINAL' : 'WEAK')
                : (dtClass === 'TURBULENT' ? 'SOLID' : dtClass === 'TREND' ? 'WEAK' : 'MARGINAL'),
            };
            // Session-bias conflict flag — appended post-construction rather than woven into
            // the description ternary above, to avoid touching that already-complex string
            // logic. Informational only (see sessionConflictFor definition, ~line 3355).
            if (sessionConflict) {
              ibSetup.sessionConflict = sessionConflict;
              ibSetup.description = `⚠ SESSION-BIAS CONFLICT: "${sessionConflict.label}" reads ${sessionConflict.direction} at ${(sessionConflict.winRate * 100).toFixed(0)}% (N=${sessionConflict.n}) — opposite this setup's direction. Not suppressed, but weigh this before sizing.\n\n${ibSetup.description}`;
            }
          }
        }
      }

      // ── SETUP 4: OPEN DRIVE ───────────────────────────────────────────────────
      let openDrive = null;
      if (liveOpeningCallType === 'OPEN_DRIVE' && orH && orL && currentPrice) {
        const nearOrHigh = Math.abs(currentPrice - orH) <= 15 && currentPrice >= orH - 15 && currentPrice <= orH + 5;
        const nearOrLow  = Math.abs(currentPrice - orL) <= 15 && currentPrice <= orL + 15 && currentPrice >= orL - 5;
        const isBull = nearOrHigh && nl30State !== 'BEARISH';
        const isBear = nearOrLow  && nl30State !== 'BULLISH';
        if (isBull || isBear) {
          // FIXED 2026-07-17 (same "unbounded structural-level target" bug found and fixed for
          // IB_BULLISH/BEARISH — see docs/OPEN_THREADS.md). The OR-measured-move projection
          // (orH + orRange) has no realistic-distance cap and can sit far past what real MFE data
          // supports. Now uses the real sweep-optimal OPTIMAL_STOP target instead.
          const _odTargetPts = isBull
            ? (getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._opt?.OPEN_DRIVE_LONG?.target ?? 50)
            : (getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._opt?.OPEN_DRIVE_SHORT?.target ?? 40);
          openDrive = {
            type: isBull ? 'OPEN_DRIVE_LONG' : 'OPEN_DRIVE_SHORT',
            label: isBull ? 'OPEN DRIVE (LONG)' : 'OPEN DRIVE (SHORT)',
            direction: isBull ? 'LONG' : 'SHORT',
            entry: +currentPrice.toFixed(0),
            stop: isBull ? +(orL - (orH - orL)).toFixed(0) : +(orH + 2).toFixed(0),
            target: isBull
              ? +(currentPrice + _odTargetPts).toFixed(0)
              : +(currentPrice - _odTargetPts).toFixed(0),
            targetLabel: `T1: ${_odTargetPts}pt sweep-optimal`,
            keyLevel: +(isBull ? orH : orL).toFixed(0),
            keyLevelLabel: isBull ? 'OR High (support)' : 'OR Low (resistance)',
            // FIXED 2026-07-17: hand-typed "66.7% WR (N=42)"/"68.2% WR (N=22)" — real live SETUP_STATUS
            // data (N=44-59) shows OPEN_DRIVE_LONG's EV has since flipped negative (-$7 to -$16/trade)
            // and WR is ~46-47%, ~19pp lower than the hardcoded claim. Same "never fabricate a stat"
            // violation fixed elsewhere this session (docs/OPEN_THREADS.md).
            description: isBull
              ? `Open Drive up confirmed. Pullback to near OR High (${orH?.toFixed(0)}) — first test of the breakout level.\n\nEDGE: OPEN_DRIVE_LONG ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('OPEN_DRIVE_LONG') ?? 'not yet calibrated'} overall. EXECUTION: Buy the pullback to OR High. Stop below OR Low −1× OR Range (${+(orL - (orH - orL)).toFixed(0)}). Target ${_odTargetPts}pt sweep-optimal. Do NOT fade this drive before 1:30 PM.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — higher conviction.' : ''}`
              : `Open Drive down confirmed. Rally toward OR Low (${orL?.toFixed(0)}) — first test of the breakdown level.\n\nEDGE: OPEN_DRIVE_SHORT ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('OPEN_DRIVE_SHORT') ?? 'not yet calibrated'} overall. EXECUTION: Short the rally to OR Low. Stop above OR High +2pt (${+(orH + 2).toFixed(0)}). Target ${_odTargetPts}pt sweep-optimal.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — highest conviction zone.' : ''}`,
            history: await getHistory('TRENDING_UP'),
          };
        }
      }

      // ── Setup D: Opening Drive, 15-minute-OR-consistent (roadmap Phase 6, 2026-08-11) ──
      // Deliberately a NEW setup_type (OPENING_DRIVE_15MIN_LONG/SHORT), NOT a change to
      // OPEN_DRIVE_LONG/SHORT above. Stage 1 (scripts/backtest_setup_d_opening_drive_
      // stage1.mjs) tested the CURRENT live 5-min-OR definition against a 15-min-OR-
      // consistent variant, each with a required blind-delay confound control (DeepSeek
      // design critique, scratch/deepseek_setup_d_design.md — the same confound that
      // invalidated engagement_confirmation_entry_timing: entering later against fixed
      // exits is structurally favorable regardless of the entry condition tested). Result:
      // the 5-min (live, above) definition FAILED its own confound check — its apparent
      // edge was indistinguishable from "just enter later." The 15-min variant PASSED
      // cleanly (beat blind delay, beat a flat default, rigor-clean, N=138). Full account:
      // OPEN_DECISION open_drive_5min_or_vs_15min_classifier_mismatch (resolved).
      //
      // Uses the extracted classifyACDOpeningCall() (server/services/
      // openingCallClassifier.js) — the SAME formula OPEN_DRIVE above uses inline, not a
      // reimplementation — fed a 15-minute OR (9:30-9:45) and a 45-minute confirm window
      // (9:30-10:15, same 1:3 anchor:confirm ratio the live 5-min/15-min pairing already
      // uses, just scaled up), replicating Stage 1's exact VARIANT_15MIN definition.
      let openingDrive15Min = null;
      try {
        if (currentPrice && etMin >= 615) { // confirm window (9:30-10:15) must have closed
          const odOrBars = allRthBarsRow.rows.filter(b => b.et_min < 585); // 9:30-9:45
          const odConfirmBars = allRthBarsRow.rows.filter(b => b.et_min < 615); // 9:30-10:15
          if (odOrBars.length >= 5 && odConfirmBars.length >= 15) {
            const odOrH = Math.max(...odOrBars.map(b => b.high));
            const odOrL = Math.min(...odOrBars.map(b => b.low));
            const odCall = classifyACDOpeningCall(odConfirmBars, odOrH, odOrL);
            if (odCall?.type === 'OPEN_DRIVE') {
              const isLong = odCall.driveDirection === 'UP';
              // Exact asymmetric pullback band replicated from OPEN_DRIVE above — a
              // symmetric band would test a different (unvalidated) entry rule.
              const nearBoundary = isLong
                ? (currentPrice >= odOrH - 15 && currentPrice <= odOrH + 5)
                : (currentPrice <= odOrL + 15 && currentPrice >= odOrL - 5);
              if (nearBoundary) {
                const type = isLong ? 'OPENING_DRIVE_15MIN_LONG' : 'OPENING_DRIVE_15MIN_SHORT';
                const opt = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._opt?.[type];
                // Fallbacks only cover the narrow window before the OPTIMAL_STOP seed row
                // (Stage 1's own result, stop=85/target=150) exists or if this lookup fails
                // — same bootstrap-then-real-data-overrides pattern used throughout this file.
                const stopPts = opt?.stop ?? 85;
                const targetPts = opt?.target ?? 150;
                openingDrive15Min = {
                  type, direction: isLong ? 'LONG' : 'SHORT', entry: currentPrice,
                  stop: Math.round(isLong ? currentPrice - stopPts : currentPrice + stopPts),
                  target: Math.round(isLong ? currentPrice + targetPts : currentPrice - targetPts),
                  targetLabel: `15-min OR drive reversal-of-pullback (Setup D)`,
                  description: `15-min Opening Range drive confirmed ${isLong ? 'up' : 'down'}, price pulled back to the OR boundary. Stage 1 bar-history backtest: stop ${stopPts}pt / target ${targetPts}pt (N=138, rigor-clean, beat its own blind-delay control).`,
                  history: { winRate: null, occurrences: null, avgPnl: null, t1HitRate: null },
                };
              }
            }
          }
        }
      } catch (odErr) {
        // Isolated (2026-08-11, same convention as failedSweepReversalSetup above): a bug
        // here should cost this one SHADOW-only setup's fire for this poll, not 500 the
        // entire /api/acd/setup-detection response via the route's own outer catch.
        console.error('[setup-detection] OPENING_DRIVE_15MIN block error (isolated, not fatal):', odErr.message);
        openingDrive15Min = null;
      }

      // ── SETUP 5a: C PAIRED (LONG) ────────────────────────────────────────────
      let cPairedLong = null;
      if (aUpFired && cUpConf && !timelineEvents.some(e => e === 'C_PAIRED_LONG')) {
        const cPairedLongT1 = t1GuardLabeled('LONG', currentPrice,
          { value: pdVAH, label: 'Prior Day VAH' },
          { value: (orH != null && orRange != null) ? orH + orRange * 1.5 : null, label: 'OR Measured Move 1.5x' }
        );
        cPairedLong = {
          type: 'C_PAIRED_LONG', label: 'C PAIRED (LONG)',
          direction: 'LONG',
          entry: +currentPrice.toFixed(0),
          stop: orL ? +orL.toFixed(0) : null,
          target: cPairedLongT1.value,
          targetLabel: cPairedLongT1.label,
          keyLevel: orH ? +orH.toFixed(0) : null, keyLevelLabel: 'OR High',
          description: `C Up confirmed after an A Up fired. Paired C confirms absorption of seller counter-moves. Hold for weekly extension. Stop below OR Low (${orL?.toFixed(0)}).`,
          history: await getHistory('TRENDING_UP'),
        };
      }

      // ── SETUP 5b: C PAIRED (SHORT) ───────────────────────────────────────────
      let cPairedShort = null;
      if (aDownFired && cDownConf && !timelineEvents.some(e => e === 'C_PAIRED_SHORT')) {
        const cPairedShortT1 = t1GuardLabeled('SHORT', currentPrice,
          { value: pdVAL, label: 'Prior Day VAL' },
          { value: (orL != null && orRange != null) ? orL - orRange * 1.5 : null, label: 'OR Measured Move 1.5x' }
        );
        cPairedShort = {
          type: 'C_PAIRED_SHORT', label: 'C PAIRED (SHORT)',
          direction: 'SHORT',
          entry: +currentPrice.toFixed(0),
          stop: orH ? +orH.toFixed(0) : null,
          target: cPairedShortT1.value,
          targetLabel: cPairedShortT1.label,
          keyLevel: orL ? +orL.toFixed(0) : null, keyLevelLabel: 'OR Low',
          description: `C Down confirmed after an A Down fired. Paired C confirms absorption of buyer counter-moves. Hold for weekly extension. Stop above OR High (${orH?.toFixed(0)}).`,
          history: await getHistory('TRENDING_DOWN'),
        };
      }

      // ── SETUP 5c: C REVERSAL (LONG) ──────────────────────────────────────────
      let cReversalLong = null;
      if (aDownFired && cUpConf && !timelineEvents.some(e => e === 'C_REVERSAL_LONG')) {
        const cReversalLongT1 = t1GuardLabeled('LONG', currentPrice,
          { value: pdVAH, label: 'Prior Day VAH' },
          { value: (orH != null && orRange != null) ? orH + orRange : null, label: 'OR Measured Move' }
        );
        cReversalLong = {
          type: 'C_REVERSAL_LONG', label: 'C REVERSAL (LONG)',
          direction: 'LONG',
          entry: +currentPrice.toFixed(0),
          stop: sessionLow ? +sessionLow.toFixed(0) : (orL ? +orL.toFixed(0) : null),
          target: cReversalLongT1.value,
          targetLabel: cReversalLongT1.label,
          keyLevel: orH ? +orH.toFixed(0) : null, keyLevelLabel: 'OR High',
          description: `C Up fires after a failed A Down signal, confirming that the initial bearish thesis reversed. Stop below session low (${sessionLow?.toFixed(0)}).`,
          history: await getHistory('TRANSITIONAL'),
        };
      }

      // ── SETUP 5d: C REVERSAL (SHORT) ─────────────────────────────────────────
      let cReversalShort = null;
      if (aUpFired && cDownConf && !timelineEvents.some(e => e === 'C_REVERSAL_SHORT')) {
        const cReversalShortT1 = t1GuardLabeled('SHORT', currentPrice,
          { value: pdVAL, label: 'Prior Day VAL' },
          { value: (orL != null && orRange != null) ? orL - orRange : null, label: 'OR Measured Move' }
        );
        cReversalShort = {
          type: 'C_REVERSAL_SHORT', label: 'C REVERSAL (SHORT)',
          direction: 'SHORT',
          entry: +currentPrice.toFixed(0),
          stop: sessionHigh ? +sessionHigh.toFixed(0) : (orH ? +orH.toFixed(0) : null),
          target: cReversalShortT1.value,
          targetLabel: cReversalShortT1.label,
          keyLevel: orL ? +orL.toFixed(0) : null, keyLevelLabel: 'OR Low',
          description: `C Down fires after a failed A Up signal, confirming that the initial bullish thesis reversed. Stop above session high (${sessionHigh?.toFixed(0)}).`,
          history: await getHistory('TRANSITIONAL'),
        };
      }

      // ── SETUP 6: FAILED AUCTION ───────────────────────────────────────────────
      let failedAuction = null;
      {
        const gLineLost      = timelineEvents.includes('G-Line lost');
        const gLineReclaimed = timelineEvents.includes('G-Line reclaimed');
        const pwHighTested   = timelineEvents.includes('PW High tested');
        const pwHighBroken   = timelineEvents.includes('PW High broken');
        const pwLowTested    = timelineEvents.includes('PW Low tested');
        const pwLowBroken    = timelineEvents.includes('PW Low broken');
        const lastBarVol     = latestBarRow.rows[0]?.volume || 0;
        const highVolume     = avgVol > 0 && lastBarVol > avgVol * 1.5;

        // FIXED 2026-07-17 (same "unbounded structural-level target" bug found and fixed for
        // IB_BULLISH/BEARISH, OPEN_DRIVE, VALUE_AREA_RESPONSIVE, BRACKET_BREAKOUT — see
        // docs/OPEN_THREADS.md): pdVAL/pdVAH picked first via t1Guard regardless of realistic
        // distance. FAILED_AUCTION_LONG/SHORT were THIN_N (N=3/N=9) with no OPTIMAL_STOP row at
        // the time of that fix, so the 40/35 fallback below was the only option — using the same
        // conservative generic fallback distance as other uncalibrated setups instead of an
        // unbounded structural level. FAILED_AUCTION_LONG has since cleared N≥20 (2026-08-03,
        // stop=54/target=26) — _faOpt now reads that row for new fires; the 40/35 fallback only
        // still applies to FAILED_AUCTION_SHORT (still THIN_N) or if _opt is momentarily unavailable.
        const _faOpt = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._opt;
        if (pwHighTested && !pwHighBroken && currentPrice && currentPrice < (orH || currentPrice + 50)) {
          const _faStopPts = _faOpt?.FAILED_AUCTION_SHORT?.stop ?? 40;
          const _faTargetPts = _faOpt?.FAILED_AUCTION_SHORT?.target ?? 35;
          failedAuction = {
            type: 'FAILED_AUCTION_SHORT', label: 'FAILED AUCTION — PRIOR WEEK HIGH',
            direction: 'SHORT',
            entry: +currentPrice.toFixed(0),
            stop: +(currentPrice + _faStopPts).toFixed(0),
            target: +(currentPrice - _faTargetPts).toFixed(0),
            targetLabel: `T1: ${_faTargetPts}pt sweep-optimal · Stop: ${_faStopPts}pt`,
            keyLevel: null, keyLevelLabel: 'Prior Week High',
            description: `Prior week high was tested but price failed to close above it — supply waiting. Bulls pushed to last week's extreme, found sellers, retreated. Fade the failed breakout.\n\nEDGE: ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('FAILED_AUCTION_SHORT') ?? 'not yet calibrated'} overall.`,
            history: await getHistory('BALANCE'),
          };
        } else if (pwLowTested && !pwLowBroken && currentPrice && currentPrice > (orL || currentPrice - 50)) {
          const _faStopPts = _faOpt?.FAILED_AUCTION_LONG?.stop ?? 40;
          const _faTargetPts = _faOpt?.FAILED_AUCTION_LONG?.target ?? 35;
          failedAuction = {
            type: 'FAILED_AUCTION_LONG', label: 'FAILED AUCTION — PRIOR WEEK LOW',
            direction: 'LONG',
            entry: +currentPrice.toFixed(0),
            stop: +(currentPrice - _faStopPts).toFixed(0),
            target: +(currentPrice + _faTargetPts).toFixed(0),
            targetLabel: `T1: ${_faTargetPts}pt sweep-optimal · Stop: ${_faStopPts}pt`,
            keyLevel: null, keyLevelLabel: 'Prior Week Low',
            description: `Prior week low tested but price failed to close below — buyers defended. Fade the failed breakdown.\n\nEDGE: ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('FAILED_AUCTION_LONG') ?? 'not yet calibrated'} overall.`,
            history: await getHistory('BALANCE'),
          };
        } else if (gLineLost && gLineReclaimed && currentPrice) {
          const _faStopPts = _faOpt?.FAILED_AUCTION_LONG?.stop ?? 40;
          const _faTargetPts = _faOpt?.FAILED_AUCTION_LONG?.target ?? 35;
          failedAuction = {
            type: 'FAILED_AUCTION_LONG', label: 'FAILED AUCTION — G-LINE RECLAIM',
            direction: 'LONG',
            entry: +currentPrice.toFixed(0),
            stop: +(currentPrice - _faStopPts).toFixed(0),
            target: +(currentPrice + _faTargetPts).toFixed(0),
            targetLabel: `T1: ${_faTargetPts}pt sweep-optimal · Stop: ${_faStopPts}pt`,
            keyLevel: null, keyLevelLabel: 'G-Line (weekly open)',
            description: `G-Line lost then reclaimed — bears failed to hold below weekly open. ${highVolume ? 'High volume on reclaim confirms conviction.' : ''}\n\nEDGE: ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('FAILED_AUCTION_LONG') ?? 'not yet calibrated'} overall.`,
            history: await getHistory('TRANSITIONAL'),
          };
        }
      }

      // ── SETUP 7: BRACKET BREAKOUT ─────────────────────────────────────────────
      let bracketBreakout = null;
      if (ltRow.rows.length >= 3 && orH && orL && currentPrice && pdVAH && pdVAL) {
        const priorHighs = ltRow.rows.map(r => r.or_high).filter(Boolean);
        const priorLows  = ltRow.rows.map(r => r.or_low).filter(Boolean);
        const bracketTop = priorHighs.length ? Math.max(...priorHighs) : null;
        const bracketBot = priorLows.length  ? Math.min(...priorLows)  : null;
        const breakingUp   = bracketTop && currentPrice > bracketTop + 5 && nl30State === 'BULLISH';
        const breakingDown = bracketBot && currentPrice < bracketBot - 5 && nl30State === 'BEARISH';
        if (breakingUp || breakingDown) {
          const isBull = breakingUp;
          // FIXED 2026-07-17: hand-typed "+4.4% directional edge (55.1% WR, N=49)"/"+30.7% directional
          // edge (80% WR, N=10)" — real live SETUP_STATUS shows BRACKET_BREAKOUT_LONG is SUPPRESS
          // (N=37, WR=29.7%, EV=-$16.84) and BRACKET_BREAKOUT_SHORT is THIN_N (N=16, WR=6.3%,
          // EV=-$104.75) — the polar opposite of the hardcoded claim. Same "never fabricate a stat"
          // violation, plus the same "unbounded structural-level target" bug (raw VA-extension
          // distance, no cap) fixed elsewhere this session (docs/OPEN_THREADS.md). Stop/target now
          // read the real sweep-optimal OPTIMAL_STOP calibration.
          const _bbOpt = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._opt?.[isBull ? 'BRACKET_BREAKOUT_LONG' : 'BRACKET_BREAKOUT_SHORT'];
          const _bbStopPts = _bbOpt?.stop ?? 80;
          const _bbTargetPts = _bbOpt?.target ?? 30;
          bracketBreakout = {
            type: isBull ? 'BRACKET_BREAKOUT_LONG' : 'BRACKET_BREAKOUT_SHORT',
            label: isBull ? 'BRACKET BREAKOUT (LONG)' : 'BRACKET BREAKOUT (SHORT)',
            direction: isBull ? 'LONG' : 'SHORT',
            entry: +currentPrice.toFixed(0),
            stop: isBull ? +(currentPrice - _bbStopPts).toFixed(0) : +(currentPrice + _bbStopPts).toFixed(0),
            target: isBull ? +(currentPrice + _bbTargetPts).toFixed(0) : +(currentPrice - _bbTargetPts).toFixed(0),
            targetLabel: `T1: ${_bbTargetPts}pt sweep-optimal · Stop: ${_bbStopPts}pt`,
            keyLevel: +(isBull ? bracketTop : bracketBot).toFixed(0),
            keyLevelLabel: isBull ? 'Prior Bracket Top' : 'Prior Bracket Bottom',
            description: isBull
              ? `5-session bracket top (${bracketTop?.toFixed(0)}) exceeded with NL30 +${nl30}.\n\nEDGE: BRACKET_BREAKOUT_LONG ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('BRACKET_BREAKOUT_LONG') ?? 'not yet calibrated'} overall. EXECUTION: Prior bracket top becomes support. Buy pullbacks to the bracket boundary. Stop ${_bbStopPts}pt below entry. Target ${_bbTargetPts}pt sweep-optimal.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — higher conviction.' : ''}`
              : `5-session bracket bottom (${bracketBot?.toFixed(0)}) broken with NL30 ${nl30}.\n\nEDGE: BRACKET_BREAKOUT_SHORT ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('BRACKET_BREAKOUT_SHORT') ?? 'not yet calibrated'} overall. EXECUTION: Prior bracket bottom becomes resistance. Short rallies to bracket boundary. Stop ${_bbStopPts}pt above entry. Target ${_bbTargetPts}pt sweep-optimal.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — highest conviction.' : ''}`,
            history: await getHistory(isBull ? 'TRENDING_UP' : 'TRENDING_DOWN'),
          };
        }
      }

      // ── SETUP 8: VALUE AREA RESPONSIVE ───────────────────────────────────────
      let valueAreaResp = null;
      if (liveOpenVsPrior === 'INSIDE_VALUE' && liveOpeningCallType !== 'OPEN_DRIVE' && currentPrice && pdVAH && pdVAL) {
        const nearVAH = Math.abs(currentPrice - pdVAH) <= 20;
        const nearVAL = Math.abs(currentPrice - pdVAL) <= 20;
        if (nearVAH || nearVAL) {
          const isFade = nearVAH;
          // FIXED 2026-07-17 (same "unbounded structural-level target" bug found and fixed for
          // IB_BULLISH/BEARISH and OPEN_DRIVE — see docs/OPEN_THREADS.md). Both stop (hardcoded
          // +18/-8pt, contradicted its own description text which claimed a different "recalibrated"
          // value) and target (raw PD POC/VAH/VAL distance, unbounded) now read the real sweep-
          // optimal OPTIMAL_STOP calibration instead.
          const _varOpt = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._opt?.[isFade ? 'VALUE_AREA_RESPONSIVE_SHORT' : 'VALUE_AREA_RESPONSIVE_LONG'];
          const _varStopPts = _varOpt?.stop ?? 30;
          const _varTargetPts = _varOpt?.target ?? 28;
          valueAreaResp = {
            type: isFade ? 'VALUE_AREA_RESPONSIVE_SHORT' : 'VALUE_AREA_RESPONSIVE_LONG',
            label: isFade ? 'VALUE AREA RESPONSIVE (SHORT)' : 'VALUE AREA RESPONSIVE (LONG)',
            direction: isFade ? 'SHORT' : 'LONG',
            entry: +currentPrice.toFixed(0),
            stop: isFade ? +(currentPrice + _varStopPts).toFixed(0) : +(currentPrice - _varStopPts).toFixed(0),
            target: isFade ? +(currentPrice - _varTargetPts).toFixed(0) : +(currentPrice + _varTargetPts).toFixed(0),
            targetLabel: `T1: ${_varTargetPts}pt sweep-optimal · Stop: ${_varStopPts}pt`,
            keyLevel: +(isFade ? pdVAH : pdVAL).toFixed(0),
            keyLevelLabel: isFade ? 'Prior Day VAH' : 'Prior Day VAL',
            // FIXED 2026-07-17: hand-typed "66.7% WR (N=60)... 90% WR (N=10)... 93% WR (N=14)" for
            // SHORT, and a hardcoded "-5.0% directional edge, SUPPRESSED" claim for LONG that
            // directly contradicts live data (VALUE_AREA_RESPONSIVE_LONG is actually ACTIVE with
            // positive EV). Same "never fabricate a stat" violation fixed elsewhere this session
            // (docs/OPEN_THREADS.md).
            description: isFade
              ? `Price opened inside prior value and is testing VAH (${pdVAH?.toFixed(0)}) — responsive sellers defend this level.\n\nEDGE: VALUE_AREA_RESPONSIVE_SHORT ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('VALUE_AREA_RESPONSIVE_SHORT') ?? 'not yet calibrated'} overall. EXECUTION: Stop ${_varStopPts}pt above entry. Target ${_varTargetPts}pt sweep-optimal.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — highest conviction.' : ''}`
              : `Price opened inside prior value and is testing VAL (${pdVAL?.toFixed(0)}) — responsive buyers defend this level.\n\nEDGE: VALUE_AREA_RESPONSIVE_LONG ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('VALUE_AREA_RESPONSIVE_LONG') ?? 'not yet calibrated'} overall. EXECUTION: Stop ${_varStopPts}pt below entry. Target ${_varTargetPts}pt sweep-optimal.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — highest conviction.' : ''}`,
            history: await getHistory('BALANCE'),
          };
        }
      }

      // ── SETUP 9: C STANDALONE ─────────────────────────────────────────────────
      // No A signal today — first C break of OR is the setup
      let cStandalone = null;
      // RE-ENABLED 2026-07-17 (user directive: shadow every confirmed-losing setup instead of
      // hard-killing it, so forward data keeps accumulating and it can be reconsidered if it
      // recovers -- "treat these like the others that go through the motions"). Both branches
      // were fully disabled since 2026-07-05 (C_STANDALONE_UP: empty branch, C_STANDALONE_DOWN:
      // `if (false)`), meaning NEITHER fired even in shadow mode -- zero new data collected for
      // 12 days, unlike every other suppressed setup in this file (OPEN_TEST_DRIVE,
      // BRACKET_BREAKOUT, IB_BULLISH/BEARISH, the generic level-fade family), which all
      // continue to construct and rely on the existing dynamic mechanism (shadowCandidates ->
      // liveStats._suppressedSetups -> status='SHADOW' at insert time, ~line 6018) to keep
      // them out of live trade recommendations without freezing their data collection. This
      // restores that same treatment for C_STANDALONE_UP/DOWN -- no change to the suppression
      // mechanism itself, just removing the two setup_types that had been special-cased out of
      // it. Both are still SUPPRESS in live SETUP_STATUS as of tonight, so they will insert as
      // status='SHADOW', not 'ACTIVE' -- they cannot fire as real trades either way.
      if (!aUpFired && !aDownFired && !hasCFiredToday && currentPrice && orH && orL) {
        if (currentPrice > orH) {
          cStandalone = {
            type: 'C_STANDALONE_UP', label: 'C UP (STANDALONE)',
            direction: 'LONG',
            entry: +currentPrice.toFixed(0),
            stop: +(orL - 4).toFixed(0),
            target: t1Guard('LONG', currentPrice, pdVAH, currentPrice + (orRange || 80)),
            targetLabel: 'T1: PD VAH (half off) · Runner: 45pt',
            keyLevel: +orH.toFixed(0), keyLevelLabel: 'OR High',
            description: `No A signal today. C Up — price closing above OR High (${orH?.toFixed(0)}).\n\nEDGE: ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('C_STANDALONE_UP') ?? 'not yet calibrated'} overall — this setup is currently suppressed (confirmed negative EV).`,
            history: await getHistory('BALANCE'),
          };
        } else if (currentPrice < orL && nearPD2VA) {
          cStandalone = {
            type: 'C_STANDALONE_DOWN', label: 'C DOWN (STANDALONE)',
            direction: 'SHORT',
            entry: +currentPrice.toFixed(0),
            stop: +(orH + 4).toFixed(0),
            target: t1Guard('SHORT', currentPrice, pdVAL, currentPrice - (orRange || 80)),
            targetLabel: 'T1: PD VAL (half off) · Runner: 45pt',
            keyLevel: +orL.toFixed(0), keyLevelLabel: 'OR Low',
            description: `No A signal today. C Down — price closing below OR Low (${orL?.toFixed(0)}).\n\nEDGE: ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('C_STANDALONE_DOWN') ?? 'not yet calibrated'} overall — this setup is currently suppressed (confirmed negative EV).`,
            history: await getHistory('BALANCE'),
          };
        }
      }

      // ── SETUP 10: GAP FILL ──────────────────────────────────────────────────
      let gapFill = null;
      {
        const rangesQ = await query(`
          SELECT d, rth_low, rth_high FROM (
            SELECT ts::date::text as d,
              MIN(low)::float as rth_low,
              MAX(high)::float as rth_high
            FROM price_bars_primary
            WHERE symbol='NQ'
              AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
              AND ts::date <= $1
            GROUP BY ts::date
            ORDER BY ts::date DESC
            LIMIT 40
          ) sub ORDER BY d ASC
        `, [todayET]);
        const sessions = rangesQ.rows;

        if (sessions.length >= 2 && currentPrice) {
          const gaps = [];
          for (let i = 1; i < sessions.length; i++) {
            const prev = sessions[i - 1];
            const curr = sessions[i];
            if (curr.rth_low > prev.rth_high) {
              gaps.push({ type: 'up', fromDate: prev.d, toDate: curr.d, gapLow: prev.rth_high, gapHigh: curr.rth_low });
            } else if (curr.rth_high < prev.rth_low) {
              gaps.push({ type: 'down', fromDate: prev.d, toDate: curr.d, gapLow: curr.rth_high, gapHigh: prev.rth_low });
            }
          }

          const openGaps = [];
          for (const gap of gaps) {
            const gapIdx = sessions.findIndex(s => s.d === gap.toDate);
            const gapSize = gap.gapHigh - gap.gapLow;
            let filled = false;
            for (let i = gapIdx + 1; i < sessions.length; i++) {
              const s = sessions[i];
              if (gap.type === 'up') {
                if (s.rth_low <= gap.gapLow) { filled = true; break; }
              } else {
                if (s.rth_high >= gap.gapHigh) { filled = true; break; }
              }
            }
            if (!filled) {
              openGaps.push({ ...gap, gapSize });
            }
          }

          for (const gap of openGaps) {
            if (currentPrice < gap.gapHigh && currentPrice > gap.gapLow) {
              if (gap.type === 'up') {
                gapFill = {
                  type: 'GAP_FILL_SHORT',
                  label: `GAP FILL SHORT (${gap.fromDate} to ${gap.toDate})`,
                  direction: 'SHORT',
                  entry: +currentPrice.toFixed(0),
                  stop: +Math.round(gap.gapHigh + 15),
                  target: t1Guard('SHORT', currentPrice, gap.gapLow),
                  targetLabel: 'Gap Floor',
                  keyLevel: +Math.round(gap.gapHigh),
                  keyLevelLabel: 'Gap Ceiling',
                  description: `NQ entered the unfilled up-gap zone from ${gap.fromDate} to ${gap.toDate} (${Math.round(gap.gapLow)}–${Math.round(gap.gapHigh)}). Expecting fast travel to complete the gap fill down to ${Math.round(gap.gapLow)}. Invalidation is 15 pts above gap ceiling.`,
                  history: await getHistory('TREND'),
                };
              } else {
                gapFill = {
                  type: 'GAP_FILL_LONG',
                  label: `GAP FILL LONG (${gap.fromDate} to ${gap.toDate})`,
                  direction: 'LONG',
                  entry: +currentPrice.toFixed(0),
                  stop: +Math.round(gap.gapLow - 15),
                  target: t1Guard('LONG', currentPrice, gap.gapHigh),
                  targetLabel: 'Gap Ceiling',
                  keyLevel: +Math.round(gap.gapLow),
                  keyLevelLabel: 'Gap Floor',
                  description: `NQ entered the unfilled down-gap zone from ${gap.fromDate} to ${gap.toDate} (${Math.round(gap.gapLow)}–${Math.round(gap.gapHigh)}). Expecting fast travel to complete the gap fill up to ${Math.round(gap.gapHigh)}. Invalidation is 15 pts below gap floor.`,
                  history: await getHistory('TREND'),
                };
              }
              break;
            }
          }
        }
      }

      // IB setup day-type precision gate — made DYNAMIC 2026-07-24 (was a hardcoded boolean
      // based on a stale in-code comment snapshot, re-verified/updated by hand at least twice
      // before, 2026-07-07 then 2026-07-14 — exactly the silent-drift pattern this codebase has
      // hit before, see docs/OPEN_THREADS.md). Now reads real DAY_TYPE_ALPHA rows (populated
      // weekly by backtest_day_type_alpha.js, extended 2026-07-23 to cover IB_BULLISH/IB_BEARISH
      // — previously excluded by that script's `LIKE '%FADE%'` filter) instead of a fixed
      // decision, using the same standard N>=20 / EV<-$5 bar this codebase already uses
      // everywhere else (backtest_setup_status.mjs's SUPPRESS floor) rather than a new
      // threshold. Self-corrects automatically as real data accumulates — no more manual
      // re-verification needed. liveStats._dta isn't populated until much later in this
      // function (~line 4877's Promise.all) so this can't reuse that shared object here;
      // intentionally a small, self-contained query instead of restructuring control flow in
      // this fragile function.
      if (ibSetup) {
        const ibDtaQ = await query(`
          SELECT DISTINCT ON (signal_name) signal_name, sample_size, ev_per_trade, notes, run_date::text
          FROM performance_audit
          WHERE signal_type='DAY_TYPE_ALPHA' AND signal_name = ANY($1::text[])
          ORDER BY signal_name, run_date DESC
        `, [['IB_BULLISH_BALANCE', 'IB_BULLISH_TREND', 'IB_BULLISH_TURBULENT',
             'IB_BEARISH_BALANCE', 'IB_BEARISH_TREND', 'IB_BEARISH_TURBULENT']]);
        const ibDtaRow = ibDtaQ.rows.find(r => r.signal_name === `${ibSetup.type}_${dtClass}`);
        if (ibDtaRow) {
          // Real-N floor added 2026-07-28 (Opus Audit #5 + direct user question "why is
          // IB_BULLISH still firing") -- the check above this comment trusted the BLENDED
          // cell EV with no origin_status filter, same gap PROMOTE_MIN_REAL_N already fixed
          // for the main SUPPRESS check on 2026-07-20 (backtest_setup_status.mjs) but never
          // applied here. Confirmed live: IB_BULLISH_TREND fired on blended EV=+$37.8 while
          // real (ACTIVE/SHADOW-origin) support was 0 trades -- all UNKNOWN-origin, unverifiable.
          // IB_BEARISH_TURBULENT fired on blended +$57.1 while real EV was -$12.70 (N=10 real).
          // Fix: once a cell has >=REAL_N_FLOOR real trades, trust REAL EV instead of blended
          // (this can un-suppress a cell whose blended EV looks bad but whose real trades are
          // fine, not just suppress) -- below the floor, treat as unproven and don't fire it
          // live regardless of how good blended looks, since blended can't be trusted at all
          // (the exact IB_BULLISH_TREND failure mode). REAL_N_FLOOR=5 reuses backtest_setup_
          // status.mjs's PROMOTE_MIN_REAL_N precedent (not importable directly -- that file
          // runs its whole backtest unconditionally on import, so redeclaring the same value
          // here with this comment is the established pattern, see IB_MID_SCALP's own local
          // PT/COMM redeclaration elsewhere in this file for the identical convention).
          const REAL_N_FLOOR = 5;
          const dtaNotes = ibDtaRow.notes ? JSON.parse(ibDtaRow.notes) : {};
          const realN = dtaNotes.real_n ?? 0;
          const realEv = dtaNotes.real_ev;
          const unproven = realN < REAL_N_FLOOR;
          const realBad = !unproven && realEv != null && realEv < -5;
          if (unproven || realBad) {
            // FIXED 2026-08-05 (RESEARCH_CLAIM ib_bullish_blocked_by_stale_daytype_alpha_realn0):
            // this gate previously nulled ibSetup with zero trace anywhere -- not a console
            // line, not a DB row, nothing. It silently blocked every IB_BULLISH RTH candidate
            // for 2+ days (a stale DAY_TYPE_ALPHA row reading real_n=0) and was only found by
            // reasoning backward from an unexplained outage. A gate that nulls a candidate
            // must say why, in real time, not just in a scratch/*.log line that scrolls away --
            // console.error so it lands in scratch/server_errors.jsonl (the standing error
            // watcher already tails this) and is queryable/greppable after the fact.
            const ibGateReason = `DAY_TYPE_ALPHA real-N floor: cell=${ibDtaRow.signal_name} run_date=${ibDtaRow.run_date} real_n=${realN} (floor=${REAL_N_FLOOR}) real_ev=${realEv ?? 'n/a'} reason=${unproven ? 'unproven (real_n<floor)' : 'realBad (real_ev<-5)'}`;
            console.error(`[ib-gate] ${ibSetup.type} NULLED by ${ibGateReason}`);
            logGatedCandidate({ tradeDate: todayET, setupType: ibSetup.type, gateName: 'IB_DAYTYPE_REAL_N_FLOOR', gateReason: ibGateReason, entry: ibSetup.entry, stop: ibSetup.stop, target: ibSetup.target });
            ibSetup = null;
          }
        }
      }

      // Morning volatility regime — used to gate C_STANDALONE in HIGH-VOL-CHOP (0% WR confirmed, regime backtest 2026-06-30)
      const regimeResult = await computeLiveVolatilityRegime().catch(() => ({ regime: null }));
      const morningRegime = regimeResult?.regime || null;

      // ── BULLISH ABSORPTION detection (support held + RSI rising + price flat) ──
      // Uses 2-min bars: 5-min was too coarse (16 fires/yr, 0 morning). 2-min
      // fires ~83/yr with 32 morning detections on BALANCE days.
      let absorptionSetup = null;
      if (allRthBarsRow.rows.length >= 30) {
        const absTwoBk = {};
        for (const b of allRthBarsRow.rows) {
          const bk = Math.floor(b.et_min / 2) * 2;
          if (!absTwoBk[bk]) absTwoBk[bk] = { high: b.high, low: b.low, close: b.close, open: b.open };
          else { absTwoBk[bk].high = Math.max(absTwoBk[bk].high, b.high); absTwoBk[bk].low = Math.min(absTwoBk[bk].low, b.low); absTwoBk[bk].close = b.close; }
        }
        const absFb = Object.values(absTwoBk);
        if (absFb.length >= 25) {
          const absC = absFb.map(b => b.close);
          const absRsi = new Array(absC.length).fill(null);
          let aag = 0, aal = 0;
          for (let i = 1; i <= 14; i++) { const d = absC[i] - absC[i-1]; aag += d > 0 ? d : 0; aal += d < 0 ? -d : 0; }
          aag /= 14; aal /= 14;
          absRsi[14] = aal === 0 ? 100 : 100 - 100 / (1 + aag / aal);
          for (let i = 15; i < absC.length; i++) {
            const d = absC[i] - absC[i-1]; aag = (aag * 13 + (d > 0 ? d : 0)) / 14; aal = (aal * 13 + (d < 0 ? -d : 0)) / 14;
            absRsi[i] = aal === 0 ? 100 : 100 - 100 / (1 + aag / aal);
          }

          const AW = 20;
          const last = absC.length - 1;
          if (last >= AW + 5 && absRsi[last] != null && absRsi[last - AW] != null) {
            const wb = absFb.slice(last - AW, last + 1);
            const wH = Math.max(...wb.map(b => b.high)), wL = Math.min(...wb.map(b => b.low));
            const wRange = wH - wL;
            const rsiDrift = absRsi[last] - absRsi[last - AW];
            const priceDrift = absC[last] - absC[last - AW];
            const priceFlat = Math.abs(priceDrift) < wRange * 0.3;
            const lowCluster = wb.filter(b => Math.abs(b.low - wL) < 5).length;

            const isBullAbsorption = lowCluster >= 4 && rsiDrift > 4 && priceFlat;
            const dayTypeOk = dtClass === 'BALANCE';

            if (isBullAbsorption && dayTypeOk) {
              const nearPD1VA = pdVAL && Math.abs(currentPrice - pdVAL) <= 25;
              const nearPD1POC = pdPOC && Math.abs(currentPrice - pdPOC) <= 25;
              const atLevel = nearPD1VA || nearPD1POC;

              const stopDist = 25;
              const targetDist = 40;
              // FIXED 2026-07-17: hand-typed "71.4% WR (N=35)... 90.9% WR (N=11)" with zero backing
              // data (ABSORPTION_LONG has never fired in active_setups) — same "never fabricate a
              // stat" violation as RSI_DIV above. Now reads liveStats._setupStats honestly.
              const _absorpStats = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._setupStats?.ABSORPTION_LONG;
              const _absorpEdge = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('ABSORPTION_LONG') ?? 'not yet calibrated';
              absorptionSetup = {
                type: 'ABSORPTION_LONG',
                direction: 'LONG',
                entry: +currentPrice.toFixed(0),
                stop: +(currentPrice - stopDist).toFixed(0),
                target: +(currentPrice + targetDist).toFixed(0),
                targetLabel: '40pt Runner (calibrated)',
                description: `Bullish absorption detected: ${lowCluster} 2-min bars clustering at support (${Math.round(wL)}), RSI rising +${rsiDrift.toFixed(0)} while price flat in ${Math.round(wRange)}pt range.\n\nEDGE: Bullish absorption ${_absorpEdge} overall.\n\nEXECUTION: Price held at support with buyers absorbing selling pressure. RSI confirms hidden bullish momentum. Enter long, stop below support zone (${Math.round(currentPrice - stopDist)}), target ${pdVAH ? 'PD VAH (' + Math.round(pdVAH) + ')' : '2R'}.${atLevel ? '\n\n✅ AT 2D VA LEVEL — historically higher conviction near this confluence.' : ''}${nearPD2VA ? '\n✅ PD-2 VA CONFLUENCE' : ''}`,
                history: (_absorpStats && _absorpStats.n >= 20)
                  ? { winRate: _absorpStats.wr, occurrences: _absorpStats.n, avgPnl: _absorpStats.ev, t1HitRate: _absorpStats.wr }
                  : { winRate: null, occurrences: null, avgPnl: null, t1HitRate: null },
              };
            }
          }
        }
      }

      // ── COIL SURGE detection (coil → volume surge → fade toward VWAP) ─────
      let coilSurgeSetup = null;
      if (allRthBarsRow.rows.length >= 60) {
        const cbars = allRthBarsRow.rows;
        const cRW = 15, cRT = 40, cVR = 0.40, cBB = 20, cPOP = 2.5;
        // Progressive VWAP
        let cPV = 0, cTV = 0;
        const cVwaps = [];
        for (const b of cbars) {
          const tp = (b.high + b.low + b.close) / 3;
          cPV += tp * (Number(b.vol) || 1); cTV += (Number(b.vol) || 1);
          cVwaps.push(cTV > 0 ? cPV / cTV : null);
        }

        for (let ci = 50; ci < cbars.length; ci++) {
          // Rolling range
          let cHi = -Infinity, cLo = Infinity;
          for (let j = ci - cRW + 1; j <= ci; j++) { cHi = Math.max(cHi, cbars[j].high); cLo = Math.min(cLo, cbars[j].low); }
          if (cHi - cLo >= cRT) continue;

          // Anchored baseline volume
          const cbs = Math.max(0, ci - cRW - cBB), cbe = ci - cRW;
          if (cbe - cbs < 10) continue;
          const cBv = cbars.slice(cbs, cbe).reduce((s, b) => s + (Number(b.vol) || 0), 0) / (cbe - cbs);
          if (cBv <= 0 || (Number(cbars[ci].vol) || 0) / cBv >= cVR) continue;

          // Check if CURRENT bar (latest) is a surge bar
          const lastBar = cbars[cbars.length - 1];
          const lastVol = Number(lastBar.vol) || 0;
          if (lastVol < cBv * cPOP) continue; // no surge yet
          if (ci < cbars.length - 5) continue; // coil must be recent (within last 5 bars)

          const vwap = cVwaps[cbars.length - 1];
          if (!vwap) continue;

          const dist = currentPrice - vwap;
          const isLong = dist < 0; // below VWAP → long toward VWAP
          const targetDist = Math.abs(dist);
          if (targetDist < 8) continue; // too close to VWAP, no trade

          const stopDist = Math.max(15, isLong ? currentPrice - (cLo - 5) : (cHi + 5) - currentPrice);
          const dayTypeOk = (dtClass === 'TREND' || (isLong && nl30 > 9) || (!isLong && nl30 < -9));
          if (!dayTypeOk) break; // only fire on TREND or NL30-aligned

          // FIXED 2026-07-17: hand-typed "65.3% WR on TREND days (N=49)... Expectancy +$24/trade"
          // with zero backing data (COIL_SURGE has never fired in active_setups) — same "never
          // fabricate a stat" violation as RSI_DIV/ABSORPTION_LONG above.
          const _coilType = isLong ? 'COIL_SURGE_LONG' : 'COIL_SURGE_SHORT';
          const _coilStats = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._setupStats?.[_coilType];
          const _coilEdge = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.(_coilType) ?? 'not yet calibrated';
          coilSurgeSetup = {
            type: _coilType,
            direction: isLong ? 'LONG' : 'SHORT',
            entry: +currentPrice.toFixed(0),
            stop: +(isLong ? currentPrice - stopDist : currentPrice + stopDist).toFixed(0),
            target: +vwap.toFixed(0),
            targetLabel: 'RTH VWAP',
            description: `Coil detected (${(cHi - cLo).toFixed(0)}pt range, volume ${((Number(cbars[ci].vol)||0)/cBv*100).toFixed(0)}% of baseline) with volume surge (${(lastVol/cBv).toFixed(1)}x baseline). Price is ${Math.abs(dist).toFixed(0)}pt ${dist > 0 ? 'above' : 'below'} VWAP.\n\nEDGE: Coil→surge→VWAP fade ${_coilEdge} overall.\n\nEXECUTION: Fade toward VWAP (${Math.round(vwap)}). Stop at coil range extreme (${isLong ? Math.round(cLo - 5) : Math.round(cHi + 5)}). Hold 10 bars max — edge decays after that. Only fires on TREND days or NL30-aligned.${nearPD2VA ? '\n\n✅ PD-2 VA CONFLUENCE' : ''}`,
            history: (_coilStats && _coilStats.n >= 20)
              ? { winRate: _coilStats.wr, occurrences: _coilStats.n, avgPnl: _coilStats.ev, t1HitRate: _coilStats.wr }
              : { winRate: null, occurrences: null, avgPnl: null, t1HitRate: null },
          };
          break;
        }
      }

      // ── 15min RSI Divergence detection ──────────────────────────────────────
      let rsiDivSetup = null;
      if (allRthBarsRow.rows.length >= 20) {
        // Resample to 15min
        const fifteenBk = {};
        for (const b of allRthBarsRow.rows) {
          const bk = Math.floor(b.et_min / 15) * 15;
          if (!fifteenBk[bk]) fifteenBk[bk] = { open: b.open, high: b.high, low: b.low, close: b.close };
          else { fifteenBk[bk].high = Math.max(fifteenBk[bk].high, b.high); fifteenBk[bk].low = Math.min(fifteenBk[bk].low, b.low); fifteenBk[bk].close = b.close; }
        }
        const fb15 = Object.values(fifteenBk);
        if (fb15.length >= 17) {
          const fc = fb15.map(b => b.close), fh = fb15.map(b => b.high), fl = fb15.map(b => b.low);
          // RSI(14)
          const rsiArr = new Array(fc.length).fill(null);
          let ag = 0, al = 0;
          for (let i = 1; i <= 14; i++) { const d = fc[i] - fc[i-1]; ag += d > 0 ? d : 0; al += d < 0 ? -d : 0; }
          ag /= 14; al /= 14;
          rsiArr[14] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
          for (let i = 15; i < fc.length; i++) {
            const d = fc[i] - fc[i-1]; ag = (ag * 13 + (d > 0 ? d : 0)) / 14; al = (al * 13 + (d < 0 ? -d : 0)) / 14;
            rsiArr[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
          }
          // Swing detection (N=2 for 15min — smaller window, faster detection)
          const SW = 2;
          const sHighs = [], sLows = [];
          for (let i = SW; i < fc.length - SW; i++) {
            let isH = true, isL = true;
            for (let j = 1; j <= SW; j++) {
              if (fh[i] <= fh[i-j] || fh[i] <= fh[i+j]) isH = false;
              if (fl[i] >= fl[i-j] || fl[i] >= fl[i+j]) isL = false;
            }
            if (isH) sHighs.push({ idx: i, price: fh[i], rsi: rsiArr[i] });
            if (isL) sLows.push({ idx: i, price: fl[i], rsi: rsiArr[i] });
          }
          // Check for divergence using the two most recent swing points
          // Bullish: price lower low + RSI higher low + CONFIRMATION bar closes higher
          if (sLows.length >= 2) {
            const curr = sLows[sLows.length - 1], prev = sLows[sLows.length - 2];
            if (curr.idx - prev.idx <= 12 && curr.price < prev.price && curr.rsi != null && prev.rsi != null && curr.rsi > prev.rsi) {
              const last = fc.length - 1;
              const confirmIdx = curr.idx + 1;
              const confirmed = confirmIdx <= last && fc[confirmIdx] > fc[curr.idx];
              if (confirmed && last - confirmIdx <= 2) {
                const stopDist = Math.max(20, Math.round((fh[curr.idx] - fl[curr.idx]) * 1.5));
                const rsiDelta = (curr.rsi - prev.rsi).toFixed(1);
                // FIXED 2026-07-17: this used to hand-type "WR with confirmation: 90.0% (N=20)" and a
                // matching history{} object with no real backing data at all — RSI_DIV_BULLISH has
                // zero fired trades in active_setups, a direct "never fabricate a stat" violation
                // (see CLAUDE.md, docs/OPEN_THREADS.md). Now reads liveStats._setupStats honestly via
                // _edgeText(), which reports real N/WR or says plainly there's no calibration yet.
                const _rsiBullStats = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._setupStats?.RSI_DIV_BULLISH;
                rsiDivSetup = {
                  type: 'RSI_DIV_BULLISH',
                  direction: 'LONG',
                  entry: currentPrice,
                  stop: currentPrice - stopDist,
                  target: t1Guard('LONG', currentPrice, currentPrice + stopDist * 2),
                  targetLabel: '2R Target',
                  description: `15min RSI BULLISH divergence CONFIRMED. Price made lower low (${Math.round(curr.price)} vs ${Math.round(prev.price)}) but RSI made higher low (${curr.rsi.toFixed(0)} vs ${prev.rsi.toFixed(0)}, Δ+${rsiDelta}). Confirmation bar closed higher — selling exhaustion confirmed. WR with confirmation: ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('RSI_DIV_BULLISH') ?? 'not yet calibrated'}. Scalp long — hold 3 bars (45min) max. Take profit at value area midpoint or 2R.`,
                  history: (_rsiBullStats && _rsiBullStats.n >= 20)
                    ? { winRate: _rsiBullStats.wr, occurrences: _rsiBullStats.n, avgPnl: _rsiBullStats.ev, t1HitRate: _rsiBullStats.wr }
                    : { winRate: null, occurrences: null, avgPnl: null, t1HitRate: null },
                };
              }
            }
          }
          // Bearish: price higher high + RSI lower high + CONFIRMATION bar closes lower
          if (!rsiDivSetup && sHighs.length >= 2) {
            const curr = sHighs[sHighs.length - 1], prev = sHighs[sHighs.length - 2];
            if (curr.idx - prev.idx <= 12 && curr.price > prev.price && curr.rsi != null && prev.rsi != null && curr.rsi < prev.rsi) {
              const last = fc.length - 1;
              const confirmIdx = curr.idx + 1;
              const confirmed = confirmIdx <= last && fc[confirmIdx] < fc[curr.idx];
              if (confirmed && last - confirmIdx <= 2) {
                const stopDist = Math.max(20, Math.round((fh[curr.idx] - fl[curr.idx]) * 1.5));
                const rsiDelta = (prev.rsi - curr.rsi).toFixed(1);
                // FIXED 2026-07-17: see the matching RSI_DIV_BULLISH comment above — same fabricated-
                // stat bug, same fix (RSI_DIV_BEARISH also has zero fired trades in active_setups).
                const _rsiBearStats = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._setupStats?.RSI_DIV_BEARISH;
                rsiDivSetup = {
                  type: 'RSI_DIV_BEARISH',
                  direction: 'SHORT',
                  entry: currentPrice,
                  stop: currentPrice + stopDist,
                  target: t1Guard('SHORT', currentPrice, currentPrice - stopDist * 2),
                  targetLabel: '2R Target',
                  description: `15min RSI BEARISH divergence CONFIRMED. Price made higher high (${Math.round(curr.price)} vs ${Math.round(prev.price)}) but RSI made lower high (${curr.rsi.toFixed(0)} vs ${prev.rsi.toFixed(0)}, Δ-${rsiDelta}). Confirmation bar closed lower — buying exhaustion confirmed. WR with confirmation: ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('RSI_DIV_BEARISH') ?? 'not yet calibrated'}. Scalp short — hold 2-3 bars (30-45min) max. Take profit at value area midpoint or 2R.`,
                  history: (_rsiBearStats && _rsiBearStats.n >= 20)
                    ? { winRate: _rsiBearStats.wr, occurrences: _rsiBearStats.n, avgPnl: _rsiBearStats.ev, t1HitRate: _rsiBearStats.wr }
                    : { winRate: null, occurrences: null, avgPnl: null, t1HitRate: null },
                };
              }
            }
          }
        }
      }

      // ── Pre-fetch: overnight reads + prior setups (needed BEFORE level fade section) ─────
      // isS2DoubleCounter, isOvernightAligned, sizeMultiplier all reference these.
      // Previously defined at line ~4392 — caused silent TDZ ReferenceError on every level
      // fade call. Outer try{} at line 2545 caught it; fades appeared to work but sizeMultiplier
      // and isS2DoubleCounter suppression were both non-functional. Fixed 2026-07-05.
      // Batched 2026-07-15 — these 7 queries only depend on todayET (or nothing at
      // all, for the two bar-derived ones below), none on each other's results, but
      // were awaited one at a time. Profiling confirmed this exact section
      // ("Pre-fetch: overnight reads + prior setups") as the single dominant
      // contributor to /api/acd/setup-detection's remaining latency (1.8-6.7s of a
      // ~9-15s total, see docs/OPEN_THREADS.md) — collapsed into one Promise.all,
      // same pattern already applied to the Unified Level Fade Setups section above.
      const _cachedVwapSigmaPre = getCached(todayET, 'lfVwapSigma');
      const [_lfArRow, _lfPriorQ, _lfSameDirCountQ, _lfNl30Q, _lfVwapSigmaQ, _lfRecencyQ, _lfTurbRangeQ] = await Promise.all([
        query(`SELECT overnight_inventory, open_vs_prior_value FROM auction_reads WHERE trade_date=$1`, [todayET]).catch(() => ({ rows: [] })),
        // origin_status='ACTIVE' added 2026-07-27 (unify_sizemultiplier_into_validated_score) --
        // this drives lfConsecWins/lfConsecLosses, the win/loss-streak sizing factor (the largest
        // magnitude adjustments in the whole IIFE, up to +0.50/capped at 0.10). Predates the
        // origin_status column (written 2026-06-22, column added 2026-07-17) and was never
        // revisited. This is specifically about the TRADER'S OWN recent real trades (a
        // psychological/risk concept), so scoped to ACTIVE only -- SHADOW setups were never
        // shown to the user, so a SHADOW "loss" isn't something the user experienced either.
        query(`SELECT resolution FROM active_setups WHERE trade_date=$1 AND origin_status='ACTIVE' AND status='RESOLVED' ORDER BY fired_at DESC LIMIT 3`, [todayET]).catch(() => ({ rows: [] })),
        // origin_status IN ('ACTIVE','SHADOW') added 2026-07-27 -- unlike the streak query above,
        // "stacking" (how many same-direction fade attempts have occurred today) is a MARKET
        // STRUCTURE signal, not a personal-day one -- a SHADOW-origin touch is still a real,
        // live-price-triggered event (just suppressed from a full alert), so it legitimately
        // counts toward "how many real fades has this direction seen today." BACKFILL/UNKNOWN
        // (synthetic/historical) do not represent today's real market activity and are excluded.
        query(
          `SELECT CASE WHEN setup_type LIKE '%_LONG' THEN 'LONG' WHEN setup_type LIKE '%_SHORT' THEN 'SHORT' END AS direction,
                  COUNT(*) as cnt
           FROM active_setups WHERE trade_date=$1 AND origin_status IN ('ACTIVE','SHADOW') AND status IN ('ACTIVE','RESOLVED')
           GROUP BY 1`,
          [todayET]
        ).catch(() => ({ rows: [] })),
        query(`
          SELECT COALESCE(SUM(COALESCE(daily_score, 0)), 0)::int AS nl30
          FROM (SELECT daily_score FROM acd_daily_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 30) sub
        `, [todayET]).catch(() => ({ rows: [{ nl30: 0 }] })),
        _cachedVwapSigmaPre ? Promise.resolve(null) : query(`
          WITH svwap AS (
            SELECT close::float as c,
              SUM((COALESCE(ask_volume,0)+COALESCE(bid_volume,0))::float * close::float) OVER (PARTITION BY ts::date ORDER BY ts) /
              NULLIF(SUM((COALESCE(ask_volume,0)+COALESCE(bid_volume,0))::float) OVER (PARTITION BY ts::date ORDER BY ts), 0) AS vwap
            FROM price_bars_primary
            WHERE symbol='NQ'
              AND ts::date IN (SELECT DISTINCT ts::date FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1 ORDER BY ts::date DESC LIMIT 20)
              AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
          )
          SELECT AVG(ABS(c - vwap))::float as mean_dist, STDDEV(ABS(c - vwap))::float as std_dist
          FROM svwap WHERE vwap IS NOT NULL
        `, [todayET]).catch(() => ({ rows: [{}] })),
        // origin_status IN ('ACTIVE','SHADOW') added 2026-07-27 -- "level recency" (was this level
        // tested recently = proven defender, vs untested = risky) is about REAL market touches,
        // same reasoning as the stacking-count fix above. Without this, a level with dense
        // BACKFILL/UNKNOWN historical coverage would almost always show as "recently tested"
        // regardless of genuine recent activity.
        query(`
          SELECT
            REGEXP_REPLACE(setup_type, '_(LONG|SHORT)$', '') AS level_base,
            MAX(trade_date)::text AS last_date
          FROM active_setups
          WHERE trade_date >= $1::date - INTERVAL '21 days' AND trade_date < $1
            AND origin_status IN ('ACTIVE','SHADOW')
            AND status = 'RESOLVED'
          GROUP BY level_base
        `, [todayET]).catch(() => ({ rows: [] })),
        query(`
          SELECT AVG(daily_range)::float AS avg_first15_range
          FROM (
            SELECT ts::date AS dt, MAX(high) - MIN(low) AS daily_range
            FROM price_bars_primary
            WHERE symbol = 'NQ'
              AND ts::date IN (
                SELECT DISTINCT ts::date FROM price_bars_primary
                WHERE symbol = 'NQ' AND ts::date < $1
                ORDER BY ts::date DESC LIMIT 20
              )
              AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 584
            GROUP BY ts::date
          ) sub
        `, [todayET]).catch(() => ({ rows: [] })),
      ]);
      const _lfOvInv  = _lfArRow.rows[0]?.overnight_inventory;
      const _lfOvOpen = _lfArRow.rows[0]?.open_vs_prior_value;
      const isOvernightAligned = (dir) =>
        (dir === 'LONG'  && (_lfOvInv === 'SHORT_TRAPPED' || _lfOvOpen === 'ABOVE_VALUE')) ||
        (dir === 'SHORT' && (_lfOvInv === 'LONG_TRAPPED'  || _lfOvOpen === 'BELOW_VALUE'));
      const isOvernightCounter = (dir) =>
        (dir === 'LONG'  && (_lfOvInv === 'LONG_TRAPPED'  || _lfOvOpen === 'BELOW_VALUE')) ||
        (dir === 'SHORT' && (_lfOvInv === 'SHORT_TRAPPED' || _lfOvOpen === 'ABOVE_VALUE'));
      // S2 double-counter: BOTH overnight inventory AND open-vs-value disagree with fade direction.
      // Backtest: baseline 72.2% WR → S2 filter $8,225 (+$833). Only suppress when both agree.
      const isS2DoubleCounter = (dir) =>
        (dir === 'LONG'  && _lfOvInv === 'LONG_TRAPPED'  && _lfOvOpen === 'BELOW_VALUE') ||
        (dir === 'SHORT' && _lfOvInv === 'SHORT_TRAPPED' && _lfOvOpen === 'ABOVE_VALUE');
      // Prior completed setups — streak depth sizing.
      // Research 2026-07-05: 1×loss=47% WR, 2×loss=31.6%, 3+×loss=28.4%; 1×win=76.6%, 2×win=79.7%, 3+×win=87.8%
      const lfFirstOfDay = !_lfPriorQ.rows[0];
      let lfConsecLosses = 0, lfConsecWins = 0;
      for (const r of _lfPriorQ.rows) {
        if (r.resolution === 'STOP_HIT')   { if (lfConsecWins   === 0) lfConsecLosses++; else break; }
        else if (r.resolution === 'TARGET_HIT') { if (lfConsecLosses === 0) lfConsecWins++;  else break; }
        else break;
      }
      const lfPriorStop = lfConsecLosses >= 1;
      const lfPriorWin  = lfConsecWins  >= 1;
      // Stacking count: same-direction setups fired today (ACTIVE or RESOLVED).
      // Verified 2026-07-05: 1-6 setups = 80-86% WR solid; 7+ = 62.4% WR -$15.7 EV (N=1922) suppress.
      const _lfSameDirCounts = Object.fromEntries(_lfSameDirCountQ.rows.map(r => [r.direction, parseInt(r.cnt)]));
      // NL30: rolling 30-day sum of daily ACD scores — conditions fade edge by market regime.
      // Verified 2026-07-05 (N=229-429 per bucket): MILD trend = SHORT fades penalized (-$17 to -$19 EV);
      // STRONG regime boosts both extremes; prior-day only (< today) to avoid lookahead.
      const _lfNl30 = _lfNl30Q.rows[0]?.nl30 ?? 0;
      const _lfNl30Bucket = _lfNl30 > 15 ? 'STRONG_BULL' : _lfNl30 >= 6 ? 'MILD_BULL' :
        _lfNl30 < -15 ? 'STRONG_BEAR' : _lfNl30 <= -6 ? 'MILD_BEAR' : 'NEUTRAL';
      // VWAP at detection time — computed from today's RTH bars (ask_vol+bid_vol ≈ total volume).
      // Rolling σ of VWAP distances over last 20 sessions gives the dynamic threshold.
      // Verified 2026-07-06: far extended (>mean+σ) = 76.2% WR +$59.7 EV z=+2.95 N=600.
      const _lfVwapData = allRthBarsRow.rows.reduce((acc, b) => {
        const vol = (b.ask_vol || 0) + (b.bid_vol || 0);
        acc.pv += b.close * vol; acc.vol += vol; return acc;
      }, { pv: 0, vol: 0 });
      const _lfVwap = _lfVwapData.vol > 0 ? _lfVwapData.pv / _lfVwapData.vol : null;
      let _lfVwapMean = _cachedVwapSigmaPre?.mean ?? null;
      let _lfVwapStd  = _cachedVwapSigmaPre?.std  ?? null;
      if (_lfVwapMean == null && _lfVwapSigmaQ) {
        _lfVwapMean = _lfVwapSigmaQ.rows[0]?.mean_dist ?? null;
        _lfVwapStd  = _lfVwapSigmaQ.rows[0]?.std_dist  ?? null;
        if (_lfVwapMean != null) setCached(todayET, 'lfVwapSigma', { mean: _lfVwapMean, std: _lfVwapStd });
      }
      // Level recency: last test date per level base name (past 21 days).
      // Research 2026-07-05: 1-2d ago = 65.9% WR $22 EV, 21d+ fresh = 60.5% WR -$5 EV.
      const lfRecencyMap = Object.fromEntries(_lfRecencyQ.rows.map(r => [r.level_base, r.last_date]));

      // TURBULENT intraday range confirmation: first-15-min range vs rolling 20-day average.
      // Research 2026-07-05: range >= avg → 79.99% WR N=39 (56% of TURBULENT days pass);
      //                       range < avg → 67.67% WR N=21 (44% false calls).
      // Threshold is the rolling mean itself — no hardcoded number.
      const _lfAvgFirst15Range = _lfTurbRangeQ.rows[0]?.avg_first15_range ?? null;
      const _lfFirst15Bars = allRthBarsRow.rows.filter(b => b.et_min >= 570 && b.et_min <= 584);
      const _lfFirst15Range = _lfFirst15Bars.length >= 3
        ? Math.max(..._lfFirst15Bars.map(b => b.high)) - Math.min(..._lfFirst15Bars.map(b => b.low))
        : null;
      // turbConfirmed = true once 9:45 has passed and range >= rolling mean
      const turbConfirmed = _lfFirst15Range != null && _lfAvgFirst15Range != null && _lfFirst15Range >= _lfAvgFirst15Range;

      // OR Expansion Bias: no A Up/A Down breach yet = untouched liquidity reinforces fade.
      // BALANCE: 78.88% WR N=161 (+5.77pp lift, z=2.03). TURBULENT: 96.15% WR N=26 (+20.97pp, z=2.77).
      // aUpFired/aDownFired are written to DB progressively each poll — real-time, not lookahead.
      const _lfOrExpanded = aUpFired || aDownFired;

      // Regime Persistence: prior 2 days same day_type = 3-day streak. Only meaningful on TURBULENT.
      // TURBULENT × streak: 84.08% WR N=157 (+8.89pp, z=3.45). BALANCE: flat (+0.20pp, skip).
      // NL30 nuance: streak negative in NEUTRAL (-3.13pp) — skip when NL30 is ranging.
      const _lfRegimePersistQ = dtClass === 'TURBULENT' && _lfNl30Bucket !== 'NEUTRAL'
        ? await query(`
            SELECT COUNT(*) AS streak_days
            FROM (SELECT day_type FROM acd_daily_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 2) sub
            WHERE day_type = $2
          `, [todayET, dtClass]).catch(() => ({ rows: [{ streak_days: '0' }] }))
        : { rows: [{ streak_days: '0' }] };
      const _lfRegimePersist = parseInt(_lfRegimePersistQ.rows[0]?.streak_days ?? '0') >= 2;

      // Overnight gap: pre-9:30 range vs rolling 60-session p33.
      // Opus audit 2026-07-07: small gaps (< p33) = 60.8% WR, -$27 EV (N=332) — quiet consolidation kills fades.
      // Threshold is rolling p33 (no hardcoded number per CLAUDE.md hard rule).
      const _lfOnGapQ = await query(`
        WITH today_on AS (
          SELECT MAX(high)::float - MIN(low)::float AS on_range
          FROM price_bars_primary
          WHERE symbol='NQ' AND ts::date=$1
            AND (EXTRACT(hour FROM ts AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York') * 60
                + EXTRACT(minute FROM ts AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')) < 570
        ),
        prior_on AS (
          SELECT MAX(high) - MIN(low) AS on_range
          FROM price_bars_primary
          WHERE symbol='NQ'
            AND ts::date IN (
              SELECT DISTINCT ts::date FROM price_bars_primary
              WHERE symbol='NQ' AND ts::date < $1
              ORDER BY ts::date DESC LIMIT 60
            )
            AND (EXTRACT(hour FROM ts AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York') * 60
                + EXTRACT(minute FROM ts AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')) < 570
          GROUP BY ts::date
        )
        SELECT
          (SELECT on_range FROM today_on) AS today_on_range,
          PERCENTILE_CONT(0.33) WITHIN GROUP (ORDER BY on_range) AS p33_60d
        FROM prior_on
      `, [todayET]).catch(() => ({ rows: [{}] }));
      const _lfTodayOnRange = _lfOnGapQ.rows[0]?.today_on_range ?? null;
      const _lfOnRangeP33   = _lfOnGapQ.rows[0]?.p33_60d ?? null;
      const _lfSmallGap = _lfTodayOnRange != null && _lfOnRangeP33 != null && _lfTodayOnRange < _lfOnRangeP33;

      // Session delta: cumulative (ask_vol - bid_vol) from RTH open to now.
      // Backtest 2026-07-08 (N=4,354 fades): neutral |Δ|<p25 = 57.9% WR -$3 EV; high |Δ|>p75 = 69.3% WR +$28 EV.
      // Against-flow is slightly better than with-flow overall (overextension reversal logic) — only magnitude matters.
      const _lfSessionDelta = allRthBarsRow.rows.reduce((sum, b) => sum + ((b.ask_vol || 0) - (b.bid_vol || 0)), 0);
      const _lfAbsDelta = Math.abs(_lfSessionDelta);
      const _cachedDeltaPerc = getCached(todayET, 'lfDeltaPerc');
      let _lfDeltaP25 = _cachedDeltaPerc?.p25 ?? null;
      let _lfDeltaP75 = _cachedDeltaPerc?.p75 ?? null;
      if (_lfDeltaP25 == null) {
        const _lfDeltaPercQ = await query(`
          WITH session_deltas AS (
            SELECT ts::date AS bar_date,
              SUM(COALESCE(ask_volume,0) - COALESCE(bid_volume,0)) AS net_delta
            FROM price_bars_primary
            WHERE symbol='NQ'
              AND ts::date IN (
                SELECT DISTINCT ts::date FROM price_bars_primary
                WHERE symbol='NQ' AND ts::date < $1
                ORDER BY ts::date DESC LIMIT 60
              )
              AND EXTRACT(hour FROM ts AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')*60
                + EXTRACT(minute FROM ts AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York') BETWEEN 570 AND 959
            GROUP BY ts::date
          )
          SELECT
            PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY ABS(net_delta)) AS p25,
            PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY ABS(net_delta)) AS p75
          FROM session_deltas
        `, [todayET]).catch(() => ({ rows: [{}] }));
        _lfDeltaP25 = _lfDeltaPercQ.rows[0]?.p25 ?? null;
        _lfDeltaP75 = _lfDeltaPercQ.rows[0]?.p75 ?? null;
        if (_lfDeltaP25 != null) setCached(todayET, 'lfDeltaPerc', { p25: _lfDeltaP25, p75: _lfDeltaP75 });
      }
      const _lfDeltaNeutral = _lfDeltaP25 != null && _lfAbsDelta < _lfDeltaP25;
      const _lfDeltaHigh    = _lfDeltaP75 != null && _lfAbsDelta > _lfDeltaP75;

      // ── Pulse score pre-computation (MC-calibrated 2026-07-08) ───────────────
      // Parameters: vol≥2.5σ (3 bars), delta 15-bar direction-aware, struct 8-bar strict, rot≤1 full session
      // Score distribution: 0→58.8% WR, 1→65.4%, 2→71.8%, 3→78.8% (N=80 CI=[73.8%,85%])
      const _pulseBars = allRthBarsRow.rows;

      // Per-minute vol baseline (90-day, cached per day)
      let _pulseVolBaseline = getCached(todayET, 'pulseVolBaseline');
      if (!_pulseVolBaseline) {
        const _pvbQ = await query(`
          SELECT (EXTRACT(hour FROM ts AT TIME ZONE 'America/New_York')*60 +
                  EXTRACT(minute FROM ts AT TIME ZONE 'America/New_York'))::int AS et_min,
                 AVG((COALESCE(ask_volume,0)+COALESCE(bid_volume,0))::float) AS avg_vol,
                 STDDEV((COALESCE(ask_volume,0)+COALESCE(bid_volume,0))::float) AS std_vol
          FROM price_bars_primary
          WHERE symbol='NQ'
            AND ts::date >= $1::date - 90 AND ts::date < $1
            AND (EXTRACT(hour FROM ts AT TIME ZONE 'America/New_York')*60 +
                 EXTRACT(minute FROM ts AT TIME ZONE 'America/New_York')) BETWEEN 570 AND 959
          GROUP BY 1
        `, [todayET]).catch(() => ({ rows: [] }));
        _pulseVolBaseline = {};
        for (const r of _pvbQ.rows) _pulseVolBaseline[r.et_min] = { avg: +r.avg_vol, std: +(r.std_vol || 1) };
        if (Object.keys(_pulseVolBaseline).length > 0) setCached(todayET, 'pulseVolBaseline', _pulseVolBaseline);
      }

      // Vol sigma: max sigma across last 3 bars
      const _pulseLast3 = _pulseBars.slice(-3);
      let _pulseVolSigma = null;
      for (const b of _pulseLast3) {
        const bl = _pulseVolBaseline?.[b.et_min];
        if (!bl || bl.avg <= 0) continue;
        const vol = (b.ask_vol || 0) + (b.bid_vol || 0);
        const sig = (vol - bl.avg) / bl.std;
        if (_pulseVolSigma == null || sig > _pulseVolSigma) _pulseVolSigma = sig;
      }
      const _pulseHighVol = _pulseVolSigma != null && _pulseVolSigma >= 2.5;

      // Delta 15-bar (direction computed per-setup inside IIFE)
      const _pulseDelta15 = _pulseBars.slice(-15).reduce((s, b) => s + ((b.ask_vol || 0) - (b.bid_vol || 0)), 0);

      // Micro structure: last 8 bars strict higher-lows OR lower-highs
      const _pulseStruct = (() => {
        const last8 = _pulseBars.slice(-8);
        if (last8.length < 2) return false;
        const hl = last8.every((b, i) => i === 0 || b.low  >= last8[i - 1].low);
        const lh = last8.every((b, i) => i === 0 || b.high <= last8[i - 1].high);
        return hl || lh;
      })();

      // Rotations ≤1: full session close sign-changes (rarely fires — tiebreaker)
      let _pulseRots = 0;
      for (let i = 2; i < _pulseBars.length; i++) {
        const d1 = Math.sign(_pulseBars[i].close   - _pulseBars[i - 1].close);
        const d0 = Math.sign(_pulseBars[i - 1].close - _pulseBars[i - 2].close);
        if (d1 !== 0 && d0 !== 0 && d1 !== d0) _pulseRots++;
      }
      const _pulseLowRots = _pulseRots <= 1;

      // Cascade breaker: detect trend-running-over-fades regime (Opus audit 2026-07-07).
      // Worst 5 days each had 17–18 STOP_HITs across 20–29 setups — all different levels cascading.
      // Distribution (N=1564 stop-out events): normal avg=1.84 prior same-day stops in 60min, std=2.16.
      // Worst days: avg=5.89. Threshold = mean + σ = 4 total distinct stops → trigger at ≥3 to catch early.
      // Window = 45 min (tighter than 60 to detect cascades sooner). Never fires on best days (max 6 stops total).
      const _cascadeQ = await query(`
        SELECT COUNT(DISTINCT setup_type)::int AS stop_count
        FROM active_setups
        WHERE trade_date = $1
          AND resolution = 'STOP_HIT'
          AND resolved_at >= NOW() - INTERVAL '45 minutes'
      `, [todayET]).catch(() => ({ rows: [{ stop_count: 0 }] }));
      const _cascadeStopCount = _cascadeQ.rows[0]?.stop_count ?? 0;
      const _cascadeThreshold = 3; // data-derived: normal p75 = 3 "prior" stops ≈ 4 total; -1 for early trigger
      const cascadeBreaker = {
        active: _cascadeStopCount >= _cascadeThreshold,
        stopCount: _cascadeStopCount,
        threshold: _cascadeThreshold,
        windowMins: 45,
      };

      // ── Level Scalp detection ────────────────────────────────────────────
      // Backtested 90 days of 1-min bars. These replace EMA_SNAPBACK (0% WR, removed).
      let levelScalpSetup = null;
      let vwapMagnetSetup = null;
      let globexVwapMagnetRTH = null;
      let globexVwapFadeRTH = null;
      let vwapReclaimShortSetup = null;
      // Early-touch backfill: levels touched before a previous poll could catch them
      // (touched-and-already-moved-on between polls) but never got a live banner.
      // Recorded SHADOW-only for stats integrity — never fires a live alert, since the
      // entry window has already passed by the time we can detect it. Found 2026-06-30.
      let backfilledTouches = [];
      if (currentPrice && allRthBarsRow.rows.length >= 3) {
        const etMinNow = allRthBarsRow.rows[allRthBarsRow.rows.length - 1].et_min;
        const last5 = allRthBarsRow.rows.slice(-6, -1);

        // Compute VWAP early for magnet detection
        let earlyVwap = null;
        if (allRthBarsRow.rows.length > 0) {
          const mappedBars = allRthBarsRow.rows.map(b => ({ ...b, volume: (b.ask_vol || 0) + (b.bid_vol || 0) }));
          const vwapSeries = computeRunningVwapSeries(mappedBars);
          earlyVwap = vwapSeries[vwapSeries.length - 1];
        }

        // ── VWAP Magnet: σ-based trigger — fires when price ≥1.5σ from RTH VWAP ──
        // σ = rolling 30-session std of (session_close - RTH_VWAP) from session_analysis.
        // Consistent with trade-alerts dailyVwapSigma (same source, same threshold).
        // T1/stop are data-derived (OPTIMAL_STOP calibration, see below) since 2026-08-02 —
        // runner = min(vwapDist*0.5, 100pt), fallback T1=20pt/stop=30pt if uncalibrated.
        if (earlyVwap) {
          const vwapStdData = await getTrailingVwapStd(todayET, 30);
          const vwapThreshold = vwapStdData.threshold;
          const vwapDist = currentPrice - earlyVwap;
          const vwapSigma = vwapStdData.std > 0 ? vwapDist / vwapStdData.std : 0;
          if (Math.abs(vwapDist) >= vwapThreshold) {
            const isLong = vwapDist < 0;
            const t2Dist = Math.min(Math.round(Math.abs(vwapDist) * 0.5), 100);
            // FIXED 2026-07-17: hand-typed history{winRate:0.62, occurrences:460, avgPnl:24} — real
            // SETUP_STATUS data is THIN_N with N=2-3, nowhere close to 460. Same "never fabricate a
            // stat" violation as the other setups fixed this session (docs/OPEN_THREADS.md).
            const _vwapMagType = isLong ? 'VWAP_MAGNET_LONG' : 'VWAP_MAGNET_SHORT';
            const _vwapMagStats = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._setupStats?.[_vwapMagType];
            // FIXED 2026-08-02 (OPEN_DECISION vwap_magnet_hardcoded_stop_target_never_calibrated):
            // stop/target were hardcoded 30/20, never reading OPTIMAL_STOP -- a live No-Static-
            // Thresholds violation on this system's highest-volume setup family. Mirrors the exact
            // getCached(...)?._opt?.[type] pattern already used everywhere else in this file
            // (e.g. OPEN_DRIVE_LONG ~line 4436), same fallback numbers as before if uncalibrated.
            const _vwapMagOpt = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._opt?.[_vwapMagType];
            const _vwapStopPts = _vwapMagOpt?.stop ?? 30;
            const _vwapT1Pts = _vwapMagOpt?.target ?? 20;
            vwapMagnetSetup = {
              type: _vwapMagType,
              direction: isLong ? 'LONG' : 'SHORT',
              entry: currentPrice,
              stop: isLong ? currentPrice - _vwapStopPts : currentPrice + _vwapStopPts,
              target: isLong ? currentPrice + _vwapT1Pts : currentPrice - _vwapT1Pts,
              targetLabel: `T1: ${_vwapT1Pts}pt (half off) · Runner: ${t2Dist}pt toward VWAP`,
              description: `Price ${Math.round(Math.abs(vwapDist))}pt (${vwapSigma > 0 ? '+' : ''}${vwapSigma.toFixed(1)}σ) from VWAP (${Math.round(earlyVwap)}). Threshold: ${vwapThreshold}pt (1.5σ = ${Math.round(vwapStdData.std)}pt std). Scale out: half at ${_vwapT1Pts}pt, runner to ${t2Dist}pt (50% of dist, max 100pt). Breakeven stop after T1.\n\nEDGE: ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.(_vwapMagType) ?? 'not yet calibrated'} overall.`,
              history: (_vwapMagStats && _vwapMagStats.n >= 20)
                ? { winRate: _vwapMagStats.wr, occurrences: _vwapMagStats.n, avgPnl: _vwapMagStats.ev, t1HitRate: _vwapMagStats.wr }
                : { winRate: null, occurrences: null, avgPnl: null, t1HitRate: null },
            };
          }
        }

        // ── VWAP Reclaim-and-Hold, SHORT only — SHADOW-only, 2026-08-04 ──────────
        // docs/VWAP_RECLAIM_HOLD_SPEC.md: price crosses developing RTH VWAP and holds the
        // SHORT side for 2 consecutive 5-min bar closes (not an immediate snapback) ->
        // trend-continuation bet, trade AWAY from VWAP (the opposite bet from RTH_VWAP_FADE
        // just above/below, which bets reversion TOWARD VWAP). K=2 SHORT is the ONLY cell
        // that survived Phase 1's full audit (N=919, EV=$5.96/trade backtest, rigor-clean
        // across all 3 chronological thirds, beats a properly independent control, passes
        // computeReplication() against the other 5 swept cells) -- LONG and every other K
        // value failed, and the Globex/overnight window failed entirely (does not transfer
        // -- see the spec's Globex results section). RTH only, SHORT only, by design.
        //
        // LIVE SIMPLIFICATION, not yet the exact backtested mechanism: Phase 1's stop was
        // STRUCTURAL (price closes a 5-min bar back on the wrong side of VWAP) -- building
        // that live would need a genuinely new bar-by-bar VWAP-tracking resolution path
        // inside resolveSetupsByPrice(), real additional risk to that shared, already
        // heavily-loaded function (it already does double duty for STOP_HIT/TARGET_HIT/
        // TRAIL). For this first SHADOW-only version, stop/target use the same fixed-point
        // mechanism every other setup already uses, with the point distances taken directly
        // from Phase 1's own real data (p75 MAE of the K=2 SHORT candidate population =
        // 44.8pt, rounded to 45; target = 70pt, the swept value) rather than a guessed
        // number -- but this is NOT yet the same stop mechanism Phase 1 validated, and
        // hasn't been re-tested under it. Flagged: OPEN_DECISION
        // vwap_reclaim_short_structural_stop_not_yet_built. Once real forward N>=20
        // accumulates on this fixed-stop version, update_optimal_stops.mjs's generic sweep
        // picks it up automatically like any other setup_type (liveStats._opt lookup below).
        // (Declared at the outer scope above, same escape-the-block pattern vwapMagnetSetup
        // already uses, so shadowCandidates far below can read it.)
        if (earlyVwap && allRthBarsRow.rows.length >= 15) {
          const RECLAIM_K = 2;
          // Roll today's RTH 1-min bars into 5-min bars -- same bucketing convention as
          // scripts/backtest_vwap_reclaim_hold_phase1.mjs's build5MinBars() (RTH_START=570).
          const bars5m = [];
          let cur5 = null;
          for (const b of allRthBarsRow.rows) {
            const intervalStart = 570 + Math.floor((b.et_min - 570) / 5) * 5;
            if (!cur5 || cur5.mod !== intervalStart) {
              if (cur5) bars5m.push(cur5);
              cur5 = { mod: intervalStart, high: b.high, low: b.low, close: b.close, volume: (b.ask_vol || 0) + (b.bid_vol || 0) };
            } else {
              cur5.high = Math.max(cur5.high, b.high);
              cur5.low = Math.min(cur5.low, b.low);
              cur5.close = b.close;
              cur5.volume += (b.ask_vol || 0) + (b.bid_vol || 0);
            }
          }
          if (cur5) bars5m.push(cur5);
          if (bars5m.length >= RECLAIM_K + 1) {
            const vwapSeries = computeRunningVwapSeries(bars5m);
            const last = bars5m.length - 1;
            const isBelow = (i) => vwapSeries[i] != null && bars5m[i].close < vwapSeries[i];
            const isAbove = (i) => vwapSeries[i] != null && bars5m[i].close > vwapSeries[i];
            const heldShort = isBelow(last) && isBelow(last - 1);
            const crossedFromAbove = isAbove(last - RECLAIM_K);
            if (heldShort && crossedFromAbove) {
              // Mutual-exclusion gate vs RTH_VWAP_FADE (docs/VWAP_RECLAIM_HOLD_SPEC.md
              // must-fix #2, DeepSeek finding, HIGH severity): RTH_VWAP_FADE fires on ANY
              // close-range VWAP touch within the standard 15pt band (nearLevels' own
              // convention, acd.js ~line 6142) and bets the OPPOSITE direction (reversion
              // toward VWAP). Never insert two directly-contradicting rows for the same
              // VWAP touch on the same poll.
              const nearVwapForFade = Math.abs(currentPrice - earlyVwap) <= 15;
              if (!nearVwapForFade) {
                const _reclaimOpt = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._opt?.VWAP_RECLAIM_SHORT;
                const _reclaimStopPts = _reclaimOpt?.stop ?? 45;
                const _reclaimTargetPts = _reclaimOpt?.target ?? 70;
                vwapReclaimShortSetup = {
                  type: 'VWAP_RECLAIM_SHORT',
                  direction: 'SHORT',
                  entry: currentPrice,
                  stop: currentPrice + _reclaimStopPts,
                  target: currentPrice - _reclaimTargetPts,
                  targetLabel: `T1: ${_reclaimTargetPts}pt (VWAP reclaim-hold continuation)`,
                  description: `Price crossed below developing VWAP (${Math.round(earlyVwap)}) and held for 2 consecutive 5-min bar closes -- a trend-continuation bet AWAY from VWAP, not a fade toward it. SHADOW-only Phase 1 finding (N=919 backtest, EV=$5.96/trade, rigor-clean, beats an independent control). Stop/target use a fixed-point approximation of the backtest's structural VWAP-cross-back stop, not yet the exact validated mechanism -- see docs/VWAP_RECLAIM_HOLD_SPEC.md.`,
                };
              }
            }
          }
        }

        // ── 24hr/Globex VWAP relevance during RTH ──────────────────────────────────
        // The 24hr VWAP doesn't stop mattering once RTH opens -- it's a real, continuously
        // relevant level all day, not just overnight. Added 2026-07-28 per direct user
        // pushback ("you know the 24hr vwap is relevant during RTH as well too right?")
        // after GLOBEX_VWAP_MAGNET/GLOBEX_VWAP_FADE were found to be wired ONLY into
        // detectGlobexSetup(), which the route handler only calls when `inGlobex` (6PM-
        // 8:30AM ET, acd.js ~line 3650) -- meaning a 24hr-VWAP touch during RTH could never
        // be caught live, even though the historical BACKFILL (getGlobex24hrBars' window
        // spans through RTH, hour<17) already counted RTH-hour touches. That mismatch is
        // exactly the "backfill population must match what the live poller actually fires
        // on" bug class (CLAUDE.md's New Setup Type checklist, item 10) -- fixed here by
        // making the RTH path ALSO check the 24hr VWAP, reusing the SAME setup_type names
        // (GLOBEX_VWAP_MAGNET_LONG/SHORT, GLOBEX_VWAP_FADE_LONG/SHORT) rather than inventing
        // RTH-specific ones -- matches the existing PD_VAH/PD_VAL/PD_POC precedent, which
        // already fire from both detectGlobexSetup() AND the RTH keepLevelsAll path under
        // one shared name. Reuses the exact same shared functions as the Globex-fired
        // version (computeRunningVwapSeries, getTrailing24hrVwapStd, getGlobex24hrBars) --
        // no independent reimplementation. SHADOW-only (shadowCandidates), same minimal
        // sizing convention (no sizeMultiplier stack) as every other Globex-fired VWAP
        // candidate, since none of that RTH-only machinery has ever been validated for this
        // family and it fires through a fundamentally different (moving-level) mechanism.
        // (globexVwapMagnetRTH/globexVwapFadeRTH declared with `let` at the outer scope
        // above, same escape-the-block pattern vwapMagnetSetup already uses, so shadowCandidates far below can read them.)
        {
          const vwap24Bars = await getGlobex24hrBars(todayET);
          if (vwap24Bars.length > 50) {
            const vwap24Series = computeRunningVwapSeries(vwap24Bars);
            const vwap24Now = vwap24Series[vwap24Series.length - 1];
            if (vwap24Now != null) {
              const dist24 = currentPrice - vwap24Now;
              const std24 = await getTrailing24hrVwapStd(todayET, 30);
              // FIXED 2026-08-02 (OPEN_DECISION vwap_magnet_hardcoded_stop_target_never_calibrated):
              // both branches hardcoded stop/target (30/20, 90/40), never reading OPTIMAL_STOP --
              // the RTH-fired copy of these setups, unlike detectGlobexSetup()'s real Globex-hours
              // path (~line 1023/1053, widerOptMap[type]?.stop ?? fallback), which was already
              // correctly wired. Same fallback numbers preserved if calibration is unavailable.
              const _rthGlobexOpt = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._opt;
              if (Math.abs(dist24) >= std24.threshold) {
                const isLong = dist24 < 0;
                const type = isLong ? 'GLOBEX_VWAP_MAGNET_LONG' : 'GLOBEX_VWAP_MAGNET_SHORT';
                const stopPts = _rthGlobexOpt?.[type]?.stop ?? 30;
                const t1Pts = _rthGlobexOpt?.[type]?.target ?? 20;
                globexVwapMagnetRTH = {
                  type, direction: isLong ? 'LONG' : 'SHORT', entry: currentPrice,
                  stop: isLong ? currentPrice - stopPts : currentPrice + stopPts,
                  target: isLong ? currentPrice + t1Pts : currentPrice - t1Pts,
                  targetLabel: `T1: ${t1Pts}pt (24hr VWAP magnet, fired during RTH)`,
                };
              } else if (Math.abs(dist24) <= 15) {
                const isLong = currentPrice < vwap24Now; // matches detectGlobexSetup's pocDir-style convention
                const type = isLong ? 'GLOBEX_VWAP_FADE_LONG' : 'GLOBEX_VWAP_FADE_SHORT';
                const stopPts = _rthGlobexOpt?.[type]?.stop ?? 90;
                const t1Pts = _rthGlobexOpt?.[type]?.target ?? 40;
                globexVwapFadeRTH = {
                  type, direction: isLong ? 'LONG' : 'SHORT', entry: currentPrice,
                  stop: isLong ? currentPrice - stopPts : currentPrice + stopPts,
                  target: isLong ? currentPrice + t1Pts : currentPrice - t1Pts,
                  targetLabel: `T1: ${t1Pts}pt (24hr VWAP fade, fired during RTH)`,
                };
              }
            }
          }
        }

        // ── Unified Level Fade Setups ──
        // All KEEP levels from the system backtest.
        // RTH-wide detection (9:30 AM – 4:00 PM). First touch only (tracked via active_setups dedup).
        // Stats from 180-day system backtest (originally AM-only, now extended to full RTH).
        // Monday gate: wait for IB close (10:30 ET) before firing level fades.
        const isMonday = new Date(todayET + 'T12:00:00').getDay() === 1;
        const mondayGate = isMonday ? etMinNow >= 630 : true; // Mondays: wait for IB close (10:30)
        if (last5.length >= 3 && etMinNow < 960 && mondayGate) {
          const approachDir = last5[0].close < currentPrice ? 'FROM_BELOW' : 'FROM_ABOVE';
          // Fallback stop/target — only used when no OPTIMAL_STOP row exists AND no mae_p75 from level data.
          // Per-setup-type values are loaded from performance_audit via liveStats._opt[type].
          const STOP = 90;   // Fallback — only fires when _opt[type] is null AND lv.mae_p75 is null
          const TARGET = 40; // Fallback — only fires when _opt[type] is null AND lv.mfe is null

          // Compute rolling composite levels
          // Batched 2026-07-15 — these 7 lookups only depend on todayET/etMinNow, none
          // on each other's results, but were awaited one at a time (each in its own
          // try/catch). Confirmed via server-side profiling this section was a real
          // contributor to /api/acd/setup-detection's ~8-10s per-call cost (see
          // docs/OPEN_THREADS.md). Collapsed into one Promise.all; per-query .catch()
          // preserves the exact original fault-isolation (one failing leaves only its
          // own variable null, same as before). The two cache-backed ones (lpQ, poc2Q)
          // skip their query entirely on a cache hit, matching antigravityEdges.js's
          // existing `isCached ? Promise.resolve(...) : query(...)` convention.
          const cachedLP = getCached(todayET, 'lpAll');
          const cached2DPOC = getCached(todayET, '2dPOC');
          const [or5Q, pdIbQ, pdOrQ, ib10Q, ibTodayQ, or10Q, or15Q, or30Q, lpQ, poc2Q] = await Promise.all([
            query(`SELECT MAX(orh) as hi, MIN(orl) as lo FROM (SELECT or_high::float as orh, or_low::float as orl FROM acd_daily_log WHERE trade_date < $1 AND or_high IS NOT NULL ORDER BY trade_date DESC LIMIT 5) t`, [todayET]).catch(() => ({ rows: [] })),
            // Bounded lower end (2026-07-15, matches the same fix applied elsewhere this
            // session) — an unbounded ts::date < $1 lookback in the inner MAX(ts::date)
            // subquery forces price_bars_primary's dedup view to consider far more history
            // than needed before it can find the max; 288ms -> 126ms, identical result.
            // BETWEEN 570 AND 629 (not 630) — found 2026-07-16 via Gemini + independently
            // verified: this fallback used to include bar 630 (10:30:00-10:30:59, one
            // minute PAST the true 60-min IB close), while scripts/compute_levels.js's
            // canonical PD_IB_MID (the value level_prices actually gets populated with)
            // correctly stops at 629. The mismatch meant this live fallback's pdIbMid could
            // differ slightly from the real level, and when level_prices.PD_IB_MID loaded
            // mid-session and superseded the fallback (lp.PD_IB_MID ?? pdIbMid, ~line 4825),
            // the level value could shift, firing what looked like a "new" setup with a
            // fake 50-60min retroactive detection lag (root cause of PD_IB_MID_FADE_SHORT's
            // recurring lag in docs/OPEN_THREADS.md's execution-quality thread).
            query(`SELECT MAX(high)::float as ibh, MIN(low)::float as ibl FROM price_bars_primary WHERE symbol='NQ' AND ts::date = (SELECT MAX(ts::date) FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1 AND ts::date >= $1::date - 30 AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 629) AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 629`, [todayET]).catch(() => ({ rows: [] })),
            query(`SELECT or_high::float, or_low::float FROM acd_daily_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 1`, [todayET]).catch(() => ({ rows: [] })),
            // Bounded lower end (2026-07-15, same fix as pdIbQ above) — unbounded
            // ts::date < $1 in the inner DISTINCT lookback forces a full historical scan
            // before the ORDER BY...LIMIT 10 can apply.
            query(`
              SELECT AVG((ibh + ibl) / 2.0)::float as mid FROM (
                SELECT MAX(high)::float as ibh, MIN(low)::float as ibl
                FROM price_bars_primary
                WHERE symbol='NQ' AND ts::date IN (
                  SELECT DISTINCT ts::date FROM price_bars_primary
                  WHERE symbol='NQ' AND ts::date < $1 AND ts::date >= $1::date - 30
                    AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 629
                  ORDER BY ts::date DESC LIMIT 10
                ) AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 629
                GROUP BY ts::date
              ) t
            `, [todayET]).catch(() => ({ rows: [] })),
            // Today's IB high/low — only valid after IB closes at 10:30 (etMinNow >= 630)
            etMinNow >= 630 ? query(`
              SELECT MAX(high)::float as ibh, MIN(low)::float as ibl
              FROM price_bars_primary
              WHERE symbol='NQ' AND ts::date = $1
                AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 629
            `, [todayET]).catch(() => ({ rows: [] })) : Promise.resolve({ rows: [] }),
            // Today's OR10/OR15/OR30 high/low, each self-gated to its own formation window
            // (bars 570..570+N-1, available at 570+N) — added 2026-08-12 alongside the OR5
            // rename, per docs/OR_LENGTH_SEASONALITY_SPEC.md. Mirrors ibTodayQ's pattern
            // exactly (real-time bar query, not level_prices, since these same-day-forming
            // windows may not have a level_prices row yet mid-session).
            etMinNow >= 580 ? query(`
              SELECT MAX(high)::float as orh, MIN(low)::float as orl
              FROM price_bars_primary
              WHERE symbol='NQ' AND ts::date = $1
                AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 579
            `, [todayET]).catch(() => ({ rows: [] })) : Promise.resolve({ rows: [] }),
            etMinNow >= 585 ? query(`
              SELECT MAX(high)::float as orh, MIN(low)::float as orl
              FROM price_bars_primary
              WHERE symbol='NQ' AND ts::date = $1
                AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 584
            `, [todayET]).catch(() => ({ rows: [] })) : Promise.resolve({ rows: [] }),
            etMinNow >= 600 ? query(`
              SELECT MAX(high)::float as orh, MIN(low)::float as orl
              FROM price_bars_primary
              WHERE symbol='NQ' AND ts::date = $1
                AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 599
            `, [todayET]).catch(() => ({ rows: [] })) : Promise.resolve({ rows: [] }),
            // All static levels from level_prices — single batch query, cached daily.
            // Replaces individual PW_HIGH/PW_LOW, PM_VAH, etc. queries.
            // OR5_HIGH/OR5_LOW/IB_HIGH/IB_LOW/IB_MID/OR5_MID stay as real-time bar values
            // because compute_levels.js may not have run yet during the live session.
            cachedLP ? Promise.resolve(null) : query(
              `SELECT level_name, price::float FROM level_prices WHERE trade_date=$1`,
              [todayET]
            ).catch(() => ({ rows: [] })),
            // 2-day composite POC (POC of combined last-2-session RTH volume profile)
            cached2DPOC !== undefined ? Promise.resolve(null) : (async () => {
              const last2Q = await query(`
                SELECT DISTINCT ts::date::text as d FROM price_bars_primary
                WHERE symbol='NQ' AND ts::date < $1
                  AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
                ORDER BY d DESC LIMIT 2
              `, [todayET]);
              const dates = last2Q.rows.map(r => r.d);
              if (dates.length < 2) return { rows: [] };
              const profile = await computeVolumeProfileForRange(query, { startDate: dates[dates.length - 1], endDate: dates[0] });
              return { rows: profile ? [{ poc: profile.poc }] : [] };
            })().catch(() => ({ rows: [] })),
          ]);

          let or5Mid = null;
          if (or5Q.rows[0]?.hi) or5Mid = (or5Q.rows[0].hi + or5Q.rows[0].lo) / 2;

          let pdIbMid = null;
          if (pdIbQ.rows[0]?.ibh) pdIbMid = (pdIbQ.rows[0].ibh + pdIbQ.rows[0].ibl) / 2;

          let pdOrMid = null;
          if (pdOrQ.rows[0]?.or_high) pdOrMid = (pdOrQ.rows[0].or_high + pdOrQ.rows[0].or_low) / 2;

          let ib10Mid = null;
          if (ib10Q.rows[0]?.mid) ib10Mid = ib10Q.rows[0].mid;

          // Today's IB high/low — only valid after IB closes at 10:30 (etMinNow >= 630)
          let ibHighToday = null, ibLowToday = null;
          if (etMinNow >= 630 && ibTodayQ.rows[0]?.ibh) {
            ibHighToday = ibTodayQ.rows[0].ibh;
            ibLowToday  = ibTodayQ.rows[0].ibl;
          }

          // Today's OR10/OR15/OR30 high/low/mid — each self-gated to its own window close.
          let or10High = null, or10Low = null, or10Mid = null;
          if (etMinNow >= 580 && or10Q.rows[0]?.orh != null) {
            or10High = or10Q.rows[0].orh; or10Low = or10Q.rows[0].orl; or10Mid = (or10High + or10Low) / 2;
          }
          let or15High = null, or15Low = null, or15Mid = null;
          if (etMinNow >= 585 && or15Q.rows[0]?.orh != null) {
            or15High = or15Q.rows[0].orh; or15Low = or15Q.rows[0].orl; or15Mid = (or15High + or15Low) / 2;
          }
          let or30High = null, or30Low = null, or30Mid = null;
          if (etMinNow >= 600 && or30Q.rows[0]?.orh != null) {
            or30High = or30Q.rows[0].orh; or30Low = or30Q.rows[0].orl; or30Mid = (or30High + or30Low) / 2;
          }

          // Today's IB mid (usable after IB closes at 10:30) and OR mid (usable once the
          // 5min OR itself forms, ~9:35 — not IB-dependent, see comment at the candidates entry below)
          const ibMid = (ibHighToday && ibLowToday) ? (ibHighToday + ibLowToday) / 2 : null;
          const orMid = (orH && orL) ? (orH + orL) / 2 : null;

          let lp = cachedLP || {};
          if (!cachedLP) {
            for (const r of lpQ.rows) lp[r.level_name] = r.price;
            setCached(todayET, 'lpAll', lp);
          }
          const pwHigh = lp.PW_HIGH ?? null;
          const pwLow  = lp.PW_LOW  ?? null;

          let twoDayPOC = null;
          if (cached2DPOC !== undefined) {
            twoDayPOC = cached2DPOC;
          } else {
            if (poc2Q.rows[0]) twoDayPOC = poc2Q.rows[0].poc;
            setCached(todayET, '2dPOC', twoDayPOC ?? null);
          }

          // All suppression is data-driven: SETUP_STATUS (global) + SETUP_STATUS_DOW (per-DOW).
          // Both loaded below into _suppressedSetups and _dowSuppressToday. Hardcoded lists removed 2026-07-09.

          // On TREND days after IB close: suppress counter-trend fades only.
          // Full-year analysis (Jul 2025–Jul 2026, N=484 TREND-day trades): SHORT fades on UP-trend
          // days lose -$17.5K/year; LONG fades on UP-trend days win 77-100% WR. Directional asymmetry
          // is driven by IB break: IB_BULLISH = UP-trend (suppress SHORT fades), IB_BEARISH = DOWN-trend
          // (suppress LONG fades). If IB direction unknown, suppress all fades to be safe.
          const isTrendCounterFade = (dir) => {
            if (dtClass !== 'TREND' || etMinNow < 630) return false;
            if (ibSetup?.type === 'IB_BULLISH') return dir === 'SHORT'; // up-trend: SHORT fades fail
            if (ibSetup?.type === 'IB_BEARISH') return dir === 'LONG';  // down-trend: LONG fades fail
            return true; // unknown trend direction: suppress all fades
          };
          // Fade in IB direction: IB broke UP + LONG fade = with momentum (elite on TURBULENT).
          // Used for ELITE_ZONE badge. Different from isTrendCounterFade: no day_type gate.
          const isWithIbDirection = (dir) => {
            if (!ibSetup) return false;
            return (ibSetup.type === 'IB_BULLISH' && dir === 'LONG') ||
                   (ibSetup.type === 'IB_BEARISH' && dir === 'SHORT');
          };

          // Live stats from performance_audit (UNIFIED_BACKTEST directional rows, latest run).
          // Cached with DAY_CACHE_TTL (was a bare 60s default until 2026-08-04) — backtests
          // run at most weekly so freshness is fine, and this whole populating block only runs
          // when etMinNow < 960 (4:00 PM ET). At 60s TTL, every getCached(todayET,'levelFadeStats')
          // read anywhere in this file (there are ~45 of them, including VWAP_MAGNET's stop/target
          // lookup and the ibSetup _suppressedSetups/_dowSuppressToday suppression check) would go
          // stale ~60s after the last pre-4pm poll and silently fall back to null/hardcoded defaults
          // for the rest of the 4-6PM window — confirmed live via VWAP_MAGNET_LONG/SHORT fires in
          // that window using the hardcoded 30pt/20pt fallback instead of the real calibrated
          // stop/target (VWAP_MAGNET_SHORT's OPTIMAL_STOP row said stop=29/target=25 the same day
          // several of its own SHADOW fires used stop=30/target=20 instead). The suppression-check
          // side of this was never a live-alert risk (inNewEntryDeadZone force-SHADOWs everything in
          // that exact same 4-6PM window regardless), but it did corrupt SHADOW forward-validation
          // data with the wrong stop/target baked into mae_points/mfe_points/actual_pnl. Since the
          // cache key already includes todayET, a day-long TTL can never leak into a different day.
          const cachedLevelStats = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL);
          let liveStats = cachedLevelStats;
          if (!liveStats) {
            // DOW as integer (0=Sun, 1=Mon...5=Fri, 6=Sat) for SETUP_STATUS_DOW lookup
            const todayDowInt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();
            const [statsQ, monQ, optStopQ, dtaQ, setupStatusQ, dowStatusQ, confluencePairQ, exhaustionCalibQ] = await Promise.all([
              query(`
                SELECT DISTINCT ON (signal_name) signal_name,
                  sample_size, win_rate::float, ev_per_trade::float,
                  p50_mae::float, p75_mae::float, p50_mfe::float, p75_mfe::float, notes
                FROM performance_audit
                WHERE signal_type = 'UNIFIED_BACKTEST'
                  AND window_days = 9999
                ORDER BY signal_name, run_date DESC
              `).catch(() => ({ rows: [] })),
              query(`
                SELECT DISTINCT ON (signal_name) signal_name,
                  sample_size, win_rate::float, ev_per_trade::float
                FROM performance_audit
                WHERE signal_type = 'MON_BACKTEST'
                ORDER BY signal_name, run_date DESC
              `).catch(() => ({ rows: [] })),
              // Directional optimal stops derived from active_setups MAE backfill.
              // Keyed by full setup_type (e.g. 'OR5_HIGH_FADE_SHORT'). Updated weekly.
              // FIXED 2026-08-03 (OPEN_DECISION live_opt_stop_reads_percentiles_not_ev_sweep):
              // this query read the raw p75_mae/p50_mfe percentile columns -- the ORIGINAL
              // calibration method from this query's creation (2026-07-05, commit a04b2fd) --
              // instead of the real EV-swept optimal_stop/optimal_target columns added 4 days
              // later (2026-07-09, de3e407, "EV-sweep targets") when update_optimal_stops.mjs
              // was upgraded. This query was never migrated, so the ENTIRE RTH level-fade
              // engine (keepLevelsAll, IB_BEARISH/BULLISH, OPEN_DRIVE, VALUE_AREA_RESPONSIVE,
              // BRACKET_BREAKOUT, FAILED_AUCTION, VWAP_MAGNET's RTH paths -- everything except
              // detectGlobexSetup(), whose separate widerOptMap query ~line 938 was already
              // correct) has been live-firing with raw MAE-p75/MFE-p50 stop/target instead of
              // the properly EV-optimized, thin-tail-guardrailed sweep result for ~1 month.
              // Confirmed live via test_invariants.mjs check [8] (real fired trades' stop
              // distances matched p75_mae, not optimal_stop) and independently verified via
              // Gemini before fixing: computeEvAtStopTarget() (imported, not reimplemented)
              // against every setup_type's real resolved trades showed 77 improve / 39 degrade
              // under the fix -- the degradations are NOT a reason to revert: they're mostly
              // low-N setups where the bug was accidentally bypassing sweepOptimalStopAndTarget's
              // thin-tail gate (a deliberate anti-overfitting guardrail) by feeding the live
              // engine a wide, in-sample-lucky percentile stop instead of the properly
              // constrained swept one. COALESCE fallback: 0 of 124 current OPTIMAL_STOP rows
              // have a NULL optimal_stop/optimal_target as of this fix, but kept as a safety
              // net for any future setup_type inserted before its first calibration run.
              query(`
                SELECT DISTINCT ON (signal_name) signal_name,
                  COALESCE(optimal_stop, p75_mae)::float AS opt_stop,
                  COALESCE(optimal_target, p50_mfe)::float AS opt_target
                FROM performance_audit
                WHERE signal_type = 'OPTIMAL_STOP'
                ORDER BY signal_name, run_date DESC
              `).catch(() => ({ rows: [] })),
              // Day-type × setup_type significance matrix.
              // Keyed by `{setup_type}-{day_type}`. Updated weekly by backtest_day_type_alpha.js.
              // Only non-NEUTRAL rows are actionable (N≥20, z≥1.5). Others stored for data completeness.
              query(`
                SELECT DISTINCT ON (signal_name) signal_name,
                  sample_size, win_rate::float, ev_per_trade::float, recommendation, notes
                FROM performance_audit
                WHERE signal_type = 'DAY_TYPE_ALPHA'
                ORDER BY signal_name, run_date DESC
              `).catch(() => ({ rows: [] })),
              // Setup-level suppression: N≥20, EV<-$5/trade. No WR gate — catches high-WR structural losers.
              // Promoted back when recent 90-day WR≥52% and EV>$0. Updated weekly by backtest_setup_status.mjs.
              // sample_size/win_rate/ev_per_trade added 2026-07-17 — this query previously only selected
              // recommendation, so every live "EDGE: ... WR (N=...)" description string had no real source
              // to read from and several were hand-typed literals instead (some for setup types with ZERO
              // real fired trades — a direct "never fabricate a stat" violation). See liveStats._setupStats
              // below and docs/OPEN_THREADS.md for the full incident writeup.
              query(`
                SELECT DISTINCT ON (signal_name) signal_name, recommendation,
                  sample_size, win_rate::float, ev_per_trade::float
                FROM performance_audit
                WHERE signal_type = 'SETUP_STATUS'
                ORDER BY signal_name, run_date DESC
              `).catch(() => ({ rows: [] })),
              // DOW-specific suppression: setups negative on one DOW but positive all-time.
              // signal_name = '{SETUP_TYPE}_DOW_{N}'. Only loads today's DOW rows.
              query(`
                SELECT DISTINCT ON (signal_name) signal_name, recommendation
                FROM performance_audit
                WHERE signal_type = 'SETUP_STATUS_DOW'
                  AND signal_name LIKE $1
                ORDER BY signal_name, run_date DESC
              `, [`%_DOW_${todayDowInt}`]).catch(() => ({ rows: [] })),
              // Real level-pair confluence bonus data, computed weekly (full ~1.7yr level_prices
              // history, not a rolling window) by backtest_confluence.js from a genuine bar
              // simulation (not active_setups BACKFILL data). recommendation='VALIDATED_PAIR' is
              // the single source of truth for "safe to use live" -- that script already requires
              // distinctDays>=20 (the real unit of independent evidence for two static levels'
              // convergence, not touch count -- see its PAIR_MIN_DISTINCT_DAYS comment), real
              // per-pair proximity calibration (excludes VWAP/DEV_POC developing-level pairs, a
              // confirmed confound), chronological stability, and positive EV, all in one place --
              // do not re-derive or duplicate that filter logic here.
              query(`
                SELECT DISTINCT ON (signal_name) signal_name, ev_per_trade::float, sample_size, recommendation
                FROM performance_audit
                WHERE signal_type = 'CONFLUENCE_AUDIT' AND signal_name LIKE 'PAIR:%'
                ORDER BY signal_name, run_date DESC
              `).catch(() => ({ rows: [] })),
              // Live volRatio/rangeRatio cutoffs for the confluence+exhaustion interaction
              // signal — informational only (see liveStats._exhaustionCutoffs below and
              // scripts/backtest_confluence_exhaustion_interaction.mjs). RESEARCH_CLAIM
              // confluence_exhaustion_interaction is still PROVISIONAL, not a validated
              // live edge — do not use this to gate sizing/suppression.
              query(`
                SELECT notes FROM performance_audit
                WHERE signal_type = 'EXHAUSTION_SIGNAL_CALIB' AND signal_name = 'LIVE_CUTOFFS'
                ORDER BY run_date DESC LIMIT 1
              `).catch(() => ({ rows: [] })),
            ]);
            liveStats = { _mon: {} };
            for (const r of statsQ.rows) {
              const isLong = r.signal_name.endsWith('_LONG');
              // CORRECTED 2026-07-18 (OPEN_DECISION keepLevels_ls_base_key_mismatch_selection_bug):
              // this line originally shipped with a comment claiming statsQ.signal_name values
              // look like PD_HIGH_FADE_LONG (requiring a _FADE strip here to match ls('PD_HIGH')
              // call sites below) and that ls() had always returned null as a result. Direct
              // re-verification against the live DB disproved that: statsQ reads signal_type=
              // 'UNIFIED_BACKTEST', and backtest_unified.js's own fadeLevels object (its source)
              // has used bare keys (PD_HIGH, CAM_R1, etc., no _FADE) since it was written
              // (624df42, 2026-07-01) -- signal_name has only ever been e.g. PD_HIGH_LONG here.
              // The _FADE-suffixed names that misled the original diagnosis (PD_HIGH_FADE_LONG)
              // belong to SETUP_STATUS/OPTIMAL_STOP/TOUCH_QUALITY, a different signal_type this
              // query never reads. So the pre-existing single-line regex was already correct for
              // real data, and ls() was never actually broken. The .replace(/_FADE$/, '') below
              // is a no-op against current data; left in only as harmless defense in case
              // backtest_unified.js's naming convention is ever unified with the live _FADE one.
              const base = r.signal_name.replace(/_(?:LONG|SHORT)$/, '').replace(/_FADE$/, '');
              if (!liveStats[base]) liveStats[base] = {};
              const dir = isLong ? 'long' : 'short';
              let parsedNotes = {};
              try { parsedNotes = JSON.parse(r.notes || '{}'); } catch (_) {}
              liveStats[base][dir] = {
                wr: r.win_rate, ev: r.ev_per_trade, n: r.sample_size,
                mae: r.p50_mae, mae_p75: r.p75_mae,
                mfe: r.p50_mfe, mfe_p75: r.p75_mfe,
                mae_p80w: parsedNotes.p80_mae_winners ?? null,
                tier: parsedNotes.confidence_tier ?? 'THIN',
              };
              // Recompute combined N-weighted WR/EV for backward compat
              const l = liveStats[base].long, s = liveStats[base].short;
              if (l && s) {
                const totalN = (l.n || 0) + (s.n || 0);
                liveStats[base].wr      = totalN ? (l.wr * l.n + s.wr * s.n) / totalN : null;
                liveStats[base].ev      = totalN ? (l.ev * l.n + s.ev * s.n) / totalN : null;
                liveStats[base].n       = totalN;
                liveStats[base].mae     = Math.min(l.mae ?? 999, s.mae ?? 999);
                liveStats[base].mae_p75 = Math.max(l.mae_p75 ?? 0, s.mae_p75 ?? 0);
                liveStats[base].mfe     = Math.max(l.mfe ?? 0, s.mfe ?? 0);
                liveStats[base].mfe_p75 = Math.max(l.mfe_p75 ?? 0, s.mfe_p75 ?? 0);
                liveStats[base].tier = (l.tier === 'CONFIDENT' && s.tier === 'CONFIDENT') ? 'CONFIDENT' : (l.tier === 'THIN' && s.tier === 'THIN') ? 'THIN' : 'MARGINAL';
              } else {
                const only = l || s;
                if (only) {
                  liveStats[base].wr      = only.wr;
                  liveStats[base].ev      = only.ev;
                  liveStats[base].n       = only.n;
                  liveStats[base].mae     = only.mae;
                  liveStats[base].mae_p75 = only.mae_p75;
                  liveStats[base].mfe     = only.mfe;
                  liveStats[base].mfe_p75 = only.mfe_p75;
                  liveStats[base].tier    = only.tier;
                }
              }
            }
            for (const r of monQ.rows) {
              // signal_name is e.g. 'PD_POC_MONDAY' — strip suffix to get base key
              const base = r.signal_name.replace(/_MONDAY$/, '');
              liveStats._mon[base] = { wr: r.win_rate, ev: r.ev_per_trade, n: r.sample_size };
            }
            // Directional optimal stops — keyed by full setup_type
            liveStats._opt = {};
            for (const r of optStopQ.rows) {
              liveStats._opt[r.signal_name] = {
                stop:   Math.round(r.opt_stop   ?? 65),
                target: Math.round(r.opt_target ?? 35),
              };
            }
            // Day-type significance matrix — keyed by `{setup_type}-{day_type}`
            // Populated weekly by backtest_day_type_alpha.js. Only actionable rows
            // (SIZE_UP/SIZE_DOWN/SUPPRESS) affect sizeMultiplier; NEUTRAL rows are ignored.
            liveStats._dta = {};
            for (const r of dtaQ.rows) {
              const dayType = ['BALANCE', 'TREND', 'TURBULENT'].find(dt => r.signal_name.endsWith(`_${dt}`));
              if (!dayType) continue;
              const setupType = r.signal_name.slice(0, -(dayType.length + 1));
              let parsedNotes = {};
              try { parsedNotes = JSON.parse(r.notes || '{}'); } catch (_) {}
              liveStats._dta[`${setupType}-${dayType}`] = {
                wr:             r.win_rate,
                ev:             r.ev_per_trade,
                n:              r.sample_size,
                recommendation: r.recommendation,
                sizeDelta:      parsedNotes.size_delta ?? 0.10,
                zScore:         parsedNotes.z_score    ?? null,
                // real_n/real_ev (ACTIVE/SHADOW-origin only, excludes BACKFILL synthetic
                // data) — added 2026-08-12 so the dtaRow real-N floor below (~line 6791)
                // can gate SIZE_UP/SIZE_UP_STRONG on real evidence, not blended.
                realN:          parsedNotes.real_n     ?? null,
                realEv:         parsedNotes.real_ev    ?? null,
              };
            }
            // Setup-level suppression set — keyed by setup_type (directional)
            // SUPPRESS: N≥20, EV<-$5 — auto-suppress structural losers
            // THIN_N: N<20 — CLAUDE.md rule: insufficient data, must shadow until N≥20
            // Both cause new setups to insert as SHADOW rather than ACTIVE
            liveStats._suppressedSetups = new Set();
            // Real, live per-setup_type WR/EV/N — the single source every "EDGE: ... WR (N=...)"
            // description string in this file must read from instead of hand-typing a literal.
            // See the setupStatusQ comment above for the incident this fixed.
            liveStats._setupStats = {};
            for (const r of setupStatusQ.rows) {
              if (r.recommendation === 'SUPPRESS' || r.recommendation === 'THIN_N') liveStats._suppressedSetups.add(r.signal_name);
              liveStats._setupStats[r.signal_name] = { wr: r.win_rate, ev: r.ev_per_trade, n: r.sample_size, recommendation: r.recommendation };
            }
            // Formats a live edge stat honestly: real N≥20 numbers, or an explicit "not enough
            // data yet" instead of ever falling back to a hand-typed/approximate literal.
            liveStats._edgeText = (type) => {
              const r = liveStats._setupStats?.[type];
              if (!r || r.n == null) return 'not yet calibrated — no fired trades yet';
              if (r.n < 20) return `insufficient sample (N=${r.n}) — not yet decisive`;
              return `${(r.wr * 100).toFixed(1)}% WR (N=${r.n}, EV=$${r.ev?.toFixed(2)})`;
            };
            // DOW-specific suppression for today — setups negative on this DOW but fine all-time
            // signal_name format: '{SETUP_TYPE}_DOW_{DOW_INT}' — strip the suffix to get setup_type
            liveStats._dowSuppressToday = new Set();
            for (const r of dowStatusQ.rows) {
              if (r.recommendation === 'SUPPRESS') {
                const setupType = r.signal_name.replace(/_DOW_\d+$/, '');
                liveStats._dowSuppressToday.add(setupType);
              }
            }
            // Live confluence pair-bonus lookup — replaces the old hardcoded _PAIR_BONUS_MAP
            // (5 hand-picked, never-validated pairs) with real data from
            // backtest_confluence.js. Widened 2026-07-22 to the full ~1.7yr level_prices
            // history + a per-pair calibrated proximity gate (was a flat 15pt/30pt window
            // for every pair uniformly) — that script's own recommendation='VALIDATED_PAIR'
            // now encodes the complete "safe to use live" decision (distinctDays>=20, real
            // calibration, chronological stability, positive EV), so this loop just trusts
            // it rather than re-deriving the criteria here. Result: 60 real static-static
            // pairs qualify as of 2026-07-22 (N 301-1291, EV $4-$20/trade) — a real, wired
            // result, not the placeholder "nothing qualifies yet" state from before the
            // window/calibration fix. Self-heals via the existing weekly recompute as more
            // data accumulates or a pair's stability changes.
            liveStats._pairBonus = {}; // levelBase -> Set of partner levelBase names
            for (const r of confluencePairQ.rows) {
              if (r.recommendation !== 'VALIDATED_PAIR') continue;
              const pairName = r.signal_name.replace(/^PAIR:/, '');
              const [a, b] = pairName.split('+');
              if (!a || !b) continue;
              (liveStats._pairBonus[a] ??= new Set()).add(b);
              (liveStats._pairBonus[b] ??= new Set()).add(a);
            }
            // Live-usable exhaustion cutoffs (informational field only — see
            // exhaustion_signal_at_detection below). Recomputed weekly from full history by
            // scripts/backtest_confluence_exhaustion_interaction.mjs.
            try {
              liveStats._exhaustionCutoffs = JSON.parse(exhaustionCalibQ.rows[0]?.notes ?? 'null');
            } catch (_) { liveStats._exhaustionCutoffs = null; }
            setCached(todayET, 'levelFadeStats', liveStats);
          }
          const ls = (key) => liveStats[key] || null;
          const lsMon = (key) => liveStats._mon?.[key] || null;

          const monOverride = (key) => isMonday && lsMon(key) ? lsMon(key) : {};
          const keepLevelsAll = [
            // Prior-day value area (POC, VAH, VAL — all three)
            { name: 'PD_POC_FADE',    level: lp.PD_POC ?? pdPOC,   ...(ls('PD_POC')     || {}), ...monOverride('PD_POC') },
            { name: 'PD_VAH_FADE',    level: lp.PD_VAH ?? pdVAH,   ...(ls('PD_VAH')     || {}), ...monOverride('PD_VAH') },
            { name: 'PD_VAL_FADE',    level: lp.PD_VAL ?? pdVAL,   ...(ls('PD_VAL')     || {}), ...monOverride('PD_VAL') },
            // Prior-day IB mid
            { name: 'PD_IB_MID_FADE', level: lp.PD_IB_MID ?? pdIbMid, ...(ls('PD_IB_MID') || {}), ...monOverride('PD_IB_MID') },
            // Floor pivots (all 7: Pivot, R1, R2, R3, S1, S2, S3)
            { name: 'FLOOR_PIVOT_FADE', level: lp.FLOOR_PIVOT ?? floorP, ...(ls('FLOOR_PIVOT') || {}), ...monOverride('FLOOR_PIVOT') },
            { name: 'FLOOR_R1_FADE',   level: lp.FLOOR_R1 ?? floorR1,   ...(ls('FLOOR_R1')    || {}), ...monOverride('FLOOR_R1') },
            // FLOOR_S1 restored 2026-07-04: backfill (corrected direction) shows LONG 80% WR N=55 EV=+$98, SHORT 66.7% N=21 EV=+$18. Prior removal was based on inverted-direction backtest data.
            { name: 'FLOOR_S1_FADE',   level: lp.FLOOR_S1   ?? null, ...(ls('FLOOR_S1')    || {}), ...monOverride('FLOOR_S1') },
            // Today's OR/IB (real-time bar values — not from level_prices which may lag)
            { name: 'OR5_HIGH_FADE',   level: orH,         ...(ls('OR5_HIGH')    || {}), ...monOverride('OR5_HIGH') },
            { name: 'OR5_LOW_FADE',    level: orL,         ...(ls('OR5_LOW')     || {}) },
            // OR10/15/30 HIGH/LOW — added 2026-08-12, SHADOW-only until real N accumulates
            // (see the "New setup type checklist" — THIN_N placeholder rows seeded the same
            // session precisely so these never fire unsuppressed on a first real touch).
            // Phase 1 bar-history backtest: docs/OR_LENGTH_SEASONALITY_SPEC.md.
            { name: 'OR10_HIGH_FADE',  level: or10High,    ...(ls('OR10_HIGH')   || {}) },
            { name: 'OR10_LOW_FADE',   level: or10Low,     ...(ls('OR10_LOW')    || {}) },
            { name: 'OR15_HIGH_FADE',  level: or15High,    ...(ls('OR15_HIGH')   || {}) },
            { name: 'OR15_LOW_FADE',   level: or15Low,     ...(ls('OR15_LOW')    || {}) },
            { name: 'OR30_HIGH_FADE',  level: or30High,    ...(ls('OR30_HIGH')   || {}) },
            { name: 'OR30_LOW_FADE',   level: or30Low,     ...(ls('OR30_LOW')    || {}) },
            { name: 'IB_HIGH_FADE',   level: ibHighToday, ...(ls('IB_HIGH')    || {}) },
            { name: 'IB_LOW_FADE',    level: ibLowToday,  ...(ls('IB_LOW')     || {}) },
            // Computed meta-levels
            { name: '5D_OR_MID_FADE',  level: or5Mid,  ...(ls('5D_OR_MID')  || {}), ...monOverride('5D_OR_MID') },
            { name: '10D_IB_MID_FADE', level: ib10Mid, ...(ls('10D_IB_MID') || {}) },
            { name: 'PD_OR_MID_FADE',     level: pdOrMid,              ...(ls('PD_OR_MID')     || {}), ...monOverride('PD_OR_MID') },
            // PD_SESSION_MID: (prior day high + low) / 2 — 78.8% WR N=255 EV=+$37 (PD_IB_AUDIT), Monday-suppressed
            { name: 'PD_SESSION_MID_FADE', level: lp.PD_SESSION_MID ?? null, ...(ls('PD_SESSION_MID') || {}), ...monOverride('PD_SESSION_MID') },
            // Prior-day range and IB boundaries
            { name: 'PD_HIGH_FADE',      level: lp.PD_HIGH      ?? null, ...(ls('PD_HIGH')      || {}) },
            { name: 'PD_LOW_FADE',       level: lp.PD_LOW       ?? null, ...(ls('PD_LOW')       || {}) },
            { name: 'PD_CLOSE_FADE',     level: lp.PD_CLOSE     ?? null, ...(ls('PD_CLOSE')     || {}) },
            { name: 'PD_IB_HIGH_FADE',   level: lp.PD_IB_HIGH   ?? null, ...(ls('PD_IB_HIGH')   || {}) },
            { name: 'PD_IB_LOW_FADE',    level: lp.PD_IB_LOW    ?? null, ...(ls('PD_IB_LOW')    || {}) },
            // Extended floor pivots
            { name: 'FLOOR_R2_FADE',     level: lp.FLOOR_R2     ?? null, ...(ls('FLOOR_R2')     || {}) },
            { name: 'FLOOR_R3_FADE',     level: lp.FLOOR_R3     ?? null, ...(ls('FLOOR_R3')     || {}) },
            { name: 'FLOOR_S2_FADE',     level: lp.FLOOR_S2     ?? null, ...(ls('FLOOR_S2')     || {}) },
            { name: 'FLOOR_S3_FADE',     level: lp.FLOOR_S3     ?? null, ...(ls('FLOOR_S3')     || {}) },
            // Overnight range
            { name: 'ONH_FADE',          level: lp.ONH          ?? null, ...(ls('ONH')          || {}) },
            { name: 'ONL_FADE',          level: lp.ONL          ?? null, ...(ls('ONL')          || {}) },
            // Opens
            { name: 'DAILY_OPEN_FADE',   level: lp.DAILY_OPEN   ?? null, ...(ls('DAILY_OPEN')   || {}) },
            { name: 'WEEKLY_OPEN_FADE',  level: lp.WEEKLY_OPEN  ?? null, ...(ls('WEEKLY_OPEN')  || {}) },
            { name: 'MONTHLY_OPEN_FADE', level: lp.MONTHLY_OPEN ?? null, ...(ls('MONTHLY_OPEN') || {}) },
            // Weekly VWAP
            { name: 'WEEKLY_VWAP_FADE',  level: lp.WEEKLY_VWAP  ?? null, ...(ls('WEEKLY_VWAP')  || {}) },
            // Monthly VWAP (month-to-date) — added 2026-07-19. THIN_N as of backfill
            // (N=12-17 same-day-decided outcomes; most touches don't resolve within one
            // RTH session — see docs/OPEN_THREADS.md). SHADOW-only via the standard
            // _suppressedSetups gate (THIN_N types are included in it same as SUPPRESS) —
            // never a live alert until N≥20 clears the normal promotion bar.
            { name: 'MONTHLY_VWAP_FADE', level: lp.MONTHLY_VWAP ?? null, ...(ls('MONTHLY_VWAP') || {}) },
            // Prior-week value area
            { name: 'PW_VAH_FADE',       level: lp.PW_VAH       ?? null, ...(ls('PW_VAH')       || {}) },
            { name: 'PW_VAL_FADE',       level: lp.PW_VAL       ?? null, ...(ls('PW_VAL')       || {}) },
            { name: 'PW_POC_FADE',       level: lp.PW_POC       ?? null, ...(ls('PW_POC')       || {}) },
            // Prior-month value area (VAH, VAL, POC) + range
            { name: 'PM_VAH_FADE',       level: lp.PM_VAH       ?? null, ...(ls('PM_VAH')       || {}) },
            { name: 'PM_VAL_FADE',       level: lp.PM_VAL       ?? null, ...(ls('PM_VAL')       || {}) },
            // PM_POC re-added 2026-07-27 (OPEN_DECISION pm_poc_rth_inclusion_stale_exclusion_found):
            // the 2026-07-02 "WR=44.4%, EV=-$54.9" exclusion was computed on level_prices data
            // since confirmed corrupted by the volume-profile bucketing bug (fixed 2026-07-17).
            // Re-verified on corrected data (scripts/backtest_pm_poc_short_reverify_20260727.mjs,
            // sweepOptimalStopAndTarget-derived, Gemini-cross-checked): PM_POC_FADE_SHORT is real
            // but thin (N=29) and chronologically unstable — seeded THIN_N, not ACTIVE, so it
            // fires SHADOW-only via the standard _suppressedSetups gate and accumulates real data
            // for backtest_setup_status.mjs to take over. PM_POC_FADE_LONG confirmed a non-edge on
            // two independent checks — seeded SUPPRESS. See scripts/seed_pm_poc_setup_status_20260727.mjs.
            { name: 'PM_POC_FADE',       level: lp.PM_POC       ?? null, ...(ls('PM_POC')       || {}) },
            { name: 'PM_HIGH_FADE',      level: lp.PM_HIGH      ?? null, ...(ls('PM_HIGH')      || {}) },
            { name: 'PM_LOW_FADE',       level: lp.PM_LOW       ?? null, ...(ls('PM_LOW')       || {}) },
            // Quarterly value area
            // 3M_VAH omitted — WR=7.1% (structural bull market makes this a breakout level, not fade)
            { name: '3M_VAL_FADE',       level: lp['3M_VAL']    ?? null, ...(ls('3M_VAL')       || {}) },
            { name: '3M_POC_FADE',       level: lp['3M_POC']    ?? null, ...(ls('3M_POC')       || {}) },
            // Prior-year value area — added 2026-07-19. All 3 THIN_N as of backfill; touches
            // of a specific bygone year's POC/VAL are genuinely rare (a full year's VA is wide,
            // price seldom revisits its exact center) — PY_POC has N=1, PY_VAL N=0 over ~2.3yr
            // of history. SHADOW-only via the standard THIN_N gate, same as MONTHLY_VWAP above.
            { name: 'PY_VAH_FADE',       level: lp.PY_VAH       ?? null, ...(ls('PY_VAH')       || {}) },
            { name: 'PY_VAL_FADE',       level: lp.PY_VAL       ?? null, ...(ls('PY_VAL')       || {}) },
            { name: 'PY_POC_FADE',       level: lp.PY_POC       ?? null, ...(ls('PY_POC')       || {}) },
            // Camarilla pivots (R3/S3 = reversal zones, R4/S4 = breakout levels)
            { name: 'CAM_R1_FADE',       level: lp.CAM_R1       ?? null, ...(ls('CAM_R1')       || {}) },
            { name: 'CAM_R2_FADE',       level: lp.CAM_R2       ?? null, ...(ls('CAM_R2')       || {}) },
            { name: 'CAM_R3_FADE',       level: lp.CAM_R3       ?? null, ...(ls('CAM_R3')       || {}) },
            { name: 'CAM_R4_FADE',       level: lp.CAM_R4       ?? null, ...(ls('CAM_R4')       || {}) },
            { name: 'CAM_S1_FADE',       level: lp.CAM_S1       ?? null, ...(ls('CAM_S1')       || {}) },
            { name: 'CAM_S2_FADE',       level: lp.CAM_S2       ?? null, ...(ls('CAM_S2')       || {}) },
            { name: 'CAM_S3_FADE',       level: lp.CAM_S3       ?? null, ...(ls('CAM_S3')       || {}) },
            { name: 'CAM_S4_FADE',       level: lp.CAM_S4       ?? null, ...(ls('CAM_S4')       || {}) },
            // Weekly floor pivots
            { name: 'WPP_FADE',          level: lp.WPP          ?? null, ...(ls('WPP')          || {}) },
            { name: 'WR1_FADE',          level: lp.WR1          ?? null, ...(ls('WR1')          || {}) },
            { name: 'WR2_FADE',          level: lp.WR2          ?? null, ...(ls('WR2')          || {}) },
            { name: 'WS1_FADE',          level: lp.WS1          ?? null, ...(ls('WS1')          || {}) },
            { name: 'WS2_FADE',          level: lp.WS2          ?? null, ...(ls('WS2')          || {}) },
            // Monthly floor pivots
            { name: 'MPP_FADE',          level: lp.MPP          ?? null, ...(ls('MPP')          || {}) },
            { name: 'MR1_FADE',          level: lp.MR1          ?? null, ...(ls('MR1')          || {}) },
            { name: 'MR2_FADE',          level: lp.MR2          ?? null, ...(ls('MR2')          || {}) },
            { name: 'MS1_FADE',          level: lp.MS1          ?? null, ...(ls('MS1')          || {}) },
            { name: 'MS2_FADE',          level: lp.MS2          ?? null, ...(ls('MS2')          || {}) },
            // PD-2 value area and prior week H/L
            { name: 'PD2_VAH_FADE',      level: pd2VAH,                  ...(ls('PD2_VAH')      || {}) },
            { name: 'PD2_VAL_FADE',      level: pd2VAL,                  ...(ls('PD2_VAL')      || {}) },
            { name: 'PW_HIGH_FADE',      level: pwHigh,                  ...(ls('PW_HIGH')      || {}) },
            { name: 'PW_LOW_FADE',       level: pwLow,                   ...(ls('PW_LOW')       || {}) },
            { name: '2D_POC_FADE',       level: twoDayPOC,               ...(ls('2D_POC')       || {}) },
            // IB mid — only valid after IB (60min) closes at 10:30. OR mid forms with the
            // 5min OR itself (~9:35) and is NOT IB-dependent — gating it to 630 was a
            // copy-paste of the IB_MID_SCALP_FADE line below (both added same commit,
            // bf65b47, 2026-07-02) rather than a deliberate finding that the OR mid fade
            // only works post-IB. Gate fixed 2026-07-16 per live user report; the setup_type
            // itself was renamed OR_MID_AFTER_IB -> OR5_MID 2026-08-12 (folded into the new
            // OR{N}_HIGH/LOW/MID naming family, see docs/OR_LENGTH_SEASONALITY_SPEC.md) since
            // "AFTER_IB" had been a stale, misleading name for ungated logic for nearly a
            // month. Full active_setups/performance_audit/level_prices history renamed in
            // place (backup: *_or_rename_backup_20260812, see docs/DB_BACKUP_CATALOG.md).
            { name: 'IB_MID_SCALP_FADE', level: etMinNow >= 630 ? ibMid : null,  mae_p75: 50, mfe: 15, mfe_p75: 30, ...(ls('IB_MID_SCALP') || {}) },
            { name: 'OR5_MID_FADE',      level: orMid, mae_p75: 35, mfe: 20, mfe_p75: 40, ...(ls('OR5_MID') || {}) },
            // OR10/15/30 MID — added 2026-08-12, same SHADOW-only convention as the HIGH/LOW
            // entries above. Unlike the old OR_MID_AFTER_IB name, none of these wait for IB.
            { name: 'OR10_MID_FADE', level: or10Mid, mae_p75: 35, mfe: 20, mfe_p75: 40, ...(ls('OR10_MID') || {}) },
            { name: 'OR15_MID_FADE', level: or15Mid, mae_p75: 35, mfe: 20, mfe_p75: 40, ...(ls('OR15_MID') || {}) },
            { name: 'OR30_MID_FADE', level: or30Mid, mae_p75: 35, mfe: 20, mfe_p75: 40, ...(ls('OR30_MID') || {}) },
            // Ordinary close-range VWAP touch (within the standard 15pt window every other
            // level here uses), distinct from VWAP_MAGNET's far-away sigma-distance trigger
            // just above. Added 2026-07-28 per direct user pushback ("what about fades off
            // the vwap? those are trades too") -- VWAP_MAGNET only ever fires on a rare
            // extreme departure from VWAP; it says nothing about the far more common case of
            // price simply touching VWAP at close range like it touches any other level.
            // Reuses earlyVwap (the same running/developing VWAP VWAP_MAGNET already
            // computes above, in scope here) -- inherits the exact same machinery every
            // other keepLevelsAll entry gets for free (direction-from-approach-side,
            // sizeMultiplier stack, confluence, S2/trend-counter suppression, dedup) rather
            // than a bespoke check.
            { name: 'RTH_VWAP_FADE', level: earlyVwap, ...(ls('RTH_VWAP') || {}) },
          ].filter(l => l.level != null);
          const keepLevels = keepLevelsAll;

          // Conditional type override table. Converts raw `${lv.name}_${dir}` into a
          // variant type when entry conditions change the edge profile enough to warrant
          // separate calibration. Both the live path AND the early-touch backfill path
          // must call this — it is the single source of truth for all type overrides.
          const resolveSetupType = (rawType, lv) => {
            if (rawType === 'WPP_FADE_SHORT') {
              const sessionOpenBar = allRthBarsRow.rows.find(b => b.et_min === 570);
              if (sessionOpenBar && parseFloat(sessionOpenBar.open) < lv.level) return 'WPP_FADE_SHORT_GAP_UP';
            }
            // Unconditional diversion (docs/SCALEOUT_RUNNER_SPEC.md §4/§10) — every
            // touch of these 6 base types gets the breakeven-then-trail exit mechanism
            // instead of the fixed single target. Keeps each base type's own live
            // calibration clean/untouched going forward. FLOOR_R1_FADE_SHORT was the
            // first wired (2026-07-19); the other 5 added 2026-07-21, same pattern.
            if (rawType === 'FLOOR_R1_FADE_SHORT') return 'FLOOR_R1_FADE_SHORT_TRAIL';
            if (rawType === 'PW_HIGH_FADE_LONG') return 'PW_HIGH_FADE_LONG_TRAIL';
            if (rawType === 'PD_POC_FADE_LONG') return 'PD_POC_FADE_LONG_TRAIL';
            if (rawType === 'FLOOR_S1_FADE_LONG') return 'FLOOR_S1_FADE_LONG_TRAIL';
            if (rawType === 'DAILY_OPEN_FADE_LONG') return 'DAILY_OPEN_FADE_LONG_TRAIL';
            if (rawType === 'CAM_S2_FADE_LONG') return 'CAM_S2_FADE_LONG_TRAIL';
            return rawType;
          };

          // Collect ALL levels within 15pt — wider than the old 10pt window to catch
          // approaches that reverse before piercing deeply. Pick the highest-EV level
          // as the primary setup; annotate description with confluence when 2+ stack.
          const nearLevels = keepLevels.filter(lv => Math.abs(currentPrice - lv.level) <= 15);

          // Cascade breaker: skip new fade setup detection when trend regime detected.
          // FIXED 2026-07-27 (comprehensive dead-end audit, same session as the
          // SUPPRESSED_FADE fix): this used to insert setup_type=lv.name directly (a bare
          // level name with no direction suffix, inconsistent with every other insert's
          // convention) and no entry/stop/target/expires_at at all -- structurally
          // identical dead end (0 rows ever recorded, so no historical damage, but
          // guaranteed to fail the same way whenever the cascade breaker next fires).
          // Now mirrors the suppressed-near-level-audit fix exactly: resolves a real
          // direction+type per level and computes the same entry/stop/target a live
          // candidate at that level would have gotten.
          // DISABLED 2026-08-05 as an ACTING gate -- kept as a logging-only audit trail.
          // Full-history validation the same night (RESEARCH_CLAIM
          // cascade_breaker_validation_single_day_artifact) found its entire apparent value
          // rested on a single outlier day (1 of 7); on 5 of the other 6 days it demonstrably
          // blocked trades that outperformed the normal population that was let through,
          // including the day this was checked. A live layer between signal and execution
          // with a negative case behind it doesn't get to keep acting while under review --
          // see OPEN_DECISION cascade_breaker_validate_or_remove. The audit-row insert below
          // (suppression_reason='CASCADE_BREAKER') still runs whenever the trigger condition
          // is met, so the data keeps accumulating for a future re-decision -- only the
          // downstream gating (the `!cascadeBreaker.active` check further below) was removed.
          if (cascadeBreaker.active && nearLevels.length > 0) {
            const cbIsLong = approachDir === 'FROM_ABOVE';
            const cbDir = cbIsLong ? 'LONG' : 'SHORT';
            const cbVaMap = await getValueAreaRegimeMap(todayET).catch(() => ({}));
            for (const lv of nearLevels) {
              const cbType = resolveSetupType(`${lv.name}_${cbDir}`, lv);
              const cbOptStop = liveStats._opt?.[cbType];
              const cbStopPts = cbOptStop?.stop ?? Math.round(lv.mae_p75 ?? STOP);
              const cbTargetPts = cbOptStop?.target ?? Math.round(lv.mfe ?? TARGET);
              const cbStopLevel = cbIsLong ? currentPrice - cbStopPts : currentPrice + cbStopPts;
              const cbT1Level = cbIsLong ? currentPrice + cbTargetPts : currentPrice - cbTargetPts;
              const cbEtNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
              const cbSessionEnd = new Date(cbEtNow);
              cbSessionEnd.setHours(16, 0, 0, 0);
              if (cbSessionEnd <= cbEtNow) cbSessionEnd.setDate(cbSessionEnd.getDate() + 1);
              const cbExpiresAt = `${cbSessionEnd.getFullYear()}-${String(cbSessionEnd.getMonth() + 1).padStart(2, '0')}-${String(cbSessionEnd.getDate()).padStart(2, '0')} ${String(cbSessionEnd.getHours()).padStart(2, '0')}:${String(cbSessionEnd.getMinutes()).padStart(2, '0')}:00`;
              const cbRegimeStamp = computeRegimeStamp(currentPrice, cbVaMap);
              const cbFireTags = await computeFireTags(todayET, 'RTH', etMin);
              await query(`
                INSERT INTO active_setups (
                  trade_date, setup_type, fired_at, price_at_detection, status, origin_status,
                  suppression_reason, entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label, expires_at,
                  ${REGIME_STAMP_COLS.join(', ')}, ${FIRE_TAG_COLS.join(', ')}, bet_class
                )
                VALUES ($1,$2,NOW(),$3,'SHADOW','SHADOW','CASCADE_BREAKER',$3,$3,$4,$5,$6,$7,
                  ${REGIME_STAMP_COLS.map((_, i) => `$${8 + i}`).join(', ')},
                  ${FIRE_TAG_COLS.map((_, i) => `$${8 + REGIME_STAMP_COLS.length + i}`).join(', ')},
                  $${8 + REGIME_STAMP_COLS.length + FIRE_TAG_COLS.length})
                ON CONFLICT DO NOTHING
              `, [
                todayET, cbType, currentPrice, cbStopLevel, cbT1Level,
                `T1: ${cbTargetPts}pt · Stop: ${cbStopPts}pt (cascade breaker audit)`,
                cbExpiresAt,
                ...regimeStampValues(cbRegimeStamp),
                ...fireTagValues(cbFireTags),
                getBetClass(cbType),
              ]).catch(() => {});
            }
          }
          // Was `if (!cascadeBreaker.active && nearLevels.length > 0)` -- the cascadeBreaker
          // condition no longer gates this. See the disable note above the audit-log block.
          if (nearLevels.length > 0) {
            const isLong = approachDir === 'FROM_ABOVE';
            const dir = isLong ? 'LONG' : 'SHORT';
            // Kept purely to name the "would-have-picked" audit candidate when the
            // fallback below finds nothing eligible -- preserves exact tie-break parity
            // with the old single-pick behavior (strict `>`, earlier array element wins
            // ties) rather than depending on sort stability for the same purpose.
            const pooledPrimary = nearLevels.reduce((best, lv) =>
              (lv.ev ?? -999) > (best.ev ?? -999) ? lv : best, nearLevels[0]);
            // Cluster dedup (2026-07-29): nearLevels.reduce() above only picks one primary
            // PER POLL -- but the server polls every 15-60s, and as price ticks within a
            // clustered zone, CONSECUTIVE polls can each pick a DIFFERENT "best EV" level
            // from an overlapping nearLevels set, so multiple different setup_types can each
            // independently become "the primary" and fire their own row within a few minutes
            // of each other at nearly the same price -- confirmed live same-day (e.g.
            // PD_CLOSE_FADE_SHORT and OR_MID_AFTER_IB_FADE_SHORT both fired at the identical
            // price 27907.75, three minutes apart). This checks whether ANY setup_type that
            // could plausibly be drawn from THIS SAME nearLevels cluster (same direction) has
            // already fired in the last 15 minutes; if so, this touch is attributed to that
            // trade instead of becoming a new independent one. The 15-minute window is a
            // dedup/plumbing parameter, not a trading threshold (entry/stop/target/signal),
            // so it's a documented fixed choice rather than derived from a rolling
            // distribution -- matches this codebase's own precedent for similar internal
            // windows (the 5-bar touch dedup already used elsewhere, SIGMA_CONTINUATION_LIVE's
            // 20-minute recency window).
            const clusterTypes = nearLevels.map(cl => resolveSetupType(`${cl.name}_${dir}`, cl));
            // Re-arm on resolution, not just on a flat clock (fixed 2026-08-03, DeepSeek
            // design debate + confirmed live via the CAM_S1/PW_VAH miss on 2026-08-03 09:30-09:45
            // ET -- see OPEN_DECISION cluster_dedup_blocks_reentry_after_first_fade_stopped).
            // The 15-minute window alone used to block EVERY other level in a stacked cluster
            // for the full 15 minutes even after the anchor trade had already been decided
            // (STOP_HIT/TARGET_HIT/EXPIRED) -- so a fast, wrong pick at the top of a cluster
            // could silently lock out the level the market actually respected a few minutes
            // later. Adding `status IN ('ACTIVE','SHADOW')` means only a STILL-OPEN anchor
            // blocks the cluster; once it resolves, the cluster is immediately re-eligible for
            // the rest of the 15-minute window.
            // suppression_reason != 'CASCADE_BREAKER' excludes the audit-only rows inserted
            // just above (2026-08-05, cascade breaker disabled as an acting gate but kept
            // logging) -- those rows share the same setup_type/status='SHADOW' shape as a
            // real touch, and without this exclusion the real candidate for the SAME level
            // (now unconditionally allowed to fire) would see its own audit row as "already
            // fired in this cluster" and get silently swallowed by dedup logic instead of
            // firing independently.
            const clusterAnchorRes = await query(`
              SELECT id, setup_type FROM active_setups
              WHERE trade_date = $1 AND setup_type = ANY($2)
                AND origin_status IN ('ACTIVE','SHADOW')
                AND status IN ('ACTIVE','SHADOW')
                AND (suppression_reason IS NULL OR suppression_reason != 'CASCADE_BREAKER')
                AND fired_at >= NOW() - INTERVAL '15 minutes'
              ORDER BY fired_at ASC LIMIT 1
            `, [todayET, clusterTypes]).catch(() => ({ rows: [] }));
            const clusterAlreadyFired = clusterAnchorRes.rows[0] || null;
            // Same-type rapid-refire guard (fixed 2026-08-03, same day as the resolution-based
            // re-arm above -- flagged independently by both Gemini and DeepSeek reviewing that
            // change): re-arming the CLUSTER on resolution has a side effect the flat 15-minute
            // clock used to prevent as an accident of its own bluntness -- the exact SAME
            // setup_type could now refire on itself seconds after being STOP_HIT, if price wicks
            // through and snaps back within the same 15pt zone (a real live gap, not
            // hypothetical -- this is the identical whipsaw shape already fixed once for
            // IB_BEARISH/VWAP_MAGNET_*/GLOBEX_VWAP_MAGNET_* via REFIRE_COOLDOWN_MINUTES below,
            // which does NOT cover ordinary level fades). This restores the old same-type
            // protection (unconditional 15-minute block on THIS exact type, resolved or not)
            // while keeping the new behavior for every OTHER type in the same cluster.
            // Batched same-type-recently-fired check across the whole cluster (2026-08-12,
            // level-fade cluster-fallback fix — see the fallback loop below). Used to be a
            // single query for the one reduce()-picked type; the fallback needs to check this
            // per candidate as it tries each one in turn, so this is now one ANY($2) query +
            // Set membership instead of N sequential round-trips. Deliberately NOT merged with
            // clusterAnchorRes above -- that query has different predicates (restricted to
            // still-open ACTIVE/SHADOW non-CASCADE_BREAKER rows, for cluster-dedup attribution)
            // from this one (any row at all in the last 15min, resolved or not, for the same-type
            // refire guard) -- collapsing them would silently change the cooldown semantics.
            const recentTypeRows = await query(`
              SELECT DISTINCT setup_type FROM active_setups
              WHERE trade_date = $1 AND setup_type = ANY($2)
                AND fired_at >= NOW() - INTERVAL '15 minutes'
            `, [todayET, clusterTypes]).catch(() => ({ rows: [] }));
            const recentlyFiredTypes = new Set(recentTypeRows.rows.map(r => r.setup_type));

            // dir-global gates -- pure functions of `dir`/`dtClass`/`ibSetup`, identical for
            // every candidate in this cluster, so computed once rather than per candidate.
            const s2Double = isS2DoubleCounter(dir);
            const trendCounterFadeFlag = isTrendCounterFade(dir);

            // Level-fade cluster fallback (2026-08-12) -- replaces the old single reduce()
            // pick, which chose ONE candidate by pooled EV and gave up entirely for the whole
            // poll if it was excluded, even when several OTHER eligible, real, positive-EV
            // candidates sat in the same cluster. Root-caused live the same day: confirmed
            // RTH_VWAP_FADE_LONG (a real, cleared +$6.66/trade setup) never fired once in a
            // 42-minute window because WEEKLY_OPEN_FADE (THIN_N, cluster-blocked) kept winning
            // the pooled-EV pick every single poll. Sorts by DIRECTIONAL EV (the EV of the bet
            // actually being fired, not the pooled long+short number a level carries) and tries
            // each candidate in EV order until one clears every existing gate. Also filters to
            // the approach-consistent side of price -- a level on the far side from the approach
            // direction would fire a semantically-backwards fade, a latent pre-existing gap this
            // fallback would otherwise make MORE likely to fire, not less. DeepSeek design
            // critique 2026-08-12 (scratch/deepseek_response.md) -- see
            // OPEN_DECISION cascade_diag_awaiting_live_data for the full writeup.
            let lv = null, type = null, sameTypeRecentlyFired = false;
            // Explicit flag rather than re-deriving "cleared" from the individual suppression
            // booleans below (2026-08-12 correctness fix, caught before shipping): the side
            // filter (sideOk) excludes a candidate from ever being tried without setting any of
            // clusterAlreadyFired/sameTypeRecentlyFired/suppressedSetup/etc -- if the fallback's
            // pooledPrimary happens to be wrong-side but otherwise unsuppressed, re-deriving from
            // those flags alone would wrongly read as "cleared" and fire it anyway, silently
            // defeating the side filter this fix exists to add.
            let winnerFound = false;
            if (!clusterAlreadyFired) {
              const dirKey = isLong ? 'long' : 'short';
              const directionalEv = (cand) => {
                const base = cand.name.replace(/_FADE$/, '');
                return liveStats[base]?.[dirKey]?.ev ?? cand.ev ?? -999;
              };
              const sideOk = (cand) => isLong ? cand.level < currentPrice : cand.level > currentPrice;
              const sortedCandidates = nearLevels.filter(sideOk).sort((a, b) => directionalEv(b) - directionalEv(a));
              for (const cand of sortedCandidates) {
                const candType = resolveSetupType(`${cand.name}_${dir}`, cand);
                const candRecentlyFired = recentlyFiredTypes.has(candType);
                const candSuppressed = !!liveStats._suppressedSetups?.has(candType);
                const candDowSuppressed = !!liveStats._dowSuppressToday?.has(candType);
                if (!candRecentlyFired && !candSuppressed && !candDowSuppressed && !s2Double && !trendCounterFadeFlag) {
                  lv = cand; type = candType; sameTypeRecentlyFired = false; winnerFound = true;
                  break;
                }
                // Skipped candidate — logged so the fallback doesn't recreate the exact
                // "orphaned candidate with zero trace" problem this fix exists to solve.
                const skipReason = candRecentlyFired ? 'SAME_TYPE_REFIRE_COOLDOWN'
                  : candSuppressed ? 'SUPPRESSED_FADE'
                  : candDowSuppressed ? 'DOW_SUPPRESSED'
                  : s2Double ? 'S2_DOUBLE_COUNTER'
                  : trendCounterFadeFlag ? 'TREND_COUNTER_FADE' : 'SUPPRESSED_OTHER';
                logGatedCandidate({ tradeDate: todayET, setupType: candType, gateName: 'LEVEL_FADE_CLUSTER_FALLBACK_SKIP', gateReason: skipReason, entry: currentPrice });
              }
            }
            // No candidate cleared (or clusterAlreadyFired blocked the whole cluster) -- fall
            // back to the pooled-EV pick for the audit trail, exactly matching pre-fix behavior.
            if (!lv) {
              lv = pooledPrimary;
              type = resolveSetupType(`${lv.name}_${dir}`, lv);
              sameTypeRecentlyFired = recentlyFiredTypes.has(type);
            }

            // TEMPORARY DIAGNOSTIC (2026-08-12) — kept through the fallback fix's first live
            // cascade window per DeepSeek's review, since it's the only real-time visibility
            // into the rescue path outside cascadeBreaker.active windows. Now logs the WINNER
            // (or would-have-picked candidate), not the single pre-fallback pick. Remove once
            // the fallback's selection quality is confirmed over a few real occurrences.
            if (cascadeBreaker.active) {
              cascadeDiagLog(`[cascade-diag] type=${type} dir=${dir} cascadeActive=${cascadeBreaker.active} stopCount=${cascadeBreaker.stopCount} clusterAlreadyFired=${!!clusterAlreadyFired} sameTypeRecentlyFired=${sameTypeRecentlyFired} suppressedSetup=${!!liveStats._suppressedSetups?.has(type)} dowSuppressed=${!!liveStats._dowSuppressToday?.has(type)} s2Double=${s2Double} trendCounter=${trendCounterFadeFlag} nearLevelsN=${nearLevels.length}`);
            }

            if (winnerFound) {
            // Use directional optimal stop from MAE backfill; fall back to combined mae_p75, then constant
            const optStop  = liveStats._opt?.[type];
            const stopPts  = optStop?.stop   ?? Math.round(lv.mae_p75 ?? STOP);
            const targetPts = optStop?.target ?? Math.round(lv.mfe    ?? TARGET);
            const confluenceCount = nearLevels.length;
            const confluenceNote = confluenceCount >= 2
              ? ` ⚡ ${confluenceCount}× confluence: ${nearLevels.map(l => l.name.replace(/_FADE$/, '')).join(' + ')}`
              : '';
            // Approach delta: net buyer/seller pressure on last 5 bars before level touch.
            // Research 2026-07-05: LONG fades with net_delta>0 = 77% WR vs 71% for sellers.
            const approachDelta = last5.reduce((s, b) => s + (b.ask_vol || 0) - (b.bid_vol || 0), 0);
            const buyersAtLevel  = isLong  && approachDelta > 0; // buyers defending support on approach
            const sellersAtLevel = !isLong && approachDelta < 0; // sellers pressing resistance on approach

            // Confluence+exhaustion interaction signal (informational only — RESEARCH_CLAIM
            // confluence_exhaustion_interaction is still PROVISIONAL, not a validated live edge;
            // do NOT use this to gate sizeMultiplier or suppression). Mirrors
            // scripts/backtest_confluence_exhaustion_interaction.mjs's definition exactly: entry
            // bar's volRatio/rangeRatio vs the mean of the strictly-prior 20 bars (no lookahead),
            // delta (this bar's own ask_vol - bid_vol, not the 5-bar approachDelta above) opposing
            // the fade direction. Cutoffs are the live volRatioP50/rangeRatioP50 read from
            // liveStats._exhaustionCutoffs (weekly recompute, full history — see that script).
            let exhaustionSignalAtDetection = null;
            const _exhBars = allRthBarsRow.rows;
            const _exhEntryIdx = _exhBars.length - 1;
            if (_exhEntryIdx >= 20 && liveStats._exhaustionCutoffs) {
              const _exhPrior = _exhBars.slice(_exhEntryIdx - 20, _exhEntryIdx);
              const _exhEntry = _exhBars[_exhEntryIdx];
              const _meanVol = _exhPrior.reduce((s, b) => s + (b.volume || 0), 0) / _exhPrior.length;
              const _meanRange = _exhPrior.reduce((s, b) => s + (b.high - b.low), 0) / _exhPrior.length;
              if (_meanVol > 0 && _meanRange > 0) {
                const _volRatio = (_exhEntry.volume || 0) / _meanVol;
                const _rangeRatio = (_exhEntry.high - _exhEntry.low) / _meanRange;
                const _entryBarDelta = (_exhEntry.ask_vol || 0) - (_exhEntry.bid_vol || 0);
                const _deltaOpposing = isLong ? _entryBarDelta < 0 : _entryBarDelta > 0;
                exhaustionSignalAtDetection = _volRatio >= liveStats._exhaustionCutoffs.volRatioP50
                  && _rangeRatio <= liveStats._exhaustionCutoffs.rangeRatioP50
                  && _deltaOpposing;
              }
            }

            // HI-VOL+LO-PACE precursor (informational only — RESEARCH_CLAIM
            // hivol_lopace_precursor_confirmed_negative, CONFIRMED 2026-07-29, train/test
            // same-sign both splits). High transactional volume WITHOUT correspondingly
            // large price movement in the trailing 5 bars before a touch predicts a WORSE
            // outcome — the opposite of the "absorption defends the level" hypothesis that
            // motivated testing it. Same volZ/paceZ methodology and cutoffs (volZ>=0.5,
            // paceZ<1.0) as the already-live STACK_VOL_BREAK_LIVE entry trigger and the
            // backtest that validated this — reused via getTouchQualityBaseline()/
            // getPaceBaseline(), not reimplemented. Never gates entry or sizeMultiplier.
            let hivolLopaceAtDetection = null;
            if (last5.length === 5) {
              const _hlBaseline = await getTouchQualityBaseline(todayET);
              const _hlPaceBaseline = await getPaceBaseline(todayET);
              // Gemini review (retroactive, post-ship) caught a real off-by-one here: the
              // volume z-score loop was reusing `last5` (bars entry-5..entry-1, EXCLUDES the
              // entry bar), but the backtest that validated this finding
              // (pilot_velocity_round3_absorption_acceleration.mjs, window=5) computes over
              // bars entry-4..entry (INCLUDES the entry bar). The live signal was silently
              // evaluating a window shifted back by 1 bar from what was actually validated.
              // Fixed to the correct 5-bar window ending at the entry bar itself. Pace was
              // independently confirmed correct (last5[0] is genuinely entry-5, matching the
              // backtest's allBars[allBarsIdx-5]) and left unchanged.
              const _hlVolBars = allRthBarsRow.rows.slice(-5);
              let _hlMaxVolZ = -Infinity;
              for (const b of _hlVolBars) {
                const _hlBl = _hlBaseline.get(Number(b.et_min));
                if (_hlBl && _hlBl.std_vol > 0) {
                  const _tVol = (b.bid_vol || 0) + (b.ask_vol || 0);
                  _hlMaxVolZ = Math.max(_hlMaxVolZ, (_tVol - _hlBl.avg_vol) / _hlBl.std_vol);
                }
              }
              const _hlEntryBar = allRthBarsRow.rows[allRthBarsRow.rows.length - 1];
              const _hlPaceBl = _hlPaceBaseline.get(Number(_hlEntryBar.et_min));
              if (_hlMaxVolZ > -Infinity && _hlPaceBl && _hlPaceBl.std_pace > 0) {
                const _hlNetPace = Math.abs(_hlEntryBar.close - last5[0].close);
                const _hlPaceZ = (_hlNetPace - _hlPaceBl.avg_pace) / _hlPaceBl.std_pace;
                hivolLopaceAtDetection = _hlMaxVolZ >= 0.5 && _hlPaceZ < 1.0;
              }
            }

            // Elite zone: TURBULENT day + fade in IB direction + intraday range confirmation.
            // Research 2026-07-05: range >= 20d avg → 79.99% WR N=39; range < avg → 67.67% WR N=21.
            // turbConfirmed gates out the ~44% of TURBULENT calls that are false (classifier 20% accuracy).
            const eliteZone = dtClass === 'TURBULENT' && isWithIbDirection(dir) && turbConfirmed;

            // Level recency: lookup level's last test date (21-day window, pre-fetched above).
            const levelBase = lv.name.replace(/_FADE$/, '');
            const lastTestDate = lfRecencyMap[lv.name] ?? lfRecencyMap[levelBase] ?? null;
            const daysSinceTest = lastTestDate
              ? Math.round((new Date(todayET) - new Date(lastTestDate)) / 86400000)
              : null;
            const recencyPrefix = daysSinceTest == null
              ? 'Fresh level (no test in 21d) — '
              : daysSinceTest <= 2
              ? `Tested ${daysSinceTest}d ago — proven defender. `
              : daysSinceTest <= 7
              ? `Tested ${daysSinceTest}d ago. `
              : '';

            // Day-type edge lookup — reads from liveStats._dta (populated weekly by backtest_day_type_alpha.js).
            // Only SIZE_UP/SIZE_DOWN/SUPPRESS rows are non-NEUTRAL (N≥20, z≥1.5 required).
            const dtaKey = dtClass ? `${type}-${dtClass}` : null;
            const dtaRowRaw = dtaKey ? (liveStats._dta?.[dtaKey] ?? null) : null;
            // Real-N floor — added 2026-08-12, mirrors the IB_BULLISH/IB_BEARISH precedent
            // (~line 5133) that already fixed this exact gap for that one setup family:
            // dtaRowRaw.recommendation is derived from a BLENDED sample that can be majority
            // BACKFILL synthetic data, not real live-fired trades. Gated ONLY on the SIZE_UP
            // side (direction-aware, per DeepSeek design critique 2026-08-12) — a thin-real
            // SUPPRESS/SIZE_DOWN is still the conservative call and must not be dropped just
            // because real_n is low; the failure mode this guards against (a false-good
            // blended call inflating sizeMultiplier) is an upside-only hazard. A SUPPRESS/
            // SIZE_DOWN built on thin real data costs only foregone profit if wrong, which
            // self-corrects weekly as real N grows — dropping it would cost a sizing floor
            // and remove a live warning instead.
            const REAL_N_FLOOR = 5;
            const dtaRealN  = dtaRowRaw?.realN ?? 0;
            const dtaRealEv = dtaRowRaw?.realEv;
            const dtaIsSizeUp = dtaRowRaw?.recommendation?.startsWith('SIZE_UP') ?? false;
            const dtaUnproven = dtaIsSizeUp && dtaRealN < REAL_N_FLOOR;
            const dtaRealBad  = dtaIsSizeUp && dtaRealN >= REAL_N_FLOOR && dtaRealEv != null && dtaRealEv < -5;
            if (dtaRowRaw && (dtaUnproven || dtaRealBad)) {
              const dtaGateReason = dtaUnproven ? 'unproven' : 'realBad';
              const dtaGateLogKey = `${todayET}:${type}-${dtClass}:${dtaGateReason}`;
              if (!_dtaGateLogged.has(dtaGateLogKey)) {
                _dtaGateLogged.add(dtaGateLogKey);
                console.error(`[dta-gate] ${type}-${dtClass} recommendation=${dtaRowRaw.recommendation} dropped to NEUTRAL: real_n=${dtaRealN} (floor=${REAL_N_FLOOR}) real_ev=${dtaRealEv ?? 'n/a'} reason=${dtaGateReason}`);
              }
            }
            const dtaRow = (dtaUnproven || dtaRealBad) ? null : dtaRowRaw;

            // Specific confluence pair bonus: live lookup against backtest_confluence.js's real
            // PAIR:X+Y data (server/services/rigorDiagnostics.js-checked, distinct-day-gated —
            // see liveStats._pairBonus construction above for why touch count alone isn't safe
            // to use here). Replaced the old hardcoded 5-pair _PAIR_BONUS_MAP 2026-07-22 —
            // that map was never validated against real data; as of this date NO pair clears
            // the distinct-day floor yet, so this correctly yields no bonus until real
            // convergence data accumulates.
            const _nearNames = new Set(nearLevels.filter(l => l.name !== lv.name).map(l => l.name));
            const _pairPartners = liveStats._pairBonus?.[levelBase];
            const confluencePairPartner = _pairPartners ? [..._pairPartners].find(p => _nearNames.has(p)) ?? null : null;

            // Revisit latency: intraday minutes since price last closed within 10pt of this level.
            // Verified 2026-07-06: first visit of day = 78% WR +$71 EV (z=+2.74 N=283);
            // 3hr+ stale return = 60% WR -$35 EV (z=-2.74 N=129). Zero or null = first visit.
            const _barsNearLevel = allRthBarsRow.rows.filter(b =>
              b.et_min < etMinNow && Math.abs(b.close - lv.level) <= 10
            );
            const _lastVisitBar = _barsNearLevel.length > 0 ? _barsNearLevel[_barsNearLevel.length - 1] : null;
            const minutesSinceVisit = _lastVisitBar ? etMinNow - _lastVisitBar.et_min : null;

            levelScalpSetup = {
              type,
              direction: dir,
              entry: currentPrice,
              stop: isLong ? currentPrice - stopPts : currentPrice + stopPts,
              target: isLong ? currentPrice + targetPts : currentPrice - targetPts,
              t2: eliteZone ? (isLong ? currentPrice + targetPts * 2 : currentPrice - targetPts * 2) : null,
              targetLabel: `T1: ${targetPts}pt · Stop: ${stopPts}pt · EV: $${lv.ev != null ? lv.ev.toFixed(0) : '--'}${confluenceCount >= 2 ? ` · ${confluenceCount}× confluence` : ''}${eliteZone ? ` · T2: ${targetPts * 2}pt runner` : ''}`,
              description: (() => {
                const lvStats = ls(lv.name.replace(/_FADE$/, ''));
                const lDir = lvStats?.long, sDir = lvStats?.short;
                const dirStr = (lDir && sDir)
                  ? ` (Long: ${Math.round(lDir.wr * 100)}% N=${lDir.n} / Short: ${Math.round(sDir.wr * 100)}% N=${sDir.n})`
                  : '';
                const dirMae = isLong ? (lDir?.mae_p80w ?? null) : (sDir?.mae_p80w ?? null);
                const stopNote = dirMae != null ? ` Stop calibration: 80% of winners needed <${Math.round(dirMae)}pt of room.` : '';
                const eliteNote = eliteZone ? ` ⚡ ELITE ZONE: 78-82% WR. T2 runner at ${targetPts * 2}pt — p75 MFE on confirmed TURBULENT winners is 157pt.` : '';
                const dtNote = (() => {
                  if (!dtaRow || dtaRow.recommendation === 'NEUTRAL') return dtClass ? ` (${dtClass} day)` : '';
                  const pct = Math.round((dtaRow.wr ?? 0) * 100);
                  const z   = dtaRow.zScore != null ? ` ${dtaRow.zScore.toFixed(1)}σ` : '';
                  if (dtaRow.recommendation === 'SIZE_UP_STRONG') return ` ${dtClass} EDGE: ${pct}% WR N=${dtaRow.n}${z} — size up.`;
                  if (dtaRow.recommendation === 'SIZE_UP')        return ` ${dtClass} EDGE: ${pct}% WR N=${dtaRow.n}${z}.`;
                  if (dtaRow.recommendation === 'SUPPRESS')       return ` WARNING — ${dtClass}: ${pct}% WR historically. Reduce size.`;
                  if (dtaRow.recommendation === 'SIZE_DOWN')      return ` Caution — ${dtClass}: ${pct}% WR (below baseline).`;
                  return dtClass ? ` (${dtClass} day)` : '';
                })();
                // Confluence+exhaustion interaction note — RESEARCH_CLAIM confluence_exhaustion_interaction
                // is still PROVISIONAL (real but not yet decisive: fails computeRigor's stability bar
                // both train and test as of 2026-07-23). Surfaced as a caution, not a SKIP/suppress —
                // this is exactly the "watch until I get conviction" framework the user described,
                // not a live-execution gate yet.
                const exhaustionNote = exhaustionSignalAtDetection
                  ? ` ⚠ VOLUME/DELTA EXHAUSTION at this touch (high vol, tight range, delta opposing the fade) — historically a headwind when combined with confluence, still PROVISIONAL (not yet stable enough to size/suppress on).`
                  : '';
                // RESEARCH_CLAIM hivol_lopace_precursor_confirmed_negative — CONFIRMED
                // (train/test same-sign both splits). Unlike exhaustionNote above, this one
                // is validated, not provisional — still informational only, never gates
                // entry or sizeMultiplier per this app's standing "no execution capability"
                // convention (same as bar6_exit_recommended/checkFadeAgainstBigMoveExit).
                const hivolLopaceNote = hivolLopaceAtDetection
                  ? ` ⚠ HIGH VOLUME, LOW PACE into this touch (heavy volume without matching price movement) — historically a real headwind, not a defended level as the "absorption" idea would suggest (validated: -$7.91 EV vs +$0.07 EV control, N=1548, train/test consistent).`
                  : '';
                return `${recencyPrefix}${lv.name.replace(/_/g, ' ')} at ${Math.round(lv.level)}. ${Math.round((lv.wr ?? 0.5) * 100)}% WR (N=${lv.n ?? 0} combined${dirStr}). MAE P50: ${lv.mae ?? '--'}pt${lv.mfe != null ? `, MFE P50: ${lv.mfe}pt` : ''}.${stopNote}${confluenceNote}${exhaustionNote}${hivolLopaceNote}${eliteNote}${dtNote}${isMonday ? ' MONDAY: post-IB only (waits for IB close 10:30 ET).' : ' AM first touch.'}`;
              })(),
              history: { winRate: lv.wr, occurrences: lv.n, avgPnl: lv.ev, t1HitRate: lv.wr },
              sizeMultiplier: (() => {
                let mult = 1.0;
                // MARGINAL-tier starting discount: EV < $30 with no confluence → -0.25 base
                // (PRIME/SOLID tiers or confluent setups start at full size)
                if (lv.ev < 30 && confluenceCount < 2) mult = Math.max(mult - 0.25, 0.25);
                // First-of-day / win-streak boost (only when no loss streak — applied first so cap can override)
                if      (lfConsecWins >= 3)  mult = Math.min(mult + 0.50, 1.5);     // 87.8% WR
                else if (lfConsecWins === 2)  mult = Math.min(mult + 0.35, 1.5);    // 79.7% WR
                else if (lfConsecWins === 1)  mult = Math.min(mult + 0.25, 1.5);    // 76.6% WR
                else if (lfFirstOfDay)        mult = Math.min(mult + 0.10, 1.5);    // 79.4% WR — best group (2026-07-05)
                // Overnight NEUTRAL worst (68.2% WR vs 72-73% aligned/counter) — floor 0.25 not 0.5
                if (!isOvernightAligned(dir) && !isOvernightCounter(dir)) mult = Math.max(mult - 0.1, 0.25);
                // Approach delta: buyers/sellers confirming level (research 2026-07-05: +6% WR)
                if (buyersAtLevel || sellersAtLevel) mult = Math.min(mult + 0.15, 1.5);
                // Specific confluence pair bonus: verified N≥20 pairs (2026-07-05 Gemini Task 4)
                if (confluencePairPartner) mult = Math.min(mult + 0.15, 1.5);
                // Elite zone: TURBULENT + with IB direction = 78-82% WR (best segment)
                if (eliteZone) mult = Math.min(mult + 0.15, 1.5);
                // Level recency: 1-2d ago = $22 EV proven defender; 21d+ fresh = -$5 EV unproven — floor 0.25 not 0.5
                if (daysSinceTest != null && daysSinceTest <= 2) mult = Math.min(mult + 0.15, 1.5);
                else if (daysSinceTest == null) mult = Math.max(mult - 0.1, 0.25);
                // Day-type significance: data-driven from performance_audit DAY_TYPE_ALPHA rows.
                // size_delta scales with z_score (no fixed amount). Currently: only WEEKLY_VWAP_FADE_LONG
                // BALANCE reaches z≥1.5 (z=1.9). All other day_type divergences are within noise.
                if (dtaRow?.recommendation === 'SIZE_UP_STRONG' || dtaRow?.recommendation === 'SIZE_UP') {
                  mult = Math.min(mult + (dtaRow.sizeDelta ?? 0.10), 1.5);
                } else if (dtaRow?.recommendation === 'SIZE_DOWN') {
                  mult = Math.max(mult - (dtaRow.sizeDelta ?? 0.10), 0.25);
                } else if (dtaRow?.recommendation === 'SUPPRESS') {
                  mult = 0.25;
                }
                // Open vs prior value: INSIDE_VALUE = 68.28% WR (z=-2.43) vs OUTSIDE = 72.74% (2026-07-05)
                if (_lfOvOpen === 'INSIDE_VALUE') mult = Math.max(mult - 0.15, 0.25);
                // Stacking: 7+ same-dir setups = 62.4% WR -$15.7 EV (N=1922) — trend day, fades dead.
                const _lfSameDirN = _lfSameDirCounts[dir] ?? 0;
                if (_lfSameDirN >= 7) mult = 0.10;
                // NL30 regime conditioning (verified 2026-07-05, N=229-429 per bucket):
                if      (_lfNl30Bucket === 'MILD_BULL'   && dir === 'SHORT') mult = Math.max(mult - 0.20, 0.25); // 62.6% WR -$16.8 EV z=-2.48
                else if (_lfNl30Bucket === 'MILD_BEAR'   && dir === 'SHORT') mult = Math.max(mult - 0.20, 0.25); // 61.6% WR -$19.1 EV z=-2.69
                else if (_lfNl30Bucket === 'STRONG_BEAR' && dir === 'SHORT') mult = Math.min(mult + 0.10, 1.5);  // 77.7% WR +$68.1 EV z=+3.34
                else if (_lfNl30Bucket === 'STRONG_BULL' && dir === 'LONG')  mult = Math.min(mult + 0.10, 1.5);  // 77.6% WR +$62.0 EV z=+2.63
                else if (_lfNl30Bucket === 'MILD_BULL'   && dir === 'LONG')  mult = Math.min(mult + 0.10, 1.5);  // 77.3% WR +$63.7 EV z=+2.06
                // Revisit latency: untouched liquidity on first visit; picked-off zone on 3hr+ return.
                if (minutesSinceVisit === null)    mult = Math.min(mult + 0.15, 1.5);  // 78% WR +$71 EV z=+2.74 N=283
                else if (minutesSinceVisit >= 180) mult = Math.max(mult - 0.25, 0.25); // 60% WR -$35 EV z=-2.74 N=129
                // VWAP Extension: level far from VWAP = reversion force stacks with fade (z=+2.95 N=600)
                if (_lfVwap != null && _lfVwapMean != null && _lfVwapStd != null &&
                    Math.abs(currentPrice - _lfVwap) > _lfVwapMean + _lfVwapStd)
                  mult = Math.min(mult + 0.15, 1.5);
                // OR Expansion Bias: no expansion yet = liquidity intact (BALANCE z=2.03 N=161, TURBULENT z=2.77 N=26)
                if (!_lfOrExpanded && (dtClass === 'BALANCE' || dtClass === 'TURBULENT'))
                  mult = Math.min(mult + 0.10, 1.5);
                // Regime Persistence: TURBULENT 3-day streak +8.89pp (N=157, z=3.45). Skip on NEUTRAL NL30.
                if (_lfRegimePersist && dtClass === 'TURBULENT' && _lfNl30Bucket !== 'NEUTRAL')
                  mult = Math.min(mult + 0.10, 1.5);
                // TREND day: all fades structurally underperform (58.6% WR -$9,802 total, Opus audit 2026-07-07).
                // Size down — don't block entirely (WITH-trend fades can still be marginal), but penalize.
                if (dtClass === 'TREND') mult = Math.max(mult - 0.25, 0.25);
                // Small overnight gap: quiet consolidation days = 60.8% WR -$27 EV (N=332, Opus audit 2026-07-07).
                // Threshold: rolling p33 of 60-session overnight range (no hardcoded number).
                if (_lfSmallGap) mult = Math.max(mult - 0.15, 0.25);
                // Session delta magnitude (backtest 2026-07-08, N=4354):
                // Neutral |Δ|<p25 = 57.9% WR -$3 EV — quiet session kills fade resolution.
                // High |Δ|>p75 = 69.3% WR +$28 EV — strong conviction, clean reversals.
                // Thresholds: rolling p25/p75 of 60-session |cumulative delta| (no hardcoded numbers).
                if (_lfDeltaNeutral) mult = Math.max(mult - 0.10, 0.25);
                if (_lfDeltaHigh)    mult = Math.min(mult + 0.10, 1.5);
                // Pulse score: informational only — not wired to sizeMultiplier.
                // Backtest shows real lift on aggregate but too many false negatives on strong days.
                // Weekly backtest_pulse_score.mjs continues to accumulate data; revisit when N is larger.
                const _psDeltaDiv  = dir === 'SHORT' ? _pulseDelta15 > 0 : dir === 'LONG' ? _pulseDelta15 < 0 : false;
                const _pulseScore  = (_pulseHighVol ? 1 : 0) + (_psDeltaDiv ? 1 : 0) + (_pulseStruct ? 1 : 0) + (_pulseLowRots ? 1 : 0);
                // Session-bias conflict (2026-07-16, scripts/backtest_session_bias_conflict.mjs):
                // firing a mechanical fade against a strongly one-sided PERMISSION_SLIP session
                // read (>=65% WR opposing direction, same threshold sessionConflictFor already
                // uses for IB_BULLISH/IB_BEARISH's flag-only version, ~line 3505) costs real EV.
                // CONFLICT N=4037 WR=58.6% EV=-$14.93 vs NO_CONFLICT N=1887 WR=78.1% EV=+$28.62
                // (z=-8.25, far past the -2.0 SUPPRESS bar this codebase uses elsewhere) — checked
                // for a day-type confound before trusting it (this codebase has been burned by
                // exactly that shape of false signal before, see the "rotation as sizing factor"
                // thread in docs/OPEN_THREADS.md): holds up independently within BALANCE
                // (-$6/+$46), TREND (-$24/+$5), and TURBULENT (-$28/+$12) — not a re-labeled
                // day-type effect. User decision 2026-07-16: extend the existing IB-only flag to
                // level-fades and fold into sizeMultiplier, not suppress outright.
                if (sessionConflictFor(dir)) mult = Math.max(mult - 0.25, 0.25);
                // LOSS STREAK CAP: applied LAST — hard ceiling nothing else can override.
                // After-loss WR: 1×=47%, 2×=31.6%, 3+×=28.4%. Wins/conditions above inform upside, not downside.
                if      (lfConsecLosses >= 3) mult = Math.min(mult, 0.10); // near-skip
                else if (lfConsecLosses >= 2) mult = Math.min(mult, 0.10); // 31.6% WR
                else if (lfConsecLosses >= 1) mult = Math.min(mult, 0.25); // 47.0% WR
                return mult;
              })(),
              overnightAlignment: isOvernightAligned(dir) ? 'ALIGNED' : isOvernightCounter(dir) ? 'COUNTER' : 'NEUTRAL',
              eliteZone,
              dayTypeEdge: dtaRow?.recommendation?.startsWith('SIZE_UP') ? {
                strong:    dtaRow.recommendation === 'SIZE_UP_STRONG',
                wr:        dtaRow.wr,
                n:         dtaRow.n,
                dayType:   dtClass,
                sizeDelta: dtaRow.sizeDelta,
              } : null,
              dayTypeWarn: (dtaRow?.recommendation === 'SIZE_DOWN' || dtaRow?.recommendation === 'SUPPRESS') ? {
                suppress: dtaRow.recommendation === 'SUPPRESS',
                wr:       dtaRow.wr,
                n:        dtaRow.n,
                dayType:  dtClass,
              } : null,
              streakWarn: lfConsecLosses >= 2 ? { losses: lfConsecLosses } : null,
              streakBoost: lfConsecWins >= 2 ? { wins: lfConsecWins } : null,
              // Same field shape/threshold as ibSetup.sessionConflict (~line 3598) -- backtest
              // and full writeup at the sizeMultiplier factor above (~line 5085).
              sessionConflict: sessionConflictFor(dir),
              // STAND DOWN: filter out (don't just size down) when conditions are clearly -EV.
              // Opus audit 2026-07-07: after-loss 31.6% WR, TREND day 58.6% WR, TREND+loss compounding.
              standDown: lfConsecLosses >= 2 || (dtClass === 'TREND' && lfConsecLosses >= 1),
              smallGapDay: _lfSmallGap,
              sessionDeltaNeutral: _lfDeltaNeutral,
              sessionDeltaHigh: _lfDeltaHigh,
              pulseScore: (() => {
                const dDiv = dir === 'SHORT' ? _pulseDelta15 > 0 : dir === 'LONG' ? _pulseDelta15 < 0 : false;
                return (_pulseHighVol ? 1 : 0) + (dDiv ? 1 : 0) + (_pulseStruct ? 1 : 0) + (_pulseLowRots ? 1 : 0);
              })(),
              pulseVolSigma: _pulseVolSigma != null ? +_pulseVolSigma.toFixed(2) : null,
              confluencePairPartner,
              openVsPriorValue: _lfOvOpen,
              buyersAtLevel,
              sellersAtLevel,
              confluenceCount,
              confluenceLevels: nearLevels.map(l => l.name.replace(/_FADE$/, '')),
              stackCount: _lfSameDirCounts[dir] ?? 0,
              tier: lv.ev >= 50 ? 'PRIME' : lv.ev >= 20 ? 'SOLID' : lv.ev >= 0 ? 'MARGINAL' : lv.ev >= -20 ? 'WEAK' : 'KILL',
              exhaustionSignalAtDetection,
              hivolLopaceAtDetection,
            };
            } // end suppression check
            else {
              // Suppressed near-level audit: write SHADOW row so user can verify suppression decisions.
              // FIXED 2026-07-27 (found via a direct user question about last week's shadow P&L):
              // this used to write ONLY setup_type/fired_at/price_at_detection -- no entry/stop/
              // target/expires_at at all -- so these rows could NEVER resolve via resolveSetupsByPrice()
              // (nothing to walk against) and NEVER counted toward backtest_setup_status.mjs's N
              // (which requires resolution IN ('TARGET_HIT','STOP_HIT')). Confirmed live: 64 of these
              // fired in a single week with zero path to ever produce a real P&L or grow the gating
              // sample size -- a full dead end by this codebase's own standing rule, not just a
              // missing-stat cosmetic gap. Now computes the exact same entry/stop/target a live
              // (non-suppressed) candidate would have gotten (same liveStats._opt[type] lookup,
              // same STOP/TARGET fallback), so these rows resolve normally and their outcome
              // actually answers "was this suppression decision correct" in dollar terms.
              const suppressReason = clusterAlreadyFired ? 'CLUSTER_ALREADY_FIRED'
                : sameTypeRecentlyFired ? 'SAME_TYPE_REFIRE_COOLDOWN'
                : liveStats._suppressedSetups?.has(type) ? 'SUPPRESSED_FADE'
                : liveStats._dowSuppressToday?.has(type) ? 'DOW_SUPPRESSED'
                : isS2DoubleCounter(dir) ? 'S2_DOUBLE_COUNTER'
                : isTrendCounterFade(dir) ? 'TREND_COUNTER_FADE' : 'SUPPRESSED_OTHER';
              const auditOptStop = liveStats._opt?.[type];
              const auditStopPts = auditOptStop?.stop ?? Math.round(lv.mae_p75 ?? STOP);
              const auditTargetPts = auditOptStop?.target ?? Math.round(lv.mfe ?? TARGET);
              const auditStopLevel = isLong ? currentPrice - auditStopPts : currentPrice + auditStopPts;
              const auditT1Level = isLong ? currentPrice + auditTargetPts : currentPrice - auditTargetPts;
              // Self-contained expiry calc (4PM ET RTH close, rolled to next day if already past) --
              // deliberately NOT calling the shared computeExpiry()/fmtETStr() helpers further down
              // in this same function: both are `const` closures defined later in this handler's
              // execution order, so they're not yet in scope at this earlier point (would throw a
              // temporal-dead-zone ReferenceError). Mirrors their exact non-special-cased logic.
              const auditEtNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
              const auditSessionEnd = new Date(auditEtNow);
              auditSessionEnd.setHours(16, 0, 0, 0);
              if (auditSessionEnd <= auditEtNow) auditSessionEnd.setDate(auditSessionEnd.getDate() + 1);
              const auditExpiresAt = `${auditSessionEnd.getFullYear()}-${String(auditSessionEnd.getMonth() + 1).padStart(2, '0')}-${String(auditSessionEnd.getDate()).padStart(2, '0')} ${String(auditSessionEnd.getHours()).padStart(2, '0')}:${String(auditSessionEnd.getMinutes()).padStart(2, '0')}:00`;
              // historical_win_rate/historical_sessions were never populated on this INSERT path
              // (only the live-candidate ACTIVE/non-suppressed path set them) -- found 2026-07-28
              // directly from a user report of "WR at Fire" showing empty on real, today-fired
              // SHADOW rows. The data was already in scope two blocks up (liveStats._setupStats,
              // built from the same SETUP_STATUS query that built _suppressedSetups) and simply
              // never got read here. Same source SetupHistoryView.jsx's "WR at Fire" column reads.
              const auditStats = liveStats._setupStats?.[type];
              const auditRegimeStamp = computeRegimeStamp(currentPrice, await getValueAreaRegimeMap(todayET).catch(() => ({})));
              const auditFireTags = await computeFireTags(todayET, 'RTH', etMin);
              await query(`
                INSERT INTO active_setups (
                  trade_date, setup_type, fired_at, price_at_detection, status, origin_status,
                  suppression_reason, confluence_score_at_detection, confluence_levels_at_detection,
                  entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label, expires_at,
                  historical_win_rate, historical_sessions, ${REGIME_STAMP_COLS.join(', ')}, ${FIRE_TAG_COLS.join(', ')}, bet_class
                )
                VALUES ($1,$2,NOW(),$3,'SHADOW','SHADOW',$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13,
                  ${REGIME_STAMP_COLS.map((_, i) => `$${14 + i}`).join(', ')},
                  ${FIRE_TAG_COLS.map((_, i) => `$${14 + REGIME_STAMP_COLS.length + i}`).join(', ')},
                  $${14 + REGIME_STAMP_COLS.length + FIRE_TAG_COLS.length})
                ON CONFLICT DO NOTHING
              `, [
                todayET, type, currentPrice, suppressReason,
                nearLevels.length,
                nearLevels.length ? nearLevels.map(l => l.name) : null,
                currentPrice, auditStopLevel, auditT1Level,
                `T1: ${auditTargetPts}pt · Stop: ${auditStopPts}pt (suppressed audit)`,
                auditExpiresAt,
                auditStats?.wr ?? null, auditStats?.n ?? null,
                ...regimeStampValues(auditRegimeStamp),
                ...fireTagValues(auditFireTags),
                getBetClass(type),
              ]).catch(() => {});
              // Tag the anchor trade with this attributed setup, so the trade detail modal can
              // show "this execution also represents: X, Y, Z" -- the whole point of tracking
              // this dedup, per the user's explicit ask, is that every level still gets credit
              // (this SHADOW row still resolves normally and counts toward that level's own
              // calibration N) while the anchor's live P&L isn't multiplied by however many
              // levels happened to be stacked in the same zone.
              if (clusterAlreadyFired) {
                await query(`
                  UPDATE active_setups
                  SET cluster_attributed_setups = array_append(COALESCE(cluster_attributed_setups, ARRAY[]::text[]), $2)
                  WHERE id = $1 AND NOT ($2 = ANY(COALESCE(cluster_attributed_setups, ARRAY[]::text[])))
                `, [clusterAlreadyFired.id, type]).catch(() => {});
              }
            }
          }

          // ── Approach alert — pre-touch early warning ─────────────────────
          // Fires a WebSocket event when price is 15–30pt from a level AND the
          // last 2 bars show net movement toward it. Gives ~60s advance notice
          // (median lead-time from backtest: 60s, 42% coverage). Does not write
          // to active_setups — purely a real-time push to the frontend.
          // Threshold: 30pt derived from backtest distribution (avg_dist - 0.5σ).
          if (last5.length >= 2) {
            const prevBar = last5[last5.length - 2];
            const lastBar = last5[last5.length - 1];
            const approachingLevels = keepLevels.filter(lv => {
              const dist = Math.abs(currentPrice - lv.level);
              if (dist < 15 || dist > 30) return false; // outside approach zone
              const movingToward = lv.level > currentPrice
                ? lastBar.close > prevBar.close  // approaching from below (resistance)
                : lastBar.close < prevBar.close; // approaching from above (support)
              return movingToward;
            });
            // Filter to quality levels only (EV >= $20) and apply per-level cooldown
            const qualityApproaching = approachingLevels.filter(lv => {
              if ((lv.ev ?? -999) < APPROACH_MIN_EV) return false;
              const lastEmit = _approachCooldown.get(lv.name);
              return !lastEmit || (Date.now() - lastEmit) > APPROACH_COOLDOWN_MS;
            });
            if (qualityApproaching.length > 0) {
              const top = qualityApproaching.reduce((best, lv) =>
                Math.abs(currentPrice - lv.level) < Math.abs(currentPrice - best.level) ? lv : best,
                qualityApproaching[0]);
              _approachCooldown.set(top.name, Date.now());
              const dist = Math.round(Math.abs(currentPrice - top.level));
              const dir = top.level > currentPrice ? 'RESISTANCE' : 'SUPPORT';
              // Confluence: any other keepLevels within 15pt of THIS level (not of currentPrice)
              const nearThisLevel = keepLevels.filter(lv =>
                lv.name !== top.name && Math.abs(top.level - lv.level) <= 15
              );
              io.emit('level-approaching', {
                level: top.level,
                levelName: top.name,
                currentPrice,
                distance: dist,
                direction: dir,
                ev: top.ev,
                wr: top.wr,
                n: top.n,
                confluenceCount: nearThisLevel.length,
                confluenceLevels: nearThisLevel.map(l => l.name),
                tier: top.ev >= 50 ? 'PRIME' : top.ev >= 20 ? 'SOLID' : top.ev >= 0 ? 'MARGINAL' : 'WEAK',
                timestamp: new Date().toISOString(),
              });
            }
          }

          // ── Early-touch backfill ──────────────────────────────────────────
          // For every KEEP level NOT currently near price (liveNear false this poll),
          // scan all RTH bars collected so far (9:30→now, includes bars from before the
          // 60-bar gate opened) for the earliest bar whose range came within 15pt of the
          // level. If found, that's the day's real first touch — record it for stats even
          // though the live banner path above already missed its window. Idempotent: the
          // actual INSERT (later, near the shadowCandidates persist block) checks for an
          // existing row first and is also ON CONFLICT DO NOTHING-protected.
          for (const lv of keepLevels) {
            if (Math.abs(currentPrice - lv.level) <= 15) continue; // live path already covers this
            const touchIdx = allRthBarsRow.rows.findIndex(b => b.low <= lv.level + 15 && b.high >= lv.level - 15);
            if (touchIdx === -1) continue;
            const touchBar = allRthBarsRow.rows[touchIdx];
            const priorBar = touchIdx > 0 ? allRthBarsRow.rows[touchIdx - 1] : null;
            const touchApproachDir = priorBar
              ? (priorBar.close < lv.level ? 'FROM_BELOW' : 'FROM_ABOVE')
              : (touchBar.open < lv.level ? 'FROM_BELOW' : 'FROM_ABOVE');
            const isLong = touchApproachDir === 'FROM_ABOVE';
            const dir = isLong ? 'LONG' : 'SHORT';
            const btType = resolveSetupType(`${lv.name}_${dir}`, lv);
            if (liveStats._suppressedSetups?.has(btType) || liveStats._dowSuppressToday?.has(btType) || isS2DoubleCounter(dir) || isTrendCounterFade(dir)) continue;
            {
            const btOpt  = liveStats._opt?.[btType];
            const btStop = btOpt?.stop   ?? Math.round(lv.mae_p75 ?? STOP);
            const btTgt  = btOpt?.target ?? Math.round(lv.mfe     ?? TARGET);
            backfilledTouches.push({
              type: btType,
              direction: dir,
              entry: touchBar.close,
              stop: isLong ? touchBar.close - btStop : touchBar.close + btStop,
              target: isLong ? touchBar.close + btTgt : touchBar.close - btTgt,
              targetLabel: `T1: ${btTgt}pt · Stop: ${btStop}pt · EV: $${lv.ev?.toFixed(0) ?? '--'} (backfilled early touch)`,
              etMin: touchBar.et_min,
              history: { winRate: lv.wr, occurrences: lv.n, avgPnl: lv.ev, t1HitRate: lv.wr },
            });
            } // end btType block
          }
        }
      }

      // ── Stop Sweep detection ──────────────────────────────────────────────
      // Price breaks through a key level (ONL, PDL, IB Low/High, session low/high),
      // traps traders, then reverses. Backtested: 198 sweeps/90d, avg 80pt reversal.
      // ── Stop Sweep detection (confluence-gated) ─────────────────────────
      // Raw sweeps lose money (35-41% WR). Only flag when sweep level is within
      // 30pt of another key level (2D VAL/VAH, Floor S1/R1, PW Low/High) — that's
      // the confluence that makes the reversal stick.
      let stopSweepSetup = null;
      if (currentPrice && allRthBarsRow.rows.length >= 30) {
        const recentBars = allRthBarsRow.rows.slice(-10);

        // Sweep reference levels
        const onBarsRes = await query(
          `SELECT MAX(high)::float as hi, MIN(low)::float as lo FROM price_bars_primary
           WHERE symbol='NQ' AND ts::date=$1
           AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) NOT BETWEEN 570 AND 959`, [todayET]).catch(() => ({ rows: [] }));
        const onHigh = onBarsRes.rows[0]?.hi;
        const onLow = onBarsRes.rows[0]?.lo;
        const pdBarsRes = await query(
          `SELECT MAX(high)::float as hi, MIN(low)::float as lo FROM price_bars_primary
           WHERE symbol='NQ' AND ts::date = (SELECT MAX(ts::date) FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1)
           AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959`, [todayET]).catch(() => ({ rows: [] }));
        const pdHi = pdBarsRes.rows[0]?.hi, pdLo = pdBarsRes.rows[0]?.lo;

        const sweepLevels = [
          onLow && { name: 'ONL', price: onLow, side: 'LOW' },
          onHigh && { name: 'ONH', price: onHigh, side: 'HIGH' },
          pdLo && { name: 'PDL', price: pdLo, side: 'LOW' },
          pdHi && { name: 'PDH', price: pdHi, side: 'HIGH' },
          ibLow && { name: 'IB_LOW', price: ibLow, side: 'LOW' },
          ibHigh && { name: 'IB_HIGH', price: ibHigh, side: 'HIGH' },
        ].filter(Boolean);

        // Confluence levels to check against
        const confLevels = [pdVAH, pdVAL, pdPOC, floorS1, floorR1, floorP].filter(Boolean);
        // Add PW low/high
        const pwRes = await query(
          `SELECT MAX(high)::float as hi, MIN(low)::float as lo FROM price_bars_primary
           WHERE symbol='NQ' AND ts::date >= ($1::date - interval '7 days') AND ts::date < $1
           AND EXTRACT(dow FROM ts::date) BETWEEN 1 AND 5
           AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959`, [todayET]).catch(() => ({ rows: [] }));
        if (pwRes.rows[0]?.lo) confLevels.push(pwRes.rows[0].lo);
        if (pwRes.rows[0]?.hi) confLevels.push(pwRes.rows[0].hi);
        // PW composite VA
        const pwVABars = await query(
          `SELECT close::float, volume::bigint as vol FROM price_bars_primary
           WHERE symbol='NQ' AND ts::date >= ($1::date - interval '7 days') AND ts::date < $1
           AND EXTRACT(dow FROM ts::date) BETWEEN 1 AND 5
           AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959`, [todayET]).catch(() => ({ rows: [] }));
        if (pwVABars.rows.length > 100) {
          const vbk = {};
          for (const b of pwVABars.rows) { const bk = Math.round(b.close / 25) * 25; vbk[bk] = (vbk[bk] || 0) + Number(b.vol || 0); }
          const sorted = Object.entries(vbk).sort((a, b) => b[1] - a[1]);
          const totalV = sorted.reduce((s, [, v]) => s + v, 0);
          let cumV = 0; const vaLevels = [];
          for (const [price, vol] of sorted) { cumV += vol; vaLevels.push(parseFloat(price)); if (cumV >= totalV * 0.7) break; }
          const pwVAH = Math.max(...vaLevels);
          const pwVAL = Math.min(...vaLevels);
          confLevels.push(pwVAH, pwVAL);
        }

        for (const level of sweepLevels) {
          if (stopSweepSetup) break;
          // Confluence gate: sweep level must be within 30pt of another key level
          const nearConf = confLevels.some(c => Math.abs(c - level.price) <= 30);
          if (!nearConf) continue;
          const confNames = [];
          if (pdVAL && Math.abs(pdVAL - level.price) <= 30) confNames.push(`2D VAL (${Math.round(pdVAL)})`);
          if (pdVAH && Math.abs(pdVAH - level.price) <= 30) confNames.push(`2D VAH (${Math.round(pdVAH)})`);
          if (pdPOC && Math.abs(pdPOC - level.price) <= 30) confNames.push(`2D POC (${Math.round(pdPOC)})`);
          if (floorS1 && Math.abs(floorS1 - level.price) <= 30) confNames.push(`Floor S1 (${Math.round(floorS1)})`);
          if (floorR1 && Math.abs(floorR1 - level.price) <= 30) confNames.push(`Floor R1 (${Math.round(floorR1)})`);

          if (level.side === 'LOW') {
            const brokeBelow = recentBars.some(b => b.low < level.price - 3);
            const nowAbove = currentPrice > level.price;
            const recentLow = Math.min(...recentBars.map(b => b.low));
            const extension = level.price - recentLow;
            const bounce = currentPrice - recentLow;
            if (brokeBelow && nowAbove && extension > 3 && extension < 50 && bounce > 15) {
              // FIXED 2026-07-17: hand-typed history{winRate:0.55, occurrences:198} — real SETUP_STATUS
              // data is THIN_N with N=3-7. Same "never fabricate a stat" violation fixed elsewhere
              // this session (docs/OPEN_THREADS.md).
              const _sweepLongStats = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._setupStats?.STOP_SWEEP_LONG;
              // Target was a flat hardcoded entry+30 until 2026-08-05 (test_invariants.mjs check [8]
              // flagged this live -- the ONE of 7 flagged types that turned out to be a genuine
              // "never reads OPTIMAL_STOP" bug, not a fired-before-calibration-existed timing
              // artifact like the other 6). PAUSED same day, before any live fire occurred:
              // STOP_SWEEP_LONG/SHORT are two of this system's few genuinely real-data-dominated
              // stop populations (zero BACKFILL contamination), and the calibration source
              // (sweepOptimalStopAndTarget()) has a confirmed order-blind EV check (defect #5,
              // OPEN_DECISION order_blind_evaluation_pattern_sweep) -- reverted to the flat 30pt
              // value deliberately rather than trust a calibrated number from a known-biased
              // selector on a population worth protecting. Re-enable only after that defect is
              // fixed. See OPEN_DECISION stop_sweep_long_calibrated_target_pause_or_keep.
              stopSweepSetup = {
                type: 'STOP_SWEEP_LONG',
                direction: 'LONG',
                entry: currentPrice,
                stop: Math.round(recentLow - 5),
                target: Math.round(currentPrice + 30),
                targetLabel: `${level.name} sweep bounce`,
                description: `Price swept below ${level.name} (${Math.round(level.price)}) by ${Math.round(extension)}pt, now reversing. Confluence: ${confNames.join(', ')}. Stop below sweep low (${Math.round(recentLow)}).\n\nEDGE: ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('STOP_SWEEP_LONG') ?? 'not yet calibrated'} overall.`,
                history: (_sweepLongStats && _sweepLongStats.n >= 20)
                  ? { winRate: _sweepLongStats.wr, occurrences: _sweepLongStats.n, avgPnl: _sweepLongStats.ev, t1HitRate: _sweepLongStats.wr }
                  : { winRate: null, occurrences: null, avgPnl: null, t1HitRate: null },
              };
            }
          } else {
            const brokeAbove = recentBars.some(b => b.high > level.price + 3);
            const nowBelow = currentPrice < level.price;
            const recentHigh = Math.max(...recentBars.map(b => b.high));
            const extension = recentHigh - level.price;
            const drop = recentHigh - currentPrice;
            if (brokeAbove && nowBelow && extension > 3 && extension < 50 && drop > 15) {
              // FIXED 2026-07-17: same fabricated-history fix as STOP_SWEEP_LONG above.
              const _sweepShortStats = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._setupStats?.STOP_SWEEP_SHORT;
              // PAUSED 2026-08-05 alongside STOP_SWEEP_LONG -- see comment there and
              // OPEN_DECISION stop_sweep_long_calibrated_target_pause_or_keep.
              stopSweepSetup = {
                type: 'STOP_SWEEP_SHORT',
                direction: 'SHORT',
                entry: currentPrice,
                stop: Math.round(recentHigh + 5),
                target: Math.round(currentPrice - 30),
                targetLabel: `${level.name} sweep fade`,
                description: `Price swept above ${level.name} (${Math.round(level.price)}) by ${Math.round(extension)}pt, now reversing. Confluence: ${confNames.join(', ')}. Stop above sweep high (${Math.round(recentHigh)}).\n\nEDGE: ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('STOP_SWEEP_SHORT') ?? 'not yet calibrated'} overall.`,
                history: (_sweepShortStats && _sweepShortStats.n >= 20)
                  ? { winRate: _sweepShortStats.wr, occurrences: _sweepShortStats.n, avgPnl: _sweepShortStats.ev, t1HitRate: _sweepShortStats.wr }
                  : { winRate: null, occurrences: null, avgPnl: null, t1HitRate: null },
              };
            }
          }
        }
      }

      // ── Setup B: Failed Sweep Reversal (roadmap Phase 4, Stage 2, 2026-08-11) ──────
      // Distinct from STOP_SWEEP_LONG/SHORT above -- Setup B was validated against a
      // DIFFERENT, wider level set with NO confluence-proximity requirement
      // (PD_POC/PD_VAH/PD_VAL/OR5_HIGH/OR5_LOW/FLOOR_PIVOT/FLOOR_R1/FLOOR_S1), via the real
      // detectStopSweep() bar-history detector (backtest_unified.js, reused not
      // reimplemented) in scripts/backtest_setup_b_failed_sweep_reversal_stage1.mjs.
      // Stage 0: RESEARCH_CLAIM setup_b_failed_sweep_reversal_stage0. Stage 1 result:
      // RESEARCH_CLAIM setup_b_failed_sweep_reversal_stage1 (PASSED -- N=803,
      // rigor.clean=true, OOS_EV=$12.99 beats a flat volatility-scaled default's
      // OOS_EV=$2.00; stop=68pt/target=250pt). Day-type breakdown found in Stage 1 is
      // worth reading before trusting the aggregate: BALANCE was net-NEGATIVE (-$23.3/
      // trade, N=469, the majority bucket) while TREND (+$74.76) and TURBULENT (+$43.48)
      // carried the positive aggregate -- the opposite of the Stage 0 pre-registered
      // expectation ("works in both BALANCE and TURBULENT"). Not day-type-gated here
      // (Stage 2 is SHADOW-only, zero capital risk either way; day-type conditioning is a
      // natural post-Stage-2 refinement once real fires accumulate, matching how
      // IB_BULLISH/IB_BEARISH later became DAY_TYPE_MANAGED).
      //
      // IMPORTANT CAVEAT, stated plainly rather than silently: this live block is a
      // ROLLING-WINDOW ADAPTATION of the swept-then-reclaimed condition (matching this
      // file's own live-polling convention, same adaptation the STOP_SWEEP block above
      // already makes), NOT a byte-identical port of detectStopSweep()'s whole-session
      // bar-pattern scan -- that function is shaped for a one-time historical replay, not
      // a live "check only what's new since last poll" loop. Reconciliation (Stage 3) is
      // exactly the roadmap's built-in mechanism for catching and correcting any material
      // gap between this live adaptation and the Stage 1 backtest -- do not skip Stage 3
      // once real SHADOW fires accumulate.
      // Wrapped in its own try/catch (2026-08-11): this route's own outer catch (see the
      // handler's final `catch(e)` clause) turns any uncaught exception here into a 500 for
      // the ENTIRE /api/acd/setup-detection response -- degrading every other live setup,
      // not just this brand-new SHADOW-only one. A local failure here should cost Setup B's
      // own fire for this poll, nothing more.
      let failedSweepReversalSetup = null;
      try {
      if (currentPrice && allRthBarsRow.rows.length >= 30) {
        const fsrRecentBars = allRthBarsRow.rows.slice(-10);
        const fsrLevels = [
          pdPOC != null && { name: 'PD_POC', price: pdPOC },
          pdVAH != null && { name: 'PD_VAH', price: pdVAH },
          pdVAL != null && { name: 'PD_VAL', price: pdVAL },
          floorP != null && { name: 'FLOOR_PIVOT', price: floorP },
          floorR1 != null && { name: 'FLOOR_R1', price: floorR1 },
          floorS1 != null && { name: 'FLOOR_S1', price: floorS1 },
        ].filter(Boolean);
        // Today's opening range -- fetched fresh (not already in scope in this block,
        // unlike pdPOC/pdVAH/pdVAL/floorP/floorR1/floorS1 which the STOP_SWEEP block
        // above already computed and left in scope).
        const fsrOrRow = await query(
          `SELECT or_high::float as or_high, or_low::float as or_low FROM acd_daily_log WHERE trade_date=$1`,
          [todayET]
        ).catch(() => ({ rows: [] }));
        if (fsrOrRow.rows[0]?.or_high != null) fsrLevels.push({ name: 'OR5_HIGH', price: fsrOrRow.rows[0].or_high });
        if (fsrOrRow.rows[0]?.or_low != null) fsrLevels.push({ name: 'OR5_LOW', price: fsrOrRow.rows[0].or_low });

        const fsrOpt = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._opt;
        for (const lvl of fsrLevels) {
          if (failedSweepReversalSetup) break;
          const fsrBrokeBelow = fsrRecentBars.some(b => b.low < lvl.price - 3);
          const fsrBrokeAbove = fsrRecentBars.some(b => b.high > lvl.price + 3);
          if (fsrBrokeBelow && currentPrice > lvl.price) {
            const type = 'FAILED_SWEEP_REVERSAL_LONG';
            // Fallback literals only cover the narrow window before the OPTIMAL_STOP seed
            // row (scripts/backtest_setup_b_failed_sweep_reversal_stage1.mjs's own result,
            // stop=68/target=250) exists or if this lookup fails -- matches the same
            // bootstrap-default-then-real-data-overrides pattern already used throughout
            // this file's keepLevelsAll entries (mae_p75/mfe literals overridden by ls()).
            const stopPts = fsrOpt?.[type]?.stop ?? 68;
            const targetPts = fsrOpt?.[type]?.target ?? 250;
            failedSweepReversalSetup = {
              type, direction: 'LONG', entry: currentPrice,
              stop: Math.round(currentPrice - stopPts),
              target: Math.round(currentPrice + targetPts),
              targetLabel: `${lvl.name} sweep reversal (Setup B)`,
              description: `Price swept below ${lvl.name} (${Math.round(lvl.price)}), now reclaimed above. Stage 1 bar-history backtest: stop ${stopPts}pt / target ${targetPts}pt (N=803, rigor-clean).`,
              history: { winRate: null, occurrences: null, avgPnl: null, t1HitRate: null },
            };
          } else if (fsrBrokeAbove && currentPrice < lvl.price) {
            const type = 'FAILED_SWEEP_REVERSAL_SHORT';
            const stopPts = fsrOpt?.[type]?.stop ?? 68;
            const targetPts = fsrOpt?.[type]?.target ?? 250;
            failedSweepReversalSetup = {
              type, direction: 'SHORT', entry: currentPrice,
              stop: Math.round(currentPrice + stopPts),
              target: Math.round(currentPrice - targetPts),
              targetLabel: `${lvl.name} sweep reversal (Setup B)`,
              description: `Price swept above ${lvl.name} (${Math.round(lvl.price)}), now reclaimed below. Stage 1 bar-history backtest: stop ${stopPts}pt / target ${targetPts}pt (N=803, rigor-clean).`,
              history: { winRate: null, occurrences: null, avgPnl: null, t1HitRate: null },
            };
          }
        }
      }
      } catch (fsrErr) {
        console.error('[setup-detection] FAILED_SWEEP_REVERSAL block error (isolated, not fatal):', fsrErr.message);
        failedSweepReversalSetup = null;
      }

      // ── Priority selection (spec order) ──────────────────────────────────────
      // Integrity guard: a setup must not fire with the stop on the wrong side of
      // entry (non-positive risk — e.g. VALUE_AREA_RESPONSIVE's ±8pt buffer can land
      // past entry relative to where price already is vs the prior-day value area,
      // and OPEN_DRIVE's orL-2/orH+2 stop can do the same when price has already
      // drifted past the OR boundary by fire time). Such a setup is pre-invalidated
      // at the moment of detection — reject it and fall through to the next-priority
      // candidate rather than persisting a guaranteed-instant-stop "setup".
      // ── Edge-based filtering ─────────────────────────────────────────────
      // Backtested 12mo forward-bar directional WR vs baseline (June 2025–2026).
      // Removed: setups with negative directional edge at baseline.
      // Gated: setups that only work with PD-2 VA confluence.
      // NL30 counter-trend suppression: counter-trend setups = 40.2% WR (below baseline).
      const isNL30Aligned = (dir) =>
        (dir === 'LONG' && nl30State === 'BULLISH') || (dir === 'SHORT' && nl30State === 'BEARISH');
      const isNL30Counter = (dir) =>
        (dir === 'LONG' && nl30State === 'BEARISH') || (dir === 'SHORT' && nl30State === 'BULLISH');
      // OR width σ-based classification from trailing 90-day OR width distribution (no static 47.5/91.5)
      const trailingORW = await getTrailingORWidths(todayET, 90);
      const orStats = trailingORW.length >= MIN_SAMPLES ? rollingStats(trailingORW) : { mean: 65, std: 20 };
      const tightORThreshold = orStats.mean - orStats.std;  // -1σ = tight
      const wideORThreshold = orStats.mean + orStats.std;    // +1σ = wide
      const isTightOR = orRange != null && orRange < tightORThreshold;
      const isWideOR = orRange != null && orRange > wideORThreshold;
      // nearPD2VA already computed above after pd2VA initialization

      // Compression confluence: VWAP within 15pt of PD-2 VA level
      // When VWAP sits on PD-2 VA, WR = 70.4% (N=27) vs 46.9% when apart.
      // The "anti-confluence paradox" — VWAP alone hurts (-1.3%), but VWAP
      // confirming PD-2 creates a 72.5% zone (N=40). Gate: distance ≤15pt.
      let cumPV = 0, cumTV = 0;
      for (const b of allRthBarsRow.rows) {
        cumPV += (b.high + b.low + b.close) / 3 * (Number(b.vol) || 1);
        cumTV += (Number(b.vol) || 1);
      }
      const liveVwap = cumTV > 0 ? cumPV / cumTV : null;
      const vwapPD2compressed = liveVwap && (
        (pd2VAH && Math.abs(liveVwap - pd2VAH) <= 15) ||
        (pd2VAL && Math.abs(liveVwap - pd2VAL) <= 15)
      );

      // Overnight structural reads — data variables for trade brief + conviction section below.
      // isOvernightAligned, isOvernightCounter, isS2DoubleCounter are defined ABOVE (before the
      // level fade section at ~line 3786) to fix TDZ bug. Only the data bindings follow here.
      const arRow2 = await query(`SELECT overnight_inventory, open_vs_prior_value, prior_day_profile FROM auction_reads WHERE trade_date=$1`, [todayET]).catch(() => ({ rows: [] }));
      const overnightInv = arRow2.rows[0]?.overnight_inventory;
      const openVsValue = arRow2.rows[0]?.open_vs_prior_value;
      const priorDayProfile = arRow2.rows[0]?.prior_day_profile;

      // Suppress only on DOUBLE headwind: NL30 counter AND overnight counter (20% WR).
      // NL30 counter alone = 33% WR but IB_BEARISH is 52% and TURBULENT days are 67%.
      // Let the triple-stack conviction system handle sizing, not blanket suppression.
      // Sequential gate: if first setup of the day FAILED, suppress C_STANDALONE in same direction
      // Death sequences: OTD fails → C_STANDALONE = 9-14% WR. After prior win → next WR 52% vs 41.8% after loss.
      const priorSetupsQ = await query(`
        SELECT setup_type, resolution,
          CASE WHEN setup_type LIKE '%LONG%' OR setup_type LIKE '%BULLISH%' OR setup_type LIKE '%_UP' THEN 'LONG' ELSE 'SHORT' END as dir
        FROM active_setups WHERE trade_date=$1 AND status='RESOLVED' ORDER BY fired_at
      `, [todayET]).catch(() => ({ rows: [] }));
      const priorSetups = priorSetupsQ.rows;
      const lastPrior = priorSetups[priorSetups.length - 1];
      const priorFailed = lastPrior && lastPrior.resolution !== 'TARGET_HIT';
      const priorFailedDir = priorFailed ? lastPrior.dir : null;

      const suppressIfDeathSequence = (setup) => {
        if (!setup) return null;
        if (!priorFailedDir) return setup;
        // If prior setup failed and this is C_STANDALONE in the SAME direction → 9-14% WR death sequence
        if ((setup.type === 'C_STANDALONE_UP' && priorFailedDir === 'LONG') || (setup.type === 'C_STANDALONE_DOWN' && priorFailedDir === 'SHORT')) {
          logGatedCandidate({ tradeDate: todayET, setupType: setup.type, gateName: 'C_STANDALONE_DEATH_SEQUENCE', gateReason: `prior setup failed same-direction (${priorFailedDir}), 9-14% WR death sequence`, entry: setup.entry, stop: setup.stop, target: setup.target });
          return null;
        }
        return setup;
      };

      // POC migration filter: 2-day consecutive POC migration direction
      // Aligned with setup: 54.2% WR. Counter: 41.5% WR. Delta: +12.7%.
      const pocMigQ = await query(`
        SELECT migration_dir_vs_prior FROM developing_value_log
        WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 2
      `, [todayET]).catch(() => ({ rows: [] }));
      const pocMig = pocMigQ.rows;
      const pocStreakUp = pocMig.length >= 2 && pocMig[0].migration_dir_vs_prior === 'HIGHER' && pocMig[1].migration_dir_vs_prior === 'HIGHER';
      const pocStreakDn = pocMig.length >= 2 && pocMig[0].migration_dir_vs_prior === 'LOWER' && pocMig[1].migration_dir_vs_prior === 'LOWER';
      const pocDir = pocStreakUp ? 'HIGHER' : pocStreakDn ? 'LOWER' : null;

      const suppressIfPOCCounter = (setup) => {
        if (!setup || !pocDir) return setup;
        // If POC is migrating HIGHER but setup is SHORT (or vice versa) → counter, suppress
        const isCounter = (setup.direction === 'LONG' && pocDir === 'LOWER') || (setup.direction === 'SHORT' && pocDir === 'HIGHER');
        if (isCounter) {
          logGatedCandidate({ tradeDate: todayET, setupType: setup.type, gateName: 'C_STANDALONE_POC_COUNTER', gateReason: `counter to 2-day POC migration (${pocDir})`, entry: setup.entry, stop: setup.stop, target: setup.target });
          return null;
        }
        return setup;
      };

      // ── ZONE EDGE FADE detection (ATR-scaled, 45% WR, +$736/yr backtested) ──
      let zoneEdgeFade = null;
      if (currentPrice && allRthBarsRow.rows.length >= 20) {
        // Compute 14-bar ATR from session bars
        const rthBars = allRthBarsRow.rows;
        let atrSum = 0;
        for (let ai = Math.max(1, rthBars.length - 14); ai < rthBars.length; ai++) atrSum += rthBars[ai].high - rthBars[ai].low;
        const atr14 = atrSum / Math.min(14, rthBars.length - 1);

        // Check if current VA forms a balance zone (overlapping with PD-2)
        const dvlCheck = await query(`SELECT vah::float, val::float FROM developing_value_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 2`, [todayET]).catch(() => ({ rows: [] }));
        if (dvlCheck.rows.length >= 2) {
          const pd1v = dvlCheck.rows[0], pd2v = dvlCheck.rows[1];
          const overlaps = pd1v.val <= pd2v.vah && pd1v.vah >= pd2v.val;
          if (overlaps) {
            const zoneLo = Math.min(pd1v.val, pd2v.val), zoneHi = Math.max(pd1v.vah, pd2v.vah);
            const prox = atr14 * 0.08;
            const nearTop = Math.abs(currentPrice - zoneHi) <= prox && currentPrice <= zoneHi + prox;
            const nearBot = Math.abs(currentPrice - zoneLo) <= prox && currentPrice >= zoneLo - prox;

            if (nearTop || nearBot) {
              const isLong = nearBot;
              const stopDist = Math.round(atr14 * 0.05);
              const targetDist = Math.round(atr14 * 0.05);
              const entry = +currentPrice.toFixed(0);
              const stop = isLong ? entry - stopDist : entry + stopDist;
              const target = isLong ? entry + targetDist : entry - targetDist;
              const edgeLabel = nearTop ? `zone ceiling (${Math.round(zoneHi)})` : `zone floor (${Math.round(zoneLo)})`;

              // FIXED 2026-07-17: hand-typed "45% WR, +$736/yr... zone edges fade back 84% of the
              // time" — real SETUP_STATUS data is THIN_N with N=1, EV=-$7. Same "never fabricate a
              // stat" violation fixed elsewhere this session (docs/OPEN_THREADS.md).
              const _zoneEdgeStats = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._setupStats?.ZONE_EDGE_FADE;
              zoneEdgeFade = {
                type: 'ZONE_EDGE_FADE',
                direction: isLong ? 'LONG' : 'SHORT',
                entry, stop, target,
                targetLabel: `${targetDist}pt fade (5%×ATR)`,
                description: `Price at balance ${edgeLabel}. ATR-scaled fade: ${stopDist}pt stop, ${targetDist}pt target. EDGE: ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('ZONE_EDGE_FADE') ?? 'not yet calibrated'} overall.`,
                history: (_zoneEdgeStats && _zoneEdgeStats.n >= 20)
                  ? { winRate: _zoneEdgeStats.wr, occurrences: _zoneEdgeStats.n, avgPnl: _zoneEdgeStats.ev, t1HitRate: _zoneEdgeStats.wr }
                  : { winRate: null, occurrences: null, avgPnl: null, t1HitRate: null },
              };
            }
          }
        }
      }

      // Re-read from cache — liveStats is block-scoped inside the level-fade block above.
      // The block writes it to cache via setCached before closing; this recovers it for the
      // candidates array, the INSERT loop, and any other outer-scope usage.
      const liveStats = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL);

      // ACTIVE candidates — ONLY the 9 KEEP level fades from system backtest.
      // These fire banners, show as actionable setups, and count as trade entries.
      const candidates = [
        levelScalpSetup, // PD_POC / PD_VAL / PD_VAH / FLOOR_PIVOT / FLOOR_R1 / OR5_HIGH / PD_IB_MID / PD_OR_MID / 5D_OR_MID fades
        // IB_BULLISH is now fully SUPPRESSed (2026-07-14, backtest_setup_status.mjs) — every
        // day-type bucket is below breakeven, see docs/OPEN_THREADS.md for the incident. Checked
        // via _suppressedSetups the same way level-fade setup_types are, alongside the existing
        // DOW-specific check. IB_BEARISH remains DAY_TYPE_MANAGED (TURBULENT bucket is genuinely
        // strong) — see the day-type nulling above this candidates array for its per-type gate.
        // DOW suppression via pipeline: Thu×IB_BEARISH EV=-$17 N=27 suppressed as of 2026-07-09.
        (ibSetup
          && !getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._suppressedSetups?.has(ibSetup.type)
          && !getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._dowSuppressToday?.has(ibSetup.type)
        ) ? ibSetup : null,
      ];
      // SHADOW candidates — tracked for forward-testing but NO banners, NO trade alerts.
      // These persist to active_setups with status='SHADOW', resolve against price,
      // and build WR data. Promoted to ACTIVE when positive EV over 30+ forward trades.
      const shadowCandidates = [
        stopSweepSetup,
        failedSweepReversalSetup,
        vwapMagnetSetup,
        globexVwapMagnetRTH,
        globexVwapFadeRTH,
        vwapReclaimShortSetup,
        absorptionSetup,
        coilSurgeSetup,
        zoneEdgeFade,
        trt?.type === 'TRT_LONG' ? trt : null,
        trt?.type === 'TRT_SHORT' ? trt : null,
        trtMah,
        aDownWeak,
        // ibSetup moved to candidates 2026-07-01 — BALANCE suppressed, TREND/TURBULENT promoted
        openDrive,
        openingDrive15Min,
        valueAreaResp,
        // C_STANDALONE: suppressed in HIGH-VOL-CHOP (0% WR), death sequences (9-14% WR), and POC counter direction (41.5% WR)
        morningRegime !== 'HIGH-VOL-CHOP' ? suppressIfPOCCounter(suppressIfDeathSequence(cStandalone)) : null,
        cPairedLong, cPairedShort,
        failedAuction, bracketBreakout,
      ].filter(Boolean);
      // Priority selection: candidates array is ordered by priority.
      // Take the first valid candidate, but check for directional conflicts
      // against already-active setups and apply post-loss size reduction.
      //
      // selected_over (2026-08-10, roadmap item "instrument the one-alert-per-poll selection
      // mechanism"): this is the one place in the codebase where multiple independently-
      // qualifying candidates compete for a SINGLE alert slot and the loser(s) get zero trace
      // -- unlike shadowCandidates below (every qualifier persists as SHADOW) or
      // detectGlobexSetup()'s own candidates loop (every qualifier gets its own row regardless
      // of ACTIVE/SHADOW status), a candidate here that also passed its own risk check but sat
      // behind a higher-priority one in this fixed array order simply vanishes -- no row, no
      // log line, no way to ever ask "how often does IB_BULLISH lose to a level-fade touch
      // purely because of array order, not because it was actually worse that moment." Track
      // every OTHER candidate that also cleared riskOk this poll (not just the winner) so it
      // can be persisted alongside the winning row and made queryable.
      const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      // TEMPORARY DIAGNOSTIC (2026-08-12) — see the matching comment ~6698. Confirms whether
      // levelScalpSetup successfully survived the suppression check above but got dropped here
      // or later (forceShadow ~8399), vs never having been built at all.
      if (cascadeBreaker.active) {
        cascadeDiagLog(`[cascade-diag] candidates-stage levelScalpSetup=${levelScalpSetup ? levelScalpSetup.type : 'null'} candidatesNonNull=${candidates.filter(Boolean).map(c => c.type).join(',') || 'none'}`);
      }
      let active = null;
      const qualifyingThisPoll = [];
      for (const cand of candidates) {
        if (!cand) continue;
        const isLongCand = cand.direction === 'LONG';
        const riskOk = cand.stop == null || (isLongCand ? cand.stop < cand.entry : cand.stop > cand.entry);
        if (!riskOk) {
          console.error(`[setup-detection] REJECTED ${cand.type} — non-positive risk: stop ${cand.stop} vs entry ${cand.entry} (${cand.direction})`);
          logGatedCandidate({ tradeDate: todayET, setupType: cand.type, gateName: 'RISK_CHECK_MAIN', gateReason: `non-positive risk: stop ${cand.stop} vs entry ${cand.entry} (${cand.direction})`, entry: cand.entry, stop: cand.stop, target: cand.target });
          continue;
        }
        qualifyingThisPoll.push(cand);
        if (!active) active = cand;
      }
      if (active) {
        const selectedOver = qualifyingThisPoll.filter(c => c !== active).map(c => c.type);
        active.selectedOver = selectedOver.length ? selectedOver : null;
      }

      if (active) {
        // Directional conflict check: suppress if opposite-direction setup is already active today
        const activeToday = await query(`
          SELECT setup_type, fired_at::text as fired_at FROM active_setups
          WHERE trade_date=$1 AND status='ACTIVE'
        `, [todayET]).catch(() => ({ rows: [] }));
        const oppositeActive = activeToday.rows.find(s => inferDirection(s.setup_type) !== active.direction);
        if (oppositeActive) {
          const conflictReason = `opposite-direction setup already active today: ${oppositeActive.setup_type} (${inferDirection(oppositeActive.setup_type)}) fired ${oppositeActive.fired_at}`;
          console.log(`[setup-detection] CONFLICT: ${active.type} (${active.direction}) vs active ${oppositeActive.setup_type} (${inferDirection(oppositeActive.setup_type)}). Standing aside.`);
          logGatedCandidate({ tradeDate: todayET, setupType: active.type, gateName: 'DIRECTIONAL_CONFLICT_STAND_ASIDE', gateReason: conflictReason, entry: active.entry, stop: active.stop, target: active.target });
          active = null;
        }

        // Build full trade brief: WHY NOW + PACE + SIZE
        if (active) {
          // origin_status='ACTIVE' filter added 2026-07-27 (unify_sizemultiplier_into_validated_score
          // investigation) -- this query predates the origin_status column (written 2026-06-22,
          // column added 2026-07-17) and was never revisited once it existed, matching this
          // codebase's own documented "the concept didn't exist yet" bug class (see the CumPL
          // account-scoping hard rule). Confirmed live: on 6 of the last 23 days, this query
          // counted a loss with ZERO real (ACTIVE-origin) losses that day -- purely BACKFILL-
          // origin rows sharing the same trade_date -- meaning the "Death Sequence" 0.5x ceiling
          // was engaging on ~26% of days for a reason that had nothing to do with the user's own
          // day. Also explains why real active_setups.size_multiplier is 0.500 on 56/57 real
          // level-fade rows checked -- the rich ~20-factor stack's output was being overridden to
          // 0.5x far more often than the "a real prior loss today" concept actually intends.
          const lossesToday = await query(`
            SELECT COUNT(*)::int as count FROM active_setups
            WHERE trade_date=$1 AND origin_status='ACTIVE'
              AND (resolution='STOP_HIT' OR (status='RESOLVED' AND actual_pnl < 0))
          `, [todayET]).catch(() => ({ rows: [{ count: 0 }] }));
          const hasLossToday = (lossesToday.rows[0]?.count || 0) > 0;
          let sizeMult = hasLossToday ? 0.5 : 1.0;

          const aligned = isOvernightAligned(active.direction);
          const counter = isOvernightCounter(active.direction);

          // 20-day range quintile
          const range20Q = await query(`
            SELECT MAX(h) as hi, MIN(l) as lo FROM (
              SELECT MAX(high)::float as h, MIN(low)::float as l
              FROM price_bars_primary WHERE symbol='NQ'
              AND ts::date BETWEEN ($1::date - 20) AND ($1::date - 1)
              AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
              GROUP BY ts::date
            ) x
          `, [todayET]).catch(() => ({ rows: [] }));
          const r20 = range20Q.rows[0];
          let rangeQuintile = null;
          if (r20?.hi && r20?.lo && currentPrice) {
            const pct = (currentPrice - r20.lo) / (r20.hi - r20.lo);
            rangeQuintile = pct >= 0.80 ? 'TOP' : pct >= 0.60 ? 'UPPER' : pct >= 0.40 ? 'MID' : pct >= 0.20 ? 'LOWER' : 'BOT';
          }

          // Day type for triple stack
          const cachedDT = getCached(todayET, 'dayTypeStack');
          let dayTypeForStack;
          if (cachedDT !== undefined) { dayTypeForStack = cachedDT; }
          else {
            const dtRow = await query(`SELECT day_type FROM acd_daily_log WHERE trade_date=$1`, [todayET]).catch(() => ({ rows: [] }));
            dayTypeForStack = dtRow.rows[0]?.day_type || dtClass || null;
            setCached(todayET, 'dayTypeStack', dayTypeForStack);
          }
          const dayTypeLabel = dayTypeForStack === 'TREND' ? 'TREND' : dayTypeForStack === 'BALANCE' ? 'BALANCE' : dayTypeForStack === 'TURBULENT' ? 'TURBULENT' : null;

          // Triple stack conviction assessment
          const alignLabel = aligned ? 'ALIGNED' : counter ? 'COUNTER' : 'NEUTRAL';
          let tripleStack = null;
          // Money combos (from backtest)
          if (alignLabel === 'ALIGNED' && dayTypeLabel === 'TURBULENT') {
            tripleStack = { conviction: 'MAXIMUM', wr: '83-100%', note: 'ALIGNED + TURBULENT is the strongest combo in the system. Every range quintile shows 83%+ WR. Full size with conviction.' };
          } else if (rangeQuintile === 'MID' && alignLabel === 'ALIGNED' && dayTypeLabel === 'TREND') {
            tripleStack = { conviction: 'VERY HIGH', wr: '88%', note: 'MID range + ALIGNED + TREND. Price has room, structure supports, trend confirms. 7 of 8 trades won.' };
          } else if (rangeQuintile === 'MID' && alignLabel === 'ALIGNED' && dayTypeLabel === 'BALANCE') {
            tripleStack = { conviction: 'HIGH', wr: '75%', note: 'MID range + ALIGNED + BALANCE. Sweet spot — balanced auction with structural support.' };
          } else if (rangeQuintile === 'UPPER' && alignLabel === 'ALIGNED' && dayTypeLabel === 'BALANCE') {
            tripleStack = { conviction: 'HIGH', wr: '69%', note: 'UPPER range + ALIGNED + BALANCE. Good room with structural backing.' };
          }
          // Death combos
          else if (alignLabel === 'COUNTER' && dayTypeLabel === 'BALANCE' && (rangeQuintile === 'UPPER' || rangeQuintile === 'LOWER')) {
            tripleStack = { conviction: 'AVOID', wr: '0%', note: `${rangeQuintile} + COUNTER + BALANCE = 0% WR (N=12-18). Do NOT take this trade. Every single one lost.` };
          } else if (alignLabel === 'COUNTER' && dayTypeLabel === 'TREND') {
            tripleStack = { conviction: 'AVOID', wr: '13-27%', note: 'COUNTER + TREND. Fighting momentum with structural headwind. Skip unless you see overwhelming absorption.' };
          } else if (alignLabel === 'COUNTER' && dayTypeLabel === 'BALANCE') {
            tripleStack = { conviction: 'LOW', wr: '25-34%', note: 'COUNTER + BALANCE. Structural headwind in a range day. Reduce size significantly or skip.' };
          }
          // Moderate combos
          else if (alignLabel === 'ALIGNED' && dayTypeLabel === 'BALANCE') {
            tripleStack = { conviction: 'MODERATE', wr: '51-55%', note: 'ALIGNED + BALANCE. Structure supports but no trend confirmation. Standard size, manage normally.' };
          } else if (alignLabel === 'ALIGNED' && dayTypeLabel === 'TREND') {
            tripleStack = { conviction: 'MODERATE', wr: '55%', note: 'ALIGNED + TREND. Good combo. Go with the trend, use structure as confirmation.' };
          }

          // Setup profiles — style/pace/hold describe genuine trade MECHANICS (entry timing,
          // expiry windows, structural gates), which don't go stale the way a backtested WR%
          // does, so they stay static prose. stats/stop/target/bestWR/conviction are built live
          // from liveStats._setupStats / liveStats._opt (cached once per day via getCached,
          // not a fresh query per request — this whole handler is already a hot, expensive
          // endpoint per CLAUDE.md's data-fetching performance rule) instead of the hand-typed
          // WR%/$/N literals this object had until 2026-07-17 (OPEN_DECISION
          // acd_profiles_hardcoded_playbook_stats_table). Several had already drifted
          // measurably from real numbers by the time they were checked: VALUE_AREA_RESPONSIVE_
          // SHORT claimed 18% WR (real ~24%, EV actually positive), C_STANDALONE_DOWN claimed
          // 63% WR while its only construction path was `if (false)`-disabled (dead code at the
          // time) -- entry removed same session. C_STANDALONE_UP/DOWN were both re-enabled to
          // construct again later the same night (user directive: shadow every confirmed-
          // losing setup instead of freezing its data collection entirely), so both have real
          // PROFILES entries again below.
          const _profLS = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL);
          function liveProfile(setupType, style, pace, hold) {
            const stat = _profLS?._setupStats?.[setupType];
            const opt = _profLS?._opt?.[setupType];
            const n = stat?.n ?? null;
            const thin = n != null && n < 20;
            const wrInt = n != null ? Math.round(stat.wr * 100) : null;
            const evStr = n != null ? `${stat.ev >= 0 ? '+' : '-'}$${Math.abs(stat.ev).toFixed(2)}` : null;

            const stats = n == null
              ? 'Not yet calibrated — no fired trades yet.'
              : `WR: ${wrInt}% | EV: ${evStr}/trade | N=${n}${thin ? ' (thin sample — provisional, not yet decisive)' : ''}`;

            const stop = opt
              ? `Stop: ~${opt.stop}pt (sweep-optimal, recalibrated weekly by update_optimal_stops.mjs).`
              : 'Stop: not yet calibrated (no OPTIMAL_STOP row for this setup) — the live entry logic falls back to a structural distance.';
            const target = opt
              ? `Target: ~${opt.target}pt (sweep-optimal). R:R ${opt.stop > 0 ? (opt.target / opt.stop).toFixed(2) : '—'}:1.`
              : 'Target: not yet calibrated for this setup.';

            const bestWR = stat?.recommendation === 'DAY_TYPE_MANAGED'
              ? 'Day-type-dependent — see the live DAY_TYPE_MANAGED bucket breakdown (Alpha Engine Overview / session-start hook), not duplicated here to avoid a second source of truth.'
              : 'No live day-type/alignment breakdown currently meets the N≥20 floor for this setup.';

            const statusNote = stat?.recommendation === 'SUPPRESS'
              ? `⚠️ Currently SUPPRESSED live (N=${n}, EV=${evStr}) — this card is informational only, not an active recommendation.`
              : thin
              ? `Sample is still too thin (N=${n}) to trust as a live edge — treat as unproven.`
              : stat?.recommendation === 'PROMOTE'
              // PROMOTE is based on recent 90-day performance (N≥15, WR≥52%, EV>$0) clearing
              // backtest_setup_status.mjs's bar, which can differ from the all-time stats
              // shown above (e.g. a setup can show negative all-time EV but have genuinely
              // improved in the last 90 days) — spell that out instead of letting the two
              // numbers look contradictory.
              ? `Recently promoted back to live — the last 90 days cleared the bar (N≥15, WR≥52%, EV>$0) even though the all-time stats above can lag that recent improvement.`
              : stat?.recommendation === 'ACTIVE'
              ? 'Confirmed live at current calibration.'
              : '';

            return { style, stats, stop, target, pace, hold, bestWR, conviction: statusNote || 'Standard context.' };
          }

          const PROFILES = {
            'VALUE_AREA_RESPONSIVE_SHORT': liveProfile('VALUE_AREA_RESPONSIVE_SHORT', 'sniper',
              'Quick rejection expected at 2D VAH. Price should stall and reverse within 3-5 bars. If it keeps making new highs after your entry, the fade is failing.',
              'This is a fade at a value-area boundary, not a breakout continuation. Let the calibrated target play out rather than taking an early fixed-point partial — the stop/target pair above is already the EV-optimized pair, not a starting guess.'),
            'IB_BEARISH': liveProfile('IB_BEARISH', 'grinder',
              'Steady selling over 30-60 min. NOT a crash. Expect pullbacks to IB Low — hold through them. If price reclaims IB Low and holds above for 10+ bars, the break is failing.',
              'GRINDER. Be patient — this trade needs time to work. Day-type matters a lot here (see the live day-type breakdown below, not a fixed historical number).'),
            'OPEN_DRIVE_SHORT': liveProfile('OPEN_DRIVE_SHORT', 'scalp',
              "FAST. You know within 15 bars if this works. If no selling follow-through by 10:00 AM, exit. Do not hold past IB close.",
              'Morning trade only. If it is working by 10:00, hold to target. If price is churning sideways, the drive is absorbing and you should cut.'),
            'OPEN_DRIVE_LONG': liveProfile('OPEN_DRIVE_LONG', 'scalp',
              'FAST. Entry on first touch of OR High after pullback. If it bounces, ride. If it slices through OR High, cut immediately.',
              'Know within 15 bars whether this is working. Day type matters more than day-of-week here — check the live breakdown, not a fixed claim.'),
            'TRT_LONG': liveProfile('TRT_LONG', 'grinder',
              'SLOW. This takes 1-2 hours to play out. A+C failed and price pushes through the OR — the reversal grinds, it does not spike. Be patient.',
              "DO NOT CUT EARLY. 120-minute expiry by design (see EXPIRY_WINDOW.TRT_LONG below) — the whole point of this setup is that it takes time to resolve. An early partial defeats the setup's own thesis."),
            'ZONE_EDGE_FADE': liveProfile('ZONE_EDGE_FADE', 'scalp',
              'FAST. Price hits the zone edge and either bounces within 5-10 bars or breaks through. If no fade in 10 bars, the edge is failing — cut or let it expire.',
              'Do NOT hold for runners — this is a balance-zone rotation trade, targeting the other side of the zone or the first structural level inside.'),
            // Re-added 2026-07-17 alongside re-enabling both setups' construction (see the
            // C_STANDALONE block above) -- both are currently SUPPRESS live, so this card will
            // show the ⚠️ SUPPRESSED conviction note automatically via liveProfile().
            'C_STANDALONE_UP': liveProfile('C_STANDALONE_UP', 'sniper',
              'Fast initial move after the C signal confirms. Once price breaks above OR High, trapped shorts can accelerate the rally.',
              'Only fires when no A signal has fired today and no C has already fired — a standalone break, not a confirmation of an existing signal.'),
            'C_STANDALONE_DOWN': liveProfile('C_STANDALONE_DOWN', 'sniper',
              'Fast initial move after the C signal confirms. Once price breaks below OR Low near the PD-2 value area, trapped longs can accelerate the sell-off.',
              'Only fires near a gated PD-2 VA condition — no A signal fired today, no C already fired, and price within 25pt of PD-2 VAH/VAL.'),
          };
          const prof = PROFILES[active.type] || { style: 'standard', pace: 'Monitor price action at entry zone.', bestWR: '', holdNote: '' };

          // Build WHY NOW section
          const whyParts = [];
          if (overnightInv === 'SHORT_TRAPPED' && active.direction === 'SHORT')
            whyParts.push('Short trapped inventory means sellers from overnight are under pressure — forced buying could push against you initially, but structural imbalance favors downside resolution');
          else if (overnightInv === 'LONG_TRAPPED' && active.direction === 'SHORT')
            whyParts.push('Long trapped inventory — overnight longs need to exit. Selling pressure builds as trapped participants capitulate');
          else if (overnightInv === 'SHORT_TRAPPED' && active.direction === 'LONG')
            whyParts.push('Short trapped inventory — overnight shorts are squeezed. Covering creates buying fuel for upside continuation');
          else if (overnightInv === 'LONG_TRAPPED' && active.direction === 'LONG')
            whyParts.push('Long trapped inventory is structural headwind — overnight longs may sell into your rally');

          if (openVsValue === 'BELOW_VALUE' && active.direction === 'SHORT')
            whyParts.push('Open below prior value area confirms institutional selling. Price rejected from value — downside continuation likely');
          else if (openVsValue === 'ABOVE_VALUE' && active.direction === 'LONG')
            whyParts.push('Open above prior value area confirms institutional buying. Value migrating higher — upside continuation likely');
          else if (openVsValue === 'ABOVE_VALUE' && active.direction === 'SHORT')
            whyParts.push('Open above value — you are fading into strength. Structural headwind');
          else if (openVsValue === 'BELOW_VALUE' && active.direction === 'LONG')
            whyParts.push('Open below value — you are buying into weakness. Structural headwind');
          else if (openVsValue === 'INSIDE_VALUE')
            whyParts.push('Open inside value — balanced, no strong structural tilt. Context-dependent');

          if (priorDayProfile === 'NONTREND')
            whyParts.push('Prior day was NONTREND (extreme balance). Today resolves — first sustained directional move has 61% WR (N=23). This is a high-conviction break');
          else if (priorDayProfile === 'TREND')
            whyParts.push('Prior day was a TREND day. Continuation bias — look for pullback entries, not fade entries');
          else if (priorDayProfile === 'NEUTRAL')
            whyParts.push('Prior day was NEUTRAL — unfinished business at yesterday\'s extremes. Expect test of prior range boundary before direction resolves');

          // Nearby confluence levels
          const confParts = [];
          if (active.entry && pd2VAH && Math.abs(active.entry - pd2VAH) <= 25) confParts.push(`PD-2 VAH (${Math.round(pd2VAH)}) — strongest confluence +44.8%`);
          if (active.entry && pd2VAL && Math.abs(active.entry - pd2VAL) <= 25) confParts.push(`PD-2 VAL (${Math.round(pd2VAL)}) — +20.5% controlled edge`);
          if (active.entry && pdVAH && Math.abs(active.entry - pdVAH) <= 25) confParts.push(`2D VAH (${Math.round(pdVAH)}) — +9.6% controlled edge`);
          if (active.entry && pdVAL && Math.abs(active.entry - pdVAL) <= 25) confParts.push(`2D VAL (${Math.round(pdVAL)}) — support level`);
          if (active.entry && pdPOC && Math.abs(active.entry - pdPOC) <= 25) confParts.push(`2D POC (${Math.round(pdPOC)}) — price magnet +9.0%`);

          // Rolling momentum: last 10 resolved trades for this setup
          const momentumQ = await query(`
            SELECT resolution, actual_pnl::float as pnl, trade_date::text as d
            FROM active_setups WHERE setup_type=$1 AND resolution IN ('TARGET_HIT','STOP_HIT')
            ORDER BY trade_date DESC, fired_at DESC LIMIT 10
          `, [active.type]).catch(() => ({ rows: [] }));
          let momentumLine = null;
          if (momentumQ.rows.length >= 3) {
            const recent = momentumQ.rows;
            const recentW = recent.filter(r => r.resolution === 'TARGET_HIT').length;
            const recentWR = (recentW / recent.length * 100).toFixed(0);
            const allTimeWR = prof.stats?.match(/WR:\s*(\d+)%/)?.[1] || '—';
            // Streak
            let streak = 0, streakType = recent[0]?.resolution === 'TARGET_HIT' ? 'win' : 'loss';
            for (const r of recent) { if ((r.resolution === 'TARGET_HIT') === (streakType === 'win')) streak++; else break; }
            const lastWin = recent.find(r => r.resolution === 'TARGET_HIT');
            const lastLoss = recent.find(r => r.resolution === 'STOP_HIT');
            const streakIcon = streakType === 'win' && streak >= 3 ? '🔥' : streakType === 'loss' && streak >= 3 ? '❄️' : streak >= 2 ? (streakType === 'win' ? '📈' : '📉') : '—';
            const momentum = parseInt(recentWR) > parseInt(allTimeWR) + 10 ? 'HOT' : parseInt(recentWR) < parseInt(allTimeWR) - 10 ? 'COOLING' : 'NORMAL';
            momentumLine = `${streakIcon} ${streak}-${streakType} streak | Last ${recent.length}: ${recentW}W/${recent.length - recentW}L (${recentWR}%) vs ${allTimeWR}% all-time`;
            if (lastWin) momentumLine += ` | Last win: ${lastWin.d} $${Math.round(lastWin.pnl)}`;
            if (lastLoss) momentumLine += ` | Last loss: ${lastLoss.d} $${Math.round(lastLoss.pnl)}`;
            if (momentum === 'COOLING') momentumLine += ' — consider reduced size or skip';
          }

          // Assemble trade brief
          const brief = [];

          if (momentumLine) brief.push(`**MOMENTUM:** ${momentumLine}`);

          if (aligned || counter || whyParts.length > 0) {
            brief.push(`**WHY NOW:** ${whyParts.join('. ') || 'No strong overnight directional tilt.'}`);
          }
          if (confParts.length > 0) {
            brief.push(`**CONFLUENCE:** ${confParts.join(' | ')}`);
          }
          brief.push(`**STATS:** ${prof.stats || ''}`);
          brief.push(`**STOP:** ${prof.stop || ''}`);
          brief.push(`**TARGET:** ${prof.target || ''}`);
          brief.push(`**PACE:** ${prof.pace}`);
          brief.push(`**HOLD:** ${prof.hold || prof.holdNote || ''} Best conditions: ${prof.bestWR || 'standard'}.`);
          brief.push(`**CONVICTION:** ${prof.conviction || 'Standard context.'}`);

          // Triple stack assessment
          if (tripleStack) {
            const tsColor = tripleStack.conviction === 'MAXIMUM' || tripleStack.conviction === 'VERY HIGH' ? '🔥' : tripleStack.conviction === 'HIGH' ? '✅' : tripleStack.conviction === 'AVOID' ? '🚫' : tripleStack.conviction === 'LOW' ? '⚠️' : '';
            brief.push(`**TRIPLE STACK:** ${tsColor} ${tripleStack.conviction} conviction (${tripleStack.wr} WR). ${tripleStack.note}`);

            // Flip logic: when AVOID fires, the opposite direction has edge
            if (tripleStack.conviction === 'AVOID') {
              const oppDir = active.direction === 'LONG' ? 'SHORT' : 'LONG';
              const atTop = rangeQuintile === 'TOP' || rangeQuintile === 'UPPER';
              const atBot = rangeQuintile === 'BOT' || rangeQuintile === 'LOWER';
              const flipNote = atTop && oppDir === 'SHORT'
                ? `The FADE SHORT has edge here. TOP of range + this setup direction is 0% WR = the opposite side wins. If you see a failed breakout or exhaustion at this level, the short is the high-conviction play. Log via Quick Trade Log: balance_ceiling_fade.`
                : atBot && oppDir === 'LONG'
                ? `The BOUNCE LONG has edge here. BOTTOM of range + this setup direction is losing = the bounce is the play. If you see absorption at support, the long is high conviction. Log via Quick Trade Log: balance_floor_bounce.`
                : `The opposite direction (${oppDir}) may have edge. This combo loses — if you see a reversal/rejection, consider the ${oppDir} fade.`;
              brief.push(`**FLIP:** ↔ ${flipNote}`);
            }
          }

          // Exhaustion detection at balance edges
          if (rangeQuintile && (rangeQuintile === 'TOP' || rangeQuintile === 'BOT') && allRthBarsRow.rows.length >= 10) {
            const last10 = allRthBarsRow.rows.slice(-10);
            const last5 = last10.slice(-5);
            const prior5 = last10.slice(0, 5);

            const avgRange5 = last5.reduce((s, b) => s + (b.high - b.low), 0) / 5;
            const avgRangePrior = prior5.reduce((s, b) => s + (b.high - b.low), 0) / 5;
            const rangeShrinking = avgRange5 < avgRangePrior * 0.6;

            const lastBar = last5[last5.length - 1];
            const barRange = lastBar.high - lastBar.low;
            const wickRatio = rangeQuintile === 'TOP'
              ? (lastBar.high - Math.max(lastBar.open, lastBar.close)) / (barRange || 1)
              : (Math.min(lastBar.open, lastBar.close) - lastBar.low) / (barRange || 1);
            const wickRejection = wickRatio > 0.5;

            const closeNearExtreme = rangeQuintile === 'TOP'
              ? (lastBar.close - lastBar.low) / (barRange || 1) < 0.3
              : (lastBar.high - lastBar.close) / (barRange || 1) < 0.3;

            const exhaustionSigns = [];
            if (rangeShrinking) exhaustionSigns.push('bar ranges shrinking (momentum dying)');
            if (wickRejection) exhaustionSigns.push(`long ${rangeQuintile === 'TOP' ? 'upper' : 'lower'} wick (${rangeQuintile === 'TOP' ? 'sellers' : 'buyers'} stepping in)`);
            if (closeNearExtreme) exhaustionSigns.push(`close near ${rangeQuintile === 'TOP' ? 'low' : 'high'} of bar (${rangeQuintile === 'TOP' ? 'buyers couldn\'t hold' : 'sellers couldn\'t push'})`);

            if (exhaustionSigns.length >= 2) {
              brief.push(`**EXHAUSTION:** ⚡ ${exhaustionSigns.length} signs detected at ${rangeQuintile} of range: ${exhaustionSigns.join('; ')}. This is what a reversal looks like before it happens. Watch for the failed breakout to confirm.`);
            } else if (exhaustionSigns.length === 1) {
              brief.push(`**EXHAUSTION WATCH:** ${exhaustionSigns[0]}. One sign — not confirmed yet. Need 2+ for high-conviction reversal read.`);
            }
          }

          if (rangeQuintile) {
            brief.push(`**RANGE POSITION:** Price is in the ${rangeQuintile} quintile of the 20-day range (${Math.round(r20.lo)}–${Math.round(r20.hi)}). ${
              rangeQuintile === 'BOT' ? 'Bottom of range — strong mean-reversion zone (71% up, +170pt avg). Bounce setups high conviction.' :
              rangeQuintile === 'LOWER' ? 'Lower range — danger zone for longs (44% up). Downtrends accelerate here.' :
              rangeQuintile === 'MID' ? 'Middle of range — balanced. Setups work best here (51% WR).' :
              rangeQuintile === 'UPPER' ? 'Upper range — slight upward bias continues.' :
              'Top of range — strength tends to continue but large reversals start here. Watch for exhaustion.'
            }`);
          }

          // Size section — overnight is advisory, only post-loss is mechanical
          if (hasLossToday) {
            brief.push(`**SIZE:** 0.5x (post-loss protection). Overnight context is ${aligned ? 'supportive — consider standard size if read is strong' : counter ? 'opposing — stay small' : 'neutral'}.`);
          } else if (aligned) {
            brief.push(`**SIZE:** Standard or size up. Overnight structure supports this direction (61% WR when aligned, N=126). Your call based on what you see at the level.`);
          } else if (counter) {
            brief.push(`**SIZE:** Overnight structure opposes this direction (31% WR when counter, N=145). Consider reduced size — but big winners can come from counter setups. Use your read.`);
          } else {
            brief.push(`**SIZE:** Standard. No strong overnight directional tilt.`);
          }

          if (hasLossToday) brief.unshift(`⚠️ **A prior setup failed today — size reduced 50% (Death Sequence protection).**`);

          // Death Sequence protection (hasLossToday, cross-setup-type "any loss today") is
          // a different signal than the level-fade sizeMultiplier IIFE's own same-type
          // lfConsecLosses ceiling (~line 5090). This line used to unconditionally
          // overwrite active.sizeMultiplier with sizeMult, silently discarding the entire
          // ~20-factor IIFE result levelScalpSetup already computed (~line 5018) and
          // replacing it with this binary 0.5/1.0 value -- confirmed live: every persisted
          // active_setups.size_multiplier row was exactly 0.500 or 1.000, and the live
          // /api/acd/setup-detection response (read directly by MarketPulseBar.jsx) carried
          // the same wrong value. Found 2026-07-16 auditing sizing-multiplier adherence
          // (docs/OPEN_THREADS.md). Fixed: hasLossToday now applies as an additional ceiling
          // on top of the real IIFE value (never exceeding 0.5x after any loss today),
          // instead of replacing it outright -- preserves size-up signals (up to 1.5x) on
          // clean days, still enforces Death Sequence protection on loss days.
          active.sizeMultiplier = hasLossToday
            ? Math.min(active.sizeMultiplier ?? 1.0, 0.5)
            : (active.sizeMultiplier ?? 1.0);
          active.tradeBrief = brief.join('\n\n');
          active.overnightAlignment = aligned ? 'ALIGNED' : counter ? 'COUNTER' : 'NEUTRAL';
          active.paceProfile = prof.style;
          active.description = brief.join('\n\n') + (active.description ? '\n\n---\n\n' + active.description : '');
        }
      }

      // Persist early-touch backfills (fire-and-forget, runs regardless of whether an
      // ACTIVE candidate also fired this poll — this must NOT be gated behind the
      // `if (!active) return` below, since the whole point is to record touches on
      // polls where nothing live fired). SHADOW status only — never an alert.
      if (backfilledTouches.length > 0) {
        const sessionEndStr = `${todayET} 13:00:00`;
        (async () => {
          const btVaMap = await getValueAreaRegimeMap(todayET).catch(() => ({}));
          for (const bt of backfilledTouches) {
            try {
              const existing = await query(
                `SELECT 1 FROM active_setups WHERE trade_date=$1 AND setup_type=$2 LIMIT 1`,
                [todayET, bt.type]
              );
              if (existing.rows.length) continue; // already recorded (ACTIVE or SHADOW) this day
              const h = Math.floor(bt.etMin / 60), m = bt.etMin % 60;
              const firedAtBackfill = `${todayET} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
              const btRegimeStamp = computeRegimeStamp(bt.entry, btVaMap);
              // bt.etMin is the touch's OWN time-of-day (earlier than "now", since this is a
              // same-poll backfill of an earlier-in-the-session touch) -- use it, not the
              // outer etMin, so minutes_from_open reflects when the touch actually happened.
              const btFireTags = await computeFireTags(todayET, 'RTH', bt.etMin);
              await query(`
                INSERT INTO active_setups (trade_date, setup_type, fired_at, expires_at,
                  entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label,
                  price_at_detection, historical_win_rate, historical_sessions, historical_avg_pnl, historical_t1_hit_rate,
                  status, origin_status, resolution_method, ${REGIME_STAMP_COLS.join(', ')}, ${FIRE_TAG_COLS.join(', ')}, bet_class)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'SHADOW','SHADOW','EARLY_TOUCH_BACKFILL',
                  ${REGIME_STAMP_COLS.map((_, i) => `$${15 + i}`).join(', ')},
                  ${FIRE_TAG_COLS.map((_, i) => `$${15 + REGIME_STAMP_COLS.length + i}`).join(', ')},
                  $${15 + REGIME_STAMP_COLS.length + FIRE_TAG_COLS.length})
                ON CONFLICT DO NOTHING
              `, [
                todayET, bt.type, firedAtBackfill, sessionEndStr,
                bt.entry, bt.entry, bt.stop, bt.target, bt.targetLabel,
                bt.entry, bt.history.winRate, bt.history.occurrences, bt.history.avgPnl, bt.history.t1HitRate,
                ...regimeStampValues(btRegimeStamp),
                ...fireTagValues(btFireTags),
                getBetClass(bt.type),
              ]);
            } catch (e) { console.error(`[backfill-touch] ${bt.type} failed:`, e.message); }
          }
        })();
      }

      // bigMoveSignal/sigmaContinuation/stackVolSignal — informational-only, do NOT gate/suppress
      // any setup. MOVED HERE 2026-08-04 (was previously below the `if (!active) return` early
      // return just below) — confirmed live via a real missed move: 2026-08-04 was a 926pt RTH
      // trend day (price rode the 9-EMA up all session, per direct user chart review) and NONE
      // of these three signals fired even once all day, despite bigMoveSignal's own trigger
      // condition (rangeSoFar>=250 AND minutesRemaining>=180) being independently re-verified as
      // true for hours. Root cause: on a sustained one-directional trend day, no fade-family
      // candidate naturally becomes `active` (price keeps running through/away from levels
      // instead of holding one), so every single poll hit this early return before ever reaching
      // the signal computations that used to live below it — the exact days these signals exist
      // to flag are the days a fade candidate is LEAST likely to be active, making the bug
      // maximally self-defeating. Same failure class as the 2026-07-27 STACK_VOL_BREAK_LIVE
      // Globex-unreachability bug (an early return before the code that computes a signal), just
      // a second, previously-uncaught instance gating the RTH path instead of the Globex path.
      // Real per-trade dollar risk is unaffected either way (these are informational-only), but
      // the entire point of a "watch for a big move happening" signal is defeated if it can only
      // ever fire on days a live-alert fade candidate also happens to be active.
      let bigMoveSignal = { active: false, rangeSoFar: null, minutesRemaining: null };
      if (allRthBarsRow.rows.length > 0) {
        const sessionQ = await query(`
          WITH recent AS (
            SELECT ts, high::float, low::float,
                   ts - LAG(ts) OVER (ORDER BY ts) AS gap
            FROM price_bars_primary
            WHERE symbol='NQ' AND ts >= (SELECT MAX(ts) FROM price_bars_primary WHERE symbol='NQ') - interval '30 hours'
          ),
          session_start AS (
            SELECT COALESCE(MAX(ts), (SELECT MIN(ts) FROM recent)) AS start_ts FROM recent WHERE gap > interval '45 minutes'
          )
          SELECT MAX(high) AS h, MIN(low) AS l, COUNT(*) AS n
          FROM recent, session_start
          WHERE ts >= start_ts
        `);
        const row = sessionQ.rows[0];
        if (row?.h != null && row?.l != null && Number(row.n) > 0) {
          const rangeSoFar = row.h - row.l;
          const nowEtMin = allRthBarsRow.rows[allRthBarsRow.rows.length - 1].et_min;
          const minutesRemaining = nowEtMin < 1020 ? (1020 - nowEtMin) : (1440 - nowEtMin + 1020);
          const isActive = rangeSoFar >= 250 && minutesRemaining >= 180;
          bigMoveSignal = { active: isActive, rangeSoFar: Math.round(rangeSoFar), minutesRemaining };
          if (isActive) {
            // FIXED 2026-08-04: was `$1` used for BOTH run_date (date) and signal_name (varchar)
            // in the same statement -- Postgres can't infer one consistent type for a single
            // parameter placeholder used in two different type contexts, and threw a real
            // "42P08 date versus character varying" error on every single attempt, always
            // swallowed silently by the .catch(() => {}) below. Confirmed via server logs the
            // moment this code became reachable for the first time (see the reachability fix
            // above) -- this INSERT had never once succeeded, on any day, since it was written.
            // Separate $3 parameter for signal_name, same todayET value, resolves the ambiguity.
            query(`
              INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes)
              VALUES ($1, 0, 'BIGMOVE_LIVE_SIGNAL', $3, 1, $2)
              ON CONFLICT (run_date, window_days, signal_type, signal_name) DO NOTHING
            `, [todayET, JSON.stringify({ rangeSoFar: Math.round(rangeSoFar), minutesRemaining, triggeredAt: new Date().toISOString() }), todayET]).catch(e => console.error('[BIGMOVE_LIVE_SIGNAL insert failed]', e.message));
          }
        }
      }

      let sigmaContinuation = { active: false, sigma: null, expectedExtraPts: null };
      try {
        const sigBarsQ = await query(`
          SELECT ts, close::float, gap
          FROM (
            SELECT ts, close::float,
                   EXTRACT(EPOCH FROM (ts - LAG(ts) OVER (ORDER BY ts))) / 60 AS gap
            FROM price_bars_primary
            WHERE symbol='NQ' AND ts >= (SELECT MAX(ts) FROM price_bars_primary WHERE symbol='NQ') - interval '8 hours'
          ) t ORDER BY ts ASC
        `);
        const sBars = sigBarsQ.rows;
        const SIG_WIN = 100, H = 60, GAP_CUTOFF = 45;
        if (sBars.length > SIG_WIN + H) {
          let volWindow = [], sumLogRet = 0, sumSqLogRet = 0;
          for (let i = 1; i < sBars.length; i++) {
            const gapMin = sBars[i].gap == null ? Infinity : sBars[i].gap;
            const logRet = Math.log(sBars[i].close / sBars[i - 1].close);
            if (gapMin > GAP_CUTOFF) { volWindow = []; sumLogRet = 0; sumSqLogRet = 0; }
            else {
              volWindow.push(logRet);
              sumLogRet += logRet; sumSqLogRet += logRet * logRet;
              if (volWindow.length > SIG_WIN) { const rm = volWindow.shift(); sumLogRet -= rm; sumSqLogRet -= rm * rm; }
            }
          }
          const i = sBars.length - 1;
          let lookbackHasGap = false;
          for (let j = Math.max(1, i - H + 1); j <= i; j++) {
            const g = sBars[j].gap == null ? Infinity : sBars[j].gap;
            if (g > GAP_CUTOFF) { lookbackHasGap = true; break; }
          }
          if (volWindow.length === SIG_WIN && i >= H && !lookbackHasGap) {
            const mean = sumLogRet / SIG_WIN;
            const variance = Math.max(0, sumSqLogRet / SIG_WIN - mean * mean);
            const stdDevLogRet = Math.sqrt(variance);
            if (stdDevLogRet > 0) {
              const bar = sBars[i];
              const moveInPoints = bar.close - sBars[i - H].close;
              const expectedMove = bar.close * stdDevLogRet * Math.sqrt(H);
              if (moveInPoints < 0) {
                const downMagnitude = Math.abs(moveInPoints) / expectedMove;
                if (downMagnitude >= 1.0) {
                  const calibQ = await query(`SELECT notes FROM performance_audit WHERE signal_type='SIGMA_CONTINUATION_CALIB' AND signal_name='LIVE_CUTOFFS' ORDER BY run_date DESC LIMIT 1`);
                  const calib = calibQ.rows[0] ? JSON.parse(calibQ.rows[0].notes) : null;
                  let bucket = null;
                  if (calib) {
                    for (const c of calib.cutoffs) { if (downMagnitude >= c.sigma) bucket = c; }
                  }
                  sigmaContinuation = {
                    active: true,
                    sigma: Math.round(downMagnitude * 100) / 100,
                    expectedExtraPts: bucket ? bucket.extraPts : null,
                  };
                  const hourEt = allRthBarsRow.rows.length ? Math.floor(allRthBarsRow.rows[allRthBarsRow.rows.length - 1].et_min / 60) : 0;
                  const bucketSigma = bucket ? bucket.sigma : Math.floor(downMagnitude * 2) / 2;
                  const dedupeKey = `${todayET}_${hourEt}_${bucketSigma}`;
                  query(`
                    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes)
                    VALUES ($1, 0, 'SIGMA_CONTINUATION_LIVE', $2, 1, $3)
                    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO NOTHING
                  `, [todayET, dedupeKey, JSON.stringify({ sigma: sigmaContinuation.sigma, expectedExtraPts: sigmaContinuation.expectedExtraPts, triggeredAt: new Date().toISOString() })]).catch(() => {});
                }
              }
            }
          }
        }
      } catch (_) { /* informational only, never block the response */ }

      const stackVolSignal = await computeStackVolSignal(todayET);

      if (!active) return res.json({ setup: null, noNewEntries: !!noNewEntries, cascadeBreaker, bigMoveSignal, sigmaContinuation, stackVolSignal });

      // ── Persist first-detection to active_setups (source of truth) ───────────
      // fired_at = latest bar ts at first detection (bar-accurate, not poll wall-clock).
      // price_bars.ts stores ET times as TIMESTAMP WITHOUT TIME ZONE — pg returns them
      // as JS Dates where UTC fields equal the ET hours/minutes.
      const latestBarTs = latestBarRow.rows[0]?.ts; // ET time stored as UTC by pg driver
      const firedAtTs = latestBarTs
        ? latestBarTs.toISOString().replace('T', ' ').slice(0, 19)
        : etNow.toISOString().replace('T', ' ').slice(0, 19);
      const firedTimeStr = latestBarTs
        ? `${String(latestBarTs.getUTCHours()).padStart(2,'0')}:${String(latestBarTs.getUTCMinutes()).padStart(2,'0')}:00`
        : `${String(etNow.getHours()).padStart(2,'0')}:${String(etNow.getMinutes()).padStart(2,'0')}:00`;

      // Expiry per setup type (minutes from fired_at); null = no time expiry
      const EXPIRY_WINDOW = {
        ZONE_EDGE_FADE: 30, // 30 min to resolve at zone edge
        STOP_SWEEP_LONG: 30, STOP_SWEEP_SHORT: 30,
        VWAP_MAGNET_LONG: 30, VWAP_MAGNET_SHORT: 30,
        PD_POC_FADE_LONG: 30, PD_POC_FADE_SHORT: 30,
        FLOOR_S1_FADE_LONG: 30, FLOOR_S1_FADE_SHORT: 30,
        OR5_HIGH_FADE_LONG: 30, OR5_HIGH_FADE_SHORT: 30,
        IB_HIGH_FADE_LONG: 30, IB_HIGH_FADE_SHORT: 30,
        RSI_DIV_BULLISH: 45, RSI_DIV_BEARISH: 30,
        ABSORPTION_LONG: 100, // runner — needs 20 bars (100 min) for full edge
        COIL_SURGE_LONG: 10, COIL_SURGE_SHORT: 10,
        TRT_SHORT: 50, TRT_LONG: 120, TRT_SHORT_V2: 50, TRT_LONG_V2: 50, TRT_MAH_SHORT: 50, TRT_MAH_LONG: 50,
        OPEN_TEST_DRIVE_SHORT: 45, OPEN_TEST_DRIVE_LONG: 45,
        IB_BULLISH: null, IB_BEARISH: null,
        OPEN_DRIVE_LONG: null, OPEN_DRIVE_SHORT: null,
        C_STANDALONE_UP: null, C_STANDALONE_DOWN: null,
        FAILED_AUCTION_SHORT: 30, FAILED_AUCTION_LONG: 30,
        VALUE_AREA_RESPONSIVE_SHORT: null, VALUE_AREA_RESPONSIVE_LONG: null,
        BRACKET_BREAKOUT_LONG: 960, BRACKET_BREAKOUT_SHORT: 960, // full session
        A_UP_STRONG: null, A_DOWN_STRONG: null,
        A_UP_WEAK: null, A_DOWN_WEAK: null,
        C_PAIRED_LONG: null, C_PAIRED_SHORT: null,
        C_REVERSAL_LONG: null, C_REVERSAL_SHORT: null,
        GAP_FILL_LONG: null, GAP_FILL_SHORT: null,
      };
      // Hard cap: 4:00 PM ET (RTH close). Use local (ET) time formatting so PostgreSQL
      // interprets the stored TIMESTAMP WITHOUT TZ correctly in its session timezone.
      const fmtETStr = (d) => {
        const y = d.getFullYear(), mo = String(d.getMonth()+1).padStart(2,'0'),
              day = String(d.getDate()).padStart(2,'0'),
              h = String(d.getHours()).padStart(2,'0'), m = String(d.getMinutes()).padStart(2,'0');
        return `${y}-${mo}-${day} ${h}:${m}:00`;
      };
      // FIXED 2026-07-17 (Setup Log duplicate-firing bug): this was hardcoded to 1:00 PM ET
      // since the file's original commit (2026-06-01), from back when the app apparently only
      // detected setups until 1 PM -- never updated as detection extended to full RTH (4 PM)
      // and then, 2026-07-16, to full Globex hours. Any setup detected after 1 PM got an
      // expires_at already in the PAST at the moment of insertion, so the very next 15s poll
      // instantly expired it (TIME_EXPIRED), and because the existingSetup dedup check only
      // looks at still-open ACTIVE/SHADOW rows, the NEXT poll re-inserted a fresh duplicate for
      // the exact same touch -- confirmed live: every IB_HIGH_FADE_SHORT fire after 1 PM today
      // duplicated this way. Fixed to 4:00 PM (RTH close, matching the BRACKET_BREAKOUT eodET
      // case just below) and rolled forward a day if that's already passed -- since Globex-hours
      // firing means "now" can legitimately be evening/overnight, a same-day-only cap would
      // reintroduce this exact bug for any post-4PM/overnight fire.
      const sessionEndET = new Date(etNow); sessionEndET.setHours(16, 0, 0, 0);
      if (sessionEndET <= etNow) sessionEndET.setDate(sessionEndET.getDate() + 1);
      const computeExpiry = (type) => {
        if (type === 'BRACKET_BREAKOUT_LONG' || type === 'BRACKET_BREAKOUT_SHORT') {
          const eodET = new Date(etNow); eodET.setHours(16, 0, 0, 0);
          return fmtETStr(eodET);
        }
        const windowMins = EXPIRY_WINDOW[type];
        const byWindow = windowMins ? new Date(etNow.getTime() + windowMins * 60000) : sessionEndET;
        return fmtETStr(byWindow < sessionEndET ? byWindow : sessionEndET);
      };

      // status filter is load-bearing, not cosmetic: without it, this picks up ANY row
      // for the setup_type today by fired_at DESC — including one already
      // EXPIRED/RESOLVED/INVALIDATED earlier the same session. A later genuine re-touch
      // of the same level then gets misreported as "still" the old resolved instance
      // (stale fired_at/entry/stop/target echoed back) instead of starting a real new
      // row via the INSERT branch below. Found live 2026-07-16: OR_LOW_FADE_LONG
      // invalidated at 09:36 was still being shown as the "active" card at 10:25 with
      // "fired 09:34 ET" when price re-touched OR low. ACTIVE and SHADOW are the two
      // still-open (not yet resolved) statuses this INSERT ever assigns — only those
      // represent "this is genuinely the same ongoing instance, don't re-fire." The
      // partial unique index `idx_as_unique_setup` is (trade_date, setup_type,
      // COALESCE(status,'')) WHERE status IN ('ACTIVE','SHADOW'), so a fresh ACTIVE/SHADOW
      // row for the same setup_type/day does not conflict with an already-closed
      // EXPIRED/RESOLVED one — that's what lets a genuine later re-touch get its own row.
      // BUT this only blocks two *simultaneously open* rows — it does nothing to stop the
      // exact same touch instant (identical fired_at) from being re-inserted the moment the
      // first instance resolves, which is exactly what the sessionEndET bug above was doing
      // every poll cycle. Fixed 2026-07-17 with a second, unconditional unique index,
      // `idx_as_unique_touch_instant` on (trade_date, setup_type, fired_at) — this guarantees
      // the same touch can never produce two rows regardless of status, while still allowing
      // a later bar's genuinely different fired_at to insert normally. All ON CONFLICT
      // clauses against this table are now bare `ON CONFLICT DO NOTHING` (catches either
      // index) rather than targeting one specific constraint.
      const existingSetup = await query(`
        SELECT id, fired_at::text as fired_at, entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label
        FROM active_setups WHERE trade_date=$1 AND setup_type=$2 AND status IN ('ACTIVE','SHADOW')
        ORDER BY fired_at DESC LIMIT 1
      `, [todayET, active.type]);

      // Safety guard: T1 must be above entry for LONG, below entry for SHORT.
      // If any target computation produced a wrong-direction value, null it out.
      let safeT1Level = active.target;
      let safeT1Label = active.targetLabel;
      if (safeT1Level != null) {
        const isLongSetup = active.direction === 'LONG';
        if ((isLongSetup && safeT1Level <= active.entry) || (!isLongSetup && safeT1Level >= active.entry)) {
          console.error(`[setup-detection] REJECTED T1 ${safeT1Level} for ${active.type} — wrong side of entry ${active.entry} (${active.direction})`);
          safeT1Level = null;
          safeT1Label = 'NO_VIABLE_TARGET';
        }
      }

      // The persisted active_setups row is the ONE canonical source for tradeable
      // levels (entry/stop/target). Once a setup is detected, those levels are frozen
      // for its lifetime — the live recompute above (`active.entry/stop/target`) only
      // feeds the INSERT on first detection; every subsequent poll must echo back the
      // persisted row so the card never shows a drifting, per-poll-recomputed target.
      let detectedAt, setupId, persistedLevels;
      if (existingSetup.rows.length) {
        const row = existingSetup.rows[0];
        detectedAt = row.fired_at.slice(11, 16); // HH:MM
        setupId    = row.id;
        persistedLevels = {
          entry: row.entry_zone_low != null ? +row.entry_zone_low : active.entry,
          stop: row.stop_level != null ? +row.stop_level : active.stop,
          target: row.t1_level != null ? +row.t1_level : null,
          targetLabel: row.t1_label || 'NO_VIABLE_TARGET',
        };
      } else {
        const hist = active.history || {};
        // Trail-mechanism variants (docs/SCALEOUT_RUNNER_SPEC.md) have zero live
        // SETUP_STATUS history by construction — they're brand new, so the standard
        // `_suppressedSetups` check below (which only knows SUPPRESS/THIN_N from a REAL
        // SETUP_STATUS row) would otherwise miss them entirely and let a type with N=0
        // live trades fire straight to 'ACTIVE'. Force SHADOW explicitly here instead —
        // matches CLAUDE.md's "New setup type checklist" item 3 ("If N<20 resolved
        // trades, do NOT fire live"). Promotion once N>=20 accumulates is a deliberate
        // manual step (spec §7/§10), not automatic, same as every other new setup type.
        const trailVariant = CONDITIONAL_VARIANTS[active.type];
        const isTrailMechanism = trailVariant?.trailSignalName != null;
        let runnerTrailWidth = null;
        if (isTrailMechanism) {
          const trailRow = await query(
            `SELECT DISTINCT ON (signal_name) notes FROM performance_audit
             WHERE signal_type='BREAKEVEN_TRAIL_TEST' AND signal_name=$1
             ORDER BY signal_name, run_date DESC`,
            [trailVariant.trailSignalName]
          );
          const notes = trailRow.rows[0]?.notes;
          const parsed = typeof notes === 'string' ? JSON.parse(notes) : notes;
          runnerTrailWidth = parsed?.trail ?? null;
        }
        // Re-fire cooldown (2026-08-03) — gates a NEW candidate to SHADOW if the SAME
        // setup_type resolved within the last N minutes today. IB_BEARISH: 30min is
        // backtest-validated (RESEARCH_CLAIM ib_bearish_refire_cooldown_beats_volz_gate,
        // PROVISIONAL — rigor-clean, not yet independently replicated) — real finding:
        // "re-firing repeatedly in one day is itself the problem" (EV degrades by
        // within-day fire number), and a blind cooldown performs at least as well as a
        // bespoke volume gate, so the simple fix is the right shape. VWAP_MAGNET family:
        // precautionary, not independently backtested for its own EV — historical
        // backfill directly showed the same unbounded-rapid-refire pattern on trend days
        // (scripts/backtest_vwap_magnet.mjs: 2025-11-20, 107 of 1158 VWAP_MAGNET_LONG
        // backfilled fires from repeated ~2-bar-apart stop-outs in one session), same
        // shape of problem as the validated IB_BEARISH fix (OPEN_DECISION
        // vwap_magnet_repeated_whipsaw_on_trend_days). IB_BULLISH deliberately excluded —
        // its own cooldown backtest cell failed computeReplication (see the RESEARCH_CLAIM
        // above), and it's globally SUPPRESSed today anyway. `resolved_at` (not
        // resolution_bar_time) matches the cascadeBreaker precedent 130 lines above.
        const REFIRE_COOLDOWN_MINUTES = {
          IB_BEARISH: 30,
          VWAP_MAGNET_LONG: 30, VWAP_MAGNET_SHORT: 30,
          GLOBEX_VWAP_MAGNET_LONG: 30, GLOBEX_VWAP_MAGNET_SHORT: 30,
        };
        let inRefireCooldown = false;
        const _cooldownMin = REFIRE_COOLDOWN_MINUTES[active.type];
        if (_cooldownMin) {
          const cooldownQ = await query(`
            SELECT 1 FROM active_setups
            WHERE trade_date = $1 AND setup_type = $2
              AND resolution IS NOT NULL
              AND resolved_at > NOW() - ($3::int * INTERVAL '1 minute')
            LIMIT 1
          `, [todayET, active.type, _cooldownMin]).catch(() => ({ rows: [] }));
          inRefireCooldown = cooldownQ.rows.length > 0;
        }
        const forceShadow = isTrailMechanism
          || getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._suppressedSetups?.has(active.type)
          || inNewEntryDeadZone
          || inRefireCooldown;
        // TEMPORARY DIAGNOSTIC (2026-08-12) — see matching comments ~6698/~7660.
        if (cascadeBreaker.active) {
          cascadeDiagLog(`[cascade-diag] insert-stage active.type=${active.type} forceShadow=${forceShadow} isTrailMechanism=${!!isTrailMechanism} cachedSuppressed=${!!getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._suppressedSetups?.has(active.type)} inNewEntryDeadZone=${!!inNewEntryDeadZone} inRefireCooldown=${!!inRefireCooldown}`);
        }
        const forceShadowReason = isTrailMechanism ? 'UNCALIBRATED_TRAIL_VARIANT'
          : inNewEntryDeadZone ? 'POST_RTH_DEAD_ZONE'
          : inRefireCooldown ? 'REFIRE_COOLDOWN'
          : forceShadow ? 'PERFORMANCE_BELOW_THRESHOLD' : null;
        const regimeStamp = computeRegimeStamp(active.entry, await getValueAreaRegimeMap(todayET));
        const fireTags = await computeFireTags(todayET, 'RTH', etMin);
        const ins = await query(`
          INSERT INTO active_setups (
            trade_date, setup_type, fired_at, expires_at, status, origin_status,
            entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label,
            price_at_detection,
            historical_win_rate, historical_sessions, historical_avg_pnl, historical_t1_hit_rate,
            nl30_at_detection, structural_state_at_detection,
            size_multiplier, suppression_reason, runner_trail_width,
            confluence_score_at_detection, confluence_levels_at_detection,
            exhaustion_signal_at_detection, hivol_lopace_at_detection, selected_over,
            ${REGIME_STAMP_COLS.join(', ')}, ${FIRE_TAG_COLS.join(', ')}, bet_class
          ) VALUES ($1,$2,$3,$4,$18,$18,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$19,$20,$21,$22,$23,$24,$25,
            ${REGIME_STAMP_COLS.map((_, i) => `$${26 + i}`).join(', ')},
            ${FIRE_TAG_COLS.map((_, i) => `$${26 + REGIME_STAMP_COLS.length + i}`).join(', ')},
            $${26 + REGIME_STAMP_COLS.length + FIRE_TAG_COLS.length})
          ON CONFLICT DO NOTHING RETURNING id, entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label
        `, [
          todayET, active.type, firedAtTs, computeExpiry(active.type),
          active.entry, active.entry, active.stop, safeT1Level, safeT1Label,
          active.entry,
          hist.winRate ?? null, hist.occurrences ?? null, hist.avgPnl ?? null, hist.t1HitRate ?? null,
          nl30, nl30State === 'BULLISH' ? 'TRENDING_UP' : nl30State === 'BEARISH' ? 'TRENDING_DOWN' : 'BALANCE',
          active.sizeMultiplier ?? 1.0,
          forceShadow ? 'SHADOW' : 'ACTIVE',
          forceShadowReason,
          runnerTrailWidth,
          active.confluenceCount ?? null,
          active.confluenceLevels && active.confluenceLevels.length ? active.confluenceLevels : null,
          active.exhaustionSignalAtDetection ?? null,
          active.hivolLopaceAtDetection ?? null,
          active.selectedOver ?? null,
          ...regimeStampValues(regimeStamp),
          ...fireTagValues(fireTags),
          getBetClass(active.type),
        ]);
        let row = ins.rows[0];
        if (!row) {
          // ON CONFLICT DO NOTHING — a concurrent poll won the race and persisted first.
          // Re-select so we still serve the canonical persisted row, not our live recompute.
          const won = await query(`
            SELECT id, fired_at::text as fired_at, entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label
            FROM active_setups WHERE trade_date=$1 AND setup_type=$2
            ORDER BY fired_at DESC LIMIT 1
          `, [todayET, active.type]);
          row = won.rows[0];
          if (row) detectedAt = row.fired_at.slice(11, 16);
        }
        setupId    = row?.id;
        detectedAt = detectedAt || firedTimeStr.slice(0, 5);
        persistedLevels = row ? {
          entry: row.entry_zone_low != null ? +row.entry_zone_low : active.entry,
          stop: row.stop_level != null ? +row.stop_level : active.stop,
          target: row.t1_level != null ? +row.t1_level : null,
          targetLabel: row.t1_label || 'NO_VIABLE_TARGET',
        } : { entry: active.entry, stop: active.stop, target: safeT1Level, targetLabel: safeT1Label };
        // Backward compat: also write to acd_setup_events
        await query(`
          INSERT INTO acd_setup_events (trade_date, setup_type, fired_time, fired_price)
          VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING
        `, [todayET, active.type, firedTimeStr, active.entry || null]);
        // Found 2026-07-27 (setup_log_sidebar_recording_audit): this, the MAIN RTH
        // candidate insertion path, was the one INSERT site in this file that never
        // called dropToTimeline() at fire time -- every other insert path does. A
        // freshly-fired ACTIVE setup was invisible in the sidebar Session Timeline until
        // it later resolved (which does drop a timeline event via its own UPDATE path),
        // sometimes minutes to hours later. dropToTimeline()'s own ON CONFLICT (setup_id)
        // DO NOTHING makes this safe even though the resolve path will also call it later
        // for the same id.
        if (setupId) {
          try {
            await dropToTimeline({
              id: setupId,
              trade_date: todayET,
              fired_at: firedAtTs,
              setup_type: active.type,
              entry_zone_low: persistedLevels.entry,
              stop_level: persistedLevels.stop,
              t1_level: persistedLevels.target,
              t1_label: persistedLevels.targetLabel,
              resolution: null,
              historical_win_rate: hist.winRate ?? null,
              historical_sessions: hist.occurrences ?? null,
              expires_at: computeExpiry(active.type),
            });
          } catch (_) {}
        }
      }

      // Keep size_multiplier current — it changes with intraday conditions (streak, stacking, etc.)
      // Guarded by IS DISTINCT FROM (2026-07-27): this fires on every ~15s poll for any
      // open setup regardless of whether the value actually moved -- without the guard,
      // adding updated_at=NOW() here would make it track "last polled" rather than
      // "actually changed," defeating its use as a real modification signal.
      if (setupId && active.sizeMultiplier != null) {
        query('UPDATE active_setups SET size_multiplier=$1, updated_at=NOW() WHERE id=$2 AND size_multiplier IS DISTINCT FROM $1',
          [active.sizeMultiplier, setupId]).catch(() => {});
      }

      const expiresAt = computeExpiry(active.type);
      const minsRemaining = Math.max(0, Math.round((new Date(expiresAt) - etNow) / 60000));
      const isExpired = minsRemaining === 0;


       // Compute ET hour for time-of-day edge badge (10 AM ET = backtested +9.7% WR lift)
       const firedEtHour = (() => {
         try {
           const [hh, mm] = (detectedAt || '').split(':').map(Number);
           if (isNaN(hh)) return null;
           const d = new Date();
           d.setUTCHours(hh, mm || 0, 0, 0);
           return parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(d), 10);
         } catch { return null; }
       })();
      // Persist shadow setups (fire-and-forget, don't block response)
      if (shadowCandidates.length > 0) {
        (async () => {
          const vaMap = await getValueAreaRegimeMap(todayET).catch(() => ({}));
          const shadowFireTags = await computeFireTags(todayET, 'RTH', etMin);
          for (const shadow of shadowCandidates) {
            if (!shadow || shadow.type === active?.type) continue;
            const isLongS = shadow.direction === 'LONG';
            const riskOk = shadow.stop == null || (isLongS ? shadow.stop < shadow.entry : shadow.stop > shadow.entry);
            if (!riskOk) {
              logGatedCandidate({ tradeDate: todayET, setupType: shadow.type, gateName: 'RISK_CHECK_SHADOW', gateReason: `non-positive risk: stop ${shadow.stop} vs entry ${shadow.entry} (${shadow.direction})`, entry: shadow.entry, stop: shadow.stop, target: shadow.target });
              continue;
            }
            let sT1 = shadow.target;
            if (sT1 != null && ((isLongS && sT1 <= shadow.entry) || (!isLongS && sT1 >= shadow.entry))) sT1 = null;
            const regimeStamp = computeRegimeStamp(shadow.entry, vaMap);
            await query(`
              INSERT INTO active_setups (trade_date, setup_type, fired_at, expires_at,
                entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label,
                status, origin_status, ${REGIME_STAMP_COLS.join(', ')}, ${FIRE_TAG_COLS.join(', ')}, bet_class)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'SHADOW','SHADOW', ${REGIME_STAMP_COLS.map((_, i) => `$${10 + i}`).join(', ')},
                ${FIRE_TAG_COLS.map((_, i) => `$${10 + REGIME_STAMP_COLS.length + i}`).join(', ')},
                $${10 + REGIME_STAMP_COLS.length + FIRE_TAG_COLS.length})
              ON CONFLICT DO NOTHING
            `, [
              todayET, shadow.type, firedAtTs, computeExpiry(shadow.type),
              shadow.entry, shadow.entry, shadow.stop, sT1, shadow.targetLabel || null,
              ...regimeStampValues(regimeStamp),
              ...fireTagValues(shadowFireTags),
              getBetClass(shadow.type),
            ]).catch(() => {});
          }
        })();
      }

      // bigMoveSignal/sigmaContinuation/stackVolSignal computation MOVED from here to before
      // the `if (!active) return` early return above (2026-08-04) — see that block for why.

      res.json({
        setup: {
          ...active,
          entry: persistedLevels.entry,
          stop: persistedLevels.stop,
          target: persistedLevels.target,
          targetLabel: persistedLevels.targetLabel,
          detectedAt, minsRemaining, isExpired, setupId, firedEtHour,
          sizeMultiplier: active.sizeMultiplier ?? 1.0,
        },
        noNewEntries: !!noNewEntries,
        cascadeBreaker,
        bigMoveSignal,
        sigmaContinuation,
        stackVolSignal,
      });
    } catch(e) { console.error('setup-detection error:', e); cascadeDiagLog(`[setup-detection-error] ${e.stack}`); res.status(500).json({ error: e.message }); }
  };

  // Short-lived (20s) full-response cache, on top of the in-flight coalescing lock
  // below. server/index.js already runs an autonomous poller hitting this exact
  // endpoint every 15s during RTH (9:30-4 PM ET), independent of any open browser
  // — that pre-computation was being thrown away before, so a real page load still
  // paid the full ~7-10s cost even though a near-identical result had just been
  // computed seconds earlier. 20s (slightly over the 15s autonomous-poll cadence)
  // means a real request almost always lands inside a still-fresh window. This is
  // a real-time detection endpoint, not day-stable data, hence the short TTL vs.
  // the 12h/5min conventions used elsewhere (see CLAUDE.md).
  const SETUP_DETECTION_CACHE_TTL = 20000;
  let setupDetectionInFlight = null;
  router.get('/acd/setup-detection', async (req, res) => {
    const cached = cacheGet('setup-detection-response');
    if (cached) return res.status(cached.status).json(cached.body);
    if (setupDetectionInFlight) {
      const result = await setupDetectionInFlight;
      return res.status(result.status).json(result.body);
    }
    let capturedStatus = 200, capturedBody = null;
    const fakeRes = {
      status(code) { capturedStatus = code; return this; },
      json(body) { capturedBody = body; return this; },
    };
    setupDetectionInFlight = runSetupDetection(req, fakeRes)
      .then(() => ({ status: capturedStatus, body: capturedBody }));
    try {
      const result = await setupDetectionInFlight;
      if (result.status === 200) cacheSet('setup-detection-response', result, SETUP_DETECTION_CACHE_TTL);
      res.status(result.status).json(result.body);
    } finally {
      setupDetectionInFlight = null;
    }
  });

  // ── Replayed baseline stats (replaces hardcoded SETUP_BASELINES) ──────────
  // Source: setup_daytype_winrates, populated by scripts/replay_all_setups.js +
  // scripts/populate_setup_daytype_winrates.js — a full-history replay of the
  // CURRENT detection rules (incl. the negative-risk/zero-reward integrity guard),
  // resolved with the current price-vs-T1/stop logic. The 'OVERALL' row is the
  // blended (all day types) baseline; TREND/BALANCE/TURBULENT rows back the
  // conditional-edge display on setup cards.
  const getReplayBaseline = async (setupType) => {
    const r = await query(`
      SELECT day_type, n, decided_n, win_rate, limited_sample
      FROM setup_daytype_winrates
      WHERE setup_type=$1 AND computed_date = (SELECT MAX(computed_date) FROM setup_daytype_winrates)
    `, [setupType]).catch(() => ({ rows: [] }));
    const byDayType = {};
    for (const row of r.rows) {
      byDayType[row.day_type] = {
        n: row.n, decidedN: row.decided_n,
        winRate: row.win_rate != null ? parseFloat(row.win_rate) : null,
        limitedSample: row.limited_sample,
      };
    }
    return byDayType;
  };

  const MIN_SAMPLE = 5; // minimum resolved setups before live stats override baseline

  // Returns { allTime, d90, d60, d30 } each with { winRate, sessions, t1HitRate, avgPnl }
  const getSetupStats = async (setupType) => {
    const r = await query(`
      SELECT
        'all'  as tf, COUNT(*) FILTER (WHERE resolution='TARGET_HIT') as wins, COUNT(*) as total, AVG(actual_pnl) as avg_pnl
        FROM active_setups WHERE setup_type=$1 AND resolution IN ('TARGET_HIT','STOP_HIT')
      UNION ALL
      SELECT
        '90d', COUNT(*) FILTER (WHERE resolution='TARGET_HIT'), COUNT(*), AVG(actual_pnl)
        FROM active_setups WHERE setup_type=$1 AND resolution IN ('TARGET_HIT','STOP_HIT') AND fired_at >= NOW() - INTERVAL '90 days'
      UNION ALL
      SELECT
        '60d', COUNT(*) FILTER (WHERE resolution='TARGET_HIT'), COUNT(*), AVG(actual_pnl)
        FROM active_setups WHERE setup_type=$1 AND resolution IN ('TARGET_HIT','STOP_HIT') AND fired_at >= NOW() - INTERVAL '60 days'
      UNION ALL
      SELECT
        '30d', COUNT(*) FILTER (WHERE resolution='TARGET_HIT'), COUNT(*), AVG(actual_pnl)
        FROM active_setups WHERE setup_type=$1 AND resolution IN ('TARGET_HIT','STOP_HIT') AND fired_at >= NOW() - INTERVAL '30 days'
    `, [setupType]).catch(() => ({ rows: [] }));

    const byDayType = await getReplayBaseline(setupType);
    const overall = byDayType.OVERALL || null;
    const fmt = (rows, tf) => {
      const row = rows.find(r => r.tf === tf);
      const n = row ? parseInt(row.total) : 0;
      if (n >= MIN_SAMPLE) {
        return {
          winRate: n > 0 ? parseFloat(row.wins) / n : null,
          sessions: n,
          t1HitRate: null,
          avgPnl: row.avg_pnl != null ? parseFloat(row.avg_pnl) : null,
        };
      }
      // Fall back to the full-history replay baseline for all-time; null for shorter windows
      if (tf === 'all' && overall?.winRate != null) {
        return { winRate: overall.winRate, sessions: overall.n, t1HitRate: null, avgPnl: null, isBaseline: true, limitedSample: overall.limitedSample };
      }
      return null;
    };

    return { allTime: fmt(r.rows, 'all'), d90: fmt(r.rows, '90d'), d60: fmt(r.rows, '60d'), d30: fmt(r.rows, '30d'), byDayType };
  };

  // ── GET /api/setups/active ─────────────────────────────────────────────────
  router.get('/setups/active', async (req, res) => {
    try {
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const r = await query(`
        SELECT *, fired_at::text as fired_at_str, expires_at::text as expires_at_str
        FROM active_setups WHERE trade_date=$1 AND status='ACTIVE' ORDER BY fired_at DESC LIMIT 1
      `, [todayET]);
      if (!r.rows.length) return res.json({ setup: null });
      const s = r.rows[0];
      const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const minsRemaining = s.expires_at_str
        ? Math.max(0, Math.round((new Date(s.expires_at_str) - etNow) / 60000))
        : null;
      res.json({ setup: { ...s, minsRemaining } });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/setups/today ──────────────────────────────────────────────────
  // GET /api/learning-digest/recent — last 14 days of learning_digest_events for the
  // AlphaEngineOverview "Recent Learning" panel. See server/services/learningDigestService.js.
  router.get('/learning-digest/recent', async (req, res) => {
    try {
      const r = await query(`
        SELECT event_type, signal_name, old_value, new_value, description, magnitude,
          created_at::text AS created_at
        FROM learning_digest_events
        WHERE created_at >= NOW() - INTERVAL '14 days'
        ORDER BY created_at DESC
        LIMIT 100
      `);
      res.json({ events: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/setups/today', async (req, res) => {
    try {
      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const todayET = nowET.toLocaleDateString('en-CA');
      // After 6 PM ET Globex starts — include both today's RTH setups AND next day's Globex setups
      const dates = [todayET];
      if (nowET.getHours() >= 18) dates.push(nextTradingDay(nowET));

      const setupsRes = await query(`
        SELECT s.*,
          TO_CHAR(s.fired_at, 'YYYY-MM-DD HH24:MI:SS') as fired_at_str,
          TO_CHAR(s.expires_at, 'YYYY-MM-DD HH24:MI:SS') as expires_at_str,
          TO_CHAR(s.resolved_at, 'YYYY-MM-DD HH24:MI:SS') as resolved_at_str
        FROM active_setups s
        WHERE s.trade_date = ANY($1) ORDER BY s.fired_at
      `, [dates]);

      // body_pct/bar_dir of the exact 1-min bar matching each setup's fired_at — was a
      // correlated LATERAL subquery against `price_bars` (raw, partitioned) per row, ~35
      // rows × full partition scan each (confirmed via EXPLAIN ANALYZE: loops=35 across
      // every monthly partition — the same partition-pruning trap found and fixed elsewhere
      // in this codebase 2026-07-15) — also reading the un-deduplicated table instead of
      // `price_bars_primary` (missed by the 2026-07-13 dedup-view migration that fixed 23
      // other consumers, per docs/KNOWN_ISSUES.md item 8). Fixed by bulk-fetching bars once
      // (plain WHERE ts::date = ANY(...), fully partition-prunable) and matching in JS.
      // Bar-fetch dates are derived from each setup's own fired_at calendar date, NOT
      // `dates` (trade_date) — verified this matters: a Globex setup firing at 6pm ET has
      // trade_date = next session but fired_at's own calendar date is still "today," and
      // the original query's bar lookup was always anchored to fired_at::date, not
      // trade_date. Verified byte-for-byte against the original LATERAL query (0 mismatches
      // across today's 35 setups, including this exact overnight edge case) before wiring in.
      const firedDates = [...new Set(setupsRes.rows.filter(s => s.fired_at).map(s => new Date(s.fired_at).toISOString().slice(0, 10)))];
      const barByMinute = new Map();
      if (firedDates.length) {
        const barsRes = await query(`
          SELECT ts, open::float, high::float, low::float, close::float
          FROM price_bars_primary WHERE symbol='NQ' AND ts::date = ANY($1::date[])
        `, [firedDates]);
        for (const b of barsRes.rows) barByMinute.set(Math.floor(new Date(b.ts).getTime() / 60000), b);
      }

      const setups = setupsRes.rows.map(s => {
        let body_pct = null, bar_dir = null;
        if (s.fired_at) {
          const bar = barByMinute.get(Math.floor(new Date(s.fired_at).getTime() / 60000));
          if (bar) {
            const range = bar.high - bar.low;
            body_pct = range > 0 ? Math.round(Math.abs(bar.close - bar.open) / range * 100) : null;
            bar_dir = bar.close > bar.open ? 'UP' : bar.close < bar.open ? 'DOWN' : 'FLAT';
          }
        }
        return { ...s, body_pct, bar_dir };
      });

      res.json({ setups });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/setups/range-summary?range=today|week|month|year|all&origin=real|all —
  // powers the quick-check page's single filterable equity curve + by-setup table
  // (superseded the earlier separate /setups/week-summary, which only did one fixed
  // range). Deliberately NOT `SELECT s.*` like /setups/today -- for month/year/all this
  // can return thousands of rows, and the equity curve / aggregation table only need a
  // handful of fields, so this stays lightweight on purpose rather than shipping every
  // active_setups column (confluence arrays, runner-trail state, etc.) for a range that
  // could span the whole history. SHADOW/ACTIVE-status excluded server-side (only
  // resolved/expired rows) -- separate from origin_status below, which is about
  // ACTIVE/SHADOW/BACKFILL/UNKNOWN provenance, not the `status` column's ACTIVE/SHADOW/
  // RESOLVED/EXPIRED lifecycle, an easy pair to conflate since both use "ACTIVE"/
  // "SHADOW" as literal values for two unrelated concepts.
  //
  // origin=real (default) restricts to origin_status IN ('ACTIVE','SHADOW') -- genuinely
  // live-fired data, per this codebase's standing rule that ~80-97% of active_setups for
  // any wide date range is BACKFILL (synthetic historical seeding) or UNKNOWN (pre-2026-
  // 07-09, unrecoverable), and presenting a blended figure as "performance" without this
  // filter is exactly the mistake that rule exists to prevent. Found 2026-07-29, same
  // session this endpoint was built: the "All time" range's blended equity curve was
  // being dragged to a large apparent loss almost entirely by UNKNOWN-origin legacy rows
  // (-$10,892) while the real ACTIVE+SHADOW total was actually positive (+$4,858) --
  // confirmed directly, not assumed. realCount/nonRealCount are always returned
  // regardless of which origin filter is active, so the frontend can show the
  // composition even when already filtered to real-only.
  router.get('/setups/range-summary', async (req, res) => {
    try {
      const range = ['today', 'week', 'month', 'year', 'all'].includes(req.query.range) ? req.query.range : 'today';
      const origin = req.query.origin === 'all' ? 'all' : 'real';
      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const todayET = nowET.toLocaleDateString('en-CA');

      let whereClause, params, rangeLabel;
      if (range === 'today') {
        // FIXED 2026-08-09: was `[todayET]` + next day appended once >=6PM ET (matching
        // /api/setups/today's own deliberately wider "today + tomorrow" contract) -- for
        // THIS endpoint (the Performance tab's "Today" filter) that meant the tab kept
        // showing the RTH session that had already closed, blended with the new Globex
        // session, from 6PM until local midnight, instead of resetting the moment the new
        // session opened. Same user report, same fix as the Session Timeline's own
        // currentSessionDateET() -- single session date, not an accumulating pair. Only
        // consumer is quick-check.html (grepped 2026-08-09), so this is safe to change here
        // directly rather than filtering client-side.
        const sessionDate = nowET.getHours() >= 18 ? nextTradingDay(nowET) : todayET;
        whereClause = 's.trade_date = $1';
        params = [sessionDate];
        rangeLabel = sessionDate;
      } else if (range === 'week') {
        const dow = nowET.getDay(); // 0=Sun...6=Sat
        // Sunday: the week opening tonight starts TOMORROW (Monday) -- post-6PM Sunday
        // activity is already tagged trade_date=Monday under this app's own rollover
        // convention, so Sunday shows the upcoming week, not the one that already
        // closed out last Friday.
        const daysSinceMonday = dow === 0 ? 1 : 1 - dow;
        const monday = new Date(nowET);
        monday.setDate(monday.getDate() + daysSinceMonday);
        const weekDates = [];
        for (let i = 0; i < 5; i++) {
          const d = new Date(monday);
          d.setDate(d.getDate() + i);
          weekDates.push(d.toLocaleDateString('en-CA'));
        }
        whereClause = 's.trade_date = ANY($1)';
        params = [weekDates];
        rangeLabel = weekDates[0] + ' → ' + weekDates[4];
      } else if (range === 'month' || range === 'year') {
        const days = range === 'month' ? 30 : 365;
        const since = new Date(nowET);
        since.setDate(since.getDate() - days);
        const sinceStr = since.toLocaleDateString('en-CA');
        whereClause = 's.trade_date >= $1::date';
        params = [sinceStr];
        rangeLabel = 'trailing ' + days + 'd (since ' + sinceStr + ')';
      } else {
        whereClause = 'TRUE';
        params = [];
        rangeLabel = 'all time';
      }

      const setupsRes = await query(`
        SELECT s.id, s.setup_type, s.trade_date, s.status, s.resolution, s.actual_pnl, s.is_rth, s.origin_status,
          s.mae_points, s.mfe_points,
          TO_CHAR(s.fired_at, 'YYYY-MM-DD HH24:MI:SS') as fired_at_str
        FROM active_setups s
        WHERE ${whereClause}
          AND s.fired_at IS NOT NULL AND s.status NOT IN ('SHADOW','ACTIVE')
        ORDER BY s.fired_at
      `, params);

      const allRows = setupsRes.rows;
      const isReal = (r) => r.origin_status === 'ACTIVE' || r.origin_status === 'SHADOW';
      const realCount = allRows.filter(isReal).length;
      const nonRealCount = allRows.length - realCount;
      const setups = origin === 'real' ? allRows.filter(isReal) : allRows;

      res.json({ setups, range, rangeLabel, origin, realCount, nonRealCount });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/setups/today-summary — same population as /setups/today, pre-formatted
  // as a single text block for external consumers (Home Assistant, etc.) that can't
  // iterate a JSON array as a sensor attribute -- confirmed 2026-07-20 via HA's own
  // REST sensor docs that json_attributes only supports a single flat object, not a
  // list, so a client-side array-based dashboard card can't work against this data
  // no matter how the sensor is configured. This endpoint does the filtering/sorting
  // server-side instead: excludes SHADOW/ACTIVE (unresolved/not-yet-promoted) rows,
  // matching the exact same rule as src/App.jsx's Session Timeline sidebar, sorted
  // most-recent-first by the FULL fired_at timestamp (not just HH:MM -- see the
  // sidebar sort bug fixed the same session for why that distinction matters).
  router.get('/setups/today-summary', async (req, res) => {
    try {
      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const todayET = nowET.toLocaleDateString('en-CA');
      // Single current-session trade_date (not "today + tomorrow" like /setups/today
      // above) -- user wants this list scoped to just ONE session window (6PM Globex
      // open through 4PM RTH close), resetting fresh at each 6PM rollover rather than
      // accumulating across sessions. Before 6PM, that's today's own trade_date; at/
      // after 6PM, the session that's now open belongs to the NEXT trading day already
      // (matches every other 6PM-rollover convention in this codebase).
      const currentSessionDate = nowET.getHours() >= 18 ? nextTradingDay(nowET) : todayET;

      const setupsRes = await query(`
        SELECT id, setup_type, status, resolution, actual_pnl, bar6_checkpoint, bar6_exit_recommended,
          delta_confirmation_state,
          entry_zone_low, fired_at, TO_CHAR(fired_at, 'YYYY-MM-DD HH24:MI:SS') as fired_at_str
        FROM active_setups
        WHERE status = 'ACTIVE'
           OR (trade_date = $1 AND status NOT IN ('SHADOW', 'ACTIVE'))
        ORDER BY fired_at DESC
      `, [currentSessionDate]);

      // Prefix each line with weekday+date, not just HH:MM -- this list can span two
      // calendar days once past 6PM ET (today's leftover RTH entries + the new
      // session's overnight touches), so bare time-of-day is genuinely ambiguous.
      // Weekday computed from the Y-M-D calendar components directly (Date.UTC),
      // not by parsing fired_at_str as a real-world instant -- avoids any ambient-
      // timezone dependency for what's purely a calendar-date lookup.
      // Fade-against-a-big-move-day exit alert — see checkFadeAgainstBigMoveExit() above for
      // the full validation writeup. Informational only, never blocks the response.
      const fadeExitBySetupId = new Map();
      const openTrades = setupsRes.rows.filter(s => s.status === 'ACTIVE' && s.resolution == null && s.entry_zone_low != null);
      for (const s of openTrades) {
        if (await checkFadeAgainstBigMoveExit(s, currentSessionDate)) fadeExitBySetupId.set(s.id, true);
      }

      const WEEKDAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      const lines = setupsRes.rows.map(s => {
        const [y, mo, d] = s.fired_at_str.slice(0, 10).split('-').map(Number);
        const weekday = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
        const dateLabel = `${weekday} ${mo}/${d}`;
        const time = s.fired_at_str.slice(11, 16);
        const outcome = s.resolution || 'expired';
        const pnl = s.actual_pnl != null ? `, $${parseFloat(s.actual_pnl).toFixed(2)}` : '';
        const bar6 = s.bar6_checkpoint ? `, bar6:${s.bar6_checkpoint}` : '';
        const exitRec = s.bar6_exit_recommended ? ', EXIT NOW recommended' : '';
        const fadeExit = fadeExitBySetupId.get(s.id) ? ', FADING BIG-MOVE DAY — EXIT NOW recommended' : '';
        const deltaConf = s.delta_confirmation_state ? `, delta:${s.delta_confirmation_state}` : '';
        return `${dateLabel} ${time} — ${s.setup_type} (${outcome}${pnl}${bar6}${exitRec}${fadeExit}${deltaConf})`;
      });

      // Big-move-day signal — same persisted BIGMOVE_LIVE_SIGNAL row antigravityEdges.js reads
      // for the dashboard badge (server/routes/acd.js's setup-detection handler), surfaced here
      // too so the HA integration doesn't need a second endpoint for it.
      let bigMoveLine = null;
      try {
        const bmsQ = await query(`
          SELECT notes FROM performance_audit
          WHERE signal_type='BIGMOVE_LIVE_SIGNAL' AND signal_name=$1
        `, [currentSessionDate]);
        if (bmsQ.rows[0]) {
          const n = JSON.parse(bmsQ.rows[0].notes || '{}');
          bigMoveLine = `Big-move-day signal ACTIVE — session range ${n.rangeSoFar}pt, ${n.minutesRemaining}min remaining (triggered ${n.triggeredAt || ''})`;
        }
      } catch (_) { /* informational only, never block the response */ }

      // Sigma-continuation signal -- transient (unlike the big-move flag above), only shown if
      // triggered within the last 20 minutes, matching antigravityEdges.js's recency check.
      let sigmaLine = null;
      try {
        const scQ = await query(`
          SELECT notes FROM performance_audit
          WHERE signal_type='SIGMA_CONTINUATION_LIVE' AND run_date=$1
          ORDER BY created_at DESC LIMIT 1
        `, [currentSessionDate]);
        if (scQ.rows[0]) {
          const n = JSON.parse(scQ.rows[0].notes || '{}');
          const ageMin = n.triggeredAt ? (Date.now() - new Date(n.triggeredAt).getTime()) / 60000 : Infinity;
          if (ageMin <= 20) {
            sigmaLine = `Sigma-continuation signal ACTIVE — ${n.sigma}σ down move` + (n.expectedExtraPts != null ? `, ~${n.expectedExtraPts}pt more downside expected (60min horizon)` : '') + ` (triggered ${n.triggeredAt})`;
          }
        }
      } catch (_) { /* informational only, never block the response */ }

      const summaryLines = [bigMoveLine, sigmaLine].filter(Boolean).concat(lines);
      res.json({ count: lines.length, summary_text: summaryLines.join('\n') || 'No resolved setups yet.' });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/setups/:id/outcome ───────────────────────────────────────────
  router.post('/setups/:id/outcome', async (req, res) => {
    try {
      const { id } = req.params;
      const { resolution, actualPnl, priceAtResolution } = req.body; // resolution: TARGET_HIT|STOP_HIT|INVALIDATED
      const r = await query(`
        UPDATE active_setups
        SET status='RESOLVED', resolution=$2, actual_pnl=$3, price_at_resolution=$4,
            resolved_at=NOW(), updated_at=NOW()
        WHERE id=$1 AND status='ACTIVE'
        RETURNING *
      `, [id, resolution, actualPnl ?? null, priceAtResolution ?? null]);
      if (!r.rows.length) return res.status(404).json({ error: 'setup not found or already resolved' });
      await dropToTimeline(r.rows[0]);
      io.emit('setup-resolved', { setupId: parseInt(id), resolution, setupType: r.rows[0].setup_type });
      res.json({ ok: true, setup: r.rows[0] });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Setup types currently classified SUPPRESS/THIN_N by the live SETUP_STATUS pipeline —
  // tracked (fires as SHADOW) but not real live-traded. Used by /api/setups/history to let
  // the user filter these out by default, even for historical rows that pre-date the
  // demotion and still have status='RESOLVED'.
  // FIXED 2026-07-17: this used to be a hardcoded setup_type list that never re-synced with
  // the live pipeline — found stale (OPEN_DRIVE_SHORT, VALUE_AREA_RESPONSIVE_LONG/SHORT were
  // hardcoded here as permanently "shadow" while the live pipeline had already promoted all
  // three to ACTIVE), exactly the hardcoded-suppression-list anti-pattern the "unified
  // suppression pipeline" convention already exists to prevent elsewhere in this file. Now
  // reads performance_audit SETUP_STATUS fresh every call, matching the identical
  // recommendation IN ('SUPPRESS','THIN_N') logic as the live candidates array's
  // liveStats._suppressedSetups (~line 4768) — one definition of "shadow type," not two.
  async function getShadowSetupTypes() {
    const r = await query(`
      SELECT DISTINCT ON (signal_name) signal_name, recommendation
      FROM performance_audit WHERE signal_type='SETUP_STATUS'
      ORDER BY signal_name, run_date DESC
    `);
    return new Set(r.rows.filter(x => x.recommendation === 'SUPPRESS' || x.recommendation === 'THIN_N').map(x => x.signal_name));
  }
  // Legacy hardcoded fallback for setup_types that don't yet have a SETUP_STATUS row at all
  // (e.g. brand-new/shadow-only types never calibrated) — still shown as shadow so they
  // don't leak into the default view before their first calibration run. Defined in
  // server/config/setupTypes.js (not inline here) so scripts/test_invariants.mjs can import
  // the real list and verify none of its entries have quietly picked up a real SETUP_STATUS
  // row — see that file's comment for the 2026-07-17 prune (27 entries -> 5) this replaced.

  // ── GET /api/setups/history ───────────────────────────────────────────────
  router.get('/setups/history', async (req, res) => {
    try {
      const { from, to, type, resolution, shadow = 'hide', session = 'both', origin = 'all', hourFrom, hourTo, limit = 2000, offset = 0 } = req.query;
      const liveShadowTypes = await getShadowSetupTypes();
      const shadowTypes = [...new Set([...liveShadowTypes, ...UNCALIBRATED_SHADOW_TYPES])];
      // $1 = shadowTypes only when actually used (not for shadow=show/both, which apply no shadow filter at all)
      const noShadowFilter = shadow === 'show' || shadow === 'both';
      const params = noShadowFilter ? [] : [shadowTypes];
      const shadowRef = noShadowFilter ? null : `$1`;
      let conditions;
      if (shadow === 'only') {
        conditions = [`setup_type = ANY(${shadowRef})`];
      } else if (shadow === 'both') {
        // Live + Shadow both selected — true union, no shadow-related exclusion at all
        // (unlike 'show', which still excludes still-open status='SHADOW' rows).
        conditions = [];
      } else if (shadow === 'show') {
        conditions = ["status != 'SHADOW'"];
      } else {
        conditions = ["status != 'SHADOW'", `setup_type != ALL(${shadowRef})`];
      }
      // Hour-of-day filter (ET wall-clock hour of fired_at), added 2026-07-28 per direct
      // user request. fired_at is stored as a naive ET timestamp (see the naive-timestamp
      // hard rule in CLAUDE.md) so EXTRACT(HOUR ...) reads the real ET hour directly, no
      // timezone conversion needed.
      if (hourFrom !== undefined && hourFrom !== '') { params.push(parseInt(hourFrom)); conditions.push(`EXTRACT(HOUR FROM fired_at) >= $${params.length}`); }
      if (hourTo !== undefined && hourTo !== '') { params.push(parseInt(hourTo)); conditions.push(`EXTRACT(HOUR FROM fired_at) <= $${params.length}`); }
      // RTH = 9:30-15:59 ET, now backed by the persisted is_rth generated column (added
      // 2026-07-18) instead of a hand-rolled EXTRACT expression — see OPEN_DECISION
      // no_rth_column_trades_or_active_setups. 'overnight' had no real rows until the
      // Globex-hours poller fix (2026-07-16) started running, so a thin overnight bucket
      // is expected, not a bug.
      if (session === 'rth') {
        conditions.push(`is_rth = true`);
      } else if (session === 'overnight') {
        conditions.push(`is_rth = false`);
      }
      if (from) { params.push(from); conditions.push(`trade_date >= $${params.length}`); }
      if (to)   { params.push(to);   conditions.push(`trade_date <= $${params.length}`); }
      if (type) { params.push(type); conditions.push(`setup_type = $${params.length}`); }
      if (resolution) { params.push(resolution); conditions.push(`resolution = $${params.length}`); }
      // origin/real-vs-backfill breakdown — added 2026-07-28 after a direct user report of
      // misreading a Setup Log count (e.g. "62" rows for OR_LOW_FADE_LONG) as real live-fired
      // experience, when ~96% of it was actually origin_status='BACKFILL' (synthetic
      // reconstructed history). Computed over every OTHER active filter (type/date/shadow/
      // session/hour, all applied above) but deliberately BEFORE the origin filter itself is
      // applied, so the breakdown stays meaningful no matter which origin slice is currently
      // selected — filtering to origin=real and then showing "100% real" would be circular.
      const originWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const originBreakdownR = await query(`
        SELECT
          count(*) FILTER (WHERE origin_status IN ('ACTIVE','SHADOW'))::int as real_n,
          count(*) FILTER (WHERE origin_status = 'BACKFILL')::int as backfill_n,
          count(*) FILTER (WHERE origin_status = 'UNKNOWN' OR origin_status IS NULL)::int as unknown_n,
          count(*)::int as total_n
        FROM active_setups ${originWhere}
      `, params);
      const originBreakdown = originBreakdownR.rows[0];
      // Default 'all' preserves prior behavior; 'real' isolates ACTIVE+SHADOW (genuinely
      // live-detected, whether or not shown), 'backfill' isolates the synthetic population.
      if (origin === 'real') conditions.push(`origin_status IN ('ACTIVE','SHADOW')`);
      else if (origin === 'backfill') conditions.push(`origin_status = 'BACKFILL'`);
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const totalR = await query(`SELECT COUNT(*)::int as total FROM active_setups ${where}`, params);
      const total = totalR.rows[0]?.total || 0;
      params.push(parseInt(limit)); params.push(parseInt(offset));
      // current.win_rate/sample_size/ev_per_trade come from the live SETUP_STATUS pipeline
      // (recalibrated weekly/daily, server/scripts/backtest_setup_status.mjs) -- distinct from
      // historical_win_rate/historical_sessions below, which are a frozen snapshot written once
      // at fire time and never updated. Surfacing both, clearly labeled, instead of letting the
      // frozen one masquerade as current (found 2026-07-16: this table had no live-current stat
      // at all, only the frozen one, with nothing distinguishing them to the viewer).
      // matched_trade_* reuses the exact time-proximity LATERAL join already used by
      // /timeline/today (same file, ~line 6425) rather than reimplementing it -- this is the
      // only place in this table that reconciles the user's own executed trades against a
      // system-detected setup; previously there was none.
      //
      // Direction + price-proximity guards added 2026-07-16 (execution-quality audit,
      // docs/OPEN_THREADS.md): the original time-only 5-min match had no direction check and
      // matched ANY nearby trade regardless of price. Verified directly against raw rows --
      // 34% of same-window matches were the wrong direction, and even direction-matched rows
      // included entries hundreds of points from price_at_detection (e.g. MR1_FADE_LONG fired
      // at 21224.5, matched to an unrelated trade at 22323.25 -- 1098pt away, clearly a
      // different trade, not slippage). SETUP_TYPE_DIR mirrors inferDirection() in
      // server/config/setupTypes.js (strip _GAP_UP/_GAP_DOWN suffix, then LONG/BULLISH/_UP vs
      // SHORT/BEARISH/_DOWN, then UP/DOWN endswith fallback) -- can't import the JS function
      // into raw SQL, so this is a deliberate one-time port, not a reimplementation of new
      // logic. 30pt price window matches this codebase's existing "near a level" convention
      // (audit_setup_latency.mjs's PROXIMITY_PT=15, the live approach-alert 15-30pt zone).
      const r = await query(`
        SELECT s.id, s.trade_date::text, s.setup_type,
          TO_CHAR(s.fired_at, 'YYYY-MM-DD HH24:MI:SS') as fired_at_str,
          s.entry_zone_low, s.stop_level, s.t1_level, s.t1_label, s.status, s.resolution, s.actual_pnl,
          s.historical_win_rate, s.historical_sessions, s.price_at_detection,
          s.mae_points, s.mfe_points, s.resolution_method, s.bars_to_resolution, s.origin_status,
          TO_CHAR(s.resolved_at, 'YYYY-MM-DD HH24:MI:SS') as resolved_at_str,
          cur.win_rate as current_win_rate, cur.sample_size as current_sample_size, cur.ev_per_trade as current_ev,
          tr.pnl as matched_trade_pnl, tr.quantity as matched_trade_qty,
          TO_CHAR(tr.entry_time, 'HH24:MI:SS') as matched_trade_time
        FROM active_setups s
        LEFT JOIN LATERAL (
          SELECT win_rate, sample_size, ev_per_trade
          FROM performance_audit
          WHERE signal_type = 'SETUP_STATUS' AND signal_name = s.setup_type
          ORDER BY run_date DESC LIMIT 1
        ) cur ON true
        LEFT JOIN LATERAL (
          SELECT pnl, quantity, entry_time FROM trades t
          WHERE t.log_date = s.trade_date
            AND ABS(EXTRACT(EPOCH FROM (t.entry_time - s.fired_at))) < 300
            AND t.pnl IS NOT NULL
            AND t.direction = (CASE
              WHEN s.setup_type ~ '_GAP_(UP|DOWN)$' THEN
                CASE WHEN regexp_replace(s.setup_type, '_GAP_(UP|DOWN)$', '') ~* '(LONG|BULLISH|_UP)' THEN 'LONG'
                     WHEN regexp_replace(s.setup_type, '_GAP_(UP|DOWN)$', '') ~* '(SHORT|BEARISH|_DOWN)' THEN 'SHORT'
                     ELSE NULL END
              WHEN s.setup_type ~* '(LONG|BULLISH|_UP)' THEN 'LONG'
              WHEN s.setup_type ~* '(SHORT|BEARISH|_DOWN)' THEN 'SHORT'
              WHEN s.setup_type ~* 'UP$' THEN 'LONG'
              WHEN s.setup_type ~* 'DOWN$' THEN 'SHORT'
              ELSE NULL END)
            AND ABS(t.entry_price - COALESCE(s.entry_zone_low, s.price_at_detection)) <= 30
          ORDER BY ABS(EXTRACT(EPOCH FROM (t.entry_time - s.fired_at))) ASC
          LIMIT 1
        ) tr ON true
        ${where.replace(/\b(trade_date|setup_type|status|resolution|fired_at)\b/g, 's.$1')}
        ORDER BY s.trade_date DESC, s.fired_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `, params);
      const shadowSet = new Set(shadowTypes);
      const rows = r.rows.map(row => ({ ...row, is_shadow_type: shadowSet.has(row.setup_type) }));
      res.json({ setups: rows, count: rows.length, total, originBreakdown });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/setups/stats?type=IB_BULLISH ─────────────────────────────────
  router.get('/setups/stats', async (req, res) => {
    try {
      const { type } = req.query;
      if (!type) return res.status(400).json({ error: 'type required' });
      const stats = await getSetupStats(type);
      res.json(stats);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/timeline/today ────────────────────────────────────────────────
  const CONVICTION_KEY_BY_SETUP = {
    IB_BULLISH: 'ib_high', IB_BEARISH: 'ib_low',
    TRT_LONG: 'ib_low', TRT_SHORT: 'ib_high',
    TRT_LONG_V2: 'ib_low', TRT_SHORT_V2: 'ib_high',
    OPEN_DRIVE_LONG: 'ib_high', OPEN_DRIVE_SHORT: 'ib_low',
    C_STANDALONE_UP: 'ib_high', C_STANDALONE_DOWN: 'ib_low',
    BRACKET_BREAKOUT_LONG: 'bracket_high', BRACKET_BREAKOUT_SHORT: 'bracket_low',
    VALUE_AREA_RESPONSIVE_LONG: 'composite_val', VALUE_AREA_RESPONSIVE_SHORT: 'composite_vah',
    FAILED_AUCTION_LONG: 'bracket_low', FAILED_AUCTION_SHORT: 'bracket_high',
    A_UP_STRONG: 'ib_high', A_DOWN_STRONG: 'ib_low',
    A_UP_WEAK: 'ib_high', A_DOWN_WEAK: 'ib_low',
    C_PAIRED_LONG: 'ib_high', C_PAIRED_SHORT: 'ib_low',
    C_REVERSAL_LONG: 'ib_high', C_REVERSAL_SHORT: 'ib_low',
    GAP_FILL_LONG: 'bracket_high', GAP_FILL_SHORT: 'bracket_low',
  };

  router.get('/timeline/today', async (req, res) => {
    try {
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const { filter = 'significant' } = req.query;
      const r = await query(`
        SELECT t.*, s.setup_type as parent_setup_type, s.status as parent_status,
          s.actual_pnl, s.price_at_resolution, s.invalidation_timing,
          ROUND(EXTRACT(EPOCH FROM (COALESCE(s.resolved_at, NOW()) - s.fired_at))/60::numeric, 0) as minutes_active,
          t.event_time::text as event_time_str,
          tr.pnl as matched_trade_pnl,
          EXTRACT(EPOCH FROM (tr.entry_time - t.event_time)) as match_offset_secs
        FROM trade_timeline_events t
        LEFT JOIN active_setups s ON t.setup_id = s.id
        LEFT JOIN LATERAL (
          SELECT pnl, entry_time FROM trades tr2
          WHERE tr2.log_date = t.trade_date
            AND ABS(EXTRACT(EPOCH FROM (tr2.entry_time - t.event_time))) < 300
            AND tr2.pnl IS NOT NULL
            -- Direction + price-proximity guards added 2026-07-16 (execution-quality
            -- audit, docs/OPEN_THREADS.md) -- same fix as /setups/history's identical
            -- LATERAL join just above; t.direction/t.entry_zone are already stored on
            -- this row (dropToTimeline() sets them at insert time), so no re-derivation
            -- needed here. See /setups/history's comment for the full incident writeup.
            AND (t.direction IS NULL OR tr2.direction = t.direction)
            AND (t.entry_zone IS NULL OR ABS(tr2.entry_price - t.entry_zone) <= 30)
          ORDER BY ABS(EXTRACT(EPOCH FROM (tr2.entry_time - t.event_time))) ASC
          LIMIT 1
        ) tr ON true
        WHERE t.trade_date = $1
          AND (
            $2 = 'all'
            OR (
              t.event_type = 'SETUP'
              AND (t.historical_sessions >= 20 OR t.historical_win_rate IS NOT NULL)
              AND (
                t.resolution IN ('TARGET_HIT','STOP_HIT')
                OR t.resolution IS NULL
                OR (t.resolution = 'INVALIDATED' AND s.invalidation_timing = 'POST_ENTRY')
              )
            )
          )
        ORDER BY t.event_time
      `, [todayET, filter]);

      // Augment rows with conviction_key and estimated pts
      const conviction = await getConvictionData().catch(() => null);
      let nl30 = 0, structuralState = null;
      const cnl = getCached(todayET, 'nl30');
      if (cnl) { nl30 = cnl.nl30; structuralState = cnl.nl30State === 'BULLISH' ? 'TRENDING_UP' : cnl.nl30State === 'BEARISH' ? 'TRENDING_DOWN' : 'BALANCE'; }

      // Fetch MFE for POST_ENTRY invalidated setups: max favorable excursion from entry to invalidation
      // active_setups.fired_at and resolved_at store ET as TIMESTAMP WITHOUT TZ.
      // price_bars.ts stores UTC as TIMESTAMP WITHOUT TZ.
      // Use AT TIME ZONE to convert the ET timestamps to UTC before comparing.
      const postEntryInvalidated = r.rows.filter(
        ev => ev.resolution === 'INVALIDATED' && ev.invalidation_timing === 'POST_ENTRY' && ev.setup_id
      );
      const mfeBySetupId = {};
      if (postEntryInvalidated.length > 0) {
        const setupIds = postEntryInvalidated.map(ev => ev.setup_id);
        const setupTimes = await query(`
          SELECT id,
            fired_at::text as fired_at_str,
            resolved_at::text as resolved_at_str,
            entry_zone_low, setup_type
          FROM active_setups WHERE id = ANY($1)
        `, [setupIds]);
        for (const s of setupTimes.rows) {
          const isLong = (s.setup_type || '').includes('LONG') || (s.setup_type || '').includes('BULLISH');
          const entry = parseFloat(s.entry_zone_low) || null;
          if (!entry || !s.fired_at_str || !s.resolved_at_str) continue;
          try {
            // Cast text → timestamp AT TIME ZONE 'America/New_York' to get UTC-equivalent TIMESTAMPTZ,
            // then compare against price_bars.ts (UTC stored as TIMESTAMP WITHOUT TZ via session UTC).
            const mfeQ = await query(`
              SELECT ${isLong ? 'MAX(high)' : 'MIN(low)'}::float as mfe_price
              FROM price_bars_primary
              WHERE symbol='NQ'
                AND ts >= ($1::timestamp AT TIME ZONE 'America/New_York')::timestamp
                AND ts <= ($2::timestamp AT TIME ZONE 'America/New_York')::timestamp
            `, [s.fired_at_str, s.resolved_at_str]);
            const mfePrice = mfeQ.rows[0]?.mfe_price;
            if (mfePrice != null) {
              mfeBySetupId[s.id] = isLong
                ? Math.round(mfePrice - entry)
                : Math.round(entry - mfePrice);
            }
          } catch (_) {}
        }
      }

      const events = r.rows.map(ev => {
        const ck = CONVICTION_KEY_BY_SETUP[ev.setup_type] || null;
        const cvBase = ck && conviction ? conviction[ck] : null;
        const cvDynamic = cvBase ? computeDynamicConviction(cvBase, ck, { nl30, structuralState }) : null;
        const isLong = ev.direction === 'LONG';
        const entry = parseFloat(ev.entry_zone) || null;
        const t1 = parseFloat(ev.t1_level) || null;
        const stop = parseFloat(ev.stop_level) || null;
        const estimated_pts = (entry != null && t1 != null)
          ? Math.abs(t1 - entry)
          : null;
        const stop_pts = (entry != null && stop != null)
          ? Math.abs(stop - entry)
          : null;
        const mfe_pts = ev.setup_id ? (mfeBySetupId[ev.setup_id] ?? null) : null;
        return { ...ev, conviction_key: ck, conviction: cvDynamic || cvBase || null, estimated_pts, stop_pts, mfe_pts };
      });

      res.json({ events });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/setups/playbook-reference ────────────────────────────────────
  router.get('/setups/playbook-reference', async (req, res) => {
    try {
      // ACD backtest results — NL-aligned vs counter-trend for A signals
      const br = await query(`
        SELECT nl_aligned, win_rate::float, win_rate_nl_above_9::float,
          win_rate_nl_below_9::float, win_rate_nl_ranging::float,
          total_signals, filter_label
        FROM acd_backtest_results
        ORDER BY run_date DESC LIMIT 10
      `);
      const nlAligned    = br.rows.find(r => r.nl_aligned === true);
      const counterTrend = br.rows.find(r => r.nl_aligned === false);

      // Active setups win rates by type (from resolved setups with decisive outcomes)
      const sr = await query(`
        SELECT setup_type,
          COUNT(*) FILTER (WHERE resolution IN ('TARGET_HIT','STOP_HIT')) as decided,
          COUNT(*) FILTER (WHERE resolution = 'TARGET_HIT') as wins
        FROM active_setups
        WHERE resolution IN ('TARGET_HIT','STOP_HIT')
        GROUP BY setup_type
      `);
      const setupStats = {};
      for (const row of sr.rows) {
        const n = parseInt(row.decided);
        setupStats[row.setup_type] = {
          n,
          winRate: n > 0 ? Math.round(parseInt(row.wins) / n * 100) / 100 : null,
        };
      }

      res.json({
        aSignalAligned: nlAligned ? {
          winRate: nlAligned.win_rate,
          winRateNLAbove9: nlAligned.win_rate_nl_above_9,
          winRateNLRanging: nlAligned.win_rate_nl_ranging,
          totalSignals: nlAligned.total_signals,
        } : null,
        aSignalCounter: counterTrend ? {
          winRate: counterTrend.win_rate,
          winRateNLAbove9: counterTrend.win_rate_nl_above_9,
          winRateNLRanging: counterTrend.win_rate_nl_ranging,
          totalSignals: counterTrend.total_signals,
        } : null,
        setupStats,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Trade Feedback API ──────────────────────────────────────────────────
  const FEEDBACK_TAGS = [
    'absorption', 'level_confluence', 'momentum', 'volume', 'gut_read',
    'no_confluence', 'momentum_wrong', 'too_extended', 'after_loss', 'choppy',
  ];

  router.post('/acd/feedback', async (req, res) => {
    try {
      const { setupId, setupType, action, direction, tags, note, entryPrice, contracts } = req.body;
      if (!setupType || !action) return res.status(400).json({ error: 'setupType and action required' });
      if (!['TAKEN', 'PASSED'].includes(action)) return res.status(400).json({ error: 'action must be TAKEN or PASSED' });
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const r = await query(`
        INSERT INTO trade_feedback (trade_date, setup_id, setup_type, action, direction, tags, note, entry_price, contracts)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (trade_date, setup_type, setup_id) DO UPDATE SET
          action=EXCLUDED.action, tags=EXCLUDED.tags, note=EXCLUDED.note,
          entry_price=EXCLUDED.entry_price, contracts=EXCLUDED.contracts
        RETURNING *
      `, [todayET, setupId || null, setupType, action, direction || null,
          tags || [], note || null, entryPrice || null, contracts || 1]);
      res.json({ feedback: r.rows[0] });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.patch('/acd/feedback/:id/close', async (req, res) => {
    try {
      const { exitPrice, pnl, note } = req.body;
      const r = await query(`
        UPDATE trade_feedback SET exit_price=$2, pnl=$3, note=COALESCE($4, note), closed_at=NOW()
        WHERE id=$1 RETURNING *
      `, [req.params.id, exitPrice || null, pnl || null, note || null]);
      if (!r.rows.length) return res.status(404).json({ error: 'not found' });
      res.json({ feedback: r.rows[0] });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/acd/feedback/:id', async (req, res) => {
    try {
      const r = await query(`DELETE FROM trade_feedback WHERE id=$1 RETURNING id`, [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'not found' });
      res.json({ deleted: r.rows[0].id });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/acd/feedback', async (req, res) => {
    try {
      const days = parseInt(req.query.days) || 30;
      const r = await query(`
        SELECT f.*, s.resolution as system_resolution, s.actual_pnl as system_pnl
        FROM trade_feedback f
        LEFT JOIN active_setups s ON s.id = f.setup_id
        WHERE f.trade_date >= CURRENT_DATE - $1::int
        ORDER BY f.trade_date DESC, f.created_at DESC
      `, [days]);
      res.json({ feedback: r.rows, tags: FEEDBACK_TAGS });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/acd/feedback/calibration', async (req, res) => {
    try {
      const days = parseInt(req.query.days) || 90;

      // User WR by setup (trades they TOOK)
      const userWR = await query(`
        SELECT f.setup_type,
          COUNT(*) FILTER (WHERE f.pnl > 0)::int as user_wins,
          COUNT(*) FILTER (WHERE f.pnl IS NOT NULL)::int as user_decided,
          ROUND(AVG(f.pnl) FILTER (WHERE f.pnl IS NOT NULL)::numeric, 2) as user_avg_pnl
        FROM trade_feedback f
        WHERE f.action='TAKEN' AND f.trade_date >= CURRENT_DATE - $1::int
        GROUP BY f.setup_type
      `, [days]);

      // System WR by setup (all resolved setups, same period)
      const systemWR = await query(`
        SELECT setup_type,
          COUNT(*) FILTER (WHERE resolution='TARGET_HIT')::int as sys_wins,
          COUNT(*) FILTER (WHERE resolution IN ('TARGET_HIT','STOP_HIT'))::int as sys_decided,
          ROUND(AVG(actual_pnl) FILTER (WHERE resolution IN ('TARGET_HIT','STOP_HIT'))::numeric, 2) as sys_avg_pnl
        FROM active_setups
        WHERE status='RESOLVED' AND trade_date >= CURRENT_DATE - $1::int
        GROUP BY setup_type
      `, [days]);

      // User skip accuracy (trades they PASSED — what was the system outcome?)
      const skipWR = await query(`
        SELECT f.setup_type,
          COUNT(*) FILTER (WHERE s.resolution='TARGET_HIT')::int as skip_wins,
          COUNT(*) FILTER (WHERE s.resolution IN ('TARGET_HIT','STOP_HIT'))::int as skip_decided
        FROM trade_feedback f
        JOIN active_setups s ON s.id = f.setup_id
        WHERE f.action='PASSED' AND f.trade_date >= CURRENT_DATE - $1::int
          AND s.resolution IN ('TARGET_HIT','STOP_HIT')
        GROUP BY f.setup_type
      `, [days]);

      // Tag-level WR (which tags correlate with wins?)
      const tagWR = await query(`
        SELECT unnest(f.tags) as tag,
          COUNT(*) FILTER (WHERE f.pnl > 0)::int as wins,
          COUNT(*) FILTER (WHERE f.pnl IS NOT NULL)::int as decided,
          ROUND(AVG(f.pnl) FILTER (WHERE f.pnl IS NOT NULL)::numeric, 2) as avg_pnl
        FROM trade_feedback f
        WHERE f.action='TAKEN' AND f.trade_date >= CURRENT_DATE - $1::int
        GROUP BY unnest(f.tags)
        HAVING COUNT(*) FILTER (WHERE f.pnl IS NOT NULL) >= 3
      `, [days]);

      const sysMap = {}; for (const r of systemWR.rows) sysMap[r.setup_type] = r;
      const skipMap = {}; for (const r of skipWR.rows) skipMap[r.setup_type] = r;

      const calibration = userWR.rows.map(u => {
        const s = sysMap[u.setup_type] || {};
        const sk = skipMap[u.setup_type] || {};
        const userWr = u.user_decided > 0 ? u.user_wins / u.user_decided : null;
        const sysWr = s.sys_decided > 0 ? s.sys_wins / s.sys_decided : null;
        const skipWr = sk.skip_decided > 0 ? sk.skip_wins / sk.skip_decided : null;
        return {
          setupType: u.setup_type,
          userWR: userWr, userN: u.user_decided, userAvgPnl: u.user_avg_pnl,
          systemWR: sysWr, systemN: s.sys_decided || 0, systemAvgPnl: s.sys_avg_pnl,
          wrDelta: userWr != null && sysWr != null ? userWr - sysWr : null,
          skipWR: skipWr, skipN: sk.skip_decided || 0,
        };
      });

      res.json({ calibration, tagEdges: tagWR.rows, days, tags: FEEDBACK_TAGS });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Monte Carlo API (/acd/monte-carlo/run, /optimize, /runs, /runs/:id) removed 2026-07-17
  // -- confirmed zero frontend callers anywhere in src/ across this route's entire git
  // history (see docs/OPEN_THREADS.md, OPEN_DECISION consolidate_two_monte_carlo_
  // implementations), the exact duplicate-of-the-live-Scenario-Tester already flagged
  // earlier. monteCarloService.js itself (runMonteCarlo/runOptimizer/simulateRun/etc) is
  // KEPT, not deleted -- it's a real, actively-used engine (scripts/prop_test_2k_no_dll.mjs
  // imports it directly and found a real $/pt bug in it the same night), just no longer
  // wrapped in a live API route nothing was calling. monte_carlo_runs table left in place
  // (6 historical dev-test rows from 2026-06-22, harmless) but nothing will insert into it
  // going forward since this was its only writer.

  // Performance Audit — comprehensive setup/edge backtest results
  router.get('/performance-audit', async (req, res) => {
    try {
      const latest = await query(`SELECT MAX(run_date)::text as d FROM performance_audit`);
      const runDate = latest.rows[0]?.d;
      if (!runDate) return res.json({ results: [], runDate: null });
      const results = await query(`
        SELECT signal_type, signal_name, window_days, sample_size,
               win_rate::float, ev_per_trade::float, total_pnl::float,
               avg_mfe::float, p50_mfe::float, p75_mfe::float,
               avg_mae::float, p50_mae::float, p75_mae::float, p90_mae::float,
               recommendation, notes
        FROM performance_audit WHERE run_date = $1
        ORDER BY signal_type, ev_per_trade DESC NULLS LAST
      `, [runDate]);
      res.json({ results: results.rows, runDate });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Auto-suppression engine status — current SUPPRESS/PROMOTE list from backtest_setup_status.mjs
  router.get('/acd/setup-status', async (req, res) => {
    try {
      const r = await query(`
        SELECT DISTINCT ON (signal_name)
          signal_name AS setup_type,
          recommendation,
          sample_size,
          win_rate::float,
          ev_per_trade::float,
          total_pnl::float,
          notes,
          run_date::text
        FROM performance_audit
        WHERE signal_type = 'SETUP_STATUS'
        ORDER BY signal_name, run_date DESC
      `);
      const lastRun = r.rows[0]?.run_date ?? null;
      const suppressed = r.rows.filter(x => x.recommendation === 'SUPPRESS');
      const promoted   = r.rows.filter(x => x.recommendation === 'PROMOTE');
      res.json({ suppressed, promoted, lastRun, total: r.rows.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Regime-Adaptive Level Performance lived here too, unreachable dead code (shadowed by
  // keyLevels.js's richer copy, mounted before acd.js) — removed 2026-07-17 dead-routes
  // audit. See server/routes/keyLevels.js for the live implementation.

  // Target calibration coverage — makes the corrected-resim guardrail funnel visible
  // (docs/OPEN_THREADS.md 2026-07-19: "why aren't all 100+ setups calibrating" was
  // previously unanswerable without re-running the guardrail logic by hand — the
  // exclusion reason was computed and silently discarded). Every setup_type is
  // re-evaluated by update_optimal_stops.mjs on every weekly (Sun 10:30 PM ET) and daily
  // (4:20 PM ET) run — this endpoint's `lastRunDate` is direct proof of that cadence, not
  // a claim. Consumed by AlphaEngineOverview.jsx's "Target Calibration Coverage" section.
  router.get('/acd/target-calibration-coverage', async (req, res) => {
    try {
      const r = await query(`
        SELECT DISTINCT ON (signal_name) signal_name, notes, run_date
        FROM performance_audit WHERE signal_type='OPTIMAL_STOP'
        ORDER BY signal_name, run_date DESC
      `);
      const tally = {};
      const byReason = {};
      // Widening evidence (2026-07-19) — the concrete, ongoing answer to "are targets
      // actually learning to capture more of a move, not just using a different
      // methodology label." oldTarget is the pre-correction (order-blind, truncated-MFE)
      // target for the same setup_type; widenPct is how much further the guardrailed
      // resimulation validated riding the trade before this setup's own real data said
      // stop. No static "large move" threshold anywhere here — every number is this
      // setup's own before/after comparison, not a hardcoded cutoff.
      const widenings = [];
      for (const row of r.rows) {
        let n = null;
        try { n = typeof row.notes === 'string' ? JSON.parse(row.notes) : row.notes; } catch (_) {}
        const succeeded = n?.method === 'corrected-resim';
        const key = succeeded ? 'corrected_resim' : (n?.exclusionReason || 'stale_no_notes');
        tally[key] = (tally[key] || 0) + 1;
        if (!succeeded) (byReason[key] ||= []).push(row.signal_name);
        else if (n.oldTarget != null && n.bestTarget != null && n.oldTarget > 0) {
          widenings.push({ signal_name: row.signal_name, oldTarget: n.oldTarget, newTarget: n.bestTarget, widenPct: Math.round((n.bestTarget - n.oldTarget) / n.oldTarget * 100) });
        }
      }
      widenings.sort((a, b) => b.widenPct - a.widenPct);
      const lastRunDate = r.rows.reduce((max, row) => (!max || row.run_date > max ? row.run_date : max), null);
      res.json({
        total: r.rows.length,
        correctedResimCount: tally.corrected_resim || 0,
        tally,
        exclusionExamples: Object.fromEntries(Object.entries(byReason).map(([k, v]) => [k, v.slice(0, 5)])),
        widenings,
        widenedCount: widenings.filter(w => w.widenPct > 0).length,
        narrowedCount: widenings.filter(w => w.widenPct < 0).length,
        lastRunDate,
        schedule: 'Re-evaluated weekly (Sun 10:30 PM ET, scripts/run_weekly_backtests.sh) and daily (8:20 PM ET Mon-Fri, scripts/run_daily_calibration.sh) — every setup_type, every run, no manual promotion list.',
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Rigor/trend stability coverage — the aggregate answer to "does the live setup
  // roster's backtested edge actually hold up over time." Reads the SAME computeRigor()/
  // classifyTrend() output backtest_setup_status.mjs has been writing into every
  // SETUP_STATUS row's notes.rigor since 2026-07-14 (also already exposed per-row via
  // /performance-audit/unified's stabilityTrend/stabilityStable fields and shown in
  // BacktestView.jsx's "Stability" column) — this endpoint just adds the missing
  // aggregate view (breakdown counts + the DEGRADING setups called out by name) that
  // nothing surfaced before. No new computation, purely a summary of existing data.
  router.get('/acd/rigor-stability-coverage', async (req, res) => {
    try {
      const r = await query(`
        SELECT DISTINCT ON (signal_name) signal_name, sample_size, ev_per_trade, recommendation, notes, run_date
        FROM performance_audit WHERE signal_type='SETUP_STATUS'
        ORDER BY signal_name, run_date DESC
      `);
      const live = r.rows.filter(row => !['SUPPRESS', 'THIN_N'].includes(row.recommendation));
      const tally = {};
      const degrading = [];
      for (const row of live) {
        let n = null;
        try { n = typeof row.notes === 'string' ? JSON.parse(row.notes) : row.notes; } catch (_) {}
        const rigor = n?.rigor;
        const key = !rigor || rigor.top5_day_pct == null ? 'NO_DATA'
          : rigor.three_way_stable === true ? 'STABLE'
          : rigor.trend || 'NO_DATA';
        tally[key] = (tally[key] || 0) + 1;
        if (key === 'DEGRADING') {
          degrading.push({
            signal_name: row.signal_name, n: row.sample_size,
            ev: row.ev_per_trade != null ? Math.round(row.ev_per_trade * 100) / 100 : null,
            thirds: rigor.thirds,
          });
        }
      }
      degrading.sort((a, b) => b.n - a.n);
      const lastRunDate = live.reduce((max, row) => (!max || row.run_date > max ? row.run_date : max), null);
      res.json({
        total: live.length,
        tally,
        degrading,
        lastRunDate,
        schedule: 'Re-evaluated weekly (Sun 10:30 PM ET, scripts/run_weekly_backtests.sh) via backtest_setup_status.mjs — every live setup_type, every run.',
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Roster-rebuild roadmap status (Phase 8, 2026-08-11) — the read-back half of the whole
  // multi-week rebuild (scratch/MASTER_OPUS_ROSTER_REBUILD_ROADMAP.md). Before this
  // endpoint, none of bet_class, the roster cap, or the correlation monitor had any UI
  // surface at all — the entire rebuild was backend/DB-only, which is exactly the kind of
  // gap CLAUDE.md's own "no dead ends" hard rule (item 3, "actually wired to a consumer")
  // exists to catch. Deliberately read-only/descriptive — mirrors rigor-stability-coverage
  // above, does not gate or size anything live.
  router.get('/acd/roster-rebuild-status', async (req, res) => {
    try {
      const [betClassQ, corrBetClassQ, corrSetupTypeQ] = await Promise.all([
        query(`
          SELECT DISTINCT ON (signal_name) signal_name AS bet_class, sample_size, win_rate, ev_per_trade, notes, run_date::text
          FROM performance_audit WHERE signal_type='BET_CLASS_STATUS'
          ORDER BY signal_name, run_date DESC
        `).catch(() => ({ rows: [] })),
        query(`
          SELECT DISTINCT ON (signal_name) signal_name, sample_size AS overlap_n, ev_per_trade AS r, notes, run_date::text
          FROM performance_audit WHERE signal_type='CORRELATION_MONITOR_BET_CLASS'
          ORDER BY signal_name, run_date DESC
        `).catch(() => ({ rows: [] })),
        query(`
          SELECT DISTINCT ON (signal_name) signal_name, sample_size AS overlap_n, ev_per_trade AS r, notes, run_date::text
          FROM performance_audit WHERE signal_type='CORRELATION_MONITOR_SETUP_TYPE'
          ORDER BY signal_name, run_date DESC
        `).catch(() => ({ rows: [] })),
      ]);

      const liveClasses = assertRosterCapNotExceeded();
      const betClasses = betClassQ.rows.map(r => {
        let notes = null;
        try { notes = typeof r.notes === 'string' ? JSON.parse(r.notes) : r.notes; } catch (_) {}
        return {
          betClass: r.bet_class,
          stage: BET_CLASS_STAGE[r.bet_class] || 'UNSTAGED',
          n: r.sample_size,
          realN: notes?.all_time?.real_n ?? null,
          wr: r.win_rate,
          ev: r.ev_per_trade,
          rigorClean: notes?.rigor?.clean ?? null,
          runDate: r.run_date,
        };
      });

      // Trustworthy (non-too-thin) correlation pairs above/near the roadmap's own 0.6 ceiling,
      // pooled across both matrices — this is the "did anything actually flag" summary a
      // dashboard panel needs; full per-pair detail stays in performance_audit for anyone
      // who wants to query it directly.
      const allCorrRows = [...corrBetClassQ.rows, ...corrSetupTypeQ.rows];
      const flaggedPairs = allCorrRows
        .map(r => {
          let notes = null;
          try { notes = typeof r.notes === 'string' ? JSON.parse(r.notes) : r.notes; } catch (_) {}
          return { a: notes?.a, b: notes?.b, r: r.r != null ? +r.r : null, overlapN: r.overlap_n, tooThin: notes?.tooThin };
        })
        .filter(p => !p.tooThin && p.r != null && Math.abs(p.r) > 0.6);

      const lastCorrRunDate = allCorrRows.reduce((max, r) => (!max || r.run_date > max ? r.run_date : max), null);

      res.json({
        rosterCap: { cap: ROSTER_CAP, liveCount: liveClasses.length, liveClasses },
        betClasses,
        correlation: {
          betClassPairsChecked: corrBetClassQ.rows.length,
          setupTypePairsChecked: corrSetupTypeQ.rows.length,
          flaggedPairs,
          lastRunDate: lastCorrRunDate,
        },
        schedule: 'bet_class status + correlation monitor both re-evaluated weekly (run_weekly_backtests.sh) via backtest_bet_class_status.mjs / monitor_bet_correlation.mjs.',
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Unified Setup/Edge Table — single source of truth for all tradeable signals
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/performance-audit/unified', async (req, res) => {
    try {
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

      // Every query in this first batch depends only on `todayET` (or nothing at all) —
      // none depend on each other's results. Was ~18 sequential awaits (several wrapped
      // in their own try/catch, several inside a for-loop); confirmed via profiling
      // (2026-07-15) this was the dominant remaining cost of this endpoint even after
      // the earlier 18s->3.1s fix (which addressed a different bottleneck — the 30-date
      // replay's N+1/LATERAL-vs-partitioned-view issue, see the comment further below).
      // Collapsed into one Promise.all with per-query .catch() fallbacks matching each
      // original try/catch's silent-failure behavior — total wait is now the max of the
      // slowest single query, not the sum of ~18.
      const [
        latestRunQ, auditQ, priceQ, atrQ, pdVaQ, pdDvQ, acdQ, ibQ, pdIbQ, pdOrQ, or5Q,
        pdSessQ, trQ, last30Days, moQ, pmVaFull, m1VaQ, m3VaQ,
        pairsBaseQ, pairsSubQ, pairsWinQ, optStopLatestQ,
      ] = await Promise.all([
        // 1. Latest results per signal_type — each signal type has its own run cadence,
        // so a single global MAX(run_date) hides older signal types whenever any
        // fast-cycling type (e.g. ON_INVENTORY) runs and bumps the global max.
        query(`SELECT MAX(run_date)::text as d FROM performance_audit`),
        query(`
          WITH latest_per_type AS (
            SELECT signal_type, MAX(run_date) as latest_date
            FROM performance_audit GROUP BY signal_type
          )
          SELECT pa.signal_type, pa.signal_name, pa.sample_size,
                 pa.win_rate::float, pa.ev_per_trade::float, pa.total_pnl::float,
                 pa.avg_mfe::float, pa.p50_mfe::float, pa.p75_mfe::float,
                 pa.avg_mae::float, pa.p50_mae::float, pa.p75_mae::float, pa.p90_mae::float,
                 pa.current_stop::float, pa.current_target::float,
                 pa.optimal_stop::float, pa.optimal_target::float,
                 pa.recommendation, pa.notes
          FROM performance_audit pa
          JOIN latest_per_type l ON pa.signal_type = l.signal_type AND pa.run_date = l.latest_date
          ORDER BY pa.signal_type, pa.ev_per_trade DESC NULLS LAST
        `),
        // 2. Current price
        query(`SELECT close::float as close FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= CURRENT_DATE - 5 ORDER BY ts DESC LIMIT 1`),
        // 3. ATR(20) from daily true ranges
        query(`
          WITH daily AS (
            SELECT ts::date as d, MAX(high)::float as hi, MIN(low)::float as lo
            FROM price_bars_primary WHERE symbol='NQ'
              AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
            GROUP BY ts::date ORDER BY d DESC LIMIT 21
          ),
          trs AS (
            SELECT hi - lo as tr FROM daily ORDER BY d DESC LIMIT 20
          )
          SELECT AVG(tr)::float as atr20 FROM trs
        `).catch(() => ({ rows: [] })),
        // 4. Compute level prices — PD VA levels
        query(`
          SELECT poc::float, vah::float, val::float FROM developing_value_log
          WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 1
        `, [todayET]),
        // Floor pivots from prior day H/L/C
        query(`
          SELECT session_high::float as hi, session_low::float as lo, session_close::float as cl
          FROM developing_value_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 1
        `, [todayET]),
        // OR High/Low from today's ACD log
        query(`SELECT or_high::float, or_low::float FROM acd_daily_log WHERE trade_date=$1`, [todayET]),
        // IB High/Low from today's bars (9:30-10:30)
        query(`
          SELECT MAX(high)::float as ib_high, MIN(low)::float as ib_low
          FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
            AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 629
        `, [todayET]),
        // PD IB Mid (and individual PD IB High/Low) — bounded lower end (2026-07-15,
        // same fix as the level-fade candidates block's pdIbQ): unbounded ts::date < $1
        // in the inner MAX(ts::date) lookback forced a full historical scan (288ms->126ms).
        // BETWEEN 570 AND 629 (not 630) — this copy inherited the same off-by-one-minute
        // bug as the original pdIbQ (see that query's comment, ~line 4547, for the full
        // writeup); fixed both together 2026-07-16.
        query(`
          SELECT MAX(high)::float as ibh, MIN(low)::float as ibl
          FROM price_bars_primary WHERE symbol='NQ'
            AND ts::date = (SELECT MAX(ts::date) FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1 AND ts::date >= $1::date - 30
              AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 629)
            AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 629
        `, [todayET]).catch(() => ({ rows: [] })),
        // PD OR Mid (and individual PD OR High/Low)
        query(`SELECT or_high::float, or_low::float FROM acd_daily_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 1`, [todayET]).catch(() => ({ rows: [] })),
        // 5D OR Mid (rolling composite)
        query(`
          SELECT MAX(orh) as hi, MIN(orl) as lo FROM (
            SELECT or_high::float as orh, or_low::float as orl FROM acd_daily_log
            WHERE trade_date < $1 AND or_high IS NOT NULL ORDER BY trade_date DESC LIMIT 5
          ) t
        `, [todayET]).catch(() => ({ rows: [] })),
        // PD Session Mid
        query(`
          SELECT session_high::float as hi, session_low::float as lo
          FROM developing_value_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 1
        `, [todayET]).catch(() => ({ rows: [] })),
        // 5. Current regime raw data (vol/dir/range) — same methodology as the backtest script
        query(`
          WITH daily AS (
            SELECT ts::date as d,
              MAX(high)::float as hi, MIN(low)::float as lo, MAX(close)::float as cl
            FROM price_bars_primary WHERE symbol='NQ'
              AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
            GROUP BY ts::date ORDER BY d DESC LIMIT 25
          )
          SELECT d, hi - lo as tr, cl FROM daily ORDER BY d ASC
        `).catch(() => ({ rows: [] })),
        // 7. Last 30 trading dates (drives the replay batch below)
        query(`
          SELECT DISTINCT ts::date::text as d FROM price_bars_primary
          WHERE symbol='NQ' AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
          ORDER BY d DESC LIMIT 30
        `).catch(() => ({ rows: [] })),
        // Monthly levels
        query(`
          SELECT open::float as mo FROM price_bars_primary
          WHERE symbol='NQ' AND ts::date = (
            SELECT MIN(ts::date) FROM price_bars_primary
            WHERE symbol='NQ' AND date_trunc('month', ts) = date_trunc('month', CURRENT_DATE)
              AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 960
          ) ORDER BY ts LIMIT 1
        `).catch(() => ({ rows: [] })),
        query(`
          WITH vp AS (
            SELECT ROUND(close::float / 25)::int * 25 as bk, SUM(volume)::float as vol
            FROM price_bars_primary WHERE symbol='NQ'
              AND date_trunc('month', ts) = date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
              AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
            GROUP BY 1
          ), tot AS (SELECT SUM(vol)::float as t FROM vp),
          cum AS (SELECT bk, vol, SUM(vol) OVER (ORDER BY vol DESC) as cv, t FROM vp, tot)
          SELECT MAX(bk) FILTER (WHERE cv - vol < t * 0.7) as vah,
                 MIN(bk) FILTER (WHERE cv - vol < t * 0.7) as val FROM cum
        `).catch(() => ({ rows: [] })),
        query(`
          WITH vp AS (
            SELECT ROUND(close::float / 25)::int * 25 as bk, SUM(volume)::float as vol
            FROM price_bars_primary WHERE symbol='NQ'
              AND ts::date >= ($1::date - 30 * INTERVAL '1 day') AND ts::date < $1
              AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
            GROUP BY 1
          ), tot AS (SELECT SUM(vol)::float as t FROM vp),
          cum AS (SELECT bk, vol, SUM(vol) OVER (ORDER BY vol DESC) as cv, t FROM vp, tot)
          SELECT MAX(bk) FILTER (WHERE cv - vol < t * 0.7) as vah,
                 MIN(bk) FILTER (WHERE cv - vol < t * 0.7) as val FROM cum
        `, [todayET]).catch(() => ({ rows: [] })),
        query(`
          WITH vp AS (
            SELECT ROUND(close::float / 25)::int * 25 as bk, SUM(volume)::float as vol
            FROM price_bars_primary WHERE symbol='NQ'
              AND ts::date >= ($1::date - 90 * INTERVAL '1 day') AND ts::date < $1
              AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
            GROUP BY 1
          ), tot AS (SELECT SUM(vol)::float as t FROM vp),
          cum AS (SELECT bk, vol, SUM(vol) OVER (ORDER BY vol DESC) as cv, t FROM vp, tot)
          SELECT MAX(bk) FILTER (WHERE cv - vol < t * 0.7) as vah,
                 MIN(bk) FILTER (WHERE cv - vol < t * 0.7) as val FROM cum
        `, [todayET]).catch(() => ({ rows: [] })),
        // Confluence pairs (base/sub/rolling-window) — independent reads of performance_audit
        query(`
          SELECT signal_name, sample_size,
            ROUND(win_rate*100, 2)::float AS wr_pct,
            ROUND(ev_per_trade::numeric, 2)::float AS ev,
            recommendation
          FROM performance_audit
          WHERE signal_type='CONTEXT_ANALYSIS'
            AND signal_name LIKE 'PAIR_%'
            AND window_days = 9999
            AND signal_name NOT LIKE '%_DOW_%'
            AND signal_name NOT LIKE '%_TOD_%'
            AND signal_name NOT LIKE '%_DT_%'
          ORDER BY ev_per_trade DESC NULLS LAST
        `),
        query(`
          SELECT signal_name,
            ROUND(win_rate*100, 2)::float AS wr_pct,
            ROUND(ev_per_trade::numeric, 2)::float AS ev,
            sample_size, recommendation
          FROM performance_audit
          WHERE signal_type='CONTEXT_ANALYSIS'
            AND window_days = 9999
            AND (signal_name LIKE 'PAIR_%_DOW_%'
              OR signal_name LIKE 'PAIR_%_TOD_%'
              OR signal_name LIKE 'PAIR_%_DT_%')
          ORDER BY signal_name, ev_per_trade DESC NULLS LAST
        `),
        query(`
          SELECT signal_name, window_days,
            sample_size,
            ROUND(win_rate*100, 2)::float AS wr_pct,
            ROUND(ev_per_trade::numeric, 2)::float AS ev
          FROM performance_audit
          WHERE signal_type='CONTEXT_ANALYSIS'
            AND signal_name LIKE 'PAIR_%'
            AND window_days IN (365, 182, 20)
            AND signal_name NOT LIKE '%_DOW_%'
            AND signal_name NOT LIKE '%_TOD_%'
            AND signal_name NOT LIKE '%_DT_%'
          ORDER BY signal_name, window_days
        `),
        // Real per-setup calibration, correctly latest-per-signal_name (2026-07-20).
        // auditQ's own `latest_per_type` join (query 2 above) filters by MAX(run_date)
        // GROUPed BY signal_type alone -- fine for signal_types where every signal_name
        // is rewritten in lockstep on the same run, but OPTIMAL_STOP is not one of those:
        // update_optimal_stops.mjs's own population query can skip a signal_name on a
        // given run (thin data, direction inference failure, etc — see
        // /api/acd/target-calibration-coverage's own "stale_no_notes" bucket, currently
        // 7 signal_names), leaving that ONE row at an older run_date while every other
        // OPTIMAL_STOP row advances — auditQ's join then excludes it entirely, not just
        // shows it stale. Confirmed live: IB_HIGH_FADE_LONG (real optimal_stop=53,
        // optimal_target=35) was silently absent from auditQ.rows for exactly this
        // reason. This dedicated DISTINCT ON (signal_name) query is the same
        // latest-per-signal_name pattern CLAUDE.md's own OPTIMAL_STOP hard rule already
        // documents as correct — used here instead of trusting auditQ's per-type join.
        query(`
          SELECT DISTINCT ON (signal_name) signal_name, optimal_stop::float, optimal_target::float, notes
          FROM performance_audit WHERE signal_type='OPTIMAL_STOP'
          ORDER BY signal_name, run_date DESC
        `),
      ]);

      const runDate = latestRunQ.rows[0]?.d;
      if (!runDate) return res.json({ setups: [], runDate: null, currentPrice: null });

      const currentPrice = priceQ.rows[0]?.close || null;

      let atr20 = atrQ.rows[0]?.atr20 ? Math.round(atrQ.rows[0].atr20) : null;

      let pdPOC = null, pdVAH = null, pdVAL = null;
      if (pdVaQ.rows[0]) {
        pdPOC = pdVaQ.rows[0].poc;
        pdVAH = pdVaQ.rows[0].vah;
        pdVAL = pdVaQ.rows[0].val;
      }

      let floorP = null, floorR1 = null, floorS1 = null;
      if (pdDvQ.rows[0]) {
        const pdDv = pdDvQ.rows[0];
        floorP = (pdDv.hi + pdDv.lo + pdDv.cl) / 3;
        floorR1 = 2 * floorP - pdDv.lo;
        floorS1 = 2 * floorP - pdDv.hi;
      }

      let orH = null, orL = null;
      if (acdQ.rows[0]) {
        orH = acdQ.rows[0].or_high;
        orL = acdQ.rows[0].or_low;
      }

      let ibHigh = null, ibLow = null;
      if (ibQ.rows[0]) {
        ibHigh = ibQ.rows[0].ib_high;
        ibLow = ibQ.rows[0].ib_low;
      }

      let pdIbMid = null, pdIbHigh = null, pdIbLow = null;
      if (pdIbQ.rows[0]?.ibh) {
        pdIbHigh = pdIbQ.rows[0].ibh;
        pdIbLow  = pdIbQ.rows[0].ibl;
        pdIbMid  = (pdIbHigh + pdIbLow) / 2;
      }

      let pdOrMid = null, pdOrHigh = null, pdOrLow = null;
      if (pdOrQ.rows[0]?.or_high) {
        pdOrHigh = pdOrQ.rows[0].or_high;
        pdOrLow  = pdOrQ.rows[0].or_low;
        pdOrMid  = (pdOrHigh + pdOrLow) / 2;
      }

      let or5Mid = null;
      if (or5Q.rows[0]?.hi) or5Mid = (or5Q.rows[0].hi + or5Q.rows[0].lo) / 2;

      // IB Mid (today)
      const ibMid = ibHigh && ibLow ? (ibHigh + ibLow) / 2 : null;
      // OR Mid (today)
      const orMid = orH && orL ? (orH + orL) / 2 : null;

      let pdSessMid = null;
      if (pdSessQ.rows[0]?.hi) pdSessMid = (pdSessQ.rows[0].hi + pdSessQ.rows[0].lo) / 2;

      // 5. Current regime (vol/dir/range)
      let currentRegime = { vol: 'NORMAL', dir: 'NEUTRAL', range: 'NORMAL' };
      try {
        const days = trQ.rows;
        if (days.length >= 21) {
          const trs = days.map(d => d.tr);
          const closes = days.map(d => d.cl);
          const atr20v = trs.slice(-20).reduce((s, v) => s + v, 0) / 20;
          const atr5 = trs.slice(-5).reduce((s, v) => s + v, 0) / 5;
          const volZ = atr20v > 0 ? (atr5 / atr20v - 1) * 3 : 0; // simplified z-score
          currentRegime.vol = volZ > 0.5 ? 'EXPANDING' : volZ < -0.5 ? 'CONTRACTING' : 'NORMAL';

          // Direction from close drift
          const close5 = closes.slice(-5);
          const close20 = closes.slice(-20);
          const drift5 = close5.length >= 2 ? (close5[close5.length - 1] - close5[0]) / atr20v : 0;
          currentRegime.dir = drift5 > 0.5 ? 'BULLISH' : drift5 < -0.5 ? 'BEARISH' : 'NEUTRAL';

          // Range
          const lastTR = trs[trs.length - 1];
          const rangeRatio = atr20v > 0 ? lastTR / atr20v : 1;
          currentRegime.range = rangeRatio > 1.3 ? 'WIDE' : rangeRatio < 0.7 ? 'NARROW' : 'NORMAL';
        }
      } catch (_) {}

      const all30Dates = last30Days.rows.map(r => r.d);
      const recentDates = all30Dates.slice(0, 10);

      // 6. Regime fit + 7. recent replay batch — both independent of each other, and only
      // depend on values computed synchronously above (currentRegime, recentDates/all30Dates).
      const replayEligible = recentDates.length >= 5;
      const [regimeQ, recentSetups, priorAsOfQ, allBarsQ] = await Promise.all([
        query(`
          SELECT level_name, vs_overall, sample_size, win_rate::float, ev_per_trade::float
          FROM level_regime_performance
          WHERE vol_regime = $1 AND dir_regime = $2 AND range_regime = $3
            AND sample_size >= 5
        `, [currentRegime.vol, currentRegime.dir, currentRegime.range]),
        replayEligible ? query(`
          SELECT setup_type, resolution FROM active_setups
          WHERE trade_date = ANY($1::date[]) AND resolution IN ('TARGET_HIT','STOP_HIT')
        `, [recentDates]) : Promise.resolve({ rows: [] }),
        // 2026-07-15: was an N+1 pattern (4 sequential queries × 30 dates ≈ 120 round
        // trips, the confirmed dominant cost of this endpoint's ~18s response time). A
        // first batching attempt (LATERAL join for ALL of dv/ib/or against
        // price_bars_primary) was reverted the same session — EXPLAIN ANALYZE showed
        // ~114s, because the correlated IB lookback against price_bars_primary (a view
        // over ~40 monthly partitions) defeated partition pruning under LATERAL and
        // forced a sequential scan of every partition per outer date row. Fixed properly
        // below by sourcing IB high/low from `level_prices` instead — precomputed nightly
        // by scripts/compute_levels.js (already using the canonical 60-min IB window,
        // corrected in an earlier session), on a plain non-partitioned indexed table, so
        // no partition-pruning risk. Independently verified via Gemini (EXPLAIN ANALYZE:
        // <1ms; full 30-date correctness check) before wiring in — Gemini's pass also
        // caught a real, pre-existing gap (level_prices had zero rows for 2026-06-18,
        // a silent compute_levels.js --backfill skip under load, same known failure mode
        // documented elsewhere in this codebase) — backfilled that date before trusting
        // this as the new source. developing_value_log/acd_daily_log lookups were never
        // the slow part (neither is partitioned) — batched here too since it's free once
        // the dangerous IB lookup no longer forces a per-date correlated subquery. See
        // docs/OPEN_THREADS.md for the full incident writeup.
        replayEligible ? query(`
          WITH d AS (SELECT unnest($1::date[]) as dt)
          SELECT d.dt::text as date,
                 dv.trade_date as dv_found,
                 dv.poc::float, dv.vah::float, dv.val::float,
                 dv.session_high::float as hi, dv.session_low::float as lo, dv.session_close::float as cl,
                 ib.h::float as ib_h, ib.l::float as ib_l,
                 o.or_high::float as or_h, o.or_low::float as or_l
          FROM d
          LEFT JOIN LATERAL (
            SELECT trade_date, poc, vah, val, session_high, session_low, session_close
            FROM developing_value_log WHERE trade_date < d.dt ORDER BY trade_date DESC LIMIT 1
          ) dv ON true
          LEFT JOIN LATERAL (
            SELECT MAX(price) FILTER (WHERE level_name='IB_HIGH') as h,
                   MAX(price) FILTER (WHERE level_name='IB_LOW') as l
            FROM level_prices
            WHERE trade_date = (SELECT MAX(trade_date) FROM level_prices WHERE trade_date < d.dt AND level_name IN ('IB_HIGH','IB_LOW'))
              AND level_name IN ('IB_HIGH','IB_LOW')
          ) ib ON true
          LEFT JOIN LATERAL (
            SELECT or_high, or_low FROM acd_daily_log WHERE trade_date < d.dt ORDER BY trade_date DESC LIMIT 1
          ) o ON true
        `, [all30Dates]) : Promise.resolve({ rows: [] }),
        replayEligible ? query(`
          SELECT ts::date::text as date,
                 (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min,
                 close::float, high::float, low::float
          FROM price_bars_primary
          WHERE symbol='NQ' AND ts::date = ANY($1::date[])
            AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 720
          ORDER BY ts
        `, [all30Dates]) : Promise.resolve({ rows: [] }),
      ]);
      const regimeFitMap = {};
      for (const r of regimeQ.rows) {
        regimeFitMap[r.level_name] = r.vs_overall;
      }

      // Recent 10-day and 30-day per-level performance (quick replay)
      const recent10d = {}, recent30d = {};
      try {
        if (replayEligible) {
          // Group by setup_type
          for (const r of recentSetups.rows) {
            const name = r.setup_type.replace(/_FADE_(LONG|SHORT)$/, '').replace(/_FADE$/, '');
            if (!recent10d[name]) recent10d[name] = { wins: 0, total: 0 };
            recent10d[name].total++;
            if (r.resolution === 'TARGET_HIT') recent10d[name].wins++;
          }
          // Replay ALL levels for each of the last 30 days (10d is a subset).
          // priorAsOfQ/allBarsQ already fetched in the Promise.all batch above (see the
          // comment there for the 2026-07-15 N+1/LATERAL-vs-partitioned-view incident
          // this replay design fixed) — no re-query needed here.
          const priorAsOfByDate = {};
          for (const r of priorAsOfQ.rows) priorAsOfByDate[r.date] = r;

          const barsByDate = {};
          for (const r of allBarsQ.rows) {
            if (!barsByDate[r.date]) barsByDate[r.date] = [];
            barsByDate[r.date].push(r);
          }

          for (const date of all30Dates) {
            const dv = priorAsOfByDate[date];
            if (!dv || !dv.dv_found) continue; // no prior developing_value_log row — matches original dvQ.rows[0] undefined check
            const dayBars = { rows: barsByDate[date] || [] };
            if (dayBars.rows.length < 30) continue;

            // Compute all levels for this day
            const fp = dv.hi && dv.lo && dv.cl ? (dv.hi + dv.lo + dv.cl) / 3 : null;
            const fr1 = fp ? 2 * fp - dv.lo : null;
            const fs1 = fp ? 2 * fp - dv.hi : null;
            const orBars10 = dayBars.rows.filter(b => b.et_min < 575);
            const orH10 = orBars10.length ? Math.max(...orBars10.map(b => b.high)) : null;
            const ibBars10 = dayBars.rows.filter(b => b.et_min < 630);
            const ibH10 = ibBars10.length ? Math.max(...ibBars10.map(b => b.high)) : null;
            const ibL10 = ibBars10.length ? Math.min(...ibBars10.map(b => b.low)) : null;
            const pdIbMid10 = dv.ib_h ? (dv.ib_h + dv.ib_l) / 2 : null;
            const pdOrMid10 = dv.or_h ? (dv.or_h + dv.or_l) / 2 : null;
            const pdSessMid10 = dv.hi && dv.lo ? (dv.hi + dv.lo) / 2 : null;

            const allLevels = {
              PD_POC: dv.poc, PD_VAL: dv.val, PD_VAH: dv.vah,
              FLOOR_PIVOT: fp, FLOOR_R1: fr1, FLOOR_S1: fs1,
              OR5_HIGH: orH10, IB_HIGH: ibH10, IB_LOW: ibL10,
              PD_IB_MID: pdIbMid10, PD_OR_MID: pdOrMid10, PD_SESSION_MID: pdSessMid10,
              PD_OR_HIGH: dv.or_h, PD_OR_LOW: dv.or_l,
              PD_IB_HIGH: dv.ib_h, PD_IB_LOW: dv.ib_l,
            };

            const isIn10d = recentDates.includes(date);
            for (const [name, price] of Object.entries(allLevels)) {
              if (!price) continue;
              let touched = false;
              // Start at i=1 so we can always read the previous bar to determine approach direction
              for (let i = 1; i < dayBars.rows.length && !touched; i++) {
                if (Math.abs(dayBars.rows[i].close - price) <= 10) {
                  touched = true;
                  if (!recent30d[name]) recent30d[name] = { wins: 0, total: 0 };
                  recent30d[name].total++;
                  if (isIn10d) {
                    if (!recent10d[name]) recent10d[name] = { wins: 0, total: 0 };
                    recent10d[name].total++;
                  }
                  // Directional fade logic: determine approach direction from prior bar
                  const fromAbove = dayBars.rows[i - 1].close > price;
                  const horizon = Math.min(i + 30, dayBars.rows.length);
                  let won = false;
                  for (let j = i + 1; j < horizon; j++) {
                    const cl = dayBars.rows[j].close;
                    // Win: price bounces back in approach direction (20pt target)
                    if (fromAbove && cl > price + 20) { won = true; break; }
                    if (!fromAbove && cl < price - 20) { won = true; break; }
                    // Loss: price breaks through (30pt stop)
                    if (fromAbove && cl < price - 30) break;
                    if (!fromAbove && cl > price + 30) break;
                  }
                  if (won) {
                    recent30d[name].wins++;
                    if (isIn10d) recent10d[name].wins++;
                  }
                }
              }
            }
          }
        }
      } catch (_) {}

      // Monthly levels — moQ/pmVaFull/m1VaQ/m3VaQ already fetched in the batch above
      const monthOpen = moQ.rows[0]?.mo || null;
      const pmVAHaudit = pmVaFull.rows[0]?.vah || null;
      const pmVALaudit = pmVaFull.rows[0]?.val || null;
      const m1VAHaudit = m1VaQ.rows[0]?.vah || null;
      const m1VALaudit = m1VaQ.rows[0]?.val || null;
      const m3VAHaudit = m3VaQ.rows[0]?.vah || null;
      const m3VALaudit = m3VaQ.rows[0]?.val || null;

      // Map signal names to level prices and metadata.
      // bestCtx here is a purely qualitative fallback label (no %/N/$ claims) — used only
      // when a row has no live win_rate/sample_size/ev_per_trade to describe it from.
      // Found 2026-07-13: this map used to hardcode specific WR%/N/$ literals per level
      // (e.g. 'IB_HIGH': '90% WR level fade') that directly violated this file's own
      // documented hard rule ("Never write a stop, target, or WR claim as a literal
      // number in acd.js — always read from liveStats._opt[type] or performance_audit")
      // — and rendered live in BacktestView.jsx's Setups guide/table. describeLevel()
      // below now builds this text from each row's own live performance_audit fields
      // instead; the literal numbers here are gone, not just relabeled.
      const levelMap = {
        'PD_POC':       { price: pdPOC,    bestCtx: 'System anchor level', freq: '~1/day' },
        '5D_OR_MID':    { price: or5Mid,   bestCtx: 'Rolling composite', freq: '~0.5/day' },
        'PD_VAL':       { price: pdVAL,    bestCtx: 'Consistent performer, support fade', freq: '~0.8/day' },
        'PD_VAH':       { price: pdVAH,    bestCtx: 'High frequency level', freq: '~1.2/day' },
        'PD_IB_MID':    { price: pdIbMid,  bestCtx: 'PD midpoint fade', freq: '~0.5/day' },
        'FLOOR_PIVOT':  { price: floorP,   bestCtx: 'Structural reference', freq: '~0.8/day' },
        'OR5_HIGH':     { price: orH,      bestCtx: 'AM session strong', freq: '~0.7/day' },
        'FLOOR_R1':     { price: floorR1,  bestCtx: 'Thursday 1PM specialist', freq: '~0.5/day' },
        'PD_OR_MID':    { price: pdOrMid,  bestCtx: 'Good midpoint fade', freq: '~0.5/day' },
        // FLOOR_S1 removed from keepLevels 2026-07-03 (12+ backtest runs all negative EV)
        // 'FLOOR_S1':  { price: floorS1,  bestCtx: 'Support level', freq: '~0.5/day' },
        'IB_HIGH':      { price: ibHigh,   bestCtx: 'IB level fade', freq: '~0.8/day' },
        'IB_LOW':       { price: ibLow,    bestCtx: 'IB level fade', freq: '~0.8/day' },
        'IB_MID':       { price: ibMid,    bestCtx: 'Midpoint reference', freq: '~1/day' },
        'ON_HIGH':      { price: null,     bestCtx: 'Overnight high', freq: '~0.5/day' },
        'PD_IB_LOW':    { price: pdIbLow,  bestCtx: 'PD IB Low', freq: '~0.5/day' },
        'PD_IB_HIGH':   { price: pdIbHigh, bestCtx: 'PD IB High', freq: '~0.5/day' },
        'PD_OR_HIGH':   { price: pdOrHigh, bestCtx: 'PD OR High', freq: '~0.5/day' },
        'PD_OR_LOW':    { price: pdOrLow,  bestCtx: 'PD OR Low', freq: '~0.5/day' },
        'PD_SESSION_MID': { price: pdSessMid, bestCtx: 'PD session midpoint', freq: '~0.5/day' },
        '10D_IB_MID':   { price: null,     bestCtx: '10-day IB composite', freq: '~0.3/day' },
        'IB_MID_SCALP': { price: ibMid,    bestCtx: 'Tight-target scalp fade', freq: '~1.5/day' },
        'OR5_MID':      { price: orMid,    bestCtx: '5-min OR midpoint (tradeable as soon as OR completes)', freq: '~1/day' },
        'TRT_LONG':     { price: null,     bestCtx: 'Trend resumption', freq: '~0.3/day' },
        'IB_BEARISH_DIRECTION': { price: null, bestCtx: 'Directional context (IB break)', freq: '~0.4/day' },
        'IB_BULLISH_DIRECTION': { price: null, bestCtx: 'Directional context (IB break)', freq: '~0.5/day' },
        'MONTH_OPEN':  { price: monthOpen,   bestCtx: 'Monthly open fade', freq: '~1/month' },
        'PM_VAH':      { price: pmVAHaudit,  bestCtx: 'Prior-month VAH fade', freq: '~monthly' },
        'PM_VAL':      { price: pmVALaudit,  bestCtx: 'Prior-month VAL fade', freq: '~monthly' },
        'M1_VAH':      { price: m1VAHaudit,  bestCtx: '1-month rolling VAH fade', freq: '~daily' },
        'M1_VAL':      { price: m1VALaudit,  bestCtx: '1-month rolling VAL fade', freq: '~daily' },
        'M3_VAH':      { price: m3VAHaudit,  bestCtx: '3-month rolling VAH fade', freq: '~daily' },
        'M3_VAL':      { price: null,        bestCtx: '3-month rolling VAL fade', freq: '~daily' },
        // Directional display cards sourced from UNIFIED_BACKTEST (replaces CONTEXT/SCALP legacy orphan types)
        'IB_BULLISH':           { price: null,  bestCtx: 'IB breakout direction context (all-day-type blended)', freq: '~0.4/day' },
        'IB_BEARISH':           { price: null,  bestCtx: 'IB breakdown direction context (all-day-type blended)', freq: '~0.4/day' },
        'IB_MID_SCALP_LONG':   { price: ibMid, bestCtx: 'Scalp fade LONG from IB midpoint', freq: '~1.5/day' },
        'IB_MID_SCALP_SHORT':  { price: ibMid, bestCtx: 'Scalp fade SHORT from IB midpoint', freq: '~1.5/day' },
        'OR5_MID_LONG':  { price: orMid, bestCtx: 'Scalp fade LONG from 5-min OR midpoint', freq: '~1/day' },
        'OR5_MID_SHORT': { price: orMid, bestCtx: 'Scalp fade SHORT from 5-min OR midpoint', freq: '~1/day' },
      };

      // Builds the level's context description from its OWN live performance_audit
      // fields (win_rate/sample_size/ev_per_trade, already fetched into `row` above) —
      // falls back to the qualitative levelMap label only when no numeric stat exists.
      function describeLevel(row, fallbackLabel) {
        const parts = [];
        if (row.win_rate != null) parts.push(`${Math.round(row.win_rate * 100)}% WR`);
        if (row.sample_size != null) parts.push(`N=${row.sample_size}`);
        if (row.ev_per_trade != null) parts.push(`$${Math.round(row.ev_per_trade)}/trade`);
        if (row.sample_size != null && row.sample_size < 20) parts.push('(thin sample)');
        return parts.length ? parts.join(', ') : fallbackLabel;
      }

      // Build unified setups array
      const setups = [];
      // Removed 2026-07-20: a 14-entry hand-typed stop/t1/t2 override map — the exact
      // "never hand-type a WR%/N/$ literal" anti-pattern CLAUDE.md has caught 7 other
      // times, an 8th instance sitting unnoticed here. Checked directly before removing:
      // 13 of 14 entries were already fully redundant (a real OPTIMAL_STOP row exists for
      // every signal_name they covered, and `optByName` above already takes priority over
      // this map, so the hardcoded values were silently dead — never actually reached).
      // Only TRT_LONG (N=16, below the N>=20 calibration floor) still lacked real data;
      // per the same hard rule ("never hand-type... even as a placeholder"), it now
      // correctly shows `--` (honestly uncalibrated) instead of a stale guess, and will
      // pick up real data automatically the moment update_optimal_stops.mjs can compute
      // one — same self-healing pattern as everything else in this file.

      // Priority order for dedup: SETUP_STATUS > LEVEL_FADE_AUDIT / MIDPOINT_FADE_AUDIT > SYSTEM_BACKTEST
      // UNIFIED_BACKTEST: shown only for the specific signal_names that replace CONTEXT/SCALP legacy orphan types.
      //
      // FOUND 2026-07-18 (while verifying unified_display_allowlist_vs_dynamic_criteria's new
      // dynamic UNIFIED_BACKTEST filter actually deduplicated anything): displayPrimary listed
      // signal_types ('LEVEL_FADE', 'PD_LEVEL', 'SCALP', 'ROLLING') that don't exist ANYWHERE in
      // the live database (confirmed via direct query, 0 rows for all four) -- this codebase's
      // current primary calibration source is 'SETUP_STATUS', evidently the successor to
      // whatever produced those four signal_types before a past refactor, which never updated
      // this Set to match. hasPrimary() has been silently returning false for every call this
      // whole time, meaning its OTHER two use sites below (SYSTEM_BACKTEST and the 3 audit
      // types) have also never actually deduplicated against a real primary source, despite
      // their own comments saying they should. Also fixed a second, independent mismatch found
      // in the same investigation: SETUP_STATUS's own naming always includes "_FADE" before the
      // direction suffix (PD_HIGH_FADE_SHORT) while UNIFIED_BACKTEST/SYSTEM_BACKTEST/the audit
      // types never do (PD_HIGH_SHORT) -- an exact-string match would still fail to find a
      // SETUP_STATUS row for the same level even with the signal_type fixed. normalizeSetupName
      // strips "_FADE_" so both conventions compare equal; a name that never had "_FADE" (e.g.
      // TRT_LONG, IB_BULLISH) is unaffected by the strip.
      const normalizeSetupName = (name) => name.replace('_FADE_', '_');
      const displayPrimary = new Set(['SETUP_STATUS']);
      const hasPrimary = (name) => {
        const norm = normalizeSetupName(name);
        return auditQ.rows.some(r => displayPrimary.has(r.signal_type) && normalizeSetupName(r.signal_name) === norm);
      };
      const hasSystemBacktest = (name) => auditQ.rows.some(r => r.signal_name === name && r.signal_type === 'SYSTEM_BACKTEST');

      // UNIFIED_BACKTEST rows shown in the table (replaces CONTEXT/SCALP/SETUP legacy orphan
      // types) — dynamic as of 2026-07-18, replacing a hand-curated Set. See OPEN_DECISION
      // unified_display_allowlist_vs_dynamic_criteria for the full investigation: a naive
      // "N>=20 and EV>=-$5" filter alone would have flooded this table with dozens of thin/
      // duplicate directional facets of levels already shown via their own LEVEL_FADE/
      // SETUP_STATUS row (confirmed directly — 66 of 158 all-time UNIFIED_BACKTEST rows
      // classify ACTIVE, most of them exactly these duplicates, e.g. CAM_R1_SHORT/
      // FLOOR_PIVOT_LONG/CAM_R2_LONG). scripts/backtest_unified.js now writes a real
      // SUPPRESS/THIN_N/ACTIVE/PROMOTE recommendation onto every UNIFIED_BACKTEST row (same
      // thresholds as backtest_setup_status.mjs, not re-derived) — combined with the
      // already-existing hasPrimary() check below (previously only used to gate
      // LEVEL_FADE_AUDIT/SYSTEM_BACKTEST rows), that's enough to replace the hardcoded list:
      // show a row only if it independently clears the same bar every other setup_type does
      // AND isn't just re-surfacing a level already shown elsewhere. ACTIVE and PROMOTE both
      // count as "clears the bar" — PROMOTE is a narrower recovery-from-suppression state in
      // backtest_setup_status.mjs's own vocabulary, but on a UNIFIED_BACKTEST row's first-ever
      // classification pass nothing has suppression history yet, so requiring PROMOTE alone
      // (as literally read from the original decision text) would show almost nothing;
      // ACTIVE is the correct "good enough to trust, no exception involved" state.
      // 2D_POC_LONG/SHORT, PD2_VAH_LONG/SHORT, PD2_VAL_LONG/SHORT used to classify ACTIVE
      // under this backtest_unified.js pass (wrong entry-price convention + the old volume-
      // bucketing bug — confirmed via Gemini audit, independently re-verified by reading
      // detectLevelFades()/buildTwoDayPOC() directly), directly contradicting the CONFIRMED
      // RESEARCH_CLAIM 2d_poc_fade_no_edge (scripts/backtest_pd2_2dpoc_complete.mjs). A
      // hand-maintained CONFIRMED_NO_EDGE_OVERRIDE Set used to live here as a display-only
      // patch. Removed 2026-07-19: fixed at the root instead — the real gap wasn't the
      // display, it was that this CONFIRMED finding had never been wired into the live
      // unified suppression pipeline at all (these types had ~0 real active_setups history,
      // so backtest_setup_status.mjs had nothing to suppress). backtest_pd2_2dpoc_complete.mjs
      // now writes real SETUP_STATUS rows (SUPPRESS for the 3 N>=20 LONG variants, THIN_N for
      // the thin SHORT ones) using its own validated simulation — hasPrimary() below already
      // excludes any UNIFIED_BACKTEST row with a matching SETUP_STATUS row, so this override
      // is now redundant AND the underlying live-candidate-construction gap (server/routes/
      // acd.js's keepLevelsAll reads UNIFIED_BACKTEST stats directly, with no display-only
      // override applying there) is actually closed, not just hidden from this one table.
      const isUnifiedDisplayWorthy = (row) =>
        (row.recommendation === 'ACTIVE' || row.recommendation === 'PROMOTE')
        && !hasPrimary(row.signal_name);

      // Real live-used stop/target, keyed by signal_name — added 2026-07-20. Before this,
      // the stop/t1/t2 shown for a SETUP_STATUS-sourced row (the overwhelming majority of
      // this table) never read the real OPTIMAL_STOP calibration at all — the values shown
      // instead came from a hand-typed `overrides` literal (the exact "never hand-type a
      // WR%/N/$ literal" anti-pattern CLAUDE.md has caught 7 other times, removed) or a raw
      // MAE/MFE percentile fallback with no relationship to what's actually live. Sourced
      // from the dedicated optStopLatestQ (see its own query comment above) rather than
      // auditQ.rows — auditQ's per-signal_type latest-run join silently drops any
      // OPTIMAL_STOP signal_name that wasn't touched by the single most recent run.
      const optByName = new Map();
      for (const r of optStopLatestQ.rows) {
        let notes = null;
        try { notes = typeof r.notes === 'string' ? JSON.parse(r.notes) : r.notes; } catch (_) {}
        optByName.set(r.signal_name, { stop: r.optimal_stop, target: r.optimal_target, method: notes?.method || null });
      }

      for (const row of auditQ.rows) {
        if (row.signal_type === 'SYSTEM_SUMMARY') continue;
        if (row.signal_type === 'ROLLING_IB_AUDIT') continue;
        // TOUCH_QUALITY: a secondary per-setup_type dimension (order-flow classification of
        // HOW a touch resolved), not a tradeability verdict on its own — the setup_type's real
        // ACTIVE/CONTEXT/REMOVED status already comes from its SETUP_STATUS row above. Forcing
        // OVERRUN_BAD/ABSORBED_BEST/QUIET_BEST/NO_CLEAR_PATTERN into that status vocabulary would
        // misrepresent it as a suppression signal. Deliberately excluded (was previously an
        // undocumented silent fallthrough to the generic `else continue` below — the exact class
        // of bug CLAUDE.md's "New setup type checklist" item 8 exists to prevent). Shown instead
        // via the live ACDView.jsx badge (touchQualityStats on /api/antigravity/edges-context).
        // Found in code review 2026-07-15.
        if (row.signal_type === 'TOUCH_QUALITY') continue;
        // UNIFIED_BACKTEST: only show the specific signal_names above; everything else feeds keepLevels only
        if (row.signal_type === 'UNIFIED_BACKTEST' && !isUnifiedDisplayWorthy(row)) continue;
        // SYSTEM_BACKTEST is fallback only when no primary source (LEVEL_FADE etc.) exists
        if (row.signal_type === 'SYSTEM_BACKTEST' && hasPrimary(row.signal_name)) continue;
        // Audit types are suppressed when a primary source or SYSTEM_BACKTEST exists for the same signal
        if ((row.signal_type === 'LEVEL_FADE_AUDIT' || row.signal_type === 'MIDPOINT_FADE_AUDIT' || row.signal_type === 'PD_IB_AUDIT') && (hasPrimary(row.signal_name) || hasSystemBacktest(row.signal_name))) continue;

        // Normalize win_rate: PD_IB_AUDIT and some older audit scripts stored on 0-100 scale instead of 0-1
        const winRate = row.win_rate > 1 && (row.signal_type === 'LEVEL_FADE_AUDIT' || row.signal_type === 'MIDPOINT_FADE_AUDIT' || row.signal_type === 'PD_IB_AUDIT')
          ? row.win_rate / 100 : row.win_rate;

        const meta = levelMap[row.signal_name] || {};
        const levelPrice = meta.price != null ? Math.round(meta.price * 100) / 100 : null;
        const dist = levelPrice != null && currentPrice != null ? Math.round(Math.abs(currentPrice - levelPrice)) : null;

        // Determine status
        let status;
        if (row.signal_type === 'UNIFIED_BACKTEST') {
          // IB_BULLISH/BEARISH: always CONTEXT — EV is blended across day types (good on TREND, bad on BALANCE)
          if (row.signal_name === 'IB_BULLISH' || row.signal_name === 'IB_BEARISH') {
            status = 'CONTEXT';
          } else {
            const ev = row.ev_per_trade || 0;
            const wr = row.win_rate || 0;
            if (ev > 0 && wr >= 0.52) status = 'ACTIVE';
            else if (ev < -5)          status = 'REMOVED';
            else                       status = 'CONTEXT';
          }
        } else if (row.recommendation === 'KEEP' || row.recommendation === 'ACTIVE' || row.recommendation === 'PROMOTE') {
          status = 'ACTIVE';
        } else if (row.recommendation === 'DIRECTIONAL' || row.recommendation === 'CONTEXT' || row.recommendation === 'DLL_TRADEABLE' || row.recommendation === 'THIN' || row.recommendation === 'THIN_N' || row.recommendation === 'DAY_TYPE_MANAGED') {
          status = 'CONTEXT';
        } else if (row.recommendation === 'CUT' || row.recommendation === 'SUPPRESS') {
          status = 'REMOVED';
        } else {
          continue; // skip analytical rows with no display status (null, non-standard)
        }

        // Determine type
        let type;
        if (row.signal_type === 'SCALP' ||
            (row.signal_type === 'UNIFIED_BACKTEST' && (row.signal_name.includes('_SCALP_') || row.signal_name.startsWith('OR5_MID')))) {
          type = 'SCALP';
        } else if (row.signal_type === 'CONTEXT' ||
            (row.signal_type === 'UNIFIED_BACKTEST' && (row.signal_name === 'IB_BULLISH' || row.signal_name === 'IB_BEARISH'))) {
          type = 'CONTEXT';
        } else if (row.signal_type === 'SETUP') {
          type = 'SETUP';
        } else {
          type = 'LEVEL_FADE';
        }

        // Next 2 day probability based on ATR distance
        let next2DayProb = null;
        if (dist != null && atr20 != null) {
          if (dist <= atr20 * 0.5) next2DayProb = 'VERY_HIGH';
          else if (dist <= atr20) next2DayProb = 'HIGH';
          else if (dist <= atr20 * 1.5) next2DayProb = 'MEDIUM';
          else next2DayProb = 'LOW';
        }

        // Regime fit
        const regimeFit = regimeFitMap[row.signal_name] || null;

        // Stability/trend classification from backtest_setup_status.mjs's rigor diagnostics
        // (day-clustering + 3-way chronological EV-sign stability, added 2026-07-14). Only
        // meaningful for SETUP_STATUS rows — other signal_types don't write this field.
        let stabilityTrend = null, stabilityStable = null;
        if (row.signal_type === 'SETUP_STATUS' && row.notes) {
          try {
            const parsed = JSON.parse(row.notes);
            stabilityTrend = parsed.rigor?.trend || null;
            stabilityStable = parsed.rigor?.three_way_stable;
          } catch (_) {}
        }

        // Tests applied
        const tests = [];
        if (row.signal_type === 'SYSTEM_BACKTEST') tests.push(`180d system backtest (N=${row.sample_size})`);
        else if (row.signal_type === 'LEVEL_FADE') tests.push(`Level fade audit (N=${row.sample_size})`);
        else if (row.signal_type === 'SCALP' || row.signal_type === 'UNIFIED_BACKTEST') tests.push(`Unified backtest (N=${row.sample_size})`);
        else if (row.signal_type === 'CONTEXT') tests.push(`Context analysis (N=${row.sample_size})`);
        else tests.push(`${row.signal_type} (N=${row.sample_size})`);
        if (regimeFit) tests.push('regime analysis');
        if (row.avg_mae != null) tests.push('MAE/MFE audit');

        const opt = optByName.get(row.signal_name);
        setups.push({
          name: row.signal_name.replace(/_/g, ' '),
          rawName: row.signal_name,
          type,
          signalType: row.signal_type,
          wr: winRate,
          ev: row.ev_per_trade,
          totalPnl: status === 'ACTIVE' ? row.total_pnl : null,
          n: row.sample_size,
          stop: opt?.stop ?? row.current_stop ?? (row.p75_mae ? Math.round(row.p75_mae) : null),
          t1: opt?.target ?? row.current_target ?? (row.p50_mfe ? Math.round(row.p50_mfe) : null),
          t2: row.p75_mfe ? Math.round(row.p75_mfe) : null,
          targetMethod: opt?.method || null,
          runner: !!(row.p75_mfe && row.p50_mfe && row.p75_mfe > row.p50_mfe * 1.2),
          mae: row.avg_mae,
          mfe: row.avg_mfe,
          p50mae: row.p50_mae,
          p75mae: row.p75_mae,
          p90mae: row.p90_mae,
          p50mfe: row.p50_mfe,
          bestContext: describeLevel(row, meta.bestCtx) || row.notes || '',
          regimeFit,
          frequency: meta.freq || null,
          levelPrice,
          distFromPrice: dist,
          next2DayProb,
          wr10d: recent10d[row.signal_name]?.total >= 2 ? recent10d[row.signal_name].wins / recent10d[row.signal_name].total : null,
          n10d: recent10d[row.signal_name]?.total || 0,
          wr30d: recent30d[row.signal_name]?.total >= 3 ? recent30d[row.signal_name].wins / recent30d[row.signal_name].total : null,
          n30d: recent30d[row.signal_name]?.total || 0,
          trend10d: (() => {
            const r10 = recent10d[row.signal_name];
            if (!r10 || r10.total < 2) return null;
            const wr10 = r10.wins / r10.total;
            const diff = wr10 - (winRate || 0);
            return diff > 0.05 ? 'UP' : diff < -0.05 ? 'DOWN' : 'FLAT';
          })(),
          testsApplied: tests.join(', '),
          status,
          recommendation: row.recommendation,
          notes: row.notes,
          stabilityTrend,
          stabilityStable,
        });
      }

      // Sort: ACTIVE first (by EV desc), then CONTEXT, then REMOVED
      const statusOrder = { ACTIVE: 0, CONTEXT: 1, REMOVED: 2 };
      setups.sort((a, b) => {
        const so = (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3);
        if (so !== 0) return so;
        return (b.ev || 0) - (a.ev || 0);
      });

      // Final-pass dedup by rawName — after sort so highest-status entry wins.
      // Prevents duplicates when the same signal appears in multiple signal types
      // (e.g. a level in LEVEL_FADE_AUDIT but not the current LEVEL_FADE run, plus SYSTEM_BACKTEST).
      const seenNames = new Set();
      const dedupedSetups = setups.filter(s => {
        if (seenNames.has(s.rawName)) return false;
        seenNames.add(s.rawName);
        return true;
      });

      // ── Confluence pairs ──────────────────────────────────────────────
      // pairsBaseQ/pairsSubQ/pairsWinQ already fetched in the batch above (all-time
      // reads of performance_audit, no dependency on anything else in this handler).

      // Index sub-conditions: pick best and worst per category per pair
      const subBest = {}, subWorst = {};
      pairsSubQ.rows.forEach(r => {
        const isDOW = /_DOW_\w+$/.test(r.signal_name);
        const isTOD = /_TOD_\w+$/.test(r.signal_name);
        const isDT  = /_DT_\w+$/.test(r.signal_name);
        const cat = isDOW ? 'DOW' : isTOD ? 'TOD' : isDT ? 'DT' : null;
        if (!cat) return;
        const base = r.signal_name.replace(/_DOW_\w+$/, '').replace(/_TOD_\w+$/, '').replace(/_DT_\w+$/, '');
        const key = base + '_' + cat;
        const suffix = isDOW ? r.signal_name.match(/_DOW_(\w+)$/)?.[1]
                     : isTOD ? r.signal_name.match(/_TOD_(\w+)$/)?.[1]
                     : r.signal_name.match(/_DT_(\w+)$/)?.[1];
        const entry = { label: suffix, n: r.sample_size, wr: r.wr_pct, ev: r.ev, rec: r.recommendation };
        if (!subBest[key])  subBest[key]  = entry;
        if (!subWorst[key]) subWorst[key] = entry;
        else if (r.ev < subWorst[key].ev) subWorst[key] = entry;
      });

      // Build rolling windows index
      const pairWins = {};
      pairsWinQ.rows.forEach(r => {
        if (!pairWins[r.signal_name]) pairWins[r.signal_name] = {};
        pairWins[r.signal_name][r.window_days] = { n: r.sample_size, wr: r.wr_pct, ev: r.ev };
      });

      const pairs = pairsBaseQ.rows.map(r => {
        const base = r.signal_name;
        const pairKey = base.replace(/^PAIR_/, '');
        const wins = pairWins[base] || {};
        const wr20  = wins[20]?.wr,  ev20  = wins[20]?.ev,  n20  = wins[20]?.n;
        const trend = (wr20 != null && r.wr_pct != null)
          ? (wr20 > r.wr_pct + 5 ? 'UP' : wr20 < r.wr_pct - 5 ? 'DOWN' : 'FLAT') : null;
        return {
          pair: pairKey,
          n: r.sample_size,
          wr: r.wr_pct,
          ev: r.ev,
          recommendation: r.recommendation,
          status: r.recommendation === 'TRADE' ? 'ACTIVE'
                : r.recommendation === 'CUT'   ? 'REMOVED'
                : 'CONTEXT',
          trend,
          wr20, ev20, n20,
          wr6m: wins[182]?.wr, ev6m: wins[182]?.ev,
          wr1y: wins[365]?.wr, ev1y: wins[365]?.ev,
          best_dow:  subBest[base + '_DOW']  || null,
          worst_dow: subWorst[base + '_DOW'] || null,
          best_tod:  subBest[base + '_TOD']  || null,
          worst_tod: subWorst[base + '_TOD'] || null,
          best_dt:   subBest[base + '_DT']   || null,
          worst_dt:  subWorst[base + '_DT']  || null,
        };
      });

      // Get SYSTEM_SUMMARY for the header
      const summary = auditQ.rows.find(r => r.signal_type === 'SYSTEM_SUMMARY');

      res.json({
        currentPrice,
        atr20,
        currentRegime,
        runDate,
        systemSummary: summary ? {
          totalPnl: summary.total_pnl,
          totalTrades: summary.sample_size,
          wr: summary.win_rate,
          ev: summary.ev_per_trade,
          notes: summary.notes,
        } : null,
        setups: dedupedSetups,
        pairs,
      });
    } catch (err) {
      console.error('Unified audit error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Market Pulse — lightweight live state for MarketPulseBar ───────────────
  // Returns: currentPrice, session range, cumulative delta, RVol, engagement verdict.
  // Polled every 30s during RTH. Range/delta percentiles cached daily.
  router.get('/market/pulse', async (req, res) => {
    try {
      const now = new Date();
      const etOffset = -4; // EDT
      const etNow = new Date(now.getTime() + etOffset * 3600000);
      const todayET = etNow.toISOString().split('T')[0];
      const etHour = etNow.getUTCHours();
      const etMin  = etNow.getUTCMinutes();
      const etMinTotal = etHour * 60 + etMin;
      const isRTH = etMinTotal >= 570 && etMinTotal < 960 &&
        etNow.getUTCDay() >= 1 && etNow.getUTCDay() <= 5;

      // Current price + session bars + live setup + ACD state
      const [priceQ, sessionQ, rthBarsQ, setupQ, acdQ] = await Promise.all([
        query(`SELECT close::float FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= CURRENT_DATE - 5 ORDER BY ts DESC LIMIT 1`),
        query(`SELECT MAX(high)::float as h, MIN(low)::float as l FROM price_bars_primary
               WHERE symbol='NQ' AND ts::date=$1
               AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959`, [todayET]),
        query(`SELECT close::float, COALESCE(ask_volume,0)::int as ask_vol, COALESCE(bid_volume,0)::int as bid_vol, volume::int,
               (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min
               FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
               AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
               ORDER BY ts`, [todayET]),
        query(`SELECT setup_type, status FROM active_setups
               WHERE trade_date=$1 AND status IN ('PENDING','ACTIVE','ACTIVE_MANAGING')
               ORDER BY fired_at DESC LIMIT 1`, [todayET]),
        query(`SELECT a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed, day_type
               FROM acd_daily_log WHERE trade_date=$1 LIMIT 1`, [todayET]),
      ]);

      const currentPrice = priceQ.rows[0]?.close ?? null;
      const sessionHigh = sessionQ.rows[0]?.h ?? null;
      const sessionLow  = sessionQ.rows[0]?.l ?? null;
      const bars = rthBarsQ.rows;
      const sessionOpen = bars[0]?.close ?? null;
      const sessionRange = sessionHigh && sessionLow ? +(sessionHigh - sessionLow).toFixed(1) : null;
      const ptsFromOpen = currentPrice && sessionOpen ? +(currentPrice - sessionOpen).toFixed(1) : null;

      // Cumulative delta
      const sessionDelta = bars.reduce((s, b) => s + (b.ask_vol - b.bid_vol), 0);
      const sessionVolume = bars.reduce((s, b) => s + (b.volume || 0), 0);

      // Cached daily: range percentiles + delta percentiles + avg volume
      let rangeP25 = null, rangeP50 = null, rangeP75 = null;
      let deltaP25 = null, deltaP75 = null;
      let avgSessionVol = null;

      const cached = getCached(todayET, 'marketPulse');
      if (cached) {
        ({ rangeP25, rangeP50, rangeP75, deltaP25, deltaP75, avgSessionVol } = cached);
      } else {
        const [rangeQ, deltaQ, volQ] = await Promise.all([
          query(`
            WITH daily AS (
              SELECT ts::date as d, MAX(high)-MIN(low) as rng
              FROM price_bars_primary WHERE symbol='NQ'
                AND ts::date < $1
                AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
                AND EXTRACT(DOW FROM ts) BETWEEN 1 AND 5
              GROUP BY 1 HAVING COUNT(*)>200
            )
            SELECT
              PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY rng)::float as p25,
              PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY rng)::float as p50,
              PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY rng)::float as p75
            FROM daily`, [todayET]),
          query(`
            WITH daily AS (
              SELECT ts::date as d,
                ABS(SUM(COALESCE(ask_volume,0)-COALESCE(bid_volume,0)))::float as abs_delta
              FROM price_bars_primary WHERE symbol='NQ'
                AND ts::date < $1
                AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
                AND EXTRACT(DOW FROM ts) BETWEEN 1 AND 5
              GROUP BY 1 HAVING COUNT(*)>200
            )
            SELECT
              PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY abs_delta)::float as p25,
              PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY abs_delta)::float as p75
            FROM daily`, [todayET]),
          query(`
            WITH daily AS (
              SELECT ts::date as d, SUM(volume)::float as total_vol
              FROM price_bars_primary WHERE symbol='NQ'
                AND ts::date < $1
                AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
                AND EXTRACT(DOW FROM ts) BETWEEN 1 AND 5
              GROUP BY 1 HAVING COUNT(*)>200
              ORDER BY d DESC LIMIT 20
            )
            SELECT AVG(total_vol)::float as avg FROM daily`, [todayET]),
        ]);
        rangeP25 = rangeQ.rows[0]?.p25 ?? null;
        rangeP50 = rangeQ.rows[0]?.p50 ?? null;
        rangeP75 = rangeQ.rows[0]?.p75 ?? null;
        deltaP25 = deltaQ.rows[0]?.p25 ?? null;
        deltaP75 = deltaQ.rows[0]?.p75 ?? null;
        avgSessionVol = volQ.rows[0]?.avg ?? null;
        setCached(todayET, 'marketPulse', { rangeP25, rangeP50, rangeP75, deltaP25, deltaP75, avgSessionVol });
      }

      // Derived signals
      const absDelta = Math.abs(sessionDelta);
      const deltaSign = sessionDelta > 0 ? 'BUYING' : sessionDelta < 0 ? 'SELLING' : 'NEUTRAL';
      let deltaClass = 'NORMAL';
      if (deltaP25 != null && absDelta < deltaP25) deltaClass = 'QUIET';
      else if (deltaP75 != null && absDelta > deltaP75) deltaClass = 'HIGH';

      // Range extension: where is today's range relative to historical?
      let rangeClass = 'NORMAL';
      if (rangeP25 != null && sessionRange < rangeP25) rangeClass = 'QUIET';
      else if (rangeP75 != null && sessionRange > rangeP75) rangeClass = 'EXTENDED';

      // RVol: time-of-day adjusted — last bar vs 90-day per-minute baseline (same method as VOLUME_SPIKE alert)
      // This makes the chip consistent with the VOLUME SPIKE banner in TradeAlertBanner.
      let rvol = null, rvolSigma = null;
      const last3 = bars.slice(-3);
      if (last3.length > 0) {
        try {
          const minLo = Math.min(...last3.map(b => b.et_min));
          const minHi = Math.max(...last3.map(b => b.et_min));
          const volBaseQ = await query(`
            SELECT (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min,
                   AVG(volume::float) as avg_vol, STDDEV(volume::float) as std_vol
            FROM price_bars_primary WHERE symbol='NQ'
            AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) BETWEEN $1 AND $2
            AND ts::date >= $3::date - 90 AND ts::date < $3
            GROUP BY et_min
          `, [minLo, minHi, todayET]);
          const baseline = {};
          for (const r of volBaseQ.rows) baseline[r.et_min] = { avg: +r.avg_vol, std: +r.std_vol };
          let maxSigma = -Infinity, maxRatio = 1;
          for (const b of last3) {
            const bl = baseline[b.et_min];
            if (!bl || bl.avg <= 0) continue;
            const sig = bl.std > 0 ? (b.volume - bl.avg) / bl.std : 0;
            if (sig > maxSigma) { maxSigma = sig; maxRatio = b.volume / bl.avg; }
          }
          if (maxSigma > -Infinity) {
            rvol = +maxRatio.toFixed(2);
            rvolSigma = +maxSigma.toFixed(2);
          }
        } catch (_) {}
      }

      // Engagement verdict — uses active setup, ACD signals, delta/range, time of day
      const liveSetup = setupQ.rows[0] ?? null;
      const acd       = acdQ.rows[0]  ?? null;

      // Direction from setup_type name (e.g. IB_MID_SCALP_FADE_LONG → LONG)
      const setupDir = liveSetup?.setup_type?.includes('_LONG')  ? 'LONG'
        :              liveSetup?.setup_type?.includes('_SHORT') ? 'SHORT'
        : null;

      // ACD directional read — C-confirmed is strong, A-only is softer
      const aUpStrong   = acd?.a_up_fired   && acd?.c_up_confirmed;
      const aDownStrong = acd?.a_down_fired  && acd?.c_down_confirmed;
      const acdDir = aUpStrong   ? 'LONG'
        :            aDownStrong ? 'SHORT'
        :            acd?.a_up_fired   ? 'LONG'
        :            acd?.a_down_fired ? 'SHORT'
        : null;

      // After 3:30 PM ET with nothing live — wind down
      const isWindDown = etMinTotal >= 930 && !liveSetup;

      let verdict    = 'WAIT';
      let verdictDir = null;

      if (isWindDown) {
        verdict = 'STAND_ASIDE';
      } else if (liveSetup) {
        // Active fired setup is the clearest signal we have — go
        verdict    = 'ENGAGE';
        verdictDir = setupDir;
      } else if ((aUpStrong || aDownStrong) && deltaClass !== 'QUIET') {
        // A+C confirmed with some participation — high conviction directional
        verdict    = 'ENGAGE';
        verdictDir = acdDir;
      } else if (acdDir && rangeClass !== 'QUIET' && deltaClass === 'HIGH') {
        // A-only + strong flow — engage but softer
        verdict    = 'ENGAGE';
        verdictDir = acdDir;
      } else if (deltaClass === 'QUIET' && rangeClass === 'QUIET' && !acdDir) {
        // No flow, no range expansion, no ACD — nothing to trade
        verdict = 'STAND_ASIDE';
      } else if (deltaClass === 'HIGH' && rangeClass !== 'QUIET') {
        // Strong flow even without a named setup — worth watching
        verdict    = 'ENGAGE';
        verdictDir = deltaSign === 'BUYING' ? 'LONG' : 'SHORT';
      }

      res.json({
        currentPrice,
        sessionOpen,
        sessionHigh,
        sessionLow,
        sessionRange,
        ptsFromOpen,
        sessionDelta,
        deltaSign,
        deltaClass,
        absDelta,
        deltaP25, deltaP75,
        rangeP25, rangeP50, rangeP75,
        rangeClass,
        rvol,
        rvolSigma,
        verdict,
        verdictDir,
        isRTH,
        barsLoaded: bars.length,
        ts: new Date().toISOString(),
      });
    } catch (e) {
      console.error('market/pulse error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Live Reads — log manual trade reads with auto market context ─────────
  router.post('/live-reads', async (req, res) => {
    try {
      const { direction, entryPrice, note, attributed_setups, outcome, pnl_pts } = req.body;
      if (!direction || !entryPrice) return res.status(400).json({ error: 'direction and entryPrice required' });

      const now = new Date();
      const etOffset = -4;
      const etNow = new Date(now.getTime() + etOffset * 3600000);
      const todayET = etNow.toISOString().split('T')[0];

      // Auto-attach market context
      const [barQ, levelQ, dayTypeQ] = await Promise.all([
        query(`SELECT close::float, open::float, high::float, low::float,
                 COALESCE(ask_volume,0)::int as ask_vol, COALESCE(bid_volume,0)::int as bid_vol,
                 EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) as et_min
               FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
               AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
               ORDER BY ts DESC LIMIT 1`, [todayET]),
        query(`SELECT level_name, price::float as level_value FROM level_prices
               WHERE trade_date=$1 ORDER BY ABS(price - $2) LIMIT 3`, [todayET, entryPrice]).catch(() => ({ rows: [] })),
        query(`SELECT day_type FROM acd_daily_log WHERE trade_date=$1`, [todayET]),
      ]);

      const bar = barQ.rows[0];
      const barBodyPct = bar && (bar.high - bar.low) > 0
        ? Math.round(Math.abs(bar.close - bar.open) / (bar.high - bar.low) * 100)
        : null;
      const barDir = bar ? (bar.close > bar.open ? 'UP' : bar.close < bar.open ? 'DOWN' : 'FLAT') : null;
      const etMinAtEntry = bar ? parseInt(bar.et_min) : null;
      const dayType = dayTypeQ.rows[0]?.day_type ?? null;
      const nearestLevel = levelQ.rows[0] ? {
        name: levelQ.rows[0].level_name,
        value: levelQ.rows[0].level_value,
        dist: Math.round(Math.abs(entryPrice - levelQ.rows[0].level_value)),
      } : null;

      // Cumulative delta to this point
      const deltaQ = await query(`
        SELECT SUM(COALESCE(ask_volume,0)-COALESCE(bid_volume,0))::int as cum_delta
        FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND $2`,
        [todayET, etMinAtEntry ?? 959]);
      const cumDelta = deltaQ.rows[0]?.cum_delta ?? 0;

      const r = await query(`
        INSERT INTO live_reads
          (trade_date, logged_at, direction, entry_price, note,
           nearest_level_name, nearest_level_value, nearest_level_dist,
           bar_body_pct, bar_dir, et_min, day_type, cum_delta_at_entry,
           attributed_setups, outcome, pnl_pts)
        VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING *`,
        [todayET, direction, entryPrice, note || null,
         nearestLevel?.name || null, nearestLevel?.value || null, nearestLevel?.dist || null,
         barBodyPct, barDir, etMinAtEntry, dayType, cumDelta,
         attributed_setups?.length ? attributed_setups : null,
         outcome || null, pnl_pts ?? null]);

      res.json({ ok: true, read: r.rows[0] });
    } catch (e) {
      console.error('live-reads POST error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/live-reads', async (req, res) => {
    try {
      const date = req.query.date || new Date().toLocaleDateString('en-CA');
      const r = await query(
        `SELECT * FROM live_reads WHERE trade_date=$1 ORDER BY logged_at DESC`, [date]);
      res.json({ reads: r.rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
