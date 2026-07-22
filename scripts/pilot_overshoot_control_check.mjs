// =============================================================================
// Control check for the overshoot-then-reversal-pattern re-entry test.
//
// Gemini's corpus-wide run (2026-07-21) found the pattern-timed re-entry beat the
// original blind first-touch entry on the paired "overshot + pattern found"
// subset in 62 of 64 setup_types, uniformly. That near-universal, no-exception
// result is exactly the "too clean, audit before trusting" signal this codebase's
// own history keeps finding bugs behind (see CLAUDE.md's several "looked too
// good" incidents).
//
// The likely confound, worked out by hand before writing this: entering LATER,
// after an adverse move, against the SAME fixed original stop/target, is
// ALGEBRAICALLY favorable regardless of any pattern -- a winning trade pays MORE
// points (you bought/sold the retracement at a better price before the same
// target), and a losing trade costs FEWER points (you're closer to the same
// stop). Since the underlying bar path and stop/target don't change, and the
// original spec excluded any trade whose stop was already hit before the
// overshoot point, the WIN/LOSS outcome for the remaining walk should be
// IDENTICAL whether you mark "entry" at the overshoot bar or at a later
// pattern-confirmation bar -- only the ENTRY PRICE differs. That alone would
// mechanically improve EV almost everywhere, with zero predictive contribution
// from the candle pattern itself.
//
// This script isolates that by adding the missing control: OVERSHOOT_BLIND_ENTRY
// (enter immediately at the overshoot bar, no pattern required) vs
// OVERSHOOT_PATTERN_ENTRY (enter at the pattern-confirmation bar), computed on
// the IDENTICAL paired subset (trades that overshot AND later show a pattern).
// If PATTERN doesn't clearly beat BLIND on this subset, the pattern isn't adding
// anything -- the entire "improvement" Gemini found is just the entry-price
// algebra, not real timing information from the candle shape.
// =============================================================================

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { getBarShapeBaseline, classifyReversalPattern } from '../server/services/candlePatternQuality.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

const DPP = LIVE_INSTRUMENT.dollarsPerPoint;
const COMM = LIVE_INSTRUMENT.commissionPerRoundTrip;

const SETUP_TYPES = process.argv[2]
  ? process.argv.slice(2)
  : null; // null = query all N>=50 setup_types

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function pointsPnl(entry, exitPrice, direction) {
  return direction === 'LONG' ? (exitPrice - entry) : (entry - exitPrice);
}

// Walk bars from a given start index vs fixed stop/target, return {resolution, exitIdx, exitPrice}
function walkToResolution(bars, startIdx, stop, t1, direction) {
  for (let i = startIdx; i < bars.length; i++) {
    const bar = bars[i];
    const stopHit = direction === 'LONG' ? bar.low <= stop : bar.high >= stop;
    const targetHit = direction === 'LONG' ? bar.high >= t1 : bar.low <= t1;
    if (stopHit) return { resolution: 'STOP_HIT', exitIdx: i, exitPrice: stop };
    if (targetHit) return { resolution: 'TARGET_HIT', exitIdx: i, exitPrice: t1 };
  }
  return { resolution: 'EXPIRED', exitIdx: bars.length - 1, exitPrice: bars.length ? bars[bars.length - 1].close : null };
}

const _baselineCache = new Map();
async function getBaseline(date) {
  if (_baselineCache.has(date)) return _baselineCache.get(date);
  const b = await getBarShapeBaseline(query, date, 'NQ', 90);
  _baselineCache.set(date, b);
  return b;
}

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

  const pooled = { origN: 0, origWins: 0, origPnl: 0, blindWins: 0, blindPnl: 0, patternWins: 0, patternPnl: 0 };
  const perSetup = [];
  const allRows = [];

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
      const barsRes = await query(`SELECT ts, open::float, high::float, low::float, close::float FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1 ORDER BY ts`, [date]);
      const allBars = barsRes.rows;
      const baseline = await getBaseline(date);
      for (const s of dateSetups) {
        const bars = allBars.filter(b => b.ts > s.fired_at);
        if (bars.length === 0) continue;
        const entry = (s.entry_low + s.entry_high) / 2;
        // Pass 1: MAE-at-resolution for the overshoot threshold calibration
        let mae = 0, resolved = false;
        for (const bar of bars) {
          const adverse = direction === 'LONG' ? entry - bar.low : bar.high - entry;
          mae = Math.max(mae, adverse);
          const stopHit = direction === 'LONG' ? bar.low <= s.stop : bar.high >= s.stop;
          const targetHit = direction === 'LONG' ? bar.high >= s.t1 : bar.low <= s.t1;
          if (stopHit || targetHit) { resolved = true; break; }
        }
        enriched.push({ ...s, dateStr: date, entry, bars, baseline, maeAtResolution: mae, resolved });
      }
    }
    if (enriched.length === 0) continue;

    const maeList = enriched.filter(r => r.resolved).map(r => r.maeAtResolution).sort((a, b) => a - b);
    if (maeList.length < 20) continue;
    const overshootThreshold = percentile(maeList, 0.5);

    const barsToRes = enriched.map(r => r.bars.length).sort((a, b) => a - b);
    const windowBars = Math.max(1, Math.ceil(percentile(barsToRes, 0.25)));

    const rows = [];
    for (const r of enriched) {
      const stopDistance = Math.abs(r.entry - r.stop);
      if (overshootThreshold >= stopDistance) continue; // stop too tight for this trade

      let overshootIdx = -1, mae = 0;
      for (let i = 0; i < r.bars.length; i++) {
        const bar = r.bars[i];
        const adverse = direction === 'LONG' ? r.entry - bar.low : bar.high - r.entry;
        mae = Math.max(mae, adverse);
        const stopHit = direction === 'LONG' ? bar.low <= r.stop : bar.high >= r.stop;
        const targetHit = direction === 'LONG' ? bar.high >= r.t1 : bar.low <= r.t1;
        if (targetHit && mae < overshootThreshold) { overshootIdx = -1; break; } // never overshot, clean winner
        if (stopHit) { overshootIdx = -1; break; } // shouldn't happen given the stopDistance gate above, defensive
        if (mae >= overshootThreshold) { overshootIdx = i; break; }
      }
      if (overshootIdx === -1) continue;

      // BLIND control: enter at close of the overshoot bar itself, no pattern required
      const blindEntry = r.bars[overshootIdx].close;
      const blindRes = walkToResolution(r.bars, overshootIdx + 1, r.stop, r.t1, direction);
      if (blindRes.resolution === 'EXPIRED') continue; // need a determinate outcome for a fair comparison

      // PATTERN: search the window starting at the overshoot bar
      const win = r.bars.slice(overshootIdx, Math.min(overshootIdx + windowBars, r.bars.length));
      const match = r.baseline ? classifyReversalPattern({ windowBars: win, direction, baseline: r.baseline }) : null;
      if (!match) continue; // only keep the PAIRED subset (overshot AND pattern found) -- matches Gemini's comparison population

      const patternAbsIdx = overshootIdx + match.barIndex;
      const patternEntry = r.bars[patternAbsIdx].close;
      const patternRes = walkToResolution(r.bars, patternAbsIdx + 1, r.stop, r.t1, direction);
      if (patternRes.resolution === 'EXPIRED') continue;

      const blindPnlPts = pointsPnl(blindEntry, blindRes.exitPrice, direction);
      const patternPnlPts = pointsPnl(patternEntry, patternRes.exitPrice, direction);
      const blindPnl = blindPnlPts * DPP - COMM;
      const patternPnl = patternPnlPts * DPP - COMM;

      rows.push({
        pattern: match.pattern,
        origWin: r.resolution === 'TARGET_HIT', origPnl: Number(r.actual_pnl),
        blindWin: blindRes.resolution === 'TARGET_HIT', blindPnl,
        patternWin: patternRes.resolution === 'TARGET_HIT', patternPnl,
      });
    }

    if (rows.length === 0) continue;
    const n = rows.length;
    const origWr = rows.filter(x => x.origWin).length / n;
    const blindWr = rows.filter(x => x.blindWin).length / n;
    const patternWr = rows.filter(x => x.patternWin).length / n;
    const origEv = rows.reduce((s, x) => s + x.origPnl, 0) / n;
    const blindEv = rows.reduce((s, x) => s + x.blindPnl, 0) / n;
    const patternEv = rows.reduce((s, x) => s + x.patternPnl, 0) / n;
    const sameOutcomeCount = rows.filter(x => x.blindWin === x.patternWin).length;

    perSetup.push({ setupType, n, origWr, origEv, blindWr, blindEv, patternWr, patternEv, sameOutcomeCount });
    pooled.origN += n;
    pooled.origWins += rows.filter(x => x.origWin).length; pooled.origPnl += rows.reduce((s, x) => s + x.origPnl, 0);
    pooled.blindWins += rows.filter(x => x.blindWin).length; pooled.blindPnl += rows.reduce((s, x) => s + x.blindPnl, 0);
    pooled.patternWins += rows.filter(x => x.patternWin).length; pooled.patternPnl += rows.reduce((s, x) => s + x.patternPnl, 0);
    for (const row of rows) allRows.push({ ...row, setupType });
  }

  console.log('='.repeat(100));
  console.log('BY PATTERN TYPE: does any specific pattern carry a real edge over BLIND overshoot-entry,');
  console.log('masked by dilution with weaker patterns in the pooled number?');
  console.log('='.repeat(100));
  const byPattern = new Map();
  for (const r of allRows) { if (!byPattern.has(r.pattern)) byPattern.set(r.pattern, []); byPattern.get(r.pattern).push(r); }
  console.log(`${'Pattern'.padEnd(22)} ${'N'.padEnd(6)} ${'SetupsN'.padEnd(9)} ${'BlindEV'.padEnd(10)} ${'PatternEV'.padEnd(10)} ${'Delta'.padEnd(9)} flag`);
  const patternSummary = [];
  for (const [pat, list] of [...byPattern.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const n = list.length;
    const blindEv = list.reduce((s, x) => s + x.blindPnl, 0) / n;
    const patternEv = list.reduce((s, x) => s + x.patternPnl, 0) / n;
    const delta = patternEv - blindEv;
    const distinctSetups = new Set(list.map(x => x.setupType)).size;
    // N>=20 floor (this codebase's standard) AND spread across >=3 distinct setup_types
    // (not just one setup dominating the pattern's whole sample) before treating a delta
    // as a real, generalizable candidate rather than noise or a single-setup artifact.
    const flag = n >= 20 && distinctSetups >= 3 ? 'CANDIDATE' : (n < 20 ? 'N<20' : 'single-setup');
    console.log(`${pat.padEnd(22)} ${String(n).padEnd(6)} ${String(distinctSetups).padEnd(9)} $${blindEv.toFixed(2).padEnd(9)} $${patternEv.toFixed(2).padEnd(9)} $${delta.toFixed(2).padEnd(8)} ${flag}`);
    patternSummary.push({ pat, n, distinctSetups, blindEv, patternEv, delta, flag });
  }

  console.log('='.repeat(100));
  console.log('CONTROL CHECK: does the candle pattern add anything beyond just waiting for the overshoot?');
  console.log('='.repeat(100));
  console.log(`${'Setup'.padEnd(28)} ${'N'.padEnd(5)} ${'OrigEV'.padEnd(10)} ${'BlindEV'.padEnd(10)} ${'PatternEV'.padEnd(10)} ${'SameOutcome%'}`);
  for (const r of perSetup.sort((a, b) => b.n - a.n)) {
    const sameOutcomePct = (100 * r.sameOutcomeCount / r.n).toFixed(1);
    console.log(`${r.setupType.padEnd(28)} ${String(r.n).padEnd(5)} $${r.origEv.toFixed(2).padEnd(9)} $${r.blindEv.toFixed(2).padEnd(9)} $${r.patternEv.toFixed(2).padEnd(9)} ${sameOutcomePct}%`);
  }
  console.log('-'.repeat(100));
  console.log(`POOLED N=${pooled.origN}`);
  console.log(`  ORIG    (blind first-touch entry):     WR=${(100 * pooled.origWins / pooled.origN).toFixed(1)}%  EV=$${(pooled.origPnl / pooled.origN).toFixed(2)}`);
  console.log(`  BLIND   (enter at overshoot, no pattern): WR=${(100 * pooled.blindWins / pooled.origN).toFixed(1)}%  EV=$${(pooled.blindPnl / pooled.origN).toFixed(2)}`);
  console.log(`  PATTERN (enter at pattern confirmation):  WR=${(100 * pooled.patternWins / pooled.origN).toFixed(1)}%  EV=$${(pooled.patternPnl / pooled.origN).toFixed(2)}`);
  console.log(`  PATTERN minus BLIND (the pattern's real marginal contribution): $${((pooled.patternPnl - pooled.blindPnl) / pooled.origN).toFixed(2)}/trade`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
