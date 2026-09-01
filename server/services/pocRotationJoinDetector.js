// Live detector for POC_ROTATION_JOIN_LONG/SHORT. Resolves OPEN_DECISION
// poc_rotation_join_build_live_detector (2026-09-01) -- porting the ZigZag-style
// leg/pivot + running-median-fair-value convergence detector
// (server/services/pocRotationService.js's detectSignalEvents(), originally built and
// audited in scripts/backtest_poc_rotation_vbp.mjs) into a live, poll-computable form.
//
// Modeled on rthFlushDetector.js/globexFlushDetector.js's shape (own poller, not the
// level-touch candidates array in acd.js) -- this is a whole-session leg-tracking
// pattern, not a price touching a fixed level.
//
// Validated construction (RESEARCH_CLAIM poc_rotation_join_fade_levels_med50_fixed,
// re-verified 2026-09-01): JOIN direction (trade WITH the leg that just converged back
// to the running 24hr median-volume fair value) + Time60_Stop20 exit (stop=20pt,
// 60-bar/60-min time limit, NO fixed price target) -- N=1935, WR=29.2%, EV=+$2.40/trade,
// stable=false cluster=false (real but thin edge, not rigor-clean -- SHADOW-only per the
// New Setup Type checklist regardless, since real live N=0 < 20). ONH/ONL and WS1
// confluence findings (RESEARCH_CLAIM poc_rotation_join_onh_onl_confluence N=335 EV
// $21.18, poc_rotation_join_ws1_confluence N=42 EV $22.15) are deliberately NOT wired
// here yet -- get the base type accumulating real data first, per the OPEN_DECISION's
// own explicit sequencing.
//
// STATELESS BY DESIGN (restart-safe): every poll recomputes detectSignalEvents() fresh
// from real bar history for the session-to-date, exactly like rthFlushDetector.js/
// globexFlushDetector.js -- no armed/pending state lives only in memory. This was the
// direct lesson from this same session's GLOBEX_FLUSH restart-fragility bug (an
// in-memory departure-armed flag lost on every server restart, of which there were 339
// in 7 days). The in-memory `_cache.lastProcessedEntryTs` below is a POLL-SKIP
// OPTIMIZATION ONLY (avoid redundant recompute+insert-attempt of already-seen events) --
// if it resets on restart, the detector just re-attempts inserting today's already-fired
// events, which harmlessly no-ops against active_setups' unique (trade_date, setup_type,
// fired_at) index. Never treat this cache as a source of truth.
//
// Session definition: the SAME 6PM ET -> 5PM ET (next day) 23hr window
// backtest_poc_rotation_vbp.mjs's `sessions` array uses (matches developing_value_log's
// trade_date convention) -- genuinely different from RTH's 9:30am open or Globex's own
// 6PM-anchored live boundaryMod elsewhere in acd.js. A leg can freely span RTH and
// Globex hours; this construction was never tested as RTH-only vs Globex-only splits
// (see the backtest's own KNOWN LIMITATION comment) -- it's a single continuous-session
// mechanism by design, satisfying CLAUDE.md's RTH+Globex-both-required rule structurally
// rather than via two separate calibrations.
//
// Exit resolution: does NOT use the shared bar-walk in resolveSetupsByPrice() (t1_level
// is an unreachable informational placeholder, never checked) -- see this setup type's
// own custom early-continue branch there, matching the ABSORPTION_LONG/COIL_SURGE
// precedent, since resolveSetupsByPrice() is a shared, heavily-loaded function this
// session deliberately avoided extending for a genuinely different (time-limit, no
// price target) exit shape without its own review.
import { query } from '../db.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { detectSignalEvents } from './pocRotationService.js';
import { dropToTimeline, computeFireTags, FIRE_TAG_COLS, fireTagValues } from '../routes/acd.js';
import { getBetClass } from '../config/setupTypes.js';

const THETA_CACHE_KEY = 'pocRotationJoin_theta';
const THETA_CACHE_TTL = 12 * 60 * 60 * 1000; // 12hr -- full-history median bar range moves negligibly intraday
const MIN_SESSION_BARS = 40; // matches rthFlushDetector's floor -- not enough bars yet to trust leg detection
const TIME_LIMIT_MINUTES = 60; // Time60_Stop20's validated exit -- 1-min bars, so 60 bars == 60 minutes
const STOP_POINTS = 20;
const T1_PLACEHOLDER_DIST = 1000; // informational-only, see header -- never checked for resolution

let _cache = { sessionKey: null, lastProcessedEntryTs: null };

async function getTheta() {
  const cached = cacheGet(THETA_CACHE_KEY);
  if (cached != null) return cached;
  const r = await query(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY high - low) as median_range FROM price_bars_primary WHERE symbol='NQ'`);
  const theta = Math.max(0.25, +r.rows[0].median_range);
  return cacheSet(THETA_CACHE_KEY, theta, THETA_CACHE_TTL);
}

// Current 6PM-5PM session's own trade_date (developing_value_log convention) as of "now".
// Returns null during the 5-6PM ET daily maintenance gap -- no session is open then.
function currentSessionDate(nowEt) {
  const etMin = nowEt.getUTCHours() * 60 + nowEt.getUTCMinutes(); // db.js parses ET wall-clock as UTC digits
  const y = nowEt.getUTCFullYear(), m = nowEt.getUTCMonth(), d = nowEt.getUTCDate();
  if (etMin >= 1080) { // >= 6PM -- tonight's session, dated tomorrow
    const tmr = new Date(Date.UTC(y, m, d + 1));
    return tmr.toISOString().slice(0, 10);
  }
  if (etMin < 1020) { // < 5PM -- still today's session (started 6PM yesterday)
    return new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
  }
  return null; // 5-6PM maintenance gap
}

export async function detectPocRotationJoin(io) {
  try {
    const nowEtRow = await query(`SELECT (NOW() AT TIME ZONE 'America/New_York')::text as now_et`);
    const nowEt = new Date(nowEtRow.rows[0].now_et.replace(' ', 'T') + 'Z');
    const sessionDate = currentSessionDate(nowEt);
    if (!sessionDate) return;

    if (_cache.sessionKey !== sessionDate) _cache = { sessionKey: sessionDate, lastProcessedEntryTs: null };

    const barsQ = await query(`
      SELECT ts::text as ts, open::float, high::float, low::float, close::float, volume::float as volume
      FROM price_bars_primary WHERE symbol='NQ' AND (
        (ts::date = $1::date - 1 AND EXTRACT(hour FROM ts) >= 18) OR
        (ts::date = $1::date AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) < 1020)
      ) AND ts <= $2
      ORDER BY ts ASC
    `, [sessionDate, nowEtRow.rows[0].now_et]);
    const bars = barsQ.rows;
    if (bars.length < MIN_SESSION_BARS) return;

    const theta = await getTheta();
    const { all_signal } = detectSignalEvents(65, 'standard', theta, [{ t: sessionDate, bars }], 'fixed');
    if (!all_signal.length) return;

    for (const event of all_signal) {
      if (event.entry_idx == null) continue;
      const entryBar = bars[event.entry_idx];
      if (_cache.lastProcessedEntryTs != null && entryBar.ts <= _cache.lastProcessedEntryTs) continue;

      const long = event.direction === 'UP'; // JOIN: trade WITH the leg that just converged
      const setupType = `POC_ROTATION_JOIN_${long ? 'LONG' : 'SHORT'}`;
      const entryPx = entryBar.open;
      const stopPx = long ? entryPx - STOP_POINTS : entryPx + STOP_POINTS;
      const t1Placeholder = long ? entryPx + T1_PLACEHOLDER_DIST : entryPx - T1_PLACEHOLDER_DIST;
      const firedAt = entryBar.ts;
      const expiresAtDate = new Date(entryBar.ts.replace(' ', 'T') + 'Z');
      expiresAtDate.setUTCMinutes(expiresAtDate.getUTCMinutes() + TIME_LIMIT_MINUTES);
      const expiresAt = expiresAtDate.toISOString().slice(0, 19).replace('T', ' ');

      const entryEtMin = (() => {
        const d = new Date(entryBar.ts.replace(' ', 'T') + 'Z');
        return d.getUTCHours() * 60 + d.getUTCMinutes();
      })();
      const fireSession = (entryEtMin >= 570 && entryEtMin < 960) ? 'RTH' : 'GLOBEX';

      // Real N=0 today -- always SHADOW per the New Setup Type checklist (N<20 real
      // resolved trades). No getLiveStatus()-style live re-check exists yet (checklist
      // item 7) -- add one once real fires start accumulating, matching
      // globexFlushDetector.js's own getLiveStatus() pattern.
      const status = 'SHADOW';
      const reason = 'NEW_SIGNAL_UNDER_LIVE_EVALUATION';

      const fireTags = await computeFireTags(sessionDate, fireSession, entryEtMin);
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
      `, [sessionDate, setupType, firedAt, expiresAt, status, entryPx, stopPx, t1Placeholder,
          'TIME_LIMIT_60BAR_MTM (no fixed target -- see pocRotationJoinDetector.js header)',
          reason, ...fireTagValues(fireTags), getBetClass(setupType)]);

      if (ins.rows[0]) {
        try {
          await dropToTimeline({
            id: ins.rows[0].id, trade_date: sessionDate, setup_type: setupType, fired_at: firedAt,
            entry_zone_low: entryPx, stop_level: stopPx, t1_level: t1Placeholder, t1_label: reason,
            resolution: null, historical_win_rate: null, historical_sessions: null, expires_at: expiresAt,
          });
        } catch (_) {}
      }
      _cache.lastProcessedEntryTs = entryBar.ts;
    }
  } catch (err) {
    console.error('[pocRotationJoinDetector] error:', err.message);
  }
}
