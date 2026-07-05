// backtest_next_day_type.js
// ═══════════════════════════════════════════════════════════════════════
// Predict next-session day_type (BALANCE / TREND / TURBULENT) from
// features available before the open:
//   - Prior day type
//   - Overnight inventory  (SHORT_TRAPPED / NEUTRAL / LONG_TRAPPED)
//   - Open vs prior value  (ABOVE_VALUE / INSIDE_VALUE / BELOW_VALUE)
//   - Overnight range tier (small / medium / large vs rolling 20-day median)
//   - Gap tier             (up / flat / down vs rolling 20-day ATR)
//   - Day of week
//
// Outputs:
//   - Univariate: how much each feature shifts the base-rate distribution
//   - Bivariate: most actionable feature combos
//   - Overall accuracy vs base-rate
// ═══════════════════════════════════════════════════════════════════════

import { query } from '../server/db.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const DOW_LABEL = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
const DAY_TYPES = ['BALANCE','TREND','TURBULENT'];

async function run() {
  console.log('Loading features...');

  // 1. Core feature set — all available before RTH open
  const res = await query(`
    WITH rth_first AS (
      SELECT DISTINCT ON (ts::date) ts::date AS trade_date, open AS rth_open
      FROM price_bars_primary
      WHERE EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 575
      ORDER BY ts::date, ts
    ),
    rth_stats AS (
      SELECT ts::date AS trade_date,
             MAX(high)::float  AS day_high,
             MIN(low)::float   AS day_low,
             MAX(CASE WHEN EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 930 AND 960
                      THEN close END)::float AS session_close
      FROM price_bars_primary
      WHERE EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 960
      GROUP BY ts::date
    ),
    prev_day AS (
      SELECT d.trade_date,
             rs.trade_date AS prev_trade_date,
             rs.day_high - rs.day_low AS prev_range,
             rs.session_close         AS prev_close
      FROM acd_daily_log d
      JOIN LATERAL (
        SELECT rs2.trade_date, rs2.day_high, rs2.day_low, rs2.session_close
        FROM rth_stats rs2
        WHERE rs2.trade_date < d.trade_date
        ORDER BY rs2.trade_date DESC LIMIT 1
      ) rs ON TRUE
    )
    SELECT
      d.trade_date::text,
      d.day_type                                       AS next_day_type,
      EXTRACT(dow FROM d.trade_date)::int              AS dow,
      a.overnight_inventory,
      a.open_vs_prior_value,
      (onh.price - onl.price)::float                   AS overnight_range,
      (rf.rth_open - pd.prev_close)::float             AS gap_pts,
      pd.prev_range::float                             AS prev_day_range,
      d_prev.day_type                                  AS prev_day_type
    FROM acd_daily_log d
    JOIN auction_reads  a     ON a.trade_date   = d.trade_date
    JOIN level_prices   onh   ON onh.trade_date = d.trade_date AND onh.level_name = 'ONH'
    JOIN level_prices   onl   ON onl.trade_date = d.trade_date AND onl.level_name = 'ONL'
    JOIN rth_first      rf    ON rf.trade_date  = d.trade_date
    JOIN prev_day       pd    ON pd.trade_date  = d.trade_date
    JOIN acd_daily_log  d_prev ON d_prev.trade_date = pd.prev_trade_date
    WHERE d.day_type IS NOT NULL
      AND a.overnight_inventory IS NOT NULL
      AND a.open_vs_prior_value IS NOT NULL
      AND onh.price IS NOT NULL AND onl.price IS NOT NULL
      AND d_prev.day_type IS NOT NULL
      AND pd.prev_close IS NOT NULL
    ORDER BY d.trade_date
  `);

  const rows = res.rows;
  console.log(`  ${rows.length} qualifying days\n`);

  // 2. Bucket continuous features using rolling percentiles (no static thresholds)
  const onRanges  = rows.map(r => r.overnight_range).sort((a,b) => a-b);
  const gapPts    = rows.map(r => Math.abs(r.gap_pts)).sort((a,b) => a-b);
  const prevRanges= rows.map(r => r.prev_day_range).sort((a,b) => a-b);

  const pct = (arr, p) => arr[Math.floor(arr.length * p / 100)];
  const onP33 = pct(onRanges, 33),  onP67 = pct(onRanges, 67);
  const gapP50 = pct(gapPts, 50),   gapP80 = pct(gapPts, 80);
  const prP33  = pct(prevRanges, 33), prP67 = pct(prevRanges, 67);

  const bucketON  = v => v < onP33 ? 'NARROW' : v < onP67 ? 'MEDIUM' : 'WIDE';
  const bucketGap = (pts) => {
    const abs = Math.abs(pts);
    if (abs < gapP50) return 'FLAT';
    return pts > 0 ? (abs >= gapP80 ? 'BIG_UP' : 'UP') : (abs >= gapP80 ? 'BIG_DOWN' : 'DOWN');
  };
  const bucketPR  = v => v < prP33 ? 'TIGHT' : v < prP67 ? 'NORMAL' : 'WIDE';

  console.log(`Overnight range buckets: NARROW<${onP33.toFixed(0)}pt, MEDIUM<${onP67.toFixed(0)}pt, WIDE≥${onP67.toFixed(0)}pt`);
  console.log(`Gap buckets: FLAT<${gapP50.toFixed(0)}pt, UP/DOWN<${gapP80.toFixed(0)}pt, BIG_UP/DOWN≥${gapP80.toFixed(0)}pt`);
  console.log(`Prior day range: TIGHT<${prP33.toFixed(0)}pt, NORMAL<${prP67.toFixed(0)}pt, WIDE≥${prP67.toFixed(0)}pt\n`);

  // Enrich rows
  for (const r of rows) {
    r.on_bucket  = bucketON(r.overnight_range);
    r.gap_bucket = bucketGap(r.gap_pts);
    r.pr_bucket  = bucketPR(r.prev_day_range);
    r.dow_label  = DOW_LABEL[r.dow];
  }

  // 3. Helpers
  const baseRate = {};
  for (const dt of DAY_TYPES) {
    baseRate[dt] = rows.filter(r => r.next_day_type === dt).length / rows.length;
  }

  const condProb = (filtered, label = '') => {
    const n = filtered.length;
    if (!n) return null;
    const dist = {};
    for (const dt of DAY_TYPES) {
      dist[dt] = filtered.filter(r => r.next_day_type === dt).length / n;
    }
    return { n, dist };
  };

  const printSection = (title, groupFn, rows) => {
    const groups = {};
    for (const r of rows) {
      const key = groupFn(r);
      if (!groups[key]) groups[key] = [];
      groups[key].push(r);
    }
    console.log(`\n${title}`);
    console.log('─'.repeat(80));
    console.log(`  ${'Context'.padEnd(32)} ${'N'.padStart(5)}  BALANCE   TREND   TURB   Lift(T+TURB)`);
    const sorted = Object.entries(groups).sort((a,b) => b[1].length - a[1].length);
    for (const [key, grp] of sorted) {
      if (grp.length < 8) continue;
      const p = condProb(grp);
      const bal = (p.dist.BALANCE  * 100).toFixed(0);
      const trd = (p.dist.TREND    * 100).toFixed(0);
      const trb = (p.dist.TURBULENT* 100).toFixed(0);
      const volatile = p.dist.TREND + p.dist.TURBULENT;
      const basevolat = baseRate.TREND + baseRate.TURBULENT;
      const lift = ((volatile / basevolat - 1) * 100).toFixed(0);
      const liftStr = volatile > basevolat ? `+${lift}%` : `${lift}%`;
      const liftColor = volatile > basevolat + 0.05 ? '▲' : volatile < basevolat - 0.05 ? '▼' : '─';
      console.log(`  ${key.padEnd(32)} ${String(p.n).padStart(5)}  ${bal.padStart(7)}%  ${trd.padStart(5)}%  ${trb.padStart(5)}%   ${liftColor}${liftStr}`);
    }
  };

  // 4. Base rates
  console.log('BASE RATES (overall distribution)');
  console.log('─'.repeat(40));
  for (const dt of DAY_TYPES) console.log(`  ${dt.padEnd(12)} ${(baseRate[dt]*100).toFixed(1)}%  (N=${rows.filter(r=>r.next_day_type===dt).length})`);
  console.log(`  Total: ${rows.length} days`);

  // 5. Univariate sections
  printSection('PRIOR DAY TYPE', r => `prior=${r.prev_day_type}`, rows);
  printSection('OVERNIGHT INVENTORY', r => `inv=${r.overnight_inventory}`, rows);
  printSection('OPEN VS PRIOR VALUE', r => `open=${r.open_vs_prior_value}`, rows);
  printSection('OVERNIGHT RANGE TIER', r => `ON_range=${r.on_bucket}`, rows);
  printSection('GAP TIER', r => `gap=${r.gap_bucket}`, rows);
  printSection('PRIOR DAY RANGE TIER', r => `prev_range=${r.pr_bucket}`, rows);
  printSection('DAY OF WEEK', r => `dow=${r.dow_label}`, rows);

  // 6. Best bivariate combos
  printSection('PRIOR DAY TYPE × OVERNIGHT INVENTORY',
    r => `${r.prev_day_type} + ${r.overnight_inventory}`, rows);
  printSection('PRIOR DAY TYPE × OPEN VS VALUE',
    r => `${r.prev_day_type} + ${r.open_vs_prior_value}`, rows);
  printSection('OVERNIGHT INVENTORY × OPEN VS VALUE',
    r => `${r.overnight_inventory} + ${r.open_vs_prior_value}`, rows);
  printSection('OVERNIGHT RANGE × PRIOR DAY TYPE',
    r => `${r.prev_day_type} + ON=${r.on_bucket}`, rows);
  printSection('GAP × PRIOR DAY TYPE',
    r => `${r.prev_day_type} + gap=${r.gap_bucket}`, rows);

  // 7. Trivariate: the most actionable combo
  printSection('PRIOR DAY TYPE × OVERNIGHT INV × OPEN VS VALUE',
    r => `${r.prev_day_type}|${r.overnight_inventory}|${r.open_vs_prior_value}`, rows);

  // 8. High-volatility flag accuracy
  // Define "volatile" = TREND or TURBULENT
  // Find the combo that best predicts volatile days
  console.log('\n\nHIGH-VOLATILITY COMBOS (predicted volatile, actual volatile)');
  console.log('─'.repeat(80));
  const combos = [];
  const features = [
    r => `${r.prev_day_type}|${r.overnight_inventory}`,
    r => `${r.prev_day_type}|${r.open_vs_prior_value}`,
    r => `${r.overnight_inventory}|${r.open_vs_prior_value}`,
    r => `${r.prev_day_type}|${r.on_bucket}`,
    r => `${r.prev_day_type}|${r.gap_bucket}`,
    r => `${r.prev_day_type}|${r.overnight_inventory}|${r.open_vs_prior_value}`,
    r => `${r.prev_day_type}|${r.overnight_inventory}|${r.on_bucket}`,
  ];
  for (const fn of features) {
    const groups = {};
    for (const r of rows) {
      const k = fn(r);
      if (!groups[k]) groups[k] = [];
      groups[k].push(r);
    }
    for (const [key, grp] of Object.entries(groups)) {
      if (grp.length < 8) continue;
      const volatRate = grp.filter(r => r.next_day_type !== 'BALANCE').length / grp.length;
      combos.push({ key, n: grp.length, volatRate });
    }
  }
  combos.sort((a,b) => b.volatRate - a.volatRate);
  const baseVolat = baseRate.TREND + baseRate.TURBULENT;
  console.log(`  Base volatility rate: ${(baseVolat*100).toFixed(1)}% (TREND+TURBULENT)`);
  console.log(`  ${'Context'.padEnd(50)} ${'N'.padStart(5)}  ${'Volatile%'.padStart(10)}  Lift`);
  for (const c of combos.filter(c => c.volatRate > baseVolat + 0.05).slice(0, 15)) {
    const lift = ((c.volatRate / baseVolat - 1) * 100).toFixed(0);
    console.log(`  ${c.key.padEnd(50)} ${String(c.n).padStart(5)}  ${(c.volatRate*100).toFixed(0).padStart(9)}%  +${lift}%`);
  }

  console.log('\n\nLOW-VOLATILITY COMBOS (predicted BALANCE)');
  console.log('─'.repeat(80));
  for (const c of combos.filter(c => c.volatRate < baseVolat - 0.05).sort((a,b) => a.volatRate - b.volatRate).slice(0, 10)) {
    const drop = ((1 - c.volatRate / baseVolat) * 100).toFixed(0);
    console.log(`  ${c.key.padEnd(50)} ${String(c.n).padStart(5)}  ${(c.volatRate*100).toFixed(0).padStart(9)}%  -${drop}%`);
  }
}

run().then(() => {
  console.log('\nDone.');
  process.exit(0);
}).catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
