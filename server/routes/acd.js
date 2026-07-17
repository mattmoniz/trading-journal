// ACD Routes — full implementation extracted from server/index.js lines ~4759-7220
// Covers: /api/acd/*, /api/acd/backtest/*, /api/acd/weekly/*, weekly ACD computation

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { query } from '../db.js';
import { directionFromType } from '../services/maeMfeReplay.js';
import { getVolumeBaseline, classifyTouch } from '../services/touchQuality.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { getMarketStatus, getEarlyCloseMinute } from '../services/marketCalendar.js';
import { getGLine, getGLineDaysHeld, getConvictionData, computeDynamicConviction, getTrailingVwapStd } from '../services/queries.js';
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

// ── Setup-detection level cache (structural data that changes at most daily) ──
// Keyed by trade date + cache key. Default TTL = 60 seconds for intraday stability;
// callers with a naturally-daily-scoped value (already keyed by date, so a stale-day
// read is impossible) can pass a longer ttl instead of reinventing a second cache —
// see getTouchQualityCalib/getTouchQualityBaseline below, which used to hand-roll
// their own module-level date-compare cache next to this one. Found in code review
// 2026-07-15, consolidated onto this existing helper instead.
const _levelCache = {};
const LEVEL_CACHE_TTL = 60000;
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
  const active = await query(`
    SELECT id, setup_type, trade_date::text as trade_date, fired_at::text as fired_at, entry_zone_low, entry_zone_high, stop_level, t1_level, status, touch_quality
    FROM active_setups WHERE status IN ('ACTIVE', 'SHADOW')
  `);

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

    let resolution = null, resolvedAt = null, priceAtRes = null, method = null;
    let runMfe = 0, runMae = 0, barCount = 0;
    for (const bar of bars.rows) {
      barCount++;
      const favorable = long ? bar.high - entry : entry - bar.low;
      const adverse   = long ? entry - bar.low  : bar.high - entry;
      runMfe = Math.max(runMfe, favorable);
      runMae = Math.max(runMae, adverse);

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
              `UPDATE active_setups SET touch_quality=$2, touch_quality_vol_z=$3 WHERE id=$1 AND touch_quality IS NULL`,
              [row.id, tq.bucket, Math.round(tq.maxVolZ * 100) / 100]
            );
          }
        }
      } catch (e) {
        console.error('touch-quality classification error (non-critical):', e.message);
      }
    }

    if (!resolution) continue;

    const pnl = resolution === 'TARGET_HIT'
      ? (long ? (t1 - entry) : (entry - t1)) * PNL_PER_POINT - COMMISSION
      : (long ? (stop - entry) : (entry - stop)) * PNL_PER_POINT - COMMISSION;

    const updated = await query(`
      UPDATE active_setups
      SET status='RESOLVED', resolution=$2, resolution_method=$3, actual_outcome=$2,
          actual_pnl=$4, price_at_resolution=$5, resolved_at=$6, updated_at=NOW(),
          mae_points=$8, mfe_points=$9, bars_to_resolution=$10,
          resolution_bar_time=$6, replay_resolution=$2
      WHERE id=$1 AND status=$7
      RETURNING *
    `, [row.id, resolution, method, Math.round(pnl * 100) / 100, priceAtRes, resolvedAt, statusMatch,
        Math.round(runMae * 100) / 100, Math.round(runMfe * 100) / 100, barCount]);

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
async function detectGlobexSetup(sessionDate, io) {
  try {
    const [priceRow, pdRow, auditRow] = await Promise.all([
      query(`SELECT close::float as price FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= CURRENT_DATE - 5 ORDER BY ts DESC LIMIT 1`),
      query(`SELECT vah::float, val::float, poc::float FROM developing_value_log ORDER BY trade_date DESC LIMIT 1`),
      query(`SELECT signal_name, p75_mae, p50_mfe FROM performance_audit
             WHERE signal_type='UNIFIED_BACKTEST' AND window_days=9999
               AND signal_name IN ('PD_VAH_SHORT','PD_VAL_LONG','PD_POC_SHORT','PD_POC_LONG')
             ORDER BY sample_size DESC`),
    ]);
    if (!priceRow.rows[0] || !pdRow.rows[0]) return null;
    const px = priceRow.rows[0].price;
    const { vah, val, poc } = pdRow.rows[0];

    const auditMap = {};
    for (const r of auditRow.rows) if (!auditMap[r.signal_name]) auditMap[r.signal_name] = r;
    const globexParams = (key) => ({
      stop: parseFloat(auditMap[key]?.p75_mae ?? 65),
      t1:   parseFloat(auditMap[key]?.p50_mfe ?? 40),
    });

    const TOUCH = 15; // proximity window — consistent with RTH level detection system-wide

    const pocDir = px >= poc ? 'SHORT' : 'LONG';
    const candidates = [
      { level: vah, name: 'PD VAH', type: 'PD_VAH_FADE_SHORT', dir: 'SHORT', auditKey: 'PD_VAH_SHORT' },
      { level: val, name: 'PD VAL', type: 'PD_VAL_FADE_LONG',  dir: 'LONG',  auditKey: 'PD_VAL_LONG'  },
      { level: poc, name: 'PD POC', type: `PD_POC_FADE_${pocDir}`, dir: pocDir, auditKey: `PD_POC_${pocDir}` },
    ].filter(c => c.level != null && Math.abs(px - c.level) <= TOUCH);

    for (const c of candidates) {
      const existing = await query(
        `SELECT 1 FROM active_setups WHERE trade_date=$1 AND setup_type=$2 LIMIT 1`,
        [sessionDate, c.type]
      );
      if (existing.rows.length) continue;

      const { stop: STOP, t1: T1 } = globexParams(c.auditKey);
      const isLong = c.dir === 'LONG';
      const entry  = px;
      const stop   = isLong ? px - STOP  : px + STOP;
      const target = isLong ? px + T1    : px - T1;

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
      const ins = await query(`
        INSERT INTO active_setups (
          trade_date, setup_type, fired_at, expires_at, status,
          entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label,
          price_at_detection, historical_win_rate, historical_sessions
        ) VALUES ($1,$2,NOW(),$3,'ACTIVE',$4,$5,$6,$7,$8,$9,NULL,NULL)
        ON CONFLICT (trade_date, setup_type, COALESCE(status, '')) WHERE status IN ('ACTIVE','SHADOW') DO NOTHING
        RETURNING id, entry_zone_low, stop_level, t1_level
      `, [sessionDate, c.type, expiresAt, entry, entry, stop, target, `T1: ${Math.round(T1)}pt (${c.name})`, entry]);

      if (!ins.rows[0]) continue; // ON CONFLICT — already exists

      const rr = (Math.abs(target - entry) / Math.abs(entry - stop)).toFixed(1);
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

// Expires any ACTIVE setups past their expires_at; emits socket events.
export async function expireStaleSetups(io) {
  // SHADOW rows from prior dates have no expires_at and accumulate forever, eventually
  // causing unique-constraint conflicts when the same setup fires again. Purge them.
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  await query(`DELETE FROM active_setups WHERE status = 'SHADOW' AND trade_date < $1`, [todayET]);

  const expired = await query(`
    UPDATE active_setups
    SET status = 'EXPIRED', resolution = 'TIME_EXPIRED', resolved_at = NOW(), updated_at = NOW()
    WHERE status IN ('ACTIVE', 'SHADOW')
      AND expires_at IS NOT NULL
      AND expires_at < NOW()
    RETURNING *
  `);
  for (const row of expired.rows) {
    try { await dropToTimeline(row); } catch (_) {}
    if (io) io.emit('setup-expired', { setupId: row.id, setupType: row.setup_type, tradeDate: row.trade_date });
  }
  return expired.rows.length;
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
    SELECT id, setup_type, trade_date, stop_level,
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

    const updated = await query(`
      UPDATE active_setups
      SET status='EXPIRED', resolution='INVALIDATED', resolved_at=NOW(),
          updated_at=NOW(), invalidation_timing=$2
      WHERE id=$1 AND status='ACTIVE'
      RETURNING *
    `, [row.id, invalidationTiming]);

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
              const pmEnd   = new Date(Date.UTC(yr, mo - 1, 1)).toISOString().split('T')[0];
              const pmVpQ = await query(`
                WITH vp AS (
                  SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
                  FROM price_bars_primary WHERE symbol='NQ'
                    AND ts >= $1::date AND ts < $2::date
                    AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) >= 570
                    AND EXTRACT(hour FROM ts) < 16
                  GROUP BY ROUND(low/0.25)*0.25
                ), total AS (SELECT SUM(vol) as t FROM vp),
                poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
                SELECT p.poc_px::float as poc,
                  (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) cv FROM vp WHERE px>=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as vah,
                  (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) cv FROM vp WHERE px<=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as val
                FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
              `, [pmStart, pmEnd]);
              pmVaCache[monthKey] = {
                pmVAH: pmVpQ.rows[0]?.vah || null,
                pmVAL: pmVpQ.rows[0]?.val || null,
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

  // GET /api/auction-read/day-setups (moved here as it uses ACD data)
  router.get('/auction-read/day-setups', async (req, res) => {
    try {
      const { date } = req.query;
      if (!date) return res.status(400).json({ error: 'date required' });

      const barsR = await query(`
        SELECT ts, open::float, high::float, low::float, close::float, volume::bigint,
               SUM(close::float * volume::bigint) OVER (ORDER BY ts) /
               NULLIF(SUM(volume::bigint) OVER (ORDER BY ts), 0) as vwap_running
        FROM price_bars_primary
        WHERE symbol='NQ' AND ts::date=$1
          AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 960
        ORDER BY ts
      `, [date]);
      const bars = barsR.rows;
      if (!bars.length) return res.json([]);

      const priorR = await query(`
        SELECT MAX(ts::date::text) as prior_date FROM price_bars_primary
        WHERE symbol='NQ' AND ts::date < $1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
      `, [date]);
      const priorDate = priorR.rows[0]?.prior_date;

      let pdHigh = null, pdLow = null, pdVAH = null, pdVAL = null, onHigh = null, onLow = null;
      if (priorDate) {
        const pd = await query(`
          SELECT MAX(high)::float as h, MIN(low)::float as l FROM price_bars_primary
          WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        `, [priorDate]);
        pdHigh = pd.rows[0]?.h; pdLow = pd.rows[0]?.l;

        const vaR = await query(`
          SELECT poc::float as poc, vah::float as vah, val::float as val
          FROM developing_value_log
          WHERE trade_date = $1
        `, [priorDate]);
        if (vaR.rows[0]) {
          pdVAH = vaR.rows[0].vah;
          pdVAL = vaR.rows[0].val;
        } else {
          // fallback
          const fallbackQ = await query(`
            WITH vp AS (SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ROUND(low/0.25)*0.25),
            total AS (SELECT SUM(vol) as t FROM vp), poc_row AS (SELECT px FROM vp ORDER BY vol DESC LIMIT 1)
            SELECT p2.px::float as poc,
              (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) as cv FROM vp WHERE px >= p2.px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as vah,
              (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) as cv FROM vp WHERE px <= p2.px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as val
            FROM vp, poc_row p2 GROUP BY p2.px LIMIT 1
          `, [priorDate]);
          pdVAH = fallbackQ.rows[0]?.vah;
          pdVAL = fallbackQ.rows[0]?.val;
        }

        const onR = await query(`
          SELECT MAX(high)::float as h, MIN(low)::float as l FROM price_bars_primary
          WHERE symbol='NQ' AND ts::date=$1 AND (EXTRACT(hour FROM ts) >= 16 OR EXTRACT(hour FROM ts) < 9)
        `, [priorDate]);
        onHigh = onR.rows[0]?.h; onLow = onR.rows[0]?.l;
      }

      const acdR = await query(`SELECT or_high::float, or_low::float FROM acd_daily_log WHERE trade_date=$1`, [date]);
      const ibHigh = acdR.rows[0]?.or_high, ibLow = acdR.rows[0]?.or_low;

      const keyLevels = [
        { key: 'IBH',    price: ibHigh,  type: 'resistance', desc: 'Initial Balance High' },
        { key: 'IBL',    price: ibLow,   type: 'support',    desc: 'Initial Balance Low'  },
        { key: 'PD VAH', price: pdVAH,   type: 'resistance', desc: 'Prior Day Value Area High' },
        { key: 'PD VAL', price: pdVAL,   type: 'support',    desc: 'Prior Day Value Area Low'  },
        { key: 'PD High',price: pdHigh,  type: 'resistance', desc: 'Prior Day High' },
        { key: 'PD Low', price: pdLow,   type: 'support',    desc: 'Prior Day Low'  },
        { key: 'ON High',price: onHigh,  type: 'resistance', desc: 'Overnight High'  },
        { key: 'ON Low', price: onLow,   type: 'support',    desc: 'Overnight Low'   },
      ].filter(l => l.price);

      const TOUCH_RANGE = 8;
      const MEASURE_BARS = 30;
      const MIN_MOVE = 15;

      const profitable = [];

      for (const lvl of keyLevels) {
        const p = parseFloat(lvl.price);
        for (let i = 10; i < bars.length - MEASURE_BARS; i++) {
          const bar = bars[i];
          const touched = lvl.type === 'resistance'
            ? bar.high >= p - TOUCH_RANGE && bar.high <= p + TOUCH_RANGE
            : bar.low <= p + TOUCH_RANGE && bar.low >= p - TOUCH_RANGE;
          if (!touched) continue;

          const futBars = bars.slice(i + 1, i + MEASURE_BARS + 1);
          const futClose = futBars[futBars.length - 1]?.close;
          if (!futClose) break;

          const move = lvl.type === 'resistance'
            ? bar.high - Math.min(...futBars.map(b => b.low))
            : Math.max(...futBars.map(b => b.high)) - bar.low;

          if (move >= MIN_MOVE) {
            const time = new Date(bar.ts).toISOString().slice(11, 16);
            profitable.push({
              type: 'KEY_LEVEL',
              setup: lvl.key,
              desc: lvl.desc,
              level_type: lvl.type,
              price: p,
              time,
              move_pts: Math.round(move),
              direction: lvl.type === 'resistance' ? 'SHORT' : 'LONG',
            });
          }
          break;
        }
      }

      const acdEvents = await query(`
        SELECT setup_type, TO_CHAR(fired_time,'HH24:MI') as fired_time, fired_price::float
        FROM acd_setup_events WHERE trade_date=$1 ORDER BY fired_time
      `, [date]);

      for (const ev of acdEvents.rows) {
        const isLong  = ev.setup_type?.includes('A_UP') && !ev.setup_type?.includes('Failed');
        const isShort = ev.setup_type?.includes('A_DOWN') && !ev.setup_type?.includes('Failed') ||
                        ev.setup_type?.includes('Failed_A_Up');
        const isLong2 = ev.setup_type?.includes('Failed_A_Down');
        if (!isLong && !isShort && !isLong2) continue;

        const barIdx = bars.findIndex(b => new Date(b.ts).toISOString().slice(11, 16) === ev.fired_time);
        if (barIdx < 0 || barIdx >= bars.length - MEASURE_BARS) continue;

        const futBars = bars.slice(barIdx + 1, barIdx + MEASURE_BARS + 1);
        if (!futBars.length) continue;

        const entryPrice = parseFloat(ev.fired_price);
        let movePts;
        if (isLong || isLong2) {
          movePts = Math.max(...futBars.map(b => b.high)) - entryPrice;
        } else {
          movePts = entryPrice - Math.min(...futBars.map(b => b.low));
        }

        if (movePts >= MIN_MOVE) {
          profitable.push({
            type: 'ACD',
            setup: ev.setup_type.replace(/_/g, ' '),
            desc: '',
            level_type: (isLong || isLong2) ? 'support' : 'resistance',
            price: entryPrice,
            time: ev.fired_time,
            move_pts: Math.round(movePts),
            direction: (isLong || isLong2) ? 'LONG' : 'SHORT',
          });
        }
      }

      for (let i = 10; i < bars.length - MEASURE_BARS; i++) {
        const bar = bars[i];
        const vwap = bar.vwap_running;
        if (!vwap) continue;
        const prev = bars[i - 1];
        if (!prev?.vwap_running) continue;
        const crossUp   = prev.close < prev.vwap_running && bar.close > vwap;
        const crossDown = prev.close > prev.vwap_running && bar.close < vwap;
        if (!crossUp && !crossDown) continue;

        const futBars = bars.slice(i + 1, i + MEASURE_BARS + 1);
        const move = crossUp
          ? Math.max(...futBars.map(b => b.high)) - bar.close
          : bar.close - Math.min(...futBars.map(b => b.low));

        if (move >= MIN_MOVE) {
          const time = new Date(bar.ts).toISOString().slice(11, 16);
          profitable.push({
            type: 'VWAP',
            setup: crossUp ? 'VWAP Reclaim' : 'VWAP Break',
            desc: crossUp ? 'Price crossed above VWAP — buyers taking control' : 'Price crossed below VWAP — sellers taking control',
            level_type: crossUp ? 'support' : 'resistance',
            price: parseFloat(vwap.toFixed(2)),
            time,
            move_pts: Math.round(move),
            direction: crossUp ? 'LONG' : 'SHORT',
          });
          break;
        }
      }

      profitable.sort((a, b) => b.move_pts - a.move_pts);
      res.json(profitable);
    } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
  });

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
      const pmVaQ = await query(`
        WITH vp AS (
          SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
          FROM price_bars_primary WHERE symbol='NQ'
            AND date_trunc('month', ts) = date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
            AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
          GROUP BY ROUND(low/0.25)*0.25
        ), total AS (SELECT SUM(vol) as t FROM vp),
        poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
        SELECT p.poc_px::float as poc,
          (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) as cv FROM vp WHERE px >= p.poc_px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as vah,
          (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) as cv FROM vp WHERE px <= p.poc_px) x WHERE cv <= (SELECT t*0.35 FROM total))::float as val
        FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
      `);
      const pmVAH = pmVaQ.rows[0]?.vah || null;
      const pmVAL = pmVaQ.rows[0]?.val || null;
      const pmPOC = pmVaQ.rows[0]?.poc || null;

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
  const runSetupDetection = async (req, res) => {
    try {
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const nowET   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const etMin   = nowET.getHours() * 60 + nowET.getMinutes();
      const etHour  = nowET.getHours();

      // Resolve/expire existing setups on every poll regardless of window
      await resolveSetupsByPrice(io).catch(() => {});
      await expireStaleSetups(io).catch(() => {});
      await structurallyInvalidateSetups(io).catch(() => {});

      // 5–6 PM ET: hard close / reset gap — expire RTH setups, dark until Globex opens
      if (etMin >= 17 * 60 && etMin < 18 * 60) {
        await query(`
          UPDATE active_setups SET status='EXPIRED', resolution='SESSION_CLOSED',
            resolved_at=NOW(), updated_at=NOW()
          WHERE trade_date=$1 AND status='ACTIVE'
        `, [todayET]).catch(() => {});
        return res.json({ setup: null, sessionClosed: true });
      }

      // Globex window: 6 PM–8:30 AM ET — fire level fades against PD VAH/VAL/POC only
      const inGlobex = etHour >= 18 || etMin < 8 * 60 + 30;
      if (inGlobex) {
        const sessionDate = etHour >= 18 ? nextTradingDay(nowET) : todayET;
        const globexSetup = await detectGlobexSetup(sessionDate, io);
        return res.json({ setup: globexSetup, sessionClosed: false, globexMode: true });
      }

      const noNewEntries = false; // setups fire throughout RTH session

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
        // IB bars (9:30–10:00) with bid/ask volume — spec: 30-min OR period
        query(`
          SELECT high::float, low::float, close::float, open::float,
                 COALESCE(ask_volume,0)::int as ask_vol, COALESCE(bid_volume,0)::int as bid_vol, volume::int
          FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
            AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 599
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
                 high::float, low::float, close::float, open::float,
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
            const fallbackQ = await query(`
              WITH vp AS (SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ROUND(low/0.25)*0.25),
              total AS (SELECT SUM(vol) as t FROM vp), poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
              SELECT p.poc_px::float as poc,
                (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) cv FROM vp WHERE px>=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as vah,
                (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) cv FROM vp WHERE px<=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as val
              FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
            `, [priorDay]);
            if (fallbackQ.rows[0]) {
              pdVAH = fallbackQ.rows[0].vah;
              pdVAL = fallbackQ.rows[0].val;
              pdPOC = fallbackQ.rows[0].poc;
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
          const pmVaQ = await query(`
            WITH vp AS (
              SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
              FROM price_bars_primary
              WHERE symbol='NQ'
                AND date_trunc('month', ts) = date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
                AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
              GROUP BY ROUND(low/0.25)*0.25
            ),
            total AS (SELECT SUM(vol) as t FROM vp),
            poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
            SELECT p.poc_px::float as poc,
              (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) cv FROM vp WHERE px>=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as vah,
              (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) cv FROM vp WHERE px<=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as val
            FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
          `);
          if (pmVaQ.rows[0]) { pmVAH = pmVaQ.rows[0].vah; pmVAL = pmVaQ.rows[0].val; pmPOC = pmVaQ.rows[0].poc; }
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

          if (otdShortSignaled && currentPrice < orL) {
            otdSetup = {
              type: 'OPEN_TEST_DRIVE_SHORT', label: 'OPEN TEST DRIVE (SHORT)',
              direction: 'SHORT',
              entry: +currentPrice.toFixed(0),
              stop: +probeHigh.toFixed(0),
              target: t1Guard('SHORT', currentPrice, pdVAL, currentPrice - (orRange || 80) * 1.5),
              targetLabel: (pdVAL && pdVAL < currentPrice) ? 'Prior Day VAL' : 'OR Range Extension',
              keyLevel: +orL.toFixed(0), keyLevelLabel: 'OR Low (reversal confirmed)',
              description: `Open Test Drive short. Price probed up ${upProbe.toFixed(0)}pts to ${probeHigh.toFixed(0)} then reversed through OR Low (${orL?.toFixed(0)}).\n\nEDGE: OTD_SHORT has -5.6% directional edge at baseline and is GATED to PD-2 VA confluence only. At PD-2 VA: 73% WR (+23%, N=11). On TURBULENT days: 60% WR (+11%). NL30 aligned: 69% WR. EXECUTION: Short with stop above probe high (${probeHigh.toFixed(0)}). Target PD VAL or OR extension. Only fires when price is near PD-2 VA levels.`,
              history: await getHistory('TRANSITIONAL'),
            };
          } else if (otdLongSignaled && currentPrice > orH) {
            otdSetup = {
              type: 'OPEN_TEST_DRIVE_LONG', label: 'OPEN TEST DRIVE (LONG)',
              direction: 'LONG',
              entry: +currentPrice.toFixed(0),
              stop: +probeLow.toFixed(0),
              target: t1Guard('LONG', currentPrice, pdVAH, currentPrice + (orRange || 80) * 1.5),
              targetLabel: (pdVAH && pdVAH > currentPrice) ? 'Prior Day VAH' : 'Composite VAH',
              keyLevel: +orH.toFixed(0), keyLevelLabel: 'OR High (reversal confirmed)',
              description: `Open Test Drive long. Price probed down ${downProbe.toFixed(0)}pts to ${probeLow.toFixed(0)} in the opening, then reversed through OR High (${orH?.toFixed(0)}) — initiative buyers dominated. Stop below probe low (${probeLow.toFixed(0)}).`,
              history: await getHistory('TRANSITIONAL'),
            };
          }
        }
      }
      // OPEN_TEST_DRIVE suppressed 2026-07-05: LONG=31.8% WR N=44 EV=-$100 (KILL), SHORT=26.7% WR N=45 EV=-$74 (KILL).
      // Code gates (nearPD2VA) described in description but not enforced — base rate is catastrophic.
      // Shadow tracking continues; revisit if PD-2 VA gate shows N≥20 at ≥65% WR.
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
          description: `A Down + C Down both failed. Price is now above OR High (${orH?.toFixed(0)}) and A Down level (${aDownLevel?.toFixed(0)}). Trapped shorts fuel the reversal.\n\nEDGE: TRT_LONG has -4.3% edge at 10 bars but +24% edge at 20 bars (75% WR, N=28) — it's a slow-burn reversal. On TREND days: 100% WR (N small). EXECUTION: This trade needs TIME. Don't cut early. Expiry is 120 min. Target PD VAH or OR measured move. Stop below A Down level (${trtLongStop}).${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — higher conviction zone.' : ''}`,
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
        const ibHigh = Math.max(...ibBars.map(b => b.high));
        const ibLow  = Math.min(...ibBars.map(b => b.low));
        const ibMid  = (ibHigh + ibLow) / 2;
        const ibClose = ibBars[ibBars.length - 1].close;
        const totalAsk = ibBars.reduce((s, b) => s + b.ask_vol, 0);
        const totalBid = ibBars.reduce((s, b) => s + b.bid_vol, 0);
        const ibBullish = ibClose > ibMid && totalAsk > totalBid;
        const ibBearish = ibClose < ibMid && totalBid > totalAsk;
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
            const _ibLS = getCached(todayET, 'levelFadeStats');
            const ibTypeName = isBull ? 'IB_BULLISH' : 'IB_BEARISH';
            const ibOpt = _ibLS?._opt?.[ibTypeName];
            const ibStopPts = ibOpt?.stop ?? 50; // sweep-optimal 50pt for both BULLISH and BEARISH
            const stop = isBull ? +(currentPrice - ibStopPts).toFixed(0) : +(currentPrice + ibStopPts).toFixed(0);
            const target = isBull
              ? (pdVAH && pdVAH > currentPrice ? Math.round(pdVAH) : Math.round(ibHigh + (orRange || 0) * 0.5))
              : (pdVAL && pdVAL < currentPrice ? Math.round(pdVAL) : Math.round(ibLow - (orRange || 0) * 0.5));
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
              targetLabel: isBull ? `T1: PD VAH (half off) · Stop: ${ibStopPts}pt from entry (${stop})` : `T1: PD VAL (half off) · Stop: ${ibStopPts}pt from entry (${stop})`,
              keyLevel: +ibMid.toFixed(0),
              keyLevelLabel: 'IB Midpoint',
              description: conflicting
                ? (isBull
                  ? `IB closed bullish but A Up was tested and rejected before 10:00 — conflicting signals. Half conviction only: smaller size, wider stop tolerance.`
                  : `IB closed bearish but A Down was tested and rejected before 10:00 — conflicting signals. Half conviction only.\n\nEDGE: IB_BEARISH ${(() => { const r = _ibLS?._opt?.IB_BEARISH; return r ? `${(r.wr*100).toFixed(1)}% WR (N=${r.n})` : '~55% WR'; })()} overall. On TURBULENT: strongest. EXECUTION: Lean short on rallies to IB midpoint (${Math.round(ibMid)}). Stop ${ibStopPts}pt above entry (${stop}). Target PD VAL or IB extension.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — higher conviction.' : ''}`)
                : (isBull
                  ? `IB closed ${(ibClose - ibMid).toFixed(0)}pts above midpoint with ask volume dominating (${totalAsk.toLocaleString()} vs ${totalBid.toLocaleString()} bid). Buyers controlled the initial balance.\n\nEDGE: IB_BULLISH ${(() => { const r = _ibLS?._opt?.IB_BULLISH; return r ? `${(r.wr*100).toFixed(1)}% WR (N=${r.n})` : '~64% WR'; })()} overall. TREND days: strongest. BALANCE: suppressed (below breakeven). EXECUTION: Buy pullbacks to IB midpoint (${Math.round(ibMid)}). Stop ${ibStopPts}pt below entry (${stop}). Target PD VAH or IB extension.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — higher conviction.' : ''}`
                  : `IB closed ${(ibMid - ibClose).toFixed(0)}pts below midpoint with bid volume dominating (${totalBid.toLocaleString()} vs ${totalAsk.toLocaleString()} ask). Sellers controlled the initial balance.\n\nEDGE: IB_BEARISH ${(() => { const r = _ibLS?._opt?.IB_BEARISH; return r ? `${(r.wr*100).toFixed(1)}% WR (N=${r.n})` : '~55% WR'; })()} overall. TURBULENT: strongest. BALANCE: suppressed. EXECUTION: Short rallies to IB midpoint (${Math.round(ibMid)}). Stop ${ibStopPts}pt above entry (${stop}). Target PD VAL or IB extension.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — higher conviction.' : ''}`),
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
          openDrive = {
            type: isBull ? 'OPEN_DRIVE_LONG' : 'OPEN_DRIVE_SHORT',
            label: isBull ? 'OPEN DRIVE (LONG)' : 'OPEN DRIVE (SHORT)',
            direction: isBull ? 'LONG' : 'SHORT',
            entry: +currentPrice.toFixed(0),
            stop: isBull ? +(orL - (orH - orL)).toFixed(0) : +(orH + 2).toFixed(0),
            target: isBull
              ? t1Guard('LONG',  currentPrice, orH + (orRange || 0), currentPrice + Math.max(60, orRange || 60))
              : t1Guard('SHORT', currentPrice, orL - (orRange || 0), currentPrice - Math.max(60, orRange || 60)),
            targetLabel: isBull ? 'T1: OR Measured Move (half off) · Runner: 70pt' : 'T1: OR Measured Move (half off) · Runner: 65pt',
            keyLevel: +(isBull ? orH : orL).toFixed(0),
            keyLevelLabel: isBull ? 'OR High (support)' : 'OR Low (resistance)',
            description: isBull
              ? `Open Drive up confirmed. Pullback to near OR High (${orH?.toFixed(0)}) — first test of the breakout level.\n\nEDGE: OPEN_DRIVE_LONG has +15.9% directional edge (66.7% WR at 10 bars, N=42). On TREND days: 83% WR (N=6). NL30 aligned: 60% WR. EXECUTION: Buy the pullback to OR High. Stop below OR Low −1× OR Range (${+(orL - (orH - orL)).toFixed(0)}). Target OR measured move. Do NOT fade this drive before 1:30 PM.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — higher conviction.' : ''}`
              : `Open Drive down confirmed. Rally toward OR Low (${orL?.toFixed(0)}) — first test of the breakdown level.\n\nEDGE: OPEN_DRIVE_SHORT has +18.9% directional edge (68.2% WR at 10 bars, N=22). At VA level: 78% WR. NL30 aligned: 80% WR (N=10). EXECUTION: Short the rally to OR Low. Stop above OR High +2pt (${+(orH + 2).toFixed(0)}). Target OR measured move or PD VAL.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — highest conviction zone.' : ''}`,
            history: await getHistory('TRENDING_UP'),
          };
        }
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

        if (pwHighTested && !pwHighBroken && currentPrice && currentPrice < (orH || currentPrice + 50)) {
          failedAuction = {
            type: 'FAILED_AUCTION_SHORT', label: 'FAILED AUCTION — PRIOR WEEK HIGH',
            direction: 'SHORT',
            entry: +currentPrice.toFixed(0),
            stop: +(currentPrice + (orRange || 50) * 0.3).toFixed(0),
            target: t1Guard('SHORT', currentPrice, pdVAL, currentPrice - (orRange || 50) * 0.5),
            targetLabel: (pdVAL && pdVAL < currentPrice) ? 'Prior Day VAL' : 'OR Extension',
            keyLevel: null, keyLevelLabel: 'Prior Week High',
            description: `Prior week high was tested but price failed to close above it — supply waiting. Bulls pushed to last week's extreme, found sellers, retreated. Fade the failed breakout.`,
            history: await getHistory('BALANCE'),
          };
        } else if (pwLowTested && !pwLowBroken && currentPrice && currentPrice > (orL || currentPrice - 50)) {
          failedAuction = {
            type: 'FAILED_AUCTION_LONG', label: 'FAILED AUCTION — PRIOR WEEK LOW',
            direction: 'LONG',
            entry: +currentPrice.toFixed(0),
            stop: +(currentPrice - (orRange || 50) * 0.3).toFixed(0),
            target: t1Guard('LONG', currentPrice, pdVAH, currentPrice + (orRange || 50) * 0.5),
            targetLabel: (pdVAH && pdVAH > currentPrice) ? 'Prior Day VAH' : 'OR Extension',
            keyLevel: null, keyLevelLabel: 'Prior Week Low',
            description: `Prior week low tested but price failed to close below — buyers defended. Fade the failed breakdown toward prior day value area.`,
            history: await getHistory('BALANCE'),
          };
        } else if (gLineLost && gLineReclaimed && currentPrice) {
          failedAuction = {
            type: 'FAILED_AUCTION_LONG', label: 'FAILED AUCTION — G-LINE RECLAIM',
            direction: 'LONG',
            entry: +currentPrice.toFixed(0),
            stop: +(currentPrice - (orRange || 50) * 0.5).toFixed(0),
            target: t1Guard('LONG', currentPrice, pdVAH, currentPrice + (orRange || 50) * 0.5),
            targetLabel: (pdVAH && pdVAH > currentPrice) ? 'Prior Day VAH' : 'OR Extension',
            keyLevel: null, keyLevelLabel: 'G-Line (weekly open)',
            description: `G-Line lost then reclaimed — bears failed to hold below weekly open. ${highVolume ? 'High volume on reclaim confirms conviction.' : ''} Long lean toward prior VAH.`,
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
          bracketBreakout = {
            type: isBull ? 'BRACKET_BREAKOUT_LONG' : 'BRACKET_BREAKOUT_SHORT',
            label: isBull ? 'BRACKET BREAKOUT (LONG)' : 'BRACKET BREAKOUT (SHORT)',
            direction: isBull ? 'LONG' : 'SHORT',
            entry: +currentPrice.toFixed(0),
            stop: +(isBull ? (bracketTop - 5) : (bracketBot + 5)).toFixed(0),
            target: isBull
              ? t1Guard('LONG',  currentPrice, pdVAH + (pdVAH - pdVAL), pdVAH, currentPrice + (orRange || 80))
              : t1Guard('SHORT', currentPrice, pdVAL - (pdVAH - pdVAL), pdVAL, currentPrice - (orRange || 80)),
            targetLabel: 'Value Area Extension',
            keyLevel: +(isBull ? bracketTop : bracketBot).toFixed(0),
            keyLevelLabel: isBull ? 'Prior Bracket Top' : 'Prior Bracket Bottom',
            description: isBull
              ? `5-session bracket top (${bracketTop?.toFixed(0)}) exceeded with NL30 +${nl30}.\n\nEDGE: BRACKET_BREAKOUT_LONG has +4.4% directional edge (55.1% WR at 10 bars, N=49). At 2D VA: 73% WR (N=11). Best on BALANCE days: 57% WR. EXECUTION: Prior bracket top becomes support. Buy pullbacks to the bracket boundary. Stop 5pt inside bracket (${+(bracketTop - 5).toFixed(0)}). Target value area measured move.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — higher conviction.' : ''}`
              : `5-session bracket bottom (${bracketBot?.toFixed(0)}) broken with NL30 ${nl30}.\n\nEDGE: BRACKET_BREAKOUT_SHORT has +30.7% directional edge (80% WR at 10 bars, N=10 ⚠small). Strongest setup in the backtest by edge delta. EXECUTION: Prior bracket bottom becomes resistance. Short rallies to bracket boundary. Stop 5pt inside bracket (${+(bracketBot + 5).toFixed(0)}). Target value area extension.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — highest conviction.' : ''}`,
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
          valueAreaResp = {
            type: isFade ? 'VALUE_AREA_RESPONSIVE_SHORT' : 'VALUE_AREA_RESPONSIVE_LONG',
            label: isFade ? 'VALUE AREA RESPONSIVE (SHORT)' : 'VALUE AREA RESPONSIVE (LONG)',
            direction: isFade ? 'SHORT' : 'LONG',
            entry: +currentPrice.toFixed(0),
            stop: +(isFade ? (pdVAH + 18) : (pdVAL - 8)).toFixed(0),
            target: isFade
              ? t1Guard('SHORT', currentPrice, pdPOC, pdVAL, currentPrice - Math.max(60, (orRange || 80) * 0.5))
              : t1Guard('LONG',  currentPrice, pdPOC, pdVAH, currentPrice + Math.max(60, (orRange || 80) * 0.5)),
            targetLabel: isFade ? 'T1: PD POC (half off) · Runner: 95pt' : 'T1: PD POC (half off) · Runner: 100pt',
            keyLevel: +(isFade ? pdVAH : pdVAL).toFixed(0),
            keyLevelLabel: isFade ? 'Prior Day VAH' : 'Prior Day VAL',
            description: isFade
              ? `Price opened inside prior value and is testing VAH (${pdVAH?.toFixed(0)}) — responsive sellers defend this level.\n\nEDGE: VA_RESP_SHORT is the #1 profitable setup — +17.4% directional edge (66.7% WR at 10 bars, N=60). On TURBULENT days: 90% WR (N=10). On BALANCE: 65% WR. NL30 aligned: 93% WR (N=14). EXECUTION: Stop above VAH +18pt (${+(pdVAH + 18).toFixed(0)}) — recalibrated from +8 (MAE sweep optimal: 27pt from entry, +$26 EV). Target PD POC (${pdPOC?.toFixed(0)}) or PD VAL. The tight stop with large target is WHY this setup is profitable — one win covers 6-8 losses.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — highest conviction.' : ''}`
              : `Price opened inside prior value and is testing VAL (${pdVAL?.toFixed(0)}). NOTE: VA_RESP_LONG has -5.0% directional edge and is SUPPRESSED.`,
            history: await getHistory('BALANCE'),
          };
        }
      }

      // ── SETUP 9: C STANDALONE ─────────────────────────────────────────────────
      // No A signal today — first C break of OR is the setup
      let cStandalone = null;
      if (!aUpFired && !aDownFired && !hasCFiredToday && currentPrice && orH && orL) {
        if (currentPrice > orH) {
          // C_STANDALONE_UP suppressed 2026-07-05: 53.7% WR N=95 EV=-$60 (KILL).
          // Needs 67% WR to break even at current avg win/loss. No gate improves it enough.
          // cStandalone = null (skip creation);
        } else if (currentPrice < orL && nearPD2VA) {
          // C_STANDALONE_DOWN suppressed 2026-07-05: N=89 EV=-$39 despite nearPD2VA gate.
          // Gate showed N=16 81% WR early on — that was small-sample noise. Kill same as C_STANDALONE_UP.
          // cStandalone = null (skip creation)
          void 0;
          if (false) cStandalone = {
            type: 'C_STANDALONE_DOWN', label: 'C DOWN (STANDALONE)',
            direction: 'SHORT',
            entry: +currentPrice.toFixed(0),
            stop: +(orH + 4).toFixed(0),
            target: t1Guard('SHORT', currentPrice, pdVAL, currentPrice - (orRange || 80)),
            targetLabel: 'T1: PD VAL (half off) · Runner: 45pt',
            keyLevel: +orL.toFixed(0), keyLevelLabel: 'OR Low',
            description: `No A signal today. C Down — price closing below OR Low (${orL?.toFixed(0)}).\n\nEDGE: C_STANDALONE_DOWN has -12% directional edge at baseline (37.3% WR) and is GATED to PD-2 VA confluence only. At PD-2 VA: 81% WR (+32%, N=16). On TURBULENT days: 69% WR. This setup ONLY fires when price is within 25pt of PD-2 VAH (${pd2VAH ? Math.round(pd2VAH) : '—'}) or PD-2 VAL (${pd2VAL ? Math.round(pd2VAL) : '—'}). Without PD-2 confluence, the edge is negative — do not trade.`,
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

      // IB setup day-type precision gate — originally Opus Audit 2 2026-07-07, numbers below
      // re-verified 2026-07-14 and found stale/drifted (exactly the silent-drift pattern this
      // codebase has hit before — see docs/OPEN_THREADS.md for the incident). IB_BULLISH's
      // TREND bucket had gone from +$16 EV (N=32, 2026-07-07) to -$16 EV (N=34) by 2026-07-14 —
      // no bucket clears the bar anymore, so IB_BULLISH is now fully SUPPRESSed by
      // backtest_setup_status.mjs's DAY_TYPE_CONDITIONAL check (see that script), independent
      // of the per-day-type nulling below. Current (2026-07-14) real numbers:
      // IB_BULLISH: BALANCE N=53 EV=-$47 | TREND N=34 EV=-$16 | TURBULENT N=19 EV=+$4 (thin)
      // IB_BEARISH: BALANCE N=53 EV=-$15 | TREND N=18 EV=-$64 | TURBULENT N=30 EV=+$78 (strong)
      if (dtClass === 'BALANCE' && ibSetup) ibSetup = null;
      if (dtClass === 'TURBULENT' && ibSetup?.type === 'IB_BULLISH') ibSetup = null;
      if (dtClass === 'TREND' && ibSetup?.type === 'IB_BEARISH') ibSetup = null;

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
              absorptionSetup = {
                type: 'ABSORPTION_LONG',
                direction: 'LONG',
                entry: +currentPrice.toFixed(0),
                stop: +(currentPrice - stopDist).toFixed(0),
                target: +(currentPrice + targetDist).toFixed(0),
                targetLabel: '40pt Runner (calibrated)',
                description: `Bullish absorption detected: ${lowCluster} 2-min bars clustering at support (${Math.round(wL)}), RSI rising +${rsiDrift.toFixed(0)} while price flat in ${Math.round(wRange)}pt range.\n\nEDGE: Bullish absorption has 71.4% WR at 5 bars (N=35, +18.4% vs baseline). On BALANCE days: 73.9% WR at 20 bars (+20.9%, N=23). Near 2D VA: 90.9% WR (N=11).\n\nEXECUTION: Price held at support with buyers absorbing selling pressure. RSI confirms hidden bullish momentum. Enter long, stop below support zone (${Math.round(currentPrice - stopDist)}), target ${pdVAH ? 'PD VAH (' + Math.round(pdVAH) + ')' : '2R'}.${atLevel ? '\n\n✅ AT 2D VA LEVEL — highest conviction (90.9% WR).' : ''}${nearPD2VA ? '\n✅ PD-2 VA CONFLUENCE' : ''}`,
                history: { winRate: 0.714, occurrences: 35, avgPnl: null, t1HitRate: 0.714 },
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

          coilSurgeSetup = {
            type: isLong ? 'COIL_SURGE_LONG' : 'COIL_SURGE_SHORT',
            direction: isLong ? 'LONG' : 'SHORT',
            entry: +currentPrice.toFixed(0),
            stop: +(isLong ? currentPrice - stopDist : currentPrice + stopDist).toFixed(0),
            target: +vwap.toFixed(0),
            targetLabel: 'RTH VWAP',
            description: `Coil detected (${(cHi - cLo).toFixed(0)}pt range, volume ${((Number(cbars[ci].vol)||0)/cBv*100).toFixed(0)}% of baseline) with volume surge (${(lastVol/cBv).toFixed(1)}x baseline). Price is ${Math.abs(dist).toFixed(0)}pt ${dist > 0 ? 'above' : 'below'} VWAP.\n\nEDGE: Coil→surge→VWAP fade has 65.3% WR on TREND days (N=49, +16.1% vs baseline). NL30 aligned: 60% WR. R:R avg 3.08. Expectancy +$24/trade.\n\nEXECUTION: Fade toward VWAP (${Math.round(vwap)}). Stop at coil range extreme (${isLong ? Math.round(cLo - 5) : Math.round(cHi + 5)}). Hold 10 bars max — edge decays after that. Only fires on TREND days or NL30-aligned.${nearPD2VA ? '\n\n✅ PD-2 VA CONFLUENCE' : ''}`,
            history: { winRate: 0.653, occurrences: 49, avgPnl: null, t1HitRate: 0.653 },
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
                rsiDivSetup = {
                  type: 'RSI_DIV_BULLISH',
                  direction: 'LONG',
                  entry: currentPrice,
                  stop: currentPrice - stopDist,
                  target: t1Guard('LONG', currentPrice, currentPrice + stopDist * 2),
                  targetLabel: '2R Target',
                  description: `15min RSI BULLISH divergence CONFIRMED. Price made lower low (${Math.round(curr.price)} vs ${Math.round(prev.price)}) but RSI made higher low (${curr.rsi.toFixed(0)} vs ${prev.rsi.toFixed(0)}, Δ+${rsiDelta}). Confirmation bar closed higher — selling exhaustion confirmed. WR with confirmation: 90.0% (N=20). Scalp long — hold 3 bars (45min) max. Take profit at value area midpoint or 2R.`,
                  history: { winRate: 0.900, occurrences: 20, avgPnl: null, t1HitRate: 0.900 },
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
                rsiDivSetup = {
                  type: 'RSI_DIV_BEARISH',
                  direction: 'SHORT',
                  entry: currentPrice,
                  stop: currentPrice + stopDist,
                  target: t1Guard('SHORT', currentPrice, currentPrice - stopDist * 2),
                  targetLabel: '2R Target',
                  description: `15min RSI BEARISH divergence CONFIRMED. Price made higher high (${Math.round(curr.price)} vs ${Math.round(prev.price)}) but RSI made lower high (${curr.rsi.toFixed(0)} vs ${prev.rsi.toFixed(0)}, Δ-${rsiDelta}). Confirmation bar closed lower — buying exhaustion confirmed. WR with confirmation: 86.1% (N=36). On BALANCE days: 84.6%. Scalp short — hold 2-3 bars (30-45min) max. Take profit at value area midpoint or 2R.`,
                  history: { winRate: 0.861, occurrences: 36, avgPnl: null, t1HitRate: 0.861 },
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
        query(`SELECT resolution FROM active_setups WHERE trade_date=$1 AND status='RESOLVED' ORDER BY fired_at DESC LIMIT 3`, [todayET]).catch(() => ({ rows: [] })),
        query(
          `SELECT CASE WHEN setup_type LIKE '%_LONG' THEN 'LONG' WHEN setup_type LIKE '%_SHORT' THEN 'SHORT' END AS direction,
                  COUNT(*) as cnt
           FROM active_setups WHERE trade_date=$1 AND status IN ('ACTIVE','RESOLVED')
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
        query(`
          SELECT
            REGEXP_REPLACE(setup_type, '_(LONG|SHORT)$', '') AS level_base,
            MAX(trade_date)::text AS last_date
          FROM active_setups
          WHERE trade_date >= $1::date - INTERVAL '21 days' AND trade_date < $1
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
        { let pv = 0, tv = 0;
          for (const b of allRthBarsRow.rows) { const v = (b.ask_vol || 0) + (b.bid_vol || 0) || 1; pv += (b.high + b.low + b.close) / 3 * v; tv += v; }
          earlyVwap = tv > 0 ? pv / tv : null;
        }

        // ── VWAP Magnet: σ-based trigger — fires when price ≥1.5σ from RTH VWAP ──
        // σ = rolling 30-session std of (session_close - RTH_VWAP) from session_analysis.
        // Consistent with trade-alerts dailyVwapSigma (same source, same threshold).
        // T1 = 20pt (half off), runner = min(vwapDist*0.5, 100pt). Stop = 30pt.
        if (earlyVwap) {
          const vwapStdData = await getTrailingVwapStd(todayET, 30);
          const vwapThreshold = vwapStdData.threshold;
          const vwapDist = currentPrice - earlyVwap;
          const vwapSigma = vwapStdData.std > 0 ? vwapDist / vwapStdData.std : 0;
          if (Math.abs(vwapDist) >= vwapThreshold) {
            const isLong = vwapDist < 0;
            const t2Dist = Math.min(Math.round(Math.abs(vwapDist) * 0.5), 100);
            vwapMagnetSetup = {
              type: isLong ? 'VWAP_MAGNET_LONG' : 'VWAP_MAGNET_SHORT',
              direction: isLong ? 'LONG' : 'SHORT',
              entry: currentPrice,
              stop: isLong ? currentPrice - 30 : currentPrice + 30,
              target: isLong ? currentPrice + 20 : currentPrice - 20,
              targetLabel: `T1: 20pt (half off) · Runner: ${t2Dist}pt toward VWAP`,
              description: `Price ${Math.round(Math.abs(vwapDist))}pt (${vwapSigma > 0 ? '+' : ''}${vwapSigma.toFixed(1)}σ) from VWAP (${Math.round(earlyVwap)}). Threshold: ${vwapThreshold}pt (1.5σ = ${Math.round(vwapStdData.std)}pt std). Scale out: half at 20pt, runner to ${t2Dist}pt (50% of dist, max 100pt). Breakeven stop after T1.`,
              history: { winRate: 0.62, occurrences: 460, avgPnl: 24, t1HitRate: 0.62 },
            };
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
          const [or5Q, pdIbQ, pdOrQ, ib10Q, ibTodayQ, lpQ, poc2Q] = await Promise.all([
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
            // All static levels from level_prices — single batch query, cached daily.
            // Replaces individual PW_HIGH/PW_LOW, PM_VAH, etc. queries.
            // OR_HIGH/OR_LOW/IB_HIGH/IB_LOW/IB_MID/OR_MID stay as real-time bar values
            // because compute_levels.js may not have run yet during the live session.
            cachedLP ? Promise.resolve(null) : query(
              `SELECT level_name, price::float FROM level_prices WHERE trade_date=$1`,
              [todayET]
            ).catch(() => ({ rows: [] })),
            // 2-day composite POC (POC of combined last-2-session RTH volume profile)
            cached2DPOC !== undefined ? Promise.resolve(null) : query(`
              WITH last2 AS (
                SELECT DISTINCT ts::date as d FROM price_bars_primary
                WHERE symbol='NQ' AND ts::date < $1
                  AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
                ORDER BY d DESC LIMIT 2
              ),
              vp AS (
                SELECT ROUND(low::numeric/0.25)*0.25 as px, SUM(volume::numeric) as vol
                FROM price_bars_primary
                WHERE symbol='NQ' AND ts::date IN (SELECT d FROM last2)
                  AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
                GROUP BY ROUND(low::numeric/0.25)*0.25
              )
              SELECT px::float as poc FROM vp ORDER BY vol DESC LIMIT 1
            `, [todayET]).catch(() => ({ rows: [] })),
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
          // Cached 60s — backtests run at most weekly so freshness is fine.
          // Falls back to hardcoded defaults if DB is unavailable or level is missing.
          const cachedLevelStats = getCached(todayET, 'levelFadeStats');
          let liveStats = cachedLevelStats;
          if (!liveStats) {
            // DOW as integer (0=Sun, 1=Mon...5=Fri, 6=Sat) for SETUP_STATUS_DOW lookup
            const todayDowInt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();
            const [statsQ, monQ, optStopQ, dtaQ, setupStatusQ, dowStatusQ] = await Promise.all([
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
              // Keyed by full setup_type (e.g. 'OR_HIGH_FADE_SHORT'). Updated weekly.
              query(`
                SELECT DISTINCT ON (signal_name) signal_name,
                  p75_mae::float AS opt_stop, p50_mfe::float AS opt_target
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
              query(`
                SELECT DISTINCT ON (signal_name) signal_name, recommendation
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
            ]);
            liveStats = { _mon: {} };
            for (const r of statsQ.rows) {
              const isLong = r.signal_name.endsWith('_LONG');
              const base = r.signal_name.replace(/_(?:LONG|SHORT)$/, '');
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
              };
            }
            // Setup-level suppression set — keyed by setup_type (directional)
            // SUPPRESS: N≥20, EV<-$5 — auto-suppress structural losers
            // THIN_N: N<20 — CLAUDE.md rule: insufficient data, must shadow until N≥20
            // Both cause new setups to insert as SHADOW rather than ACTIVE
            liveStats._suppressedSetups = new Set();
            for (const r of setupStatusQ.rows) {
              if (r.recommendation === 'SUPPRESS' || r.recommendation === 'THIN_N') liveStats._suppressedSetups.add(r.signal_name);
            }
            // DOW-specific suppression for today — setups negative on this DOW but fine all-time
            // signal_name format: '{SETUP_TYPE}_DOW_{DOW_INT}' — strip the suffix to get setup_type
            liveStats._dowSuppressToday = new Set();
            for (const r of dowStatusQ.rows) {
              if (r.recommendation === 'SUPPRESS') {
                const setupType = r.signal_name.replace(/_DOW_\d+$/, '');
                liveStats._dowSuppressToday.add(setupType);
              }
            }
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
            { name: 'OR_HIGH_FADE',   level: orH,         ...(ls('OR_HIGH')    || {}), ...monOverride('OR_HIGH') },
            { name: 'OR_LOW_FADE',    level: orL,         ...(ls('OR_LOW')     || {}) },
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
            // Prior-week value area
            { name: 'PW_VAH_FADE',       level: lp.PW_VAH       ?? null, ...(ls('PW_VAH')       || {}) },
            { name: 'PW_VAL_FADE',       level: lp.PW_VAL       ?? null, ...(ls('PW_VAL')       || {}) },
            { name: 'PW_POC_FADE',       level: lp.PW_POC       ?? null, ...(ls('PW_POC')       || {}) },
            // Prior-month value area (VAH, VAL, POC) + range
            { name: 'PM_VAH_FADE',       level: lp.PM_VAH       ?? null, ...(ls('PM_VAH')       || {}) },
            { name: 'PM_VAL_FADE',       level: lp.PM_VAL       ?? null, ...(ls('PM_VAL')       || {}) },
            // PM_POC omitted — WR=44.4%, stop=93pt, EV=-$54.9 (negative EV at any stop)
            { name: 'PM_HIGH_FADE',      level: lp.PM_HIGH      ?? null, ...(ls('PM_HIGH')      || {}) },
            { name: 'PM_LOW_FADE',       level: lp.PM_LOW       ?? null, ...(ls('PM_LOW')       || {}) },
            // Quarterly value area
            // 3M_VAH omitted — WR=7.1% (structural bull market makes this a breakout level, not fade)
            { name: '3M_VAL_FADE',       level: lp['3M_VAL']    ?? null, ...(ls('3M_VAL')       || {}) },
            { name: '3M_POC_FADE',       level: lp['3M_POC']    ?? null, ...(ls('3M_POC')       || {}) },
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
            // only works post-IB. Fixed 2026-07-16 per live user report. NOTE: the existing
            // SETUP_STATUS calibration for OR_MID_AFTER_IB_FADE (N=121/97, EV=-$5.90/-$5.12,
            // SUPPRESS) was computed entirely from >=10:30 touches (230/235 active_setups rows
            // are BACKFILL-sourced, fired_at >= 10:30) — it says nothing about touches in the
            // newly-eligible 9:35-10:29 window. Don't treat this setup as validated for that
            // window until a dedicated recalibration backtest re-runs against the wider
            // first-touch-anywhere population, same lesson as the CAM_R4/CAM_S3 window-mismatch
            // fix (docs/OPEN_THREADS.md).
            { name: 'IB_MID_SCALP_FADE',    level: etMinNow >= 630 ? ibMid : null,  mae_p75: 50, mfe: 15, mfe_p75: 30, ...(ls('IB_MID_SCALP') || {}) },
            { name: 'OR_MID_AFTER_IB_FADE', level: orMid, mae_p75: 35, mfe: 20, mfe_p75: 40, ...(ls('OR_MID_AFTER_IB') || {}) },
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
            return rawType;
          };

          // Collect ALL levels within 15pt — wider than the old 10pt window to catch
          // approaches that reverse before piercing deeply. Pick the highest-EV level
          // as the primary setup; annotate description with confluence when 2+ stack.
          const nearLevels = keepLevels.filter(lv => Math.abs(currentPrice - lv.level) <= 15);

          // Cascade breaker: skip new fade setup detection when trend regime detected.
          if (cascadeBreaker.active && nearLevels.length > 0) {
            for (const lv of nearLevels) {
              await query(`
                INSERT INTO active_setups (trade_date, setup_type, fired_at, price_at_detection, status, suppression_reason)
                VALUES ($1,$2,NOW(),$3,'SHADOW','CASCADE_BREAKER')
                ON CONFLICT (trade_date, setup_type, COALESCE(status, '')) WHERE status IN ('ACTIVE','SHADOW') DO NOTHING
              `, [todayET, lv.name, currentPrice]).catch(() => {});
            }
          }
          if (!cascadeBreaker.active && nearLevels.length > 0) {
            const primary = nearLevels.reduce((best, lv) =>
              (lv.ev ?? -999) > (best.ev ?? -999) ? lv : best, nearLevels[0]);
            const lv = primary;
            const isLong = approachDir === 'FROM_ABOVE';
            const dir = isLong ? 'LONG' : 'SHORT';
            const type = resolveSetupType(`${lv.name}_${dir}`, lv);
            if (!liveStats._suppressedSetups?.has(type) && !liveStats._dowSuppressToday?.has(type) && !isS2DoubleCounter(dir) && !isTrendCounterFade(dir)) {
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
            const dtaRow = dtaKey ? (liveStats._dta?.[dtaKey] ?? null) : null;

            // Specific confluence pair bonus: verified N≥20 pairs (2026-07-05 Gemini Task 4)
            // OR_MID+DAILY_OPEN 84%, OR_LOW+IB_LOW 80%, OR_HIGH+IB_HIGH 78%, IB_LOW+OR_LOW 77%
            const _nearNames = new Set(nearLevels.filter(l => l.name !== lv.name).map(l => l.name));
            const _PAIR_BONUS_MAP = { 'OR_MID': ['DAILY_OPEN'], 'OR_LOW': ['IB_LOW'], 'OR_HIGH': ['IB_HIGH'], 'IB_LOW': ['OR_LOW'], 'IB_HIGH': ['OR_HIGH'] };
            const confluencePairPartner = (_PAIR_BONUS_MAP[levelBase] ?? []).find(p => _nearNames.has(p)) ?? null;

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
                return `${recencyPrefix}${lv.name.replace(/_/g, ' ')} at ${Math.round(lv.level)}. ${Math.round((lv.wr ?? 0.5) * 100)}% WR (N=${lv.n ?? 0} combined${dirStr}). MAE P50: ${lv.mae ?? '--'}pt${lv.mfe != null ? `, MFE P50: ${lv.mfe}pt` : ''}.${stopNote}${confluenceNote}${eliteNote}${dtNote}${isMonday ? ' MONDAY: post-IB only (waits for IB close 10:30 ET).' : ' AM first touch.'}`;
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
            };
            } // end suppression check
            else {
              // Suppressed near-level audit: write SHADOW row so user can verify suppression decisions
              const suppressReason = liveStats._suppressedSetups?.has(type) ? 'SUPPRESSED_FADE'
                : liveStats._dowSuppressToday?.has(type) ? 'DOW_SUPPRESSED'
                : isS2DoubleCounter(dir) ? 'S2_DOUBLE_COUNTER'
                : isTrendCounterFade(dir) ? 'TREND_COUNTER_FADE' : 'SUPPRESSED_OTHER';
              await query(`
                INSERT INTO active_setups (trade_date, setup_type, fired_at, price_at_detection, status, suppression_reason)
                VALUES ($1,$2,NOW(),$3,'SHADOW',$4)
                ON CONFLICT (trade_date, setup_type, COALESCE(status, '')) WHERE status IN ('ACTIVE','SHADOW') DO NOTHING
              `, [todayET, type, currentPrice, suppressReason]).catch(() => {});
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
              stopSweepSetup = {
                type: 'STOP_SWEEP_LONG',
                direction: 'LONG',
                entry: currentPrice,
                stop: Math.round(recentLow - 5),
                target: Math.round(currentPrice + 30),
                targetLabel: `${level.name} sweep bounce`,
                description: `Price swept below ${level.name} (${Math.round(level.price)}) by ${Math.round(extension)}pt, now reversing. Confluence: ${confNames.join(', ')}. Stop below sweep low (${Math.round(recentLow)}).`,
                history: { winRate: 0.55, occurrences: 198, avgPnl: null, t1HitRate: 0.55 },
              };
            }
          } else {
            const brokeAbove = recentBars.some(b => b.high > level.price + 3);
            const nowBelow = currentPrice < level.price;
            const recentHigh = Math.max(...recentBars.map(b => b.high));
            const extension = recentHigh - level.price;
            const drop = recentHigh - currentPrice;
            if (brokeAbove && nowBelow && extension > 3 && extension < 50 && drop > 15) {
              stopSweepSetup = {
                type: 'STOP_SWEEP_SHORT',
                direction: 'SHORT',
                entry: currentPrice,
                stop: Math.round(recentHigh + 5),
                target: Math.round(currentPrice - 30),
                targetLabel: `${level.name} sweep fade`,
                description: `Price swept above ${level.name} (${Math.round(level.price)}) by ${Math.round(extension)}pt, now reversing. Confluence: ${confNames.join(', ')}. Stop above sweep high (${Math.round(recentHigh)}).`,
                history: { winRate: 0.55, occurrences: 198, avgPnl: null, t1HitRate: 0.55 },
              };
            }
          }
        }
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
        if (setup.type === 'C_STANDALONE_UP' && priorFailedDir === 'LONG') return null;
        if (setup.type === 'C_STANDALONE_DOWN' && priorFailedDir === 'SHORT') return null;
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
        if (isCounter) return null;
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

              zoneEdgeFade = {
                type: 'ZONE_EDGE_FADE',
                direction: isLong ? 'LONG' : 'SHORT',
                entry, stop, target,
                targetLabel: `${targetDist}pt fade (5%×ATR)`,
                description: `Price at balance ${edgeLabel}. ATR-scaled fade: ${stopDist}pt stop, ${targetDist}pt target. Backtested 45% WR, +$736/yr. High vol days: 55% WR. Zone edges fade back 84% of the time.`,
                history: { winRate: 0.45, occurrences: 199, avgPnl: null, t1HitRate: 0.45 },
              };
            }
          }
        }
      }

      // Re-read from cache — liveStats is block-scoped inside the level-fade block above.
      // The block writes it to cache via setCached before closing; this recovers it for the
      // candidates array, the INSERT loop, and any other outer-scope usage.
      const liveStats = getCached(todayET, 'levelFadeStats');

      // ACTIVE candidates — ONLY the 9 KEEP level fades from system backtest.
      // These fire banners, show as actionable setups, and count as trade entries.
      const candidates = [
        levelScalpSetup, // PD_POC / PD_VAL / PD_VAH / FLOOR_PIVOT / FLOOR_R1 / OR_HIGH / PD_IB_MID / PD_OR_MID / 5D_OR_MID fades
        // IB_BULLISH is now fully SUPPRESSed (2026-07-14, backtest_setup_status.mjs) — every
        // day-type bucket is below breakeven, see docs/OPEN_THREADS.md for the incident. Checked
        // via _suppressedSetups the same way level-fade setup_types are, alongside the existing
        // DOW-specific check. IB_BEARISH remains DAY_TYPE_MANAGED (TURBULENT bucket is genuinely
        // strong) — see the day-type nulling above this candidates array for its per-type gate.
        // DOW suppression via pipeline: Thu×IB_BEARISH EV=-$17 N=27 suppressed as of 2026-07-09.
        (ibSetup
          && !getCached(todayET, 'levelFadeStats')?._suppressedSetups?.has(ibSetup.type)
          && !getCached(todayET, 'levelFadeStats')?._dowSuppressToday?.has(ibSetup.type)
        ) ? ibSetup : null,
      ];
      // SHADOW candidates — tracked for forward-testing but NO banners, NO trade alerts.
      // These persist to active_setups with status='SHADOW', resolve against price,
      // and build WR data. Promoted to ACTIVE when positive EV over 30+ forward trades.
      const shadowCandidates = [
        stopSweepSetup,
        vwapMagnetSetup,
        absorptionSetup,
        coilSurgeSetup,
        zoneEdgeFade,
        trt?.type === 'TRT_LONG' ? trt : null,
        trt?.type === 'TRT_SHORT' ? trt : null,
        trtMah,
        aDownWeak,
        // ibSetup moved to candidates 2026-07-01 — BALANCE suppressed, TREND/TURBULENT promoted
        openDrive,
        valueAreaResp,
        // C_STANDALONE: suppressed in HIGH-VOL-CHOP (0% WR), death sequences (9-14% WR), and POC counter direction (41.5% WR)
        morningRegime !== 'HIGH-VOL-CHOP' ? suppressIfPOCCounter(suppressIfDeathSequence(cStandalone)) : null,
        cPairedLong, cPairedShort,
        failedAuction, bracketBreakout,
      ].filter(Boolean);
      // Priority selection: candidates array is ordered by priority.
      // Take the first valid candidate, but check for directional conflicts
      // against already-active setups and apply post-loss size reduction.
      const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      let active = null;
      for (const cand of candidates) {
        if (!cand) continue;
        const isLongCand = cand.direction === 'LONG';
        const riskOk = cand.stop == null || (isLongCand ? cand.stop < cand.entry : cand.stop > cand.entry);
        if (!riskOk) {
          console.error(`[setup-detection] REJECTED ${cand.type} — non-positive risk: stop ${cand.stop} vs entry ${cand.entry} (${cand.direction})`);
          continue;
        }
        active = cand;
        break;
      }

      if (active) {
        // Directional conflict check: suppress if opposite-direction setup is already active today
        const activeToday = await query(`
          SELECT setup_type, fired_at::text as fired_at FROM active_setups
          WHERE trade_date=$1 AND status='ACTIVE'
        `, [todayET]).catch(() => ({ rows: [] }));
        const oppositeActive = activeToday.rows.find(s => inferDirection(s.setup_type) !== active.direction);
        if (oppositeActive) {
          console.log(`[setup-detection] CONFLICT: ${active.type} (${active.direction}) vs active ${oppositeActive.setup_type} (${inferDirection(oppositeActive.setup_type)}). Standing aside.`);
          active = null;
        }

        // Build full trade brief: WHY NOW + PACE + SIZE
        if (active) {
          const lossesToday = await query(`
            SELECT COUNT(*)::int as count FROM active_setups
            WHERE trade_date=$1 AND (resolution='STOP_HIT' OR (status='RESOLVED' AND actual_pnl < 0))
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

          // Setup profiles with backtested stats (1yr, 6 surviving setups)
          const PROFILES = {
            'VALUE_AREA_RESPONSIVE_SHORT': {
              style: 'sniper',
              stats: 'WR: 18% | Avg Win: $457 | Avg Loss: $55 | R:R 5.7:1',
              stop: 'Stop: ~19pt (tight). Cut IMMEDIATELY if price accepts above VAH — no second chances.',
              target: 'Target: 2D POC or VAL (avg winner +107pt). Do NOT take profit at +20pt — avg winner is 5x your stop.',
              pace: 'Quick rejection expected at 2D VAH. Price should stall and reverse within 3-5 bars. If it keeps making new highs after your entry, the fade is failing.',
              hold: 'RUNNER profile. You will lose most of these (~82%) but winners are massive ($457 avg). The math works because R:R is 5.7:1. Let winners run to POC/VAL — that is where the edge lives.',
              bestWR: 'TURB 90%, NL30 aligned 93%, after NONTREND 75%',
              conviction: 'Almost always fires counter to overnight (fading VAH when price is above value). That is the point — you are fading. Trust the R:R, not the WR.',
            },
            'IB_BEARISH': {
              style: 'grinder',
              stats: 'WR: 47% | Avg Win: $202 | Avg Loss: $233 | R:R 0.87:1',
              stop: 'Stop: ~133pt (wide). This is structural, not a scalp. The wide stop is necessary — IB breaks retest.',
              target: 'Target: 1x IB extension below (avg winner +88pt). Take partial at IB Mid if offered.',
              pace: 'Steady selling over 30-60 min. NOT a crash. Expect pullbacks to IB Low — hold through them. If price reclaims IB Low and holds above for 10+ bars, the break is failing.',
              hold: 'GRINDER. Be patient. This trade needs time to work. When below value with trapped longs (88% WR, N=32), it grinds in your favor all session.',
              bestWR: 'Below value 88% (N=32), TURB 81%, aligned 77% (N=13)',
              conviction: 'HIGHEST conviction when aligned (77% WR). When counter: 25% WR — seriously consider skipping unless you see strong volume confirmation.',
            },
            'OPEN_DRIVE_SHORT': {
              style: 'scalp',
              stats: 'WR: 53% | Avg Win: $112 | Avg Loss: $120 | R:R 0.93:1',
              stop: 'Stop: ~51pt. Wider than it looks — the opening drive creates a range you are fading.',
              target: 'Target: OR Low (avg winner +55pt). Take it when offered — this is not a runner.',
              pace: 'FAST. You know within 15 bars if this works. If no selling follow-through by 10:00 AM, exit. Do not hold past IB close.',
              hold: 'Morning trade only. If it is working by 10:00, hold to target. If price is churning sideways, the drive is absorbing and you should cut.',
              bestWR: 'WED 86%, TURB 88%, aligned 71% (N=7)',
              conviction: 'When aligned: 71% WR — hold with confidence. On Wednesday + TURBULENT, this is one of your best setups.',
            },
            'OPEN_DRIVE_LONG': {
              style: 'scalp',
              stats: 'WR: 54% | Avg Win: $134 | Avg Loss: $152 | R:R 0.88:1',
              stop: 'Stop: ~59pt. Entry is on pullback to OR High — stop below OR Low.',
              target: 'Target: OR measured move up (avg winner +62pt). Similar to drive short — take profits, do not overstay.',
              pace: 'FAST. Entry on first touch of OR High after pullback. If it bounces, ride. If it slices through OR High, cut immediately.',
              hold: 'Know within 15 bars. Monday is actually strong for this setup (+19% vs other days). TREND days = 83% WR.',
              bestWR: 'TREND 83%, tight OR 78%, Monday +19%',
              conviction: 'Overnight alignment does not significantly change WR here. Use day type — TREND is key.',
            },
            'TRT_LONG': {
              style: 'grinder',
              stats: 'WR: 56% | Avg Win: $111 | Avg Loss: ~$0 (expired) | R:R high',
              stop: 'Stop: ~117pt (very wide). This is a reversal — trapped shorts are unwinding. You need room for the rotation.',
              target: 'Target: opposite side of OR (avg winner +55pt at $2/pt). Do not take profit early — the edge is at 20 bars, NOT 10.',
              pace: 'SLOW. This takes 1-2 hours to play out. A+C failed and price pushes through OR — the reversal grinds, it does not spike. Be patient.',
              hold: 'DO NOT CUT EARLY. 120 min expiry. If you exit at +10pt, you leave 75% of the edge on the table. The whole point of this setup is that it takes time to resolve.',
              bestWR: 'BALANCE 83%, TUE 83%',
              conviction: 'Small sample on overnight alignment. Rely on day type — BALANCE days are your sweet spot. Suppressed on wide OR.',
            },
            'C_STANDALONE_DOWN': {
              style: 'sniper',
              stats: 'WR: 63% | Avg Win: $264 | Avg Loss: ~$0 (expired) | R:R high',
              stop: 'Stop: ~90pt. Only fires near PD-2 VA (gated). Death sequence gate also active — no cascading after a loss.',
              target: 'Target: 1x OR extension below OR Low (avg winner +93pt). Let it run — trapped longs create a selling cascade.',
              pace: 'Fast initial move after C signal confirms. Once price breaks below OR Low near PD-2 VA, trapped longs accelerate the sell-off. Reassess at 1x OR extension.',
              hold: 'If the PD-2 VA gate is met, this is high conviction (63% WR). Let it run. Do not take quick profit — the cascade is the edge.',
              bestWR: 'TURB 72%, NONTREND prior 75% (N=8)',
              conviction: 'When counter: 25% WR — consider skipping. When PD-2 VA gate is met + NONTREND prior day: 75% WR. That is your highest conviction C trade.',
            },
            'ZONE_EDGE_FADE': {
              style: 'scalp',
              stats: 'WR: 45% | Avg Win: ~16pt | Avg Loss: ~10pt | R:R 1.6:1 | +$736/yr backtested',
              stop: 'Stop: 5%×ATR (ATR-scaled, typically 10-25pt). Tight — this is a scalp, not a runner.',
              target: 'Target: 5%×ATR (same as stop). Take profit immediately when hit — zone fades are quick rotations.',
              pace: 'FAST. Price hits the zone edge and either bounces within 5-10 bars or breaks through. If no fade in 10 bars, the edge is failing — cut or let it expire.',
              hold: 'Do NOT hold for runners. This is a balance zone rotation trade — target the other side of the zone or the first structural level inside. Zone edges fade 84% of the time but the fade is small.',
              bestWR: 'HIGH VOL 55%, TOP edge 49%, TREND days 54%',
              conviction: 'Best on HIGH VOL days (55% WR). Zone edges that have held for 3+ days have stronger fade conviction. If price breaks through and stays outside for 15+ bars, the fade has failed — breakout is real.',
            },
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
          for (const bt of backfilledTouches) {
            try {
              const existing = await query(
                `SELECT 1 FROM active_setups WHERE trade_date=$1 AND setup_type=$2 LIMIT 1`,
                [todayET, bt.type]
              );
              if (existing.rows.length) continue; // already recorded (ACTIVE or SHADOW) this day
              const h = Math.floor(bt.etMin / 60), m = bt.etMin % 60;
              const firedAtBackfill = `${todayET} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
              await query(`
                INSERT INTO active_setups (trade_date, setup_type, fired_at, expires_at,
                  entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label,
                  price_at_detection, historical_win_rate, historical_sessions, historical_avg_pnl, historical_t1_hit_rate,
                  status, resolution_method)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'SHADOW','EARLY_TOUCH_BACKFILL')
                ON CONFLICT (trade_date, setup_type, COALESCE(status, '')) WHERE status IN ('ACTIVE','SHADOW') DO NOTHING
              `, [
                todayET, bt.type, firedAtBackfill, sessionEndStr,
                bt.entry, bt.entry, bt.stop, bt.target, bt.targetLabel,
                bt.entry, bt.history.winRate, bt.history.occurrences, bt.history.avgPnl, bt.history.t1HitRate,
              ]);
            } catch (e) { console.error(`[backfill-touch] ${bt.type} failed:`, e.message); }
          }
        })();
      }

      if (!active) return res.json({ setup: null, noNewEntries: !!noNewEntries, cascadeBreaker });

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
        OR_HIGH_FADE_LONG: 30, OR_HIGH_FADE_SHORT: 30,
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
      // Hard cap: 1:00 PM ET (session end). Use local (ET) time formatting so PostgreSQL
      // interprets the stored TIMESTAMP WITHOUT TZ correctly in its session timezone.
      const fmtETStr = (d) => {
        const y = d.getFullYear(), mo = String(d.getMonth()+1).padStart(2,'0'),
              day = String(d.getDate()).padStart(2,'0'),
              h = String(d.getHours()).padStart(2,'0'), m = String(d.getMinutes()).padStart(2,'0');
        return `${y}-${mo}-${day} ${h}:${m}:00`;
      };
      const sessionEndET = new Date(etNow); sessionEndET.setHours(13, 0, 0, 0);
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
      // unique index is (trade_date, setup_type, COALESCE(status,'')), so a fresh
      // ACTIVE/SHADOW row for the same setup_type/day does not conflict with an
      // already-closed EXPIRED/RESOLVED one.
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
        const ins = await query(`
          INSERT INTO active_setups (
            trade_date, setup_type, fired_at, expires_at, status,
            entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label,
            price_at_detection,
            historical_win_rate, historical_sessions, historical_avg_pnl, historical_t1_hit_rate,
            nl30_at_detection, structural_state_at_detection,
            size_multiplier, suppression_reason
          ) VALUES ($1,$2,$3,$4,$18,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$19)
          ON CONFLICT (trade_date, setup_type, COALESCE(status, '')) WHERE status IN ('ACTIVE','SHADOW') DO NOTHING RETURNING id, entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label
        `, [
          todayET, active.type, firedAtTs, computeExpiry(active.type),
          active.entry, active.entry, active.stop, safeT1Level, safeT1Label,
          active.entry,
          hist.winRate ?? null, hist.occurrences ?? null, hist.avgPnl ?? null, hist.t1HitRate ?? null,
          nl30, nl30State === 'BULLISH' ? 'TRENDING_UP' : nl30State === 'BEARISH' ? 'TRENDING_DOWN' : 'BALANCE',
          active.sizeMultiplier ?? 1.0,
          getCached(todayET, 'levelFadeStats')?._suppressedSetups?.has(active.type) ? 'SHADOW' : 'ACTIVE',
          getCached(todayET, 'levelFadeStats')?._suppressedSetups?.has(active.type) ? 'PERFORMANCE_BELOW_THRESHOLD' : null,
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
      }

      // Keep size_multiplier current — it changes with intraday conditions (streak, stacking, etc.)
      if (setupId && active.sizeMultiplier != null) {
        query('UPDATE active_setups SET size_multiplier=$1 WHERE id=$2',
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
          for (const shadow of shadowCandidates) {
            if (!shadow || shadow.type === active?.type) continue;
            const isLongS = shadow.direction === 'LONG';
            const riskOk = shadow.stop == null || (isLongS ? shadow.stop < shadow.entry : shadow.stop > shadow.entry);
            if (!riskOk) continue;
            let sT1 = shadow.target;
            if (sT1 != null && ((isLongS && sT1 <= shadow.entry) || (!isLongS && sT1 >= shadow.entry))) sT1 = null;
            await query(`
              INSERT INTO active_setups (trade_date, setup_type, fired_at, expires_at,
                entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label,
                status)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'SHADOW')
              ON CONFLICT (trade_date, setup_type, COALESCE(status, '')) WHERE status IN ('ACTIVE','SHADOW') DO NOTHING
            `, [
              todayET, shadow.type, firedAtTs, computeExpiry(shadow.type),
              shadow.entry, shadow.entry, shadow.stop, sT1, shadow.targetLabel || null,
            ]).catch(() => {});
          }
        })();
      }

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
      });
    } catch(e) { console.error('setup-detection error:', e); res.status(500).json({ error: e.message }); }
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

  // Setup types currently in shadowCandidates — tracked but not live-traded.
  // Used by /api/setups/history to let the user filter "shadow type" rows even
  // when those historical rows pre-date the demotion and still have status='RESOLVED'.
  const SHADOW_SETUP_TYPES = new Set([
    'TRT_LONG','TRT_SHORT','TRT_LONG_V2','TRT_SHORT_V2','TRT_MAH_SHORT','TRT_MAH_LONG',
    'STOP_SWEEP_LONG','STOP_SWEEP_SHORT',
    'VWAP_MAGNET_LONG','VWAP_MAGNET_SHORT',
    'ZONE_EDGE_FADE',
    'A_DOWN_WEAK','A_UP_WEAK','A_UP_STRONG','A_DOWN_STRONG',
    'OPEN_DRIVE_LONG','OPEN_DRIVE_SHORT',
    'OPEN_TEST_DRIVE_LONG','OPEN_TEST_DRIVE_SHORT',
    'VALUE_AREA_RESPONSIVE_LONG','VALUE_AREA_RESPONSIVE_SHORT',
    'C_STANDALONE_UP','C_STANDALONE_DOWN',
    'C_PAIRED_LONG','C_PAIRED_SHORT',
    'FAILED_AUCTION_LONG','FAILED_AUCTION_SHORT',
    'BRACKET_BREAKOUT_LONG','BRACKET_BREAKOUT_SHORT',
    'GAP_FILL_LONG','GAP_FILL_SHORT',
  ]);

  // ── GET /api/setups/history ───────────────────────────────────────────────
  router.get('/setups/history', async (req, res) => {
    try {
      const { from, to, type, resolution, shadow = 'hide', limit = 2000, offset = 0 } = req.query;
      const shadowTypes = [...SHADOW_SETUP_TYPES];
      // $1 = shadowTypes only when actually used (not for shadow=show)
      const params = shadow === 'show' ? [] : [shadowTypes];
      const shadowRef = shadow === 'show' ? null : `$1`;
      let conditions;
      if (shadow === 'only') {
        conditions = [`setup_type = ANY(${shadowRef})`];
      } else if (shadow === 'show') {
        conditions = ["status != 'SHADOW'"];
      } else {
        conditions = ["status != 'SHADOW'", `setup_type != ALL(${shadowRef})`];
      }
      if (from) { params.push(from); conditions.push(`trade_date >= $${params.length}`); }
      if (to)   { params.push(to);   conditions.push(`trade_date <= $${params.length}`); }
      if (type) { params.push(type); conditions.push(`setup_type = $${params.length}`); }
      if (resolution) { params.push(resolution); conditions.push(`resolution = $${params.length}`); }
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
          s.mae_points, s.mfe_points, s.resolution_method, s.bars_to_resolution,
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
        ${where.replace(/\b(trade_date|setup_type|status|resolution)\b/g, 's.$1')}
        ORDER BY s.trade_date DESC, s.fired_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `, params);
      const shadowSet = new Set(shadowTypes);
      const rows = r.rows.map(row => ({ ...row, is_shadow_type: shadowSet.has(row.setup_type) }));
      res.json({ setups: rows, count: rows.length, total });
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

  // ── Monte Carlo API ─────────────────────────────────────────────────
  router.post('/acd/monte-carlo/run', async (req, res) => {
    try {
      const { runMonteCarlo } = await import('../services/monteCarloService.js');
      const result = await runMonteCarlo(req.body || {});
      if (result.error) return res.status(400).json(result);
      const saved = await query(`INSERT INTO monte_carlo_runs (name, config, results, summary) VALUES ($1, $2, $3, $4) RETURNING id`,
        [req.body.name || `Run ${new Date().toISOString().slice(0,16)}`, JSON.stringify(result.config), JSON.stringify({ equityDistribution: result.equityDistribution, drawdownDistribution: result.drawdownDistribution, sampleCurves: result.sampleCurves }), JSON.stringify(result.summary)]);
      res.json({ id: saved.rows[0].id, summary: result.summary });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/acd/monte-carlo/optimize', async (req, res) => {
    try {
      const { runOptimizer } = await import('../services/monteCarloService.js');
      const result = await runOptimizer(req.body || {});
      res.json(result);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/acd/monte-carlo/runs', async (req, res) => {
    try {
      const r = await query(`SELECT id, name, run_date, summary, notes FROM monte_carlo_runs ORDER BY run_date DESC LIMIT 20`);
      res.json({ runs: r.rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/acd/monte-carlo/runs/:id', async (req, res) => {
    try {
      const r = await query(`SELECT * FROM monte_carlo_runs WHERE id=$1`, [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'not found' });
      res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

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

  // Regime-Adaptive Level Performance
  router.get('/level-regime-performance', async (req, res) => {
    try {
      const { vol, dir, range } = req.query;
      let where = 'WHERE sample_size >= 5';
      const params = [];
      if (vol) { params.push(vol); where += ` AND vol_regime = $${params.length}`; }
      if (dir) { params.push(dir); where += ` AND dir_regime = $${params.length}`; }
      if (range) { params.push(range); where += ` AND range_regime = $${params.length}`; }
      const results = await query(`
        SELECT level_name as level, vol_regime, dir_regime, range_regime,
               sample_size, win_rate::float, ev_per_trade::float,
               avg_mfe::float, avg_mae::float, vs_overall
        FROM level_regime_performance ${where}
        ORDER BY ev_per_trade DESC NULLS LAST
      `, params);
      res.json({ levels: results.rows });
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
        pairsBaseQ, pairsSubQ, pairsWinQ,
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
              OR_HIGH: orH10, IB_HIGH: ibH10, IB_LOW: ibL10,
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
        'OR_HIGH':      { price: orH,      bestCtx: 'AM session strong', freq: '~0.7/day' },
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
        'OR_MID_AFTER_IB': { price: orMid, bestCtx: 'Post-IB OR midpoint', freq: '~1/day' },
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
        'OR_MID_AFTER_IB_LONG':  { price: orMid, bestCtx: 'Scalp fade LONG post-IB OR midpoint', freq: '~1/day' },
        'OR_MID_AFTER_IB_SHORT': { price: orMid, bestCtx: 'Scalp fade SHORT post-IB OR midpoint', freq: '~1/day' },
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
      // Per-setup overrides for scalps and runner targets (T2 = P75 MFE)
      const overrides = {
        'IB_MID_SCALP':    { stop: 50, t1: 15, t2: 30, freq: '3/day' },
        'OR_MID_AFTER_IB': { stop: 35, t1: 20, t2: 40, freq: '5/day' },
        'PD_POC':          { t2: 65 },
        '5D_OR_MID':       { t2: 80 },
        'PD_VAL':          { t2: 60 },
        'PD_VAH':          { t2: 60 },
        'PD_IB_MID':       { t2: 38 },
        'FLOOR_PIVOT':     { t2: 65 },
        'OR_HIGH':         { t2: 55 },
        'FLOOR_R1':        { t2: 65 },
        'PD_OR_MID':       { t2: 65 },
        'IB_HIGH':         { t2: 55 },
        'IB_LOW':          { t2: 55 },
        'TRT_LONG':        { stop: 143, t1: 60, t2: 120 },
      };

      // Priority order for dedup: LEVEL_FADE / PD_LEVEL / SCALP / ROLLING > LEVEL_FADE_AUDIT / MIDPOINT_FADE_AUDIT > SYSTEM_BACKTEST
      // UNIFIED_BACKTEST: shown only for the specific signal_names that replace CONTEXT/SCALP legacy orphan types.
      const displayPrimary = new Set(['LEVEL_FADE', 'PD_LEVEL', 'SCALP', 'ROLLING']);
      const hasPrimary = (name) => auditQ.rows.some(r => r.signal_name === name && displayPrimary.has(r.signal_type));
      const hasSystemBacktest = (name) => auditQ.rows.some(r => r.signal_name === name && r.signal_type === 'SYSTEM_BACKTEST');

      // UNIFIED_BACKTEST rows shown in the table (replaces CONTEXT/SCALP/SETUP legacy orphan types).
      // Recommendation is null for most UNIFIED_BACKTEST rows — status is derived from EV/WR below.
      const UNIFIED_DISPLAY = new Set([
        'IB_BULLISH', 'IB_BEARISH',                                        // replaces CONTEXT type
        'IB_MID_SCALP_LONG', 'IB_MID_SCALP_SHORT',                        // replaces SCALP type
        'OR_MID_AFTER_IB_LONG', 'OR_MID_AFTER_IB_SHORT',                  // replaces SCALP type
        // TRT_LONG: WR=33% EV=-$77 N=69 in UNIFIED_BACKTEST — dead setup, not shown
      ]);

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
        if (row.signal_type === 'UNIFIED_BACKTEST' && !UNIFIED_DISPLAY.has(row.signal_name)) continue;
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
            (row.signal_type === 'UNIFIED_BACKTEST' && (row.signal_name.includes('_SCALP_') || row.signal_name.startsWith('OR_MID_AFTER_IB')))) {
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

        const ov = overrides[row.signal_name] || {};
        setups.push({
          name: row.signal_name.replace(/_/g, ' '),
          rawName: row.signal_name,
          type,
          signalType: row.signal_type,
          wr: winRate,
          ev: row.ev_per_trade,
          totalPnl: status === 'ACTIVE' ? row.total_pnl : null,
          n: row.sample_size,
          stop: ov.stop || row.current_stop || (row.p75_mae ? Math.round(row.p75_mae) : null),
          t1: ov.t1 || row.current_target || (row.p50_mfe ? Math.round(row.p50_mfe) : null),
          t2: ov.t2 || (row.p75_mfe ? Math.round(row.p75_mfe) : null),
          runner: ov.t2 ? true : !!(row.p75_mfe && row.p50_mfe && row.p75_mfe > row.p50_mfe * 1.2),
          mae: row.avg_mae,
          mfe: row.avg_mfe,
          p50mae: row.p50_mae,
          p75mae: row.p75_mae,
          p90mae: row.p90_mae,
          p50mfe: row.p50_mfe,
          bestContext: describeLevel(row, meta.bestCtx) || row.notes || '',
          regimeFit,
          frequency: ov.freq || meta.freq || null,
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
