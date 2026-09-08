import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';

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
  `);
  
  const allTrades = tradesRes.rows
    .map(t => ({ 
      ...t, 
      direction: inferDirection(t.setup_type),
      fired_at_ms: parseFloat(t.fired_at_ms),
      resolved_at_ms: parseFloat(t.resolved_at_ms)
    }))
    .filter(t => t.direction !== null);
    
  const rthTrades = allTrades.filter(t => isRTH(t.fired_at_ms));
  const globexTrades = allTrades.filter(t => !isRTH(t.fired_at_ms));
  
  const sessions = [
    { name: 'RTH', trades: rthTrades },
    { name: 'Globex', trades: globexTrades }
  ];
  
  const Ks = [1, 2];
  
  const results = [];
  
  for (const session of sessions) {
    for (const K of Ks) {
      let longLossStreak = 0;
      let shortLossStreak = 0;
      let longBlocked = false;
      let shortBlocked = false;
      
      let ungatedPnl = 0;
      let gatedPnl = 0;
      
      let suppressedCount = 0;
      let suppressedLoss = 0;
      let suppressedWin = 0;
      
      let simultaneousBlocks = 0;
      let swapBlocks = 0;
      
      const tradeDeltas = [];
      
      // Build events
      const events = [];
      for (const trade of session.trades) {
        // give each trade a unique id to reference back
        trade.id = Math.random();
        events.push({ time: trade.fired_at_ms, type: 'FIRE', trade });
        events.push({ time: trade.resolved_at_ms, type: 'RESOLVE', trade });
      }
      
      events.sort((a, b) => {
        if (a.time !== b.time) return a.time - b.time;
        if (a.type !== b.type) return a.type === 'RESOLVE' ? -1 : 1;
        return 0;
      });
      
      for (const event of events) {
        const isLong = event.trade.direction === 'LONG';
        
        if (event.type === 'FIRE') {
          const isSuppressed = isLong ? longBlocked : shortBlocked;
          event.trade.suppressed = isSuppressed;
        } else if (event.type === 'RESOLVE') {
          const pnl = event.trade.actual_pnl;
          const wasSuppressed = event.trade.suppressed;
          
          ungatedPnl += pnl;
          const gatedThisTrade = wasSuppressed ? 0 : pnl;
          gatedPnl += gatedThisTrade;
          
          tradeDeltas.push({
            date: event.trade.trade_date,
            delta: gatedThisTrade - pnl
          });
          
          if (wasSuppressed) {
            suppressedCount++;
            if (pnl < 0) suppressedLoss++;
            if (pnl > 0) suppressedWin++;
          }
          
          const isLoss = pnl < 0;
          const isWin = pnl > 0;
          
          const preLongBlocked = longBlocked;
          const preShortBlocked = shortBlocked;
          
          if (isLong) {
            if (isLoss) {
              longLossStreak++;
              if (longLossStreak >= K) longBlocked = true;
              if (shortBlocked) {
                shortBlocked = false;
                shortLossStreak = 0;
              }
            } else if (isWin) {
              longLossStreak = 0;
            }
          } else {
            if (isLoss) {
              shortLossStreak++;
              if (shortLossStreak >= K) shortBlocked = true;
              if (longBlocked) {
                longBlocked = false;
                longLossStreak = 0;
              }
            } else if (isWin) {
              shortLossStreak = 0;
            }
          }
          
          if (longBlocked && shortBlocked) simultaneousBlocks++;
          if ((preLongBlocked && !longBlocked && !preShortBlocked && shortBlocked) ||
              (preShortBlocked && !shortBlocked && !preLongBlocked && longBlocked)) {
            swapBlocks++;
          }
        }
      }
      
      // Calculate clustering
      const byDay = new Map();
      for (const r of tradeDeltas) {
        if (!byDay.has(r.date)) byDay.set(r.date, { n: 0, d: 0 });
        byDay.get(r.date).n++;
        byDay.get(r.date).d += r.delta;
      }
      const days = [...byDay.values()].sort((a, b) => b.d - a.d);
      const totalDelta = tradeDeltas.reduce((sum, r) => sum + r.delta, 0);
      const top5 = days.slice(0, 5);
      const top5Delta = top5.reduce((sum, d) => sum + d.d, 0);
      let clusteringFlag = "No";
      if (totalDelta > 0 && top5Delta > (totalDelta * 0.5)) {
        clusteringFlag = `Yes (${(top5Delta/totalDelta*100).toFixed(1)}% in top 5 days)`;
      } else if (totalDelta > 0) {
        clusteringFlag = `No (${(top5Delta/totalDelta*100).toFixed(1)}% in top 5 days)`;
      } else {
        clusteringFlag = "N/A (Negative total delta)";
      }
      
      // Chronological half split
      const chronoDays = [...byDay.keys()].sort();
      const firstHalfDays = new Set(chronoDays.slice(0, Math.ceil(chronoDays.length / 2)));
      let h1Delta = 0, h2Delta = 0;
      for (const r of tradeDeltas) {
        if (firstHalfDays.has(r.date)) h1Delta += r.delta;
        else h2Delta += r.delta;
      }
      
      results.push({
        session: session.name,
        K,
        ungatedPnl,
        gatedPnl,
        delta: totalDelta,
        suppressedCount,
        suppressedLoss,
        suppressedWin,
        clusteringFlag,
        h1Delta,
        h2Delta,
        simultaneousBlocks,
        swapBlocks
      });
    }
  }
  
  console.log("## Directional Loss-Streak Lockout Backtest Results");
  console.log("");
  console.log("| Session | K | Ungated Total $ | Gated Total $ | Delta | N Suppressed | Suppressed Lost | Suppressed Won | Clustered? | Half 1 Delta | Half 2 Delta |");
  console.log("|---------|---|-----------------|---------------|-------|--------------|-----------------|----------------|------------|--------------|--------------|");
  for (const r of results) {
    console.log(`| ${r.session} | ${r.K} | $${r.ungatedPnl.toFixed(2)} | $${r.gatedPnl.toFixed(2)} | $${r.delta.toFixed(2)} | ${r.suppressedCount} | ${r.suppressedLoss} | ${r.suppressedWin} | ${r.clusteringFlag} | $${r.h1Delta.toFixed(2)} | $${r.h2Delta.toFixed(2)} |`);
  }
  
  console.log("");
  console.log("### Simultaneous Block States Analysis");
  for (const r of results) {
    console.log(`- ${r.session} (K=${r.K}): Simultaneous blocks: ${r.simultaneousBlocks}, Swaps (One blocked instantly unblocks other): ${r.swapBlocks}`);
  }
  console.log("Note: As per the exact logical specification, a loss that causes one direction to become blocked simultaneously unblocks the opposing direction (if it was blocked). Thus, a persistent simultaneous block never exists in the real timeline.");

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
