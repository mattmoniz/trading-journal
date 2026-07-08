/**
 * Backtest: cumulative session delta (bid/ask volume) vs level-fade outcome.
 *
 * Hypothesis: fades where the session delta AGREES with the fade direction
 * (bearish delta + SHORT fade, or bullish delta + LONG fade) should have
 * higher WR and better EV than fades that swim against the flow.
 *
 * Data: price_bars_primary.bid_volume / ask_volume (NQ, 1-min RTH bars, 2024+)
 *       active_setups (RESOLVED level fades, ~2,000+ rows)
 *
 * Run: node scripts/backtest_session_delta.mjs
 * Output: prints summary + writes LEVEL_FADE_DELTA signal_type rows to performance_audit
 */

import { query } from '../server/db.js';
import pool from '../server/db.js';

// Map setup_type → direction (LONG or SHORT)
function getDirection(setup_type) {
  if (!setup_type) return null;
  const t = setup_type.toUpperCase();
  if (t.endsWith('_LONG') || t.endsWith('_LONG_FADE') || t.includes('_BULLISH') ||
      t.includes('STANDALONE_UP') || t.includes('TEST_DRIVE_LONG') || t.includes('DRIVE_LONG')) {
    return 'LONG';
  }
  if (t.endsWith('_SHORT') || t.endsWith('_SHORT_FADE') || t.includes('_BEARISH') ||
      t.includes('STANDALONE_DOWN') || t.includes('TEST_DRIVE_SHORT') || t.includes('DRIVE_SHORT')) {
    return 'SHORT';
  }
  return null;
}

// Classify delta alignment given direction and net_delta
// with_flow: delta confirms fade (bearish flow + SHORT, or bullish flow + LONG)
// against_flow: delta opposes fade
// neutral: < threshold (p25 of |delta| distribution)
function classify(direction, net_delta, p25_abs_delta) {
  if (Math.abs(net_delta) < p25_abs_delta) return 'neutral';
  if (direction === 'LONG')  return net_delta > 0 ? 'with_flow' : 'against_flow';
  if (direction === 'SHORT') return net_delta < 0 ? 'with_flow' : 'against_flow';
  return null;
}

function stats(rows) {
  const n = rows.length;
  if (n === 0) return { n: 0, wr: null, ev: null };
  const wins = rows.filter(r => r.resolution === 'TARGET_HIT').length;
  const ev   = rows.reduce((s, r) => s + (parseFloat(r.actual_pnl) || 0), 0) / n;
  return { n, wr: Math.round(wins / n * 1000) / 10, ev: Math.round(ev) };
}

async function run() {
  console.log('[backtest_session_delta] Starting...');

  // 1. Fetch all RESOLVED level fades with fired_at + actual_pnl
  const setupsRes = await query(`
    SELECT id, trade_date::text, setup_type, fired_at, resolution, actual_pnl
    FROM active_setups
    WHERE status = 'RESOLVED'
      AND resolution IN ('TARGET_HIT', 'STOP_HIT')
      AND actual_pnl IS NOT NULL
      AND fired_at IS NOT NULL
    ORDER BY fired_at
  `);
  const setups = setupsRes.rows.filter(s => getDirection(s.setup_type) !== null);
  console.log(`  ${setups.length} setups with direction (of ${setupsRes.rows.length} total)`);

  // 2. For each setup, compute cumulative session delta from 9:30 ET to fired_at.
  //    Batch by trade_date to limit DB round trips.
  const byDate = {};
  for (const s of setups) {
    if (!byDate[s.trade_date]) byDate[s.trade_date] = [];
    byDate[s.trade_date].push(s);
  }

  // Pre-load all RTH 1-min bars with delta for relevant dates
  const dates = Object.keys(byDate);
  console.log(`  Loading RTH bars for ${dates.length} dates...`);

  // Use a single bulk query keyed by (trade_date::date, minute bucket)
  const barsRes = await query(`
    SELECT
      (ts AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date::text AS bar_date,
      EXTRACT(EPOCH FROM (ts AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')
        - (ts AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date) / 60 AS et_min,
      ts,
      COALESCE(ask_volume, 0)::float - COALESCE(bid_volume, 0)::float AS bar_delta
    FROM price_bars_primary
    WHERE symbol = 'NQ'
      AND (ts AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date = ANY($1::date[])
      AND EXTRACT(EPOCH FROM (ts AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')
          - (ts AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date) / 60 BETWEEN 570 AND 960
    ORDER BY ts
  `, [dates]);

  // Build a map: bar_date → [{et_min, ts_epoch, bar_delta}]
  const barsByDate = {};
  for (const b of barsRes.rows) {
    if (!barsByDate[b.bar_date]) barsByDate[b.bar_date] = [];
    barsByDate[b.bar_date].push({
      et_min: parseFloat(b.et_min),
      bar_delta: parseFloat(b.bar_delta),
    });
  }
  console.log(`  Loaded bars for ${Object.keys(barsByDate).length} dates`);

  // 3. For each setup, sum delta up to fired_at minute.
  //    fired_at is stored as naive ET (UTC column but ET values) — compare in ET minutes.
  //    Bars are keyed by et_min (minutes since midnight ET). RTH = 570–960.
  const enriched = [];
  for (const s of setups) {
    const bars = barsByDate[s.trade_date] || [];
    if (bars.length === 0) continue;

    // fired_at: extract UTC hour/min as ET time (naive ET stored as UTC)
    const fd = new Date(s.fired_at);
    const firedEtMin = fd.getUTCHours() * 60 + fd.getUTCMinutes();

    const cumulDelta = bars
      .filter(b => b.et_min <= firedEtMin)
      .reduce((sum, b) => sum + b.bar_delta, 0);

    enriched.push({
      ...s,
      direction: getDirection(s.setup_type),
      net_delta: cumulDelta,
    });
  }
  console.log(`  ${enriched.length} setups with delta computed`);

  // 4. Compute p25 of |net_delta| as neutral threshold
  const absSorted = enriched.map(e => Math.abs(e.net_delta)).sort((a, b) => a - b);
  const p25 = absSorted[Math.floor(absSorted.length * 0.25)] || 0;
  const p50 = absSorted[Math.floor(absSorted.length * 0.50)] || 0;
  const p75 = absSorted[Math.floor(absSorted.length * 0.75)] || 0;
  console.log(`  |delta| percentiles: p25=${Math.round(p25)} p50=${Math.round(p50)} p75=${Math.round(p75)}`);

  // 5. Classify each setup
  for (const e of enriched) {
    e.alignment = classify(e.direction, e.net_delta, p25);
  }

  // 6. Overall breakdown
  const withFlow    = enriched.filter(e => e.alignment === 'with_flow');
  const againstFlow = enriched.filter(e => e.alignment === 'against_flow');
  const neutral     = enriched.filter(e => e.alignment === 'neutral');

  const sAll     = stats(enriched);
  const sWith    = stats(withFlow);
  const sAgainst = stats(againstFlow);
  const sNeutral = stats(neutral);

  console.log('\n=== OVERALL DELTA ALIGNMENT BREAKDOWN ===');
  console.log(`All         : N=${sAll.n}  WR=${sAll.wr}%  EV=$${sAll.ev}`);
  console.log(`With flow   : N=${sWith.n}  WR=${sWith.wr}%  EV=$${sWith.ev}`);
  console.log(`Against flow: N=${sAgainst.n}  WR=${sAgainst.wr}%  EV=$${sAgainst.ev}`);
  console.log(`Neutral     : N=${sNeutral.n}  WR=${sNeutral.wr}%  EV=$${sNeutral.ev}`);

  // 7. By direction
  for (const dir of ['LONG', 'SHORT']) {
    const sub = enriched.filter(e => e.direction === dir);
    const sWithDir    = stats(sub.filter(e => e.alignment === 'with_flow'));
    const sAgainstDir = stats(sub.filter(e => e.alignment === 'against_flow'));
    console.log(`\n${dir} fades:`);
    console.log(`  With flow   : N=${sWithDir.n}  WR=${sWithDir.wr}%  EV=$${sWithDir.ev}`);
    console.log(`  Against flow: N=${sAgainstDir.n}  WR=${sAgainstDir.wr}%  EV=$${sAgainstDir.ev}`);
  }

  // 8. By delta magnitude (tertile = against p50 and p75)
  const lowDelta  = enriched.filter(e => Math.abs(e.net_delta) <= p50);
  const midDelta  = enriched.filter(e => Math.abs(e.net_delta) > p50 && Math.abs(e.net_delta) <= p75);
  const highDelta = enriched.filter(e => Math.abs(e.net_delta) > p75);

  console.log('\n=== BY DELTA MAGNITUDE (all alignments) ===');
  console.log(`Low  (≤p50=${Math.round(p50)}) : N=${lowDelta.length}  WR=${stats(lowDelta).wr}%  EV=$${stats(lowDelta).ev}`);
  console.log(`Mid  (p50-p75)        : N=${midDelta.length}  WR=${stats(midDelta).wr}%  EV=$${stats(midDelta).ev}`);
  console.log(`High (>p75=${Math.round(p75)}) : N=${highDelta.length}  WR=${stats(highDelta).wr}%  EV=$${stats(highDelta).ev}`);

  // High-delta further broken down by alignment
  const highWith    = highDelta.filter(e => e.alignment === 'with_flow');
  const highAgainst = highDelta.filter(e => e.alignment === 'against_flow');
  console.log(`  High + with_flow   : N=${highWith.length}  WR=${stats(highWith).wr}%  EV=$${stats(highWith).ev}`);
  console.log(`  High + against_flow: N=${highAgainst.length}  WR=${stats(highAgainst).wr}%  EV=$${stats(highAgainst).ev}`);

  // 9. By setup_type (top 10 by N)
  const byType = {};
  for (const e of enriched) {
    if (!byType[e.setup_type]) byType[e.setup_type] = { with_flow: [], against_flow: [], neutral: [] };
    byType[e.setup_type][e.alignment].push(e);
  }
  console.log('\n=== TOP SETUP TYPES: with_flow vs against_flow ===');
  const typeRows = Object.entries(byType)
    .map(([t, g]) => ({
      setup_type: t,
      n_with: g.with_flow.length,
      n_against: g.against_flow.length,
      wr_with: stats(g.with_flow).wr,
      wr_against: stats(g.against_flow).wr,
      ev_with: stats(g.with_flow).ev,
      ev_against: stats(g.against_flow).ev,
    }))
    .sort((a, b) => (b.n_with + b.n_against) - (a.n_with + a.n_against));

  for (const r of typeRows.slice(0, 12)) {
    const diff = r.wr_with != null && r.wr_against != null ? (r.wr_with - r.wr_against).toFixed(1) : '?';
    console.log(`  ${r.setup_type.padEnd(32)} with: N=${String(r.n_with).padEnd(3)} WR=${String(r.wr_with ?? '?').padEnd(5)}% EV=$${String(r.ev_with ?? '?').padEnd(6)}  against: N=${String(r.n_against).padEnd(3)} WR=${String(r.wr_against ?? '?').padEnd(5)}% EV=$${String(r.ev_against ?? '?').padEnd(6)}  WR-diff=${diff}pp`);
  }

  // 10. Write findings to performance_audit
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const buckets = [
    { name: 'all_fades',           rows: enriched },
    { name: 'with_flow',           rows: withFlow },
    { name: 'against_flow',        rows: againstFlow },
    { name: 'high_delta_with',     rows: highWith },
    { name: 'high_delta_against',  rows: highAgainst },
  ];

  for (const b of buckets) {
    const s = stats(b.rows);
    if (s.n < 5) continue;
    const notes = {
      p25_abs_delta: Math.round(p25),
      p50_abs_delta: Math.round(p50),
      p75_abs_delta: Math.round(p75),
      bucket: b.name,
    };
    await query(`
      INSERT INTO performance_audit
        (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, notes, recommendation)
      VALUES ($1, 9999, 'LEVEL_FADE_DELTA', $2, $3, $4, $5, $6, $7)
      ON CONFLICT (run_date, window_days, signal_type, signal_name)
        DO UPDATE SET sample_size=$3, win_rate=$4, ev_per_trade=$5, notes=$6, recommendation=$7
    `, [today, b.name, s.n, s.n ? Math.round(withFlow.filter(r=>r.resolution==='TARGET_HIT').length / (withFlow.length||1) * 1000)/1000 : null, s.ev, JSON.stringify(notes),
      b.name === 'with_flow' ? 'SIZE_UP' : b.name === 'against_flow' ? 'SUPPRESS' : 'MONITOR']);
  }

  // Fix: write correct win_rate per bucket
  for (const b of buckets) {
    const s = stats(b.rows);
    if (s.n < 5) continue;
    await query(`
      UPDATE performance_audit SET win_rate = $1
      WHERE run_date=$2 AND signal_type='LEVEL_FADE_DELTA' AND signal_name=$3
    `, [s.n > 0 ? Math.round(b.rows.filter(r=>r.resolution==='TARGET_HIT').length / b.rows.length * 10000)/10000 : null,
       today, b.name]);
  }

  console.log(`\n[backtest_session_delta] Wrote ${buckets.filter(b=>stats(b.rows).n>=5).length} rows to performance_audit (signal_type=LEVEL_FADE_DELTA)`);
}

run().catch(e => { console.error(e); process.exit(1); }).finally(() => pool.end());
