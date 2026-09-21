// Live "volume piling on" descriptive gauge, 2026-09-21 -- user request right after the Globex
// overnight rotation badge, immediately followed by an explicit warning (before this was built):
// this reading is a DESCRIPTIVE analog of a retrospective/hindsight finding
// (RESEARCH_CLAIM globex_big_move_volume_piling_at_accel_20260910 -- real big Globex moves show
// elevated volume during their own acceleration window, measured AFTER the fact), NOT the
// forward-predictive claim "a live volume spike right now means a move is starting." That
// forward version was separately tested and found NEGATIVE (RESEARCH_CLAIM
// volume_confirmed_defended_breakout_continuation_20260910 -- a bare volume spike at a level
// break more often marks a fakeout than a real continuation; the sub-case that held up needed
// genuine PRIOR DEFENSE of the level first, which is what majorPivotDefendedBreakDetector.js /
// minorDefendedLevelDetector.js / stallDefendedLevelDetector.js already test for -- all 3 sit
// at real N=0 as of this file's creation, so there is no live-validated "catch/ride the move"
// mechanism to attach this reading to). Shown purely descriptively, same "informational only,
// not a signal" framing this codebase already uses for pulseReading.js/volatilityRegime.js's
// raw scale number -- the user makes their own discretionary read from it, the system does not
// recommend riding anything off it alone.
//
// Definition, matching the retrospective research's own pre-window-vs-at-window comparison
// exactly (see scratch/big_globex_move_volume_piling.mjs's "pre-accel (-60 to 0min) vs
// at-accel (0 to +30min)" table): mean volZ over the last 30 minutes ("AT", the live proxy for
// "right now") vs mean volZ over the preceding 60 minutes before that ("PRE") -- both z-scored
// against getTouchQualityBaseline()'s 90-day trailing per-minute-of-day average (the SAME
// baseline touchQuality.js/pulseReading.js already use, no lookahead -- reused via acdShared.js
// per the "export the real function" rule, not reimplemented).
//
// Deliberately its own standalone service, not folded into acd.js/globexRotationBadge.js --
// matches the "isolate non-trading features" convention already used for volatilityRegime.js/
// pulseReading.js.

import { query } from '../db.js';
import { getTouchQualityBaseline } from './acdShared.js';

const PRE_MIN = 60;
const AT_MIN = 30;

export async function getLiveVolumePileReading() {
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  // Bounded to the last ~100 minutes -- PRE_MIN+AT_MIN=90 plus a small buffer for gaps.
  const barsRes = await query(`
    SELECT (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as mod,
      (COALESCE(bid_volume,0)+COALESCE(ask_volume,0)) as vol
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts <= NOW() AND ts >= NOW() - INTERVAL '100 minutes'
    ORDER BY ts ASC
  `).catch(() => ({ rows: [] }));
  const bars = barsRes.rows;
  if (bars.length < PRE_MIN + AT_MIN) {
    return { state: 'WARMING_UP', barsSoFar: bars.length, barsNeeded: PRE_MIN + AT_MIN };
  }

  const baseline = await getTouchQualityBaseline(todayET);
  const zOf = (row) => {
    const bl = baseline.get(row.mod);
    if (!bl || bl.std_vol <= 0) return null;
    return (Number(row.vol) - bl.avg_vol) / bl.std_vol;
  };

  const recent = bars.slice(-(PRE_MIN + AT_MIN));
  const preZs = recent.slice(0, PRE_MIN).map(zOf).filter((z) => z != null);
  const atZs = recent.slice(PRE_MIN).map(zOf).filter((z) => z != null);
  if (preZs.length < PRE_MIN * 0.5 || atZs.length < AT_MIN * 0.5) {
    return { state: 'INSUFFICIENT_BASELINE' };
  }

  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const preVolZ = mean(preZs);
  const atVolZ = mean(atZs);
  const delta = atVolZ - preVolZ;
  const state = delta > 0 ? 'PILING_ON' : 'QUIET';

  const explanation = state === 'PILING_ON'
    ? `Volume over the last ${AT_MIN} minutes (z=${atVolZ.toFixed(2)}) is running above the preceding ${PRE_MIN} minutes (z=${preVolZ.toFixed(2)}) -- the same shape seen at the start of large real Globex moves, in hindsight. Descriptive only: a live volume spike on its own was separately tested and found to mark a fakeout MORE often than a real continuation -- this does not predict direction or that a move will continue.`
    : `Volume over the last ${AT_MIN} minutes (z=${atVolZ.toFixed(2)}) is at or below the preceding ${PRE_MIN} minutes (z=${preVolZ.toFixed(2)}) -- no pile-on happening right now.`;

  return { state, preVolZ: +preVolZ.toFixed(2), atVolZ: +atVolZ.toFixed(2), delta: +delta.toFixed(2), explanation };
}
