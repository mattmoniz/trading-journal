import { query } from '../server/db.js';
import { 
  fiveMinBars, 
  stdevLogReturns, 
  getPercentile, 
  classifyRegime 
} from '../server/services/volatilityRegimeService.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const N_BASELINE = 60;
const RTH_START_MIN = 570;   // 9:30 ET

async function getBaselineForDuration(todayET, durationMins, allBarsByDate, validDates) {
  const recentDates = validDates.filter(d => d < todayET).slice(-N_BASELINE);
  if (recentDates.length < N_BASELINE) return null;
  
  const endMin = RTH_START_MIN + durationMins;
  
  const vols = [];
  for (const d of recentDates) {
    const dayBars = allBarsByDate[d] || [];
    const windowBars = dayBars.filter(b => b.et_min < endMin);
    const five = fiveMinBars(windowBars);
    const vol = stdevLogReturns(five);
    if (vol != null) vols.push(vol);
  }
  
  if (vols.length < 2) return null;
  const mean = vols.reduce((s, x) => s + x, 0) / vols.length;
  const sd = Math.sqrt(vols.reduce((s, x) => s + (x - mean) ** 2, 0) / (vols.length - 1));
  const pct80 = getPercentile(vols, 0.80);
  const pct20 = getPercentile(vols, 0.20);
  
  return { mean, sd, pct80, pct20, n: vols.length };
}

import { computeReplication } from '../server/services/rigorDiagnostics.js';

async function computeReplicationReal(labelData) {
  const tradesQ = await query(`
    SELECT trade_date::text as d, origin_status, actual_pnl, setup_type 
    FROM active_setups 
    WHERE origin_status IN ('ACTIVE','SHADOW') 
      AND actual_pnl IS NOT NULL
      AND bet_class = 'VALUE_FADE'
  `);
  
  const labelSetups = {};
  for (const t of tradesQ.rows) {
    const lbl = labelData[t.d];
    if (!lbl) continue;
    if (!labelSetups[lbl]) labelSetups[lbl] = {};
    if (!labelSetups[lbl][t.setup_type]) labelSetups[lbl][t.setup_type] = {n:0, pnl:0};
    labelSetups[lbl][t.setup_type].n += 1;
    labelSetups[lbl][t.setup_type].pnl += Number(t.actual_pnl);
  }
  
  for (const [lbl, typeMap] of Object.entries(labelSetups)) {
    const units = [];
    for (const [s, data] of Object.entries(typeMap)) {
      units.push({ id: s, metric: { n: data.n, value: data.pnl / data.n } });
    }
    
    // Sort setups by impact (n * diff from baseline). Since we just want to know if it replicates, we can just use value.
    const selected = units.filter(u => u.metric.n >= 10).sort((a,b) => b.metric.value - a.metric.value).map(u => u.id).slice(0, 5);
    
    if (selected.length > 0) {
      console.log(`  ${lbl.padEnd(20)}:`);
      const rep = computeReplication(units, { idFn: u => u.id, metricFn: u => u.metric, selectedIds: selected });
      console.log(`    Replicates? ${rep.replicates} (selected: ${selected.join(',')})`);
    } else {
      console.log(`  ${lbl.padEnd(20)}: Not enough data for computeReplication (requires N>=10 per setup)`);
    }
  }
}

async function main() {
  console.log("Loading price bars...");
  const barsQ = await query(`
    SELECT ts::date::text as d,
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
      open::float, high::float, low::float, close::float
    FROM price_bars_primary WHERE symbol='NQ'
      AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
    ORDER BY ts
  `);
  
  const fullCountsQ = await query(`
    SELECT ts::date::text as d, COUNT(*) as n
    FROM price_bars_primary WHERE symbol='NQ'
      AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
    GROUP BY ts::date
  `);
  const fullCounts = {};
  for (const r of fullCountsQ.rows) fullCounts[r.d] = Number(r.n);
  
  const allBarsByDate = {};
  for (const b of barsQ.rows) {
    if (!allBarsByDate[b.d]) allBarsByDate[b.d] = [];
    allBarsByDate[b.d].push(b);
  }
  
  const validDates = Object.keys(allBarsByDate).filter(d => (fullCounts[d] || 0) >= 200).sort();
  
  console.log("Found " + validDates.length + " valid dates.");
  
  const labels15 = {};
  const labels30 = {};
  const labels60 = {};
  
  for (let i = 60; i < validDates.length; i++) {
    const today = validDates[i];
    const todayBars = allBarsByDate[today];
    
    // Compute actual trends for 60 min to split HIGH-VOL
    const sessOpen = todayBars[0].open;
    const sessClose60 = (todayBars.find(b => b.et_min === RTH_START_MIN + 59) || todayBars[todayBars.length-1]).close;
    const sessHigh60 = Math.max(...todayBars.filter(b => b.et_min < RTH_START_MIN + 60).map(b => b.high));
    const sessLow60 = Math.min(...todayBars.filter(b => b.et_min < RTH_START_MIN + 60).map(b => b.low));
    const trendStr60 = (sessHigh60 - sessLow60) > 0 ? Math.abs(sessClose60 - sessOpen) / (sessHigh60 - sessLow60) : 0;
    
    const sessClose15 = (todayBars.find(b => b.et_min === RTH_START_MIN + 14) || todayBars[0]).close;
    const sessHigh15 = Math.max(...todayBars.filter(b => b.et_min < RTH_START_MIN + 15).map(b => b.high));
    const sessLow15 = Math.min(...todayBars.filter(b => b.et_min < RTH_START_MIN + 15).map(b => b.low));
    const trendStr15 = (sessHigh15 - sessLow15) > 0 ? Math.abs(sessClose15 - sessOpen) / (sessHigh15 - sessLow15) : 0;

    const sessClose30 = (todayBars.find(b => b.et_min === RTH_START_MIN + 29) || todayBars[0]).close;
    const sessHigh30 = Math.max(...todayBars.filter(b => b.et_min < RTH_START_MIN + 30).map(b => b.high));
    const sessLow30 = Math.min(...todayBars.filter(b => b.et_min < RTH_START_MIN + 30).map(b => b.low));
    const trendStr30 = (sessHigh30 - sessLow30) > 0 ? Math.abs(sessClose30 - sessOpen) / (sessHigh30 - sessLow30) : 0;
    
    const getRegime = async (duration, trendStr) => {
      const b = await getBaselineForDuration(today, duration, allBarsByDate, validDates);
      if (!b) return null;
      const windowBars = todayBars.filter(bar => bar.et_min < RTH_START_MIN + duration);
      const five = fiveMinBars(windowBars);
      const vol = stdevLogReturns(five);
      return classifyRegime(vol, b, trendStr, true);
    };
    
    labels15[today] = await getRegime(15, trendStr15);
    labels30[today] = await getRegime(30, trendStr30);
    labels60[today] = await getRegime(60, trendStr60);
  }
  
  let agree15 = 0, agree30 = 0, totalCompared = 0;
  for (const d of Object.keys(labels60)) {
    if (labels60[d]) {
      totalCompared++;
      if (labels15[d] === labels60[d]) agree15++;
      if (labels30[d] === labels60[d]) agree30++;
    }
  }
  
  console.log("\\nAgreement with 60-min label (N=" + totalCompared + "):");
  console.log("  15-min label: " + agree15 + "/" + totalCompared + " (" + (agree15/totalCompared*100).toFixed(1) + "%)");
  console.log("  30-min label: " + agree30 + "/" + totalCompared + " (" + (agree30/totalCompared*100).toFixed(1) + "%)");
  
  console.log("\\nDownstream Fade EV separation (60-min ground truth):");
  await computeReplicationReal(labels60);
  console.log("\\nDownstream Fade EV separation (30-min early):");
  await computeReplicationReal(labels30);
  console.log("\\nDownstream Fade EV separation (15-min early):");
  await computeReplicationReal(labels15);
  
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
