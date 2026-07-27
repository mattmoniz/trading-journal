// scripts/backtest_stop_cushion_checkpoint.mjs
// ═══════════════════════════════════════════════════════════════════════
// Structural position-state test, per the user's explicit 2026-07-27 direction: extend
// the structural-rule family (bar6 worst-point-passed, distance-to-target-fraction,
// trend-alignment) rather than build another numeric-threshold signal — specifically
// "time-in-trade vs. distance-to-stop" as a candidate new position-state fact.
//
// Hypothesis: for a trade still open at bar 10 (deliberately later than bar6_checkpoint's
// bar 6, to test something genuinely new rather than reproduce it slightly later), how
// much of the ORIGINAL stop-cushion remains (current distance-to-stop / entry-to-stop
// distance) predicts the eventual outcome — a trade that has drifted close to its stop
// without triggering it should do worse, on average, than one that still has room.
//
// Reuses replayBars()/directionFromType() from maeMfeReplay.js (never reimplemented) to
// walk each trade's real bars and capture bar-10 state; reuses computeRigor() for the
// chronological-stability/day-clustering check, same as every other finding this
// session. Population: origin_status IN ('ACTIVE','SHADOW') only — real, live-fired
// trades, not the ~80% BACKFILL-synthetic corpus (see CLAUDE.md's origin_status rule).
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

const CHECKPOINT_BAR = 10; // 0-indexed bars after entry; trade must have >= 11 bars to reach it
const DPP = LIVE_INSTRUMENT.dollarsPerPoint;
const COMM = LIVE_INSTRUMENT.commissionPerRoundTrip;

async function main() {
  const rowsRes = await query(`
    SELECT id, setup_type, trade_date::text, fired_at::text as fired_at_str,
           entry_zone_low::float, entry_zone_high::float, stop_level::float, t1_level::float,
           actual_pnl::float
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND status = 'RESOLVED'
      AND resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED')
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
      AND fired_at IS NOT NULL AND actual_pnl IS NOT NULL
    ORDER BY trade_date
  `);
  console.log(`Real (ACTIVE/SHADOW) resolved population: N=${rowsRes.rows.length}`);

  const events = [];
  let skippedTooShort = 0, skippedNoBars = 0;
  for (const row of rowsRes.rows) {
    const hi = row.entry_zone_high ?? row.entry_zone_low;
    const entry = (row.entry_zone_low + hi) / 2;
    const stop = row.stop_level;
    const t1 = row.t1_level;
    const direction = directionFromType(row.setup_type);

    const barsRes = await query(`
      SELECT ts, open::float, high::float, low::float, close::float
      FROM price_bars_primary
      WHERE symbol = 'NQ'
        AND ts::date = $1
        AND ts >= $2
        AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) <= 960
      ORDER BY ts
    `, [row.trade_date, row.fired_at_str]);
    const bars = barsRes.rows;
    if (!bars.length) { skippedNoBars++; continue; }
    if (bars.length < CHECKPOINT_BAR + 1) { skippedTooShort++; continue; }

    // Check the trade hasn't already stopped/targeted before the checkpoint bar —
    // if it has, it's not "still open at bar 10", so it doesn't belong in this population.
    const isLong = direction === 'LONG';
    let alreadyDecided = false;
    for (let i = 0; i <= CHECKPOINT_BAR; i++) {
      const b = bars[i];
      const stopHit = isLong ? b.low <= stop : b.high >= stop;
      const targetHit = isLong ? b.high >= t1 : b.low <= t1;
      if (stopHit || targetHit) { alreadyDecided = true; break; }
    }
    if (alreadyDecided) continue;

    const checkpointClose = bars[CHECKPOINT_BAR].close;
    const entryToStop = Math.abs(entry - stop);
    const distToStopNow = isLong ? Math.max(0, checkpointClose - stop) : Math.max(0, stop - checkpointClose);
    const stopCushionFraction = entryToStop !== 0 ? distToStopNow / entryToStop : null;
    if (stopCushionFraction == null) continue;

    events.push({
      id: row.id, trade_date: row.trade_date, setup_type: row.setup_type,
      stopCushionFraction, pnl: row.actual_pnl,
    });
  }
  console.log(`Checkpoint-eligible events: N=${events.length} (skipped: ${skippedTooShort} too-short, ${skippedNoBars} no-bar-data, ${rowsRes.rows.length - events.length - skippedTooShort - skippedNoBars} already-decided-by-bar-${CHECKPOINT_BAR})`);
  if (events.length < 20) { console.log('N<20, cannot proceed.'); process.exit(0); }

  // Data-derived median split (no static threshold) — matches the bar6 "worst point
  // passed" binary-split simplicity that held up, rather than a numeric cutoff.
  const sorted = [...events].map(e => e.stopCushionFraction).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const lowCushion = events.filter(e => e.stopCushionFraction < median);
  const highCushion = events.filter(e => e.stopCushionFraction >= median);

  function summarize(group, label) {
    const n = group.length;
    const wr = n ? (group.filter(e => e.pnl > 0).length / n * 100) : null;
    const ev = n ? (group.reduce((s, e) => s + e.pnl, 0) / n) : null;
    console.log(`${label}: N=${n} WR=${wr?.toFixed(1)}% EV=$${ev?.toFixed(2)}/trade`);
    return { n, wr, ev };
  }
  console.log(`\nMedian stopCushionFraction split at ${median.toFixed(3)}:`);
  const lowStats = summarize(lowCushion, 'LOW cushion (closer to stop)');
  const highStats = summarize(highCushion, 'HIGH cushion (more room)');
  console.log(`Delta (high - low): $${(highStats.ev - lowStats.ev).toFixed(2)}/trade`);

  // Chronological 70/30 train/test split — same discipline as every comparison this session.
  const chronological = [...events].sort((a, b) => a.trade_date.localeCompare(b.trade_date));
  const splitIdx = Math.floor(chronological.length * 0.7);
  const train = chronological.slice(0, splitIdx);
  const test = chronological.slice(splitIdx);
  console.log(`\nChronological split: train N=${train.length}, test N=${test.length}`);
  for (const [label, pop] of [['TRAIN', train], ['TEST', test]]) {
    const s = [...pop].map(e => e.stopCushionFraction).sort((a, b) => a - b);
    const m = s.length ? s[Math.floor(s.length / 2)] : null;
    if (m == null) continue;
    const lo = pop.filter(e => e.stopCushionFraction < m);
    const hi = pop.filter(e => e.stopCushionFraction >= m);
    const loEv = lo.length ? lo.reduce((s2, e) => s2 + e.pnl, 0) / lo.length : null;
    const hiEv = hi.length ? hi.reduce((s2, e) => s2 + e.pnl, 0) / hi.length : null;
    console.log(`  ${label}: median=${m.toFixed(3)} lowN=${lo.length} lowEV=$${loEv?.toFixed(2)} highN=${hi.length} highEV=$${hiEv?.toFixed(2)} delta=$${(hiEv - loEv).toFixed(2)}`);
  }

  // Rigor check on the full-sample low-cushion group specifically (the population this
  // would flag as "at risk" if wired) — day-clustering + 3-way chronological stability.
  const rigor = computeRigor(lowCushion, { dateField: 'trade_date', pnlFn: e => e.pnl });
  console.log(`\nRigor (LOW cushion group): distinctDates=${rigor.distinctDates} top5DayPct=${rigor.top5DayPct}% clustered=${rigor.clustered} stable=${rigor.stable} thirds=${JSON.stringify(rigor.thirds)} clean=${rigor.clean}`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
