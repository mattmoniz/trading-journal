// backtest_level_exhaustion.js
// ═══════════════════════════════════════════════════════════════════════
// Verifies the "56% / 66% / 70%+" WR claims for LEVEL_EXHAUSTION /
// ABSORPTION alerts in morningBrief.js trade-alerts endpoint.
//
// Algorithm matches the live signal exactly:
//   - Approximated delta from OHLC: (bullish/bearish) * vol * max(|C-O|/H-L, 0.3)
//   - 30-bar rolling window for priceMove and delta sum
//   - Proximity threshold: max(30, 12% of session developing range)
//   - Divergence: priceFalling(-10pt) + deltaBuying(>500) = bullish
//                 priceRising(+10pt) + deltaSelling(<-500) = bearish
//
// Key levels tested (subset — most common in live signal):
//   PD POC, PD VAH, PD VAL, OR High, OR Low, IB High, IB Low
//
// Outcome: T1=20pt in fade direction, stop=20pt against (scalp target).
// Cooldown: 60 bars between signals same day (avoid re-firing on same move).
//
// Results grouped by: base (1 level), stretch≥10%, 2+ levels.
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';

const WINDOW         = 30;   // rolling bars for price/delta
const PRICE_THRESH   = 10;   // pt min price move
const DELTA_THRESH   = 500;  // approx delta units
const TARGET         = 20;   // pt
const STOP           = 20;   // pt
const COOLDOWN_BARS  = 60;   // bars between signals same day
const STRETCH_MIN    = 10;   // % of session range for "strong" tier
const PNL_WIN        = TARGET * 2;
const PNL_LOSS       = STOP  * 2;

async function run() {
  console.log('Loading bars for Level Exhaustion backtest...');

  const [barsRes, pdRes, acdRes] = await Promise.all([
    query(`
      SELECT ts::date::text as td,
        (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
        open::float, high::float, low::float, close::float,
        volume::bigint as vol
      FROM price_bars_primary
      WHERE symbol = 'NQ' AND ts::date >= '2022-01-01'
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
      ORDER BY ts
    `),
    query(`
      SELECT trade_date::text as td, poc::float, vah::float, val::float
      FROM developing_value_log WHERE poc IS NOT NULL
      ORDER BY trade_date
    `),
    query(`
      SELECT trade_date::text as td, or_high::float, or_low::float
      FROM acd_daily_log WHERE or_high IS NOT NULL
      ORDER BY trade_date
    `),
  ]);

  console.log(`  Loaded ${barsRes.rows.length} RTH bars`);

  const pdMap  = new Map(pdRes.rows.map(r => [r.td, r]));
  const acdMap = new Map(acdRes.rows.map(r => [r.td, r]));

  // Group bars by day
  const dayMap = new Map();
  for (const b of barsRes.rows) {
    if (!dayMap.has(b.td)) dayMap.set(b.td, []);
    dayMap.get(b.td).push(b);
  }
  const days = [...dayMap.keys()].sort();

  // Result buckets
  const results = {
    base:    [],  // single level
    stretch: [],  // stretch >= 10% (implies single level or more)
    multi:   [],  // 2+ levels
    triple:  [],  // 3+ levels ("triple confluence")
  };

  for (const day of days) {
    const bars = dayMap.get(day);
    const pd  = pdMap.get(day);
    const acd = acdMap.get(day);

    if (!pd || bars.length < WINDOW + 10) continue;

    // Compute IB High/Low (9:30-10:30 = et_min 570-629)
    const ibBars = bars.filter(b => b.et_min <= 629);
    const ibH = ibBars.length ? Math.max(...ibBars.map(b => b.high)) : null;
    const ibL = ibBars.length ? Math.min(...ibBars.map(b => b.low)) : null;

    // Available levels for this day (static key levels with fade direction)
    const levelDefs = [
      { name: 'PD_POC', val: pd?.poc, fadeDir: null  },
      { name: 'PD_VAH', val: pd?.vah, fadeDir: 'SHORT' },
      { name: 'PD_VAL', val: pd?.val, fadeDir: 'LONG'  },
      { name: 'OR_HIGH', val: acd?.or_high, fadeDir: 'SHORT' },
      { name: 'OR_LOW',  val: acd?.or_low,  fadeDir: 'LONG'  },
      { name: 'IB_HIGH', val: ibH, fadeDir: 'SHORT' },
      { name: 'IB_LOW',  val: ibL, fadeDir: 'LONG'  },
    ].filter(l => l.val != null);

    let sessHi = -Infinity, sessLo = Infinity;
    let lastSignalIdx = -COOLDOWN_BARS - 1;

    for (let i = WINDOW; i < bars.length; i++) {
      const recent = bars.slice(i - WINDOW, i + 1);
      const b = bars[i];

      // Update session range
      if (b.high > sessHi) sessHi = b.high;
      if (b.low  < sessLo) sessLo = b.low;
      const devRange = sessHi - sessLo;
      if (devRange < 20) continue;

      // Cooldown
      if (i - lastSignalIdx < COOLDOWN_BARS) continue;

      // 30-bar rolling price move
      const priceMove = recent[recent.length - 1].close - recent[0].close;

      // Approximated delta (matches morningBrief.js exactly)
      let delta30 = 0;
      for (const bar of recent) {
        const rng = bar.high - bar.low;
        const bp = rng > 0 ? Math.abs(bar.close - bar.open) / rng : 0;
        delta30 += (bar.close >= bar.open ? 1 : -1) * Number(bar.vol || 0) * Math.max(bp, 0.3);
      }

      const bullDiv = priceMove < -PRICE_THRESH && delta30 > DELTA_THRESH;
      const bearDiv = priceMove >  PRICE_THRESH && delta30 < -DELTA_THRESH;
      if (!bullDiv && !bearDiv) continue;

      const stretchPct = Math.abs(priceMove) / devRange * 100;
      const proximityThreshold = Math.max(30, Math.round(devRange * 0.12));
      const price = b.close;

      // Nearby levels
      const nearLevels = levelDefs.filter(l => {
        const fits = Math.abs(price - l.val) <= proximityThreshold;
        if (bullDiv) return fits && (l.fadeDir === 'LONG' || l.fadeDir === null);
        return fits && (l.fadeDir === 'SHORT' || l.fadeDir === null);
      });

      if (nearLevels.length === 0) continue;

      // Simulate fade
      const isLong = bullDiv;
      const entry  = price;
      const t1     = isLong ? entry + TARGET : entry - TARGET;
      const stop   = isLong ? entry - STOP   : entry + STOP;

      let result = 'TIMEOUT';
      for (let j = i + 1; j < bars.length; j++) {
        const fwd = bars[j];
        if (isLong) {
          if (fwd.high >= t1)   { result = 'WIN';  break; }
          if (fwd.low  <= stop) { result = 'LOSS'; break; }
        } else {
          if (fwd.low  <= t1)   { result = 'WIN';  break; }
          if (fwd.high >= stop) { result = 'LOSS'; break; }
        }
      }

      const pnl = result === 'WIN' ? PNL_WIN : result === 'LOSS' ? -PNL_LOSS : 0;
      const sig = { day, i, result, pnl, stretchPct, levelCount: nearLevels.length };

      results.base.push(sig);
      if (stretchPct >= STRETCH_MIN)  results.stretch.push(sig);
      if (nearLevels.length >= 2)     results.multi.push(sig);
      if (nearLevels.length >= 3)     results.triple.push(sig);

      lastSignalIdx = i;
    }
  }

  const pct = (n, d) => d > 0 ? (n / d * 100).toFixed(1) + '%' : 'N/A';
  const mean = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

  function report(label, arr, claim) {
    const wins = arr.filter(s => s.result === 'WIN').length;
    const wr = arr.length > 0 ? wins / arr.length : 0;
    console.log(`  ${label}: N=${arr.length} WR=${pct(wins, arr.length)} EV=$${mean(arr.map(s=>s.pnl)).toFixed(2)} (claim: ${claim})`);
    return { n: arr.length, wr, ev: mean(arr.map(s => s.pnl)) };
  }

  console.log('\n════════════════════════════════════════════════════');
  console.log('  LEVEL EXHAUSTION / ABSORPTION BACKTEST RESULTS');
  console.log(`  30-bar approx-delta divergence | T=${TARGET}pt | S=${STOP}pt | proximity=max(30, 12%range)`);
  console.log('════════════════════════════════════════════════════\n');

  const baseStats   = report('SINGLE LEVEL (base)',         results.base,    '"56% WR"');
  const stretchStats = report(`STRETCH≥${STRETCH_MIN}%`,   results.stretch, '"66% WR"');
  const multiStats  = report('2+ LEVELS (confluence)',      results.multi,   '"70%+ WR"');
  const tripleStats = report('3+ LEVELS (triple)',          results.triple,  '"70%+ WR (triple)"');

  // Persist
  const today = new Date().toISOString().slice(0, 10);
  const rows = [
    ['BASE_LEVEL',              results.base.length,   baseStats.wr,    baseStats.ev],
    [`STRETCH_${STRETCH_MIN}PCT`, results.stretch.length, stretchStats.wr, stretchStats.ev],
    ['MULTI_LEVEL',             results.multi.length,  multiStats.wr,   multiStats.ev],
    ['TRIPLE_LEVEL',            results.triple.length, tripleStats.wr,  tripleStats.ev],
  ];
  const inserts = rows
    .filter(([, ss]) => ss >= 20)
    .map(([sn, ss, wr, ev]) => [today, 365*4, 'EXHAUST_BT', sn, ss, wr, ev]);

  for (const [rd, wd, st, sn, ss, wr, ev] of inserts) {
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 0)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
        sample_size=EXCLUDED.sample_size, win_rate=EXCLUDED.win_rate, ev_per_trade=EXCLUDED.ev_per_trade
    `, [rd, wd, st, sn, ss, wr, ev]);
  }

  if (inserts.length > 0) {
    console.log(`\n  Written to performance_audit (signal_type='EXHAUST_BT')`);
  } else {
    console.log('\n  N too low — not written to performance_audit');
  }
  console.log('════════════════════════════════════════════════════\n');
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
