import { Client } from 'pg';

const client = new Client({
  user: 'trader',
  host: 'localhost',
  database: 'trading_journal',
  password: 'trader123',
});

function variance(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b) / arr.length;
  return arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (arr.length - 1);
}

function linearRegression(x, y) {
  const n = x.length;
  let sum_x = 0, sum_y = 0, sum_xy = 0, sum_xx = 0;
  for (let i = 0; i < n; i++) {
    sum_x += x[i];
    sum_y += y[i];
    sum_xy += x[i] * y[i];
    sum_xx += x[i] * x[i];
  }
  const slope = (n * sum_xy - sum_x * sum_y) / (n * sum_xx - sum_x * sum_x);
  return slope;
}

async function main() {
  await client.connect();

  console.log("Fetching 1-min bars for 09:30 to 10:30...");
  
  const res = await client.query(`
    SELECT ts::date::text as d, ts, close
    FROM price_bars_primary
    WHERE symbol='NQ'
      AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) BETWEEN 570 AND 630
    ORDER BY ts
  `);
  
  const barsByDay = {};
  for (const r of res.rows) {
    if (!barsByDay[r.d]) barsByDay[r.d] = [];
    barsByDay[r.d].push(Number(r.close));
  }
  
  const days = [];
  const hurstByDay = {};
  
  for (const [d, prices] of Object.entries(barsByDay)) {
    if (prices.length < 50) continue;
    
    const logPrices = prices.map(p => Math.log(p));
    const k_values = [2, 4, 8, 16];
    const log_k = [];
    const log_var = [];
    
    let valid = true;
    for (const k of k_values) {
      const returns_k = [];
      for (let i = k; i < logPrices.length; i++) {
        returns_k.push(logPrices[i] - logPrices[i-k]);
      }
      const v = variance(returns_k);
      if (v <= 0 || isNaN(v)) {
        valid = false;
        break;
      }
      log_k.push(Math.log(k));
      log_var.push(Math.log(v));
    }
    
    if (valid) {
      const slope = linearRegression(log_k, log_var);
      const hurst = slope / 2;
      hurstByDay[d] = hurst;
      days.push(d);
    }
  }
  
  console.log("Calculated Hurst (Variance-Ratio) for " + days.length + " days.");
  
  const h_arr = Object.values(hurstByDay).sort((a,b) => a - b);
  const t1 = h_arr[Math.floor(h_arr.length / 3)];
  const t2 = h_arr[Math.floor(h_arr.length * 2 / 3)];
  
  const h_labels = {};
  for (const d of days) {
    const h = hurstByDay[d];
    if (h <= t1) h_labels[d] = 'MEAN_REV';
    else if (h >= t2) h_labels[d] = 'PERSISTENT';
    else h_labels[d] = 'NEUTRAL';
  }
  
  const dtRes = await client.query(`
    SELECT trade_date::text as d, day_type
    FROM acd_daily_log
    WHERE trade_date::text IN (${days.map(d => "'" + d + "'").join(',')})
  `);
  
  const dayTypes = {};
  for (const r of dtRes.rows) {
    dayTypes[r.d] = r.day_type;
  }
  
  const matrix = {};
  for (const d of days) {
    if (!dayTypes[d]) continue;
    const l = h_labels[d];
    const dt = dayTypes[d];
    if (!matrix[l]) matrix[l] = {};
    if (!matrix[l][dt]) matrix[l][dt] = 0;
    matrix[l][dt]++;
  }
  
  console.log("--- HURST VS REAL DAY TYPE ---");
  for (const l of ['MEAN_REV', 'NEUTRAL', 'PERSISTENT']) {
    let tot = 0;
    for (const dt in matrix[l]) tot += matrix[l][dt];
    console.log(l + " (N=" + tot + "):");
    for (const dt of ['TREND', 'TURBULENT', 'BALANCE']) {
      const c = matrix[l] && matrix[l][dt] ? matrix[l][dt] : 0;
      console.log("  " + dt.padEnd(16) + ": " + c.toString().padStart(3) + " (" + (tot>0 ? (c/tot*100).toFixed(1) : '0.0') + "%)");
    }
  }
  
  const fadeRes = await client.query(`
    SELECT trade_date::text as d, actual_pnl as move
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND actual_pnl IS NOT NULL
      AND setup_type LIKE '%FADE%'
      AND trade_date::text IN (${days.map(d => "'" + d + "'").join(',')})
  `);
  
  const fadeStats = {
    MEAN_REV: { n: 0, sum: 0 },
    NEUTRAL: { n: 0, sum: 0 },
    PERSISTENT: { n: 0, sum: 0 },
    ALL: { n: 0, sum: 0 }
  };
  
  for (const r of fadeRes.rows) {
    const l = h_labels[r.d];
    if (fadeStats[l]) {
      fadeStats[l].n++;
      fadeStats[l].sum += Number(r.move);
      fadeStats.ALL.n++;
      fadeStats.ALL.sum += Number(r.move);
    }
  }
  
  console.log("--- HURST VS FADE SETUP EV ---");
  for (const [k, v] of Object.entries(fadeStats)) {
    const mean = v.n > 0 ? (v.sum / v.n).toFixed(2) : '0.00';
    console.log(k.padEnd(10) + " | N=" + v.n.toString().padStart(4) + " | Mean Move=" + mean.padStart(6) + " pts ($" + (mean*2).toFixed(2) + ")");
  }

  await client.end();
}

main().catch(console.error);
