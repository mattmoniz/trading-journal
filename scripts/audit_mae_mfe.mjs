// =============================================================================
// Setup Resolution Audit & MAE/MFE Analysis
// Replays ALL setup fires bar-by-bar over last 180 days
// Flags same-bar conflicts (conservative = STOP), computes MAE/MFE distributions
// =============================================================================

import { query } from '../server/db.js';

const PNL_PER_POINT = 2;
const COMMISSION = 1;

// Direction mapping
function getDirection(setupType) {
  const upper = setupType.toUpperCase();
  if (upper.includes('LONG') || upper.includes('BULLISH') || upper.includes('_UP'))
    return 'LONG';
  return 'SHORT';
}

// Percentile helper
function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function median(arr) { return percentile(arr, 50); }
function mean(arr) { return arr.length ? arr.reduce((a,b) => a+b, 0) / arr.length : 0; }

// =============================================================================
// Main
// =============================================================================
async function main() {
  console.log('='.repeat(120));
  console.log('SETUP RESOLUTION AUDIT & MAE/MFE ANALYSIS');
  console.log('Conservative rule: same-bar stop+target conflict => STOP_HIT');
  console.log('='.repeat(120));
  console.log('');

  // 1. Fetch all setups with valid entry/stop/t1 in last 180 days
  const setupsResult = await query(`
    SELECT id, trade_date, setup_type, status, resolution, fired_at,
           entry_zone_low::float as entry_low, entry_zone_high::float as entry_high,
           stop_level::float as stop, t1_level::float as t1,
           actual_pnl::float, price_at_detection::float,
           resolution_method
    FROM active_setups
    WHERE entry_zone_low IS NOT NULL
      AND stop_level IS NOT NULL
      AND t1_level IS NOT NULL
      AND fired_at IS NOT NULL
      AND trade_date >= CURRENT_DATE - 180
    ORDER BY trade_date, fired_at
  `);

  const setups = setupsResult.rows;
  console.log(`Total setups fetched: ${setups.length}`);

  // 2. Fetch daily ranges from developing_value_log
  const rangeResult = await query(`
    SELECT trade_date,
           (session_high - session_low)::float as daily_range,
           (vah - val)::float as va_range
    FROM developing_value_log
    WHERE trade_date >= CURRENT_DATE - 180
  `);
  const dailyRange = {};
  for (const r of rangeResult.rows) {
    dailyRange[r.trade_date] = { range: r.daily_range, vaRange: r.va_range };
  }

  // 3. Fetch all price bars needed (batch by trade_date)
  const tradeDates = [...new Set(setups.map(s => s.trade_date))];
  console.log(`Unique trade dates: ${tradeDates.length}`);
  console.log('Loading price bars...');

  // Build a map: date => bars[]
  const barsByDate = {};
  for (const td of tradeDates) {
    const barsResult = await query(`
      SELECT ts, open::float, high::float, low::float, close::float
      FROM price_bars_primary
      WHERE ts::date = $1
        AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
      ORDER BY ts
    `, [td]);
    barsByDate[td] = barsResult.rows;
  }
  console.log('Price bars loaded.');
  console.log('');

  // 4. Replay each setup bar-by-bar
  const results = [];
  const mismatches = [];

  for (const setup of setups) {
    const dir = getDirection(setup.setup_type);
    const entry = (setup.entry_low + setup.entry_high) / 2;
    const stop = setup.stop;
    const t1 = setup.t1;
    const firedAt = new Date(setup.fired_at);
    const bars = barsByDate[setup.trade_date] || [];

    // Sanity check direction vs levels
    const entryRisk = dir === 'LONG' ? entry - stop : stop - entry;
    const reward = dir === 'LONG' ? t1 - entry : entry - t1;

    if (entryRisk <= 0 || reward <= 0) {
      // Skip setups with inverted levels
      continue;
    }

    // Get bars AFTER fired_at
    const replayBars = bars.filter(b => new Date(b.ts) >= firedAt);

    if (replayBars.length === 0) {
      continue;
    }

    // Walk bar-by-bar
    let mfe = 0;       // max favorable excursion in points
    let mae = 0;       // max adverse excursion in points (positive = against you)
    let resolution = null;  // 'TARGET_HIT' or 'STOP_HIT'
    let resolvedBar = null;
    let barsToResolution = 0;
    let sameBarConflict = false;
    let mfeBeforeResolution = 0;
    let maeBeforeResolution = 0;
    let priceAtResolution = null;

    for (let i = 0; i < replayBars.length; i++) {
      const bar = replayBars[i];
      barsToResolution = i + 1;

      // Favorable / Adverse excursion for this bar
      let favorable, adverse;
      if (dir === 'LONG') {
        favorable = bar.high - entry;
        adverse = entry - bar.low;
      } else {
        favorable = entry - bar.low;
        adverse = bar.high - entry;
      }

      // Check stop and target hit on this bar
      let stopHit = false, targetHit = false;
      if (dir === 'LONG') {
        stopHit = bar.low <= stop;
        targetHit = bar.high >= t1;
      } else {
        stopHit = bar.high >= stop;
        targetHit = bar.low <= t1;
      }

      if (stopHit && targetHit) {
        // Same-bar conflict: CONSERVATIVE = STOP_HIT
        sameBarConflict = true;
        resolution = 'STOP_HIT';
        resolvedBar = bar;
        priceAtResolution = stop;
        // MFE/MAE up to this bar
        mfe = Math.max(mfe, favorable);
        mae = Math.max(mae, adverse);
        break;
      } else if (stopHit) {
        resolution = 'STOP_HIT';
        resolvedBar = bar;
        priceAtResolution = stop;
        mfe = Math.max(mfe, favorable);
        mae = Math.max(mae, adverse);
        break;
      } else if (targetHit) {
        resolution = 'TARGET_HIT';
        resolvedBar = bar;
        priceAtResolution = t1;
        mfe = Math.max(mfe, favorable);
        mae = Math.max(mae, adverse);
        break;
      }

      // Update running MFE/MAE
      mfe = Math.max(mfe, favorable);
      mae = Math.max(mae, adverse);
    }

    // If no resolution by end of day => EXPIRED
    if (!resolution) {
      resolution = 'EXPIRED';
      // Use last bar close for excursion
    }

    const dailyR = dailyRange[setup.trade_date];
    const dayRange = dailyR ? dailyR.range : null;

    const result = {
      id: setup.id,
      trade_date: setup.trade_date,
      setup_type: setup.setup_type,
      status: setup.status,
      direction: dir,
      entry,
      stop,
      t1,
      entryRisk,
      reward,
      db_resolution: setup.resolution,
      replay_resolution: resolution,
      mfe,
      mae,
      mfe_sigma: dayRange ? mfe / dayRange : null,
      mae_sigma: dayRange ? mae / dayRange : null,
      mae_over_risk: mae / entryRisk,
      duration_mins: barsToResolution,
      same_bar_conflict: sameBarConflict,
      mismatch: setup.resolution && resolution !== setup.resolution &&
                setup.resolution !== 'EXPIRED' && setup.resolution !== 'INVALIDATED' &&
                setup.resolution !== 'TIME_EXPIRED' &&
                resolution !== 'EXPIRED',
      winner_overshoot: resolution === 'TARGET_HIT' ? mfe - reward : null,
      loser_overshoot: resolution === 'STOP_HIT' ? mae - entryRisk : null,
      realized_rr: resolution === 'TARGET_HIT' ? reward / entryRisk : (resolution === 'STOP_HIT' ? -1 : null),
    };

    results.push(result);

    if (result.mismatch) {
      mismatches.push(result);
    }
  }

  console.log(`Total setups replayed: ${results.length}`);
  console.log(`Mismatches found: ${mismatches.length}`);
  console.log('');

  // ==========================================================================
  // 5. Per Setup Type Summary Table
  // ==========================================================================
  const byType = {};
  for (const r of results) {
    if (!byType[r.setup_type]) byType[r.setup_type] = [];
    byType[r.setup_type].push(r);
  }

  console.log('='.repeat(120));
  console.log('SECTION 1: PER SETUP TYPE SUMMARY');
  console.log('='.repeat(120));

  const summaryRows = [];
  for (const [type, recs] of Object.entries(byType).sort((a,b) => b[1].length - a[1].length)) {
    const resolved = recs.filter(r => r.replay_resolution !== 'EXPIRED');
    const n = resolved.length;
    if (n === 0) continue;

    const replayWins = resolved.filter(r => r.replay_resolution === 'TARGET_HIT').length;
    const replayWR = (replayWins / n * 100).toFixed(1);

    const dbResolved = recs.filter(r => r.db_resolution === 'TARGET_HIT' || r.db_resolution === 'STOP_HIT');
    const dbWins = dbResolved.filter(r => r.db_resolution === 'TARGET_HIT').length;
    const dbWR = dbResolved.length ? (dbWins / dbResolved.length * 100).toFixed(1) : 'N/A';

    const mismatchCount = recs.filter(r => r.mismatch).length;
    const sameBarCount = recs.filter(r => r.same_bar_conflict).length;

    const avgMFE = mean(resolved.map(r => r.mfe)).toFixed(2);
    const avgMAE = mean(resolved.map(r => r.mae)).toFixed(2);
    const avgMaeRisk = mean(resolved.map(r => r.mae_over_risk)).toFixed(2);
    const p50MFE = median(resolved.map(r => r.mfe)).toFixed(2);
    const p50MAE = median(resolved.map(r => r.mae)).toFixed(2);
    const mfeMaeRatio = mean(resolved.map(r => r.mae)) > 0
      ? (mean(resolved.map(r => r.mfe)) / mean(resolved.map(r => r.mae))).toFixed(2) : 'INF';
    const avgDuration = mean(resolved.map(r => r.duration_mins)).toFixed(1);

    // MFE/MAE in sigma
    const sigmaRecs = resolved.filter(r => r.mfe_sigma !== null);
    const avgMFEsig = sigmaRecs.length ? mean(sigmaRecs.map(r => r.mfe_sigma)).toFixed(3) : 'N/A';
    const avgMAEsig = sigmaRecs.length ? mean(sigmaRecs.map(r => r.mae_sigma)).toFixed(3) : 'N/A';

    summaryRows.push({
      type, n, replayWR, dbWR, mismatchCount, sameBarCount,
      avgMFE, avgMAE, avgMaeRisk, p50MFE, p50MAE,
      mfeMaeRatio, avgDuration, avgMFEsig, avgMAEsig
    });
  }

  // Print table header
  const hdr = [
    'Setup Type'.padEnd(30),
    'N'.padStart(4),
    'RpWR%'.padStart(7),
    'DbWR%'.padStart(7),
    'Mism'.padStart(5),
    'SameB'.padStart(5),
    'AvgMFE'.padStart(8),
    'AvgMAE'.padStart(8),
    'MAE/Rsk'.padStart(8),
    'P50MFE'.padStart(8),
    'P50MAE'.padStart(8),
    'MFE/MAE'.padStart(8),
    'AvgDur'.padStart(7),
    'MFEsig'.padStart(8),
    'MAEsig'.padStart(8),
  ].join(' | ');
  console.log(hdr);
  console.log('-'.repeat(hdr.length));

  for (const s of summaryRows) {
    console.log([
      s.type.padEnd(30),
      String(s.n).padStart(4),
      String(s.replayWR).padStart(7),
      String(s.dbWR).padStart(7),
      String(s.mismatchCount).padStart(5),
      String(s.sameBarCount).padStart(5),
      String(s.avgMFE).padStart(8),
      String(s.avgMAE).padStart(8),
      String(s.avgMaeRisk).padStart(8),
      String(s.p50MFE).padStart(8),
      String(s.p50MAE).padStart(8),
      String(s.mfeMaeRatio).padStart(8),
      String(s.avgDuration).padStart(7),
      String(s.avgMFEsig).padStart(8),
      String(s.avgMAEsig).padStart(8),
    ].join(' | '));
  }

  // ==========================================================================
  // 6. MISMATCH DETAIL
  // ==========================================================================
  console.log('');
  console.log('='.repeat(120));
  console.log('SECTION 2: RESOLUTION MISMATCHES (DB vs Replay)');
  console.log('='.repeat(120));

  if (mismatches.length === 0) {
    console.log('No mismatches found.');
  } else {
    console.log(`Found ${mismatches.length} mismatches:`);
    console.log('');
    const mhdr = ['Date'.padEnd(12), 'Setup Type'.padEnd(30), 'DB Resolution'.padEnd(15),
      'Replay Resolution'.padEnd(18), 'SameBar?'.padEnd(9), 'Entry'.padStart(10),
      'Stop'.padStart(10), 'T1'.padStart(10), 'MAE'.padStart(8), 'MFE'.padStart(8)].join(' | ');
    console.log(mhdr);
    console.log('-'.repeat(mhdr.length));
    for (const m of mismatches) {
      console.log([
        m.trade_date.padEnd(12),
        m.setup_type.padEnd(30),
        m.db_resolution.padEnd(15),
        m.replay_resolution.padEnd(18),
        (m.same_bar_conflict ? 'YES' : 'no').padEnd(9),
        m.entry.toFixed(2).padStart(10),
        m.stop.toFixed(2).padStart(10),
        m.t1.toFixed(2).padStart(10),
        m.mae.toFixed(2).padStart(8),
        m.mfe.toFixed(2).padStart(8),
      ].join(' | '));
    }
  }

  // ==========================================================================
  // 7. OPTIMAL STOP & TARGET ANALYSIS
  // ==========================================================================
  console.log('');
  console.log('='.repeat(120));
  console.log('SECTION 3: OPTIMAL STOP & TARGET ANALYSIS');
  console.log('='.repeat(120));

  for (const [type, recs] of Object.entries(byType).sort((a,b) => b[1].length - a[1].length)) {
    const resolved = recs.filter(r => r.replay_resolution !== 'EXPIRED');
    if (resolved.length < 5) continue;  // Need minimum sample

    const maeArr = resolved.map(r => r.mae).sort((a,b) => a - b);
    const mfeArr = resolved.map(r => r.mfe).sort((a,b) => a - b);

    const p25MAE = percentile(maeArr, 25);
    const p50MAE = percentile(maeArr, 50);
    const p75MAE = percentile(maeArr, 75);
    const p90MAE = percentile(maeArr, 90);
    const p25MFE = percentile(mfeArr, 25);
    const p50MFE = percentile(mfeArr, 50);
    const p75MFE = percentile(mfeArr, 75);
    const p90MFE = percentile(mfeArr, 90);

    const avgEntryRisk = mean(resolved.map(r => r.entryRisk));
    const avgReward = mean(resolved.map(r => r.reward));

    console.log('');
    console.log(`--- ${type} (N=${resolved.length}) ---`);
    console.log(`  Current avg stop distance: ${avgEntryRisk.toFixed(2)} pts`);
    console.log(`  Current avg T1 distance:   ${avgReward.toFixed(2)} pts`);
    console.log(`  MAE distribution: P25=${p25MAE.toFixed(2)} P50=${p50MAE.toFixed(2)} P75=${p75MAE.toFixed(2)} P90=${p90MAE.toFixed(2)}`);
    console.log(`  MFE distribution: P25=${p25MFE.toFixed(2)} P50=${p50MFE.toFixed(2)} P75=${p75MFE.toFixed(2)} P90=${p90MFE.toFixed(2)}`);

    // Stop analysis
    const stopTooTight = avgEntryRisk < p50MAE;
    const stopTooWide = avgEntryRisk > p90MAE;
    if (stopTooTight) {
      console.log(`  ** STOP TOO TIGHT: avg stop ${avgEntryRisk.toFixed(2)} < P50 MAE ${p50MAE.toFixed(2)} -- getting stopped out before trade works`);
    } else if (stopTooWide) {
      console.log(`  ** STOP TOO WIDE: avg stop ${avgEntryRisk.toFixed(2)} > P90 MAE ${p90MAE.toFixed(2)} -- risking too much`);
    } else {
      console.log(`  Stop sizing OK: avg stop ${avgEntryRisk.toFixed(2)} between P50-P90 MAE`);
    }

    // Target analysis
    const targetLeaving = avgReward < p50MFE;
    if (targetLeaving) {
      console.log(`  ** TARGET TOO CONSERVATIVE: avg T1 ${avgReward.toFixed(2)} < P50 MFE ${p50MFE.toFixed(2)} -- leaving money on the table`);
    } else {
      console.log(`  T1 sizing OK: avg T1 ${avgReward.toFixed(2)} vs P50 MFE ${p50MFE.toFixed(2)}`);
    }

    // EV optimization: test stop/target combos
    let bestEV = -Infinity;
    let bestCombo = null;
    const stopTests = [p50MAE, p75MAE, p90MAE, avgEntryRisk];
    const targetTests = [p25MFE, p50MFE, p75MFE, avgReward];

    for (const testStop of stopTests) {
      for (const testTarget of targetTests) {
        if (testStop <= 0 || testTarget <= 0) continue;
        // Simulate: if MAE > testStop => loss of testStop, else if MFE >= testTarget => win of testTarget
        let wins = 0, losses = 0, totalPnl = 0;
        for (const r of resolved) {
          if (r.mae > testStop) {
            // Would have been stopped
            losses++;
            totalPnl -= testStop * PNL_PER_POINT + COMMISSION;
          } else if (r.mfe >= testTarget) {
            // Would have hit target
            wins++;
            totalPnl += testTarget * PNL_PER_POINT - COMMISSION;
          } else {
            // Neither hit - scratch (use close-to-entry as proxy)
            // For simplicity, count as slight loss
            losses++;
            totalPnl -= COMMISSION;
          }
        }
        const ev = totalPnl / resolved.length;
        if (ev > bestEV) {
          bestEV = ev;
          bestCombo = { stop: testStop, target: testTarget, wins, losses, wr: (wins/(wins+losses)*100).toFixed(1) };
        }
      }
    }
    if (bestCombo) {
      console.log(`  OPTIMAL COMBO: Stop=${bestCombo.stop.toFixed(2)} Target=${bestCombo.target.toFixed(2)} => WR=${bestCombo.wr}% EV=$${bestEV.toFixed(2)}/trade`);
    }
  }

  // ==========================================================================
  // 8. EDGE-LEVEL SIGNAL ANALYSIS
  // ==========================================================================
  console.log('');
  console.log('='.repeat(120));
  console.log('SECTION 4: EDGE-LEVEL SIGNAL ANALYSIS');
  console.log('='.repeat(120));

  const edgeSignals = ['PD_POC_FADE', 'FLOOR_S1_FADE', 'OR_HIGH_FADE', 'IB_HIGH_FADE', 'VWAP_MAGNET'];
  for (const sig of edgeSignals) {
    const edgeRecs = results.filter(r => r.setup_type.includes(sig));
    const resolved = edgeRecs.filter(r => r.replay_resolution !== 'EXPIRED');
    if (resolved.length === 0) {
      console.log(`\n--- ${sig}: No resolved trades ---`);
      continue;
    }

    const wins = resolved.filter(r => r.replay_resolution === 'TARGET_HIT').length;
    const wr = (wins / resolved.length * 100).toFixed(1);
    const avgMFE = mean(resolved.map(r => r.mfe));
    const avgMAE = mean(resolved.map(r => r.mae));
    const avgDuration = mean(resolved.map(r => r.duration_mins));
    const sameBar = resolved.filter(r => r.same_bar_conflict).length;

    console.log(`\n--- ${sig} (N=${resolved.length}, incl LONG+SHORT) ---`);
    console.log(`  Replay WR: ${wr}%  | Avg MFE: ${avgMFE.toFixed(2)} pts | Avg MAE: ${avgMAE.toFixed(2)} pts | Avg Duration: ${avgDuration.toFixed(1)} min | Same-bar conflicts: ${sameBar}`);

    if (resolved.length >= 3) {
      console.log(`  MFE dist: P25=${percentile(resolved.map(r=>r.mfe),25).toFixed(2)} P50=${median(resolved.map(r=>r.mfe)).toFixed(2)} P75=${percentile(resolved.map(r=>r.mfe),75).toFixed(2)}`);
      console.log(`  MAE dist: P25=${percentile(resolved.map(r=>r.mae),25).toFixed(2)} P50=${median(resolved.map(r=>r.mae)).toFixed(2)} P75=${percentile(resolved.map(r=>r.mae),75).toFixed(2)}`);
    }
  }

  // ==========================================================================
  // 9. CONSERVATIVE WR IMPACT (Same-bar = STOP)
  // ==========================================================================
  console.log('');
  console.log('='.repeat(120));
  console.log('SECTION 5: CONSERVATIVE WIN RATE IMPACT');
  console.log('Same-bar stop+target conflicts resolved as STOP_HIT (conservative)');
  console.log('='.repeat(120));

  const allResolved = results.filter(r => r.replay_resolution !== 'EXPIRED');
  const allReplayWins = allResolved.filter(r => r.replay_resolution === 'TARGET_HIT').length;
  const allReplayWR = (allReplayWins / allResolved.length * 100).toFixed(1);

  const dbResolvedAll = results.filter(r => r.db_resolution === 'TARGET_HIT' || r.db_resolution === 'STOP_HIT');
  const dbWinsAll = dbResolvedAll.filter(r => r.db_resolution === 'TARGET_HIT').length;
  const dbWRAll = dbResolvedAll.length ? (dbWinsAll / dbResolvedAll.length * 100).toFixed(1) : 'N/A';

  const totalSameBar = results.filter(r => r.same_bar_conflict).length;
  const sameBarFlippedToLoss = results.filter(r => r.same_bar_conflict && r.db_resolution === 'TARGET_HIT').length;

  console.log(`Total setups replayed:                ${results.length}`);
  console.log(`Resolved (stop or target hit):        ${allResolved.length}`);
  console.log(`DB Win Rate (TARGET_HIT/resolved):    ${dbWRAll}% (${dbWinsAll}/${dbResolvedAll.length})`);
  console.log(`Replay Win Rate (conservative):       ${allReplayWR}% (${allReplayWins}/${allResolved.length})`);
  console.log(`Same-bar conflicts total:             ${totalSameBar}`);
  console.log(`  of which DB called TARGET_HIT:      ${sameBarFlippedToLoss} (these are the inflated wins)`);
  console.log(`Win rate delta (DB - Replay):          ${(parseFloat(dbWRAll) - parseFloat(allReplayWR)).toFixed(1)} percentage points`);

  // Per setup type breakdown of same-bar impact
  console.log('');
  console.log('Per setup type same-bar impact:');
  const sbHdr = ['Setup Type'.padEnd(30), 'N'.padStart(4), 'SameBar'.padStart(7),
    'Flipped'.padStart(8), 'DbWR%'.padStart(7), 'RpWR%'.padStart(7), 'Delta'.padStart(7)].join(' | ');
  console.log(sbHdr);
  console.log('-'.repeat(sbHdr.length));

  for (const [type, recs] of Object.entries(byType).sort((a,b) => b[1].length - a[1].length)) {
    const resolved = recs.filter(r => r.replay_resolution !== 'EXPIRED');
    if (resolved.length < 3) continue;
    const sb = recs.filter(r => r.same_bar_conflict).length;
    const flipped = recs.filter(r => r.same_bar_conflict && r.db_resolution === 'TARGET_HIT').length;
    const dbRes = recs.filter(r => r.db_resolution === 'TARGET_HIT' || r.db_resolution === 'STOP_HIT');
    const dbW = dbRes.filter(r => r.db_resolution === 'TARGET_HIT').length;
    const dbWR = dbRes.length ? (dbW/dbRes.length*100).toFixed(1) : 'N/A';
    const rpW = resolved.filter(r => r.replay_resolution === 'TARGET_HIT').length;
    const rpWR = (rpW/resolved.length*100).toFixed(1);
    const delta = dbRes.length ? (parseFloat(dbWR) - parseFloat(rpWR)).toFixed(1) : 'N/A';

    console.log([
      type.padEnd(30), String(resolved.length).padStart(4), String(sb).padStart(7),
      String(flipped).padStart(8), String(dbWR).padStart(7), String(rpWR).padStart(7),
      String(delta).padStart(7)
    ].join(' | '));
  }

  // ==========================================================================
  // 10. R:R ANALYSIS
  // ==========================================================================
  console.log('');
  console.log('='.repeat(120));
  console.log('SECTION 6: REALIZED R:R ANALYSIS');
  console.log('='.repeat(120));

  for (const [type, recs] of Object.entries(byType).sort((a,b) => b[1].length - a[1].length)) {
    const resolved = recs.filter(r => r.replay_resolution !== 'EXPIRED');
    if (resolved.length < 5) continue;

    const winners = resolved.filter(r => r.replay_resolution === 'TARGET_HIT');
    const losers = resolved.filter(r => r.replay_resolution === 'STOP_HIT');

    const avgDefinedRR = mean(resolved.map(r => r.reward / r.entryRisk));

    console.log(`\n--- ${type} (N=${resolved.length}) ---`);
    console.log(`  Defined R:R (avg): ${avgDefinedRR.toFixed(2)}`);

    if (winners.length > 0) {
      const avgWinOvershoot = mean(winners.map(r => r.winner_overshoot));
      const pctRunPast = winners.filter(r => r.winner_overshoot > 0).length / winners.length * 100;
      const avgWinnerMFE = mean(winners.map(r => r.mfe));
      const avgReward = mean(winners.map(r => r.reward));
      console.log(`  Winners (${winners.length}): avg MFE ${avgWinnerMFE.toFixed(2)} pts, avg T1 ${avgReward.toFixed(2)} pts, avg overshoot ${avgWinOvershoot.toFixed(2)} pts, ${pctRunPast.toFixed(0)}% ran past T1`);
    }

    if (losers.length > 0) {
      const avgLoseOvershoot = mean(losers.map(r => r.loser_overshoot));
      const pctBlewThrough = losers.filter(r => r.loser_overshoot > 2).length / losers.length * 100;
      const avgLoserMAE = mean(losers.map(r => r.mae));
      const avgRisk = mean(losers.map(r => r.entryRisk));
      console.log(`  Losers (${losers.length}): avg MAE ${avgLoserMAE.toFixed(2)} pts, avg stop ${avgRisk.toFixed(2)} pts, avg overshoot past stop ${avgLoseOvershoot.toFixed(2)} pts, ${pctBlewThrough.toFixed(0)}% blew through by >2 pts`);
    }

    // Effective R:R
    if (winners.length > 0 && losers.length > 0) {
      const avgWinPts = mean(winners.map(r => r.reward));
      const avgLossPts = mean(losers.map(r => r.entryRisk));
      const effectiveRR = avgWinPts / avgLossPts;
      const wr = winners.length / resolved.length;
      const ev = wr * avgWinPts * PNL_PER_POINT - (1 - wr) * avgLossPts * PNL_PER_POINT - COMMISSION;
      console.log(`  Effective R:R: ${effectiveRR.toFixed(2)} | WR: ${(wr*100).toFixed(1)}% | EV: $${ev.toFixed(2)}/trade`);
    }
  }

  // ==========================================================================
  // AGGREGATE SUMMARY
  // ==========================================================================
  console.log('');
  console.log('='.repeat(120));
  console.log('AGGREGATE SUMMARY');
  console.log('='.repeat(120));

  const totalReplayed = results.length;
  const expired = results.filter(r => r.replay_resolution === 'EXPIRED').length;
  const replayTargetHit = results.filter(r => r.replay_resolution === 'TARGET_HIT').length;
  const replayStopHit = results.filter(r => r.replay_resolution === 'STOP_HIT').length;

  console.log(`Total setups replayed:    ${totalReplayed}`);
  console.log(`  TARGET_HIT (replay):    ${replayTargetHit}`);
  console.log(`  STOP_HIT (replay):      ${replayStopHit}`);
  console.log(`  EXPIRED (no hit):       ${expired}`);
  console.log(`Overall replay WR:        ${allReplayWR}% (of ${allResolved.length} resolved)`);
  console.log(`Overall DB WR:            ${dbWRAll}% (of ${dbResolvedAll.length} resolved)`);
  console.log(`Total mismatches:         ${mismatches.length}`);
  console.log(`Total same-bar conflicts: ${totalSameBar}`);
  console.log(`Inflated wins (same-bar): ${sameBarFlippedToLoss}`);

  const globalAvgMFE = mean(allResolved.map(r => r.mfe));
  const globalAvgMAE = mean(allResolved.map(r => r.mae));
  console.log(`Global avg MFE:           ${globalAvgMFE.toFixed(2)} pts`);
  console.log(`Global avg MAE:           ${globalAvgMAE.toFixed(2)} pts`);
  console.log(`Global MFE/MAE ratio:     ${(globalAvgMFE / globalAvgMAE).toFixed(2)}`);

  // Sigma summary
  const withSigma = allResolved.filter(r => r.mfe_sigma !== null);
  if (withSigma.length > 0) {
    console.log(`Global avg MFE (sigma):   ${mean(withSigma.map(r => r.mfe_sigma)).toFixed(3)} of daily range`);
    console.log(`Global avg MAE (sigma):   ${mean(withSigma.map(r => r.mae_sigma)).toFixed(3)} of daily range`);
  }

  console.log('');
  console.log('AUDIT COMPLETE');

  // Write sentinel so process-health fallback can detect manual runs
  const today = new Date().toISOString().slice(0, 10);
  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl)
    VALUES ($1, 365, 'MAE_MFE_AUDIT', 'SUMMARY', $2, 0, 0, 0)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET sample_size=EXCLUDED.sample_size
  `, [today, allResolved.length]).catch(() => {});

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
