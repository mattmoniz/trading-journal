// Tests a live-triggered question (2026-09-02, real losing streak the user spotted on
// PD_POC_FADE_LONG while PD_POC_FADE_SHORT won 3/3 the same night): does the Globex session's
// own developing cumulative delta (bid/ask volume imbalance since session open) predict which
// SIDE of a prior-day-level fade (PD_POC/PD_VAH/PD_VAL, LONG vs SHORT) wins? No existing live
// classifier computes "session delta at a point in time" for the Globex window specifically --
// /api/market/pulse's sessionDelta is RTH-only (mod 570-959) -- so this is fresh bar-level
// computation, not a reimplementation of something that already exists.
//
// No lookahead: delta is summed only from bars strictly at/before each trade's own fired_at.
// Confound checklist applied: real (ACTIVE/SHADOW) trades only, decisive resolutions only
// (TRAIL_EXIT counted as decisive by its own P&L sign, matching the 2026-09-02 quick-check.html
// fix), split by level+direction (not pooled blind, per the pooled-verdict-hides-subgroups
// mantra), computeRigor() chronological stability on every bucket that clears N>=20.

import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const LEVELS = ['PD_POC', 'PD_VAH', 'PD_VAL'];

function globexSessionStart(tradeDate) {
  // Globex session for a given trade_date starts 6PM ET the PREVIOUS calendar day.
  const d = new Date(tradeDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10) + ' 18:00:00';
}

async function main() {
  const setupTypes = LEVELS.flatMap(l => [`${l}_FADE_LONG`, `${l}_FADE_SHORT`]);
  const { rows: trades } = await query(`
    SELECT id, trade_date::text as trade_date, setup_type, fired_at::text as fired_at,
           resolution, actual_pnl::float as actual_pnl
    FROM active_setups
    WHERE setup_type = ANY($1)
      AND origin_status IN ('ACTIVE','SHADOW')
      AND resolution IN ('TARGET_HIT','STOP_HIT','TRAIL_EXIT')
      AND actual_pnl IS NOT NULL
    ORDER BY fired_at
  `, [setupTypes]);

  console.log(`Loaded ${trades.length} decisive real PD-level-fade trades.`);

  // Compute session delta at fired_at for each trade -- one query per trade is fine at this N
  // (< 300), no need for a shared-prefetch optimization at this scale.
  for (const t of trades) {
    const sessStart = globexSessionStart(t.trade_date);
    const { rows } = await query(`
      SELECT COALESCE(SUM(COALESCE(ask_volume,0) - COALESCE(bid_volume,0)), 0)::float as delta
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts >= $1 AND ts <= $2
    `, [sessStart, t.fired_at]);
    t.sessionDelta = rows[0].delta;
    t.isLong = t.setup_type.includes('LONG');
    t.level = t.setup_type.replace(/_FADE_(LONG|SHORT)$/, '');
    t.aligned = (t.isLong && t.sessionDelta > 0) || (!t.isLong && t.sessionDelta < 0);
  }

  function summarize(bucket, label) {
    if (bucket.length === 0) { console.log(`  ${label}: N=0`); return; }
    const wins = bucket.filter(t => t.resolution === 'TARGET_HIT' || (t.resolution === 'TRAIL_EXIT' && t.actual_pnl >= 0)).length;
    const wr = (100 * wins / bucket.length).toFixed(1);
    const ev = (bucket.reduce((s, t) => s + t.actual_pnl, 0) / bucket.length).toFixed(2);
    let rigorStr = '';
    if (bucket.length >= 20) {
      const rigor = computeRigor(bucket, { dateField: 'trade_date', pnlFn: t => t.actual_pnl });
      rigorStr = ` | rigor clean=${rigor?.clean} stable=${rigor?.stable} top5DayPct=${rigor?.top5DayPct}%`;
    } else {
      rigorStr = ' | N<20, THIN';
    }
    console.log(`  ${label}: N=${bucket.length} WR=${wr}% EV=$${ev}/trade${rigorStr}`);
  }

  for (const level of [...LEVELS, 'ALL_POOLED']) {
    const scoped = level === 'ALL_POOLED' ? trades : trades.filter(t => t.level === level);
    console.log(`\n=== ${level} (N=${scoped.length}) ===`);
    for (const dir of ['LONG', 'SHORT']) {
      const dirTrades = scoped.filter(t => t.isLong === (dir === 'LONG'));
      const aligned = dirTrades.filter(t => t.aligned);
      const counter = dirTrades.filter(t => !t.aligned);
      console.log(` ${dir}:`);
      summarize(aligned, `  aligned (delta agrees w/ ${dir})`);
      summarize(counter, `  counter (delta disagrees w/ ${dir})`);
    }
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
