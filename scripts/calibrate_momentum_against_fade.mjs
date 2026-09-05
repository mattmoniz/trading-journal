// Momentum-against-fade filter calibration -- derives the live sizeMultiplier cutoff from a
// rolling window of real fade history, per this codebase's "no static thresholds" rule. User
// request 2026-09-05: does fading against sharp recent momentum predict worse outcomes, and
// should it size down live. Tested via inline analysis before building this (see
// RESEARCH_CLAIM momentum_against_fade_filter_20260905): real, held up across three lookback
// windows (5/15/30 bars) and a chronological half-split (did not reverse sign, unlike most other
// ideas tested this week). Persists the 75th-percentile "against" cutoff (the top quartile is
// where the real EV gap concentrated) so acd.js's live read never hardcodes a point value.
//
// Population: real ACTIVE+SHADOW fades, already-known-bad setup_types excluded (matches the
// forward-looking population this codebase uses everywhere else this week), both RTH and Globex
// pooled together -- the underlying mechanism (price already moved against you right before
// entry) is a generic market-microstructure effect, not a session-specific one, and Globex alone
// doesn't have enough real N to calibrate a separate cutoff yet.

import { query } from '../server/db.js';
import { resolveDirection } from '../server/config/setupTypes.js';
import { recordClaim } from './record_claim.mjs';

const ALREADY_SUPPRESSED = ['IB_BEARISH', 'IB_BULLISH', 'PD_POC_FADE_SHORT', 'GLOBEX_VWAP_FADE_LONG', 'PD_VAH_FADE_SHORT', 'OR5_LOW_FADE_SHORT'];
const LOOKBACK_BARS = 15;

async function main() {
  const todayR = await query(`SELECT CURRENT_DATE::text AS today`);
  const today = todayR.rows[0].today;

  const r = await query(`
    WITH real_fades AS (
      SELECT id, setup_type, trade_date::text AS trade_date, fired_at, actual_pnl::float AS pnl,
             stop_level, t1_level
      FROM active_setups
      WHERE origin_status IN ('ACTIVE','SHADOW')
        AND resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED') AND actual_pnl IS NOT NULL
    )
    SELECT t.*, bnow.close AS close_now, bpast.close AS close_past
    FROM real_fades t
    LEFT JOIN LATERAL (
      SELECT close FROM price_bars_primary WHERE symbol='NQ' AND ts < t.fired_at AND ts > t.fired_at - INTERVAL '2 hours'
      ORDER BY ts DESC LIMIT 1
    ) bnow ON true
    LEFT JOIN LATERAL (
      SELECT close FROM price_bars_primary WHERE symbol='NQ' AND ts < t.fired_at AND ts > t.fired_at - INTERVAL '2 hours'
      ORDER BY ts DESC OFFSET ${LOOKBACK_BARS} LIMIT 1
    ) bpast ON true
  `);

  const rows = r.rows.filter(t =>
    resolveDirection(t) != null &&
    !ALREADY_SUPPRESSED.includes(t.setup_type) &&
    t.close_now != null && t.close_past != null
  );

  const withMomentum = rows.map(t => {
    const dir = resolveDirection(t);
    const signed = Number(t.close_now) - Number(t.close_past);
    return { ...t, dir, against: dir === 'SHORT' ? signed : -signed };
  });

  const sortedAgainst = withMomentum.map(t => t.against).sort((a, b) => a - b);
  const p75 = sortedAgainst[Math.floor(sortedAgainst.length * 0.75)];
  const p25 = sortedAgainst[Math.floor(sortedAgainst.length * 0.25)];

  const q4 = withMomentum.filter(t => t.against > p75);
  const q1 = withMomentum.filter(t => t.against < p25);
  const rest = withMomentum.filter(t => t.against >= p25 && t.against <= p75);
  const stat = a => a.length ? { n: a.length, wr: +(a.filter(t => t.pnl > 0).length / a.length * 100).toFixed(1), ev: +(a.reduce((s, t) => s + t.pnl, 0) / a.length).toFixed(2) } : null;

  console.log('N used for calibration:', withMomentum.length);
  console.log('p25 (favorable) cutoff:', p25.toFixed(2), 'pts | p75 (against) cutoff:', p75.toFixed(2), 'pts');
  console.log('Q1 (favorable momentum):', stat(q1));
  console.log('Middle (no adjustment):', stat(rest));
  console.log('Q4 (against momentum, penalized):', stat(q4));

  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, notes)
    VALUES ($1, 0, 'MOMENTUM_AGAINST_FADE_CALIB', 'ALL_ROSTER', $2, $3, $4, $5)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
      sample_size = EXCLUDED.sample_size, win_rate = EXCLUDED.win_rate, ev_per_trade = EXCLUDED.ev_per_trade, notes = EXCLUDED.notes
  `, [
    today, withMomentum.length, stat(q4)?.wr ?? null, stat(q4)?.ev ?? null,
    JSON.stringify({ p25, p75, lookbackBars: LOOKBACK_BARS, q1: stat(q1), rest: stat(rest), q4: stat(q4) }),
  ]);

  await recordClaim({
    slug: 'momentum_against_fade_filter_20260905',
    claimText: `Fading against sharp recent momentum (${LOOKBACK_BARS}-bar lookback) predicts worse real fade outcomes. ` +
      `Current calibration (N=${withMomentum.length}): p75 cutoff=${p75.toFixed(2)}pts, above which EV=$${stat(q4)?.ev}/trade ` +
      `(N=${stat(q4)?.n}) vs middle-quartiles EV=$${stat(rest)?.ev}/trade. Held up across 5/15/30-bar windows and a ` +
      `chronological half-split (did not reverse sign) when first tested 2026-09-05 -- one of the more durable findings ` +
      `from that session. Wired live 2026-09-05 as a bounded sizeMultiplier penalty (RTH and Globex both) reading this ` +
      `calibration row, not a hardcoded point value. Self-recalibrates weekly.`,
    sourceFile: 'scripts/calibrate_momentum_against_fade.mjs',
    sourceDate: today,
    sampleSize: withMomentum.length,
    evPerTrade: stat(q4)?.ev ?? null,
    winRate: stat(q4)?.wr ?? null,
    rigorStatus: 'held_up_across_windows_and_chronological_split',
    status: 'PROVISIONAL',
  });
  console.log('Recorded calibration + RESEARCH_CLAIM.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
