import { Client } from 'pg';
import { getBetClass } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeReplication, computeRigor } from '../server/services/rigorDiagnostics.js';
import fs from 'fs';

const client = new Client({
  host: 'localhost',
  port: 5432,
  database: 'trading_journal',
  user: 'gemini_readonly',
  password: 'gemini_ro_2026'
});

async function run() {
  await client.connect();

  const query = `
    SELECT
      a.trade_date,
      a.setup_type,
      a.actual_pnl,
      ar.prior_day_profile
    FROM active_setups a
    JOIN auction_reads ar ON a.trade_date = ar.trade_date
    WHERE a.origin_status IN ('ACTIVE', 'SHADOW')
      AND a.actual_pnl IS NOT NULL
  `;
  const { rows } = await client.query(query);
  
  const realFadeSetups = rows.filter(r => getBetClass(r.setup_type) === 'VALUE_FADE');
  realFadeSetups.forEach(r => r.actual_pnl = parseFloat(r.actual_pnl));
  
  // 2. Split: TREND vs everything else. Compute pooled WR/EV
  const trendSetups = realFadeSetups.filter(r => r.prior_day_profile === 'TREND');
  const otherSetups = realFadeSetups.filter(r => r.prior_day_profile !== 'TREND');

  const getStats = (arr) => {
    if (arr.length === 0) return {n: 0, wr: 0, ev: 0};
    const n = arr.length;
    const wins = arr.filter(x => x.actual_pnl > 0).length;
    const wr = wins / n;
    const totalPnl = arr.reduce((sum, x) => sum + x.actual_pnl, 0);
    const ev = (totalPnl * LIVE_INSTRUMENT.dollarsPerPoint) / n;
    return {n, wr: +(wr*100).toFixed(1), ev: +ev.toFixed(2)};
  };

  const trendStats = getStats(trendSetups);
  const otherStats = getStats(otherSetups);
  
  console.log('--- Task 1.2: Real Fade Setups Pooled ---');
  console.log(`TREND prior day: N=${trendStats.n}, WR=${trendStats.wr}%, EV=$${trendStats.ev}`);
  console.log(`OTHER prior day: N=${otherStats.n}, WR=${otherStats.wr}%, EV=$${otherStats.ev}`);
  
  // 3. run computeReplication()
  const setupTypes = [...new Set(realFadeSetups.map(r => r.setup_type))];
  
  const metricFn = (type) => {
    const subset = realFadeSetups.filter(r => r.setup_type === type);
    const t = subset.filter(r => r.prior_day_profile === 'TREND');
    const o = subset.filter(r => r.prior_day_profile !== 'TREND');
    if (t.length === 0 || o.length === 0) return null;
    const tStats = getStats(t);
    const oStats = getStats(o);
    const diff = tStats.ev - oStats.ev;
    return { n: t.length + o.length, value: diff, tN: t.length, oN: o.length, tEV: tStats.ev, oEV: oStats.ev };
  };
  
  const allStats = setupTypes.map(type => {
    return { type, metric: metricFn(type) };
  }).filter(x => x.metric !== null).sort((a, b) => b.metric.value - a.metric.value);
  
  console.log('\n--- Task 1.3: Per-setup breakdown (N>=20 total) ---');
  allStats.filter(x => x.metric.n >= 20).forEach(x => {
    console.log(`${x.type}: N=${x.metric.n} (TREND: N=${x.metric.tN}, EV=$${x.metric.tEV} | OTHER: N=${x.metric.oN}, EV=$${x.metric.oEV}) -> Diff: $${x.metric.value.toFixed(2)}`);
  });
  
  const selectedIds = allStats.slice(0, 2).map(x => x.type);
  const rep = computeReplication(setupTypes, { idFn: u => u, metricFn, selectedIds });
  console.log('\n--- computeReplication (Top 2 by EV Diff vs Rest) ---');
  console.log(JSON.stringify(rep, null, 2));

  // 4. Day-clustering/chronological-stability check on the underlying rotation-day finding itself.
  const arQuery = `
    SELECT ar.trade_date, ar.prior_day_profile, pb.day_range
    FROM auction_reads ar
    JOIN (
      SELECT DATE(ts) as trade_date, MAX(high) - MIN(low) as day_range
      FROM price_bars_primary
      WHERE symbol = 'NQ'
      GROUP BY DATE(ts)
    ) pb ON ar.trade_date = pb.trade_date
    ORDER BY ar.trade_date
  `;
  const { rows: arRows } = await client.query(arQuery);
  arRows.forEach(r => r.day_range = parseFloat(r.day_range));
  
  const trendDays = arRows.filter(r => r.prior_day_profile === 'TREND');
  const otherDays = arRows.filter(r => r.prior_day_profile !== 'TREND');
  
  console.log('\n--- Task 1.4: Rotation Day check ---');
  console.log(`Total AR rows: ${arRows.length}. TREND: ${trendDays.length}, OTHER: ${otherDays.length}`);
  
  const trendRot = trendDays.filter(r => r.day_range >= 500);
  const otherRot = otherDays.filter(r => r.day_range >= 500);
  console.log(`TREND >=500pt: ${trendRot.length}/${trendDays.length} (${(trendRot.length/trendDays.length*100).toFixed(1)}%)`);
  console.log(`OTHER >=500pt: ${otherRot.length}/${otherDays.length} (${(otherRot.length/otherDays.length*100).toFixed(1)}%)`);
  
  // What fraction of the TREND->rotation subset falls in the top-5 individual dates?
  // Because each row is a unique date, top 5 dates hold exactly 5 items.
  const top5Pct = trendRot.length > 0 ? (Math.min(5, trendRot.length) / trendRot.length * 100).toFixed(1) : 0;
  console.log(`TREND->rotation top-5 dates hold: ${Math.min(5, trendRot.length)}/${trendRot.length} = ${top5Pct}%`);
  
  // 3-way chronological split
  const splitThirds = (arr) => {
    const third = Math.floor(arr.length / 3);
    return [
      arr.slice(0, third),
      arr.slice(third, 2*third),
      arr.slice(2*third)
    ];
  };
  
  // We need to chronological split the underlying sequence of ALL days, and then in each third check TREND rot% vs OTHER rot%
  // Or do we split the TREND days into thirds?
  // "does a 3-way chronological split (early/mid/late thirds of the sample) keep the same sign throughout?"
  // "of the sample" usually means the full timeline.
  const thirds = splitThirds(arRows);
  
  thirds.forEach((t, i) => {
    const td = t.filter(r => r.prior_day_profile === 'TREND');
    const od = t.filter(r => r.prior_day_profile !== 'TREND');
    const tr = td.filter(r => r.day_range >= 500);
    const or = od.filter(r => r.day_range >= 500);
    
    const trPct = td.length > 0 ? tr.length/td.length : 0;
    const orPct = od.length > 0 ? or.length/od.length : 0;
    
    console.log(`Third ${i+1}: TREND rot=${tr.length}/${td.length} (${(trPct*100).toFixed(1)}%), OTHER rot=${or.length}/${od.length} (${(orPct*100).toFixed(1)}%) -> Diff: +${((trPct-orPct)*100).toFixed(1)}%`);
  });

  await client.end();
}
run().catch(console.error);
