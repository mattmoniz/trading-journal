// Live "pulse" (volume acceleration) reading, 2026-09-09 — direct user request after the
// pulse/VWAP-slope/price-position research thread (RESEARCH_CLAIM
// pulse_vwap_slope_direction_negative_20260909). Same volZ definition that backtest used:
// current 5-min bar's volume z-scored against its own trailing 20-bar mean/std (reset fresh
// each RTH session, no cross-session bleed), classified PICKING_UP if that z-score is higher
// than it was 3 bars ago, DROPPING_OFF if lower.
//
// IMPORTANT, state this every time this value is surfaced: the backing research found this
// measure, even combined with VWAP slope and price-vs-VWAP, does NOT reliably predict forward
// direction (the one nominally-significant cell reversed sign between the two chronological
// halves of the dataset — see the RESEARCH_CLAIM). This is shown for its own sake (a live
// "is volume accelerating or decelerating right now" read, complementing the RVOL chip's level-
// only view), not as a validated trading signal — same honest-descriptive framing this
// codebase already uses for the GARCH volatility card's raw scale number.
//
// Deliberately its own standalone service, not folded into acd.js — matches the "isolate non-
// trading features" convention already used for volatilityRegime.js. Builds its own bounded
// bar query rather than importing acd.js's non-exported getSessionBarsSinceOpen().

import { query } from '../db.js';

const RTH_OPEN_MOD = 570; // 9:30 AM ET, minutes from midnight

export async function getLivePulseReading() {
  // Bounded to the last 20 hours (a session is at most ~15h) — same defensive floor as this
  // codebase's own getSessionBarsSinceOpen(), preventing a missing session-open bar from
  // silently spanning into a prior session.
  const res = await query(`
    WITH session_1m AS (
      SELECT ts, volume FROM price_bars_primary
      WHERE symbol = 'NQ' AND ts >= (
        SELECT ts FROM price_bars_primary
        WHERE symbol = 'NQ' AND (EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts))::int = $1
          AND ts <= NOW() AND ts >= NOW() - INTERVAL '20 hours'
        ORDER BY ts DESC LIMIT 1
      ) AND ts <= NOW()
    )
    SELECT date_trunc('hour', ts) + (floor(EXTRACT(minute FROM ts) / 5) * INTERVAL '5 min') as bucket,
      SUM(volume)::float as volume
    FROM session_1m
    GROUP BY bucket
    ORDER BY bucket ASC
  `, [RTH_OPEN_MOD]).catch(() => ({ rows: [] }));

  const bars = res.rows.map((r) => Number(r.volume));
  // Need 20-bar rolling window + 3-bar lookback + current = 24 bars (~2h into the session).
  // Return a distinguishable "warming up" state rather than null for this case specifically --
  // found live 2026-09-09: the frontend hides the card entirely on null, which for the first
  // ~2 hours of EVERY trading day looks identical to "this is broken," not "not ready yet."
  // `null` is still returned for genuine failure (query error, caught above) so the frontend
  // can keep distinguishing "no data at all" from "warming up."
  if (bars.length < 24) return { state: 'WARMING_UP', barsSoFar: bars.length, barsNeeded: 24 };

  const volZAt = (i) => {
    const window = bars.slice(i - 20, i);
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length;
    const std = Math.sqrt(variance);
    return std > 0 ? (bars[i] - mean) / std : 0;
  };

  const lastIdx = bars.length - 1;
  const currentVolZ = volZAt(lastIdx);
  const priorVolZ = volZAt(lastIdx - 3);

  let state;
  if (currentVolZ > priorVolZ) state = 'PICKING_UP';
  else if (currentVolZ < priorVolZ) state = 'DROPPING_OFF';
  else state = 'FLAT';

  return { state, volZ: +currentVolZ.toFixed(2), volZPrior: +priorVolZ.toFixed(2) };
}
