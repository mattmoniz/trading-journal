/**
 * MAE-Based Stop Recalibration Script
 *
 * Replays every resolved fire bar-by-bar to compute MAE/MFE distributions,
 * sweeps stop distances to find EV-maximizing stops, and stores results.
 *
 * All thresholds are dynamic (σ-based, % of developing range, ATR multiples).
 * PNL_PER_POINT = 2, COMMISSION = 1
 */

import { query } from '../server/db.js';

const PNL_PER_POINT = 2;
const COMMISSION = 1;   // per round trip

// ─── UTILITIES ───────────────────────────────────────────────────────────────

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function pad(str, len, align = 'left') {
  str = String(str);
  if (align === 'right') return str.padStart(len);
  return str.padEnd(len);
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║         MAE-BASED STOP RECALIBRATION — COMPREHENSIVE AUDIT         ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  // ── Fetch all qualifying setups (N >= 5, last 180 days) ──────────────────
  const setupsRes = await query(`
    SELECT setup_type, COUNT(*) as cnt
    FROM active_setups
    WHERE fired_at IS NOT NULL
      AND resolution IN ('TARGET_HIT','STOP_HIT')
      AND trade_date >= CURRENT_DATE - 180
      AND stop_level IS NOT NULL AND t1_level IS NOT NULL
      AND entry_zone_low IS NOT NULL AND entry_zone_high IS NOT NULL
    GROUP BY setup_type
    HAVING COUNT(*) >= 5
    ORDER BY COUNT(*) DESC
  `);

  const setupTypes = setupsRes.rows.map(r => r.setup_type);
  console.log(`Found ${setupTypes.length} setup types with N >= 5 resolved fires in last 180 days.\n`);

  // ── Fetch all fires for these setups ─────────────────────────────────────
  const firesRes = await query(`
    SELECT id, setup_type, trade_date, fired_at::text as fired_at, resolved_at::text as resolved_at,
      entry_zone_low::float as entry_low, entry_zone_high::float as entry_high,
      stop_level::float as stop, t1_level::float as t1,
      price_at_detection::float as price_at_det,
      resolution
    FROM active_setups
    WHERE fired_at IS NOT NULL
      AND resolution IN ('TARGET_HIT','STOP_HIT')
      AND trade_date >= CURRENT_DATE - 180
      AND stop_level IS NOT NULL AND t1_level IS NOT NULL
      AND entry_zone_low IS NOT NULL AND entry_zone_high IS NOT NULL
      AND setup_type = ANY($1)
    ORDER BY fired_at
  `, [setupTypes]);

  console.log(`Total fires to replay: ${firesRes.rows.length}\n`);

  // ── Fetch developing value log for range calculations ────────────────────
  const dvRes = await query(`
    SELECT trade_date,
      session_high::float as session_high, session_low::float as session_low,
      vah::float as vah, val::float as val
    FROM developing_value_log
    WHERE session_high IS NOT NULL AND session_low IS NOT NULL
    ORDER BY trade_date
  `);

  const dvByDate = {};
  const dailyRanges = [];
  for (const r of dvRes.rows) {
    dvByDate[r.trade_date] = r;
    dailyRanges.push({ date: r.trade_date, range: r.session_high - r.session_low });
  }

  // Compute trailing 20-day ATR for each date
  const atrByDate = {};
  for (let i = 0; i < dailyRanges.length; i++) {
    const start = Math.max(0, i - 19);
    const window = dailyRanges.slice(start, i + 1);
    atrByDate[dailyRanges[i].date] = mean(window.map(w => w.range));
  }

  // ── Bar-by-bar replay for each fire ──────────────────────────────────────
  console.log('Replaying fires bar-by-bar...');

  const results = {}; // setup_type -> array of fire results
  let replayed = 0;
  let skipped = 0;

  for (const fire of firesRes.rows) {
    const entry = (fire.entry_low + fire.entry_high) / 2;
    const isLong = fire.t1 > entry;
    const stopDist = Math.abs(entry - fire.stop);
    const t1Dist = Math.abs(fire.t1 - entry);

    // Fetch bars from fired_at to end of RTH that day. fired_at is a plain ET
    // wall-clock string (selected ::text above) — never round-tripped through a
    // JS Date, which would otherwise get reserialized in the server's local
    // timezone and silently shift this window by the UTC/ET offset (the same
    // bug fixed in resolveSetupsByPrice, acd.js).
    const firedAt = fire.fired_at; // e.g. "2026-06-20 10:15:00"
    const endOfDay = `${firedAt.slice(0, 10)} 16:00:00`; // RTH close, same date

    const barsRes = await query(`
      SELECT ts, open::float, high::float, low::float, close::float
      FROM price_bars_primary
      WHERE ts >= $1 AND ts <= $2
        AND symbol = 'NQ'
      ORDER BY ts ASC
    `, [firedAt, endOfDay]);

    if (barsRes.rows.length === 0) {
      skipped++;
      continue;
    }

    // Replay bar by bar
    let mae = 0;  // max adverse excursion (always positive = points against)
    let mfe = 0;  // max favorable excursion (always positive = points in favor)
    let hitStop = false;
    let hitTarget = false;
    let exitPrice = entry;

    for (const bar of barsRes.rows) {
      if (isLong) {
        // For longs: adverse = price going DOWN, favorable = price going UP
        // Conservative: check stop first (bar low), then target (bar high)
        const adverseExcursion = entry - bar.low;
        const favorableExcursion = bar.high - entry;

        if (adverseExcursion >= stopDist && !hitTarget) {
          hitStop = true;
          mae = Math.max(mae, stopDist);
          exitPrice = entry - stopDist;
          break;
        }
        if (favorableExcursion >= t1Dist && !hitStop) {
          hitTarget = true;
          mfe = Math.max(mfe, favorableExcursion);
          mae = Math.max(mae, adverseExcursion > 0 ? adverseExcursion : 0);
          exitPrice = entry + t1Dist;
          break;
        }

        // Same bar touches both — conservative: stop wins
        if (adverseExcursion >= stopDist && favorableExcursion >= t1Dist) {
          hitStop = true;
          mae = stopDist;
          exitPrice = entry - stopDist;
          break;
        }

        mae = Math.max(mae, adverseExcursion > 0 ? adverseExcursion : 0);
        mfe = Math.max(mfe, favorableExcursion > 0 ? favorableExcursion : 0);
      } else {
        // For shorts: adverse = price going UP, favorable = price going DOWN
        const adverseExcursion = bar.high - entry;
        const favorableExcursion = entry - bar.low;

        if (adverseExcursion >= stopDist && !hitTarget) {
          hitStop = true;
          mae = Math.max(mae, stopDist);
          exitPrice = entry + stopDist;
          break;
        }
        if (favorableExcursion >= t1Dist && !hitStop) {
          hitTarget = true;
          mfe = Math.max(mfe, favorableExcursion);
          mae = Math.max(mae, adverseExcursion > 0 ? adverseExcursion : 0);
          exitPrice = entry - t1Dist;
          break;
        }

        if (adverseExcursion >= stopDist && favorableExcursion >= t1Dist) {
          hitStop = true;
          mae = stopDist;
          exitPrice = entry + stopDist;
          break;
        }

        mae = Math.max(mae, adverseExcursion > 0 ? adverseExcursion : 0);
        mfe = Math.max(mfe, favorableExcursion > 0 ? favorableExcursion : 0);
      }
    }

    // If neither hit by end of session, treat as a loss at close
    if (!hitStop && !hitTarget) {
      const lastBar = barsRes.rows[barsRes.rows.length - 1];
      exitPrice = lastBar.close;
      hitStop = true; // TIME_EXPIRED is a loss
    }

    // Get developing range for this date
    const dv = dvByDate[fire.trade_date];
    const devRange = dv ? (dv.session_high - dv.session_low) : null;
    const atr20 = atrByDate[fire.trade_date] || null;

    if (!results[fire.setup_type]) results[fire.setup_type] = [];
    results[fire.setup_type].push({
      id: fire.id,
      tradeDate: fire.trade_date,
      entry,
      stop: fire.stop,
      t1: fire.t1,
      isLong,
      stopDist,
      t1Dist,
      mae,
      mfe,
      maeRangePct: devRange ? (mae / devRange * 100) : null,
      mfeRangePct: devRange ? (mfe / devRange * 100) : null,
      hitTarget,
      hitStop,
      resolution: fire.resolution,
      devRange,
      atr20,
      pnl: hitTarget ? (t1Dist * PNL_PER_POINT - COMMISSION) : (-stopDist * PNL_PER_POINT - COMMISSION),
    });

    replayed++;
    if (replayed % 50 === 0) process.stdout.write(`  ${replayed}/${firesRes.rows.length} fires replayed...\r`);
  }

  console.log(`\nReplayed ${replayed} fires, skipped ${skipped} (no bar data).\n`);

  // ═══════════════════════════════════════════════════════════════════════════
  // PART 1: MAE DISTRIBUTION PER SETUP
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  PART 1: MAE DISTRIBUTION PER SETUP');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  const setupAnalysis = {};

  for (const setup of setupTypes) {
    const fires = results[setup];
    if (!fires || fires.length < 5) continue;

    const maes = fires.map(f => f.mae).sort((a, b) => a - b);
    const maeRangePcts = fires.filter(f => f.maeRangePct !== null).map(f => f.maeRangePct).sort((a, b) => a - b);

    const p10 = percentile(maes, 10);
    const p25 = percentile(maes, 25);
    const p50 = percentile(maes, 50);
    const p75 = percentile(maes, 75);
    const p90 = percentile(maes, 90);
    const p95 = percentile(maes, 95);

    const p10r = percentile(maeRangePcts, 10);
    const p25r = percentile(maeRangePcts, 25);
    const p50r = percentile(maeRangePcts, 50);
    const p75r = percentile(maeRangePcts, 75);
    const p90r = percentile(maeRangePcts, 90);

    // Current stop vs P75 MAE
    const stopsInsideP75 = fires.filter(f => f.stopDist <= p75).length;
    const stopsInsideP75Pct = (stopsInsideP75 / fires.length * 100);

    // Blowthrough rate: losers that exceed defined stop by > 5pt
    const losers = fires.filter(f => f.hitStop);
    const blowthroughs = losers.filter(f => f.mae > f.stopDist + 5);
    const blowthroughRate = losers.length > 0 ? (blowthroughs.length / losers.length * 100) : 0;

    const avgStop = mean(fires.map(f => f.stopDist));

    setupAnalysis[setup] = {
      fires, maes, maeRangePcts,
      mae: { p10, p25, p50, p75, p90, p95, mean: mean(maes), std: stddev(maes) },
      maeRange: { p10: p10r, p25: p25r, p50: p50r, p75: p75r, p90: p90r },
      stopsInsideP75, stopsInsideP75Pct,
      blowthroughRate, blowthroughCount: blowthroughs.length, loserCount: losers.length,
      avgStop,
      winCount: fires.filter(f => f.hitTarget).length,
      lossCount: losers.length,
      n: fires.length,
    };

    console.log(`┌─── ${setup} (N=${fires.length}) ────────────────────────────────────`);
    console.log(`│  MAE Distribution (points): P10=${p10.toFixed(1)} P25=${p25.toFixed(1)} P50=${p50.toFixed(1)} P75=${p75.toFixed(1)} P90=${p90.toFixed(1)}`);
    console.log(`│  MAE Distribution (% range): P10=${p10r.toFixed(1)}% P25=${p25r.toFixed(1)}% P50=${p50r.toFixed(1)}% P75=${p75r.toFixed(1)}% P90=${p90r.toFixed(1)}%`);
    console.log(`│  MAE Mean=${mean(maes).toFixed(1)}pt  σ=${stddev(maes).toFixed(1)}pt`);
    console.log(`│  Avg current stop: ${avgStop.toFixed(1)}pt`);
    console.log(`│  Stops INSIDE P75 MAE envelope: ${stopsInsideP75}/${fires.length} (${stopsInsideP75Pct.toFixed(1)}%)`);
    console.log(`│  Blowthrough rate (losers exceeding stop by >5pt): ${blowthroughs.length}/${losers.length} (${blowthroughRate.toFixed(1)}%)`);
    console.log(`└──────────────────────────────────────────────────────────────────\n`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PART 2: OPTIMAL STOP COMPUTATION
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('  PART 2: OPTIMAL STOP COMPUTATION (EV-maximizing sweep)');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  const optimalStops = {};

  for (const setup of Object.keys(setupAnalysis)) {
    const sa = setupAnalysis[setup];
    const fires = sa.fires;
    const { p25, p95 } = sa.mae;

    // Sweep from P25 MAE to P95 MAE in 10 increments
    const sweepMin = Math.max(p25, 5); // minimum 5pt stop
    const sweepMax = Math.max(p95, sweepMin + 10);
    const step = (sweepMax - sweepMin) / 9;

    let bestEV = -Infinity;
    let bestStop = sweepMin;
    let bestWR = 0;
    const sweepResults = [];

    for (let i = 0; i < 10; i++) {
      const testStop = sweepMin + step * i;

      // Replay all fires with this stop distance
      let wins = 0;
      let totalPnl = 0;

      for (const fire of fires) {
        // Re-evaluate: does the trade survive to T1 with this wider/narrower stop?
        if (fire.mae < testStop) {
          // Survived — check if MFE reached T1
          if (fire.mfe >= fire.t1Dist) {
            wins++;
            totalPnl += fire.t1Dist * PNL_PER_POINT - COMMISSION;
          } else {
            // Didn't reach T1 either — exits at session end, approximate as breakeven minus commission
            // Actually, the trade survived but never hit T1 — it's a time-expired loss
            // Use actual MFE as exit approximation (conservative: close at 0)
            totalPnl += -COMMISSION; // breakeven minus commission
          }
        } else {
          // Stopped out at testStop distance
          totalPnl += -testStop * PNL_PER_POINT - COMMISSION;
        }
      }

      const wr = wins / fires.length;
      const ev = totalPnl / fires.length;

      sweepResults.push({ testStop, wins, wr, ev, totalPnl });

      if (ev > bestEV) {
        bestEV = ev;
        bestStop = testStop;
        bestWR = wr;
      }
    }

    // Express optimal stop in multiple dynamic forms
    const avgRange = mean(fires.filter(f => f.devRange).map(f => f.devRange));
    const avgATR = mean(fires.filter(f => f.atr20).map(f => f.atr20));
    const optStopRangePct = avgRange > 0 ? (bestStop / avgRange * 100) : 0;
    const optStopATRMult = avgATR > 0 ? (bestStop / avgATR) : 0;
    const optStopSigma = sa.mae.std > 0 ? ((bestStop - sa.mae.mean) / sa.mae.std) : 0;

    // Current EV
    const currentWR = sa.winCount / sa.n;
    const avgT1Dist = mean(fires.map(f => f.t1Dist));
    const currentEV = mean(fires.map(f => f.pnl));

    optimalStops[setup] = {
      bestStop, bestWR, bestEV,
      optStopRangePct, optStopATRMult, optStopSigma,
      currentStop: sa.avgStop,
      currentWR, currentEV,
      avgRange, avgATR, avgT1Dist,
      sweepResults,
    };

    console.log(`┌─── ${setup} ──────────────────────────────────────────────────`);
    console.log(`│  Stop Sweep (P25=${sweepMin.toFixed(1)} → P95=${sweepMax.toFixed(1)}):`);
    console.log(`│  ${'Stop'.padEnd(10)} ${'WR'.padStart(7)} ${'EV/trade'.padStart(10)} ${'Total PnL'.padStart(12)}`);
    for (const sr of sweepResults) {
      const marker = Math.abs(sr.testStop - bestStop) < 0.01 ? ' ◄ BEST' : '';
      console.log(`│  ${sr.testStop.toFixed(1).padEnd(10)} ${(sr.wr * 100).toFixed(1).padStart(6)}% ${sr.ev.toFixed(2).padStart(10)} ${sr.totalPnl.toFixed(2).padStart(12)}${marker}`);
    }
    console.log(`│`);
    console.log(`│  OPTIMAL STOP: ${bestStop.toFixed(1)} pts`);
    console.log(`│    As % of developing range: ${optStopRangePct.toFixed(1)}%`);
    console.log(`│    As ATR(20) multiple:      ${optStopATRMult.toFixed(3)}x`);
    console.log(`│    As σ of MAE distribution: ${optStopSigma.toFixed(2)}σ above mean`);
    console.log(`│  Current stop: ${sa.avgStop.toFixed(1)} pts → Optimal: ${bestStop.toFixed(1)} pts (${bestStop > sa.avgStop ? '+' : ''}${(bestStop - sa.avgStop).toFixed(1)} pts)`);
    console.log(`│  Current WR: ${(currentWR * 100).toFixed(1)}% → New WR: ${(bestWR * 100).toFixed(1)}%`);
    console.log(`│  Current EV: $${currentEV.toFixed(2)} → New EV: $${bestEV.toFixed(2)}`);
    console.log(`└──────────────────────────────────────────────────────────────────\n`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PART 3: MFE DISTRIBUTION PER SETUP
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('  PART 3: MFE DISTRIBUTION PER SETUP');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  const mfeAnalysis = {};

  for (const setup of Object.keys(setupAnalysis)) {
    const sa = setupAnalysis[setup];
    const fires = sa.fires;

    const mfes = fires.map(f => f.mfe).sort((a, b) => a - b);
    const mfeRangePcts = fires.filter(f => f.mfeRangePct !== null).map(f => f.mfeRangePct).sort((a, b) => a - b);

    const p10 = percentile(mfes, 10);
    const p25 = percentile(mfes, 25);
    const p50 = percentile(mfes, 50);
    const p75 = percentile(mfes, 75);
    const p90 = percentile(mfes, 90);

    const p10r = percentile(mfeRangePcts, 10);
    const p25r = percentile(mfeRangePcts, 25);
    const p50r = percentile(mfeRangePcts, 50);
    const p75r = percentile(mfeRangePcts, 75);
    const p90r = percentile(mfeRangePcts, 90);

    const avgT1 = mean(fires.map(f => f.t1Dist));

    // T1 vs P50 MFE
    const t1VsP50 = avgT1 - p50;

    // T1 overshoot: among winners, how far past T1 does price run?
    const winners = fires.filter(f => f.hitTarget);
    const t1Overshoots = winners.map(f => f.mfe - f.t1Dist).filter(v => v > 0);
    const avgOvershoot = t1Overshoots.length > 0 ? mean(t1Overshoots) : 0;

    // Scale-out analysis: exit half at P50 MFE, hold runner to P75 MFE
    const scaleOutEVs = fires.map(fire => {
      const optStop = optimalStops[setup]?.bestStop || fire.stopDist;

      if (fire.mae >= optStop) {
        // Stopped out — both halves lose
        return -optStop * PNL_PER_POINT - COMMISSION;
      }

      // First half: exits at P50 MFE if reached, else at whatever MFE we got
      let half1PnL;
      if (fire.mfe >= p50) {
        half1PnL = p50 * PNL_PER_POINT * 0.5 - COMMISSION * 0.5;
      } else {
        // Didn't reach P50 — time expired, approximate at 0
        half1PnL = -COMMISSION * 0.5;
      }

      // Second half (runner): exits at P75 MFE if reached
      let half2PnL;
      if (fire.mfe >= p75) {
        half2PnL = p75 * PNL_PER_POINT * 0.5 - COMMISSION * 0.5;
      } else if (fire.mfe >= p50) {
        // Runner trails — approximate exit at P50 (moved stop to breakeven after first target)
        half2PnL = p50 * PNL_PER_POINT * 0.5 * 0.5 - COMMISSION * 0.5; // partial runner capture
      } else {
        half2PnL = -COMMISSION * 0.5;
      }

      return half1PnL + half2PnL;
    });

    const scaleOutEV = mean(scaleOutEVs);

    mfeAnalysis[setup] = {
      mfe: { p10, p25, p50, p75, p90, mean: mean(mfes), std: stddev(mfes) },
      mfeRange: { p10: p10r, p25: p25r, p50: p50r, p75: p75r, p90: p90r },
      avgT1, t1VsP50, avgOvershoot, scaleOutEV,
    };

    console.log(`┌─── ${setup} (N=${fires.length}) ────────────────────────────────────`);
    console.log(`│  MFE Distribution (points): P10=${p10.toFixed(1)} P25=${p25.toFixed(1)} P50=${p50.toFixed(1)} P75=${p75.toFixed(1)} P90=${p90.toFixed(1)}`);
    console.log(`│  MFE Distribution (% range): P10=${p10r.toFixed(1)}% P25=${p25r.toFixed(1)}% P50=${p50r.toFixed(1)}% P75=${p75r.toFixed(1)}% P90=${p90r.toFixed(1)}%`);
    console.log(`│  MFE Mean=${mean(mfes).toFixed(1)}pt  σ=${stddev(mfes).toFixed(1)}pt`);
    console.log(`│  Current T1: ${avgT1.toFixed(1)}pt vs P50 MFE: ${p50.toFixed(1)}pt → ${t1VsP50 > 0 ? 'T1 is ' + t1VsP50.toFixed(1) + 'pt ABOVE P50 (too aggressive)' : 'T1 is ' + Math.abs(t1VsP50).toFixed(1) + 'pt below P50 (room to raise)'}`);
    console.log(`│  T1 overshoot (winners only): avg ${avgOvershoot.toFixed(1)}pt past T1 (N=${t1Overshoots.length} winners with overshoot)`);
    console.log(`│  Scale-out EV (½ at P50, runner to P75): $${scaleOutEV.toFixed(2)}/trade`);
    console.log(`└──────────────────────────────────────────────────────────────────\n`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PART 4: RECALIBRATED SETUP TABLE
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('  PART 4: RECALIBRATED SETUP TABLE');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  const headers = [
    { key: 'setup', label: 'Setup', width: 28 },
    { key: 'n', label: 'N', width: 4 },
    { key: 'curStop', label: 'Cur Stop', width: 9 },
    { key: 'optStop', label: 'Opt Stop', width: 9 },
    { key: 'optStopPct', label: 'Opt %Rng', width: 9 },
    { key: 'optStopATR', label: 'Opt ATR', width: 8 },
    { key: 'curWR', label: 'Cur WR', width: 7 },
    { key: 'newWR', label: 'New WR', width: 7 },
    { key: 'curEV', label: 'Cur EV', width: 9 },
    { key: 'newEV', label: 'New EV', width: 9 },
    { key: 'curT1', label: 'Cur T1', width: 8 },
    { key: 'optT1', label: 'Opt T1', width: 8 },
    { key: 'runnerT1', label: 'Runner', width: 8 },
    { key: 'scaleEV', label: 'Scale EV', width: 9 },
  ];

  const headerLine = headers.map(h => pad(h.label, h.width, 'right')).join(' │ ');
  const sepLine = headers.map(h => '─'.repeat(h.width)).join('─┼─');
  console.log(headerLine);
  console.log(sepLine);

  const tableRows = [];

  for (const setup of Object.keys(setupAnalysis).sort()) {
    const sa = setupAnalysis[setup];
    const os = optimalStops[setup];
    const mfe = mfeAnalysis[setup];
    if (!os || !mfe) continue;

    const row = {
      setup: pad(setup, 28),
      n: pad(String(sa.n), 4, 'right'),
      curStop: pad(sa.avgStop.toFixed(1), 9, 'right'),
      optStop: pad(os.bestStop.toFixed(1), 9, 'right'),
      optStopPct: pad(os.optStopRangePct.toFixed(1) + '%', 9, 'right'),
      optStopATR: pad(os.optStopATRMult.toFixed(2) + 'x', 8, 'right'),
      curWR: pad((sa.winCount / sa.n * 100).toFixed(0) + '%', 7, 'right'),
      newWR: pad((os.bestWR * 100).toFixed(0) + '%', 7, 'right'),
      curEV: pad('$' + os.currentEV.toFixed(0), 9, 'right'),
      newEV: pad('$' + os.bestEV.toFixed(0), 9, 'right'),
      curT1: pad(os.avgT1Dist.toFixed(0), 8, 'right'),
      optT1: pad(mfe.mfe.p50.toFixed(0), 8, 'right'),
      runnerT1: pad(mfe.mfe.p75.toFixed(0), 8, 'right'),
      scaleEV: pad('$' + mfe.scaleOutEV.toFixed(0), 9, 'right'),
    };

    const rowLine = headers.map(h => row[h.key]).join(' │ ');
    console.log(rowLine);
    tableRows.push({ setup, sa, os, mfe });
  }

  console.log(sepLine);
  console.log(`\nAll stop/target values in NQ points. "Opt %Rng" = % of session developing range. "Opt ATR" = multiple of 20-day ATR.`);
  console.log(`PNL_PER_POINT=$${PNL_PER_POINT}, COMMISSION=$${COMMISSION}/RT.\n`);

  // ═══════════════════════════════════════════════════════════════════════════
  // PART 5: VALIDATION — 90-day vs 180-day stability
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('  PART 5: VALIDATION — 90-day vs 180-day Stability');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  // Re-run optimal stop sweep for 90-day window
  const today = new Date();
  const cutoff90 = new Date(today);
  cutoff90.setDate(cutoff90.getDate() - 90);
  const cutoff90Str = cutoff90.toISOString().slice(0, 10);

  console.log(`  ${'Setup'.padEnd(28)} ${'180d Stop'.padStart(10)} ${'90d Stop'.padStart(10)} ${'Delta'.padStart(8)} ${'Stability'.padStart(12)}`);
  console.log(`  ${'─'.repeat(28)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(12)}`);

  const stabilityResults = {};

  for (const setup of Object.keys(setupAnalysis).sort()) {
    const sa = setupAnalysis[setup];
    const fires90 = sa.fires.filter(f => f.tradeDate >= cutoff90Str);

    if (fires90.length < 3) {
      console.log(`  ${pad(setup, 28)} ${pad(optimalStops[setup].bestStop.toFixed(1), 10, 'right')} ${'N/A'.padStart(10)} ${'N/A'.padStart(8)} ${'SKIP (N<3)'.padStart(12)}`);
      stabilityResults[setup] = { score: 'SKIP', stop90: null, stop180: optimalStops[setup].bestStop };
      continue;
    }

    // Sweep on 90-day subset
    const maes90 = fires90.map(f => f.mae).sort((a, b) => a - b);
    const p25_90 = percentile(maes90, 25);
    const p95_90 = percentile(maes90, 95);
    const sweepMin = Math.max(p25_90, 5);
    const sweepMax = Math.max(p95_90, sweepMin + 10);
    const step = (sweepMax - sweepMin) / 9;

    let bestEV90 = -Infinity;
    let bestStop90 = sweepMin;

    for (let i = 0; i < 10; i++) {
      const testStop = sweepMin + step * i;
      let totalPnl = 0;
      let wins = 0;
      for (const fire of fires90) {
        if (fire.mae < testStop) {
          if (fire.mfe >= fire.t1Dist) {
            wins++;
            totalPnl += fire.t1Dist * PNL_PER_POINT - COMMISSION;
          } else {
            totalPnl += -COMMISSION;
          }
        } else {
          totalPnl += -testStop * PNL_PER_POINT - COMMISSION;
        }
      }
      const ev = totalPnl / fires90.length;
      if (ev > bestEV90) {
        bestEV90 = ev;
        bestStop90 = testStop;
      }
    }

    const stop180 = optimalStops[setup].bestStop;
    const delta = Math.abs(bestStop90 - stop180);
    const avgStop = (bestStop90 + stop180) / 2;
    const divergencePct = avgStop > 0 ? (delta / avgStop * 100) : 0;

    let stability;
    if (divergencePct < 15) stability = 'STRUCTURAL';
    else if (divergencePct < 30) stability = 'MODERATE';
    else stability = 'OVERFIT RISK';

    stabilityResults[setup] = { score: stability, stop90: bestStop90, stop180: stop180, delta, divergencePct };

    console.log(`  ${pad(setup, 28)} ${pad(stop180.toFixed(1), 10, 'right')} ${pad(bestStop90.toFixed(1), 10, 'right')} ${pad(delta.toFixed(1), 8, 'right')} ${pad(stability, 12, 'right')}`);
  }

  console.log(`\n  Stability scoring: <15% divergence = STRUCTURAL, 15-30% = MODERATE, >30% = OVERFIT RISK\n`);

  // ═══════════════════════════════════════════════════════════════════════════
  // PART 6: STORE RESULTS IN performance_audit
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('  PART 6: STORING RESULTS');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  let updated = 0;
  let inserted = 0;

  for (const setup of Object.keys(setupAnalysis).sort()) {
    const sa = setupAnalysis[setup];
    const os = optimalStops[setup];
    const mfe = mfeAnalysis[setup];
    const stab = stabilityResults[setup];
    if (!os || !mfe) continue;

    // Check if a row exists for today
    const existing = await query(
      `SELECT id FROM performance_audit WHERE signal_name = $1 AND run_date = CURRENT_DATE AND window_days = 180`,
      [setup]
    );

    const notes = JSON.stringify({
      mae_distribution: sa.mae,
      mfe_distribution: mfe.mfe,
      optimal_stop_range_pct: os.optStopRangePct,
      optimal_stop_atr_mult: os.optStopATRMult,
      optimal_stop_sigma: os.optStopSigma,
      stability: stab.score,
      stop_90d: stab.stop90,
      stop_180d: stab.stop180,
      scale_out_ev: mfe.scaleOutEV,
      runner_t1_p75_mfe: mfe.mfe.p75,
    });

    if (existing.rows.length > 0) {
      await query(`
        UPDATE performance_audit SET
          optimal_stop = $1,
          optimal_target = $2,
          optimal_ev = $3,
          current_stop = $4,
          current_target = $5,
          avg_mae = $6,
          p50_mae = $7,
          p75_mae = $8,
          p90_mae = $9,
          avg_mfe = $10,
          p50_mfe = $11,
          p75_mfe = $12,
          stop_blowthrough_pct = $13,
          t1_overshoot_avg = $14,
          mfe_range_pct = $15,
          mae_range_pct = $16,
          notes = $17
        WHERE id = $18
      `, [
        os.bestStop, mfe.mfe.p50, os.bestEV,
        sa.avgStop, os.avgT1Dist,
        sa.mae.mean, sa.mae.p50, sa.mae.p75, sa.mae.p90,
        mfe.mfe.mean, mfe.mfe.p50, mfe.mfe.p75,
        sa.blowthroughRate, mfe.avgOvershoot,
        mfe.mfeRange.p50, sa.maeRange?.p50 || 0,
        notes, existing.rows[0].id
      ]);
      updated++;
    } else {
      await query(`
        INSERT INTO performance_audit (
          run_date, window_days, signal_type, signal_name, sample_size,
          win_rate, ev_per_trade, total_pnl,
          avg_mfe, p50_mfe, p75_mfe,
          avg_mae, p50_mae, p75_mae, p90_mae,
          current_stop, current_target,
          optimal_stop, optimal_target, optimal_ev,
          stop_blowthrough_pct, t1_overshoot_avg,
          mfe_range_pct, mae_range_pct,
          recommendation, notes
        ) VALUES (
          CURRENT_DATE, 180, 'SETUP', $1, $2,
          $3, $4, $5,
          $6, $7, $8,
          $9, $10, $11, $12,
          $13, $14,
          $15, $16, $17,
          $18, $19,
          $20, $21,
          $22, $23
        )
      `, [
        setup, sa.n,
        os.bestWR, os.bestEV, os.bestEV * sa.n,
        mfe.mfe.mean, mfe.mfe.p50, mfe.mfe.p75,
        sa.mae.mean, sa.mae.p50, sa.mae.p75, sa.mae.p90,
        sa.avgStop, os.avgT1Dist,
        os.bestStop, mfe.mfe.p50, os.bestEV,
        sa.blowthroughRate, mfe.avgOvershoot,
        mfe.mfeRange.p50, sa.maeRange?.p50 || 0,
        stab.score === 'STRUCTURAL' ? 'RECALIBRATE' : (stab.score === 'MODERATE' ? 'REVIEW' : 'FLAG'),
        notes
      ]);
      inserted++;
    }
  }

  console.log(`  Updated ${updated} existing rows, inserted ${inserted} new rows in performance_audit.\n`);

  // ═══════════════════════════════════════════════════════════════════════════
  // FINAL SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║                        EXECUTIVE SUMMARY                           ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  console.log('KEY FINDINGS:\n');

  // Sort by EV improvement
  const improvements = Object.keys(setupAnalysis)
    .filter(s => optimalStops[s])
    .map(s => ({
      setup: s,
      evDelta: optimalStops[s].bestEV - optimalStops[s].currentEV,
      currentEV: optimalStops[s].currentEV,
      newEV: optimalStops[s].bestEV,
      stopDelta: optimalStops[s].bestStop - setupAnalysis[s].avgStop,
      stability: stabilityResults[s]?.score || 'N/A',
    }))
    .sort((a, b) => b.evDelta - a.evDelta);

  console.log('  Setups with BIGGEST EV improvement from stop recalibration:');
  for (const imp of improvements) {
    const arrow = imp.evDelta > 0 ? '▲' : '▼';
    console.log(`    ${pad(imp.setup, 28)} EV: $${imp.currentEV.toFixed(0)} → $${imp.newEV.toFixed(0)} (${arrow}$${Math.abs(imp.evDelta).toFixed(0)})  Stop: ${imp.stopDelta > 0 ? 'WIDEN +' : 'TIGHTEN '}${Math.abs(imp.stopDelta).toFixed(1)}pt  [${imp.stability}]`);
  }

  console.log('\n  Setups where CURRENT STOP is too tight (inside P75 MAE):');
  for (const setup of Object.keys(setupAnalysis).sort()) {
    const sa = setupAnalysis[setup];
    if (sa.stopsInsideP75Pct > 50) {
      console.log(`    ${pad(setup, 28)} ${sa.stopsInsideP75Pct.toFixed(0)}% of stops inside P75 MAE — stops are getting swept`);
    }
  }

  console.log('\n  Setups where T1 is too conservative (below P50 MFE):');
  for (const setup of Object.keys(setupAnalysis).sort()) {
    const mfe = mfeAnalysis[setup];
    if (mfe && mfe.t1VsP50 < -5) {
      console.log(`    ${pad(setup, 28)} T1=${mfe.avgT1.toFixed(0)}pt vs P50 MFE=${mfe.mfe.p50.toFixed(0)}pt — leaving ${Math.abs(mfe.t1VsP50).toFixed(0)}pt on the table`);
    }
  }

  console.log('\n  Setups where scale-out improves EV:');
  for (const setup of Object.keys(setupAnalysis).sort()) {
    const mfe = mfeAnalysis[setup];
    const os = optimalStops[setup];
    if (mfe && os && mfe.scaleOutEV > os.bestEV) {
      console.log(`    ${pad(setup, 28)} Scale-out EV=$${mfe.scaleOutEV.toFixed(0)} vs Single-exit EV=$${os.bestEV.toFixed(0)} (+$${(mfe.scaleOutEV - os.bestEV).toFixed(0)})`);
    }
  }

  const structuralSetups = improvements.filter(i => i.stability === 'STRUCTURAL' && i.evDelta > 0);
  console.log(`\n  ACTIONABLE (structural + positive EV delta): ${structuralSetups.length} setups ready for recalibration.`);
  for (const s of structuralSetups) {
    console.log(`    ✓ ${s.setup}`);
  }

  console.log('\n  All results stored in performance_audit table with run_date = TODAY.\n');
  console.log('Done.');
  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
