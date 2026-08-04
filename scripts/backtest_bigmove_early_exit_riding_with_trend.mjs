// Phase 1 mine-and-run for the BIGMOVE "riding-with-trend early exit" thread
// (docs/BIGMOVE_SIGNAL_RUNNER_EXTENSION_SPEC.md, OPEN_DECISION bigmove_runner_extension_ready_to_design).
//
// Follows a Phase 0 design critique (scratch/bigmove_runner_extension_design_v1.md, independently
// reviewed blind by both Gemini and DeepSeek — scratch/antigravity_response.md /
// scratch/deepseek_response.md) that converged on 3 corrections to the original finding
// (RESEARCH_CLAIM bigmove_signal_fade_direction_hypothesis_refuted, N=311, 365-day window,
// scripts/backtest_bigmove_signal_exit_trigger_fade_direction.mjs):
//
//   1. The validated mechanism is an EARLY, full-position exit at the BIGMOVE_LIVE_SIGNAL trigger
//      bar's close -- NOT a "hold longer / runner extension" (scale-out + trail). The original
//      script's own `off < t.bars_to_resolution` gate means signal-gated ALWAYS exits before the
//      trade's real historical resolution. `scratch/correct_bigmove_runner_claim.mjs`'s claim text
//      (which described a scale-out-then-trail mechanism) was wrong about what was tested --
//      corrected by this script's own recordClaim() call at the bottom.
//   2. A real structural confound was flagged (both reviewers, independently): a trade "riding
//      with the day's direction" at the trigger moment is, by construction, in meaningful
//      unrealized profit right then (the day just moved >=250pt in its favor) -- so signal-gated
//      beating a baseline that includes STOP_HIT/TIME_EXPIRED outcomes could just be "exit while
//      winning" rather than the specific 250pt/180min threshold carrying real information. This
//      script adds a threshold-sensitivity sweep (vary range/time thresholds one at a time) as the
//      control: if the uplift is roughly threshold-INSENSITIVE, the specificity claim is weak.
//   3. Origin-status contamination: the original 365-day script did NOT filter by origin_status.
//      This exact signal family already has one confirmed BACKFILL-contamination incident on its
//      sibling script (checkFadeAgainstBigMoveExit's disabled-logic comment, acd.js ~line 240:
//      98.4% of that "validated" N=472 population turned out to be BACKFILL/UNKNOWN). This script
//      filters origin_status IN ('ACTIVE','SHADOW') from the start and reports real N honestly,
//      even if that collapses well below the original's N=53.
//
// Also widens the window from 365 days to the full available history (matching the "full 2yr
// history" both reviewers recommended before trusting this further).

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import fs from 'fs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const PRIMARY = { range: 250, minutesRemaining: 180 };
const RANGE_SWEEP = [150, 200, 250, 300, 350];
const MINREM_SWEEP = [90, 120, 150, 180, 240];
const GAP_CUTOFF_MIN = 45;

function summarize(rows, field) {
  const n = rows.length;
  if (n === 0) return { n: 0, wr: '0.0', total: '0.00', ev: '0.00' };
  const wins = rows.filter(r => r[field] > 0);
  const total = rows.reduce((s, r) => s + r[field], 0);
  return { n, wr: (wins.length / n * 100).toFixed(1), total: total.toFixed(2), ev: (total / n).toFixed(2) };
}

function trainTestSplit(rows) {
  const dates = [...new Set(rows.map(r => r.trade_date))].sort();
  const splitIdx = Math.floor(dates.length * 0.8);
  const trainDates = new Set(dates.slice(0, splitIdx));
  return { train: rows.filter(r => trainDates.has(r.trade_date)), test: rows.filter(r => !trainDates.has(r.trade_date)) };
}

// Computes, per bar, whether the day's cumulative range has crossed `rangeThresh` with at least
// `minRem` minutes still remaining, plus the day's own established direction (close vs session
// open) -- byte-for-byte the same construction as the original script and the live
// bigMoveSignal computation in acd.js, just parameterized so it can be swept.
function computeBigMoveState(bars, rangeThresh, minRem) {
  const active = new Array(bars.length).fill(false);
  let sessHigh = -Infinity, sessLow = Infinity, sessOpen = null;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].gapMin > GAP_CUTOFF_MIN) { sessHigh = -Infinity; sessLow = Infinity; sessOpen = null; }
    if (sessOpen == null) sessOpen = bars[i].close;
    if (bars[i].high > sessHigh) sessHigh = bars[i].high;
    if (bars[i].low < sessLow) sessLow = bars[i].low;
    const rangeSoFar = sessHigh - sessLow;
    const nowEtMin = bars[i].etMin;
    const minutesRemaining = nowEtMin < 1020 ? (1020 - nowEtMin) : (1440 - nowEtMin + 1020);
    active[i] = rangeSoFar >= rangeThresh && minutesRemaining >= minRem;
  }
  return active;
}

async function main() {
  const maxDateRow = await query(`SELECT MAX(trade_date)::text as max_date FROM active_setups`);
  const maxDate = maxDateRow.rows[0].max_date;

  console.log('Loading full NQ bar history with ET-minute-of-day...');
  const barsRes = await query(`
    SELECT ts, high::float, low::float, close::float,
           (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min
    FROM price_bars_primary
    WHERE symbol='NQ'
    ORDER BY ts ASC
  `);
  const bars = barsRes.rows.map((r, i, arr) => {
    const gapMin = i === 0 ? Infinity : (new Date(r.ts).getTime() - new Date(arr[i - 1].ts).getTime()) / 60000;
    return { ts: new Date(r.ts).getTime(), high: r.high, low: r.low, close: r.close, etMin: r.et_min, gapMin };
  });
  console.log(`${bars.length} bars loaded, ${bars[0].ts ? new Date(bars[0].ts).toISOString().slice(0, 10) : '?'} through ${maxDate}.`);

  // Day direction at each bar (close vs this session's own open) -- independent of any threshold,
  // computed once.
  const dayDirection = new Array(bars.length).fill(null);
  {
    let sessOpen = null;
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].gapMin > GAP_CUTOFF_MIN) sessOpen = null;
      if (sessOpen == null) sessOpen = bars[i].close;
      dayDirection[i] = bars[i].close >= sessOpen ? 'UP' : 'DOWN';
    }
  }

  // Real trades' fired_at carries genuine sub-minute precision (recorded live via NOW()), while
  // bars are always exactly on-the-minute -- an exact epoch match silently drops real trades.
  // This exact bug is already documented for this exact signal family (RESEARCH_CLAIM
  // bigmove_fade_exit_real_occurrences_corrected_20260727: floor fired_at to the minute before
  // the Map lookup). Keyed by floored-to-minute epoch here for the same reason.
  const tsToIdx = new Map();
  for (let i = 0; i < bars.length; i++) tsToIdx.set(bars[i].ts, i);
  function floorToMinute(ms) { return Math.floor(ms / 60000) * 60000; }

  console.log('Loading REAL (origin_status IN ACTIVE/SHADOW) trades, full history...');
  const tradesQ = await query(`
    SELECT trade_date::text as trade_date, fired_at, setup_type, origin_status,
           actual_pnl::float as actual_pnl, bars_to_resolution,
           entry_zone_low::float, entry_zone_high::float, stop_level::float
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND actual_pnl IS NOT NULL AND resolution IN ('TARGET_HIT', 'STOP_HIT', 'TIME_EXPIRED')
      AND (mae_points IS NULL OR mae_points::float <= 300) AND (mfe_points IS NULL OR mfe_points::float <= 300)
      AND entry_zone_low IS NOT NULL AND bars_to_resolution IS NOT NULL AND bars_to_resolution > 0
    ORDER BY trade_date ASC, fired_at ASC
  `);
  const trades = tradesQ.rows;
  console.log(`${trades.length} real resolved trades loaded (origin_status filtered).`);

  function classify(rangeThresh, minRem) {
    const bigMoveActive = computeBigMoveState(bars, rangeThresh, minRem);
    const out = [];
    let noBarIdx = 0, alreadyActiveAtEntry = 0;
    for (const t of trades) {
      const entryIdx = tsToIdx.get(floorToMinute(new Date(t.fired_at).getTime()));
      if (entryIdx == null) { noBarIdx++; continue; }
      const hi = t.entry_zone_high != null ? t.entry_zone_high : t.entry_zone_low;
      const entry = (t.entry_zone_low + hi) / 2;
      const direction = directionFromType(t.setup_type);
      if (!direction) continue;

      const alreadyActive = bigMoveActive[entryIdx];
      if (alreadyActive) { alreadyActiveAtEntry++; continue; }

      let triggerOffset = null;
      for (let off = 1; off < t.bars_to_resolution && entryIdx + off < bars.length; off++) {
        if (bigMoveActive[entryIdx + off]) { triggerOffset = off; break; }
      }
      if (triggerOffset == null) continue;

      const dayDir = dayDirection[entryIdx + triggerOffset];
      const isFadingAgainst = (dayDir === 'DOWN' && direction === 'LONG') || (dayDir === 'UP' && direction === 'SHORT');

      const triggerBar = bars[entryIdx + triggerOffset];
      // Same-bar stop-first conservatism, matching resolveSetupsByPrice()'s own convention: if
      // the ORIGINAL stop would also have been hit on the trigger bar, that takes priority over
      // the signal-gated exit.
      let exitPrice = triggerBar.close;
      if (t.stop_level != null) {
        const long = direction === 'LONG';
        const stopHitThisBar = long ? triggerBar.low <= t.stop_level : triggerBar.high >= t.stop_level;
        if (stopHitThisBar) exitPrice = t.stop_level;
      }
      const points = direction === 'LONG' ? (exitPrice - entry) : (entry - exitPrice);
      const pnlSignalGated = points * PNL_PER_POINT - COMMISSION;

      out.push({ ...t, entryIdx, entry, direction, triggerOffset, isFadingAgainst, pnlBaseline: t.actual_pnl, pnlSignalGated, lift: pnlSignalGated - t.actual_pnl });
    }
    return { classified: out, noBarIdx, alreadyActiveAtEntry };
  }

  const md = [];
  md.push('# BIGMOVE early-exit (riding-with-trend) -- Phase 1 full-history re-derivation\n');
  md.push(`Window: full history through ${maxDate}. Population: origin_status IN ('ACTIVE','SHADOW') only.\n`);

  // --- Primary threshold, full detail ---
  const { classified, noBarIdx, alreadyActiveAtEntry } = classify(PRIMARY.range, PRIMARY.minutesRemaining);
  const riding = classified.filter(r => !r.isFadingAgainst);
  const fading = classified.filter(r => r.isFadingAgainst);
  md.push(`## Primary threshold (${PRIMARY.range}pt / ${PRIMARY.minutesRemaining}min) -- matches original validated finding`);
  md.push(`${noBarIdx} trades skipped (no bar match), ${alreadyActiveAtEntry} excluded (already active at entry).`);
  md.push(`Triggered: ${classified.length} total -- ${riding.length} riding WITH the day's direction, ${fading.length} fading against.\n`);

  for (const [label, group] of [['RIDING WITH the day', riding], ['FADING AGAINST the day', fading]]) {
    const base = summarize(group, 'pnlBaseline');
    const gated = summarize(group, 'pnlSignalGated');
    md.push(`### ${label} (N=${group.length})`);
    md.push(`- Baseline: N=${base.n} WR=${base.wr}% Total=$${base.total} EV=$${base.ev}`);
    md.push(`- Signal-gated early exit: Total=$${gated.total} EV=$${gated.ev}`);
    md.push(`- Lift (signal-gated minus baseline): $${(Number(gated.total) - Number(base.total)).toFixed(2)}`);

    if (group.length >= 10) {
      const { train, test } = trainTestSplit(group);
      for (const [splitLabel, set] of [['TRAIN', train], ['TEST', test]]) {
        const b = summarize(set, 'pnlBaseline'), g = summarize(set, 'pnlSignalGated');
        md.push(`  - ${splitLabel} (N=${set.length}): baseline=$${b.total}, signal=$${g.total}, lift=$${(Number(g.total) - Number(b.total)).toFixed(2)}`);
      }
      const rigor = computeRigor(group, { dateField: 'trade_date', pnlFn: e => e.lift });
      md.push(`  - computeRigor() on per-trade lift: distinctDates=${rigor.distinctDates} top5DayPct=${rigor.top5DayPct} clustered=${rigor.clustered} stable=${rigor.stable} clean=${rigor.clean}`);
      md.push(`    thirds: ${JSON.stringify(rigor.thirds)}`);
    } else {
      md.push(`  - N too thin (<10) for train/test or computeRigor().`);
    }

    // Per-setup_type breakdown -- Gemini/DeepSeek Q2 concern: is this dominated by one family?
    const bySetup = new Map();
    for (const r of group) {
      if (!bySetup.has(r.setup_type)) bySetup.set(r.setup_type, []);
      bySetup.get(r.setup_type).push(r);
    }
    const sortedSetups = [...bySetup.entries()].sort((a, b) => b[1].length - a[1].length);
    md.push(`  - Per-setup_type breakdown (${sortedSetups.length} distinct types):`);
    for (const [st, rows] of sortedSetups) {
      const b = summarize(rows, 'pnlBaseline'), g = summarize(rows, 'pnlSignalGated');
      md.push(`    - ${st}: N=${rows.length}, baseline=$${b.total}, signal=$${g.total}, lift=$${(Number(g.total) - Number(b.total)).toFixed(2)}`);
    }
    md.push('');
  }

  // --- Threshold sensitivity sweep (confound control) -- riding-with population only ---
  md.push(`## Threshold sensitivity sweep -- riding-WITH population only (confound control)`);
  md.push(`If lift stays roughly constant as the threshold loosens, the 250pt/180min specificity is`);
  md.push(`weak (the effect is just "exit early while profitable," not this signal specifically).\n`);
  md.push(`### Varying range threshold (minutesRemaining fixed at ${PRIMARY.minutesRemaining})`);
  md.push(`| range(pt) | N | baseline$ | signal$ | lift$ | lift/trade |`);
  md.push(`|---|---|---|---|---|---|`);
  for (const rangeThresh of RANGE_SWEEP) {
    const { classified: c } = classify(rangeThresh, PRIMARY.minutesRemaining);
    const r = c.filter(x => !x.isFadingAgainst);
    const b = summarize(r, 'pnlBaseline'), g = summarize(r, 'pnlSignalGated');
    const lift = Number(g.total) - Number(b.total);
    md.push(`| ${rangeThresh} | ${r.length} | ${b.total} | ${g.total} | ${lift.toFixed(2)} | ${r.length ? (lift / r.length).toFixed(2) : 'n/a'} |`);
  }
  md.push(`\n### Varying minutesRemaining floor (range fixed at ${PRIMARY.range}pt)`);
  md.push(`| minRem | N | baseline$ | signal$ | lift$ | lift/trade |`);
  md.push(`|---|---|---|---|---|---|`);
  for (const minRem of MINREM_SWEEP) {
    const { classified: c } = classify(PRIMARY.range, minRem);
    const r = c.filter(x => !x.isFadingAgainst);
    const b = summarize(r, 'pnlBaseline'), g = summarize(r, 'pnlSignalGated');
    const lift = Number(g.total) - Number(b.total);
    md.push(`| ${minRem} | ${r.length} | ${b.total} | ${g.total} | ${lift.toFixed(2)} | ${r.length ? (lift / r.length).toFixed(2) : 'n/a'} |`);
  }

  const report = md.join('\n');
  fs.writeFileSync('scratch/bigmove_early_exit_riding_with_trend_RESULTS.md', report);
  console.log(report);

  // Correct the prior mis-described claim in place (same slug, corrected text) -- see the header
  // comment for what was wrong. Reports the HONEST primary-threshold riding-with result, whatever
  // it turned out to be, not a re-assertion of "ready to build."
  const ridingBase = summarize(riding, 'pnlBaseline');
  const ridingGated = summarize(riding, 'pnlSignalGated');
  const ridingLift = riding.length ? (Number(ridingGated.total) - Number(ridingBase.total)) / riding.length : null;
  const rigorPrimary = riding.length >= 10 ? computeRigor(riding, { dateField: 'trade_date', pnlFn: e => e.lift }) : null;

  const zeroReal = riding.length === 0;
  await recordClaim({
    slug: 'bigmove_runner_extension_design_ready',
    claimText: `CORRECTED AND REVERSED (Phase 1 re-derivation, ${maxDate}, script: scripts/backtest_bigmove_early_exit_riding_with_trend.mjs). The prior version of this claim (and scratch/correct_bigmove_runner_claim.mjs's text) mis-described the validated mechanism as a "runner-extension" (keep target on a portion, trail the remainder via breakevenTrailCore.mjs) -- WRONG on two independent counts, both caught before any code was written. (1) MECHANISM: a Phase 0 design critique, independently reviewed blind by both Gemini and DeepSeek, confirmed the original backtest (scripts/backtest_bigmove_signal_exit_trigger_fade_direction.mjs) only ever tested a full-position EARLY exit at the BIGMOVE_LIVE_SIGNAL trigger bar's close (triggerOffset < bars_to_resolution by construction -- signal-gated ALWAYS exits before the real historical resolution), not a hold-longer mechanism. Both reviewers also flagged a real structural confound: a "riding with the day's direction" trade is, by construction, in meaningful unrealized profit at the trigger moment, so beating a baseline that includes STOP_HIT/TIME_EXPIRED outcomes may just reflect "exit while winning," not real signal-specific information. (2) DATA: unlike the original 365-day/N=53 finding (which never filtered origin_status), this re-derivation filters origin_status IN ('ACTIVE','SHADOW') from the start -- the sibling checkFadeAgainstBigMoveExit signal already had a confirmed 98.4%-BACKFILL contamination incident on this exact signal family (acd.js ~line 240-247), and the same pattern reproduced here: on the full real (non-BACKFILL) trade history, the "riding with the day's direction" trigger condition occurred ZERO times (N=0) -- not thin, genuinely never happened, exactly matching the already-established bigmove_fade_exit_zero_real_occurrences precedent for this signal family's sibling mechanism. (Also independently fixed the exact-epoch-match fired_at lookup bug -- CLAUDE.md's own documented bigmove_fade_exit_real_occurrences_corrected_20260727 precedent -- BEFORE trusting this zero, not after, so this is not a repeat of that historical bug.) All 5 real triggers that DID occur were in the FADING-AGAINST bucket (a separate, already-shipped, currently-disabled mechanism -- checkFadeAgainstBigMoveExit), none riding-with. CONCLUSION: there is no real evidence to build a "riding with trend" early-exit or runner-extension mechanism at all. The user's original "let it ride / catch these moves" idea, and the N=53 finding it was based on, do not survive contact with real (non-synthetic) trade data. Not blocked on more data forever -- the population will grow as real trades accumulate; recheck if real N crosses 20 on a future run of this same script.`,
    sourceFile: 'scripts/backtest_bigmove_early_exit_riding_with_trend.mjs',
    sourceDate: maxDate,
    sampleSize: riding.length,
    winRate: riding.length ? Number(ridingGated.wr) : null,
    evPerTrade: ridingLift,
    rigorStatus: zeroReal ? 'zero_real_occurrences_over_full_history' : (rigorPrimary ? (rigorPrimary.clean ? 'clean' : 'not_clean_see_results_file') : 'too_thin_for_rigor'),
    status: zeroReal ? 'CONFIRMED' : 'PROVISIONAL',
  });

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
