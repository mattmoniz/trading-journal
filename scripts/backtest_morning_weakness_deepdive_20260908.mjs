import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { computeReplication, computeRigor } from '../server/services/rigorDiagnostics.js';
import fs from 'fs';

function isRTH(ts_ms) {
  const date = new Date(ts_ms);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
  const hour = h === 24 ? 0 : h;
  const mins = hour * 60 + m;
  return mins >= 570 && mins < 960;
}

function getMins(ts_ms) {
  const date = new Date(ts_ms);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
  const hour = h === 24 ? 0 : h;
  return hour * 60 + m;
}

function getRTHBucket(mins) {
  if (mins >= 570 && mins < 600) return '9:30-10:00';
  if (mins >= 600 && mins < 630) return '10:00-10:30';
  if (mins >= 630 && mins < 660) return '10:30-11:00';
  if (mins >= 660 && mins < 720) return '11:00-12:00';
  if (mins >= 720 && mins < 840) return '12:00-2:00';
  if (mins >= 840 && mins < 960) return '2:00-4:00';
  return null;
}

async function main() {
  const tradesRes = await query(`
    SELECT setup_type, trade_date::text as trade_date,
      extract(epoch from fired_at)*1000 as fired_at_ms,
      extract(epoch from resolved_at)*1000 as resolved_at_ms,
      actual_pnl::float as actual_pnl
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND (is_cluster_primary IS NULL OR is_cluster_primary = true)
      AND actual_pnl IS NOT NULL
      AND resolved_at IS NOT NULL
      AND fired_at IS NOT NULL
    ORDER BY fired_at
  `);
  
  const allTrades = tradesRes.rows
    .map(t => ({ 
      ...t, 
      direction: inferDirection(t.setup_type),
      fired_at_ms: parseFloat(t.fired_at_ms),
      resolved_at_ms: parseFloat(t.resolved_at_ms)
    }))
    .filter(t => t.direction !== null);

  let outputMd = "# Morning Weakness Deep Dive Results\n\n";

  // ---------------------------------------------------------
  // WORKSTREAM A
  // ---------------------------------------------------------
  outputMd += "## Workstream A: Morning Weakness & Dig Out Shape\n\n";
  const rthTrades = allTrades.filter(t => isRTH(t.fired_at_ms));
  const globexTrades = allTrades.filter(t => !isRTH(t.fired_at_ms));

  // A1. Bucket by RTH time-of-day
  const buckets = ['9:30-10:00', '10:00-10:30', '10:30-11:00', '11:00-12:00', '12:00-2:00', '2:00-4:00'];
  const bucketStats = {};
  for (const b of buckets) {
    bucketStats[b] = { N: 0, win: 0, pnl: 0, longN: 0, longWin: 0, longPnl: 0, shortN: 0, shortWin: 0, shortPnl: 0 };
  }
  for (const t of rthTrades) {
    const mins = getMins(t.fired_at_ms);
    const b = getRTHBucket(mins);
    if (b) {
      const s = bucketStats[b];
      s.N++;
      s.pnl += t.actual_pnl;
      if (t.actual_pnl > 0) s.win++;
      if (t.direction === 'LONG') {
        s.longN++; s.longPnl += t.actual_pnl; if (t.actual_pnl > 0) s.longWin++;
      } else {
        s.shortN++; s.shortPnl += t.actual_pnl; if (t.actual_pnl > 0) s.shortWin++;
      }
    }
  }

  outputMd += "### A1. RTH Time-of-Day Buckets\n";
  outputMd += "| Bucket | N | WR | EV | Long N | Long WR | Long EV | Short N | Short WR | Short EV | Long vs Short EV Gap |\n";
  outputMd += "|---|---|---|---|---|---|---|---|---|---|---|\n";
  for (const b of buckets) {
    const s = bucketStats[b];
    const ev = s.N > 0 ? (s.pnl/s.N).toFixed(2) : 0;
    const wr = s.N > 0 ? (s.win/s.N*100).toFixed(1) : 0;
    const lev = s.longN > 0 ? (s.longPnl/s.longN).toFixed(2) : 0;
    const lwr = s.longN > 0 ? (s.longWin/s.longN*100).toFixed(1) : 0;
    const sev = s.shortN > 0 ? (s.shortPnl/s.shortN).toFixed(2) : 0;
    const swr = s.shortN > 0 ? (s.shortWin/s.shortN*100).toFixed(1) : 0;
    const gap = (s.longN > 0 && s.shortN > 0) ? (lev - sev).toFixed(2) : '-';
    outputMd += `| ${b} | ${s.N} | ${wr}% | $${ev} | ${s.longN} | ${lwr}% | $${lev} | ${s.shortN} | ${swr}% | $${sev} | $${gap} |\n`;
  }
  outputMd += "\n";

  // A2. Digs out shape (cumulative PnL by sequence number)
  function computeShape(trades) {
    const dayTrades = {};
    for (const t of trades) {
      if (!dayTrades[t.trade_date]) dayTrades[t.trade_date] = [];
      dayTrades[t.trade_date].push(t);
    }
    // They are already sorted by fired_at because of ORDER BY fired_at
    const seqSums = {};
    const seqCounts = {};
    for (const date in dayTrades) {
      let cum = 0;
      dayTrades[date].forEach((t, i) => {
        cum += t.actual_pnl;
        const seq = i + 1;
        if (!seqSums[seq]) { seqSums[seq] = 0; seqCounts[seq] = 0; }
        seqSums[seq] += cum;
        seqCounts[seq]++;
      });
    }
    const maxSeq = Math.max(...Object.keys(seqCounts).map(Number));
    const res = [];
    for (let i = 1; i <= maxSeq; i++) {
      if (seqCounts[i] >= 20) {
        res.push({ seq: i, avgCumPnl: seqSums[i] / seqCounts[i], N: seqCounts[i] });
      }
    }
    return res;
  }

  const rthShape = computeShape(rthTrades);
  const globexShape = computeShape(globexTrades);

  outputMd += "### A2. Cumulative P&L by Trade Sequence (RTH)\n";
  outputMd += "| Trade Seq | Avg Cum P&L | N Days |\n";
  outputMd += "|---|---|---|\n";
  for (const s of rthShape) {
    outputMd += `| ${s.seq} | $${s.avgCumPnl.toFixed(2)} | ${s.N} |\n`;
  }
  outputMd += "\n### A3. Cumulative P&L by Trade Sequence (Globex)\n";
  outputMd += "| Trade Seq | Avg Cum P&L | N Days |\n";
  outputMd += "|---|---|---|\n";
  for (const s of globexShape) {
    outputMd += `| ${s.seq} | $${s.avgCumPnl.toFixed(2)} | ${s.N} |\n`;
  }
  outputMd += "\n";


  // ---------------------------------------------------------
  // WORKSTREAM B
  // ---------------------------------------------------------
  outputMd += "## Workstream B: Loss-Streak Lockout Stress Test\n\n";
  
  const sessions = [
    { name: 'RTH', trades: rthTrades },
    { name: 'Globex', trades: globexTrades }
  ];
  
  const Ks = [1, 2, 3, 4];
  const bResults = [];
  let globexK1Suppressed = [];
  
  for (const session of sessions) {
    for (const K of Ks) {
      let longLossStreak = 0;
      let shortLossStreak = 0;
      let longBlocked = false;
      let shortBlocked = false;
      
      let gatedPnl = 0;
      let delta = 0;
      const suppressedTrades = [];
      
      // FIX (2026-09-08, caught via disagreement against the validated first script): each
      // trade gets its OWN object (via a real per-trade index, not `fired_at_ms`) shared
      // between its FIRE and RESOLVE events. The prior version keyed a Map by `fired_at_ms`
      // and spread a COPY per event -- 466/3696 real trades (12.6%) share an exact fired_at
      // with at least one other trade (confluence clusters firing up to 8 at once), so the
      // Map silently let a later trade's FIRE overwrite an earlier trade's suppression-state
      // entry under the same timestamp key, corrupting which trade's RESOLVE read which
      // state. Confirmed real: re-running with this fix changes RTH_K1 total delta from
      // $3615.22 back down to the original script's $2061.72-in-the-same-ballpark region.
      const events = [];
      session.trades.forEach((trade, idx) => {
        const tagged = { ...trade, _idx: idx };
        events.push({ time: trade.fired_at_ms, type: 'FIRE', trade: tagged });
        events.push({ time: trade.resolved_at_ms, type: 'RESOLVE', trade: tagged });
      });

      events.sort((a, b) => {
        if (a.time !== b.time) return a.time - b.time;
        if (a.type !== b.type) return a.type === 'RESOLVE' ? -1 : 1;
        return 0;
      });

      const tradeStates = new Map();

      for (const event of events) {
        const isLong = event.trade.direction === 'LONG';

        if (event.type === 'FIRE') {
          const isSuppressed = isLong ? longBlocked : shortBlocked;
          tradeStates.set(event.trade._idx, isSuppressed);
          if (isSuppressed) suppressedTrades.push(event.trade);
        } else if (event.type === 'RESOLVE') {
          const pnl = event.trade.actual_pnl;
          const wasSuppressed = tradeStates.get(event.trade._idx);
          
          const gatedThisTrade = wasSuppressed ? 0 : pnl;
          gatedPnl += gatedThisTrade;
          delta += (gatedThisTrade - pnl);
          
          const isLoss = pnl < 0;
          const isWin = pnl > 0;
          
          if (isLong) {
            if (isLoss) {
              longLossStreak++;
              if (longLossStreak >= K) longBlocked = true;
              if (shortBlocked) { shortBlocked = false; shortLossStreak = 0; }
            } else if (isWin) { longLossStreak = 0; }
          } else {
            if (isLoss) {
              shortLossStreak++;
              if (shortLossStreak >= K) shortBlocked = true;
              if (longBlocked) { longBlocked = false; longLossStreak = 0; }
            } else if (isWin) { shortLossStreak = 0; }
          }
        }
      }
      
      bResults.push({
        id: `${session.name}_K${K}`,
        session: session.name,
        K,
        delta,
        nTrades: session.trades.length
      });
      
      if (session.name === 'Globex' && K === 1) {
        globexK1Suppressed = suppressedTrades;
      }
    }
  }

  // B1. Replication Check
  // We have 8 configurations. Pooling Globex K=1 against the other 7.
  const units = bResults;
  const repCheck = computeReplication(units, {
    idFn: u => u.id,
    metricFn: u => ({ n: u.nTrades, value: u.delta / u.nTrades }), // value is delta per trade
    selectedIds: ['Globex_K1']
  });

  outputMd += "### B1. Replication Check (Globex K=1 against all other configurations)\n";
  outputMd += `- Selected (Globex K=1) EV Delta per trade: $${repCheck.selectedPooled.value}\n`;
  outputMd += `- Held-out (All others pooled) EV Delta per trade: $${repCheck.heldOutPooled.value}\n`;
  outputMd += `- Held-out favorable fraction: ${(repCheck.heldOutFavorableFrac * 100).toFixed(1)}% (${repCheck.heldOutFavorableCount}/${repCheck.heldOutN} configs point same direction)\n`;
  outputMd += `- **Replicates?**: ${repCheck.replicates ? 'Yes' : 'No'}\n\n`;

  outputMd += "### Full Config Sweep\n";
  outputMd += "| Config | Total Delta | Delta per Trade |\n";
  outputMd += "|---|---|---|\n";
  for (const r of bResults) {
    outputMd += `| ${r.id} | $${r.delta.toFixed(2)} | $${(r.delta / r.nTrades).toFixed(2)} |\n`;
  }
  outputMd += "\n";

  // B2. Setup Type Breakdown for Globex K=1
  const recsRes = await query(`
    SELECT DISTINCT ON (signal_name) signal_name, recommendation
    FROM performance_audit
    WHERE signal_type = 'SETUP_STATUS'
    ORDER BY signal_name, created_at DESC
  `);
  const recMap = {};
  for (const r of recsRes.rows) recMap[r.signal_name] = r.recommendation;

  let totSuppressedN = 0;
  let totSuppressedLoss = 0;
  let alreadySuppressedN = 0;
  let alreadySuppressedLoss = 0;
  let activeSuppressedN = 0;
  let activeSuppressedLoss = 0;

  for (const t of globexK1Suppressed) {
    totSuppressedN++;
    const pnl = t.actual_pnl;
    totSuppressedLoss += pnl;
    const rec = recMap[t.setup_type] || 'ACTIVE'; // assume active if not in audit
    if (rec === 'SUPPRESS' || rec === 'THIN_N') {
      alreadySuppressedN++;
      alreadySuppressedLoss += pnl;
    } else {
      activeSuppressedN++;
      activeSuppressedLoss += pnl;
    }
  }

  outputMd += "### B2. Setup Type Breakdown of Suppressed Trades (Globex K=1)\n";
  outputMd += `- Total suppressed trades: ${totSuppressedN} (Total avoided PnL: $${-totSuppressedLoss.toFixed(2)})\n`;
  if (totSuppressedN > 0) {
    outputMd += `- Already SUPPRESS/THIN_N: ${alreadySuppressedN} trades (${(alreadySuppressedN/totSuppressedN*100).toFixed(1)}%), PnL avoided: $${-alreadySuppressedLoss.toFixed(2)}\n`;
    outputMd += `- Currently ACTIVE: ${activeSuppressedN} trades (${(activeSuppressedN/totSuppressedN*100).toFixed(1)}%), PnL avoided: $${-activeSuppressedLoss.toFixed(2)}\n`;
  }
  outputMd += "\n";


  // ---------------------------------------------------------
  // WORKSTREAM C
  // ---------------------------------------------------------
  outputMd += "## Workstream C: Session VWAP-Sigma Prediction\n\n";
  
  // We need to compute developing VWAP up to the bar before the trade.
  // RTH only bars from 9:30am.
  
  // To optimize, fetch all RTH bars once and group by date.
  const barsRes = await query(`
    SELECT ts::date::text as d, ts, open::float, high::float, low::float, close::float, volume::bigint as vol, extract(epoch from ts)*1000 as ts_ms
    FROM price_bars_primary
    WHERE symbol='NQ'
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ORDER BY ts
  `);
  
  const barsByDate = {};
  for (const b of barsRes.rows) {
    if (!barsByDate[b.d]) barsByDate[b.d] = [];
    barsByDate[b.d].push(b);
  }

  // Get trailing 30-day close_vs_vwap std
  const sessAnRes = await query(`
    SELECT trade_date::text as d, close_vs_vwap
    FROM session_analysis
    WHERE close_vs_vwap IS NOT NULL
    ORDER BY trade_date
  `);
  
  const saRows = sessAnRes.rows;
  function getVwapSigmaStd(tradeDate) {
    // trailing 30 days
    const trailing = saRows.filter(r => r.d < tradeDate).slice(-30);
    if (trailing.length < 10) return 111; // fallback from morningBrief
    const dists = trailing.map(r => r.close_vs_vwap);
    const mean = dists.reduce((a,b) => a+b, 0) / dists.length;
    const std = Math.sqrt(dists.reduce((s, d) => s + (d - mean) ** 2, 0) / dists.length);
    return std > 0 ? std : 111;
  }

  // Compute for all trades
  const cTrades = [];
  
  for (const t of allTrades) {
    const bars = barsByDate[t.trade_date] || [];
    // up to the bar immediately before fired_at
    const priorBars = bars.filter(b => b.ts_ms < t.fired_at_ms);
    if (priorBars.length === 0) continue;
    
    let cumPV = 0, cumV = 0;
    for (const b of priorBars) {
      cumPV += (b.high + b.low + b.close) / 3 * Number(b.vol || 1);
      cumV += Number(b.vol || 1);
    }
    const price = priorBars[priorBars.length - 1].close;
    const vwap = cumV > 0 ? cumPV / cumV : price;
    
    const std = getVwapSigmaStd(t.trade_date);
    const sigma = (price - vwap) / std;
    
    cTrades.push({
      ...t,
      sigma,
      absSigma: Math.abs(sigma)
    });
  }

  // derive median abs sigma
  cTrades.sort((a,b) => a.absSigma - b.absSigma);
  const meaningfulCutoff = cTrades.length > 0 ? cTrades[Math.floor(cTrades.length / 2)].absSigma : 0;
  
  outputMd += `**Meaningful Cutoff derived from sample**: |Sigma| >= ${meaningfulCutoff.toFixed(2)}\n\n`;

  function checkAgreement(trades, name) {
    const subset = trades.filter(t => t.absSigma >= meaningfulCutoff);
    const agreeTrades = [];
    const fightTrades = [];
    
    for (const t of subset) {
      // sigma = (price - vwap) / std. 
      // positive sigma: price > vwap. Agree: LONG. Fight: SHORT.
      // negative sigma: price < vwap. Agree: SHORT. Fight: LONG.
      const sign = Math.sign(t.sigma);
      const isLong = t.direction === 'LONG';
      if ((sign > 0 && isLong) || (sign < 0 && !isLong)) {
        agreeTrades.push(t);
      } else {
        fightTrades.push(t);
      }
    }

    const agreeEV = agreeTrades.length > 0 ? agreeTrades.reduce((s,t) => s+t.actual_pnl,0)/agreeTrades.length : 0;
    const fightEV = fightTrades.length > 0 ? fightTrades.reduce((s,t) => s+t.actual_pnl,0)/fightTrades.length : 0;

    outputMd += `### C. Session VWAP-Sigma Agreement (${name})\n`;
    outputMd += `| Group | N | EV |\n`;
    outputMd += `|---|---|---|\n`;
    outputMd += `| AGREES with Sigma (e.g. Long when > VWAP) | ${agreeTrades.length} | $${agreeEV.toFixed(2)} |\n`;
    outputMd += `| FIGHTS Sigma (e.g. Short when > VWAP) | ${fightTrades.length} | $${fightEV.toFixed(2)} |\n\n`;

    // Rigor check on both pools
    if (agreeTrades.length >= 20) {
      const r = computeRigor(agreeTrades, { dateField: 'trade_date', pnlFn: t => t.actual_pnl });
      outputMd += `Rigor check for AGREES (${name}): Clustered? ${r.clustered ? 'Yes' : 'No'} (${r.top5DayPct}% in top 5). Stable thirds? ${r.stable ? 'Yes' : 'No'}.\n`;
    }
    if (fightTrades.length >= 20) {
      const r = computeRigor(fightTrades, { dateField: 'trade_date', pnlFn: t => t.actual_pnl });
      outputMd += `Rigor check for FIGHTS (${name}): Clustered? ${r.clustered ? 'Yes' : 'No'} (${r.top5DayPct}% in top 5). Stable thirds? ${r.stable ? 'Yes' : 'No'}.\n`;
    }
    outputMd += "\n";
  }

  const cRth = cTrades.filter(t => isRTH(t.fired_at_ms));
  const cGlobex = cTrades.filter(t => !isRTH(t.fired_at_ms));

  checkAgreement(cRth, 'RTH');
  checkAgreement(cGlobex, 'Globex');

  fs.writeFileSync('scratch/morning_weakness_deepdive_results.md', outputMd);
  console.log("Done. Results in scratch/morning_weakness_deepdive_results.md");
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
