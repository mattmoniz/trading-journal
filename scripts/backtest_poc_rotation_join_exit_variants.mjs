// Real bar-by-bar exit-mechanism backtest for POC_ROTATION_JOIN_LONG/SHORT (2026-09-24, user
// request after the real MFE finding: real trades average 191pt/113.5pt-median MFE (LONG)
// against just a 20pt stop, but 60.5% still stop out at -$42 -- does a smarter exit capture
// more of that without materially increasing risk?
//
// Baseline (the REAL live mechanism, resolveSetups.js's POC_ROTATION_JOIN branch,
// "Time60_Stop20"): 20pt stop checked bar-by-bar since fired_at, else mark-to-market at the
// 60-minute mark. This script re-derives that exact mechanism from real price_bars_primary
// bars first and cross-checks it against the real stored actual_pnl as a correctness gate
// before trusting any variant's result -- if baseline doesn't reproduce real P&L, the bar-walk
// itself is wrong and nothing downstream can be trusted.
//
// LONG and SHORT are backtested completely separately -- their real MFE profiles already
// look nothing alike (LONG median 113.5pt, SHORT median 8.75pt), so pooling or assuming
// symmetry would misrepresent both.
//
// Rigor: day-blocked bootstrap CI (dayBlockedBootstrapCI(), not a naive mean/t-test) given
// only ~17 distinct real days for LONG -- every result here is PROVISIONAL, not a promotion
// candidate. No lookahead: every variant only uses bars strictly after fired_at.
import { query } from '../server/db.js';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';

const PNL_PER_POINT = 2; // MNQ $2/pt
const COMMISSION = 2; // $2 round-trip
const MAX_HORIZON_MIN = 240; // pull enough bars for the widest variant tested (extended timeout)

async function loadRealTrades(setupType) {
  const { rows } = await query(`
    SELECT id, trade_date::text as trade_date, fired_at::text as fired_at,
           COALESCE(entry_zone_high, entry_zone_low)::float as entry,
           stop_level::float as stop, actual_pnl::float as real_pnl
    FROM active_setups
    WHERE setup_type = $1
      AND origin_status IN ('ACTIVE','SHADOW')
      AND (is_cluster_primary IS NULL OR is_cluster_primary = true)
      AND resolution IS NOT NULL
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL
    ORDER BY fired_at ASC
  `, [setupType]);
  return rows;
}

async function loadBars(firedAt) {
  const { rows } = await query(`
    SELECT ts::text as ts, high::float, low::float, close::float
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts > $1 AND ts <= $1::timestamp + ($2 || ' minutes')::interval
    ORDER BY ts ASC
  `, [firedAt, MAX_HORIZON_MIN]);
  return rows;
}

function minutesBetween(a, b) { return (new Date(b + 'Z') - new Date(a + 'Z')) / 60000; }

// Baseline: fixed stop, mark-to-market at timeoutMin.
function simBaseline(trade, bars, long, stopDist, timeoutMin) {
  const stopPrice = long ? trade.entry - stopDist : trade.entry + stopDist;
  let lastBar = null;
  for (const bar of bars) {
    const mins = minutesBetween(trade.fired_at, bar.ts);
    if (mins > timeoutMin) break;
    const stopHit = long ? bar.low <= stopPrice : bar.high >= stopPrice;
    if (stopHit) return { pnl: dollarPnl(long, trade.entry, stopPrice), exit: 'STOP' };
    lastBar = bar;
  }
  if (!lastBar) return null;
  return { pnl: dollarPnl(long, trade.entry, lastBar.close), exit: 'TIMEOUT' };
}

// Breakeven-then-trail: once favorable excursion clears armDist, move stop to breakeven, then
// trail trailDist behind the running peak. No time cap once armed (a genuine trail shouldn't
// need one) -- but still governed by the original stop before arming.
function simBreakevenTrail(trade, bars, long, stopDist, armDist, trailDist) {
  const stopPrice0 = long ? trade.entry - stopDist : trade.entry + stopDist;
  let armed = false, peak = trade.entry, stop = stopPrice0, lastBar = null;
  for (const bar of bars) {
    const favExcursion = long ? bar.high - trade.entry : trade.entry - bar.high;
    const advExcursion = long ? trade.entry - bar.low : bar.low - trade.entry; // for SHORT direction fix below
    lastBar = bar;
    // Check stop first (conservative -- assume adverse touch within the bar could happen before the favorable one)
    const stopHit = long ? bar.low <= stop : bar.high >= stop;
    if (stopHit) return { pnl: dollarPnl(long, trade.entry, stop), exit: armed ? 'TRAIL_STOP' : 'STOP' };
    // Update peak / arm / trail using this bar's favorable extreme
    const barFav = long ? bar.high : bar.low;
    if (long ? barFav > peak : barFav < peak) peak = barFav;
    const excursion = long ? peak - trade.entry : trade.entry - peak;
    if (!armed && excursion >= armDist) armed = true;
    if (armed) {
      const newStop = long ? Math.max(stop, peak - trailDist, trade.entry) : Math.min(stop, peak + trailDist, trade.entry);
      stop = newStop;
    }
  }
  if (!lastBar) return null;
  return { pnl: dollarPnl(long, trade.entry, lastBar.close), exit: 'TIME_END' };
}

function dollarPnl(long, entry, exitPrice) {
  const pts = long ? (exitPrice - entry) : (entry - exitPrice);
  return Math.round((pts * PNL_PER_POINT - COMMISSION) * 100) / 100;
}

function summarize(label, results, dateField) {
  const valid = results.filter(r => r != null);
  if (valid.length === 0) { console.log(`  ${label}: no valid trades`); return; }
  const events = valid.map(r => ({ pnl: r.pnl, date: r.date }));
  const mean = events.reduce((a, e) => a + e.pnl, 0) / events.length;
  const ci = dayBlockedBootstrapCI(events, `poc_rotation_${label}`, { dateField: 'date' });
  const exitCounts = {};
  for (const r of valid) exitCounts[r.exit] = (exitCounts[r.exit] || 0) + 1;
  const distinctDates = new Set(events.map(e => e.date)).size;
  console.log(`  ${label.padEnd(28)} N=${valid.length}  days=${distinctDates}  mean=$${mean.toFixed(2)}  CI=[$${ci.lo.toFixed(2)}, $${ci.hi.toFixed(2)}]  exits=${JSON.stringify(exitCounts)}`);
}

async function runFor(setupType) {
  const long = setupType.endsWith('LONG');
  console.log(`\n=== ${setupType} ===`);
  const trades = await loadRealTrades(setupType);
  console.log(`Real trades: ${trades.length}, distinct days: ${new Set(trades.map(t => t.trade_date)).size}`);

  const barsByTrade = new Map();
  for (const t of trades) barsByTrade.set(t.id, await loadBars(t.fired_at));

  // Baseline sanity check -- must reproduce the real live P&L before trusting anything else.
  const baselineResults = trades.map(t => {
    const r = simBaseline(t, barsByTrade.get(t.id), long, 20, 60);
    return r ? { pnl: r.pnl, exit: r.exit, date: t.trade_date, realPnl: t.real_pnl } : null;
  });
  const mismatches = baselineResults.filter(r => r && Math.abs(r.pnl - r.realPnl) > 0.02);
  console.log(`Baseline re-derivation check: ${baselineResults.filter(r => r).length}/${trades.length} simulated, ${mismatches.length} mismatches vs real actual_pnl`);
  if (mismatches.length > 0) {
    console.log('  MISMATCH SAMPLE:', mismatches.slice(0, 3).map(m => `sim=${m.pnl} real=${m.realPnl}`));
  }

  console.log('\nExit variant comparison:');
  summarize('BASELINE (20pt/60min)', baselineResults, 'date');

  for (const stopDist of [30, 40, 50]) {
    const results = trades.map(t => {
      const r = simBaseline(t, barsByTrade.get(t.id), long, stopDist, 60);
      return r ? { pnl: r.pnl, exit: r.exit, date: t.trade_date } : null;
    });
    summarize(`WIDER_STOP_${stopDist}pt/60min`, results, 'date');
  }

  for (const timeoutMin of [90, 120]) {
    const results = trades.map(t => {
      const r = simBaseline(t, barsByTrade.get(t.id), long, 20, timeoutMin);
      return r ? { pnl: r.pnl, exit: r.exit, date: t.trade_date } : null;
    });
    summarize(`20pt/${timeoutMin}min`, results, 'date');
  }

  for (const [armDist, trailDist] of [[20, 20], [20, 30], [40, 30]]) {
    const results = trades.map(t => {
      const r = simBreakevenTrail(t, barsByTrade.get(t.id), long, 20, armDist, trailDist);
      return r ? { pnl: r.pnl, exit: r.exit, date: t.trade_date } : null;
    });
    summarize(`BE_TRAIL_arm${armDist}_trail${trailDist}`, results, 'date');
  }

  return { setupType, n: trades.length, distinctDays: new Set(trades.map(t => t.trade_date)).size };
}

async function main() {
  await runFor('POC_ROTATION_JOIN_LONG');
  await runFor('POC_ROTATION_JOIN_SHORT');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
