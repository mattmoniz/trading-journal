import { query } from '../server/db.js';
import { classifyACDOpeningCall } from '../server/services/openingCallClassifier.js';
import { loadData, resolve } from './backtest_unified.js';

const WIN = { orEndMin: 585, confirmEndMin: 615 };
const IMMEDIATE_STOP = 159, IMMEDIATE_TARGET = 80;

function pnl(entry, exitPrice, long) {
  return (long ? (exitPrice - entry) : (entry - exitPrice)) * 2 - 2;
}
function walkPnl(bars, entryIdx, direction, entry, stop, target) {
  const res = resolve(bars, entryIdx, direction, entry, stop, target, 240);
  if (res.result !== 'EXPIRED') return res.pnl;
  const cutoff = bars[Math.min(bars.length - 1, entryIdx + 240)];
  return pnl(entry, cutoff.close, direction === 'LONG');
}

function computeAUC(labels, scores) {
  let concordant = 0, discordant = 0;
  for (let i = 0; i < labels.length; i++) {
    for (let j = 0; j < labels.length; j++) {
      if (labels[i] === 1 && labels[j] === 0) {
        if (scores[i] > scores[j]) concordant++;
        else if (scores[i] < scores[j]) discordant++;
        else concordant += 0.5;
      }
    }
  }
  const total = labels.filter(l => l === 1).length * labels.filter(l => l === 0).length;
  return total > 0 ? concordant / total : 0;
}

function stats(arr) {
  if (!arr.length) return { mean: null, median: null };
  const nums = arr.map(Number);
  const sorted = [...nums].sort((a,b) => a-b);
  const sum = nums.reduce((a,b) => a+b, 0);
  return {
    mean: sum / arr.length,
    median: sorted[Math.floor(sorted.length / 2)]
  };
}

async function main() {
  const { barsByDate, acdByDate, dvlByDate, dates } = await loadData();

  const extraRes = await query(`
    WITH session_stats AS (
      SELECT ts::date::text as d,
             MAX(high) - MIN(low) as rth_range
      FROM price_bars_primary
      WHERE symbol = 'NQ' AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
      GROUP BY ts::date
    ),
    overnight_stats AS (
      SELECT (ts - INTERVAL '9 hours')::date::text as d_trade_date,
             MAX(high) - MIN(low) as on_range
      FROM price_bars_primary
      WHERE symbol = 'NQ' AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) < 570 OR EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) >= 960)
      GROUP BY (ts - INTERVAL '9 hours')::date
    )
    SELECT s.d, s.rth_range,
           LAG(s.rth_range) OVER (ORDER BY s.d) as prior_rth_range,
           AVG(s.rth_range) OVER (ORDER BY s.d ROWS BETWEEN 10 PRECEDING AND 1 PRECEDING) as rolling_vol_10,
           o.on_range
    FROM session_stats s
    LEFT JOIN overnight_stats o ON o.d_trade_date = (s.d::date - 1)::text
    ORDER BY s.d;
  `);
  // FIXED 2026-08-31 (independent audit after this script's original dispatch): the join
  // above used to be `o.d_trade_date = s.d`, which -- per overnight_stats' own date-shift
  // convention (a bar before 9am rolls back to the PRIOR calendar day) -- paired each RTH
  // session with the overnight range that comes AFTER it (that same evening through the
  // next morning), not the one preceding it. A real lookahead bug, verified by tracing
  // exact timestamp-to-date-bucket mappings via raw SQL. Corrected AUC dropped from 0.803
  // to 0.697 (still real, just weaker than the buggy version showed).

  const extraByDate = new Map();
  for (const r of extraRes.rows) {
    extraByDate.set(r.d, r);
  }

  const orRangeHistory = [];
  const records = [];

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    let bars = barsByDate.get(date);
    const acd = acdByDate.get(date);
    // FIXED 2026-08-31 (independent audit): was `dvlByDate.get(date)` -- today's OWN row,
    // whose session_close doesn't exist yet at market open. This codebase's own
    // backtest_unified.js explicitly uses the prevDate-shifted convention elsewhere
    // (~line 984) for exactly this reason. Corrected AUC dropped from 0.769 to 0.534 --
    // essentially erased; this candidate carries no real signal once fixed.
    const dvl = i > 0 ? dvlByDate.get(dates[i - 1]) : null;
    const ext = extraByDate.get(date);

    if (!bars || !acd || !ext) continue;
    bars = bars.map(b => ({ ...b, mod: Number(b.tod) }));

    const orBars = bars.filter(b => b.tod >= 570 && b.tod < WIN.orEndMin);
    const confirmBars = bars.filter(b => b.tod >= 570 && b.tod < WIN.confirmEndMin);
    if (orBars.length < 3 || confirmBars.length < 5) continue;
    
    const orH = Math.max(...orBars.map(b => b.high));
    const orL = Math.min(...orBars.map(b => b.low));
    const orRange = orH - orL || 1;
    
    const orRecent = orRangeHistory.slice(-20).sort((a,b)=>a-b);
    let orPercentile = 0;
    if (orRecent.length >= 5) {
      orPercentile = orRecent.filter(r => r < orRange).length / orRecent.length;
    }
    orRangeHistory.push(orRange);

    const call = classifyACDOpeningCall(confirmBars, orH, orL);
    if (!call || call.type !== 'OPEN_DRIVE') continue;
    const isLong = call.driveDirection === 'UP';
    const direction = isLong ? 'LONG' : 'SHORT';

    const confirmEndIdx = bars.findIndex(b => b.tod >= WIN.confirmEndMin);
    if (confirmEndIdx === -1) continue;
    const confirmCloseBar = bars[confirmEndIdx];

    const driveMag = isLong
      ? (confirmCloseBar.close - orH) / orRange
      : (orL - confirmCloseBar.close) / orRange;

    if (driveMag < 0.479) continue;

    const sessionRange = ext.rth_range;
    const bigDay = sessionRange >= 600 ? 1 : 0;

    let gapSize = 0;
    if (dvl && dvl.session_close) {
        gapSize = Math.abs(bars[0].open - dvl.session_close);
    }

    const stopPrice = isLong ? confirmCloseBar.close - IMMEDIATE_STOP : confirmCloseBar.close + IMMEDIATE_STOP;
    const targetPrice = isLong ? confirmCloseBar.close + IMMEDIATE_TARGET : confirmCloseBar.close - IMMEDIATE_TARGET;
    
    const res = resolve(bars, confirmEndIdx, direction, confirmCloseBar.close, stopPrice, targetPrice, 240);
    let realPnl = 0;
    if (res.result !== 'EXPIRED') {
        realPnl = res.pnl;
    } else {
        const cutoff = bars[Math.min(bars.length - 1, confirmEndIdx + 240)];
        realPnl = pnl(confirmCloseBar.close, cutoff.close, direction === 'LONG');
    }
    
    records.push({
      date, bigDay, sessionRange,
      onRange: Number(ext.on_range) || 0,
      orRangeRaw: orRange,
      orPercentile,
      priorRthRange: Number(ext.prior_rth_range) || 0,
      rollingVol10: Number(ext.rolling_vol_10) || 0,
      gapSize,
      pnl: realPnl,
      mfe: res.mfe
    });
  }

  const candidates = [
    { name: 'Overnight Range', key: 'onRange' },
    { name: 'OR Range (Raw)', key: 'orRangeRaw' },
    { name: 'OR Range (20d Pct)', key: 'orPercentile' },
    { name: 'Prior Day Range', key: 'priorRthRange' },
    { name: 'Rolling 10d Vol', key: 'rollingVol10' },
    { name: 'Gap Size', key: 'gapSize' },
  ];

  const labels = records.map(r => r.bigDay);
  const bigGrp = records.filter(r => r.bigDay === 1);
  const nmlGrp = records.filter(r => r.bigDay === 0);

  const results = candidates.map(c => {
    const scores = records.map(r => r[c.key]);
    const auc = computeAUC(labels, scores);
    const bigSt = stats(bigGrp.map(r => r[c.key]));
    const nmlSt = stats(nmlGrp.map(r => r[c.key]));
    return {
        name: c.name,
        auc: auc.toFixed(3),
        bigMean: bigSt.mean.toFixed(2),
        bigMed: bigSt.median.toFixed(2),
        nmlMean: nmlSt.mean.toFixed(2),
        nmlMed: nmlSt.median.toFixed(2)
    };
  });

  console.table(results);

  let best = candidates[0];
  let bestAUC = 0;
  for(let c of candidates) {
      let auc = computeAUC(labels, records.map(r => r[c.key]));
      if(auc > bestAUC) { bestAUC = auc; best = c; }
  }

  console.log(`\nBest separator: ${best.name} (AUC ${bestAUC.toFixed(3)})`);
  const sorted = [...records].sort((a,b) => a[best.key] - b[best.key]);
  const splitIdx = Math.floor(sorted.length / 2);
  const topHalf = sorted.slice(splitIdx);
  const botHalf = sorted.slice(0, splitIdx);

  console.log(`Top Half (>= ${topHalf[0][best.key].toFixed(2)}): N=${topHalf.length}, Avg PnL=$${stats(topHalf.map(r=>r.pnl)).mean.toFixed(2)}, Avg MFE=${stats(topHalf.map(r=>r.mfe)).mean.toFixed(2)}pt, Big Days=${topHalf.filter(r=>r.bigDay).length}`);
  console.log(`Bot Half (< ${topHalf[0][best.key].toFixed(2)}): N=${botHalf.length}, Avg PnL=$${stats(botHalf.map(r=>r.pnl)).mean.toFixed(2)}, Avg MFE=${stats(botHalf.map(r=>r.mfe)).mean.toFixed(2)}pt, Big Days=${botHalf.filter(r=>r.bigDay).length}`);
  
  process.exit(0);
}

main().catch(console.error);
