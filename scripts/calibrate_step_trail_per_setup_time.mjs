// Per-(setup_type x time-of-day) calibration for the step-trail runner extension. User request
// 2026-09-05: monitor AND calibrate this for every setup, so a real lead gets picked up
// automatically as data grows rather than needing another one-off backtest each time someone
// asks. Self-recalibrating (weekly, run_weekly_backtests.sh) -- NOT wired to gate/size any real
// trade yet (matches the overall step-trail mechanism's own Phase 1 SHADOW-only posture, see
// OPEN_DECISION step_trail_phase2_promotion_pending). This script produces the calibration TABLE
// that a future Phase 2 (per-cell precision, once the whole mechanism clears its own N>=20 real
// bar) would read from -- building it now as a persisted, queryable table (not a chat report) is
// what lets it carry forward into live wiring later, per this codebase's own "no dead ends" rule.
//
// Reuses the EXACT same Arm A (plain bank-at-T1) / Arm B (pressure-gated extend to 1.5x, then
// step-trail) simulation as scratch/step1_ratchet_v3.mjs (the DeepSeek-reviewed script Opus Audit
// #12's numbers came from) -- never reimplemented, per "export the real function."
//
// GATE criteria per cell, matching this session's own established pattern (backtest_
// direction_alternation_after_loss.mjs / backtest_same_setup_refire_gate.mjs): N>=20 real
// (ACTIVE+SHADOW, BACKFILL excluded -- confirmed unusable for this question, inflates 5-50x),
// mean delta > 0, NOT day-clustered (top5DayPct<=50%), and rigor.clean OR the big-win-excluded
// mean delta >= -$3.00 (Opus Audit #12's own two-way rigor test, since a lottery-shaped payoff
// fails the standard chronological-thirds test by construction). Cells below N=20 are recorded
// as THIN_N, never silently dropped.
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { stepWiderTarget } from '../server/services/widerTargetWalker.js';
import { isPastMechanismSessionEnd } from '../server/services/sessionBoundary.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const PPP = 2, COMM = 2, MAX_WALK_BARS = 1500, FRAC = 0.25, MIN_N = 20;
function getPnl(pts) { return pts * PPP - COMM; }

const TIME_BLOCKS = [
  ['0930_1030_open_ib', m => m >= 570 && m < 630],
  ['1030_1200_post_ib', m => m >= 630 && m < 720],
  ['1200_1400_midday', m => m >= 720 && m < 840],
  ['1400_1600_pm', m => m >= 840 && m < 960],
  ['1800_2200_globex_open', m => m >= 1080 && m < 1320],
  ['2200_0400_overnight', m => m >= 1320 || m < 240],
  ['0400_0830_pre_rth', m => m >= 240 && m < 510],
];
function blockOf(mod) { return TIME_BLOCKS.find(([, f]) => f(mod))?.[0] ?? 'other'; }

async function main() {
  const todayR = await query(`SELECT CURRENT_DATE::text AS today`);
  const today = todayR.rows[0].today;

  const threshRes = await query(`
    SELECT notes FROM performance_audit
    WHERE signal_type='WIDER_TARGET_PRESSURE_GATE' AND signal_name='THRESHOLD'
    ORDER BY run_date DESC LIMIT 1
  `);
  const pressureThreshold = JSON.parse(threshRes.rows[0].notes).threshold;

  const setupsRes = await query(`
    SELECT setup_type, origin_status, trade_date::text as trade_date, fired_at,
      entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
      stop_level::float as stop_level, t1_level::float as t1_level
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL AND fired_at IS NOT NULL
    ORDER BY fired_at ASC
  `);
  const barsRes = await query(`
    SELECT ts, high::float as high, low::float as low, close::float as close,
      bid_volume, ask_volume, (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as mod
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const allBars = barsRes.rows.map(b => ({
    ts: new Date(b.ts).getTime(), high: b.high, low: b.low, close: b.close, mod: b.mod,
    bid_volume: Number(b.bid_volume) || 0, ask_volume: Number(b.ask_volume) || 0,
  }));
  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  let fastTrades = [];
  for (const t of setupsRes.rows) {
    const dir = inferDirection(t.setup_type);
    if (dir === null) continue;
    const long = dir === 'LONG';
    const entry = t.entry_zone_high ?? t.entry_zone_low;
    const stop = t.stop_level, t1 = t.t1_level;
    const firedTs = new Date(t.fired_at).getTime();
    const startIdx = firstIndexAfter(firedTs);
    if (startIdx >= allBars.length) continue;
    let t1Idx = null, barCount = 1;
    for (let i = startIdx; i < Math.min(allBars.length, startIdx + MAX_WALK_BARS); i++) {
      const bar = allBars[i];
      const t1Hit = long ? bar.high >= t1 : bar.low <= t1;
      const stopHit = long ? bar.low <= stop : bar.high >= stop;
      if (stopHit) break;
      if (t1Hit) { t1Idx = i; break; }
      barCount++;
    }
    if (t1Idx === null || barCount > 4) continue;
    fastTrades.push({
      setup_type: t.setup_type, origin_status: t.origin_status, trade_date: t.trade_date,
      long, entry, stop, t1, startIdx, t1Idx, firedMod: allBars[startIdx].mod,
      timeBlock: blockOf(allBars[startIdx].mod),
    });
  }
  fastTrades.sort((a, b) => new Date(a.fired_at) - new Date(b.fired_at));
  const trainT1Dists = fastTrades.slice(0, Math.floor(fastTrades.length / 2)).map(t => Math.abs(t.t1 - t.entry)).sort((a, b) => a - b);
  const p10BaseFloor = trainT1Dists[Math.floor((trainT1Dists.length - 1) * 0.10)] * 1.5;
  console.log(`N=${fastTrades.length} fast-T1 real trades`);

  function pressureReadingAt(t, idx) {
    const bar = allBars[idx];
    const totalVol = bar.bid_volume + bar.ask_volume;
    if (totalVol <= 0) return null;
    return ((t.long ? bar.ask_volume : bar.bid_volume) - (t.long ? bar.bid_volume : bar.ask_volume)) / totalVol;
  }
  function runArmA(t) {
    const flatWider = t.entry + (t.long ? 1 : -1) * 1.5 * Math.abs(t.t1 - t.entry);
    const pressureReading = pressureReadingAt(t, t.t1Idx);
    let state = { widening: false }, res = null, bCount = 1;
    for (let i = t.startIdx; i < Math.min(allBars.length, t.startIdx + MAX_WALK_BARS); i++) {
      const bar = allBars[i];
      const r = stepWiderTarget(state, bar, { entry: t.entry, stop: t.stop, t1: t.t1, widerTarget: flatWider, long: t.long, barCount: bCount, maxBarsToT1: 4, firedMod: t.firedMod, pressureReading, pressureThreshold });
      state = r.state;
      if (r.resolution) { res = r.resolution; break; }
      bCount++;
    }
    if (!res) res = { priceAtRes: allBars[Math.min(allBars.length - 1, t.startIdx + MAX_WALK_BARS) - 1].close };
    const pts = t.long ? res.priceAtRes - t.entry : t.entry - res.priceAtRes;
    return { pnl: getPnl(pts) };
  }
  function runArmB(t, frac) {
    const flatWider = t.entry + (t.long ? 1 : -1) * 1.5 * Math.abs(t.t1 - t.entry);
    const stepSize = frac * Math.max(Math.abs(flatWider - t.entry), p10BaseFloor);
    const pressureReading = pressureReadingAt(t, t.t1Idx);
    const pressureGateOk = pressureReading != null && pressureReading >= pressureThreshold;
    let state = { widening: false, ratcheting: false, currentStop: t.stop, highestMfe: null };
    let bCount = 1, exitPrice = null;
    for (let i = t.startIdx; i < Math.min(allBars.length, t.startIdx + MAX_WALK_BARS); i++) {
      const bar = allBars[i];
      const isSessionEnd = isPastMechanismSessionEnd(bar.mod, t.firedMod);
      if (!state.widening && !state.ratcheting) {
        const t1Hit = t.long ? bar.high >= t.t1 : bar.low <= t.t1;
        const stopHit = t.long ? bar.low <= t.stop : bar.high >= t.stop;
        if (stopHit) { exitPrice = t.stop; break; }
        if (t1Hit) {
          if (bCount <= 4 && !isSessionEnd && pressureGateOk) state.widening = true;
          else { exitPrice = t.t1; break; }
        }
        if (!exitPrice && isSessionEnd) { exitPrice = bar.close; break; }
      } else {
        const stopHit = t.long ? bar.low <= state.currentStop : bar.high >= state.currentStop;
        if (stopHit) { exitPrice = state.currentStop; break; }
        if (!state.ratcheting) {
          const widerHit = t.long ? bar.high >= flatWider : bar.low <= flatWider;
          if (widerHit) {
            state.ratcheting = true; state.highestMfe = flatWider;
            const snapped = t.long ? flatWider - stepSize : flatWider + stepSize;
            state.currentStop = t.long ? Math.max(state.currentStop, snapped) : Math.min(state.currentStop, snapped);
          }
        }
        if (state.ratcheting) {
          if (t.long) { if (bar.high >= state.highestMfe + stepSize) { const s = Math.floor((bar.high - state.highestMfe) / stepSize); state.highestMfe += s * stepSize; state.currentStop += s * stepSize; } }
          else { if (bar.low <= state.highestMfe - stepSize) { const s = Math.floor((state.highestMfe - bar.low) / stepSize); state.highestMfe -= s * stepSize; state.currentStop -= s * stepSize; } }
        }
        if (isSessionEnd) { exitPrice = bar.close; break; }
      }
      if (i === Math.min(allBars.length - 1, t.startIdx + MAX_WALK_BARS) - 1) { exitPrice = bar.close; break; }
      bCount++;
    }
    const pts = t.long ? exitPrice - t.entry : t.entry - exitPrice;
    return { pnl: getPnl(pts) };
  }

  const rows = fastTrades.map(t => ({
    setup_type: t.setup_type, timeBlock: t.timeBlock, trade_date: t.trade_date, origin_status: t.origin_status,
    delta: runArmB(t, FRAC).pnl - runArmA(t).pnl,
  }));

  // Group by (setup_type, timeBlock) AND a roster-wide-per-timeBlock "ALL_TYPES" fallback,
  // matching this codebase's own per-type + pooled-fallback convention (e.g. _POOLED_ALL_RTH).
  const cells = {};
  for (const r of rows) {
    const key = `${r.setup_type}__${r.timeBlock}`;
    (cells[key] ??= []).push(r);
    const poolKey = `ALL_TYPES__${r.timeBlock}`;
    (cells[poolKey] ??= []).push(r);
  }

  let gateCount = 0, thinCount = 0, noGateCount = 0;
  const writes = [];
  for (const [key, g] of Object.entries(cells)) {
    const n = g.length;
    if (n < MIN_N) { thinCount++; writes.push({ key, recommendation: 'THIN_N', n }); continue; }
    const meanDelta = g.reduce((s, r) => s + r.delta, 0) / n;
    const rigor = computeRigor(g, { dateField: 'trade_date', pnlFn: r => r.delta });
    const bigWinExcludedDelta = (() => {
      const nonBig = g.filter(r => r.delta < 100);
      return nonBig.length ? nonBig.reduce((s, r) => s + r.delta, 0) / nonBig.length : null;
    })();
    const rigorOk = rigor.clean || (bigWinExcludedDelta != null && bigWinExcludedDelta >= -3.00);
    const notClustered = !rigor.clustered;
    // Real-vs-SHADOW subgroup check (2026-09-05, added after this exact script's first run
    // GATEd a pooled result -- ALL_TYPES__0930_1030_open_ib -- that had already been manually
    // found and retracted the same session: pooled ACTIVE+SHADOW looked clean, but split by
    // origin_status, ACTIVE alone was NEGATIVE and 70%+ day-clustered on N=27, and SHADOW alone
    // failed stability too. Averaging two populations that individually fail can look clean --
    // exactly this session's own "pooled verdict hides opposite-signed subgroups" rule, now
    // enforced mechanically here so it can't recur silently on some other cell. Requires: if
    // ACTIVE-origin N>=10 exists for this cell, its mean delta must be same-signed as the
    // pooled mean (not necessarily positive alone at low N, but not reversed) -- a real
    // ACTIVE-negative/pooled-positive split is disqualifying regardless of what SHADOW alone did.
    const activeRows = g.filter(r => r.origin_status === 'ACTIVE');
    const activeMeanDelta = activeRows.length ? activeRows.reduce((s, r) => s + r.delta, 0) / activeRows.length : null;
    const activeReversalFlag = activeRows.length >= 10 && activeMeanDelta != null && Math.sign(activeMeanDelta) !== Math.sign(meanDelta) && activeMeanDelta !== 0;
    const gate = meanDelta > 0 && rigorOk && notClustered && !activeReversalFlag;
    if (gate) gateCount++; else noGateCount++;
    writes.push({
      key, recommendation: gate ? 'GATE' : 'NO_GATE', n, meanDelta: +meanDelta.toFixed(2),
      distinctDates: rigor.distinctDates, top5DayPct: rigor.top5DayPct, clean: rigor.clean,
      clustered: rigor.clustered, stable: rigor.stable, bigWinExcludedDelta: bigWinExcludedDelta != null ? +bigWinExcludedDelta.toFixed(2) : null,
      activeN: activeRows.length, activeMeanDelta: activeMeanDelta != null ? +activeMeanDelta.toFixed(2) : null, activeReversalFlag,
    });
  }

  console.log(`Cells: GATE=${gateCount} NO_GATE=${noGateCount} THIN_N=${thinCount}`);
  const gated = writes.filter(w => w.recommendation === 'GATE');
  console.log('GATE cells:', gated.map(w => `${w.key} (N=${w.n}, $${w.meanDelta})`).join('; ') || '(none yet)');

  // Persist via performance_audit directly (this project's real store), one row per cell.
  for (const w of writes) {
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, notes)
      VALUES ($1, 0, 'STEP_TRAIL_PER_CELL_CALIB', $2, $3, $4, $5)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
        sample_size = EXCLUDED.sample_size, ev_per_trade = EXCLUDED.ev_per_trade, notes = EXCLUDED.notes
    `, [today, w.key, w.n, w.meanDelta ?? null, JSON.stringify(w)]);
  }

  await recordClaim({
    slug: 'step_trail_per_cell_calibration_20260905',
    claimText: `Per-(setup_type x time-of-day) step-trail calibration, self-recalibrating weekly. Current run: ${gateCount} cells GATE (real, positive, not day-clustered, rigor-clean or big-win-excluded delta>=-$3, AND real-ACTIVE-origin not reversed vs pooled), ${noGateCount} NO_GATE, ${thinCount} THIN_N (N<${MIN_N}). ${gateCount ? 'Currently gated: ' + gated.map(w => w.key).join(', ') + '.' : 'No cell has cleared the bar yet -- expected, real per-cell N is still thin for almost every combination.'} CORRECTED same session: the first run of this script GATEd ALL_TYPES__0930_1030_open_ib (N=260, pooled ACTIVE+SHADOW) despite that exact finding already being manually retracted earlier the same session (real-ACTIVE-only N=27 was negative and 70%+ day-clustered, SHADOW-only failed stability) -- the pooled check alone could not catch this. Added a real-vs-SHADOW subgroup-reversal check (disqualifies any cell where ACTIVE-origin N>=10 exists and its mean delta sign disagrees with the pooled mean) so this exact failure mode can't recur silently on some other cell. This is a monitoring/calibration table only -- NOT wired to gate or size any real trade. Building it now so a real per-cell lead is caught automatically as data grows, rather than requiring another one-off backtest each time -- see OPEN_DECISION step_trail_per_cell_live_wiring_pending for the still-open question of whether/how to ever read this table live.`,
    sourceFile: 'scripts/calibrate_step_trail_per_setup_time.mjs',
    sourceDate: today,
    sampleSize: fastTrades.length,
    rigorStatus: gateCount > 0 ? 'has_gated_cells' : 'no_cells_gated_yet',
    status: 'PROVISIONAL',
  });

  console.log('Recorded calibration rows + RESEARCH_CLAIM.');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
