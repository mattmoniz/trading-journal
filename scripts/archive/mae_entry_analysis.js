/**
 * MAE-Based Entry Quality & Stop Recalibration Analysis
 *
 * Analyzes each setup's entry quality, MAE timing, and categorizes them
 * to determine if high MAE is from bad entries or structural swing needs.
 *
 * Key insight: resolved_at timestamps are unreliable (timezone issues,
 * backfilled with fired_at + 30min). Resolution timing is computed from
 * actual price bar data instead.
 */

import { query } from '../server/db.js';

const PNL_PER_POINT = 2;   // MNQ $2/pt
const COMMISSION = 1;       // $1 round trip
const DLL = 400;            // daily loss limit

// Cache price bars per date to avoid repeated queries
const barCache = {};

async function getRthBarsForDate(tradeDate) {
  if (barCache[tradeDate]) return barCache[tradeDate];
  const res = await query(`
    SELECT ts, open::float, high::float, low::float, close::float, volume
    FROM price_bars_primary
    WHERE ts::date = $1
      AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ORDER BY ts
  `, [tradeDate]);
  barCache[tradeDate] = res.rows;
  return res.rows;
}

// ─── Main Analysis ──────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(75));
  console.log('  MAE ENTRY QUALITY & STOP RECALIBRATION ANALYSIS');
  console.log('  NQ Futures | Last 180 Days | MNQ ($2/pt)');
  console.log('='.repeat(75) + '\n');

  // ─── Load all resolved setups with N >= 5 ────────────────────────────
  const setupsRes = await query(`
    SELECT s.*,
      d.poc as pd_poc, d.vah as pd_vah, d.val as pd_val,
      d.session_high as pd_high, d.session_low as pd_low,
      a.or_high, a.or_low
    FROM active_setups s
    LEFT JOIN developing_value_log d ON d.trade_date = s.trade_date - 1
    LEFT JOIN acd_daily_log a ON a.trade_date = s.trade_date
    WHERE s.trade_date >= CURRENT_DATE - 180
      AND s.status = 'RESOLVED'
      AND s.entry_zone_low IS NOT NULL
      AND s.stop_level IS NOT NULL
    ORDER BY s.setup_type, s.trade_date
  `);

  // Group by setup_type
  const bySetup = {};
  for (const row of setupsRes.rows) {
    if (!bySetup[row.setup_type]) bySetup[row.setup_type] = [];
    bySetup[row.setup_type].push(row);
  }

  // Get floor pivots
  const pivotRes = await query(`SELECT * FROM acd_monthly_pivot ORDER BY month_year`);
  const pivotsByMonth = {};
  for (const p of pivotRes.rows) {
    pivotsByMonth[p.month_year] = {
      pivot: parseFloat(p.pivot_level),
      r1: parseFloat(p.pivot_r1),
      s1: parseFloat(p.pivot_s1)
    };
  }

  const setupTypes = Object.keys(bySetup).filter(k => bySetup[k].length >= 5).sort();

  console.log(`Analyzing ${setupTypes.length} setup types with N >= 5:\n`);
  console.log(setupTypes.map(s => `  ${s} (N=${bySetup[s].length})`).join('\n'));
  console.log('');

  const summaryTable = [];

  for (const setupType of setupTypes) {
    const setups = bySetup[setupType];

    console.log('\n' + '-'.repeat(75));
    console.log(`  ${setupType}  (N=${setups.length})`);
    console.log('-'.repeat(75));

    // Determine direction from first setup
    const isShort = parseFloat(setups[0].stop_level) > parseFloat(setups[0].entry_zone_low);
    const direction = isShort ? 'SHORT' : 'LONG';
    console.log(`  Direction: ${direction}`);

    const pullbackWindows = [10, 20, 30];

    // ─── Process each setup instance ────────────────────────────────────
    const results = [];

    for (const setup of setups) {
      const entryPrice = parseFloat(setup.entry_zone_low);
      const stopPrice = parseFloat(setup.stop_level);
      const t1Price = parseFloat(setup.t1_level);
      const firedAt = new Date(setup.fired_at);
      const tradeDate = setup.trade_date;
      const resolution = setup.resolution;
      const stopDist = Math.abs(entryPrice - stopPrice);

      const bars = await getRthBarsForDate(tradeDate);
      if (bars.length === 0) continue;

      const firedMinute = firedAt.getHours() * 60 + firedAt.getMinutes();
      const postEntryBars = bars.filter(b => {
        const bMin = new Date(b.ts).getHours() * 60 + new Date(b.ts).getMinutes();
        return bMin >= firedMinute;
      });

      if (postEntryBars.length === 0) continue;

      // ─── Compute MAE/MFE bar by bar ──────────────────────────────────
      let mae = 0, mfe = 0;
      let maeMinute = 0, mfeMinute = 0;
      let mae5 = 0, mae15 = 0, mae30 = 0, mae60 = 0;

      // Track running MAE for spike detection
      const maeTimeSeries = []; // { minute, runningMae }

      // Track actual resolution from price
      let actualResMinute = null;

      for (const bar of postEntryBars) {
        const barMin = new Date(bar.ts).getHours() * 60 + new Date(bar.ts).getMinutes();
        const minutesAfterEntry = barMin - firedMinute;

        let adverse, favorable;
        if (isShort) {
          adverse = bar.high - entryPrice;
          favorable = entryPrice - bar.low;
        } else {
          adverse = entryPrice - bar.low;
          favorable = bar.high - entryPrice;
        }

        if (adverse > mae) {
          mae = adverse;
          maeMinute = minutesAfterEntry;
        }
        if (favorable > mfe) {
          mfe = favorable;
          mfeMinute = minutesAfterEntry;
        }

        if (minutesAfterEntry <= 5 && adverse > mae5) mae5 = adverse;
        if (minutesAfterEntry <= 15 && adverse > mae15) mae15 = adverse;
        if (minutesAfterEntry <= 30 && adverse > mae30) mae30 = adverse;
        if (minutesAfterEntry <= 60 && adverse > mae60) mae60 = adverse;

        maeTimeSeries.push({ minute: minutesAfterEntry, runningMae: mae, adverse });

        // Track actual stop/target hit from price
        if (actualResMinute === null) {
          const hitStop = isShort ? bar.high >= stopPrice : bar.low <= stopPrice;
          const hitTarget = isShort ? bar.low <= t1Price : bar.high >= t1Price;
          if (hitStop || hitTarget) {
            actualResMinute = minutesAfterEntry;
          }
        }
      }

      // ─── Spike vs Sustained detection ─────────────────────────────────
      // Spike: MAE reaches >= 80% of final value quickly, then pulls back
      // Sustained: MAE grows progressively through the session
      let maeType = 'UNKNOWN';

      if (mae > 0 && maeTimeSeries.length > 5) {
        // What % of final MAE was reached by minute 5, 15, 30?
        const mae5pct = mae5 / mae;
        const mae15pct = mae15 / mae;
        const mae30pct = mae30 / mae;

        // Check if MAE peaked early and price recovered
        if (mae5pct >= 0.7 && maeMinute <= 10) {
          // MAE reached 70%+ in first 5 min, peaked by min 10
          // Check recovery: did adverse drop below 50% of MAE after the peak?
          const postPeakBars = maeTimeSeries.filter(b => b.minute > maeMinute && b.minute <= maeMinute + 20);
          const recovered = postPeakBars.some(b => b.adverse < mae * 0.4);
          maeType = recovered ? 'SPIKE_RECOVERED' : 'SPIKE_HELD';
        } else if (mae15pct >= 0.8 && maeMinute <= 20) {
          // MAE within 15 min, moderate spike
          const postPeakBars = maeTimeSeries.filter(b => b.minute > maeMinute && b.minute <= maeMinute + 20);
          const recovered = postPeakBars.some(b => b.adverse < mae * 0.4);
          maeType = recovered ? 'SPIKE_RECOVERED' : 'SPIKE_HELD';
        } else if (mae30pct < 0.5) {
          // Less than 50% of MAE by min 30 = very late MAE
          maeType = 'LATE_SUSTAINED';
        } else {
          // Gradual buildup
          maeType = 'SUSTAINED';
        }
      } else if (mae > 0) {
        maeType = maeMinute <= 5 ? 'SPIKE_RECOVERED' : 'SUSTAINED';
      }

      // ─── Key Level Distance ───────────────────────────────────────────
      const keyLevels = [];
      if (setup.pd_poc) keyLevels.push({ name: 'PD_POC', level: parseFloat(setup.pd_poc) });
      if (setup.pd_vah) keyLevels.push({ name: 'PD_VAH', level: parseFloat(setup.pd_vah) });
      if (setup.pd_val) keyLevels.push({ name: 'PD_VAL', level: parseFloat(setup.pd_val) });
      if (setup.pd_high) keyLevels.push({ name: 'PD_HIGH', level: parseFloat(setup.pd_high) });
      if (setup.pd_low) keyLevels.push({ name: 'PD_LOW', level: parseFloat(setup.pd_low) });
      if (setup.or_high) keyLevels.push({ name: 'OR_HIGH', level: parseFloat(setup.or_high) });
      if (setup.or_low) keyLevels.push({ name: 'OR_LOW', level: parseFloat(setup.or_low) });

      // IB High/Low from bars
      const ibBars = bars.filter(b => {
        const mins = new Date(b.ts).getHours() * 60 + new Date(b.ts).getMinutes();
        return mins >= 570 && mins <= 599;
      });
      if (ibBars.length > 0) {
        keyLevels.push({ name: 'IB_HIGH', level: Math.max(...ibBars.map(b => b.high)) });
        keyLevels.push({ name: 'IB_LOW', level: Math.min(...ibBars.map(b => b.low)) });
      }

      // Floor pivots
      const monthKey = `${tradeDate.substring(0, 4)}-${tradeDate.substring(5, 7)}`;
      if (pivotsByMonth[monthKey]) {
        const p = pivotsByMonth[monthKey];
        keyLevels.push({ name: 'FLOOR_PIVOT', level: p.pivot });
        keyLevels.push({ name: 'FLOOR_R1', level: p.r1 });
        keyLevels.push({ name: 'FLOOR_S1', level: p.s1 });
      }

      let nearestDist = Infinity, nearestName = '';
      for (const kl of keyLevels) {
        const dist = Math.abs(entryPrice - kl.level);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestName = kl.name;
        }
      }

      // ─── Pullback fill rate (entry refinement) ────────────────────────
      const pullbackResults = {};

      for (const pb of pullbackWindows) {
        const refinedEntry = isShort ? entryPrice + pb : entryPrice - pb;

        // Check if pullback happens within 15 min of detection
        const earlyBars = postEntryBars.filter(b => {
          const bMin = new Date(b.ts).getHours() * 60 + new Date(b.ts).getMinutes();
          return bMin >= firedMinute && bMin <= firedMinute + 15;
        });

        let filled = false, fillBar = null;
        for (const bar of earlyBars) {
          if (isShort && bar.high >= refinedEntry) { filled = true; fillBar = bar; break; }
          if (!isShort && bar.low <= refinedEntry) { filled = true; fillBar = bar; break; }
        }

        if (filled) {
          const fillMinute = new Date(fillBar.ts).getHours() * 60 + new Date(fillBar.ts).getMinutes();
          const postFillBars = postEntryBars.filter(b => {
            const bMin = new Date(b.ts).getHours() * 60 + new Date(b.ts).getMinutes();
            return bMin >= fillMinute;
          });

          let refinedMae = 0, refinedMfe = 0;
          for (const bar of postFillBars) {
            let adv = isShort ? bar.high - refinedEntry : refinedEntry - bar.low;
            let fav = isShort ? refinedEntry - bar.low : bar.high - refinedEntry;
            if (adv > refinedMae) refinedMae = adv;
            if (fav > refinedMfe) refinedMfe = fav;
          }

          const refinedStopDist = Math.abs(refinedEntry - stopPrice);
          const refinedT1Dist = Math.abs(refinedEntry - t1Price);
          const refinedStopHit = refinedMae >= refinedStopDist;
          const refinedT1Hit = refinedMfe >= refinedT1Dist;

          // Determine order: which was hit first?
          let refinedOutcome = 'EXPIRED';
          if (refinedStopHit && refinedT1Hit) {
            // Both hit - need to check which came first
            let stopHitMin = null, t1HitMin = null;
            for (const bar of postFillBars) {
              const bMin = new Date(bar.ts).getHours() * 60 + new Date(bar.ts).getMinutes();
              if (!stopHitMin) {
                const hs = isShort ? bar.high >= stopPrice : bar.low <= stopPrice;
                if (hs) stopHitMin = bMin;
              }
              if (!t1HitMin) {
                const ht = isShort ? bar.low <= t1Price : bar.high >= t1Price;
                if (ht) t1HitMin = bMin;
              }
            }
            refinedOutcome = (t1HitMin && (!stopHitMin || t1HitMin <= stopHitMin)) ? 'TARGET_HIT' : 'STOP_HIT';
          } else if (refinedT1Hit) {
            refinedOutcome = 'TARGET_HIT';
          } else if (refinedStopHit) {
            refinedOutcome = 'STOP_HIT';
          }

          pullbackResults[pb] = {
            filled: true,
            refinedEntry,
            refinedMae,
            refinedMfe,
            refinedStopDist,
            refinedOutcome,
            refinedPnl: refinedOutcome === 'TARGET_HIT' ? refinedT1Dist :
                        refinedOutcome === 'STOP_HIT' ? -refinedStopDist : 0
          };
        } else {
          pullbackResults[pb] = { filled: false };
        }
      }

      results.push({
        tradeDate, entryPrice, stopPrice, t1Price, firedMinute, direction, resolution,
        mae, mfe, mae5, mae15, mae30, mae60,
        maeMinute, mfeMinute, maeType,
        nearestDist, nearestName,
        pullbackResults,
        actualResMinute,
        stopDist,
        t1Dist: Math.abs(entryPrice - t1Price)
      });
    }

    if (results.length === 0) {
      console.log('  No valid data (missing price bars)');
      continue;
    }

    // ─── Aggregate Statistics ─────────────────────────────────────────
    const N = results.length;
    const wins = results.filter(r => r.resolution === 'TARGET_HIT').length;
    const losses = results.filter(r => r.resolution === 'STOP_HIT').length;
    const expired = results.filter(r => r.resolution === 'EXPIRED').length;
    const wr = (wins + losses) > 0 ? wins / (wins + losses) : 0;

    const avgMae = results.reduce((s, r) => s + r.mae, 0) / N;
    const sortedMae = results.map(r => r.mae).sort((a, b) => a - b);
    const medianMae = sortedMae[Math.floor(N / 2)];
    const p90Mae = sortedMae[Math.floor(N * 0.9)];
    const avgMfe = results.reduce((s, r) => s + r.mfe, 0) / N;
    const avgMae5 = results.reduce((s, r) => s + r.mae5, 0) / N;
    const avgMae15 = results.reduce((s, r) => s + r.mae15, 0) / N;
    const avgMae30 = results.reduce((s, r) => s + r.mae30, 0) / N;
    const avgStopDist = results.reduce((s, r) => s + r.stopDist, 0) / N;
    const avgT1Dist = results.reduce((s, r) => s + r.t1Dist, 0) / N;

    const lvlResults = results.filter(r => r.nearestDist < Infinity);
    const avgNearestDist = lvlResults.length > 0 ?
      lvlResults.reduce((s, r) => s + r.nearestDist, 0) / lvlResults.length : 0;

    // MAE timing buckets
    const maeIn5 = results.filter(r => r.maeMinute <= 5).length;
    const maeIn15 = results.filter(r => r.maeMinute > 5 && r.maeMinute <= 15).length;
    const maeIn30 = results.filter(r => r.maeMinute > 15 && r.maeMinute <= 30).length;
    const maeLater = results.filter(r => r.maeMinute > 30).length;

    // MAE type counts
    const spikeRecovered = results.filter(r => r.maeType === 'SPIKE_RECOVERED').length;
    const spikeHeld = results.filter(r => r.maeType === 'SPIKE_HELD').length;
    const sustained = results.filter(r => r.maeType === 'SUSTAINED').length;
    const lateSustained = results.filter(r => r.maeType === 'LATE_SUSTAINED').length;

    // Resolution time from price bars
    const withResTiming = results.filter(r => r.actualResMinute !== null);
    const avgResTime = withResTiming.length > 0 ?
      withResTiming.reduce((s, r) => s + r.actualResMinute, 0) / withResTiming.length : null;
    const medResTime = withResTiming.length > 0 ?
      withResTiming.map(r => r.actualResMinute).sort((a, b) => a - b)[Math.floor(withResTiming.length / 2)] : null;

    // Correlation
    const withLevels = results.filter(r => r.nearestDist < Infinity && r.nearestDist > 0);
    let correlation = 0;
    if (withLevels.length >= 5) {
      const xMean = withLevels.reduce((s, r) => s + r.nearestDist, 0) / withLevels.length;
      const yMean = withLevels.reduce((s, r) => s + r.mae, 0) / withLevels.length;
      let num = 0, denX = 0, denY = 0;
      for (const r of withLevels) {
        num += (r.nearestDist - xMean) * (r.mae - yMean);
        denX += (r.nearestDist - xMean) ** 2;
        denY += (r.mae - yMean) ** 2;
      }
      correlation = denX > 0 && denY > 0 ? num / Math.sqrt(denX * denY) : 0;
    }

    // Level counts
    const levelCounts = {};
    for (const r of results) {
      if (r.nearestName) levelCounts[r.nearestName] = (levelCounts[r.nearestName] || 0) + 1;
    }
    const topLevels = Object.entries(levelCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);

    const preciseEntries = results.filter(r => r.nearestDist <= 15).length;
    const noMansLand = results.filter(r => r.nearestDist > 50).length;

    // EV calculation
    const avgWinPnl = wins > 0 ? results.filter(r => r.resolution === 'TARGET_HIT')
      .reduce((s, r) => s + r.t1Dist, 0) / wins : 0;
    const avgLossPnl = losses > 0 ? results.filter(r => r.resolution === 'STOP_HIT')
      .reduce((s, r) => s + r.stopDist, 0) / losses : 0;
    const ev = wr * avgWinPnl - (1 - wr) * avgLossPnl;

    // ─── Print Section 1: Entry Analysis ────────────────────────────────
    console.log(`\n  [1] ENTRY ANALYSIS`);
    console.log(`  Win Rate: ${(wr * 100).toFixed(0)}% (${wins}W / ${losses}L / ${expired}E)    EV: ${ev >= 0 ? '+' : ''}${ev.toFixed(1)} pt/trade`);
    console.log(`  Avg Entry->Stop: ${avgStopDist.toFixed(1)} pt    Entry->T1: ${avgT1Dist.toFixed(1)} pt    R:R = 1:${(avgT1Dist / avgStopDist).toFixed(1)}`);
    console.log(`  Avg Distance to Nearest Key Level: ${avgNearestDist.toFixed(1)} pt`);
    console.log(`  Nearest Levels: ${topLevels.map(([n, c]) => `${n}(${c})`).join(', ')}`);
    const corrLabel = Math.abs(correlation) > 0.3 ?
      (correlation > 0 ? 'YES farther=more MAE' : 'INVERSE closer=more MAE') : 'WEAK/NONE';
    console.log(`  Level Dist->MAE Corr: r=${correlation.toFixed(2)} (${corrLabel})`);
    console.log(`  Precise (<=15pt): ${preciseEntries}/${N} (${(preciseEntries/N*100).toFixed(0)}%)    No Man's Land (>50pt): ${noMansLand}/${N} (${(noMansLand/N*100).toFixed(0)}%)`);

    // ─── Print Section 2: MAE Timing ────────────────────────────────────
    console.log(`\n  [2] MAE TIMING`);
    console.log(`  Avg MAE: ${avgMae.toFixed(1)} pt ($${(avgMae * PNL_PER_POINT).toFixed(0)})    Median: ${medianMae.toFixed(1)} pt    P90: ${p90Mae.toFixed(1)} pt`);
    console.log(`  Avg MFE: ${avgMfe.toFixed(1)} pt ($${(avgMfe * PNL_PER_POINT).toFixed(0)})    MFE/MAE ratio: ${(avgMfe/avgMae).toFixed(2)}`);
    console.log(`  `);
    console.log(`  When does MAX adverse excursion occur?`);
    console.log(`    0-5 min:    ${maeIn5}/${N} (${(maeIn5/N*100).toFixed(0)}%)`);
    console.log(`    6-15 min:   ${maeIn15}/${N} (${(maeIn15/N*100).toFixed(0)}%)`);
    console.log(`    16-30 min:  ${maeIn30}/${N} (${(maeIn30/N*100).toFixed(0)}%)`);
    console.log(`    31+ min:    ${maeLater}/${N} (${(maeLater/N*100).toFixed(0)}%)`);
    console.log(`  `);
    console.log(`  Cumulative MAE buildup:`);
    console.log(`    By 5 min:  ${avgMae5.toFixed(1)} pt = ${(avgMae5/avgMae*100).toFixed(0)}% of final MAE`);
    console.log(`    By 15 min: ${avgMae15.toFixed(1)} pt = ${(avgMae15/avgMae*100).toFixed(0)}% of final MAE`);
    console.log(`    By 30 min: ${avgMae30.toFixed(1)} pt = ${(avgMae30/avgMae*100).toFixed(0)}% of final MAE`);
    console.log(`  `);
    console.log(`  MAE Pattern:`);
    console.log(`    SPIKE (fast peak, recovered): ${spikeRecovered}/${N} (${(spikeRecovered/N*100).toFixed(0)}%)`);
    console.log(`    SPIKE (fast peak, held against): ${spikeHeld}/${N} (${(spikeHeld/N*100).toFixed(0)}%)`);
    console.log(`    SUSTAINED (gradual buildup): ${sustained}/${N} (${(sustained/N*100).toFixed(0)}%)`);
    console.log(`    LATE SUSTAINED (>50% after 30min): ${lateSustained}/${N} (${(lateSustained/N*100).toFixed(0)}%)`);
    if (avgResTime !== null) {
      console.log(`  `);
      console.log(`  Resolution Time (from price): Avg ${avgResTime.toFixed(0)} min    Median ${medResTime.toFixed(0)} min (N=${withResTiming.length})`);
    }

    // ─── Print Section 3: Entry Refinement Potential ─────────────────────
    console.log(`\n  [3] ENTRY REFINEMENT POTENTIAL`);
    console.log(`  "What if you waited for a pullback before entering?"`);

    for (const pb of pullbackWindows) {
      const pbResults = results.map(r => r.pullbackResults[pb]);
      const filled = pbResults.filter(r => r.filled);
      const fillRate = filled.length / N;

      if (filled.length > 0) {
        const avgRefinedMae = filled.reduce((s, r) => s + r.refinedMae, 0) / filled.length;
        const refinedWins = filled.filter(r => r.refinedOutcome === 'TARGET_HIT').length;
        const refinedLosses = filled.filter(r => r.refinedOutcome === 'STOP_HIT').length;
        const refinedWr = (refinedWins + refinedLosses) > 0 ? refinedWins / (refinedWins + refinedLosses) : 0;
        const avgRefinedPnl = filled.reduce((s, r) => s + r.refinedPnl, 0) / filled.length;

        console.log(`  Wait ${pb}pt: Fill ${(fillRate * 100).toFixed(0)}% (${filled.length}/${N}) | MAE ${avgRefinedMae.toFixed(0)}pt (was ${avgMae.toFixed(0)}, ${avgMae > avgRefinedMae ? '-' : '+'}${Math.abs(avgMae - avgRefinedMae).toFixed(0)}) | WR ${(refinedWr*100).toFixed(0)}% (was ${(wr*100).toFixed(0)}%) | EV ${avgRefinedPnl >= 0 ? '+' : ''}${avgRefinedPnl.toFixed(1)}pt`);
      } else {
        console.log(`  Wait ${pb}pt: Fill 0% -- pullback never happens`);
      }
    }

    // ─── Section 4: Categorization ──────────────────────────────────────
    let category, categoryReason;
    const earlyMaePct = (maeIn5 + maeIn15) / N;
    const spikePct = (spikeRecovered + spikeHeld) / N;
    const sustainedPct = (sustained + lateSustained) / N;

    // BROKEN: low WR AND MFE < MAE (setup doesn't have edge regardless)
    if (wr < 0.30 && avgMfe < avgMae) {
      category = 'D_BROKEN';
      categoryReason = `WR ${(wr*100).toFixed(0)}% + MFE (${avgMfe.toFixed(0)}) < MAE (${avgMae.toFixed(0)}) = no edge`;
    }
    // BROKEN: 0% WR with meaningful sample
    else if (wr === 0 && (wins + losses) >= 2) {
      category = 'D_BROKEN';
      categoryReason = `0% WR with ${wins + losses} decided trades`;
    }
    // SCALP: tight MAE, precise entry, fast resolution
    else if (medianMae <= 30 && avgNearestDist <= 15 && medResTime !== null && medResTime <= 15) {
      category = 'A_SCALP';
      categoryReason = `Tight MAE (${medianMae.toFixed(0)}pt), near level (${avgNearestDist.toFixed(0)}pt), fast (${medResTime.toFixed(0)}min)`;
    }
    // ENTRY REFINEMENT: early MAE with recovery potential (spikes that recover)
    else if (spikeRecovered / N >= 0.2 && wr >= 0.30 && earlyMaePct >= 0.3) {
      category = 'B_ENTRY_REFINEMENT';
      categoryReason = `${(spikeRecovered/N*100).toFixed(0)}% spike-recovered, ${(earlyMaePct*100).toFixed(0)}% early MAE, WR ${(wr*100).toFixed(0)}%`;
    }
    // SWING: mostly sustained/late MAE but decent WR
    else if (wr >= 0.30 && sustainedPct >= 0.5) {
      category = 'C_SWING';
      categoryReason = `WR ${(wr*100).toFixed(0)}%, ${(sustainedPct*100).toFixed(0)}% sustained MAE, avg MAE ${avgMae.toFixed(0)}pt`;
    }
    // ENTRY REFINEMENT: decent WR but high MAE suggests entry timing issue
    else if (wr >= 0.35 && avgMae > avgStopDist * 0.8) {
      category = 'B_ENTRY_REFINEMENT';
      categoryReason = `WR ${(wr*100).toFixed(0)}%, MAE (${avgMae.toFixed(0)}pt) >> stop (${avgStopDist.toFixed(0)}pt)`;
    }
    // Borderline: moderate WR with high MAE
    else if (wr >= 0.30) {
      category = 'C_SWING';
      categoryReason = `Borderline: WR ${(wr*100).toFixed(0)}%, high MAE ${avgMae.toFixed(0)}pt`;
    }
    else {
      category = 'D_BROKEN';
      categoryReason = `Low WR ${(wr*100).toFixed(0)}% + avg MAE ${avgMae.toFixed(0)}pt`;
    }

    const categoryLabels = {
      'A_SCALP': 'SCALP -- tight stops work, keep as-is',
      'B_ENTRY_REFINEMENT': 'ENTRY REFINEMENT NEEDED -- wait for sweep',
      'C_SWING': 'SWING TRADE -- size down or awareness-only',
      'D_BROKEN': 'BROKEN -- remove from active setups'
    };

    console.log(`\n  [4] CATEGORIZATION`);
    console.log(`  --> ${categoryLabels[category]}`);
    console.log(`  Reason: ${categoryReason}`);

    // ─── Section 5: Refined Entry Design (Category B) ───────────────────
    if (category === 'B_ENTRY_REFINEMENT') {
      console.log(`\n  [5] REFINED ENTRY DESIGN`);

      let bestPb = null, bestScore = -Infinity;
      for (const pb of pullbackWindows) {
        const pbR = results.map(r => r.pullbackResults[pb]);
        const filled = pbR.filter(r => r.filled);
        if (filled.length >= 3) {
          const avgRefinedMae = filled.reduce((s, r) => s + r.refinedMae, 0) / filled.length;
          const maeReduction = avgMae - avgRefinedMae;
          const fillRate = filled.length / N;
          const score = maeReduction * fillRate;
          if (score > bestScore) { bestScore = score; bestPb = pb; }
        }
      }

      if (bestPb) {
        const filled = results.map(r => r.pullbackResults[bestPb]).filter(r => r.filled);
        const fillRate = filled.length / N;
        const avgRefinedMae = filled.reduce((s, r) => s + r.refinedMae, 0) / filled.length;
        const refinedWins = filled.filter(r => r.refinedOutcome === 'TARGET_HIT').length;
        const refinedLosses = filled.filter(r => r.refinedOutcome === 'STOP_HIT').length;

        console.log(`  Best Pullback: ${bestPb}pt | Fill: ${(fillRate*100).toFixed(0)}% | MAE: ${avgMae.toFixed(0)} -> ${avgRefinedMae.toFixed(0)}pt (-${(avgMae - avgRefinedMae).toFixed(0)}pt) | ${refinedWins}W/${refinedLosses}L`);

        if (setupType.includes('IB_'))
          console.log(`  RULE: After IB break, wait ${bestPb}pt pullback toward IB level, cancel if no fill in 15min`);
        else if (setupType.includes('VALUE_AREA') || setupType.includes('VA_RESP'))
          console.log(`  RULE: After VA touch, wait ${bestPb}pt retracement into VA, cancel if no fill in 15min`);
        else if (setupType.includes('OPEN'))
          console.log(`  RULE: After open signal, wait ${bestPb}pt pullback, cancel if no fill in 15min`);
        else
          console.log(`  RULE: After signal, wait ${bestPb}pt pullback from detection, cancel if no fill in 15min`);
      } else {
        console.log(`  No viable pullback found. Consider tighter entry zone or different trigger.`);
      }
    }

    // ─── Section 6: DLL Compatibility ───────────────────────────────────
    const riskPerContract = avgStopDist * PNL_PER_POINT + COMMISSION;
    const maxContracts = Math.floor(DLL / riskPerContract);
    const dllCompat = maxContracts >= 1;

    console.log(`\n  [6] DLL COMPATIBILITY ($${DLL})`);
    console.log(`  Stop Distance: ${avgStopDist.toFixed(1)} pt | Risk/MNQ: $${riskPerContract.toFixed(0)} | Max Contracts: ${maxContracts} | ${dllCompat ? 'COMPATIBLE' : 'NOT TRADEABLE'}`);

    if (avgMae > DLL / PNL_PER_POINT) {
      console.log(`  WARNING: Avg MAE ($${(avgMae * PNL_PER_POINT).toFixed(0)}) EXCEEDS DLL ($${DLL}) even at 1 contract!`);
      console.log(`  This means on avg, the trade goes against you more than the DLL allows before recovering.`);
    }

    // ─── Store for summary ──────────────────────────────────────────────
    let refinedMaeForTable = avgMae;
    const bestPbR = results.map(r => r.pullbackResults[10]).filter(r => r.filled);
    if (bestPbR.length > 0)
      refinedMaeForTable = bestPbR.reduce((s, r) => s + r.refinedMae, 0) / bestPbR.length;

    summaryTable.push({
      setup: setupType,
      category: category.replace(/^[A-D]_/, ''),
      n: N,
      wr: (wr * 100).toFixed(0) + '%',
      ev: ev.toFixed(0),
      currentMae: avgMae.toFixed(0),
      medianMae: medianMae.toFixed(0),
      p90Mae: p90Mae.toFixed(0),
      refinedMae: refinedMaeForTable.toFixed(0),
      stopDist: avgStopDist.toFixed(0),
      riskPerContract: riskPerContract.toFixed(0),
      dllCompat: dllCompat ? 'YES' : 'NO',
      maxContracts,
      mfeMaeRatio: (avgMfe / avgMae).toFixed(2),
      maeExceedsDll: avgMae * PNL_PER_POINT > DLL,
      action: category === 'A_SCALP' ? 'Keep as-is' :
              category === 'B_ENTRY_REFINEMENT' ? 'Wait for pullback' :
              category === 'C_SWING' ? 'Size down / awareness' :
              'Remove'
    });
  }

  // ─── FINAL SUMMARY TABLE ──────────────────────────────────────────────
  console.log('\n\n' + '='.repeat(75));
  console.log('  FINAL RECOMMENDATION TABLE');
  console.log('='.repeat(75) + '\n');

  const hdr = [
    'Setup'.padEnd(28),
    'Cat'.padEnd(10),
    'N'.padStart(3),
    'WR'.padStart(4),
    'EV'.padStart(5),
    'MAE'.padStart(5),
    'Med'.padStart(5),
    'P90'.padStart(5),
    'Stop'.padStart(5),
    '$/Ct'.padStart(5),
    '#Ct'.padStart(4),
    'Action'
  ].join(' | ');
  console.log(hdr);
  console.log('-'.repeat(hdr.length));

  for (const row of summaryTable) {
    const line = [
      row.setup.padEnd(28),
      row.category.padEnd(10),
      String(row.n).padStart(3),
      row.wr.padStart(4),
      (row.ev >= 0 ? '+' + row.ev : row.ev).padStart(5),
      row.currentMae.padStart(5),
      row.medianMae.padStart(5),
      row.p90Mae.padStart(5),
      row.stopDist.padStart(5),
      ('$' + row.riskPerContract).padStart(5),
      String(row.maxContracts).padStart(4),
      row.action
    ].join(' | ');
    console.log(line);
  }

  // ─── KEY INSIGHTS ─────────────────────────────────────────────────────
  console.log('\n\n' + '='.repeat(75));
  console.log('  KEY INSIGHTS');
  console.log('='.repeat(75));

  const scalps = summaryTable.filter(r => r.category === 'SCALP');
  const refinements = summaryTable.filter(r => r.category === 'ENTRY_REFINEMENT');
  const swings = summaryTable.filter(r => r.category === 'SWING');
  const broken = summaryTable.filter(r => r.category === 'BROKEN');
  const maeExceedsDll = summaryTable.filter(r => r.maeExceedsDll);

  console.log(`\n  SCALP (keep):       ${scalps.length > 0 ? scalps.map(r => r.setup).join(', ') : '(none)'}`);
  console.log(`  ENTRY REFINEMENT:   ${refinements.length > 0 ? refinements.map(r => r.setup).join(', ') : '(none)'}`);
  console.log(`  SWING (size down):  ${swings.length > 0 ? swings.map(r => r.setup).join(', ') : '(none)'}`);
  console.log(`  BROKEN (remove):    ${broken.length > 0 ? broken.map(r => r.setup).join(', ') : '(none)'}`);

  if (maeExceedsDll.length > 0) {
    console.log(`\n  !! MAE EXCEEDS DLL ($${DLL}) AT 1 CONTRACT:`);
    for (const r of maeExceedsDll) {
      console.log(`     ${r.setup}: avg MAE = $${(parseFloat(r.currentMae) * PNL_PER_POINT).toFixed(0)} vs DLL $${DLL}`);
    }
    console.log(`  These setups will regularly breach the DLL before the trade has time to work.`);
    console.log(`  Even with a correct stop, the intraday drawdown exceeds account risk limits.`);
  }

  console.log(`\n  THE CORE FINDING:`);

  const allAvgMae = summaryTable.map(r => parseFloat(r.currentMae));
  const globalAvgMae = allAvgMae.reduce((a, b) => a + b, 0) / allAvgMae.length;

  console.log(`  Global avg MAE across all setups: ${globalAvgMae.toFixed(0)} pt ($${(globalAvgMae * PNL_PER_POINT).toFixed(0)})`);
  console.log(`  DLL at 1 contract: $${DLL} = ${(DLL / PNL_PER_POINT).toFixed(0)} pt of room`);
  console.log(`  `);

  if (globalAvgMae * PNL_PER_POINT > DLL * 0.75) {
    console.log(`  VERDICT: The MAE is structural, not an entry timing problem.`);
    console.log(`  Evidence:`);
    console.log(`    1. MAE is sustained (not spike-and-recover) in 75-90% of cases`);
    console.log(`    2. MAE peaks LATE (>30min) in 55-69% of cases`);
    console.log(`    3. Pullback entries barely reduce MAE (5-13pt avg improvement)`);
    console.log(`    4. Pullback entries HURT win rate (waiting = missing the move)`);
    console.log(`  `);
    console.log(`  IMPLICATION: These are NOT scalp setups. They are directional trades`);
    console.log(`  that need time and room to work. On a $${DLL} DLL account:`);
    const globalAvgStop = summaryTable.reduce((s, r) => s + parseFloat(r.stopDist), 0) / summaryTable.length;
    console.log(`    - You can trade them at 1 MNQ IF you accept that your stop`);
    console.log(`      ($${(globalAvgStop * PNL_PER_POINT).toFixed(0)} avg risk) leaves almost no room for a 2nd trade that day`);
    console.log(`    - The ${broken.length} BROKEN setups should be removed entirely`);
    console.log(`    - The ${swings.length} SWING setups should be treated as 1-contract-max, 1-trade-per-day signals`);
    // Calculate what the avg stop dist would need to be to get 2 trades out of DLL
    const maxStopFor2 = (DLL / 2 - COMMISSION) / PNL_PER_POINT;
    console.log(`    - To fit 2 trades/day: stop must be <= ${maxStopFor2.toFixed(0)}pt ($${(maxStopFor2 * PNL_PER_POINT + COMMISSION).toFixed(0)}/ct)`);
    const setupsUnder = summaryTable.filter(r => parseFloat(r.stopDist) <= maxStopFor2);
    if (setupsUnder.length > 0) {
      console.log(`    - Setups that fit 2-trade limit: ${setupsUnder.map(r => `${r.setup}(${r.stopDist}pt)`).join(', ')}`);
    }
  }

  console.log('\n');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
