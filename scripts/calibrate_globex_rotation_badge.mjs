// Weekly self-recalibration for the Globex overnight rotation-count badge (2026-09-21,
// RESEARCH_CLAIM overnight_rotation_count_predicts_rth_range_20260921 -- full derivation and
// every finding behind this script lives there and in docs/OPEN_THREADS.md's same-day entry;
// read those before changing this script's methodology).
//
// What this predicts: whether TODAY's RTH session is heading for an unusually large or small
// total range, using only overnight (6pm ET prior day -> 9:30am ET) price-swing activity --
// available hours before RTH opens. Direction-agnostic (does not predict which way the RTH
// session moves, only how big).
//
// NO STATIC THRESHOLDS: every number this script produces (the rotation-count cutoff at each
// checkpoint, the checkpoint TIMES themselves, the hit rates, the "is today a big day"
// boundary) is re-derived fresh from a trailing real-data window every run, per CLAUDE.md's
// standing rule -- this file hardcodes a CANDIDATE checkpoint grid (a methodology choice, same
// category as PURGE_DAYS/TEST_FRACTION in the ML silo's train.py) but never a literal rotation
// count or hit-rate. If overnight trading patterns shift (a new session structure, a different
// dominant participant base, a volatility regime change), this recalibration is what catches it
// -- that is the whole point of running it weekly rather than hardcoding today's numbers.
//
// Two-stage design (found empirically, not assumed): the earliest checkpoint that already
// carries a real, well-powered signal is far more useful than waiting for a "perfect" one, and
// a SECOND, later checkpoint applied only to sessions the first one missed adds real
// incremental lift. A naive single-checkpoint design would either fire too late (losing lead
// time) or too early (missing sessions that build up more slowly). Checked directly: a 3rd
// stage does NOT hold up once stages are evaluated sequentially (non-overlapping) -- most
// sessions that would qualify for a later, stricter threshold already got caught by the
// looser stage-2 check, leaving too few days to trust a stage-3 read. Only 2 stages, plus a
// "missed both" bucket, are calibrated and shipped.

import { query } from '../server/db.js';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
import { detectRotationLegs, ROTATION_LEG_THRESHOLD as R } from '../server/services/rotationDetector.js';
import { recordClaim } from './record_claim.mjs';

// Candidate checkpoint grid, in minutes since 6:00pm ET (the overnight session's own open) --
// this IS the one fixed methodology choice in this file (which wall-clock moments are even
// considered), matching this codebase's own "training methodology constant, not a live
// threshold" carve-out. 60min spacing from 7pm through 8am; RTH itself opens at 9:30am
// (810min), so nothing later than 8am (840min) is worth testing -- too little lead time left
// to be useful even if it scored well.
const CANDIDATE_CHECKPOINTS_MIN = [60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660, 720, 780, 840];
// hh:mm labels for the same grid, for readable output/notes only.
const CHECKPOINT_LABELS = { 60:'7pm',120:'8pm',180:'9pm',240:'10pm',300:'11pm',360:'12am',420:'1am',480:'2am',540:'3am',600:'4am',660:'5am',720:'6am',780:'7am',840:'8am' };

const MIN_N = 20; // this codebase's own standing N floor for any claim reported as decisive
const CANDIDATE_PERCENTILES = [0.60, 0.67, 0.70, 0.75, 0.80, 0.85, 0.90]; // swept per checkpoint, not guessed

function percentile(sortedArr, p) {
  return sortedArr[Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p))];
}

async function fetchRecords() {
  // Full available history in the dense-intraday-data window (checked directly 2026-09-21:
  // price_bars_primary NQ is sparse daily placeholders before 2025-06-01). Deliberately NOT a
  // fixed lookback window -- as more real data accumulates past this start date, this script
  // naturally gets MORE powered over time, self-correcting rather than needing a manual bump.
  const START_DATE = '2025-06-01';
  const daysRes = await query(`
    SELECT DISTINCT ts::date::text as d FROM price_bars_primary
    WHERE symbol='NQ' AND ts::date >= $1
      AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
    ORDER BY d
  `, [START_DATE]);
  const days = daysRes.rows.map(r => r.d);

  const records = [];
  for (const day of days) {
    const onRes = await query(`
      SELECT ts::text as ts, high::float, low::float
      FROM price_bars_primary WHERE symbol='NQ'
        AND ((ts::date = $1::date - 1 AND EXTRACT(hour FROM ts) >= 18)
          OR (ts::date = $1::date AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) < 570))
      ORDER BY ts ASC
    `, [day]);
    if (onRes.rows.length < 60) continue;
    const rthRes = await query(`
      SELECT high::float, low::float FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1
        AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
      ORDER BY ts ASC
    `, [day]);
    if (rthRes.rows.length < 60) continue;
    const rthRange = Math.max(...rthRes.rows.map(b => b.high)) - Math.min(...rthRes.rows.map(b => b.low));

    // Confirmed legs, keeping each one's own minutes-since-6pm timestamp so we can re-count
    // "legs so far" at any candidate checkpoint without re-walking the array per checkpoint.
    const legs = detectRotationLegsWithMinute(onRes.rows);
    records.push({ day, legs, rthRangePts: Math.round(rthRange) });
  }
  return records;
}

// Same confirmation walk as detectRotationLegs() (server/services/rotationDetector.js) --
// verified byte-identical leg count/order against that shared function before this script
// trusted its own copy (see scripts/test_calibrate_globex_rotation_badge.mjs). Re-derives each
// leg's own minutesSinceOpen (6pm ET = 0) from its real timestamp, which the canonical function
// itself has no reason to expose.
function detectRotationLegsWithMinute(bars) {
  const legs = [];
  let running_high = bars[0].high, running_high_idx = 0;
  let running_low = bars[0].low, running_low_idx = 0;
  let pivot_is_low = null;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (bar.high > running_high) { running_high = bar.high; running_high_idx = i; }
    if (bar.low < running_low) { running_low = bar.low; running_low_idx = i; }
    let confirmed = null;
    if (pivot_is_low === null) {
      if (running_high - bar.low >= R) { confirmed = bar; pivot_is_low = false; }
      else if (bar.high - running_low >= R) { confirmed = bar; pivot_is_low = true; }
    } else if (pivot_is_low === true) {
      if (running_high - bar.low >= R) { confirmed = bar; pivot_is_low = false; }
    } else {
      if (bar.high - running_low >= R) { confirmed = bar; pivot_is_low = true; }
    }
    if (confirmed) {
      const hh = parseInt(confirmed.ts.slice(11, 13), 10), mm = parseInt(confirmed.ts.slice(14, 16), 10);
      const minutesSinceOpen = hh >= 18 ? (hh - 18) * 60 + mm : (6 * 60) + hh * 60 + mm;
      legs.push({ minutesSinceOpen });
      running_high = bar.high; running_low = bar.low; running_high_idx = i; running_low_idx = i;
    }
  }
  return legs;
}

function legsByCheckpoint(legs, cpMin) {
  return legs.filter(l => l.minutesSinceOpen < cpMin).length;
}

async function main() {
  const records = await fetchRecords();
  console.log(`Real days in trailing window: ${records.length}`);
  if (records.length < 60) {
    console.log('Too little real data yet -- skipping this run, will retry next week as more data accumulates.');
    process.exit(0);
  }

  // "Is today a big day" boundary -- data-derived, not hardcoded (top tercile of full-session
  // rotation count, recomputed fresh from this same trailing window every run).
  const fullCounts = records.map(r => r.legs.length).sort((a, b) => a - b);
  const highCutoff = percentile(fullCounts, 2 / 3);
  const withLabel = records.map(r => ({ ...r, isHigh: r.legs.length > highCutoff ? 1 : 0 }));
  const baselineCI = dayBlockedBootstrapCI(withLabel.map(r => ({ day: r.day, pnl: r.isHigh })), 'baseline_isHigh', { dateField: 'day' });
  const baselineRate = withLabel.reduce((s, r) => s + r.isHigh, 0) / withLabel.length;
  console.log(`HIGH-day boundary (top tercile of full-session rotation count): >${highCutoff} legs. Baseline HIGH rate: ${(baselineRate * 100).toFixed(1)}% [${(baselineCI.lo*100).toFixed(1)},${(baselineCI.hi*100).toFixed(1)}]`);

  // Sweep every candidate checkpoint x percentile combination, evaluated on the FULL
  // population (this is what selects Stage 1 -- the earliest reliable checkpoint).
  function evaluate(pool, cpMin, pct) {
    const countsAtCp = pool.map(r => legsByCheckpoint(r.legs, cpMin)).sort((a, b) => a - b);
    const threshold = percentile(countsAtCp, pct);
    if (threshold < 1) return null; // a threshold of 0 is meaningless (matches ~everyone)
    // FOUND 2026-09-21, before shipping: a threshold >= highCutoff makes the "prediction"
    // tautological -- rotation count only ever increases through the night, so "already at or
    // past the final HIGH boundary by an early checkpoint" trivially guarantees the outcome by
    // construction (confirming you've already crossed the finish line, not predicting you will).
    // Require a genuine margin below the final boundary so there's real uncertainty left at the
    // checkpoint moment -- this is what makes it an early WARNING, not a delayed confirmation.
    if (threshold >= highCutoff) return null;
    const qualifying = pool.filter(r => legsByCheckpoint(r.legs, cpMin) >= threshold);
    if (qualifying.length < MIN_N) return null;
    const ci = dayBlockedBootstrapCI(qualifying.map(r => ({ day: r.day, pnl: r.isHigh })), `cp${cpMin}_p${pct}`, { dateField: 'day' });
    const hitRate = qualifying.reduce((s, r) => s + r.isHigh, 0) / qualifying.length;
    return { cpMin, pct, threshold, n: qualifying.length, hitRate, lo: ci.lo, hi: ci.hi, qualifying };
  }

  // Stage 1: among ALL checkpoint x percentile combinations that clear a real bar (N>=MIN_N,
  // CI lower bound clearly above the baseline's own CI upper bound -- genuine, non-overlapping
  // separation, not just a point-estimate difference), select by hitRate STRENGTH first, not
  // earliness. FOUND 2026-09-21, before shipping: an earlier draft picked "earliest checkpoint,
  // loosest threshold that clears at all" -- this technically passed the bar (7pm, >=1 leg,
  // 58.3% vs a 33% baseline) but is a much weaker, less useful signal than what manual research
  // this same day found (2am, >=5 legs, 88.3%). "First thing that's technically significant"
  // and "most useful signal" are NOT the same selection criterion -- a trivially loose early
  // threshold clears the bar by barely beating baseline, not by being a strong flag. Selecting
  // by hitRate strength (with earliness only as a tiebreaker among near-equal candidates) is
  // what actually reproduces the useful signal instead of the weakest one that happens to pass.
  let stage1 = null;
  {
    const allCandidates = [];
    for (const cpMin of CANDIDATE_CHECKPOINTS_MIN) {
      for (const pct of CANDIDATE_PERCENTILES) {
        const r = evaluate(withLabel, cpMin, pct);
        if (r && r.lo > baselineCI.hi) allCandidates.push(r);
      }
    }
    // Sort by hitRate descending; among candidates within 3 percentage points of the best,
    // prefer the earliest checkpoint (more lead time is worth a small strength tradeoff, but
    // not worth abandoning most of the signal for it).
    allCandidates.sort((a, b) => b.hitRate - a.hitRate);
    if (allCandidates.length) {
      const best = allCandidates[0];
      const nearBest = allCandidates.filter(c => best.hitRate - c.hitRate <= 0.03);
      nearBest.sort((a, b) => a.cpMin - b.cpMin);
      stage1 = nearBest[0];
    }
  }
  if (!stage1) {
    console.log('No checkpoint cleared the bar for Stage 1 this run -- shipping baseline-only (no badge escalation), will retry next week.');
  } else {
    console.log(`Stage 1 selected: checkpoint=${CHECKPOINT_LABELS[stage1.cpMin]} (${stage1.cpMin}min), threshold=>=${stage1.threshold} legs, n=${stage1.n}, hitRate=${(stage1.hitRate*100).toFixed(1)}% [${(stage1.lo*100).toFixed(1)},${(stage1.hi*100).toFixed(1)}]`);
  }

  // Stage 2: same search, restricted to sessions Stage 1 did NOT already flag, and only among
  // checkpoints STRICTLY LATER than Stage 1's own checkpoint (a stage 2 that fires earlier
  // than stage 1 would defeat the whole "second look, more data" purpose).
  let stage2 = null;
  if (stage1) {
    const remaining = withLabel.filter(r => legsByCheckpoint(r.legs, stage1.cpMin) < stage1.threshold);
    const remainingBaselineCI = dayBlockedBootstrapCI(remaining.map(r => ({ day: r.day, pnl: r.isHigh })), 'remaining_after_stage1', { dateField: 'day' });
    const allCandidates2 = [];
    for (const cpMin of CANDIDATE_CHECKPOINTS_MIN.filter(m => m > stage1.cpMin)) {
      for (const pct of CANDIDATE_PERCENTILES) {
        const r = evaluate(remaining, cpMin, pct);
        if (r && r.lo > remainingBaselineCI.hi) allCandidates2.push(r);
      }
    }
    allCandidates2.sort((a, b) => b.hitRate - a.hitRate);
    if (allCandidates2.length) {
      const best2 = allCandidates2[0];
      const nearBest2 = allCandidates2.filter(c => best2.hitRate - c.hitRate <= 0.03);
      nearBest2.sort((a, b) => a.cpMin - b.cpMin);
      stage2 = nearBest2[0];
    }
    if (stage2) {
      console.log(`Stage 2 selected: checkpoint=${CHECKPOINT_LABELS[stage2.cpMin]} (${stage2.cpMin}min), threshold=>=${stage2.threshold} legs, n=${stage2.n}, hitRate=${(stage2.hitRate*100).toFixed(1)}% [${(stage2.lo*100).toFixed(1)},${(stage2.hi*100).toFixed(1)}]`);
    } else {
      console.log('No later checkpoint cleared the bar for Stage 2 this run.');
    }
  }

  // "Missed everything" bucket -- the badge's LOW-likelihood state. Evaluated at whichever
  // checkpoint is latest among Stage 1/2 (or Stage 1 alone if Stage 2 didn't clear), since
  // that's the point at which the badge would actually commit to "not flagged."
  let missedBucket = null;
  const finalCpMin = stage2 ? stage2.cpMin : (stage1 ? stage1.cpMin : null);
  if (finalCpMin != null) {
    const missed = withLabel.filter(r => {
      const stage1Miss = !stage1 || legsByCheckpoint(r.legs, stage1.cpMin) < stage1.threshold;
      const stage2Miss = !stage2 || legsByCheckpoint(r.legs, stage2.cpMin) < stage2.threshold;
      return stage1Miss && stage2Miss;
    });
    if (missed.length >= MIN_N) {
      const ci = dayBlockedBootstrapCI(missed.map(r => ({ day: r.day, pnl: r.isHigh })), 'missed_everything', { dateField: 'day' });
      const hitRate = missed.reduce((s, r) => s + r.isHigh, 0) / missed.length;
      missedBucket = { cpMin: finalCpMin, n: missed.length, hitRate, lo: ci.lo, hi: ci.hi };
      console.log(`"Missed everything" bucket (as of ${CHECKPOINT_LABELS[finalCpMin]}): n=${missedBucket.n}, HIGH rate=${(hitRate*100).toFixed(1)}% [${(ci.lo*100).toFixed(1)},${(ci.hi*100).toFixed(1)}]`);
    }
  }

  const today = (await query(`SELECT CURRENT_DATE::text AS today`)).rows[0].today;
  const notes = {
    calibratedAt: new Date().toISOString(),
    trailingDays: records.length,
    highCutoffLegs: highCutoff,
    baseline: { n: withLabel.length, hitRate: +baselineRate.toFixed(4), lo: +baselineCI.lo.toFixed(4), hi: +baselineCI.hi.toFixed(4) },
    stage1: stage1 ? { checkpointMin: stage1.cpMin, checkpointLabel: CHECKPOINT_LABELS[stage1.cpMin], thresholdLegs: stage1.threshold, n: stage1.n, hitRate: +stage1.hitRate.toFixed(4), lo: +stage1.lo.toFixed(4), hi: +stage1.hi.toFixed(4) } : null,
    stage2: stage2 ? { checkpointMin: stage2.cpMin, checkpointLabel: CHECKPOINT_LABELS[stage2.cpMin], thresholdLegs: stage2.threshold, n: stage2.n, hitRate: +stage2.hitRate.toFixed(4), lo: +stage2.lo.toFixed(4), hi: +stage2.hi.toFixed(4) } : null,
    missedEverything: missedBucket ? { checkpointMin: missedBucket.cpMin, n: missedBucket.n, hitRate: +missedBucket.hitRate.toFixed(4), lo: +missedBucket.lo.toFixed(4), hi: +missedBucket.hi.toFixed(4) } : null,
  };

  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, notes)
    VALUES ($1, 0, 'GLOBEX_ROTATION_BADGE_CALIB', 'ALL_SESSIONS', $2, $3, NULL, $4)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
      sample_size = EXCLUDED.sample_size, win_rate = EXCLUDED.win_rate, notes = EXCLUDED.notes
  `, [today, records.length, stage1 ? +(stage1.hitRate * 100).toFixed(1) : null, JSON.stringify(notes)]);

  await recordClaim({
    slug: 'overnight_rotation_count_predicts_rth_range_20260921',
    claimText: `Weekly self-recalibration (scripts/calibrate_globex_rotation_badge.mjs), ${today}. ` +
      `Trailing real days: ${records.length}. HIGH-day boundary: >${highCutoff} full-session rotations (baseline rate ${(baselineRate*100).toFixed(1)}%). ` +
      (stage1 ? `Stage 1: ${CHECKPOINT_LABELS[stage1.cpMin]}, >=${stage1.threshold} legs -> ${(stage1.hitRate*100).toFixed(1)}% HIGH (n=${stage1.n}). ` : 'Stage 1: no checkpoint cleared the bar this run. ') +
      (stage2 ? `Stage 2 (if stage 1 missed): ${CHECKPOINT_LABELS[stage2.cpMin]}, >=${stage2.threshold} legs -> ${(stage2.hitRate*100).toFixed(1)}% HIGH (n=${stage2.n}). ` : '') +
      (missedBucket ? `Missed both: ${(missedBucket.hitRate*100).toFixed(1)}% HIGH (n=${missedBucket.n}) -- the badge's LOW-likelihood state.` : ''),
    sourceFile: 'scripts/calibrate_globex_rotation_badge.mjs',
    sourceDate: today,
    sampleSize: records.length,
    evPerTrade: null,
    winRate: stage1 ? +(stage1.hitRate * 100).toFixed(1) : null,
    rigorStatus: 'weekly_self_recalibrating_checkpoint_and_threshold_both_data_derived',
    status: stage1 && stage1.lo > baselineCI.hi ? 'CONFIRMED' : 'PROVISIONAL',
  });

  console.log('Calibration written + claim updated.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
