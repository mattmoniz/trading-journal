import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { recordClaim } from './record_claim.mjs';
import fs from 'fs';

const BAR_MIN = 60;

async function main() {
  const DOLLARS_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
  const COMMISSION_RT = LIVE_INSTRUMENT.commissionPerRoundTrip;

  console.log(`Fetching 1-min bars for NQ (>= 2023-12-16)...`);
  const sql = `
    SELECT
      ts,
      to_char(ts, 'YYYY-MM-DD HH24:MI:SS') as ts_str,
      open::float, high::float, low::float, close::float, volume,
      EXTRACT(hour FROM ts AT TIME ZONE 'America/New_York')::int as et_hour,
      EXTRACT(minute FROM ts AT TIME ZONE 'America/New_York')::int as et_min_part,
      EXTRACT(hour FROM ts)::int as hour_part,
      EXTRACT(minute FROM ts)::int as minute_part,
      EXTRACT(dow FROM ts)::int as dow
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts >= '2023-12-16'
    ORDER BY ts ASC
  `;
  const { rows } = await query(sql);
  console.log(`Fetched ${rows.length} 1-min bars.`);

  // 60-min aggregation
  const buckets = new Map();
  for (const r of rows) {
    if (r.hour_part === 17) continue;
    const bucketMin = Math.floor(r.minute_part / BAR_MIN) * BAR_MIN;
    const bucketId = `${r.ts_str.substring(0, 10)} ${String(r.hour_part).padStart(2, '0')}:${String(bucketMin).padStart(2, '0')}:00`;

    if (!buckets.has(bucketId)) {
      buckets.set(bucketId, {
        ts: bucketId,
        open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
        dayOfWeek: r.dow,
        endTsStr: r.ts_str
      });
    } else {
      const b = buckets.get(bucketId);
      b.high = Math.max(b.high, r.high);
      b.low = Math.min(b.low, r.low);
      b.close = r.close;
      b.volume += r.volume;
      b.endTsStr = r.ts_str;
    }
  }

  const mBars = Array.from(buckets.values()).sort((a, b) => a.ts.localeCompare(b.ts));
  console.log(`Aggregated to ${mBars.length} 60-min bars.`);

  for (let i = 0; i < mBars.length; i++) {
    const bar = mBars[i];
    if (i === 0) bar.tr = bar.high - bar.low;
    else bar.tr = Math.max(bar.high - bar.low, Math.abs(bar.high - mBars[i-1].close), Math.abs(bar.low - mBars[i-1].close));
  }

  function addWilderATR(bars, period, field) {
    let sumTR = 0;
    for (let i = 0; i < bars.length; i++) {
      if (i < period) {
        sumTR += bars[i].tr;
        if (i === period - 1) bars[i][field] = sumTR / period;
      } else {
        bars[i][field] = (bars[i - 1][field] * (period - 1) + bars[i].tr) / period;
      }
    }
  }
  addWilderATR(mBars, 20, 'atr20');
  addWilderATR(mBars, 30, 'atr30');

  for (let i = 0; i < mBars.length; i++) {
    mBars[i].isFridayExit = false;
    if (mBars[i].dayOfWeek === 5) {
      if (!mBars[i+1] || mBars[i+1].dayOfWeek !== 5) mBars[i].isFridayExit = true;
    }
  }

  for (let i = 0; i < rows.length; i++) {
    rows[i].et_min = rows[i].et_hour * 60 + rows[i].et_min_part;
    if (i === 0) {
      rows[i].gap = 0;
      rows[i].logRet = 0;
    } else {
      rows[i].gap = (new Date(rows[i].ts).getTime() - new Date(rows[i-1].ts).getTime()) / 60000;
      rows[i].logRet = Math.log(rows[i].close / rows[i-1].close);
    }
  }

  function computeBadges(idx) {
    let bigMove = { active: false, rangeSoFar: null };
    let sigma = { active: false, sigmaVal: null };
    
    if (idx < 0) return { bigMove, sigma };
    
    let sessionHigh = -Infinity;
    let sessionLow = Infinity;
    for (let j = idx; j >= 0; j--) {
      sessionHigh = Math.max(sessionHigh, rows[j].high);
      sessionLow = Math.min(sessionLow, rows[j].low);
      if (rows[j].gap > 45) break;
    }
    const rangeSoFar = sessionHigh - sessionLow;
    const nowEtMin = rows[idx].et_min;
    const minutesRemaining = nowEtMin < 1020 ? (1020 - nowEtMin) : (1440 - nowEtMin + 1020);
    bigMove.rangeSoFar = rangeSoFar;
    bigMove.active = (rangeSoFar >= 250 && minutesRemaining >= 180);

    const SIG_WIN = 100, H = 60, GAP_CUTOFF = 45;
    if (idx >= SIG_WIN + H) {
      let lookbackHasGap = false;
      for (let j = idx - H + 1; j <= idx; j++) {
        if (rows[j].gap > GAP_CUTOFF) { lookbackHasGap = true; break; }
      }
      
      let volWindow = [];
      let sumLogRet = 0, sumSqLogRet = 0;
      let validVol = true;
      for (let j = idx - H - SIG_WIN + 1; j <= idx - H; j++) {
        if (rows[j].gap > GAP_CUTOFF) { validVol = false; break; }
        const lr = rows[j].logRet;
        volWindow.push(lr);
        sumLogRet += lr;
        sumSqLogRet += lr * lr;
      }
      
      if (validVol && volWindow.length === SIG_WIN && !lookbackHasGap) {
        const mean = sumLogRet / SIG_WIN;
        const variance = Math.max(0, sumSqLogRet / SIG_WIN - mean * mean);
        const stdDevLogRet = Math.sqrt(variance);
        if (stdDevLogRet > 0) {
          const moveInPoints = rows[idx].close - rows[idx - H].close;
          const expectedMove = rows[idx].close * stdDevLogRet * Math.sqrt(H);
          if (moveInPoints < 0) {
            const downMagnitude = Math.abs(moveInPoints) / expectedMove;
            sigma.sigmaVal = downMagnitude;
            sigma.active = downMagnitude >= 1.0;
          }
        }
      }
    }
    
    return { bigMove, sigma };
  }

  const endTsToIndex = new Map();
  for (let i = 0; i < rows.length; i++) {
    endTsToIndex.set(rows[i].ts_str, i);
  }

  let trades = [];
  let position = null;
  let entryBarIdx = null;
  
  for (let i = 30; i < mBars.length - 1; i++) {
    const prevBar = mBars[i - 1];
    const bar = mBars[i];

    if (position) {
      let stopHit = false, exitPrice = null;
      if (bar.low <= position.stop) { stopHit = true; exitPrice = Math.min(bar.open, position.stop); }

      if (stopHit) {
        const pts = exitPrice - position.entryPrice;
        const pnl = (pts * DOLLARS_PER_POINT) - COMMISSION_RT;
        trades.push({ ...position, exitTime: bar.ts, pnl, pts, reason: 'STOP', date: bar.ts.substring(0, 10) });
        position = null;
      } else if (bar.isFridayExit) {
        exitPrice = bar.close;
        const pts = exitPrice - position.entryPrice;
        const pnl = (pts * DOLLARS_PER_POINT) - COMMISSION_RT;
        trades.push({ ...position, exitTime: bar.ts, pnl, pts, reason: 'FRIDAY_CLOSE', date: bar.ts.substring(0, 10) });
        position = null;
      }
      continue;
    }

    if (prevBar.atr20 < prevBar.atr30) {
      const buyLevel = prevBar.open + (2 * prevBar.atr20);
      if (bar.high >= buyLevel) {
        const entryPrice = Math.max(bar.open, buyLevel);
        const stop = entryPrice - (0.5 * prevBar.atr20);
        
        const prev1mIdx = endTsToIndex.get(prevBar.endTsStr);
        const { bigMove, sigma } = computeBadges(prev1mIdx);
        const compRatio = prevBar.atr20 / prevBar.atr30;
        
        position = { 
          side: 'LONG', entryPrice, stop, entryTime: bar.ts,
          bigMoveActive: bigMove.active, bigMoveRange: bigMove.rangeSoFar,
          sigmaActive: sigma.active, sigmaVal: sigma.sigmaVal,
          compRatio
        };
        
        if (bar.isFridayExit) {
          const exitPrice = bar.close;
          const pts = exitPrice - entryPrice;
          const pnl = (pts * DOLLARS_PER_POINT) - COMMISSION_RT;
          trades.push({ ...position, exitTime: bar.ts, pnl, pts, reason: 'FRIDAY_CLOSE_SAME_BAR', date: bar.ts.substring(0, 10) });
          position = null;
        }
      }
    }
  }

  trades.sort((a, b) => a.compRatio - b.compRatio);
  const qSize = Math.ceil(trades.length / 4);
  for (let i = 0; i < trades.length; i++) {
    trades[i].quartile = Math.floor(i / qSize) + 1;
  }

  let out = `# ATR Breakout Badge Confluence (Thread 1)
Total Trades: ${trades.length}
Overall EV: +$${(trades.reduce((s,t)=>s+t.pnl,0)/trades.length).toFixed(2)}

## 1. BIGMOVE Badge (active on ${trades.filter(t=>t.bigMoveActive).length} trades)
`;
  
  function analyze(badgeFn) {
    const active = trades.filter(badgeFn);
    const inactive = trades.filter(t => !badgeFn(t));
    const activeEv = active.length ? active.reduce((s,t)=>s+t.pnl,0)/active.length : 0;
    const inactiveEv = inactive.length ? inactive.reduce((s,t)=>s+t.pnl,0)/inactive.length : 0;
    
    let res = `- **Overall**: Active N=${active.length} (EV=+$${activeEv.toFixed(2)}), Inactive N=${inactive.length} (EV=+$${inactiveEv.toFixed(2)})\n`;
    for(let q=1; q<=4; q++) {
      const qTrades = trades.filter(t => t.quartile === q);
      const qAct = qTrades.filter(badgeFn);
      const qInact = qTrades.filter(t => !badgeFn(t));
      const qActEv = qAct.length ? qAct.reduce((s,t)=>s+t.pnl,0)/qAct.length : 0;
      const qInactEv = qInact.length ? qInact.reduce((s,t)=>s+t.pnl,0)/qInact.length : 0;
      res += `  - Quartile ${q}: Active N=${qAct.length} (EV=+$${qActEv.toFixed(2)}), Inactive N=${qInact.length} (EV=+$${qInactEv.toFixed(2)})\n`;
    }
    return res;
  }
  out += analyze(t => t.bigMoveActive);
  
  out += `\n## 2. SIGMA_CONTINUATION Badge (active on ${trades.filter(t=>t.sigmaActive).length} trades)\n`;
  out += analyze(t => t.sigmaActive);
  out += `\n*NOTE: SIGMA fires on DOWN moves. Long entry + down-sigma is anti-correlated.*\n`;

  function pearson(arrX, arrY) {
    if(!arrX.length) return 0;
    const n = arrX.length;
    const sumX = arrX.reduce((s,x)=>s+x,0);
    const sumY = arrY.reduce((s,y)=>s+y,0);
    const meanX = sumX/n, meanY = sumY/n;
    let num=0, denX=0, denY=0;
    for(let i=0; i<n; i++) {
      num += (arrX[i]-meanX)*(arrY[i]-meanY);
      denX += Math.pow(arrX[i]-meanX, 2);
      denY += Math.pow(arrY[i]-meanY, 2);
    }
    if (denX===0 || denY===0) return 0;
    return num / Math.sqrt(denX*denY);
  }
  
  const bmValid = trades.filter(t => t.bigMoveRange !== null);
  const bmCorr = pearson(bmValid.map(t=>t.bigMoveRange), bmValid.map(t=>t.pnl));
  out += `\n## 3. Continuous Correlation\n`;
  out += `- BIGMOVE (rangeSoFar vs PnL, N=${bmValid.length}): r = ${bmCorr.toFixed(3)}\n`;
  
  const sigValid = trades.filter(t => t.sigmaVal !== null);
  const sigCorr = pearson(sigValid.map(t=>t.sigmaVal), sigValid.map(t=>t.pnl));
  out += `- SIGMA (sigmaVal vs PnL, N=${sigValid.length}): r = ${sigCorr.toFixed(3)}\n`;

  function placebo(badgeFn) {
    const realDiff = (trades.filter(badgeFn).reduce((s,t)=>s+t.pnl,0)/trades.filter(badgeFn).length) - 
                     (trades.filter(t=>!badgeFn(t)).reduce((s,t)=>s+t.pnl,0)/trades.filter(t=>!badgeFn(t)).length);
    const nActive = trades.filter(badgeFn).length;
    let nullDiffs = [];
    for(let i=0; i<1000; i++) {
      let shuffled = [...trades].sort(() => 0.5 - Math.random());
      let pAct = shuffled.slice(0, nActive);
      let pInact = shuffled.slice(nActive);
      let pActEv = pAct.reduce((s,t)=>s+t.pnl,0)/pAct.length;
      let pInactEv = pInact.reduce((s,t)=>s+t.pnl,0)/pInact.length;
      nullDiffs.push(pActEv - pInactEv);
    }
    nullDiffs.sort((a,b)=>a-b);
    let rank = nullDiffs.findIndex(d => d >= realDiff);
    if(rank === -1) rank = 1000;
    return { realDiff, pct: (rank/10).toFixed(1) };
  }
  
  if (trades.filter(t=>t.bigMoveActive).length > 0) {
    const bmp = placebo(t=>t.bigMoveActive);
    out += `\n## 4. Placebo Test (1000 permutations)\n`;
    out += `- BIGMOVE: Real EV diff = $${bmp.realDiff.toFixed(2)}. This is at the ${bmp.pct}th percentile of the null distribution.\n`;
  }
  if (trades.filter(t=>t.sigmaActive).length > 0) {
    const ssp = placebo(t=>t.sigmaActive);
    out += `- SIGMA: Real EV diff = $${ssp.realDiff.toFixed(2)}. This is at the ${ssp.pct}th percentile of the null distribution.\n`;
  }

  fs.writeFileSync('scratch/atr_breakout_badge_confluence_RESULTS.md', out);
  console.log('Results written to scratch/atr_breakout_badge_confluence_RESULTS.md');

  await recordClaim({
    slug: 'atr_breakout_confluence',
    claimText: `BIGMOVE confluence placebo pct: ${trades.filter(t=>t.bigMoveActive).length ? placebo(t=>t.bigMoveActive).pct : 'N/A'}. SIGMA placebo pct: ${trades.filter(t=>t.sigmaActive).length ? placebo(t=>t.sigmaActive).pct : 'N/A'}.`,
    sourceFile: 'scripts/pilot_atr_breakout_badge_confluence.mjs',
    sampleSize: trades.length,
    winRate: trades.filter(t=>t.pnl>0).length/trades.length,
    evPerTrade: trades.reduce((s,t)=>s+t.pnl,0)/trades.length,
    rigorStatus: 'PROVISIONAL'
  });
  process.exit(0);
}
main().catch(err => { console.error(err); process.exit(1); });
