// =============================================================================
// Bar-body-quality backtest — validates the DOJI/STRONG BODY chips shown on live
// setup cards (ACDView.jsx, ~line 4511: isDoji = bp<30, isStrong = bp>=65).
// Those tier boundaries (30%/65%) are an existing display-only convention, not a
// new trading threshold — this script measures WR/EV against them, it doesn't
// invent new cutoffs.
//
// body_pct = ABS(close-open)/(high-low)*100 for the bar at fired_at — same formula
// already used live in /api/setups/today (server/routes/acd.js ~line 5966-5972).
//
// Writes signal_type='BODY_PCT_ALPHA' to performance_audit: one 'ALL' row (blended
// across setup types) plus one row per setup_type with N≥MIN_N in any tier, so the
// per-type breakdown is available if a future session wants to condition on it.
//
// Run manually (`node scripts/backtest_body_pct.mjs`); not on a cron — this is a
// validation check for an existing informational chip, not a live sizing input.
// =============================================================================

import { query } from '../server/db.js';

const MIN_N = 20;

function tierOf(bodyPct) {
  if (bodyPct < 30) return 'DOJI';
  if (bodyPct >= 65) return 'STRONG';
  return 'NORMAL';
}

async function main() {
  console.log('Computing body-quality-tier WR/EV from active_setups + price_bars_primary...');

  const res = await query(`
    SELECT s.setup_type, s.actual_pnl::float, s.resolution,
      CASE WHEN (pb.high - pb.low) > 0
        THEN ROUND(ABS(pb.close - pb.open) / (pb.high - pb.low) * 100)::int
        ELSE NULL END AS body_pct
    FROM active_setups s
    JOIN LATERAL (
      SELECT high::float, low::float, close::float, open::float
      FROM price_bars_primary pb
      WHERE pb.symbol = 'NQ' AND pb.ts = s.fired_at
      LIMIT 1
    ) pb ON true
    WHERE s.status = 'RESOLVED'
      AND s.resolution IN ('TARGET_HIT', 'STOP_HIT')
      AND s.actual_pnl IS NOT NULL
  `);

  const rows = res.rows.filter(r => r.body_pct != null);
  console.log(`${rows.length} resolved trades with a valid body_pct at fired_at.`);

  const groups = { ALL: {} };
  for (const r of rows) {
    const tier = tierOf(r.body_pct);
    (groups.ALL[tier] ??= []).push(r);
    (groups[r.setup_type] ??= {})[tier] ??= [];
    groups[r.setup_type][tier].push(r);
  }

  let upserted = 0;
  for (const [setupType, tiers] of Object.entries(groups)) {
    for (const [tier, trades] of Object.entries(tiers)) {
      if (trades.length < MIN_N) continue;
      const n = trades.length;
      const wr = trades.filter(t => t.resolution === 'TARGET_HIT').length / n;
      const ev = trades.reduce((s, t) => s + t.actual_pnl, 0) / n;
      const signalName = `${setupType}_${tier}`;

      await query(`
        INSERT INTO performance_audit (
          run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade
        ) VALUES (CURRENT_DATE, 9999, 'BODY_PCT_ALPHA', $1, $2, $3, $4)
        ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
          sample_size = EXCLUDED.sample_size, win_rate = EXCLUDED.win_rate, ev_per_trade = EXCLUDED.ev_per_trade
      `, [signalName, n, wr, ev]);
      upserted++;
      console.log(`  ${signalName.padEnd(40)} N=${n.toString().padEnd(5)} WR=${(wr*100).toFixed(1)}%  EV=$${ev.toFixed(2)}`);
    }
  }

  console.log(`\nDone. ${upserted} rows upserted (signal_type=BODY_PCT_ALPHA). ALL_DOJI/ALL_NORMAL/ALL_STRONG are the headline blended comparison.`);
  process.exit(0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
