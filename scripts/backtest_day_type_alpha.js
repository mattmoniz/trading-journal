// =============================================================================
// Per-(setup_type × day_type) win rate analysis with statistical significance.
// Writes DAY_TYPE_ALPHA rows to performance_audit for use by the live fade path.
//
// Signal name encoding: {setup_type}_{day_type}  e.g. CAM_S3_FADE_LONG_BALANCE
// Live path reads via liveStats._dta[`${type}-${dtClass}`].
//
// Classification (see HARDCODED_CONSTANTS.md for rationale on these constants):
//   SIZE_UP_STRONG : z ≥ 2.0  AND  WR ≥ 0.75   (statistically + practically strong)
//   SIZE_UP        : z ≥ 1.5  AND  WR ≥ 0.65
//   SIZE_DOWN      : z ≤ -1.5
//   SUPPRESS       : z ≤ -2.0 AND  WR < 0.55
//   NEUTRAL        : everything else, or N < 20
//
// size_delta = min(|z| × 0.07, 0.25) — scales with evidence strength, no fixed amounts.
//
// Run after backtest_unified: node scripts/backtest_day_type_alpha.js
//
// EXTENDED 2026-07-23: the population query used to be `setup_type LIKE '%FADE%'` only,
// which structurally excluded IB_BULLISH/IB_BEARISH (and MOMENTUM_60m_60m_TREND, which has
// no active_setups history under that name and is unaffected either way) from this entire
// mechanism -- meaning these two never got a dynamically-recalibrated, statistically-gated
// per-day-type row here, ever. Found while investigating why the RTH leg of the 1yr prop-
// challenge walkthrough looks negative: IB_BULLISH/IB_BEARISH's own SETUP_STATUS
// day_type_breakdown shows a genuinely clean, large-N situational split (IB_BEARISH: BALANCE
// EV=-$26/N=54, TURBULENT EV=+$65/N=31, TREND EV=+$8/N=32; IB_BULLISH: BALANCE EV=-$37/N=65,
// TREND EV=+$17/N=32, TURBULENT EV=-$53/N=22) -- but the LIVE day-type gate for these two
// (server/routes/acd.js ~line 4132-4134) is a hardcoded boolean (suppress IB_BULLISH on
// BALANCE/TURBULENT, IB_BEARISH on BALANCE/TREND) based on a stale in-code comment snapshot,
// never re-derived from current data, unlike every FADE setup_type which gets this dynamically
// via liveStats._dta. Extending the population query is the safe half of the fix (a backtest/
// calibration script -- populates performance_audit only, no live behavior change by itself).
// Wiring ibSetup's live gate to actually READ liveStats._dta instead of the hardcoded boolean
// is a separate, deliberately-not-yet-built live-behavior change -- see OPEN_DECISION
// ib_bullish_bearish_daytype_gate_hardcoded_not_dynamic.
// =============================================================================

import { query } from '../server/db.js';

const MIN_N          = 20;    // CLAUDE.md N≥20 rule — below this, always NEUTRAL
const SCALE_FACTOR   = 0.07;  // size_delta per σ of divergence; at z=2→0.14, z=3→0.21, cap 0.25
const Z_UP_STRONG    = 2.0;
const Z_UP           = 1.5;
const Z_DOWN         = 1.5;
const Z_SUPPRESS     = 2.0;
const WR_UP_STRONG   = 0.75;
const WR_UP          = 0.65;
const WR_SUPPRESS    = 0.55;

async function run() {
  console.log('DAY_TYPE_ALPHA backtest starting…');

  // Two separate queries — critical for correct z_score computation:
  // overall uses ALL resolved trades (the true baseline expectation for each setup_type);
  // cells uses only day-typed trades (to measure day_type-specific performance).
  // Using the same set for both compresses divergences when most trades have a day_type.
  const [overallRes, daytypeRes] = await Promise.all([
    query(`
      SELECT setup_type, resolution, actual_pnl::float
      FROM active_setups
      WHERE (setup_type LIKE '%FADE%' OR setup_type IN ('IB_BULLISH', 'IB_BEARISH'))
        AND status = 'RESOLVED'
    `),
    query(`
      SELECT a.setup_type, a.resolution, a.actual_pnl::float, a.origin_status, d.day_type
      FROM active_setups a
      JOIN acd_daily_log d ON a.trade_date = d.trade_date
      WHERE (a.setup_type LIKE '%FADE%' OR a.setup_type IN ('IB_BULLISH', 'IB_BEARISH'))
        AND a.status = 'RESOLVED'
        AND d.day_type IS NOT NULL
      ORDER BY a.setup_type, d.day_type
    `),
  ]);

  console.log(`  ${overallRes.rows.length} total resolved fades; ${daytypeRes.rows.length} with day_type.`);

  // Build overall WR per setup_type from ALL resolved trades (true baseline)
  const overalls = {};
  for (const r of overallRes.rows) {
    const win = r.resolution === 'TARGET_HIT' ? 1 : 0;
    if (!overalls[r.setup_type]) overalls[r.setup_type] = { wins: 0, n: 0 };
    overalls[r.setup_type].wins += win;
    overalls[r.setup_type].n   += 1;
  }

  // Build cells from day-typed trades only. Tracks real_n/real_pnl (origin_status
  // IN ('ACTIVE','SHADOW') only) ALONGSIDE the blended n/pnl -- found 2026-07-28 (Opus
  // Audit #5 + user's own live-firing observation) that the live gate at acd.js's
  // `ibDtaRow.ev_per_trade < -5` check trusts the BLENDED cell EV with no origin filter,
  // the same gap PROMOTE_MIN_REAL_N fixed for the main suppression check on 2026-07-20
  // but never applied here. Confirmed live: IB_BULLISH_TREND fires on blended EV=+$16.3
  // (N=38) while its real (ACTIVE/SHADOW-origin) support is ~0 trades, all UNKNOWN-origin
  // and 3 weeks stale; IB_BEARISH_TURBULENT fires on blended +$72.1 while its real EV is
  // -$10.33 (N=9 real). Persisting real_n/real_ev here so the live gate can require real
  // evidence instead of trusting blended.
  const cells = {};
  for (const r of daytypeRes.rows) {
    const { setup_type, resolution, actual_pnl, origin_status, day_type } = r;
    const win = resolution === 'TARGET_HIT' ? 1 : 0;
    const ck = `${setup_type}|${day_type}`;
    if (!cells[ck]) cells[ck] = { setup_type, day_type, wins: 0, n: 0, pnl_sum: 0, pnl_n: 0, real_pnl_sum: 0, real_pnl_n: 0 };
    cells[ck].wins += win;
    cells[ck].n    += 1;
    if (actual_pnl != null && !isNaN(actual_pnl)) {
      cells[ck].pnl_sum += actual_pnl; cells[ck].pnl_n++;
      if (origin_status === 'ACTIVE' || origin_status === 'SHADOW') {
        cells[ck].real_pnl_sum += actual_pnl; cells[ck].real_pnl_n++;
      }
    }
  }

  const today  = (await query(`SELECT CURRENT_DATE::text as today`)).rows[0].today;
  const counts = { SIZE_UP_STRONG: 0, SIZE_UP: 0, SIZE_DOWN: 0, SUPPRESS: 0, NEUTRAL: 0 };
  let written = 0, tooLong = 0;

  for (const cell of Object.values(cells)) {
    const overall    = overalls[cell.setup_type];
    const overall_wr = overall.n ? overall.wins / overall.n : null;
    if (overall_wr == null) continue;

    const cell_wr = cell.n ? cell.wins / cell.n : null;
    const cell_ev = cell.pnl_n ? cell.pnl_sum / cell.pnl_n : null;
    if (cell_wr == null) continue;

    const divergence = cell_wr - overall_wr;
    // SE under the null hypothesis that cell WR = overall WR
    const se      = Math.sqrt(overall_wr * (1 - overall_wr) / cell.n) || 0.001;
    const z_score = divergence / se;
    // size_delta scales with evidence strength — not a fixed constant
    const size_delta = Math.min(Math.abs(z_score) * SCALE_FACTOR, 0.25);

    let recommendation = 'NEUTRAL';
    if (cell.n >= MIN_N) {
      if      (z_score >=  Z_UP_STRONG && cell_wr >= WR_UP_STRONG) recommendation = 'SIZE_UP_STRONG';
      else if (z_score >=  Z_UP        && cell_wr >= WR_UP)        recommendation = 'SIZE_UP';
      else if (z_score <= -Z_SUPPRESS  && cell_wr <  WR_SUPPRESS)  recommendation = 'SUPPRESS';
      else if (z_score <= -Z_DOWN)                                  recommendation = 'SIZE_DOWN';
    }
    counts[recommendation]++;

    const signal_name = `${cell.setup_type}_${cell.day_type}`;
    if (signal_name.length > 60) { tooLong++; console.warn(`  Signal name too long: ${signal_name}`); continue; }

    const notes = JSON.stringify({
      day_type:   cell.day_type,
      overall_wr: Math.round(overall_wr * 1000) / 1000,
      divergence: Math.round(divergence * 1000) / 1000,
      se:         Math.round(se * 1000)          / 1000,
      z_score:    Math.round(z_score * 100)      / 100,
      size_delta: Math.round(size_delta * 100)   / 100,
      real_n:     cell.real_pnl_n,
      real_ev:    cell.real_pnl_n ? Math.round((cell.real_pnl_sum / cell.real_pnl_n) * 100) / 100 : null,
    });

    await query(`
      INSERT INTO performance_audit
        (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, recommendation, notes)
      VALUES ($1, 9999, 'DAY_TYPE_ALPHA', $2, $3, $4, $5, $6, $7)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
        sample_size    = EXCLUDED.sample_size,
        win_rate       = EXCLUDED.win_rate,
        ev_per_trade   = EXCLUDED.ev_per_trade,
        recommendation = EXCLUDED.recommendation,
        notes          = EXCLUDED.notes,
        created_at     = now()
    `, [today, signal_name, cell.n, cell_wr, cell_ev, recommendation, notes]);
    written++;
  }

  console.log(`\nWrote ${written} rows. (${tooLong} skipped — signal_name too long)`);
  console.log('Classification counts:', counts);

  // Print actionable findings (N≥20, non-NEUTRAL)
  const actionable = Object.values(cells)
    .map(c => {
      const overall    = overalls[c.setup_type];
      const overall_wr = overall.wins / overall.n;
      const cell_wr    = c.wins / c.n;
      const divergence = cell_wr - overall_wr;
      const se         = Math.sqrt(overall_wr * (1 - overall_wr) / c.n) || 0.001;
      const z_score    = divergence / se;
      const size_delta = Math.min(Math.abs(z_score) * SCALE_FACTOR, 0.25);
      let rec = 'NEUTRAL';
      if (c.n >= MIN_N) {
        if      (z_score >=  Z_UP_STRONG && cell_wr >= WR_UP_STRONG) rec = 'SIZE_UP_STRONG';
        else if (z_score >=  Z_UP        && cell_wr >= WR_UP)        rec = 'SIZE_UP';
        else if (z_score <= -Z_SUPPRESS  && cell_wr <  WR_SUPPRESS)  rec = 'SUPPRESS';
        else if (z_score <= -Z_DOWN)                                  rec = 'SIZE_DOWN';
      }
      return { setup_type: c.setup_type, day_type: c.day_type, n: c.n,
        wr:         Math.round(cell_wr    * 1000) / 1000,
        overall_wr: Math.round(overall_wr * 1000) / 1000,
        z:          Math.round(z_score    * 10)   / 10,
        size_delta: Math.round(size_delta * 100)  / 100,
        rec };
    })
    .filter(r => r.n >= MIN_N && r.rec !== 'NEUTRAL')
    .sort((a, b) => {
      const rank = { SIZE_UP_STRONG: 0, SIZE_UP: 1, SIZE_DOWN: 2, SUPPRESS: 3 };
      return (rank[a.rec] ?? 4) - (rank[b.rec] ?? 4);
    });

  if (actionable.length) {
    console.log('\nActionable (N≥20, non-NEUTRAL):');
    const h = ['setup_type', 'day_type', 'N', 'WR', 'base_wr', 'z', 'rec', 'delta'];
    console.log(h[0].padEnd(35) + h[1].padEnd(12) + h[2].padEnd(5) + h[3].padEnd(7) + h[4].padEnd(9) + h[5].padEnd(6) + h[6].padEnd(18) + h[7]);
    for (const r of actionable) {
      console.log(
        r.setup_type.padEnd(35)  + r.day_type.padEnd(12) +
        String(r.n).padEnd(5)    + String(r.wr).padEnd(7) +
        String(r.overall_wr).padEnd(9) + String(r.z).padEnd(6) +
        r.rec.padEnd(18)         + r.size_delta
      );
    }
  } else {
    console.log('\nNo actionable findings — all NEUTRAL or N<20.');
  }

  process.exit(0);
}

run().catch(err => { console.error('FATAL:', err); process.exit(1); });
