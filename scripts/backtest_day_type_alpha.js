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
//   SIZE_DOWN      : (WR-vs-blend z ≤ -1.5) OR (real breakeven/EV trigger, see below)
//   SUPPRESS       : (WR-vs-blend z ≤ -2.0 AND WR < 0.55) OR (real breakeven/EV trigger, strong)
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
//
// EXTENDED AGAIN 2026-08-19 (dta_population_query_excludes_4_live_nonfade_types): the same
// FADE-name/IB-allowlist gap also excluded 4 more live setup_types whose names don't contain
// "FADE" and aren't IB_BULLISH/IB_BEARISH: GLOBEX_VWAP_MAGNET_LONG, GLOBEX_VWAP_MAGNET_SHORT,
// MOMENTUM_60m_60m_TREND, STOP_SWEEP_LONG. Same low-risk fix -- extends the IN-list, only
// populates performance_audit, no live behavior change by itself.
//
// EXTENDED AGAIN 2026-09-13 (daytype_alpha_wr_only_gate_blind_to_ev_20260913, DeepSeek
// deepseek-v4-pro design critique + real-data dry-run validation, see scratch/
// validate_daytype_breakeven_trigger.mjs and scratch/backtest_day_type_alpha_v2_dryrun.mjs):
// the down-side recommendation used to be driven ENTIRELY by a win-rate-divergence z-score
// against the setup_type's own BLENDED (including synthetic BACKFILL) average -- structurally
// blind to EV, and gated on blended sample_size/ev_per_trade rather than the real_n/real_ev
// this file already computed and stored in `notes` but never read back for the recommendation
// itself (the same gap the 2026-07-28/08-12 IB-specific real_n fixes closed, never extended
// roster-wide). Two NEW down-side-only triggers now run alongside the existing WR-vs-blend
// test, both real-data-gated (REAL_N_FLOOR=20, matching this codebase's own N>=20 rule -- NOT
// the looser floor=5 the up-side IB gate at acd.js uses, that asymmetry is deliberate and
// preserved untouched):
//   1. Breakeven-win-rate test: is the cell's REAL win rate below the setup's own economic
//      breakeven (from OPTIMAL_STOP's real calibrated stop/target: breakeven_wr =
//      (stop_pts+1)/(stop_pts+target_pts), "+1" = the $2 round-trip commission in point-
//      equivalents at MNQ's $2/pt)? This is the RIGHT null for "should this regime fire at
//      all" -- the old divergence-vs-blend null can flag a cell that's still profitable just
//      because it's below its own setup's average, and can MISS a cell that's genuinely
//      losing money if its win rate happens to sit close to the blend.
//   2. Day-blocked-bootstrap real EV vs the existing -$5 absolute floor (SETUP_STATUS/IB
//      precedent, not a new number) -- catches what the two-point breakeven model can't (mark-
//      to-market tails, real trades not cleanly resolving at exactly the calibrated stop/
//      target). Found live to matter: real validation showed the breakeven test alone would
//      have MISSED at least one case where real WR sat above breakeven yet real EV was still
//      bad on the available (thin) real sample -- these two triggers are CO-PRIMARY, not
//      primary+catch-all, on purpose.
// Real-data dry-run against the full live roster (2026-09-13) found exactly 2 cells currently
// clear every bar (GLOBEX_VWAP_FADE_SHORT-BALANCE, GLOBEX_VWAP_FADE_LONG-BALANCE) -- most of
// the roster's real per-day-type data is currently too day-clustered to trust regardless of
// which test is used (computeRigor().clustered=true even at real N=50-170 for most cells).
// Clustering is computed and stored in `notes` for visibility but DELIBERATELY NOT used as a
// hard gate here -- rigorDiagnostics.js's own header says computeRigor() must never feed an
// ACTIVE/SUPPRESS decision automatically except via one existing deliberate exception
// (SETUP_STATUS_DOW); extending that to a second pipeline needs the same kind of explicit,
// documented sign-off, not a silent third instance. See OPEN_DECISION
// daytype_alpha_realdata_breakeven_fix_pending_review for that still-open call.
// Up-side (SIZE_UP/SIZE_UP_STRONG) logic is UNTOUCHED -- this extension is down-side only, by
// design, matching the existing real-N-floor asymmetry (acd.js's REAL_N_FLOOR=5 IB gate: "a
// thin-real SUPPRESS/SIZE_DOWN is still the conservative call," an upside-only hazard).
// =============================================================================

import { query } from '../server/db.js';
import { computeRigor, breakevenWr, dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';

const MIN_N          = 20;    // CLAUDE.md N≥20 rule — below this, always NEUTRAL
const SCALE_FACTOR   = 0.07;  // size_delta per σ of divergence; at z=2→0.14, z=3→0.21, cap 0.25
const Z_UP_STRONG    = 2.0;
const Z_UP           = 1.5;
const Z_DOWN         = 1.5;
const Z_SUPPRESS     = 2.0;
const WR_UP_STRONG   = 0.75;
const WR_UP          = 0.65;
const WR_SUPPRESS    = 0.55;
const REAL_N_FLOOR   = 20;    // NEW down-side triggers' own real-data floor (standard N>=20)
const EV_FLOOR       = -5;    // matches SETUP_STATUS/IB precedent, not a new number

// breakevenWr/hashSeed/mulberry32/dayBlockedBootstrapCI moved to rigorDiagnostics.js
// 2026-09-13 (this script's own second consumer, scripts/calibrate_momentum_ctx_sizing.mjs,
// needed the identical breakeven/seeded-bootstrap logic -- extracted rather than copy-pasted
// a second time, matching this codebase's own "share modules" convention).

const SEVERITY = { SUPPRESS: 3, SIZE_DOWN: 2, NEUTRAL: 1 };

async function run() {
  console.log('DAY_TYPE_ALPHA backtest starting…');

  const optRes = await query(`SELECT DISTINCT ON (signal_name) signal_name, optimal_stop, optimal_target FROM performance_audit WHERE signal_type='OPTIMAL_STOP' ORDER BY signal_name, run_date DESC`);
  const optByType = new Map(optRes.rows.map(r => [r.signal_name, { stop: Number(r.optimal_stop), target: Number(r.optimal_target) }]));

  // Two separate queries — critical for correct z_score computation:
  // overall uses ALL resolved trades (the true baseline expectation for each setup_type);
  // cells uses only day-typed trades (to measure day_type-specific performance).
  // Using the same set for both compresses divergences when most trades have a day_type.
  const [overallRes, daytypeRes] = await Promise.all([
    query(`
      SELECT setup_type, resolution, actual_pnl::float
      FROM active_setups
      WHERE (setup_type LIKE '%FADE%' OR setup_type IN ('IB_BULLISH', 'IB_BEARISH',
        'GLOBEX_VWAP_MAGNET_LONG', 'GLOBEX_VWAP_MAGNET_SHORT', 'MOMENTUM_60m_60m_TREND', 'STOP_SWEEP_LONG'))
        AND status = 'RESOLVED'
    `),
    query(`
      SELECT a.setup_type, a.resolution, a.actual_pnl::float, a.origin_status, a.trade_date::text as trade_date, d.day_type
      FROM active_setups a
      JOIN acd_daily_log d ON a.trade_date = d.trade_date
      WHERE (a.setup_type LIKE '%FADE%' OR a.setup_type IN ('IB_BULLISH', 'IB_BEARISH',
        'GLOBEX_VWAP_MAGNET_LONG', 'GLOBEX_VWAP_MAGNET_SHORT', 'MOMENTUM_60m_60m_TREND', 'STOP_SWEEP_LONG'))
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

  // Build cells from day-typed trades. Tracks real_n/real_pnl/real_wins (origin_status IN
  // ('ACTIVE','SHADOW') only) ALONGSIDE the blended n/pnl -- found 2026-07-28 (Opus Audit #5)
  // that the live gate at acd.js's `ibDtaRow.ev_per_trade < -5` check trusts the BLENDED cell
  // EV with no origin filter. real_events (2026-09-13) keeps the raw per-trade {date, pnl}
  // array for real trades only -- needed for the day-blocked bootstrap below; the blended
  // accumulators stay aggregate-only since the existing WR-vs-blend test doesn't need raw data.
  const cells = {};
  for (const r of daytypeRes.rows) {
    const { setup_type, resolution, actual_pnl, origin_status, trade_date, day_type } = r;
    const win = resolution === 'TARGET_HIT' ? 1 : 0;
    const ck = `${setup_type}|${day_type}`;
    if (!cells[ck]) cells[ck] = { setup_type, day_type, wins: 0, n: 0, pnl_sum: 0, pnl_n: 0, real_pnl_sum: 0, real_pnl_n: 0, real_wins: 0, real_events: [] };
    cells[ck].wins += win;
    cells[ck].n    += 1;
    const isReal = origin_status === 'ACTIVE' || origin_status === 'SHADOW';
    if (actual_pnl != null && !isNaN(actual_pnl)) {
      cells[ck].pnl_sum += actual_pnl; cells[ck].pnl_n++;
      if (isReal) {
        cells[ck].real_pnl_sum += actual_pnl; cells[ck].real_pnl_n++;
        // PnL-based "win" (actual_pnl > 0), NOT resolution==='TARGET_HIT' -- DeepSeek code
        // review, 2026-09-13: the resolution-based `win` above misclassifies TRAIL_EXIT/
        // TIME_EXPIRED exits with positive PnL as losses, which would have spuriously flagged
        // the roster's 6 _TRAIL variants (all resolve via TRAIL_EXIT) as breakeven-failures
        // regardless of their real (positive) EV. Only used by the NEW breakeven test below --
        // the OLD blended `wins`/`cell_wr` above is untouched, matching its pre-existing
        // resolution-based convention.
        if (actual_pnl > 0) cells[ck].real_wins++;
        cells[ck].real_events.push({ date: trade_date, pnl: actual_pnl });
      }
    }
  }

  const today  = (await query(`SELECT CURRENT_DATE::text as today`)).rows[0].today;
  const counts = { SIZE_UP_STRONG: 0, SIZE_UP: 0, SIZE_DOWN: 0, SUPPRESS: 0, NEUTRAL: 0 };
  let written = 0, tooLong = 0;
  const actionable = []; // collected inline below, printed at the end -- avoids recomputing everything a second time

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
    let size_delta = Math.min(Math.abs(z_score) * SCALE_FACTOR, 0.25);

    // Up-side: UNCHANGED, blended WR-vs-blend only.
    let recommendation = 'NEUTRAL';
    if (cell.n >= MIN_N) {
      if      (z_score >=  Z_UP_STRONG && cell_wr >= WR_UP_STRONG) recommendation = 'SIZE_UP_STRONG';
      else if (z_score >=  Z_UP        && cell_wr >= WR_UP)        recommendation = 'SIZE_UP';
      else if (z_score <= -Z_SUPPRESS  && cell_wr <  WR_SUPPRESS)  recommendation = 'SUPPRESS';
      else if (z_score <= -Z_DOWN)                                  recommendation = 'SIZE_DOWN';
    }

    const signal_name = `${cell.setup_type}_${cell.day_type}`;

    // Clustering computed BEFORE the breakeven test so its SE can use an effective N --
    // DeepSeek code review, 2026-09-13: a naive one-proportion SE on raw real_n treats every
    // trade as independent, but this codebase's own dry-run found day-clustering is rampant
    // (clustered=true even at real N=50-170) -- effective sample size is closer to the number
    // of DISTINCT DAYS, not raw trade count, so using raw realN understates SE and inflates
    // |z_breakeven|, over-firing on exactly the clustered cells that dominate the roster.
    // Still informational-only as a GATE (rigor.clustered is never used to force NEUTRAL, see
    // file header) -- this only feeds the statistic's own effective-N, a correctness fix, not
    // a new policy gate.
    const realN = cell.real_pnl_n;
    const rigor = realN >= 5 ? computeRigor(cell.real_events, { dateField: 'date', pnlFn: e => e.pnl }) : null;

    // Down-side, NEW (2026-09-13): breakeven-WR + real-EV-bootstrap, co-primary, real-data-
    // gated. Only evaluated when real_pnl_n clears REAL_N_FLOOR -- a thin-real down-flag is
    // still the conservative call (matches the up-side asymmetry rationale), so no upper floor
    // is needed the way the up-side's REAL_N_FLOOR=5 cross-check protects against false SIZE_UP.
    let breakevenRec = 'NEUTRAL', z_breakeven = null, breakeven_wr = null;
    let evBootstrapRec = 'NEUTRAL', ev_ci = null;
    const realWr = realN ? cell.real_wins / realN : null;
    const realEv = realN ? cell.real_pnl_sum / realN : null;
    if (realN >= REAL_N_FLOOR) {
      const opt = optByType.get(cell.setup_type);
      if (opt && opt.stop && opt.target) {
        breakeven_wr = breakevenWr(opt.stop, opt.target);
        const effectiveN = Math.max(rigor?.distinctDates ?? realN, 5); // floor at 5 to avoid a degenerate SE on a near-single-day cell
        const se_bk = Math.sqrt(breakeven_wr * (1 - breakeven_wr) / effectiveN) || 0.001;
        z_breakeven = (realWr - breakeven_wr) / se_bk;
        if (z_breakeven <= -Z_SUPPRESS) breakevenRec = 'SUPPRESS';
        else if (z_breakeven <= -Z_DOWN) breakevenRec = 'SIZE_DOWN';
      }
      ev_ci = dayBlockedBootstrapCI(cell.real_events, signal_name);
      if (ev_ci.hi < EV_FLOOR) evBootstrapRec = ev_ci.hi < EV_FLOOR * 2 ? 'SUPPRESS' : 'SIZE_DOWN';
    }

    // Max-severity OR-gate -- DeepSeek code review, 2026-09-13, CRITICAL fix: the original
    // predicate (`SEVERITY[recommendation] === undefined || ...`) was true for SIZE_UP/
    // SIZE_UP_STRONG too (they're not in the SEVERITY map), so every up-side cell got silently
    // re-evaluated and flattened to NEUTRAL (or worse) -- the exact opposite of "up-side never
    // touched." Fixed to the two down-side-only states the new triggers are allowed to escalate.
    // size_delta is now tied to whichever trigger actually determined the final
    // recommendation -- DeepSeek code review, MAJOR fix: previously size_delta stayed
    // WR-vs-blend-z-derived even when breakeven/EV produced the SIZE_DOWN, which is precisely
    // the case where the WR-vs-blend z is near zero (that's why the new triggers exist) --
    // meaning a breakeven/EV-triggered SIZE_DOWN silently subtracted ~$0 live. SUPPRESS is
    // unaffected either way (the live consumer hard-caps mult=0.25 regardless of size_delta).
    if (recommendation === 'NEUTRAL' || recommendation === 'SIZE_DOWN') {
      const candidates = [
        { rec: recommendation, delta: size_delta },
        { rec: breakevenRec, delta: z_breakeven != null ? Math.min(Math.abs(z_breakeven) * SCALE_FACTOR, 0.25) : 0 },
        // EV-bootstrap has no natural z-score -- DeepSeek's own design critique (earlier the
        // same day) recommended a single fixed, economically-motivated reduction rather than
        // inventing a new magnitude formula, since SUPPRESS (the tier that matters most) hard-
        // caps regardless of size_delta.
        { rec: evBootstrapRec, delta: 0.15 },
      ];
      const winner = candidates.reduce((best, c) => (SEVERITY[c.rec] ?? 1) > (SEVERITY[best.rec] ?? 1) ? c : best, candidates[0]);
      recommendation = winner.rec;
      if (recommendation !== 'NEUTRAL') size_delta = winner.delta;
    }
    counts[recommendation]++;
    if (cell.n >= MIN_N && recommendation !== 'NEUTRAL') {
      actionable.push({
        setup_type: cell.setup_type, day_type: cell.day_type, n: cell.n,
        wr: Math.round(cell_wr * 1000) / 1000, overall_wr: Math.round(overall_wr * 1000) / 1000,
        z: Math.round(z_score * 10) / 10, size_delta: Math.round(size_delta * 100) / 100,
        rec: recommendation, realN, realEv: realEv != null ? Math.round(realEv * 100) / 100 : null,
      });
    }

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
      real_wr:    realWr != null ? Math.round(realWr * 1000) / 1000 : null,
      breakeven_wr: breakeven_wr != null ? Math.round(breakeven_wr * 1000) / 1000 : null,
      z_breakeven: z_breakeven != null ? Math.round(z_breakeven * 100) / 100 : null,
      breakeven_rec: breakevenRec,
      ev_bootstrap_ci: ev_ci ? [Math.round(ev_ci.lo * 100) / 100, Math.round(ev_ci.hi * 100) / 100] : null,
      ev_bootstrap_rec: evBootstrapRec,
      rigor_clustered: rigor ? rigor.clustered : null,
      rigor_top5DayPct: rigor ? rigor.top5DayPct : null,
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

  if (actionable.length) {
    actionable.sort((a, b) => {
      const rank = { SIZE_UP_STRONG: 0, SIZE_UP: 1, SIZE_DOWN: 2, SUPPRESS: 3 };
      return (rank[a.rec] ?? 4) - (rank[b.rec] ?? 4);
    });
    console.log('\nActionable (N≥20, non-NEUTRAL):');
    const h = ['setup_type', 'day_type', 'N', 'WR', 'base_wr', 'z', 'rec', 'delta', 'realN', 'realEV'];
    console.log(h[0].padEnd(35) + h[1].padEnd(12) + h[2].padEnd(5) + h[3].padEnd(7) + h[4].padEnd(9) + h[5].padEnd(6) + h[6].padEnd(18) + h[7].padEnd(7) + h[8].padEnd(7) + h[9]);
    for (const r of actionable) {
      console.log(
        r.setup_type.padEnd(35)  + r.day_type.padEnd(12) +
        String(r.n).padEnd(5)    + String(r.wr).padEnd(7) +
        String(r.overall_wr).padEnd(9) + String(r.z).padEnd(6) +
        r.rec.padEnd(18)         + String(r.size_delta).padEnd(7) +
        String(r.realN).padEnd(7) + (r.realEv ?? 'n/a')
      );
    }
  } else {
    console.log('\nNo actionable findings — all NEUTRAL or N<20.');
  }

  process.exit(0);
}

run().catch(err => { console.error('FATAL:', err); process.exit(1); });
