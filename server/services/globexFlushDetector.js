// Live detector for GLOBEX_FLUSH_LONG/SHORT and GLOBEX_FLUSH_REVERSAL_LONG/SHORT --
// docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md sec 4.8/4.18.
//
// Trigger: at ANY point from RTH close (4:00 PM ET) through 9:30 AM ET the next day, has price
// closed beyond yesterday's value area (below PD_VAL or above PD_VAH)? If so, that departure bar
// is the trigger -- no magnitude filter needed, unlike the abandoned "first 60 minutes of session
// open" design this replaced. WIDENED 2026-09-01 (was ONLY the first 30 minutes after close, 4:00-
// 4:30 PM ET -- found, via a real ~530pt overnight move that broke value at ~3:00 AM and was never
// caught at all, to structurally miss any departure developing later in the evening; see
// findDeparture()'s own header for the full incident). The SAME balance/resolution/structural-stop
// mechanism used by RTH_FLUSH then watches CONTINUOUSLY from whichever bar actually departed
// through now for balance + resolution (no fixed window) until it resolves or the watch closes at
// the next RTH open.
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

const DEPARTURE_CHECK_START_MOD = 959; // 4:00 PM ET, RTH close -- departure watch begins here
const WATCH_END_ET_MIN = 570;          // 9:30 AM ET, next RTH open -- stop watching past this
const ALL_SETUP_TYPES = ['GLOBEX_FLUSH_LONG', 'GLOBEX_FLUSH_SHORT', 'GLOBEX_FLUSH_REVERSAL_LONG', 'GLOBEX_FLUSH_REVERSAL_SHORT'];

// FIXED 2026-09-01 (real overnight incident: a server restart at 22:54 ET on 2026-08-31 silently
// dropped that night's armed UP-departure -- the departure-check window is 4:00-4:30 PM only, so
// once the restart wiped the in-memory _cache, there was no way to re-arm for the rest of the
// night, and a genuine ~530pt overnight move went completely uncaught by this mechanism). Root
// cause: departure/firedForDeparture lived ONLY in an in-memory module variable across a ~17hr
// watch window, with zero DB persistence -- restarts are frequent in this codebase's dev workflow
// (339 SERVER_SHUTDOWN events in the 7 days checked), so this was never a rare edge case.
//
// Fix, matching rthFlushDetector.js's own already-restart-safe design exactly: RTH never caches
// its trigger at all -- it re-derives it fresh from real bar history every single poll, so a
// restart is harmless by construction (worst case: a redundant computation that hits
// active_setups' own ON CONFLICT DO NOTHING and no-ops, same as this file's header already
// documented for the resolution side but never applied to the departure side). Only `calib`
// (backtest_flush_patterns.mjs's calibration) stays cached here -- safe/cheap to re-derive, same
// as RTH's own optimalTargets caching.
let _cache = { calib: null };

// The ET calendar date whose 4:00-4:30 PM RTH close is relevant to the CURRENT poll moment --
// "today" while it's still that same afternoon/evening, "yesterday" once past midnight and before
// the next RTH open (totalMins < WATCH_END_ET_MIN). Pure function of the clock, no state.
function resolveDepartureDay(todayET, totalMins) {
  if (totalMins >= WATCH_END_ET_MIN) return todayET;
  const d = new Date(todayET + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// FIXED 2026-09-01 (real overnight incident: a genuine ~530pt move on 2026-08-31/09-01 was
// never caught at all -- root-caused, AFTER first wrongly suspecting the restart-fragility bug
// above, to a structural design gap: the departure check used to look ONLY in a 30-minute window
// right at RTH close (4:00-4:30 PM ET). That night's real value-area break didn't happen until
// ~3:00 AM ET, ~11 hours after that window closed -- structurally invisible to the old design no
// matter how stable the server was). Widened to check the ENTIRE overnight watch period (4:00 PM
// departureDay through 9:30 AM the next day) for the FIRST bar that closes beyond PD_VAL/PD_VAH,
// not just the first 30 minutes. Still re-derived fresh every poll (never cached) -- restart-safe
// by construction, exactly like RTH's own trigger detection. Returns { dir, price, ts } or null.
async function findDeparture(departureDay) {
  const levelsQ = await query(`
    SELECT DISTINCT ON (level_name) level_name, price::float FROM level_prices
    WHERE trade_date <= $1 AND level_name IN ('PD_VAL','PD_VAH')
    ORDER BY level_name, trade_date DESC
  `, [departureDay]);
  const val = levelsQ.rows.find(r => r.level_name === 'PD_VAL')?.price;
  const vah = levelsQ.rows.find(r => r.level_name === 'PD_VAH')?.price;
  if (val == null || vah == null) return null;
  const closeBarsQ = await query(`
    SELECT ts, close::float FROM price_bars_primary
    WHERE symbol='NQ'
      AND ((ts::date = $1::date AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) >= ${DEPARTURE_CHECK_START_MOD})
        OR (ts::date = $1::date + 1 AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) < ${WATCH_END_ET_MIN}))
    ORDER BY ts ASC
  `, [departureDay]);
  for (const b of closeBarsQ.rows) {
    if (b.close < val) return { dir: 'DOWN', price: b.close, ts: b.ts };
    if (b.close > vah) return { dir: 'UP', price: b.close, ts: b.ts };
  }
  return null;
}

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
    if (!inWindow) return;

    if (!_cache.calib) _cache.calib = await getCalibration();
    if (!_cache.calib) return; // backtest_flush_patterns.mjs hasn't run yet

    const departureDay = resolveDepartureDay(todayET, totalMins);

    // Cheap existence check FIRST -- has any GLOBEX_FLUSH*/GLOBEX_FLUSH_REVERSAL* row already
    // fired for this departure day? If so, tonight is done, skip the (relatively) more expensive
    // departure/balance/resolution re-derivation below. This replaces the old in-memory
    // firedForDeparture flag with a real DB check -- restart-safe, and ON CONFLICT DO NOTHING
    // below remains a second safety net regardless.
    const alreadyFired = await query(
      `SELECT 1 FROM active_setups WHERE trade_date=$1 AND setup_type = ANY($2::text[]) LIMIT 1`,
      [departureDay, ALL_SETUP_TYPES]
    );
    if (alreadyFired.rows.length) return;

    // Re-derived fresh every poll, never cached -- restart-safe by construction, matching
    // rthFlushDetector.js's own trigger-detection design exactly (see the header comment above).
    const departure = await findDeparture(departureDay);
    if (!departure) return;

    // Step 2: watch continuously from the departure bar through now for balance + resolution.
    const barsQ = await query(`
      SELECT ts, open::float, high::float, low::float, close::float,
             COALESCE(bid_volume,0)+COALESCE(ask_volume,0) as volume,
             (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as mod
      FROM price_bars_primary WHERE symbol='NQ' AND ts > $1
        AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) < 570 OR EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) > 959)
      ORDER BY ts ASC
    `, [departure.ts]);
    const postBars = barsQ.rows;
    if (postBars.length < 31) return; // need the 30-bar balance window plus at least one more

    const res = computeBalanceAndResolution(postBars);
    if (!res) return;

    const long = res.resolutionDir === 'UP';
    const mode = departure.dir === res.resolutionDir ? 'CONTINUATION' : 'REVERSAL';
    const setupType = mode === 'CONTINUATION' ? `GLOBEX_FLUSH_${long ? 'LONG' : 'SHORT'}` : `GLOBEX_FLUSH_REVERSAL_${long ? 'LONG' : 'SHORT'}`;
    const calib = _cache.calib[setupType];
    if (!calib) return; // this specific mode/direction combo hasn't been calibrated yet

    const resolutionBar = postBars[res.resolutionIdx];
    const entryIdx = res.resolutionIdx;

    // Pace: departure price/time through the entry -- known entirely at entry time.
    const pace = computeEntryPace(departure.price, departure.ts, res.entryPrice, resolutionBar.ts);

    // Volume-building: bars from departure (exclusive) through the ENTRY bar (inclusive) --
    // fully known at the moment of entry, no lookahead. Baseline keyed to the departure day
    // (a single 90-day-trailing per-minute-of-day baseline covers the whole overnight span).
    const volBaseline = await getVolumeBaseline(query, departureDay);
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
    // trade_date is the DEPARTURE day, not "today" -- the setup is about the value area that
    // day's RTH close broke, even though the resolution may land after midnight. Expiry caps at
    // that departure day's own following RTH open.
    const expiresAt = `${departureDay} 09:30:00`;
    const fireTags = await computeFireTags(departureDay, 'GLOBEX', totalMins);
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
    `, [departureDay, setupType, firedAt, entry, stop, live.status, live.reason, target, expiresAt,
        `value-departure (${departure.dir}) ${mode.toLowerCase()}, score=${score}, ${targetPts.toFixed(0)}pt target`,
        ...fireTagValues(fireTags), getBetClass(setupType)]);

    if (ins.rows[0]) {
      try { await dropToTimeline(ins.rows[0]); } catch (_) {}
      if (live.status === 'ACTIVE' && io) {
        io.emit('setup-fired', { setupId: ins.rows[0].id, setupType, entry, stop, target, direction: long ? 'LONG' : 'SHORT' });
      }
    }
  } catch (err) {
    console.error('[globexFlushDetector] error:', err.message);
  }
}
