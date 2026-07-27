// Full-population bar6 exit-rule dollar-impact check, run directly by Claude after Gemini's
// pass stalled (>4min, no output) on the same task. Uses the real, live-wired
// computeBar6Checkpoint()/computeExitRuleAtBar6() from maeMfeReplay.js -- not reimplemented.
// Method already validated against a hand reference on the origin_status='ACTIVE' and
// ('ACTIVE','SHADOW') subsets (matched exactly) -- this extends the same method to the full
// population, broken out by origin_status, plus a chronological 80/20 train/test split.
import { query } from '../server/db.js';
import { computeBar6Checkpoint, directionFromType } from '../server/services/maeMfeReplay.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import fs from 'fs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;

// Computes the checkpoint ONCE per trade (the expensive part -- one bar-history query each)
// and attaches { gated } to each row in place. Called once on the full candidate set;
// every subset breakdown below just filters/aggregates this already-computed array --
// no bar-walk is ever repeated for the same trade.
async function annotateWithCheckpoints(rows) {
  let done = 0;
  for (const t of rows) {
    const direction = directionFromType(t.setup_type);
    t._skip = true;
    if (!direction) continue;
    const hi = t.entry_zone_high != null ? t.entry_zone_high : t.entry_zone_low;
    const entry = (t.entry_zone_low + hi) / 2;
    // price_bars_primary is a VIEW (join+aggregate over price_bars + a contract-calendar
    // table, no indexes possible on a view) -- an unbounded `ts >= $1` forces it to consider
    // everything from fired_at through the present before it can sort/limit. Only ever need
    // the first ~7 bars (well within a few hours), so bound the upper end tightly.
    // fired_at is fetched as ::text above and used as text here -- NEVER pass the raw Date
    // object node-pg would otherwise return, which silently round-trips through the ambient
    // process timezone and can shift the effective instant by several hours (confirmed live,
    // 2026-07-27: id=64651 showed a 779pt "6-minute move" that was actually bars from 4 hours
    // before the real touch -- fixed by using fired_at::text throughout, matching the bar-6
    // close exactly against the recorded entry price after the fix).
    const barsRes = await query(`
      SELECT high::float, low::float, close::float FROM price_bars_primary
      WHERE symbol='NQ' AND ts >= $1::timestamp AND ts < $1::timestamp + interval '6 hours'
      ORDER BY ts ASC LIMIT 10
    `, [t.fired_at]);
    done++;
    if (done % 1000 === 0) console.log(`  ...${done}/${rows.length} bar-walks done`);
    if (barsRes.rows.length < 7) continue;
    const cp = computeBar6Checkpoint(barsRes.rows, entry, t.stop_level, t.t1_level, direction, PNL_PER_POINT, COMMISSION);
    if (!cp) continue;
    t._skip = false;
    t._triggered = cp.ruleSaysExit;
    t._gated = cp.ruleSaysExit ? cp.pnlAtBar6 : t.actual_pnl;
  }
}

function computeFor(rows) {
  let n = 0, triggered = 0, baselineTotal = 0, gatedTotal = 0;
  const byDate = new Map();
  for (const t of rows) {
    if (t._skip) continue;
    n++;
    byDate.set(t.trade_date, (byDate.get(t.trade_date) || 0) + 1);
    baselineTotal += t.actual_pnl;
    gatedTotal += t._gated;
    if (t._triggered) triggered++;
  }
  const top5 = [...byDate.values()].sort((a, b) => b - a).slice(0, 5).reduce((s, c) => s + c, 0);
  return {
    n, triggered, distinctDates: byDate.size,
    top5Pct: n ? (top5 / n * 100).toFixed(1) : '0.0',
    baselineTotal, gatedTotal, diff: gatedTotal - baselineTotal,
    diffPerTrade: n ? (gatedTotal - baselineTotal) / n : 0,
  };
}

function fmt(label, r) {
  return `[${label}] N=${r.n}, rule triggered=${r.triggered}, distinct dates=${r.distinctDates}, top5Pct=${r.top5Pct}%\n` +
    `  Baseline=$${r.baselineTotal.toFixed(2)} Gated=$${r.gatedTotal.toFixed(2)} Diff=$${r.diff.toFixed(2)} DiffPerTrade=$${r.diffPerTrade.toFixed(2)}`;
}

async function main() {
  const allTrades = await query(`
    SELECT id, trade_date::text, fired_at::text as fired_at, setup_type, origin_status,
      entry_zone_low::float, entry_zone_high::float, stop_level::float, t1_level::float, actual_pnl::float
    FROM active_setups
    WHERE resolution IS NOT NULL
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
      AND actual_pnl IS NOT NULL
    ORDER BY fired_at ASC
  `);
  console.log(`Loaded ${allTrades.rows.length} candidate trades. Walking bars per-trade ONCE (no batching, no re-walking for subsets)...`);
  await annotateWithCheckpoints(allTrades.rows);
  console.log('Bar-walk pass complete. Aggregating subsets from cached results (no more DB calls)...');

  const lines = [];
  lines.push('# Bar-6 Exit Rule — Full Population Dollar Impact (Claude direct run, 2026-07-27)\n');

  const active = allTrades.rows.filter(r => r.origin_status === 'ACTIVE');
  const activeShadow = allTrades.rows.filter(r => r.origin_status === 'ACTIVE' || r.origin_status === 'SHADOW');
  const backfill = allTrades.rows.filter(r => r.origin_status === 'BACKFILL');
  const unknown = allTrades.rows.filter(r => r.origin_status === 'UNKNOWN');

  const rActive = computeFor(active);
  lines.push(fmt("origin_status='ACTIVE'", rActive));
  console.log(fmt("origin_status='ACTIVE'", rActive));

  const rActiveShadow = computeFor(activeShadow);
  lines.push(fmt("origin_status IN ('ACTIVE','SHADOW')", rActiveShadow));
  console.log(fmt("origin_status IN ('ACTIVE','SHADOW')", rActiveShadow));

  const rFull = computeFor(allTrades.rows);
  lines.push(fmt('FULL POPULATION (no filter)', rFull));
  console.log(fmt('FULL POPULATION (no filter)', rFull));

  const rBackfill = computeFor(backfill);
  lines.push(fmt("origin_status='BACKFILL'", rBackfill));
  console.log(fmt("origin_status='BACKFILL'", rBackfill));

  const rUnknown = computeFor(unknown);
  lines.push(fmt("origin_status='UNKNOWN'", rUnknown));
  console.log(fmt("origin_status='UNKNOWN'", rUnknown));

  // Chronological 80/20 train/test split on the full population
  const dates = [...new Set(allTrades.rows.map(r => r.trade_date))].sort();
  const splitIdx = Math.floor(dates.length * 0.8);
  const trainDates = new Set(dates.slice(0, splitIdx));
  const trainRows = allTrades.rows.filter(r => trainDates.has(r.trade_date));
  const testRows = allTrades.rows.filter(r => !trainDates.has(r.trade_date));

  const rTrain = computeFor(trainRows);
  lines.push(fmt('FULL POPULATION - TRAIN (oldest 80% dates)', rTrain));
  console.log(fmt('FULL POPULATION - TRAIN (oldest 80% dates)', rTrain));

  const rTest = computeFor(testRows);
  lines.push(fmt('FULL POPULATION - TEST (newest 20% dates)', rTest));
  console.log(fmt('FULL POPULATION - TEST (newest 20% dates)', rTest));

  fs.writeFileSync('scratch/bar6_full_population_CLAUDE_RESULTS.md', lines.join('\n\n'));
  console.log('\nWritten to scratch/bar6_full_population_CLAUDE_RESULTS.md');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
