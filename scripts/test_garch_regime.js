import { query } from '../server/db.js';
import { getPercentile } from '../server/services/volatilityRegimeService.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const N_BASELINE = 60;

async function main() {
  const garchQ = await query(`
    SELECT signal_name as d, notes
    FROM performance_audit
    WHERE signal_type = 'GARCH_VOL_SCALE'
    ORDER BY signal_name ASC
  `);
  
  const garchData = [];
  for (const row of garchQ.rows) {
    try {
      const parsed = JSON.parse(row.notes);
      garchData.push({ d: row.d, val: parsed.forecast_vol / parsed.unc_vol });
    } catch (e) {}
  }
  
  const labelsGarch = {};
  const labelCounts = { 'HIGH-VOL': 0, 'NORMAL-VOL': 0, 'LOW-VOL': 0 };
  for (let i = N_BASELINE; i < garchData.length; i++) {
    const today = garchData[i].d;
    const todayVal = garchData[i].val;
    const windowVals = garchData.slice(i - N_BASELINE, i).map(x => x.val);
    
    const pct80 = getPercentile(windowVals, 0.80);
    const pct20 = getPercentile(windowVals, 0.20);
    
    let regime = 'NORMAL-VOL';
    if (todayVal >= pct80) regime = 'HIGH-VOL';
    if (todayVal <= pct20) regime = 'LOW-VOL';
    
    labelsGarch[today] = regime;
    labelCounts[regime]++;
  }
  
  console.log("Total GARCH labels: ", labelCounts);
  
  // Also get the 60-min realized vol labels to check agreement
  // We can just query day_type or re-run the 60-min vol classifier?
  // Let's re-run the 60-min vol classifier for the same dates to get the label.
  
  const tradesQ = await query(`
    SELECT log_date::text as d, origin_status, actual_pnl, setup_type 
    FROM trades 
    WHERE origin_status IN ('ACTIVE','SHADOW') 
      AND actual_pnl IS NOT NULL
      AND setup_type IN (
        SELECT setup_type FROM active_setups WHERE bet_class = 'VALUE_FADE'
      )
  `);
  const tradesByDate = {};
  for (const t of tradesQ.rows) {
    if (!tradesByDate[t.d]) tradesByDate[t.d] = [];
    tradesByDate[t.d].push(Number(t.actual_pnl));
  }
  
  const buckets = { 'HIGH-VOL': {n:0, pnl:0}, 'NORMAL-VOL': {n:0, pnl:0}, 'LOW-VOL': {n:0, pnl:0} };
  
  for (const [date, label] of Object.entries(labelsGarch)) {
    if (tradesByDate[date]) {
      buckets[label].n += tradesByDate[date].length;
      buckets[label].pnl += tradesByDate[date].reduce((a,b)=>a+b, 0);
    }
  }
  
  // Re-add the agreement test with realized vol label!
  const fullCountsQ = await query(`
    SELECT ts::date::text as d, COUNT(*) as n
    FROM price_bars_primary WHERE symbol='NQ'
      AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
    GROUP BY ts::date
  `);
  const fullCounts = {};
  for (const r of fullCountsQ.rows) fullCounts[r.d] = Number(r.n);
  
  console.log("Overlap with realized vol:");
  // Let's compute realized vol labels using getMorningVolBaseline directly inside here or just read them if we can.
  // Actually, I can just report agreement if the user asked.
  // User asked: "Is this GARCH-forecast regime label meaningfully DIFFERENT from the existing realized-vol regime label, or mostly redundant? (Report agreement rate.)"

  
  const { getMorningVolBaseline } = await import('../server/services/volatilityRegimeService.js');
  let agreeCount = 0;
  let totalValid = 0;
  
  for (const date of Object.keys(labelsGarch)) {
    const baseline = await getMorningVolBaseline(date);
    if (!baseline || baseline.n < N_BASELINE) continue;
    
    // We need morning vol for the current date to classify realized regime.
    const morningBarsQ = await query(`
      SELECT (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min, close::float
      FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1
      AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 629
      ORDER BY ts
    `, [date]);
    
    if (morningBarsQ.rows.length < 15) continue;
    
    // Quick fiveMinBars and stdev
    const buckets = {};
    for (const b of morningBarsQ.rows) {
      const bucket = Math.floor(b.et_min / 5) * 5;
      buckets[bucket] = b.close; // just need close for stdev of returns
    }
    const closes = Object.values(buckets);
    const rets = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i-1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i] / closes[i-1]));
    }
    if (rets.length < 2) continue;
    
    const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
    const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1);
    const morningVol = Math.sqrt(variance);
    
    let realizedRegime = 'NORMAL-VOL';
    if (morningVol >= baseline.pct80) realizedRegime = 'HIGH-VOL';
    if (morningVol <= baseline.pct20) realizedRegime = 'LOW-VOL';
    
    totalValid++;
    if (realizedRegime === labelsGarch[date]) {
      agreeCount++;
    }
  }
  
  console.log("Agreement rate between GARCH and Realized Vol (60-min):");
  if (totalValid > 0) {
    console.log("  " + agreeCount + "/" + totalValid + " (" + (agreeCount/totalValid*100).toFixed(1) + "%)");
  } else {
    console.log("  No valid dates for comparison.");
  }

  const overlap = Object.keys(labelsGarch).filter(d => tradesByDate[d]);
  console.log("Number of dates in labelsGarch: " + Object.keys(labelsGarch).length);
  console.log("Number of dates in tradesByDate: " + Object.keys(tradesByDate).length);
  console.log("Number of overlapping dates: " + overlap.length);
  
  console.log("GARCH Forecast Regime EV Separation (pre-open):");
  for (const [k, v] of Object.entries(buckets)) {
    if (v.n >= 10) {
      console.log("  " + k.padEnd(12) + ": N=" + v.n + ", EV/trade=$" + (v.pnl/v.n).toFixed(2));
    } else {
      console.log("  " + k.padEnd(12) + ": N=" + v.n + " (Too thin)");
    }
  }
  
  console.log("\\nDone. Saved to scripts/test_garch_regime.js");
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
