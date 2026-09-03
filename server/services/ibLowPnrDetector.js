// Live detector for IB_LOW_PNR_SHORT ("point of no return") -- a momentum-continuation
// SHORT, distinct from the existing IB_LOW_FADE_SHORT/LONG retest fades. See
// docs/EXTREME_PRESSURE_POINT_OF_NO_RETURN_SPEC.md for the full research thread.
//
// Thesis: cumulative sell-side order-flow delta (running bid_volume - ask_volume since
// IB close), z-scored against a 90-day trailing same-bar-index baseline
// (touchQuality.js's getCumulativeDeltaBaseline), crossing an extreme threshold while
// price is already below today's IB Low predicts the session is much less likely to
// ever reclaim IB Low afterward (31.0% never-recover vs 0.7% unconditional baseline,
// N=29 days, rigor-clean/stable). A dedicated placebo control (same afternoon window,
// same stop, same hold-to-close, but NO z-filter) came back flat (N=207, EV=-$0.22),
// confirming the z-score itself is load-bearing, not just "afternoon day below IB Low."
// z>=3 population trade sim: N=15, WR=66.7%, stop=150pt/no-target EV=$276.27/trade --
// but 3 of 15 days carry 87% of that $, so treat the exact EV as unconfirmed until real
// forward N accumulates. REAL LIVE N=0 as of this build -- always fires SHADOW.
//
// Design-critiqued by DeepSeek before build (scratch/deepseek_response.md, 2026-09-03).
// Fixes incorporated from that review:
//  - Baseline keyed by mod-IB_CLOSE_MOD (gap-safe), early-close days excluded from the
//    trailing window (both live inside getCumulativeDeltaBaseline itself).
//  - This is the SAME underlying "did IB Low reclaim" event as IB_LOW_FADE_LONG (which
//    bets FOR reclaim) -- deliberately pass that family's own key ('IB_LOW_FADE') to
//    isCrossDirectionFastFlip/isPostWinOppositeFamilyBlocked below, not this type's own
//    name, so both shipped gates see the real conflict instead of being string-blind to it.
//  - Standalone poller runs on the 60s cycle (server/index.js), not 15s -- ~69min avg
//    lag on the underlying signal makes this immaterial.
//  - Entry-window cap (ENTRY_CUTOFF_ET_MIN) so a fire always has real runway before the
//    session close it holds to.
//  - Named IB_LOW_PNR_SHORT, not *_FADE_* -- getBetClass()/inferStrategyFamily() would
//    otherwise misclassify this continuation bet as VALUE_FADE/mean-reversion.
//  - Resolution is a custom hold-to-close/mark-to-market branch in
//    resolveSetupsByPrice() (matches the POC_ROTATION_JOIN precedent), early-close-aware
//    via marketCalendar.js's getEarlyCloseMinute().
//
// STATELESS BY DESIGN (restart-safe), matching rthFlushDetector.js/
// pocRotationJoinDetector.js: every poll recomputes the crossing bar fresh from real bar
// history; fired_at is set to the crossing bar's OWN timestamp (not NOW()), so a re-poll
// harmlessly no-ops against active_setups' unique (trade_date, setup_type, fired_at)
// index. _cache.firedToday below is a POLL-SKIP OPTIMIZATION ONLY, never a source of truth.
import { query } from '../db.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { getCumulativeDeltaBaseline, IB_CLOSE_MOD } from './touchQuality.js';
import { getMarketStatus, getEarlyCloseMinute } from './marketCalendar.js';
import { getCanonicalLiveStatus } from './setupEligibility.js';
import {
  dropToTimeline, computeFireTags, FIRE_TAG_COLS, fireTagValues,
  isCrossDirectionFastFlip, isPostWinOppositeFamilyBlocked,
} from '../routes/acd.js';
import { getBetClass } from '../config/setupTypes.js';

const SETUP_TYPE = 'IB_LOW_PNR_SHORT';
const Z_THRESHOLD = 3.0; // validated threshold -- see spec
// Best backtested config at N=15 (stop=150-170pt, no target). Literal pending real
// OPTIMAL_STOP-based recalibration once real forward N accumulates -- same pattern as
// pocRotationJoinDetector.js's own STOP_POINTS literal, which has the identical caveat.
const STOP_POINTS = 150;
const ENTRY_CUTOFF_ET_MIN = 930; // 3:30pm ET -- DeepSeek: cap entry so a fire always has real runway before close
const BASELINE_CACHE_TTL = 12 * 60 * 60 * 1000; // 12hr -- day-stable, matches levelFadeStats convention
const T1_PLACEHOLDER_DIST = 1000; // informational-only, unreachable -- never checked, see resolveSetupsByPrice's custom branch

let _cache = { tradeDate: null, firedToday: false };

async function getBaseline(tradeDate) {
  const key = `cumDeltaBaseline_SHORT_${tradeDate}`;
  const cached = cacheGet(key);
  if (cached != null) return cached;
  const baseline = await getCumulativeDeltaBaseline(query, tradeDate, 'SHORT', getMarketStatus);
  return cacheSet(key, baseline, BASELINE_CACHE_TTL);
}

export async function detectIbLowPnr() {
  try {
    const nowRow = await query(`SELECT (NOW() AT TIME ZONE 'America/New_York')::text as now_et, CURRENT_DATE::text as today`);
    const nowEtStr = nowRow.rows[0].now_et;
    const tradeDate = nowRow.rows[0].today;
    const nowEt = new Date(nowEtStr.replace(' ', 'T') + 'Z');
    const etMin = nowEt.getUTCHours() * 60 + nowEt.getUTCMinutes();

    if (_cache.tradeDate !== tradeDate) _cache = { tradeDate, firedToday: false };
    if (_cache.firedToday) return;
    // Afternoon-only window (signal doesn't show up before IB close + doesn't reliably
    // read before ~2pm per the spec) AND an entry-runway cap on the other end.
    if (etMin < IB_CLOSE_MOD || etMin > ENTRY_CUTOFF_ET_MIN) return;

    const ibRes = await query(`
      SELECT MIN(low)::float as ib_low FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date = $1::date
        AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int BETWEEN 570 AND 629
    `, [tradeDate]);
    const ibLow = ibRes.rows[0]?.ib_low;
    if (ibLow == null) return; // no IB formed yet/today (holiday, data gap)

    const barsRes = await query(`
      SELECT ts::text as ts, (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as mod,
             close::float, COALESCE(bid_volume,0)::float as bid_volume, COALESCE(ask_volume,0)::float as ask_volume
      FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1::date
        AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int >= ${IB_CLOSE_MOD}
      ORDER BY ts ASC
    `, [tradeDate]);
    if (!barsRes.rows.length) return;

    const baseline = await getBaseline(tradeDate);
    let cum = 0, crossBar = null;
    for (const b of barsRes.rows) {
      cum += (b.bid_volume - b.ask_volume);
      const bl = baseline.get(b.mod - IB_CLOSE_MOD);
      if (!bl) continue;
      const z = (cum - bl.mean) / bl.std;
      if (z >= Z_THRESHOLD) { crossBar = b; break; }
    }
    if (!crossBar) return;
    // Entry gate: price must already be below IB Low at the crossing bar -- this is
    // what defines the trade (excludes the ~30.6% of crossings that happen before the
    // initial IB Low break), not an optional filter. Must stay byte-identical to the
    // backtest's own predicate (close < ibLow).
    if (crossBar.close >= ibLow) return;

    // Opposite-direction overlap gate: this is the same underlying "did IB Low reclaim"
    // event IB_LOW_FADE_LONG bets on (for reclaim) -- pass that family's key explicitly.
    if (await isCrossDirectionFastFlip(tradeDate, 'IB_LOW_FADE', 'SHORT')) return;
    if (await isPostWinOppositeFamilyBlocked(tradeDate, 'IB_LOW_FADE', 'SHORT')) return;

    const entryPx = crossBar.close;
    const stopPx = entryPx + STOP_POINTS;
    const t1Placeholder = entryPx - T1_PLACEHOLDER_DIST;

    const earlyCloseMin = getEarlyCloseMinute(tradeDate);
    const closeMin = earlyCloseMin ?? 960; // 4:00pm ET normal, 1:00pm ET early close
    const expiresAtDate = new Date(Date.UTC(nowEt.getUTCFullYear(), nowEt.getUTCMonth(), nowEt.getUTCDate()));
    expiresAtDate.setUTCHours(0, closeMin, 0, 0);
    const expiresAt = expiresAtDate.toISOString().slice(0, 19).replace('T', ' ');

    // Real N=0 today -- ALWAYS SHADOW regardless of what getCanonicalLiveStatus would
    // eventually say once a SETUP_STATUS row exists (New Setup Type checklist: N<20 real
    // resolved trades => never fire live). Still call it for an honest suppression_reason.
    const liveStatus = await getCanonicalLiveStatus(SETUP_TYPE);
    const status = 'SHADOW';
    const reason = liveStatus.reason || 'NEW_SIGNAL_UNDER_LIVE_EVALUATION';

    const fireTags = await computeFireTags(tradeDate, 'RTH', crossBar.mod);
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
    `, [tradeDate, SETUP_TYPE, crossBar.ts, expiresAt, status, entryPx, stopPx, t1Placeholder,
        'HOLD_TO_CLOSE_MTM (no fixed target -- see ibLowPnrDetector.js header)',
        reason, ...fireTagValues(fireTags), getBetClass(SETUP_TYPE)]);

    if (ins.rows[0]) {
      _cache.firedToday = true;
      try {
        await dropToTimeline({
          id: ins.rows[0].id, trade_date: tradeDate, setup_type: SETUP_TYPE, fired_at: crossBar.ts,
          entry_zone_low: entryPx, stop_level: stopPx, t1_level: t1Placeholder, t1_label: reason,
          resolution: null, historical_win_rate: null, historical_sessions: null, expires_at: expiresAt,
        });
      } catch (_) {}
    }
  } catch (err) {
    console.error('[ibLowPnrDetector] error:', err.message);
  }
}
