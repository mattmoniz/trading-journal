// Live detector for MOMENTUM_60m_60m_TREND — the sole survivor of the 2026-07-14 minute-bar
// scanner + conditioning + real-stop/target-simulation pipeline (see docs/OPEN_THREADS.md and
// scripts/backtest_momentum60_daytype.mjs). The other 3 candidates from that investigation
// (unconditioned MOMENTUM_60m/60m, VOLZ_30m/60m, and the BALANCE-day fade variant) all turned
// negative-EV once given a real stop/target instead of the original scan's raw time-exit —
// only this one survives and is wired live.
//
// Modeled on phaseChangeDetector.js's shape (rolling bar-window condition evaluator + market-
// hours guard + fire-once state), NOT on the level-touch candidates array in acd.js — this is
// a structurally different kind of signal (a statistical extreme over a rolling bar window,
// not a price touching a fixed level), so it needed its own poller rather than shoehorning
// into the level-fade engine.
//
// No lookahead: rolling 20-trading-day extreme threshold recomputed daily from data available
// as of that day (never today's own data beyond the current bar). day_type is only trusted at
// or after IB close (10:30 ET) — acd_daily_log reclassifies at that point, so this detector
// also gates itself to >=10:30 ET, matching the original conditioning audit's own restriction.
//
// Stop/target are NEVER hardcoded here — read live from the OPTIMAL_STOP row in
// performance_audit (per CLAUDE.md's New Setup Type checklist), cached for the trading day.
import { query } from '../db.js';
import { dropToTimeline } from '../routes/acd.js';

const SETUP_FAMILY = 'MOMENTUM_60m_60m_TREND';
const LOOKBACK_MIN = 60;
const HORIZON_MIN = 60;
const THRESHOLD_WINDOW_DAYS = 20;
const EXTREME_PCTL = 0.20;
const EVAL_START_ET_MIN = 630; // 10:30 ET — day_type not trustworthy before this
const EVAL_END_ET_MIN = 900;   // 3:00 PM ET — leaves runway for the trade to play out before close

let _cache = { date: null, threshold: null, optimalStop: null, wasExtreme: false, firedToday: false };

async function getRollingThreshold(tradeDateStr) {
  // Trailing 20 trading days of MOMENTUM_60m readings (excludes today, per the no-lookahead
  // design already validated in scratch/claude_minute_bar_scanner.mjs).
  const { rows } = await query(`
    WITH days AS (
      SELECT DISTINCT (ts AT TIME ZONE 'America/New_York')::date AS td
      FROM price_bars_primary
      WHERE symbol='NQ' AND (ts AT TIME ZONE 'America/New_York')::date < $1
      ORDER BY td DESC LIMIT $2
    ),
    bars AS (
      SELECT (ts AT TIME ZONE 'America/New_York')::date AS td, ts,
        (EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York')*60+EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York'))::int as et_min,
        close::float
      FROM price_bars_primary
      WHERE symbol='NQ' AND (ts AT TIME ZONE 'America/New_York')::date IN (SELECT td FROM days)
        AND (EXTRACT(hour FROM ts AT TIME ZONE 'America/New_York')*60+EXTRACT(minute FROM ts AT TIME ZONE 'America/New_York')) BETWEEN 570 AND 959
      ORDER BY ts
    )
    SELECT et_min, close FROM bars ORDER BY ts
  `, [tradeDateStr, THRESHOLD_WINDOW_DAYS]);

  const closes = rows.map(r => r.close);
  const momentum = [];
  for (let i = LOOKBACK_MIN; i < closes.length; i++) momentum.push(closes[i] - closes[i - LOOKBACK_MIN]);
  if (momentum.length < 100) return null;
  momentum.sort((a, b) => a - b);
  return {
    lo: momentum[Math.floor(momentum.length * EXTREME_PCTL)],
    hi: momentum[Math.floor(momentum.length * (1 - EXTREME_PCTL))],
  };
}

async function getOptimalStop() {
  const { rows } = await query(`
    SELECT optimal_stop::float as stop, optimal_target::float as target
    FROM performance_audit
    WHERE signal_type='OPTIMAL_STOP' AND signal_name=$1
    ORDER BY run_date DESC LIMIT 1
  `, [SETUP_FAMILY]);
  return rows[0] || null;
}

// Live status must be computed dynamically, not hardcoded — matches the level-fade engine's
// own `getCached(...)._suppressedSetups` pattern. Without this, the setup would sit in SHADOW
// forever even after clearing N>=20 live trades with good EV, since nothing else in the
// pipeline flips a hardcoded status. Checked against REAL resolved active_setups trades for
// this family (both LONG/SHORT variants combined), not the backtest N already used to
// calibrate stop/target.
async function getLiveStatus() {
  const { rows } = await query(`
    SELECT COUNT(*) as n, AVG(actual_pnl)::float as ev
    FROM active_setups
    WHERE setup_type LIKE $1 AND resolution IN ('TARGET_HIT','STOP_HIT') AND actual_pnl IS NOT NULL
  `, [`${SETUP_FAMILY}_%`]);
  const n = +rows[0].n, ev = rows[0].ev != null ? +rows[0].ev : null;
  if (n < 20) return { status: 'SHADOW', reason: 'NEW_SIGNAL_UNDER_LIVE_EVALUATION', liveN: n, liveEv: ev };
  if (ev != null && ev < -5) return { status: 'SHADOW', reason: 'PERFORMANCE_BELOW_THRESHOLD', liveN: n, liveEv: ev };
  return { status: 'ACTIVE', reason: null, liveN: n, liveEv: ev };
}

export async function detectMomentum60Trend(io) {
  try {
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const totalMins = nowET.getHours() * 60 + nowET.getMinutes();
    const tradeDateStr = nowET.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    if (_cache.date !== tradeDateStr) {
      _cache = { date: tradeDateStr, threshold: null, optimalStop: null, wasExtreme: false, firedToday: false };
    }

    if (totalMins < EVAL_START_ET_MIN || totalMins >= EVAL_END_ET_MIN) {
      _cache.wasExtreme = false; // reset fire-once state outside the eval window, same as end-of-day
      return;
    }
    if (_cache.firedToday) return; // one fire per day for this family, matches fire-once design

    const dayTypeQ = await query(`SELECT day_type FROM acd_daily_log WHERE trade_date=$1`, [tradeDateStr]);
    if (dayTypeQ.rows[0]?.day_type !== 'TREND') return; // only evaluate on TREND days

    if (!_cache.threshold) _cache.threshold = await getRollingThreshold(tradeDateStr);
    if (!_cache.threshold) return; // insufficient trailing history (shouldn't happen post-backfill)

    if (!_cache.optimalStop) _cache.optimalStop = await getOptimalStop();
    if (!_cache.optimalStop) return; // backtest_momentum60_daytype.mjs hasn't run yet this week

    const barsQ = await query(`
      SELECT close::float FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date >= CURRENT_DATE - 5 ORDER BY ts DESC LIMIT ${LOOKBACK_MIN + 1}
    `);
    if (barsQ.rows.length < LOOKBACK_MIN + 1) return;
    const closes = barsQ.rows.map(r => r.close).reverse(); // oldest first
    const currentClose = closes[closes.length - 1];
    const momentumNow = currentClose - closes[0];

    const isHigh = momentumNow >= _cache.threshold.hi;
    const isLow = momentumNow <= _cache.threshold.lo;
    const isExtreme = isHigh || isLow;

    if (isExtreme && !_cache.wasExtreme) {
      // Rising edge — fire once. TREND day = continuation, so trade direction matches the
      // extreme's own direction (isHigh = long, isLow = short).
      const long = isHigh;
      const entry = currentClose;
      const stop = long ? entry - _cache.optimalStop.stop : entry + _cache.optimalStop.stop;
      const target = long ? entry + _cache.optimalStop.target : entry - _cache.optimalStop.target;
      const setupType = `${SETUP_FAMILY}_${long ? 'LONG' : 'SHORT'}`;

      // Status computed dynamically every fire (getLiveStatus), not hardcoded — graduates from
      // SHADOW to ACTIVE on its own once N>=20 *live* resolved trades clear the same -$5/trade
      // bar backtest_setup_status.mjs applies everywhere else. Shadow rows still resolve
      // (TARGET_HIT/STOP_HIT) via the same generic resolver, so live data accumulates either way.
      const live = await getLiveStatus();
      const ins = await query(`
        INSERT INTO active_setups (
          trade_date, setup_type, fired_at, status,
          entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label,
          price_at_detection, suppression_reason
        ) VALUES ($1,$2,NOW(),$7,$3,$3,$4,$5,$6,$3,$8)
        ON CONFLICT (trade_date, setup_type, COALESCE(status, '')) WHERE status IN ('ACTIVE','SHADOW') DO NOTHING
        RETURNING id, trade_date, fired_at::text as fired_at, entry_zone_low, stop_level, t1_level, t1_label
      `, [tradeDateStr, setupType, entry, stop, target, `${_cache.optimalStop.target.toFixed(0)}pt target`, live.status, live.reason]);

      // Every other insert path in acd.js drops a copy into trade_timeline_events — matching
      // that here so this setup type shows up in the timeline the same as any other, once it's
      // ever surfaced (SHADOW rows aren't shown live, but the row should still exist for when
      // this graduates to ACTIVE, and for any tooling that reads the timeline directly).
      if (ins.rows[0]) { try { await dropToTimeline(ins.rows[0]); } catch (_) {} }

      // Only emit once this has actually graduated to ACTIVE (matches acd.js's own convention
      // of gating 'setup-fired' emits to status==='ACTIVE' only) — silent-but-tracked until then.
      if (ins.rows[0] && live.status === 'ACTIVE' && io) {
        io.emit('setup-fired', { setupId: ins.rows[0].id, setupType, entry, stop, target, direction: long ? 'LONG' : 'SHORT' });
      }
      _cache.firedToday = true;
    }
    _cache.wasExtreme = isExtreme;
  } catch (err) {
    console.error('[minuteBarSignalDetector] error:', err.message);
  }
}
