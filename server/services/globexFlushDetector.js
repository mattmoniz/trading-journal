// Live detector for GLOBEX_FLUSH_LONG/SHORT and GLOBEX_FLUSH_REVERSAL_LONG/SHORT --
// docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md sec 4.8/4.18.
//
// Trigger: at RTH close through 4:30 PM ET, has price already closed beyond yesterday's value
// area (below PD_VAL or above PD_VAH)? If so, that departure bar is the trigger -- no magnitude
// filter needed, unlike the abandoned "first 60 minutes of session open" design this replaced.
// The SAME balance/resolution/structural-stop mechanism used by RTH_FLUSH then watches
// CONTINUOUSLY through the whole overnight session (no fixed window) until it resolves or the
// window closes at the next RTH open.
//
// MODE-AWARE, per-mode pace + volume-building tiered target (2026-08-28, user-requested review
// after a first pooled-by-resolution-direction version hid a real, much stronger effect):
// pooling all resolutions by direction alone erased the pace/volume signal (correlation only
// 0.04-0.14). Splitting by MODE -- does the departure direction AGREE with the eventual
// resolution direction (CONTINUATION) or DISAGREE (REVERSAL) -- reveals a real, tercile-clean
// effect within each mode. Each of the 4 (departure x resolution) combinations gets its own
// setup_type and its own pace/volume-building 3-tier combined score (sec 4.13's exact design:
// count of {NOT-fast pace, building volume}, each score 0/1/2 targeted at its OWN p75 MFE),
// calibrated separately by scripts/backtest_flush_patterns.mjs. Reversal types are classified
// MEAN_REVERSION in bet_class (server/config/setupTypes.js) -- they trade a reversion back
// toward/through value, not a continuation of the departure.
//
// Volume-building window is capped at the ENTRY bar (departure exclusive through entry
// inclusive) -- no lookahead, unlike the original (pre-redesign) design's bug where the
// measurement window could extend past the entry bar.
import { query } from '../db.js';
import { dropToTimeline, computeFireTags, FIRE_TAG_COLS, fireTagValues } from '../routes/acd.js';
import { getBetClass } from '../config/setupTypes.js';
import { computeBalanceAndResolution, computeEntryPace } from './flushMechanics.js';
import { getVolumeBaseline } from './touchQuality.js';

const DEPARTURE_CHECK_START_MOD = 959; // 4:00 PM ET, RTH close
const DEPARTURE_CHECK_END_MOD = 989;   // 4:30 PM ET -- matches sec 4.8's median ~4:15 PM departure timing
const WATCH_END_ET_MIN = 570;          // 9:30 AM ET, next RTH open -- stop watching past this
const ALL_SETUP_TYPES = ['GLOBEX_FLUSH_LONG', 'GLOBEX_FLUSH_SHORT', 'GLOBEX_FLUSH_REVERSAL_LONG', 'GLOBEX_FLUSH_REVERSAL_SHORT'];

// departureDay: the ET calendar date (string) whose RTH close produced the armed departure, or
// null if none armed. Persists across the midnight rollover on purpose -- a departure found at
// 4:15 PM stays armed through the following morning until it resolves or the window closes.
let _cache = { departureDay: null, departure: null, firedForDeparture: false, calib: null };

async function getCalibration() {
  const { rows } = await query(`
    SELECT signal_name, notes
    FROM performance_audit
    WHERE signal_type='OPTIMAL_STOP' AND signal_name = ANY($1::text[])
      AND run_date = (SELECT MAX(run_date) FROM performance_audit WHERE signal_type='OPTIMAL_STOP' AND signal_name = ANY($1::text[]))
  `, [ALL_SETUP_TYPES]);
  if (!rows.length) return null;
  const out = {};
  for (const r of rows) {
    let notes = {};
    try { notes = JSON.parse(r.notes || '{}'); } catch (_) {}
    if (notes.tierTargets == null || notes.paceCutoffPtsPerMin == null || notes.avgVolZMedian == null || notes.volZTrendMedian == null) continue;
    out[r.signal_name] = notes;
  }
  return Object.keys(out).length ? out : null;
}

async function getLiveStatus(setupType) {
  const { rows } = await query(`
    SELECT COUNT(*) as n, AVG(actual_pnl)::float as ev
    FROM active_setups
    WHERE setup_type = $1 AND resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED') AND actual_pnl IS NOT NULL
  `, [setupType]);
  const n = +rows[0].n, ev = rows[0].ev != null ? +rows[0].ev : null;
  if (n < 20) return { status: 'SHADOW', reason: 'NEW_SIGNAL_UNDER_LIVE_EVALUATION', liveN: n, liveEv: ev };
  if (ev != null && ev < -5) return { status: 'SHADOW', reason: 'PERFORMANCE_BELOW_THRESHOLD', liveN: n, liveEv: ev };
  return { status: 'ACTIVE', reason: null, liveN: n, liveEv: ev };
}

export async function detectGlobexFlush(io) {
  try {
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const totalMins = nowET.getHours() * 60 + nowET.getMinutes();
    const todayET = nowET.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // Active window: 4:00 PM ET through 9:30 AM ET the next day (nearly the whole non-RTH
    // period) -- the departure check itself only fires right at close, but the continuous watch
    // afterward needs to keep running all night.
    const inWindow = totalMins >= DEPARTURE_CHECK_START_MOD || totalMins < WATCH_END_ET_MIN;
    if (!inWindow) { _cache = { departureDay: null, departure: null, firedForDeparture: false, calib: null }; return; }

    if (!_cache.calib) _cache.calib = await getCalibration();
    if (!_cache.calib) return; // backtest_flush_patterns.mjs hasn't run yet

    // Step 1: look for today's own departure, only during the close-through-4:30-PM window, and
    // only once per day.
    if (totalMins >= DEPARTURE_CHECK_START_MOD && totalMins <= DEPARTURE_CHECK_END_MOD && _cache.departureDay !== todayET) {
      const levelsQ = await query(`
        SELECT DISTINCT ON (level_name) level_name, price::float FROM level_prices
        WHERE trade_date <= $1 AND level_name IN ('PD_VAL','PD_VAH')
        ORDER BY level_name, trade_date DESC
      `, [todayET]);
      const val = levelsQ.rows.find(r => r.level_name === 'PD_VAL')?.price;
      const vah = levelsQ.rows.find(r => r.level_name === 'PD_VAH')?.price;
      if (val != null && vah != null) {
        const closeBarsQ = await query(`
          SELECT ts, close::float FROM price_bars_primary
          WHERE symbol='NQ' AND ts::date=$1
            AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN ${DEPARTURE_CHECK_START_MOD} AND ${DEPARTURE_CHECK_END_MOD}
          ORDER BY ts ASC
        `, [todayET]);
        for (const b of closeBarsQ.rows) {
          if (b.close < val) { _cache.departureDay = todayET; _cache.departure = { dir: 'DOWN', price: b.close, ts: b.ts }; break; }
          if (b.close > vah) { _cache.departureDay = todayET; _cache.departure = { dir: 'UP', price: b.close, ts: b.ts }; break; }
        }
        if (_cache.departureDay === todayET) _cache.firedForDeparture = false;
      }
    }

    if (!_cache.departure || _cache.firedForDeparture) return;

    // Step 2: watch continuously from the departure bar through now for balance + resolution.
    const barsQ = await query(`
      SELECT ts, open::float, high::float, low::float, close::float,
             COALESCE(bid_volume,0)+COALESCE(ask_volume,0) as volume,
             (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as mod
      FROM price_bars_primary WHERE symbol='NQ' AND ts > $1
        AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) < 570 OR EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) > 959)
      ORDER BY ts ASC
    `, [_cache.departure.ts]);
    const postBars = barsQ.rows;
    if (postBars.length < 31) return; // need the 30-bar balance window plus at least one more

    const res = computeBalanceAndResolution(postBars);
    if (!res) return;

    const long = res.resolutionDir === 'UP';
    const mode = _cache.departure.dir === res.resolutionDir ? 'CONTINUATION' : 'REVERSAL';
    const setupType = mode === 'CONTINUATION' ? `GLOBEX_FLUSH_${long ? 'LONG' : 'SHORT'}` : `GLOBEX_FLUSH_REVERSAL_${long ? 'LONG' : 'SHORT'}`;
    const calib = _cache.calib[setupType];
    if (!calib) return; // this specific mode/direction combo hasn't been calibrated yet

    const resolutionBar = postBars[res.resolutionIdx];
    const entryIdx = res.resolutionIdx;

    // Pace: departure price/time through the entry -- known entirely at entry time.
    const pace = computeEntryPace(_cache.departure.price, _cache.departure.ts, res.entryPrice, resolutionBar.ts);

    // Volume-building: bars from departure (exclusive) through the ENTRY bar (inclusive) --
    // fully known at the moment of entry, no lookahead. Baseline keyed to the departure day
    // (a single 90-day-trailing per-minute-of-day baseline covers the whole overnight span).
    const volBaseline = await getVolumeBaseline(query, _cache.departureDay);
    const preEntryBars = postBars.slice(0, entryIdx + 1);
    const volZs = [];
    for (const b of preEntryBars) {
      const bl = volBaseline.get(b.mod);
      if (bl && bl.std_vol > 0) volZs.push((Number(b.volume) - bl.avg_vol) / bl.std_vol);
    }
    let avgVolZ = null, volZTrend = null;
    if (volZs.length >= 5) {
      avgVolZ = volZs.reduce((a, b) => a + b, 0) / volZs.length;
      const n = volZs.length, xs = Array.from({ length: n }, (_, i) => i);
      const mx = xs.reduce((a, b) => a + b, 0) / n, my = avgVolZ;
      let cov = 0, vx = 0, vy = 0;
      for (let i = 0; i < n; i++) { cov += (xs[i] - mx) * (volZs[i] - my); vx += (xs[i] - mx) ** 2; vy += (volZs[i] - my) ** 2; }
      volZTrend = (vx > 0 && vy > 0) ? cov / Math.sqrt(vx * vy) : 0;
    }

    let score = 0;
    if (pace !== null && pace <= calib.paceCutoffPtsPerMin) score++; // NOT-fast
    if (avgVolZ !== null && volZTrend !== null && avgVolZ > calib.avgVolZMedian && volZTrend > calib.volZTrendMedian) score++; // building
    const targetPts = calib.tierTargets[score];

    const entry = res.entryPrice; // the resolution bar's own close -- see flushMechanics.js's F3 comment
    const stop = res.stopPrice;
    const target = long ? entry + targetPts : entry - targetPts;
    // UTC getters, NEVER .getHours()/.getDate() -- see rthFlushDetector.js's identical comment
    // (DeepSeek review, 2026-08-27, F2) for why local getters silently wrote fired_at 4-5h early.
    const firedAt = resolutionBar.ts.toISOString().slice(0, 16).replace('T', ' ') + ':00';

    const live = await getLiveStatus(setupType);
    // trade_date is the DEPARTURE day (_cache.departureDay), not "today" -- the setup is about
    // the value area that day's RTH close broke, even though the resolution may land after
    // midnight. Expiry caps at that departure day's own following RTH open.
    const expiresAt = `${_cache.departureDay} 09:30:00`;
    const fireTags = await computeFireTags(_cache.departureDay, 'GLOBEX', totalMins);
    const ins = await query(`
      INSERT INTO active_setups (
        trade_date, setup_type, fired_at, expires_at, status, origin_status,
        entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label,
        price_at_detection, suppression_reason, ${FIRE_TAG_COLS.join(', ')}, bet_class
      ) VALUES ($1,$2,$3,$9,$6,$6,$4,$4,$5,$8,$10,$4,$7,
        ${FIRE_TAG_COLS.map((_, i) => `$${11 + i}`).join(', ')},
        $${11 + FIRE_TAG_COLS.length})
      ON CONFLICT DO NOTHING
      RETURNING id, trade_date, fired_at::text as fired_at, entry_zone_low, stop_level, t1_level, t1_label
    `, [_cache.departureDay, setupType, firedAt, entry, stop, live.status, live.reason, target, expiresAt,
        `value-departure (${_cache.departure.dir}) ${mode.toLowerCase()}, score=${score}, ${targetPts.toFixed(0)}pt target`,
        ...fireTagValues(fireTags), getBetClass(setupType)]);

    if (ins.rows[0]) {
      try { await dropToTimeline(ins.rows[0]); } catch (_) {}
      _cache.firedForDeparture = true;
      if (live.status === 'ACTIVE' && io) {
        io.emit('setup-fired', { setupId: ins.rows[0].id, setupType, entry, stop, target, direction: long ? 'LONG' : 'SHORT' });
      }
    } else {
      _cache.firedForDeparture = true;
    }
  } catch (err) {
    console.error('[globexFlushDetector] error:', err.message);
  }
}
