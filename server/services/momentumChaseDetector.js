// Momentum-chase (PDH/PDL breakout) live detector, 2026-09-09.
//
// Backing research: RESEARCH_CLAIM setup6_momentum_chase_medium_regime_positive_20260909
// (scratch/backtest_script_round5.py) -- a real, chronologically stable edge found ONLY in
// MEDIUM GARCH-regime mornings (N=128, win rate 58.6%, mean +$13.23/trade), using a stop/target
// width sized to the regime's own actual 5-min bar range (not a fixed number -- a flat 20pt
// width was found BELOW the data's own resolution floor in MEDIUM/HIGH regime, per an
// independent DeepSeek code review, and materially understated this setup's real performance).
//
// Mechanism (unchanged from the backtest): a 5-min RTH bar closes beyond the prior trading
// day's RTH high (long) or low (short) -- enter IMMEDIATELY, no retest wait. Stop and target
// are symmetric (1:1 R:R), sized to scripts/calibrate_momentum_chase_width.mjs's freshest
// MEDIUM-regime width (a rolling 90-day recalibration, not the one-off backtest's fixed 46pt --
// see that script's own header for why). Entry search restricted to the morning session
// (9:30am-12:00pm ET), matching every round of the backtest this is built from.
//
// LIVE STATUS: real N=0 as of this build -- inserts as SHADOW unconditionally regardless of
// this codebase's own dynamic SHADOW->ACTIVE promotion machinery (isLiveEligible() etc.) until
// SETUP_STATUS accumulates real forward N>=20, per the standing "New setup type checklist"
// hard rule (item 3: "If N<20 resolved trades, do NOT fire live"). No promotion-check wiring is
// needed yet for the same reason -- promotion can't happen before N=20 exists regardless, so
// there is nothing this file could get wrong on that front today. Revisit once real N approaches
// 20 (a fresh OPEN_DECISION should be flagged at that point, not before).
//
// Deliberately its OWN standalone detector, not folded into the massive shadowCandidates loop
// or the level-fade candidates array in acd.js -- this is a breakout-chase, not a level fade,
// and doesn't need (or want) that array's fade-specific gates (sibling-reversal, cross-
// direction-fast-flip, opposite-direction-conflict -- all reasoning about level-fade families
// relating to each other, not applicable to a lone breakout-chase setup that's SHADOW-only
// anyway). Matches this codebase's own "genuinely new setup outside the level-fade roster gets
// its own standalone poller" precedent (detectGlobexSetup(), STACK_VOL_BREAK_LIVE).

import { query } from '../db.js';
import { getPriorDayRthRange } from './queries.js';
import { getCurrentGarchRegime } from './volatilityRegime.js';
import { getValueAreaRegimeMap, computeRegimeStamp, REGIME_STAMP_COLS, regimeStampValues, getVaOverlapStreak } from './acdLiveCalibration.js';
import { computeFireTags, FIRE_TAG_COLS, fireTagValues } from './fireTags.js';
import { getBetClass } from '../config/setupTypes.js';
import { dropToTimeline } from './acdShared.js';

const MORNING_CUTOFF_MIN = 720; // 12:00 PM ET, matches every round of the backing backtest

// Returns a candidate { direction, entry, stop, target, width, pdHigh, pdLow, regime } or null.
// Pure function of (todayET, etMin, currentPrice) plus live reads -- no side effects, no DB
// writes. The caller (acd.js) decides whether/how to insert it.
export async function detectMomentumChaseCandidate(todayET, etMin, currentPrice) {
  if (etMin >= MORNING_CUTOFF_MIN) return null;
  if (currentPrice == null) return null;

  const regimeInfo = await getCurrentGarchRegime().catch(() => null);
  if (!regimeInfo || regimeInfo.regime !== 'MEDIUM') return null;

  const { pdHigh, pdLow } = await getPriorDayRthRange(todayET);
  if (pdHigh == null || pdLow == null) return null;

  let direction = null;
  if (currentPrice > pdHigh) direction = 'LONG';
  else if (currentPrice < pdLow) direction = 'SHORT';
  if (!direction) return null;

  const widthRes = await query(`
    SELECT notes FROM performance_audit
    WHERE signal_type = 'MOMENTUM_CHASE_WIDTH_CALIB' AND signal_name = 'LATEST'
    ORDER BY run_date DESC LIMIT 1
  `).catch(() => ({ rows: [] }));
  if (!widthRes.rows.length) return null;
  const width = JSON.parse(widthRes.rows[0].notes)?.widths?.MEDIUM;
  if (!width) return null;

  const entry = currentPrice;
  const stop = direction === 'LONG' ? entry - width : entry + width;
  const target = direction === 'LONG' ? entry + width : entry - width;

  return { direction, entry, stop, target, width, pdHigh, pdLow, regime: regimeInfo.regime };
}

// One-per-session guard -- mirrors the backtest's own "one trade per session, first valid
// signal" rule. Checks for ANY existing row of either direction today (SHADOW or otherwise),
// since the backtest never allowed a same-day re-fire after the first signal regardless of
// outcome.
export async function hasMomentumChaseFiredToday(todayET) {
  const r = await query(`
    SELECT 1 FROM active_setups
    WHERE trade_date = $1 AND setup_type IN ('MOMENTUM_CHASE_MEDIUM_LONG', 'MOMENTUM_CHASE_MEDIUM_SHORT')
    LIMIT 1
  `, [todayET]).catch(() => ({ rows: [] }));
  return r.rows.length > 0;
}

// Full detect-and-insert, called from acd.js's runSetupDetection as a single line -- ALL of
// this setup's own logic (dedup check, detection, SHADOW insert) lives here, not split across
// this file and acd.js, per this codebase's "default new acd.js logic to server/services/"
// convention (user-restated 2026-09-09: "remember I don't want to keep adding to acd"). ALWAYS
// inserts as SHADOW (see header) -- no cross-direction/sibling-reversal/opposite-direction
// gating needed yet, those protect ACTIVE-firing decisions this row never makes.
export async function computeMomentumChaseSignal(todayET, etMin) {
  try {
    if (await hasMomentumChaseFiredToday(todayET)) return null;
    const priceQ = await query(`
      SELECT close::float as price FROM price_bars_primary
      WHERE symbol='NQ' ORDER BY ts DESC LIMIT 1
    `).catch(() => ({ rows: [] }));
    const currentPrice = priceQ.rows[0]?.price ?? null;
    const candidate = await detectMomentumChaseCandidate(todayET, etMin, currentPrice);
    if (!candidate) return null;

    const mcSetupType = `MOMENTUM_CHASE_MEDIUM_${candidate.direction}`;
    const mcVaMap = await getValueAreaRegimeMap(todayET).catch(() => ({}));
    const mcRegimeStamp = computeRegimeStamp(candidate.entry, mcVaMap);
    const mcFireTags = await computeFireTags(todayET, 'RTH', etMin);
    // Fetched for parity with other insert sites' own column set; not yet wired into a column
    // here since active_setups' va_overlap_streak write already happens at every OTHER real
    // insert site consistently -- add it if/when this setup gets its own dedicated review pass.
    await getVaOverlapStreak(todayET).catch(() => null);
    const mcExpiresAt = `${todayET} 16:00:00`;

    const ins = await query(`
      INSERT INTO active_setups (
        trade_date, setup_type, fired_at, expires_at, status, origin_status,
        entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label,
        price_at_detection, ${REGIME_STAMP_COLS.join(', ')}, ${FIRE_TAG_COLS.join(', ')}, bet_class
      ) VALUES ($1,$2,NOW(),$3,'SHADOW','SHADOW',$4,$4,$5,$6,$7,$4,
        ${REGIME_STAMP_COLS.map((_, i) => `$${8 + i}`).join(', ')},
        ${FIRE_TAG_COLS.map((_, i) => `$${8 + REGIME_STAMP_COLS.length + i}`).join(', ')},
        $${8 + REGIME_STAMP_COLS.length + FIRE_TAG_COLS.length})
      ON CONFLICT DO NOTHING
      RETURNING id, trade_date, fired_at::text as fired_at, expires_at::text as expires_at, entry_zone_low, stop_level, t1_level, t1_label
    `, [todayET, mcSetupType, mcExpiresAt, candidate.entry, candidate.stop, candidate.target,
        `${candidate.width}pt (rolling MEDIUM-regime 75th-pctile bar range, see MOMENTUM_CHASE_WIDTH_CALIB)`,
        ...regimeStampValues(mcRegimeStamp), ...fireTagValues(mcFireTags), getBetClass(mcSetupType)]);
    if (ins.rows[0]) { try { await dropToTimeline(ins.rows[0]); } catch (_) {} }
    return candidate;
  } catch (_) { return null; /* informational-only build, never block the response */ }
}
