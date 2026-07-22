// =============================================================================
// PILOT — intrabar CVD (order-flow) divergence at a level-fade touch (exploratory,
// not persisted to performance_audit).
//
// Idea (user, 2026-07-21, ranked #1 next idea after the candlestick investigation):
// drop the candle-SHAPE requirement entirely and go straight to order flow --
// does price making a new adverse extreme within the reaction window WHILE net
// delta (ask_volume vs bid_volume on that same bar) is already turning favorable
// predict a real reversal? Classic bullish/bearish divergence, at bar resolution
// instead of the daily-aggregate CVD_DAILY signal that already exists.
//
// Definition, kept simple and zero-crossing-based (no arbitrary magnitude
// threshold, matching the no-static-thresholds spirit the same way touchQuality.js's
// gaveFurtherGround boolean does): within the reaction window, track the running
// adverse extreme (min low for a LONG fade, max high for SHORT) bar by bar. The
// FIRST bar that both (a) makes a new adverse extreme vs everything seen so far in
// the window AND (b) has net FAVORABLE delta on that same bar (ask_volume >
// bid_volume for LONG, bid_volume > ask_volume for SHORT) is the divergence point.
//
// Simple structure, directly comparable to the very first candle-pattern pilot
// (PATTERN_PRESENT vs NO_PATTERN using the ORIGINAL resolution/actual_pnl) --
// deliberately NOT the more complex re-entry-resimulation structure used for the
// overshoot test, to avoid reintroducing that exact entry-price confound on a
// brand-new signal's first pass.
// =============================================================================

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function replayFull(bars, entry, stop, t1, direction) {
  let resolution = 'EXPIRED', barsToResolution = 0;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    barsToResolution = i + 1;
    const stopHit = direction === 'LONG' ? bar.low <= stop : bar.high >= stop;
    const targetHit = direction === 'LONG' ? bar.high >= t1 : bar.low <= t1;
    if (stopHit) { resolution = 'STOP_HIT'; break; }
    if (targetHit) { resolution = 'TARGET_HIT'; break; }
  }
  return { resolution, barsToResolution };
}

function summarize(label, rows) {
  const n = rows.length;
  if (n === 0) return `    ${label.padEnd(20)} n=0`;
  const wins = rows.filter(r => r.resolution === 'TARGET_HIT').length;
  const wr = (wins / n * 100).toFixed(1);
  const evs = rows.map(r => Number(r.actual_pnl)).filter(v => Number.isFinite(v));
  const ev = evs.length ? (evs.reduce((a, b) => a + b, 0) / evs.length).toFixed(2) : 'n/a';
  const flag = n >= 20 ? '' : ' (N<20)';
  let rigorStr = '';
  if (n >= 20) {
    const rigor = computeRigor(rows, { dateField: 'dateStr', pnlFn: r => Number(r.actual_pnl) });
    rigorStr = `  clustered=${rigor.clustered} stable=${rigor.stable}`;
  }
  return `    ${label.padEnd(20)} n=${String(n).padEnd(5)} WR=${wr.padStart(5)}%  EV=$${ev}${flag}${rigorStr}`;
}

const SETUP_TYPES = process.argv[2] ? process.argv.slice(2) : null;

async function main() {
  let setupTypes = SETUP_TYPES;
  if (!setupTypes) {
    const r = await query(`
      SELECT setup_type FROM active_setups
      WHERE resolution_method = 'BACKFILL' AND resolution IN ('STOP_HIT', 'TARGET_HIT')
        AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL AND actual_pnl IS NOT NULL
      GROUP BY setup_type HAVING COUNT(*) >= 50
    `);
    setupTypes = r.rows.map(x => x.setup_type);
  }

  const pooledDiv = [], pooledNoDiv = [], pooledNever = [];

  for (const setupType of setupTypes) {
    const direction = directionFromType(setupType);
    const setupsRes = await query(`
      SELECT id, trade_date, fired_at, resolution, actual_pnl,
             entry_zone_low::float AS entry_low, COALESCE(entry_zone_high, entry_zone_low)::float AS entry_high,
             stop_level::float AS stop, t1_level::float AS t1
      FROM active_setups
      WHERE setup_type = $1 AND resolution_method = 'BACKFILL' AND resolution IN ('STOP_HIT', 'TARGET_HIT')
        AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL AND actual_pnl IS NOT NULL
      ORDER BY trade_date, fired_at
    `, [setupType]);
    const setups = setupsRes.rows;
    if (setups.length < 50) continue;

    const byDate = new Map();
    for (const s of setups) {
      const d = typeof s.trade_date === 'string' ? s.trade_date.slice(0, 10) : s.trade_date.toISOString().slice(0, 10);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(s);
    }

    const enriched = [];
    for (const [date, dateSetups] of byDate) {
      const barsRes = await query(`
        SELECT ts, open::float, high::float, low::float, close::float,
               COALESCE(bid_volume,0)::int AS bid_volume, COALESCE(ask_volume,0)::int AS ask_volume
        FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1 ORDER BY ts
      `, [date]);
      const allBars = barsRes.rows;
      for (const s of dateSetups) {
        const bars = allBars.filter(b => b.ts > s.fired_at);
        if (bars.length === 0) continue;
        const entry = (s.entry_low + s.entry_high) / 2;
        const { resolution, barsToResolution } = replayFull(bars, entry, s.stop, s.t1, direction);
        enriched.push({ ...s, dateStr: date, resolution, barsToResolution, bars });
      }
    }
    if (enriched.length === 0) continue;

    const barsToResList = enriched.map(r => r.barsToResolution).sort((a, b) => a - b);
    const windowBars = Math.max(1, Math.ceil(percentile(barsToResList, 0.25)));

    // 3-way split to isolate the volume condition's real marginal contribution --
    // "made a new adverse extreme within the window" is likely already a bad sign
    // on its own (the trade extended further before resolving), same confound
    // class as the TWEEZER tautology found earlier today. NEVER_EXTREME vs
    // EXTREME_UNFAVORABLE_VOL vs EXTREME_FAVORABLE_VOL (=CVD_DIVERGENCE) lets us
    // compare the latter two -- both "made a new extreme," differing ONLY in
    // whether that extending bar had contrary volume -- to see if volume adds
    // anything beyond the raw fact of extending further.
    const divRows = [], extremeNoVolRows = [], neverExtremeRows = [];
    for (const r of enriched) {
      const win = r.bars.slice(0, Math.min(windowBars, r.barsToResolution));
      let runningExtreme = direction === 'LONG' ? win[0]?.low : win[0]?.high;
      let madeExtreme = false, divergenceFound = false;
      for (let i = 1; i < win.length; i++) {
        const bar = win[i];
        const makesNewExtreme = direction === 'LONG' ? bar.low < runningExtreme : bar.high > runningExtreme;
        if (direction === 'LONG') runningExtreme = Math.min(runningExtreme, bar.low);
        else runningExtreme = Math.max(runningExtreme, bar.high);
        if (!makesNewExtreme) continue;
        madeExtreme = true;
        const favorableDelta = direction === 'LONG' ? bar.ask_volume > bar.bid_volume : bar.bid_volume > bar.ask_volume;
        if (favorableDelta) { divergenceFound = true; break; }
      }
      if (divergenceFound) divRows.push(r);
      else if (madeExtreme) extremeNoVolRows.push(r);
      else neverExtremeRows.push(r);
    }

    console.log(`\n### ${setupType}  (N=${enriched.length}, window=${windowBars} bars)`);
    console.log(summarize('CVD_DIVERGENCE', divRows));
    console.log(summarize('EXTREME_NO_FAV_VOL', extremeNoVolRows));
    console.log(summarize('NEVER_EXTREME', neverExtremeRows));
    pooledDiv.push(...divRows); pooledNoDiv.push(...extremeNoVolRows); pooledNever.push(...neverExtremeRows);
  }

  console.log('\n' + '='.repeat(90));
  console.log('POOLED');
  console.log('='.repeat(90));
  console.log(summarize('CVD_DIVERGENCE', pooledDiv));
  console.log(summarize('EXTREME_NO_FAV_VOL', pooledNoDiv));
  console.log(summarize('NEVER_EXTREME', pooledNever));
  console.log(`\nCVD_DIVERGENCE minus EXTREME_NO_FAV_VOL (the volume condition's real marginal contribution, both buckets already "made a new extreme"):`);
  const divN = pooledDiv.length, noVolN = pooledNoDiv.length;
  const divEv = pooledDiv.reduce((s, x) => s + Number(x.actual_pnl), 0) / divN;
  const noVolEv = pooledNoDiv.reduce((s, x) => s + Number(x.actual_pnl), 0) / noVolN;
  console.log(`  $${(divEv - noVolEv).toFixed(2)}/trade`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
