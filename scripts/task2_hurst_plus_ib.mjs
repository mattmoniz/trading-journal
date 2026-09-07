import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { getBetClass } from '../server/config/setupTypes.js';

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
  return (n * sum_xy - sum_x * sum_y) / (n * sum_xx - sum_x * sum_x);
}

async function run() {
  const barsRes = await query(`
    SELECT ts::date::text as trade_date,
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
      high, low, close
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 629
    ORDER BY ts ASC
  `);

  const barsByDate = {};
  for (const b of barsRes.rows) {
    if (!barsByDate[b.trade_date]) barsByDate[b.trade_date] = [];
    barsByDate[b.trade_date].push({ h: parseFloat(b.high), l: parseFloat(b.low), c: parseFloat(b.close) });
  }

  const dayStats = {};
  for (const d of Object.keys(barsByDate)) {
    const bars = barsByDate[d];
    if (bars.length < 50) continue;

    let runningHigh = bars[0].h, runningLow = bars[0].l;
    let lastEventDir = null;
    let switchCount = 0, upEvents = 0, downEvents = 0;

    for (let i = 1; i < bars.length; i++) {
      const b = bars[i];
      let newHigh = false, newLow = false;
      if (b.h > runningHigh) { runningHigh = b.h; newHigh = true; }
      if (b.l < runningLow) { runningLow = b.l; newLow = true; }

      if (newHigh && newLow) {
        upEvents++; downEvents++;
      } else if (newHigh) {
        if (lastEventDir === 'DOWN') switchCount++;
        lastEventDir = 'UP'; upEvents++;
      } else if (newLow) {
        if (lastEventDir === 'UP') switchCount++;
        lastEventDir = 'DOWN'; downEvents++;
      }
    }

    const totalEvents = upEvents + downEvents;
    const dirRatio = totalEvents > 0 ? Math.max(upEvents, downEvents) / totalEvents : 0.5;

    const logPrices = bars.map(b => Math.log(b.c));
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
      if (v <= 0 || isNaN(v)) { valid = false; break; }
      log_k.push(Math.log(k));
      log_var.push(Math.log(v));
    }
    
    let hurst = 0;
    if (valid) {
      const slope = linearRegression(log_k, log_var);
      hurst = slope / 2;
    }

    dayStats[d] = { switches: switchCount, dirRatio, range: runningHigh - runningLow, hurst, validHurst: valid };
  }

  const validDates = Object.keys(dayStats).sort();
  console.log(`Total days with valid IB-window coverage: ${validDates.length}`);

  const dayMetrics = {};
  for (let i = 0; i < validDates.length; i++) {
    const d = validDates[i];
    const stat = dayStats[d];
    const start = Math.max(0, i - 180);
    const window = validDates.slice(start, i).map(dt => dayStats[dt]);
    if (window.length === 0 || !stat.validHurst) continue;

    const pct = (arr, val) => arr.filter(x => x <= val).length / arr.length;
    dayMetrics[d] = {
      rangePct: pct(window.map(x => x.range), stat.range),
      switchPct: pct(window.map(x => x.switches), stat.switches),
      dirRatioPct: pct(window.map(x => x.dirRatio), stat.dirRatio),
      hurst: stat.hurst
    };
  }

  for (let i = 0; i < validDates.length; i++) {
    const d = validDates[i];
    if (!dayMetrics[d]) continue;
    const start = Math.max(0, i - 180);
    const window = validDates.slice(start, i).map(dt => dayStats[dt]).filter(x => x && x.validHurst);
    if (window.length < 20) {
      dayMetrics[d].hurstTercile = 'NEUTRAL';
      continue;
    }
    const hursts = window.map(x => x.hurst).sort((a,b) => a - b);
    const h = dayMetrics[d].hurst;
    if (h <= hursts[Math.floor(hursts.length / 3)]) dayMetrics[d].hurstTercile = 'MEAN_REV';
    else if (h >= hursts[Math.floor(hursts.length * 2 / 3)]) dayMetrics[d].hurstTercile = 'PERSISTENT';
    else dayMetrics[d].hurstTercile = 'NEUTRAL';
  }

  const { rows: setups } = await query(`
    SELECT trade_date::text as trade_date, setup_type, actual_pnl
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW') AND actual_pnl IS NOT NULL
  `);
  for (const s of setups) s.actual_pnl = parseFloat(s.actual_pnl);

  const getStats = (arr) => {
    if (arr.length === 0) return { n: 0, wr: 0, ev: 0 };
    const n = arr.length;
    const wins = arr.filter(x => x.actual_pnl > 0).length;
    const totalPnl = arr.reduce((s, x) => s + x.actual_pnl, 0);
    return { n, wr: +(wins / n * 100).toFixed(1), ev: +(totalPnl * LIVE_INSTRUMENT.dollarsPerPoint / n).toFixed(2) };
  };

  function testRoster(label, predicate) {
    const roster = setups.filter(predicate);
    console.log(`\n--- ${label}: real N=${roster.length} ---`);
    if (roster.length === 0) return;

    for (const h of ['MEAN_REV', 'NEUTRAL', 'PERSISTENT']) {
      const cleanLeg = [], churnLopsided = [], balancedBucket = [];
      for (const s of roster) {
        const dm = dayMetrics[s.trade_date];
        if (!dm || dm.rangePct < 0.666 || dm.hurstTercile !== h) continue;

        const lowSwitch = dm.switchPct <= 0.333, lopsided = dm.dirRatioPct >= 0.666;
        if (lowSwitch && lopsided) cleanLeg.push(s);
        else if (!lowSwitch && lopsided) churnLopsided.push(s);
        else balancedBucket.push(s);
      }
      const cl = getStats(cleanLeg), ch = getStats(churnLopsided), bl = getStats(balancedBucket);
      console.log(`[ Hurst: ${h} ]`);
      console.log(`  Clean Leg    : N=${cl.n.toString().padStart(3)}, EV=$${cl.ev.toString().padStart(6)} (${(cl.ev/2).toFixed(2)} pts)`);
      console.log(`  Churn/Grind  : N=${ch.n.toString().padStart(3)}, EV=$${ch.ev.toString().padStart(6)} (${(ch.ev/2).toFixed(2)} pts)`);
      console.log(`  Balanced/Rev : N=${bl.n.toString().padStart(3)}, EV=$${bl.ev.toString().padStart(6)} (${(bl.ev/2).toFixed(2)} pts)`);
    }
  }

  testRoster('VALUE_FADE (baseline)', s => getBetClass(s.setup_type) === 'VALUE_FADE');
  
  process.exit(0);
}

run().catch(console.error);
