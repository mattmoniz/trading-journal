// Calibrates the step-trail runner extension's step fraction and base-distance floor, and
// persists both to performance_audit (signal_type='STEP_TRAIL_FRACTION') for the live shadow
// logger (server/routes/acd.js) to read — same read-once-then-cache convention as
// WIDER_TARGET_PRESSURE_GATE. No-static-thresholds rule: the live code never hardcodes the
// fraction, it reads whatever this script last computed. Re-run weekly
// (run_weekly_backtests.sh) so the calibration tracks the real, growing population.
//
// Selection is NOT max-EV (Opus Audit #12, scratch/opus_audit_12_results.md sec 1) — a raw EV
// sweep at v3 time showed 0.15/0.25/0.40 all beating baseline, but only 0.25 passed BOTH of:
//   (a) computeRigor().clean on the TEST-half delta series
//   (b) a 4-way subgroup symmetry check (LONG/SHORT, ACTIVE/SHADOW, FADE/NONFADE deltas
//       all same-signed) — at 0.15 the entire big-win effect was long-side and shadow-side
//       only, a directional-confound signature, not a real mechanism.
// This script re-derives that same two-part selection generically on whatever the current
// population is, rather than hardcoding "0.25" as a permanent answer.
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { stepWiderTarget } from '../server/services/widerTargetWalker.js';
import { stepStepTrail } from '../server/services/stepTrailWalker.js';
import { isPastMechanismSessionEnd } from '../server/services/sessionBoundary.js';

const PPP = 2, COMM = 2, MAX_WALK_BARS = 1500;
const CANDIDATE_FRACS = [0.15, 0.20, 0.25, 0.30, 0.40];
const PLATEAU_TOLERANCE = 0.30; // within 30% of the best candidate's delta counts as "on the plateau"

function getPnl(pts) { return pts * PPP - COMM; }

async function main() {
  const threshRes = await query(`
    SELECT notes FROM performance_audit
    WHERE signal_type='WIDER_TARGET_PRESSURE_GATE' AND signal_name='THRESHOLD'
    ORDER BY run_date DESC LIMIT 1
  `);
  if (!threshRes.rows.length) {
    console.log('No WIDER_TARGET_PRESSURE_GATE threshold calibrated yet -- step-trail depends on it, nothing to do.');
    process.exit(0);
  }
  const pressureThreshold = JSON.parse(threshRes.rows[0].notes).threshold;

  const setupsRes = await query(`
    SELECT setup_type, trade_date::text as trade_date, fired_at, origin_status,
      entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
      stop_level::float as stop_level, t1_level::float as t1_level
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL AND fired_at IS NOT NULL
    ORDER BY fired_at ASC
  `);
  const barsRes = await query(`
    SELECT ts, high::float as high, low::float as low, close::float as close, open::float as open,
      bid_volume, ask_volume,
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as mod
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const allBars = barsRes.rows.map(b => ({
    ts: new Date(b.ts).getTime(), high: b.high, low: b.low, close: b.close, open: b.open, mod: b.mod,
    bid_volume: Number(b.bid_volume) || 0, ask_volume: Number(b.ask_volume) || 0,
  }));
  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  let enriched = [];
  for (const t of setupsRes.rows) {
    const dir = inferDirection(t.setup_type);
    if (dir === null) continue; // e.g. ZONE_EDGE_FADE -- see step1_ratchet_v3.mjs's own fix
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
    if (!(t1Idx !== null && barCount <= 4)) continue;

    enriched.push({
      setup_type: t.setup_type, trade_date: t.trade_date, fired_at: t.fired_at, origin_status: t.origin_status,
      long, entry, stop, t1, startIdx, t1Idx, firedMod: allBars[startIdx].mod,
      bet_class: t.setup_type.includes('FADE') ? 'fade' : 'nonfade',
    });
  }
  const fastTrades = enriched.sort((a, b) => new Date(a.fired_at) - new Date(b.fired_at));
  if (fastTrades.length < 20) {
    console.log(`Only N=${fastTrades.length} real fast-T1 trades -- below N>=20, not calibrating yet.`);
    process.exit(0);
  }

  // Floor derived on ALL current data (this script's job is "best current live value," the
  // train/test PROOF that the mechanism works already happened in step1_ratchet_v3.mjs).
  const allT1Dists = fastTrades.map(t => Math.abs(t.t1 - t.entry)).sort((a, b) => a - b);
  const p10BaseFloor = allT1Dists[Math.floor((allT1Dists.length - 1) * 0.10)] * 1.5;

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
      const r = stepWiderTarget(state, bar, {
        entry: t.entry, stop: t.stop, t1: t.t1, widerTarget: flatWider, long: t.long,
        barCount: bCount, maxBarsToT1: 4, firedMod: t.firedMod, pressureReading, pressureThreshold,
      });
      state = r.state;
      if (r.resolution) { res = r.resolution; break; }
      bCount++;
    }
    if (!res) res = { priceAtRes: allBars[Math.min(allBars.length - 1, t.startIdx + MAX_WALK_BARS) - 1].close };
    const pts = t.long ? res.priceAtRes - t.entry : t.entry - res.priceAtRes;
    return getPnl(pts);
  }

  function runArmB(t, frac) {
    const flatWider = t.entry + (t.long ? 1 : -1) * 1.5 * Math.abs(t.t1 - t.entry);
    const riskDist = Math.abs(flatWider - t.entry);
    const effectiveBase = Math.max(riskDist, p10BaseFloor);
    const stepSize = frac * effectiveBase;
    const pressureReading = pressureReadingAt(t, t.t1Idx);
    let state = { inner: { widening: false }, ratcheting: false, currentStop: null, highestMfe: null };
    let res = null, bCount = 1;
    for (let i = t.startIdx; i < Math.min(allBars.length, t.startIdx + MAX_WALK_BARS); i++) {
      const bar = allBars[i];
      const r = stepStepTrail(state, bar, {
        entry: t.entry, stop: t.stop, t1: t.t1, widerTarget: flatWider, long: t.long,
        barCount: bCount, maxBarsToT1: 4, firedMod: t.firedMod, pressureReading, pressureThreshold, stepSize,
      });
      state = r.state;
      if (r.resolution) { res = r.resolution; break; }
      bCount++;
    }
    if (!res) res = { priceAtRes: allBars[Math.min(allBars.length - 1, t.startIdx + MAX_WALK_BARS) - 1].close };
    const pts = t.long ? res.priceAtRes - t.entry : t.entry - res.priceAtRes;
    return { pnl: getPnl(pts), pts };
  }

  const armAResults = fastTrades.map(t => ({ t, pnl: runArmA(t) }));
  const BIG_WIN_PTS = 100; // matches Opus Audit #12's own ">100pt outcome" bar exactly, not a fresh threshold

  function subgroupSymmetric(rows) {
    // rows: [{t, delta, pts}]. Two conditions, both required, per Opus Audit #12 sec 1's
    // actual finding (a same-signed MEAN alone was not enough -- at frac=0.15 the mean was
    // positive but the entire big-win effect was long-side/shadow-side only, "0 big wins
    // among real ACTIVE trades" -- a same-signed-mean-only check would have missed exactly
    // the confound that check was built to catch):
    //  (a) mean delta same-signed as the overall mean in every cut with enough N to judge, AND
    //  (b) at least one >100pt Arm-B outcome present in EVERY cut with N>=20 (not just the
    //      pooled population) -- this is the check that actually distinguishes 0.25 from 0.15.
    const overallSign = Math.sign(rows.reduce((s, x) => s + x.delta, 0));
    if (overallSign === 0) return false;
    const dichotomies = [
      [rows.filter(x => x.t.long), rows.filter(x => !x.t.long)],
      [rows.filter(x => x.t.origin_status === 'ACTIVE'), rows.filter(x => x.t.origin_status === 'SHADOW')],
      [rows.filter(x => x.t.bet_class === 'fade'), rows.filter(x => x.t.bet_class === 'nonfade')],
    ];
    for (const [a, b] of dichotomies) {
      for (const c of [a, b]) {
        if (c.length < 5) continue; // too thin to judge sign meaningfully
        const mean = c.reduce((s, x) => s + x.delta, 0) / c.length;
        if (Math.sign(mean) !== 0 && Math.sign(mean) !== overallSign) return false;
      }
      // Big-win presence: only enforced on sides with N>=20 (the same floor this codebase
      // requires before treating any cell as meaningful at all) -- a thin side having zero
      // big wins by chance isn't the confound signature, a LARGE side having zero is.
      for (const c of [a, b]) {
        if (c.length < 20) continue;
        const bigWins = c.filter(x => x.pts > BIG_WIN_PTS).length;
        if (bigWins === 0) return false;
      }
    }
    return true;
  }

  const candidates = [];
  for (const frac of CANDIDATE_FRACS) {
    const armBResults = fastTrades.map(t => runArmB(t, frac));
    const rows = fastTrades.map((t, i) => ({ t, delta: armBResults[i].pnl - armAResults[i].pnl, pts: armBResults[i].pts }));
    const meanDelta = rows.reduce((s, x) => s + x.delta, 0) / rows.length;
    const rigorData = rows.map(x => ({ date: x.t.trade_date, delta: x.delta }));
    const rigor = computeRigor(rigorData, { dateField: 'date', pnlFn: r => r.delta });
    const symmetric = subgroupSymmetric(rows);
    const bigWinCount = rows.filter(x => x.pts > BIG_WIN_PTS).length;
    candidates.push({ frac, meanDelta, rigor, symmetric, bigWinCount });
    console.log(`frac=${frac}: meanDelta=$${meanDelta.toFixed(2)}, rigor.clean=${rigor.clean}, symmetric=${symmetric}, bigWins(>${BIG_WIN_PTS}pt)=${bigWinCount}/${rows.length}`);
  }

  const bestDelta = Math.max(...candidates.map(c => c.meanDelta));
  const eligible = candidates.filter(c =>
    c.rigor.clean && c.symmetric && c.meanDelta > 0 && c.meanDelta >= bestDelta * (1 - PLATEAU_TOLERANCE)
  );

  if (eligible.length === 0) {
    console.log('\nNo candidate fraction passed both rigor.clean and the subgroup-symmetry check -- not writing a calibration, live shadow logger stays disabled (fail-closed).');
    process.exit(0);
  }
  // Among eligible (rigor-clean, symmetric, on the plateau) candidates, prefer the smallest
  // fraction -- per Opus's "base-hits-vs-home-runs dial" framing, a smaller step preserves
  // more mid-size wins for the same qualifying tail effect.
  const selected = eligible.reduce((a, b) => (a.frac < b.frac ? a : b));
  console.log(`\nSelected frac=${selected.frac} (meanDelta=$${selected.meanDelta.toFixed(2)}, of ${eligible.length} eligible candidates)`);

  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes)
    VALUES (CURRENT_DATE, 0, 'STEP_TRAIL_FRACTION', 'FRACTION', $1, $2)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
      SET sample_size = EXCLUDED.sample_size, notes = EXCLUDED.notes
  `, [fastTrades.length, JSON.stringify({
    frac: selected.frac, p10BaseFloor, meanDelta: selected.meanDelta,
    rigor: selected.rigor, candidatesEvaluated: candidates.map(c => ({ frac: c.frac, meanDelta: c.meanDelta, clean: c.rigor.clean, symmetric: c.symmetric })),
    method: 'plateau_rigor_clean_subgroup_symmetric',
  })]);

  console.log('DONE');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
