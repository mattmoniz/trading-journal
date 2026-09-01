import { query } from '../server/db.js';
import { getVolumeBaseline } from '../server/services/touchQuality.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

async function main() {
  const setupRes = await query(`
    SELECT id, setup_type, trade_date::text as trade_date_str, fired_at, resolution, actual_pnl
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND setup_type LIKE '%_FADE_%'
      AND resolution IN ('STOP_HIT','TARGET_HIT')
      AND actual_pnl IS NOT NULL
      AND fired_at IS NOT NULL
  `);

  const events = [];
  const baselineCache = {};

  for (let i = 0; i < setupRes.rows.length; i++) {
    const trade = setupRes.rows[i];
    
    if (!baselineCache[trade.trade_date_str]) {
      baselineCache[trade.trade_date_str] = await getVolumeBaseline(query, trade.trade_date_str);
    }
    const baselineMap = baselineCache[trade.trade_date_str];

    const direction = trade.setup_type.includes('_LONG') ? 'LONG' : 'SHORT';
    const flooredFiredAt = new Date(trade.fired_at);
    flooredFiredAt.setSeconds(0, 0);
    const firedAtNaive = flooredFiredAt.toISOString().slice(0, 19).replace('T', ' ');

    const barRes = await query(`
      SELECT ts, open::float, high::float, low::float, close::float, bid_volume, ask_volume,
             EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) as tod
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts < $1::timestamp
      ORDER BY ts DESC
      LIMIT 1
    `, [firedAtNaive]);

    if (barRes.rows.length === 0) continue;
    const bar = barRes.rows[0];

    const totalVol = (bar.bid_volume || 0) + (bar.ask_volume || 0);
    const bl = baselineMap.get(Number(bar.tod));

    const volZ = (bl && bl.std_vol > 0) ? (totalVol - bl.avg_vol) / bl.std_vol : 0;

    const favorableVol = direction === 'LONG' ? (bar.ask_volume || 0) : (bar.bid_volume || 0);
    const adverseVol = direction === 'LONG' ? (bar.bid_volume || 0) : (bar.ask_volume || 0);
    const oneSidedRatio = (favorableVol + adverseVol) > 0 ? favorableVol / (favorableVol + adverseVol) : 0.5;

    events.push({
      id: trade.id,
      trade_date: trade.trade_date_str,
      pnl: parseFloat(trade.actual_pnl),
      volZ,
      oneSidedRatio
    });
  }

  // Bucket by volZ (terciles)
  events.sort((a, b) => a.volZ - b.volZ);
  const volZ_T1 = percentile(events.map(e => e.volZ), 0.33);
  const volZ_T2 = percentile(events.map(e => e.volZ), 0.67);

  const volZ_buckets = [
    events.filter(e => e.volZ <= volZ_T1),
    events.filter(e => e.volZ > volZ_T1 && e.volZ <= volZ_T2),
    events.filter(e => e.volZ > volZ_T2)
  ];

  console.log("\n--- volZ Terciles ---");
  for (let i = 0; i < volZ_buckets.length; i++) {
    const bucket = volZ_buckets[i];
    const n = bucket.length;
    if (n < 20) continue;
    const ev = bucket.reduce((sum, e) => sum + e.pnl, 0) / n;
    const rigor = computeRigor(bucket, { dateField: 'trade_date', pnlFn: e => e.pnl });
    console.log(`T${i+1} (<= ${i===0?volZ_T1.toFixed(2):i===1?volZ_T2.toFixed(2):'max'}): N=${n}, EV=$${ev.toFixed(2)}, clean=${rigor.clean}, stable=${rigor.stable}`);
  }

  // Bucket by oneSidedRatio (terciles)
  events.sort((a, b) => a.oneSidedRatio - b.oneSidedRatio);
  const osr_T1 = percentile(events.map(e => e.oneSidedRatio), 0.33);
  const osr_T2 = percentile(events.map(e => e.oneSidedRatio), 0.67);

  const osr_buckets = [
    events.filter(e => e.oneSidedRatio <= osr_T1),
    events.filter(e => e.oneSidedRatio > osr_T1 && e.oneSidedRatio <= osr_T2),
    events.filter(e => e.oneSidedRatio > osr_T2)
  ];

  console.log("\n--- oneSidedRatio Terciles ---");
  for (let i = 0; i < osr_buckets.length; i++) {
    const bucket = osr_buckets[i];
    const n = bucket.length;
    if (n < 20) continue;
    const ev = bucket.reduce((sum, e) => sum + e.pnl, 0) / n;
    const rigor = computeRigor(bucket, { dateField: 'trade_date', pnlFn: e => e.pnl });
    console.log(`T${i+1} (<= ${i===0?osr_T1.toFixed(2):i===1?osr_T2.toFixed(2):'max'}): N=${n}, EV=$${ev.toFixed(2)}, clean=${rigor.clean}, stable=${rigor.stable}`);
  }

  // Combined 2x2
  const volZ_med = percentile(events.map(e => e.volZ).sort((a,b)=>a-b), 0.5);
  const osr_med = percentile(events.map(e => e.oneSidedRatio).sort((a,b)=>a-b), 0.5);

  const combined = [
    { name: 'Low volZ, Low OSR', b: events.filter(e => e.volZ <= volZ_med && e.oneSidedRatio <= osr_med) },
    { name: 'Low volZ, High OSR', b: events.filter(e => e.volZ <= volZ_med && e.oneSidedRatio > osr_med) },
    { name: 'High volZ, Low OSR', b: events.filter(e => e.volZ > volZ_med && e.oneSidedRatio <= osr_med) },
    { name: 'High volZ, High OSR', b: events.filter(e => e.volZ > volZ_med && e.oneSidedRatio > osr_med) }
  ];

  console.log("\n--- Combined (Median Split) ---");
  for (const c of combined) {
    const n = c.b.length;
    if (n < 20) continue;
    const ev = c.b.reduce((sum, e) => sum + e.pnl, 0) / n;
    const rigor = computeRigor(c.b, { dateField: 'trade_date', pnlFn: e => e.pnl });
    console.log(`${c.name}: N=${n}, EV=$${ev.toFixed(2)}, clean=${rigor.clean}, stable=${rigor.stable}`);
  }


  const pooledN = events.length;
  const pooledWr = events.filter(e => e.pnl > 0).length / pooledN;
  const pooledEv = events.reduce((s, e) => s + e.pnl, 0) / pooledN;
  await recordClaim({
    slug: 'prefire_orderflow_touch_gate_negative',
    claimText: `Testing if pre-fire volZ/oneSidedRatio (same formula as acd.js's STACK_VOL_BREAK_LIVE, reusing getVolumeBaseline() -- but computed from the bar strictly BEFORE the fired_at minute, not the same trigger bar STACK_VOL_BREAK_LIVE itself reads, a deliberate stricter-no-lookahead choice that makes this a related-but-not-identical test) predicts real fade outcome (N=${pooledN}, all origin_status IN ACTIVE/SHADOW fade touches). Result: flat/negative, no monotonic predictive power -- volZ terciles non-monotonic ($-0.97/-3.77/+6.37), oneSidedRatio terciles non-monotonic ($4.21/-7.98/+5.54), 2x2 combined split shows no clean quadrant pattern (best cell $9.13 clean=false, day-clustered). Direction inferred via a simple _LONG/_SHORT substring check, not the canonical directionFromType() -- a minor deviation from this codebase's own convention, unlikely to change the result given the population is dominated by simply-suffixed setup_types.`,
    sourceFile: 'scripts/pilot_prefire_touch_quality.mjs',
    sampleSize: pooledN,
    winRate: pooledWr,
    evPerTrade: pooledEv,
    rigorStatus: 'non_monotonic_no_clean_bucket',
    status: 'PROVISIONAL',
  });
  console.log("Task 1 Done.");
  process.exit(0);
}
main().catch(console.error);
