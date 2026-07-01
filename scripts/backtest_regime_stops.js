/**
 * Regime-Stratified Stop Recalibration
 *
 * Re-runs the MAE/EV stop sweep from mae_stop_recalibration.js but stratified
 * by morning volatility regime (HIGH-VOL-DIRECTIONAL / HIGH-VOL-CHOP /
 * NORMAL-VOL / LOW-VOL), using the same methodology as volatilityRegimeService.js.
 *
 * For each setup type, answers: is the aggregate 180-day optimal stop stable
 * across regimes, or does it need regime-conditional adjustments before being
 * applied to live acd.js?
 *
 * REPORT ONLY — does not write to any table.
 * No lookahead: each date's regime baseline uses only sessions prior to that date.
 */

import { query } from '../server/db.js';

const PNL_PER_POINT = 2;
const COMMISSION    = 1;
const N_BASELINE    = 60;   // trailing sessions for vol baseline (matches live service)
const MIN_N         = 5;    // minimum fires for a regime bucket to report

// ─── UTILITIES ───────────────────────────────────────────────────────────────

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function fiveMinBars(oneMinBars) {
  const buckets = {};
  for (const b of oneMinBars) {
    const k = Math.floor(b.et_min / 5) * 5;
    if (!buckets[k]) buckets[k] = { et_min: k, open: b.open, high: b.high, low: b.low, close: b.close };
    else {
      buckets[k].high  = Math.max(buckets[k].high, b.high);
      buckets[k].low   = Math.min(buckets[k].low,  b.low);
      buckets[k].close = b.close;
    }
  }
  return Object.values(buckets).sort((a, b) => a.et_min - b.et_min);
}

function stdevLogReturns(bars) {
  if (bars.length < 3) return null;
  const rets = [];
  for (let i = 1; i < bars.length; i++) {
    const c0 = bars[i-1].close, c1 = bars[i].close;
    if (c0 > 0 && c1 > 0) rets.push(Math.log(c1 / c0));
  }
  if (rets.length < 2) return null;
  const m = rets.reduce((s, x) => s + x, 0) / rets.length;
  return Math.sqrt(rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1));
}

function getPercentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] * (1 - (idx - lo)) + sorted[hi] * (idx - lo);
}

function pad(str, len, align = 'left') {
  str = String(str);
  return align === 'right' ? str.padStart(len) : str.padEnd(len);
}

// ─── REGIME CLASSIFICATION (mirrors volatilityRegimeService.js) ──────────────

function classifyRegime(morningVol, baseline, trendStr) {
  if (morningVol == null || !baseline) return 'UNKNOWN';
  const { pct80, pct20 } = baseline;
  if (pct80 == null || pct20 == null) return 'UNKNOWN';
  if (morningVol >= pct80) return trendStr >= 0.50 ? 'HIGH-VOL-DIRECTIONAL' : 'HIGH-VOL-CHOP';
  if (morningVol <= pct20) return 'LOW-VOL';
  return 'NORMAL-VOL';
}

// ─── EV SWEEP ─────────────────────────────────────────────────────────────────

function evSweep(fires) {
  if (fires.length < MIN_N) return null;
  const maes = fires.map(f => f.mae).sort((a, b) => a - b);
  const p25  = percentile(maes, 25);
  const p95  = percentile(maes, 95);
  const sweepMin = Math.max(p25, 5);
  const sweepMax = Math.max(p95, sweepMin + 10);
  const step = (sweepMax - sweepMin) / 9;

  let bestEV = -Infinity, bestStop = sweepMin, bestWR = 0;

  for (let i = 0; i < 10; i++) {
    const testStop = sweepMin + step * i;
    let wins = 0, totalPnl = 0;
    for (const fire of fires) {
      if (fire.mae < testStop) {
        if (fire.mfe >= fire.t1Dist) { wins++; totalPnl += fire.t1Dist * PNL_PER_POINT - COMMISSION; }
        else                          { totalPnl -= COMMISSION; }
      } else {
        totalPnl -= testStop * PNL_PER_POINT + COMMISSION;
      }
    }
    const ev = totalPnl / fires.length;
    if (ev > bestEV) { bestEV = ev; bestStop = testStop; bestWR = wins / fires.length; }
  }
  return { bestStop, bestEV, bestWR, n: fires.length };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║       REGIME-STRATIFIED STOP RECALIBRATION — REPORT ONLY           ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  // ── Step 1: Fetch all morning 1-min bars for regime computation ──────────
  console.log('Loading morning bars for regime classification (9:30–10:30 ET)...');
  const morningBarsQ = await query(`
    SELECT DISTINCT ON (ts)
      ts::date::text as d,
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
      open::float, high::float, low::float, close::float
    FROM price_bars_primary
    WHERE symbol = 'NQ'
      AND ts::date >= CURRENT_DATE - 300
      AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 630
    ORDER BY ts, id DESC
  `);

  // Group by date
  const barsByDate = {};
  for (const b of morningBarsQ.rows) {
    (barsByDate[b.d] ??= []).push(b);
  }

  const allDates = Object.keys(barsByDate).sort();
  console.log(`  ${allDates.length} sessions with morning bar data.\n`);

  // ── Step 2: Compute morning vol and trendStr per date ────────────────────
  const morningVolByDate = {};
  for (const d of allDates) {
    const bars = barsByDate[d].sort((a, b) => a.et_min - b.et_min);
    if (bars.length < 15) continue; // too few 1-min bars to get a reliable 5-min stdev
    const five = fiveMinBars(bars);
    const vol = stdevLogReturns(five);
    if (vol == null) continue;
    const open  = bars[0].open;
    const high  = Math.max(...bars.map(b => b.high));
    const low   = Math.min(...bars.map(b => b.low));
    const close = bars[bars.length - 1].close;
    const range = high - low;
    const trendStr = range > 0 ? Math.abs(close - open) / range : 0;
    morningVolByDate[d] = { vol, trendStr };
  }

  // ── Step 3: Compute trailing-60 baseline (pct80/pct20) per date ──────────
  // Only uses sessions BEFORE each date (no lookahead)
  const datesWithVol = Object.keys(morningVolByDate).sort();
  const regimeByDate = {};

  for (let i = 0; i < datesWithVol.length; i++) {
    const d = datesWithVol[i];
    const prior = datesWithVol.slice(0, i); // strictly before d
    const window = prior.slice(-N_BASELINE);
    if (window.length < 20) { regimeByDate[d] = 'UNKNOWN'; continue; } // not enough history

    const vols = window.map(w => morningVolByDate[w].vol);
    const pct80 = getPercentile(vols, 0.80);
    const pct20 = getPercentile(vols, 0.20);
    const { vol, trendStr } = morningVolByDate[d];
    regimeByDate[d] = classifyRegime(vol, { pct80, pct20 }, trendStr);
  }

  // Summary of regime distribution
  const regimeCounts = {};
  for (const r of Object.values(regimeByDate)) regimeCounts[r] = (regimeCounts[r] || 0) + 1;
  console.log('Regime distribution across all classified sessions:');
  for (const [r, n] of Object.entries(regimeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(r, 24)} ${n} sessions`);
  }
  console.log();

  // ── Step 4: Fetch fires (same query as mae_stop_recalibration.js) ─────────
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

  const firesRes = await query(`
    SELECT id, setup_type, trade_date::text as trade_date,
      fired_at::text as fired_at,
      entry_zone_low::float as entry_low, entry_zone_high::float as entry_high,
      stop_level::float as stop, t1_level::float as t1,
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

  console.log(`Replaying ${firesRes.rows.length} fires bar-by-bar...\n`);

  // ── Step 5: Bar-by-bar replay ─────────────────────────────────────────────
  const resultsBySetup = {};
  let replayed = 0, skipped = 0;

  for (const fire of firesRes.rows) {
    const entry    = (fire.entry_low + fire.entry_high) / 2;
    const isLong   = fire.t1 > entry;
    const stopDist = Math.abs(entry - fire.stop);
    const t1Dist   = Math.abs(fire.t1 - entry);
    const firedAt  = fire.fired_at;
    const endOfDay = `${firedAt.slice(0, 10)} 16:00:00`;

    const barsRes = await query(`
      SELECT open::float, high::float, low::float, close::float
      FROM price_bars_primary
      WHERE symbol = 'NQ' AND ts >= $1 AND ts <= $2
      ORDER BY ts ASC
    `, [firedAt, endOfDay]);

    if (!barsRes.rows.length) { skipped++; continue; }

    let mae = 0, mfe = 0, hitStop = false, hitTarget = false;

    for (const bar of barsRes.rows) {
      const adv = isLong ? entry - bar.low  : bar.high - entry;
      const fav = isLong ? bar.high - entry : entry - bar.low;

      // Same-bar conservative: stop wins
      if (adv >= stopDist && fav >= t1Dist) { hitStop = true; mae = stopDist; break; }
      if (adv >= stopDist) { hitStop = true; mae = stopDist; break; }
      if (fav >= t1Dist)   { hitTarget = true; mfe = Math.max(mfe, fav); mae = Math.max(mae, adv > 0 ? adv : 0); break; }
      mae = Math.max(mae, adv > 0 ? adv : 0);
      mfe = Math.max(mfe, fav > 0 ? fav : 0);
    }

    if (!hitStop && !hitTarget) hitStop = true; // time expired = loss

    const regime = regimeByDate[fire.trade_date] || 'UNKNOWN';

    const rec = {
      tradeDate: fire.trade_date, regime, isLong, stopDist, t1Dist, mae, mfe,
      hitTarget, hitStop,
      pnl: hitTarget
        ? (t1Dist * PNL_PER_POINT - COMMISSION)
        : (-stopDist * PNL_PER_POINT - COMMISSION),
    };

    (resultsBySetup[fire.setup_type] ??= []).push(rec);
    replayed++;
    if (replayed % 50 === 0) process.stdout.write(`  ${replayed}/${firesRes.rows.length} replayed...\r`);
  }
  console.log(`Replayed ${replayed}, skipped ${skipped}.\n`);

  // ── Step 6: Report per setup ──────────────────────────────────────────────
  const REGIMES = ['HIGH-VOL-DIRECTIONAL', 'HIGH-VOL-CHOP', 'NORMAL-VOL', 'LOW-VOL'];
  const VERDICT_THRESHOLD = 20; // pt spread between regimes to flag as regime-conditional

  const actionable = []; // setups where regime changes the optimal stop materially

  for (const setup of setupTypes) {
    const fires = resultsBySetup[setup] || [];
    if (fires.length < MIN_N) continue;

    const aggResult  = evSweep(fires);
    if (!aggResult) continue;

    const currentAvgStop = mean(fires.map(f => f.stopDist));
    const currentEV      = mean(fires.map(f => f.pnl));

    console.log(`┌─── ${setup} (N=${fires.length}) ─────────────────────────────────────────────`);
    console.log(`│  AGGREGATE:  stop=${aggResult.bestStop.toFixed(1)}pt  EV=$${aggResult.bestEV.toFixed(2)}  WR=${(aggResult.bestWR*100).toFixed(1)}%  (current stop=${currentAvgStop.toFixed(1)}pt, current EV=$${currentEV.toFixed(2)})`);

    const regimeResults = {};
    let minStop = Infinity, maxStop = -Infinity;
    let validRegimes = 0;

    for (const regime of REGIMES) {
      const rFires = fires.filter(f => f.regime === regime);
      const res    = evSweep(rFires);
      regimeResults[regime] = { n: rFires.length, result: res };

      if (res) {
        const wr = rFires.filter(f => f.hitTarget).length / rFires.length;
        const ev = mean(rFires.map(f => f.pnl));
        console.log(`│  ${pad(regime, 22)} N=${pad(String(rFires.length), 3)} │ opt stop=${pad(res.bestStop.toFixed(1)+'pt', 8)} │ EV=$${pad(res.bestEV.toFixed(2), 7)} │ WR=${(res.bestWR*100).toFixed(1)}%  (baseline WR=${(wr*100).toFixed(1)}%, EV=$${ev.toFixed(2)})`);
        minStop = Math.min(minStop, res.bestStop);
        maxStop = Math.max(maxStop, res.bestStop);
        validRegimes++;
      } else {
        console.log(`│  ${pad(regime, 22)} N=${rFires.length} — LIMITED SAMPLE (n<${MIN_N})`);
      }
    }

    // Verdict
    const spread = validRegimes >= 2 ? maxStop - minStop : 0;
    if (spread >= VERDICT_THRESHOLD && validRegimes >= 2) {
      const best = REGIMES.find(r => regimeResults[r].result?.bestStop === maxStop);
      const worst = REGIMES.find(r => regimeResults[r].result?.bestStop === minStop);
      console.log(`│`);
      console.log(`│  ⚠  REGIME-CONDITIONAL: ${spread.toFixed(0)}pt spread (${worst} ${minStop.toFixed(0)}pt vs ${best} ${maxStop.toFixed(0)}pt)`);
      console.log(`│     Aggregate ${aggResult.bestStop.toFixed(1)}pt is a compromise — consider regime-specific stops in acd.js`);
      actionable.push({ setup, aggStop: aggResult.bestStop, spread, regimeResults, currentAvgStop, aggEV: aggResult.bestEV, currentEV });
    } else if (validRegimes >= 2) {
      console.log(`│`);
      console.log(`│  ✓  REGIME-STABLE: ${spread.toFixed(0)}pt spread across regimes — aggregate stop is safe to apply`);
    }
    console.log(`└──────────────────────────────────────────────────────────────────────\n`);
  }

  // ── Step 7: Executive summary ─────────────────────────────────────────────
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║                        EXECUTIVE SUMMARY                           ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  if (actionable.length === 0) {
    console.log('All setups with sufficient regime data are REGIME-STABLE.');
    console.log('Aggregate stops from mae_stop_recalibration.js are safe to apply as-is.\n');
  } else {
    console.log(`${actionable.length} setup(s) are REGIME-CONDITIONAL — aggregate stop is a compromise:\n`);
    for (const a of actionable) {
      console.log(`  ${a.setup}`);
      for (const regime of REGIMES) {
        const rr = a.regimeResults[regime];
        if (rr.result) {
          console.log(`    ${pad(regime, 22)} → ${rr.result.bestStop.toFixed(0)}pt stop  (EV=$${rr.result.bestEV.toFixed(2)}, N=${rr.n})`);
        }
      }
      console.log(`    Aggregate (current recommendation): ${a.aggStop.toFixed(0)}pt`);
      console.log();
    }
  }

  const stableSetups = setupTypes.filter(s => {
    const fires = resultsBySetup[s] || [];
    if (fires.length < MIN_N) return false;
    const regStops = REGIMES.map(r => {
      const res = evSweep(fires.filter(f => f.regime === r));
      return res?.bestStop ?? null;
    }).filter(v => v != null);
    if (regStops.length < 2) return true;
    return Math.max(...regStops) - Math.min(...regStops) < VERDICT_THRESHOLD;
  }).filter(s => resultsBySetup[s]?.length >= MIN_N);

  if (stableSetups.length > 0) {
    console.log('Regime-stable setups (safe to apply aggregate stop from OPEN_THREADS item 5):');
    for (const s of stableSetups) {
      const fires = resultsBySetup[s];
      const agg = evSweep(fires);
      const cur = mean(fires.map(f => f.stopDist));
      if (agg) console.log(`  ✓ ${pad(s, 32)} ${cur.toFixed(0)}pt → ${agg.bestStop.toFixed(0)}pt  (EV $${mean(fires.map(f=>f.pnl)).toFixed(2)} → $${agg.bestEV.toFixed(2)})`);
    }
  }
  console.log('\nDone.');
  process.exit(0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
