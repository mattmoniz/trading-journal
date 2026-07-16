// =============================================================================
// Session-bias conflict as a level-fade sizeMultiplier factor — does firing a
// mechanical level-fade AGAINST a strongly one-sided PERMISSION_SLIP session read
// actually cost EV, and by how much?
//
// Background: the IB_BULLISH incident (2026-07-14, docs/OPEN_THREADS.md) found a
// mechanical setup fired directly against every session-bias signal on the dashboard.
// A visible-flag-only conflict check (sessionConflictFor, server/routes/acd.js ~line
// 3505) was built the same day for IB_BULLISH/IB_BEARISH only. User decision
// (2026-07-16): extend the same check to the level-fade family, and fold it into
// sizeMultiplier as a real size-down factor -- but only with a backtested sizeDelta,
// not a guessed number. This script produces that number.
//
// Methodology: for every resolved level-fade trade (resolution IN TARGET_HIT/
// STOP_HIT), reconstruct what matchPermissionSlips() would have returned for that
// trade's date (import the real function -- export-not-reimplement, CLAUDE.md hard
// rule) using that date's own acd_daily_log fields, then classify the trade as
// CONFLICT (opposing PERMISSION_SLIP direction >= 65% WR, matching the live
// sessionConflictFor threshold exactly) or NO_CONFLICT. Compare EV between buckets,
// against each setup's OWN baseline (paired, not pooled) so this isn't just
// rediscovering "some setup types are better than others."
//
// IMPORTANT CAVEAT (same convention as DAY_TYPE_ALPHA/backtest_day_type_alpha.js):
// this uses the CURRENT PERMISSION_SLIP calibration (latest run_date) applied
// retroactively across all history, not a walk-forward re-derivation of what
// PERMISSION_SLIP would have said on each historical date. Consistent with how every
// other conditioning factor in this codebase is backtested (NL30 buckets, day-type
// alpha, etc.) -- not true walk-forward, noted explicitly per that precedent.
//
// Run: node scripts/backtest_session_bias_conflict.mjs
// =============================================================================
import { query } from '../server/db.js';
import { matchPermissionSlips } from '../server/services/permissionSlip.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const CONFLICT_MIN_WR = 0.65; // matches sessionConflictFor's live threshold exactly

async function run() {
  console.log('=== Session-bias conflict backtest (level-fade family) ===\n');

  const permSlipRows = await query(`
    SELECT signal_name, sample_size, win_rate::float, recommendation, notes
    FROM performance_audit
    WHERE signal_type = 'PERMISSION_SLIP'
      AND run_date = (SELECT MAX(run_date) FROM performance_audit WHERE signal_type = 'PERMISSION_SLIP')
  `);
  console.log(`PERMISSION_SLIP rows (latest run_date): ${permSlipRows.rows.length}`);
  if (!permSlipRows.rows.length) {
    console.log('No PERMISSION_SLIP data -- cannot backtest. Exiting.');
    process.exit(1);
  }

  // Per-date context needed by matchPermissionSlips: day_type, a_up_fired, a_down_fired,
  // c_up_confirmed, c_down_confirmed, firstHourDir. First 4 are columns on acd_daily_log.
  // firstHourDir is computed live in acd.js from ibBars[0]/ibBars[last] over the 9:30-10:00
  // ET window (30-min, NOT the 60-min IB -- verified against acd.js's own comment at that
  // call site before reproducing here, not assumed).
  const dailyCtxQ = await query(`
    SELECT trade_date::text as d, day_type, a_up_fired, a_down_fired, c_up_confirmed, c_down_confirmed
    FROM acd_daily_log
  `);
  const dailyCtx = new Map(dailyCtxQ.rows.map(r => [r.d, r]));

  const fhQ = await query(`
    SELECT ts::date::text as d,
      (array_agg(open::float ORDER BY ts ASC))[1] as open_px,
      (array_agg(close::float ORDER BY ts DESC))[1] as close_px
    FROM price_bars_primary
    WHERE symbol='NQ' AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 599
    GROUP BY ts::date
  `);
  const firstHourDir = new Map();
  for (const r of fhQ.rows) {
    firstHourDir.set(r.d, r.close_px > r.open_px ? 'UP' : r.close_px < r.open_px ? 'DOWN' : 'FLAT');
  }

  // Cache matchPermissionSlips() result per date (same today-object shape acd.js builds).
  const matchCache = new Map();
  function getMatch(dateStr) {
    if (matchCache.has(dateStr)) return matchCache.get(dateStr);
    const ctx = dailyCtx.get(dateStr);
    const today = {
      dayType: ctx?.day_type ?? null,
      aUpFired: ctx?.a_up_fired ?? false,
      aDownFired: ctx?.a_down_fired ?? false,
      cUpConfirmed: ctx?.c_up_confirmed ?? false,
      cDownConfirmed: ctx?.c_down_confirmed ?? false,
      firstHourDir: firstHourDir.get(dateStr) ?? null,
    };
    const m = matchPermissionSlips(today, permSlipRows.rows);
    matchCache.set(dateStr, m);
    return m;
  }

  // Level-fade population: exclude the IB family (already has its own conflict check
  // wired) and non-FADE families (profile-brief setups aren't in scope of this decision).
  const tradesQ = await query(`
    SELECT setup_type, trade_date::text as trade_date, resolution, actual_pnl::float as pnl, fired_at
    FROM active_setups
    WHERE resolution IN ('TARGET_HIT','STOP_HIT') AND actual_pnl IS NOT NULL
      AND setup_type LIKE '%FADE%'
      AND setup_type NOT LIKE 'IB_MID_SCALP_FADE%'  -- keep true level-fades; IB_BULLISH/BEARISH aren't FADE-named anyway
    ORDER BY setup_type, fired_at ASC
  `);
  console.log(`Level-fade resolved trades: ${tradesQ.rows.length}\n`);

  const conflict = [], noConflict = [];
  let skippedNoMatch = 0;
  for (const t of tradesQ.rows) {
    const dir = inferDirection(t.setup_type);
    if (!dir) { skippedNoMatch++; continue; }
    const m = getMatch(t.trade_date);
    const opposing = dir === 'LONG' ? m.SHORT : m.LONG;
    const isConflict = !!(opposing && opposing.winRate >= CONFLICT_MIN_WR);
    (isConflict ? conflict : noConflict).push(t);
  }

  function bucketStats(arr, label) {
    const n = arr.length;
    const wr = n ? arr.filter(t => t.resolution === 'TARGET_HIT').length / n : null;
    const ev = n ? arr.reduce((s, t) => s + t.pnl, 0) / n : null;
    const rigor = computeRigor(arr, { dateField: 'trade_date', pnlFn: t => t.pnl });
    console.log(`${label}: N=${n}  WR=${wr != null ? (wr * 100).toFixed(1) + '%' : '--'}  EV=$${ev != null ? ev.toFixed(2) : '--'}`);
    if (n >= 5) console.log(`  rigor: top5DayPct=${rigor.top5DayPct?.toFixed(1)}%  stable=${rigor.stable}  thirds=${JSON.stringify(rigor.thirds)}`);
    return { n, wr, ev, rigor };
  }

  console.log(`(skipped ${skippedNoMatch} rows with no inferrable direction)\n`);
  const cStats = bucketStats(conflict, 'CONFLICT (fired against >=65% WR opposing session read)');
  const ncStats = bucketStats(noConflict, 'NO_CONFLICT (everything else)');

  console.log(`\nN>=20 floor: CONFLICT ${cStats.n >= 20 ? 'CLEARS' : 'DOES NOT CLEAR'} (N=${cStats.n})`);

  if (cStats.n < 20) {
    console.log('\nCannot derive a live sizeDelta -- CONFLICT bucket is below the N>=20 hard floor.');
    console.log('NOT wiring this into sizeMultiplier. Recording as a PROVISIONAL/thin RESEARCH_CLAIM instead.');
  } else {
    const delta = ncStats.ev - cStats.ev;
    console.log(`\nEV delta (NO_CONFLICT - CONFLICT): $${delta.toFixed(2)}/trade`);
    console.log(cStats.ev < ncStats.ev
      ? 'Direction confirms the hypothesis: firing against a strong session read costs EV.'
      : 'Direction does NOT confirm the hypothesis -- conflict bucket is not worse. Do not wire in a penalty.');
  }

  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
