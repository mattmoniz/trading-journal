// Live detector for RTH_FLUSH_LONG/SHORT -- docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md sec
// 4.4-4.14. Modeled on minuteBarSignalDetector.js's shape (own poller, not the level-touch
// candidates array in acd.js -- this is a whole-session structural-break-then-consolidation
// pattern, not a price touching a fixed level).
//
// Mechanism: whichever fires first each RTH day -- an Initial Balance break (>=10:30 ET) or an
// overnight-high/low break (from 9:30 ET) -- becomes the trigger. The next 30 bars form a
// consolidation ("balance"); the trade enters when price closes 50pt beyond that balance, with a
// STRUCTURAL stop at the opposite balance edge (not a fixed point distance) and a flat,
// calibration-read target. sec 4.14: N=336, WR=66.1%, EV=$34.31/trade, clean+stable+rising --
// the best-supported RTH design found in the whole research thread. UNAFFECTED by the Globex
// session-boundary bug found 2026-08-27 (OPEN_DECISION
// globex_session_boundary_4to5pm_misattribution_bug) -- RTH sessions never cross a date boundary.
//
// No lookahead: trigger/balance/resolution are all computed from bars strictly at-or-before the
// current poll's latest bar. fired_at is set to the RESOLUTION bar's own timestamp (not NOW()),
// so a re-poll that recomputes the same day's already-found resolution harmlessly no-ops against
// active_setups' unique (trade_date, setup_type, fired_at) index rather than needing its own
// dedup logic.
//
// Stop/target: target is read live from OPTIMAL_STOP (never hardcoded, per CLAUDE.md's New Setup
// Type checklist). Stop is STRUCTURAL (opposite balance edge), computed per-instance -- the
// OPTIMAL_STOP row's own `optimal_stop` value is INFORMATIONAL ONLY (avg observed balance width,
// for the Setup Reference page), never read here for the actual live stop.
import { query } from '../db.js';
import { dropToTimeline, computeFireTags, FIRE_TAG_COLS, fireTagValues } from '../routes/acd.js';
import { getBetClass } from '../config/setupTypes.js';
import { computeBalanceAndResolution } from './flushMechanics.js';
import { getVolumeBaseline } from './touchQuality.js';

const IB_END_MOD = 630; // 10:30 ET
const EVAL_START_ET_MIN = 570; // 9:30 ET
const EVAL_END_ET_MIN = 960;   // 4:00 ET -- once RTH closes, no more resolutions can occur today

let _cache = { date: null, optimalTargets: null, firedToday: false };

async function getOptimalTargets() {
  const { rows } = await query(`
    SELECT signal_name, optimal_target::float as target, notes
    FROM performance_audit
    WHERE signal_type='OPTIMAL_STOP' AND signal_name IN ('RTH_FLUSH_LONG','RTH_FLUSH_SHORT')
      AND run_date = (SELECT MAX(run_date) FROM performance_audit WHERE signal_type='OPTIMAL_STOP' AND signal_name IN ('RTH_FLUSH_LONG','RTH_FLUSH_SHORT'))
  `);
  if (!rows.length) return null;
  const out = {};
  for (const r of rows) {
    let notes = {};
    try { notes = JSON.parse(r.notes || '{}'); } catch (_) {}
    // Volume-building 2-tier target (2026-08-28, scratch/rth_mode_pace_volume_retest.mjs): RTH
    // doesn't need a continuation/reversal mode split (pooling was actually cleanest here,
    // unlike Globex) -- just a plain building/not-building split on the pooled population. Pace
    // does NOT hold for RTH, confirmed unchanged from sec 4.13's original finding.
    out[r.signal_name] = { target: r.target, buildingTarget: notes.buildingTarget, avgVolZMedian: notes.avgVolZMedian, volZTrendMedian: notes.volZTrendMedian };
  }
  return out;
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

export async function detectRthFlush(io) {
  try {
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const totalMins = nowET.getHours() * 60 + nowET.getMinutes();
    const tradeDateStr = nowET.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // Re-fetch calibration on every date rollover (not preserved across it) -- DeepSeek review
    // (2026-08-27, F8) caught that carrying the old value forward means a weekly
    // backtest_flush_patterns.mjs recalibration is never picked up without a full server restart.
    if (_cache.date !== tradeDateStr) _cache = { date: tradeDateStr, optimalTargets: null, firedToday: false };
    if (totalMins < EVAL_START_ET_MIN || totalMins >= EVAL_END_ET_MIN) return;
    if (_cache.firedToday) return;

    if (!_cache.optimalTargets) _cache.optimalTargets = await getOptimalTargets();
    if (!_cache.optimalTargets) return; // backtest_flush_patterns.mjs hasn't run yet

    const barsQ = await query(`
      SELECT ts, open::float, high::float, low::float, close::float,
             COALESCE(bid_volume,0)+COALESCE(ask_volume,0) as volume,
             (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as mod
      FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
      ORDER BY ts ASC
    `, [tradeDateStr]);
    const sessBars = barsQ.rows;
    if (sessBars.length < 40) return; // need at least IB (30) + a few bars past it

    const ibBars = sessBars.filter(b => b.mod < IB_END_MOD);
    let ibTriggerIdx = null;
    if (ibBars.length >= 30) {
      const ibHigh = Math.max(...ibBars.map(b => b.high)), ibLow = Math.min(...ibBars.map(b => b.low));
      for (let i = 0; i < sessBars.length; i++) {
        if (sessBars[i].mod < IB_END_MOD) continue;
        if (sessBars[i].close > ibHigh || sessBars[i].close < ibLow) { ibTriggerIdx = i; break; }
      }
    }
    // Read ONH/ONL from level_prices (the real overnight session: prior-evening 18:00-23:59 UNION
    // today 00:00-09:29, computed pre-market by scripts/compute_levels.js), NOT a live bars query
    // restricted to today's own calendar date -- DeepSeek review (2026-08-27, F6) caught that a
    // `ts::date=$1` query only ever sees today's post-midnight bars, silently missing the entire
    // prior evening and giving a strictly narrower (and differently-triggering) range than what
    // scripts/backtest_flush_patterns.mjs actually calibrated against.
    const onQ = await query(`
      SELECT DISTINCT ON (level_name) level_name, price::float FROM level_prices
      WHERE trade_date <= $1 AND level_name IN ('ONH','ONL')
      ORDER BY level_name, trade_date DESC
    `, [tradeDateStr]);
    const onh = onQ.rows.find(r => r.level_name === 'ONH')?.price;
    const onl = onQ.rows.find(r => r.level_name === 'ONL')?.price;
    let onTriggerIdx = null;
    if (onh != null && onl != null) {
      for (let i = 0; i < sessBars.length; i++) {
        if (sessBars[i].close > onh || sessBars[i].close < onl) { onTriggerIdx = i; break; }
      }
    }
    let triggerIdx = null, triggerSource = null;
    if (ibTriggerIdx !== null && onTriggerIdx !== null) {
      if (ibTriggerIdx <= onTriggerIdx) { triggerIdx = ibTriggerIdx; triggerSource = 'IB'; } else { triggerIdx = onTriggerIdx; triggerSource = 'ON'; }
    } else if (ibTriggerIdx !== null) { triggerIdx = ibTriggerIdx; triggerSource = 'IB'; }
    else if (onTriggerIdx !== null) { triggerIdx = onTriggerIdx; triggerSource = 'ON'; }
    if (triggerIdx === null) return;

    const postBars = sessBars.slice(triggerIdx + 1);
    const res = computeBalanceAndResolution(postBars);
    if (!res) return; // not resolved yet (or never will be today)

    const long = res.resolutionDir === 'UP';
    const setupType = `RTH_FLUSH_${long ? 'LONG' : 'SHORT'}`;
    const calib = _cache.optimalTargets[setupType];
    if (calib == null || calib.target == null) return;

    // Volume-building: from the trigger bar (exclusive) through the entry bar (inclusive) -- no
    // lookahead. Falls back to the plain (NOT-building) target if the calibration row doesn't
    // have building-split data yet (an older run of backtest_flush_patterns.mjs) or if there
    // aren't enough bars in the window to compute a trend.
    let targetPts = calib.target;
    if (calib.buildingTarget != null && calib.avgVolZMedian != null && calib.volZTrendMedian != null) {
      const volBaseline = await getVolumeBaseline(query, tradeDateStr);
      const preEntryBars = sessBars.slice(triggerIdx + 1, res.resolutionIdx + triggerIdx + 2);
      const volZs = [];
      for (const b of preEntryBars) {
        const bl = volBaseline.get(b.mod);
        if (bl && bl.std_vol > 0) volZs.push((Number(b.volume) - bl.avg_vol) / bl.std_vol);
      }
      if (volZs.length >= 5) {
        const avgVolZ = volZs.reduce((a, b) => a + b, 0) / volZs.length;
        const n = volZs.length, xs = Array.from({ length: n }, (_, i) => i);
        const mx = xs.reduce((a, b) => a + b, 0) / n;
        let cov = 0, vx = 0, vy = 0;
        for (let i = 0; i < n; i++) { cov += (xs[i] - mx) * (volZs[i] - avgVolZ); vx += (xs[i] - mx) ** 2; vy += (volZs[i] - avgVolZ) ** 2; }
        const volZTrend = (vx > 0 && vy > 0) ? cov / Math.sqrt(vx * vy) : 0;
        if (avgVolZ > calib.avgVolZMedian && volZTrend > calib.volZTrendMedian) targetPts = calib.buildingTarget;
      }
    }
    const entry = res.entryPrice; // the resolution bar's own close -- see flushMechanics.js's F3 comment
    const stop = res.stopPrice;
    const target = long ? entry + targetPts : entry - targetPts;
    const resolutionBar = postBars[res.resolutionIdx];
    // UTC getters, NEVER .getHours()/.getDate() -- db.js's type parser deliberately mislabels
    // this DB's ET-wall-clock naive timestamps as UTC so the ORIGINAL digits round-trip correctly
    // through UTC getters only. Using local getters here was a real bug (DeepSeek review,
    // 2026-08-27, F2): it silently wrote fired_at 4-5h early (EDT/EST), which corrupted the whole
    // downstream resolution walk in resolveSetupsByPrice() (a stop-loss look-back window starting
    // hours before the trade actually existed).
    const firedAt = resolutionBar.ts.toISOString().slice(0, 16).replace('T', ' ') + ':00';

    const live = await getLiveStatus(setupType);
    const expiresAt = `${tradeDateStr} 16:00:00`;
    const fireTags = await computeFireTags(tradeDateStr, 'RTH', totalMins);
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
    `, [tradeDateStr, setupType, firedAt, entry, stop, live.status, live.reason, target, expiresAt,
        `${triggerSource}-break, ${targetPts.toFixed(0)}pt target`, ...fireTagValues(fireTags), getBetClass(setupType)]);

    if (ins.rows[0]) {
      try { await dropToTimeline(ins.rows[0]); } catch (_) {}
      _cache.firedToday = true;
      if (live.status === 'ACTIVE' && io) {
        io.emit('setup-fired', { setupId: ins.rows[0].id, setupType, entry, stop, target, direction: long ? 'LONG' : 'SHORT' });
      }
    } else {
      // Already inserted on an earlier poll (ON CONFLICT DO NOTHING no-op) -- stop re-querying today.
      _cache.firedToday = true;
    }
  } catch (err) {
    console.error('[rthFlushDetector] error:', err.message);
  }
}
