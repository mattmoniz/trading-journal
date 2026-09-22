// Live detector for OVERNIGHT_ORDERFLOW_LONG/SHORT (2026-09-21) -- see
// docs/OPEN_THREADS.md's same-day entry and RESEARCH_CLAIM
// overnight_9pm_orderflow_predicts_rth_direction_20260921 for the full research thread.
//
// Thesis: on a real trading day the ALREADY-LIVE Globex rotation badge would flag
// high-rotation by 12am ET (>=6 confirmed 65pt legs, server/services/rotationDetector.js --
// reads the badge's own live stage2 threshold, never hardcoded here), the cumulative 6pm-9pm
// ET order-flow direction (ask_volume vs bid_volume split) predicts the sign of the FOLLOWING
// RTH session's actual move. N=53 real days, hit rate 66-68%, day-blocked bootstrap CI
// excludes zero, chronologically stable, held up on a genuine chronological holdout split.
//
// CAUSALITY: entry is priced at 12am, NOT 9pm -- "is today a >=6-leg day by 12am" is only
// knowable AT 12am. The direction signal itself (6pm-9pm order flow) is historical/already-
// known by then, so using it to decide a 12am entry has no lookahead. A version that fired
// AT 9pm using this same gate would be using information from the future relative to its own
// decision point -- directly tested and confirmed much weaker/inconclusive (N=25, CI crosses
// zero) when restricted to what's actually knowable at 9pm. See
// scripts/calibrate_overnight_orderflow_entry.mjs's header for the full account.
//
// Stop distance and exit clock-time are read from that calibration script's LATEST
// performance_audit row (signal_type='OVERNIGHT_9PM_ENTRY_CALIB'), never hardcoded here --
// self-recalibrates daily as real trading days accumulate. A "no stop" calibration result
// is deliberately capped to a wide but FINITE real stop (STOP_FALLBACK_PTS) for genuine tail-
// risk protection -- backtested EV barely changes between "none" and a 700pt stop (94%+ of
// the edge retained), and a truly unstoppable live position is not something any backtest can
// fully price the tail risk of.
//
// Real N=0 as of this build -- ALWAYS fires SHADOW regardless of what a future SETUP_STATUS
// row would say, matching every other brand-new detector's own standing convention.
//
// STATELESS BY DESIGN (restart-safe), matching ibLowPnrDetector.js/pocRotationJoinDetector.js:
// every poll recomputes the entry fresh from real bar history; fired_at is the entry bar's OWN
// timestamp (not NOW()), so a re-poll harmlessly no-ops against active_setups' unique
// (trade_date, setup_type, fired_at) index. _cache.firedToday is a POLL-SKIP OPTIMIZATION ONLY.
import { query } from '../db.js';
import { detectRotationLegs } from './rotationDetector.js';
import { minutesSinceOvernightOpen } from './globexRotationBadge.js';
import { getGlobalCalib } from './acdShared.js';
import { getCanonicalLiveStatus } from './setupEligibility.js';
import {
  dropToTimeline, computeFireTags, FIRE_TAG_COLS, fireTagValues,
} from '../routes/acd.js';
import { getBetClass } from '../config/setupTypes.js';

const SETUP_TYPE_LONG = 'OVERNIGHT_ORDERFLOW_LONG';
const SETUP_TYPE_SHORT = 'OVERNIGHT_ORDERFLOW_SHORT';
const ENTRY_WINDOW_START_MIN = 360; // 12:00am ET (minutes since 6pm Globex open)
const ENTRY_WINDOW_END_MIN = 420; // 1:00am ET -- an hour of poller-restart grace, never drifts toward the weaker 2am/5am checkpoints
const STAGE2_LEGS_FALLBACK = 6; // only used if the badge's own live calibration is unavailable
const STOP_FALLBACK_PTS = 700; // used if calibration's chosen cell is "no stop" or unavailable
const EXIT_TIME_FALLBACK = '16:00'; // RTH close, used if calibration is unavailable
const T1_PLACEHOLDER_DIST = 1500; // informational-only, unreachable -- never checked, see resolveSetups.js's custom branch

let _cache = { tradeDate: null, firedToday: false };

async function getBadgeStage2Threshold() {
  return getGlobalCalib('globexRotationBadgeCalib', async () => {
    const r = await query(`
      SELECT notes FROM performance_audit
      WHERE signal_type='GLOBEX_ROTATION_BADGE_CALIB' AND signal_name='ALL_SESSIONS'
      ORDER BY run_date DESC LIMIT 1
    `);
    try { return r.rows[0] ? JSON.parse(r.rows[0].notes) : null; } catch (_) { return null; }
  }).then((calib) => calib?.stage2?.thresholdLegs ?? STAGE2_LEGS_FALLBACK);
}

async function getEntryCalibration() {
  const r = await query(`
    SELECT notes FROM performance_audit
    WHERE signal_type='OVERNIGHT_9PM_ENTRY_CALIB' AND signal_name='ALL_SESSIONS'
    ORDER BY run_date DESC LIMIT 1
  `);
  try {
    const notes = r.rows[0] ? JSON.parse(r.rows[0].notes) : null;
    const chosen = notes?.chosenCell;
    return {
      stopPts: chosen?.stopPts != null ? chosen.stopPts : STOP_FALLBACK_PTS,
      exitTime: chosen?.exitTime ?? EXIT_TIME_FALLBACK,
    };
  } catch (_) {
    return { stopPts: STOP_FALLBACK_PTS, exitTime: EXIT_TIME_FALLBACK };
  }
}

export async function detectOvernightOrderflowEntry() {
  try {
    const nowRow = await query(`SELECT (NOW() AT TIME ZONE 'America/New_York')::text as now_et, CURRENT_DATE::text as today`);
    const nowEtStr = nowRow.rows[0].now_et;
    const tradeDate = nowRow.rows[0].today; // valid directly -- we only ever fire after real midnight, matching the upcoming RTH session's own calendar date
    const nowEt = new Date(nowEtStr.replace(' ', 'T') + 'Z');
    const overnightMin = minutesSinceOvernightOpen(nowEt);

    if (_cache.tradeDate !== tradeDate) _cache = { tradeDate, firedToday: false };
    if (_cache.firedToday) return;
    if (overnightMin < ENTRY_WINDOW_START_MIN || overnightMin > ENTRY_WINDOW_END_MIN) return;

    // Real DB-level fire-once check (source of truth, matching the OPENING_DRIVE_15MIN fix) --
    // the in-memory _cache flag above is a poll-skip optimization only, reset by any server
    // restart. Without this, a restart mid-window could insert a second (same-direction, since
    // direction is deterministic from fixed historical data -- never an opposite one) row at a
    // later fired_at, which the unique (trade_date, setup_type, fired_at) index alone wouldn't
    // catch since the timestamp would differ.
    const already = await query(
      `SELECT 1 FROM active_setups WHERE trade_date=$1 AND setup_type IN ($2,$3) LIMIT 1`,
      [tradeDate, SETUP_TYPE_LONG, SETUP_TYPE_SHORT]
    );
    if (already.rows.length) { _cache.firedToday = true; return; }

    const barsRes = await query(`
      SELECT ts::text as ts, close::float,
        COALESCE(bid_volume,0)::float as bid_volume, COALESCE(ask_volume,0)::float as ask_volume
      FROM price_bars_primary WHERE symbol='NQ'
        AND ((ts::date = $1::date - 1 AND EXTRACT(hour FROM ts) >= 18)
          OR (ts::date = $1::date AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) < 570))
      ORDER BY ts ASC
    `, [tradeDate]);
    if (barsRes.rows.length < 10) return; // not enough overnight bars yet

    const bars = barsRes.rows.map((b) => {
      const d = new Date(b.ts.replace(' ', 'T') + 'Z');
      return { ts: b.ts, close: b.close, high: b.close, low: b.close, bid_volume: b.bid_volume, ask_volume: b.ask_volume, min: minutesSinceOvernightOpen(d) };
    });

    const bars12am = bars.filter((b) => b.min <= 360);
    const stage2Threshold = await getBadgeStage2Threshold();
    if (detectRotationLegs(bars12am).length < stage2Threshold) return; // today doesn't qualify

    const bars9pm = bars.filter((b) => b.min <= 180);
    if (bars9pm.length < 5) return;
    let ask = 0, bid = 0;
    for (const b of bars9pm) { ask += b.ask_volume; bid += b.bid_volume; }
    const share9pm = (ask + bid) > 0 ? ask / (ask + bid) : 0.5;
    const direction = share9pm > 0.5 ? 'LONG' : 'SHORT';
    const setupType = direction === 'LONG' ? SETUP_TYPE_LONG : SETUP_TYPE_SHORT;

    const entryBar = bars[bars.length - 1]; // latest available bar -- the real, executable current price
    const entryPx = entryBar.close;
    const { stopPts, exitTime } = await getEntryCalibration();
    const stopPx = direction === 'LONG' ? entryPx - stopPts : entryPx + stopPts;
    const t1Placeholder = direction === 'LONG' ? entryPx + T1_PLACEHOLDER_DIST : entryPx - T1_PLACEHOLDER_DIST;

    const [exitHH, exitMM] = exitTime.split(':').map(Number);
    const expiresAt = `${tradeDate} ${String(exitHH).padStart(2, '0')}:${String(exitMM).padStart(2, '0')}:00`;

    // Real N=0 -- ALWAYS SHADOW, matching every other brand-new detector's standing rule.
    const liveStatus = await getCanonicalLiveStatus(setupType);
    const status = 'SHADOW';
    const reason = liveStatus.reason || 'NEW_SIGNAL_UNDER_LIVE_EVALUATION';

    const fireTags = await computeFireTags(tradeDate, 'GLOBEX', overnightMin);
    const ins = await query(`
      INSERT INTO active_setups (
        trade_date, setup_type, fired_at, expires_at, status, origin_status,
        entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label,
        price_at_detection, suppression_reason, ${FIRE_TAG_COLS.join(', ')}, bet_class
      ) VALUES ($1,$2,$3,$4,$5,$5,$6,$6,$7,$8,$9,$6,$10,
        ${FIRE_TAG_COLS.map((_, i) => `$${11 + i}`).join(', ')},
        $${11 + FIRE_TAG_COLS.length})
      ON CONFLICT DO NOTHING
      RETURNING id
    `, [tradeDate, setupType, entryBar.ts, expiresAt, status, entryPx, stopPx, t1Placeholder,
        `HOLD_TO_${exitTime}_MTM (no fixed target -- see overnightOrderflowEntryDetector.js header)`,
        reason, ...fireTagValues(fireTags), getBetClass(setupType)]);

    if (ins.rows[0]) {
      _cache.firedToday = true;
      try {
        await dropToTimeline({
          id: ins.rows[0].id, trade_date: tradeDate, setup_type: setupType, fired_at: entryBar.ts,
          entry_zone_low: entryPx, stop_level: stopPx, t1_level: t1Placeholder, t1_label: reason,
          resolution: null, historical_win_rate: null, historical_sessions: null, expires_at: expiresAt,
        });
      } catch (_) {}
    }
  } catch (err) {
    console.error('[overnightOrderflowEntryDetector] error:', err.message);
  }
}
