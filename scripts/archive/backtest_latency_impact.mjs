// Backtest: does alert latency actually hurt P&L?
// For each resolved FADE setup:
//   1. Find first RTH bar within 15pt of entry level → first_bar_ts, first_bar_price
//   2. Find bar price at fired_at → fired_price
//   3. Compute entry slippage: how much worse was the entry due to lag?
//   4. For TARGET_HIT: did T1 get hit BEFORE fired_at? (phantom win — missed entirely)

import { query } from '../server/db.js';

const PROXIMITY_PT  = 15;
const PNL_PER_POINT = 2;

function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = (p / 100) * (s.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}

async function run() {
  console.log('Loading resolved FADE setups (last 180 days)…');

  // Single query: pull each setup + first RTH bar within 15pt + bar price at fired_at
  const res = await query(`
    WITH setups AS (
      SELECT
        s.id,
        s.setup_type,
        s.trade_date,
        s.fired_at,
        s.resolution,
        s.entry_zone_low::numeric  AS level_price,
        s.t1_level::numeric        AS t1,
        s.stop_level::numeric      AS stop,
        s.mae_points::numeric      AS mae,
        s.mfe_points::numeric      AS mfe,
        CASE WHEN s.setup_type LIKE '%LONG%' THEN 'LONG' ELSE 'SHORT' END AS dir
      FROM active_setups s
      WHERE s.status = 'RESOLVED'
        AND s.resolution IN ('TARGET_HIT', 'STOP_HIT')
        AND s.setup_type LIKE '%FADE%'
        AND s.entry_zone_low IS NOT NULL
        AND s.t1_level IS NOT NULL
        AND s.trade_date >= CURRENT_DATE - INTERVAL '180 days'
        -- RTH setups only (skip globex pre-market fires)
        AND s.fired_at >= (s.trade_date + TIME '09:30:00')
    ),
    -- First RTH bar within proximity of the level
    first_touch AS (
      SELECT DISTINCT ON (s.id)
        s.id,
        b.ts    AS first_bar_ts,
        b.close AS first_bar_price
      FROM setups s
      JOIN price_bars_primary b ON
        b.ts::date = s.trade_date
        AND b.ts >= (s.trade_date + TIME '09:30:00')
        AND b.high >= s.level_price - $1
        AND b.low  <= s.level_price + $1
      ORDER BY s.id, b.ts ASC
    ),
    -- Bar price at fired_at (latest bar whose ts <= fired_at)
    price_at_fire AS (
      SELECT DISTINCT ON (s.id)
        s.id,
        b.close AS fired_price
      FROM setups s
      JOIN price_bars_primary b ON
        b.ts::date = s.trade_date
        AND b.ts <= s.fired_at
        AND b.ts >= (s.trade_date + TIME '09:30:00')
      ORDER BY s.id, b.ts DESC
    ),
    -- For TARGET_HIT: first bar where T1 was reached (to detect phantom wins)
    t1_hit AS (
      SELECT DISTINCT ON (s.id)
        s.id,
        b.ts AS t1_hit_ts
      FROM setups s
      JOIN price_bars_primary b ON
        b.ts::date = s.trade_date
        AND b.ts >= (s.trade_date + TIME '09:30:00')
        AND (
          (s.dir = 'LONG'  AND b.high >= s.t1) OR
          (s.dir = 'SHORT' AND b.low  <= s.t1)
        )
      WHERE s.resolution = 'TARGET_HIT'
      ORDER BY s.id, b.ts ASC
    )
    SELECT
      s.id,
      s.setup_type,
      s.trade_date,
      s.fired_at,
      s.resolution,
      s.level_price,
      s.t1,
      s.dir,
      s.mae,
      s.mfe,
      ft.first_bar_ts,
      ft.first_bar_price,
      paf.fired_price,
      th.t1_hit_ts,
      EXTRACT(epoch FROM (s.fired_at - ft.first_bar_ts))::int AS lag_s
    FROM setups s
    LEFT JOIN first_touch  ft  ON ft.id  = s.id
    LEFT JOIN price_at_fire paf ON paf.id = s.id
    LEFT JOIN t1_hit        th  ON th.id  = s.id
    ORDER BY s.trade_date, s.fired_at
  `, [PROXIMITY_PT]);

  const rows = res.rows;
  console.log(`Loaded ${rows.length} setups.\n`);

  const results = [];
  for (const r of rows) {
    const lag = r.lag_s != null ? parseInt(r.lag_s) : null;
    if (lag == null || lag < 0) continue;          // skip no-bar or negative
    if (lag > 2700) continue;                       // skip retroactive backfills

    const fp = parseFloat(r.fired_price);
    const fbp = parseFloat(r.first_bar_price);
    const lvl = parseFloat(r.level_price);

    // Entry slippage: how far did price move away from the level between first touch and fire?
    // For LONG fade: level is a support, price should bounce up. Entering higher = worse.
    // For SHORT fade: level is resistance, price should fade down. Entering lower = worse.
    // "Worse" = entered further from where a clean first-touch entry would have been.
    let slippage_pts = null;
    if (!isNaN(fp) && !isNaN(fbp)) {
      // Distance from level at each point
      const dist_at_fire  = Math.abs(fp  - lvl);
      const dist_at_touch = Math.abs(fbp - lvl);
      // Positive slippage = entered further from level (worse). Negative = closer (better).
      slippage_pts = dist_at_fire - dist_at_touch;
    }

    // Phantom win: T1 was hit before the alert fired
    const phantom = r.resolution === 'TARGET_HIT' && r.t1_hit_ts != null
      ? new Date(r.t1_hit_ts) < new Date(r.fired_at)
      : false;

    // P&L impact of slippage: if you entered slippage_pts further from the level,
    // you got a worse fill. For TARGET_HIT: you have less room to T1 = less P&L.
    // For STOP_HIT: the stop hit sooner = same loss (stop is fixed), but entry was worse.
    // Simple estimate: slippage directly reduces realized P&L
    const slippage_pnl = slippage_pts != null ? -slippage_pts * PNL_PER_POINT : null;

    results.push({ ...r, lag, slippage_pts, slippage_pnl, phantom });
  }

  // Buckets
  const bucket = (lag) => {
    if (lag === 0)          return 'OK_0s';
    if (lag <= 60)          return 'OK_1min';
    if (lag <= 120)         return 'SLOW_2min';
    if (lag <= 300)         return 'CRITICAL_5min';
    return                         'CRITICAL_5min+';
  };

  const buckets = {};
  for (const r of results) {
    const b = bucket(r.lag);
    if (!buckets[b]) buckets[b] = [];
    buckets[b].push(r);
  }

  console.log('=== LATENCY IMPACT BACKTEST ===\n');
  console.log(`Total setups analyzed: ${results.length}`);
  console.log(`Distinct trading days: ${new Set(results.map(r => String(r.trade_date).slice(0,10))).size}\n`);

  console.log('--- By lag bucket ---');
  const header = 'Bucket'.padEnd(16) + 'N'.padEnd(6) + 'Avg slip'.padEnd(10) + 'Total $slip'.padEnd(14) + '% phantom wins';
  console.log(header);
  console.log('-'.repeat(header.length));

  let totalSlipPnl = 0;
  let totalPhantom = 0;
  let totalTargetHit = 0;

  for (const [b, rows] of Object.entries(buckets).sort((a,b) => a[0].localeCompare(b[0]))) {
    const slips = rows.map(r => r.slippage_pts).filter(s => s != null);
    const avgSlip = slips.length ? slips.reduce((a,b) => a+b, 0) / slips.length : 0;
    const totalSlip = rows.reduce((a, r) => a + (r.slippage_pnl ?? 0), 0);
    const targets = rows.filter(r => r.resolution === 'TARGET_HIT');
    const phantoms = rows.filter(r => r.phantom);
    const pctPhantom = targets.length ? (phantoms.length / targets.length * 100).toFixed(1) : '--';
    totalSlipPnl += totalSlip;
    totalPhantom += phantoms.length;
    totalTargetHit += targets.length;
    console.log(
      b.padEnd(16) +
      String(rows.length).padEnd(6) +
      (avgSlip >= 0 ? '+' : '') + avgSlip.toFixed(1).padEnd(9) + ' ' +
      ('$' + totalSlip.toFixed(0)).padEnd(14) +
      pctPhantom + '%'
    );
  }

  console.log('\n--- Overall ---');
  console.log(`Total estimated slippage P&L: $${totalSlipPnl.toFixed(0)}`);
  const nDates = new Set(results.map(r => String(r.trade_date).slice(0,10))).size;
  console.log(`Annualized (252/${nDates} days): $${(totalSlipPnl * 252 / nDates).toFixed(0)}/yr`);
  const pctPhantomAll = totalTargetHit ? (totalPhantom / totalTargetHit * 100).toFixed(1) : '--';
  console.log(`Phantom wins: ${totalPhantom}/${totalTargetHit} TARGET_HIT setups (${pctPhantomAll}%) — T1 hit before alert fired`);

  // Lag distribution
  const lags = results.map(r => r.lag);
  console.log(`\n--- Lag distribution (${results.length} setups) ---`);
  console.log(`Median: ${percentile(lags, 50)}s  P75: ${percentile(lags, 75)}s  P90: ${percentile(lags, 90)}s  Max: ${Math.max(...lags)}s`);
  console.log(`Lag=0s: ${results.filter(r => r.lag === 0).length} (${(results.filter(r=>r.lag===0).length/results.length*100).toFixed(0)}%)`);
  console.log(`Lag>120s (CRITICAL): ${results.filter(r => r.lag > 120).length} (${(results.filter(r=>r.lag>120).length/results.length*100).toFixed(0)}%)`);

  // Phantom wins list
  const phantoms = results.filter(r => r.phantom);
  if (phantoms.length) {
    console.log(`\n--- Phantom wins (${phantoms.length} setups — T1 hit before alert) ---`);
    for (const r of phantoms.slice(0, 20)) {
      const d = String(r.trade_date).slice(0,10);
      const firedEt = new Date(r.fired_at).getUTCHours().toString().padStart(2,'0') + ':' + new Date(r.fired_at).getUTCMinutes().toString().padStart(2,'0');
      const t1Et   = new Date(r.t1_hit_ts).getUTCHours().toString().padStart(2,'0') + ':' + new Date(r.t1_hit_ts).getUTCMinutes().toString().padStart(2,'0');
      console.log(`  ${d}  ${r.setup_type.padEnd(32)}  lag=${r.lag}s  T1_hit=${t1Et}  fired=${firedEt}  slip=${r.slippage_pts?.toFixed(1) ?? '--'}pt`);
    }
    if (phantoms.length > 20) console.log(`  … and ${phantoms.length - 20} more`);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
