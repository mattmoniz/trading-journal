import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
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

async function main() {
  let output = `# Cluster Reaction Ideas Backtest\n\n`;

  // === IDEA A ===
  console.log("Running Idea A...");
  output += `## Idea A: Early-exit on still-open cluster siblings\n\n`;
  const qA = await query(`
    SELECT id, cluster_touch_id, setup_type,
      extract(epoch from fired_at)*1000 as fired_at_ms,
      extract(epoch from resolved_at)*1000 as resolved_at_ms,
      resolved_at::text as resolved_at_text,
      actual_pnl::float as actual_pnl,
      COALESCE(entry_zone_high, entry_zone_low)::float as entry,
      trade_date::text as trade_date
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND actual_pnl IS NOT NULL
      AND resolved_at IS NOT NULL
      AND cluster_touch_id IS NOT NULL
  `);

  const clusterMap = new Map();
  for (const row of qA.rows) {
    const dir = inferDirection(row.setup_type);
    if (!dir) continue;
    row.direction = dir;
    row.fired_at_ms = parseFloat(row.fired_at_ms);
    row.resolved_at_ms = parseFloat(row.resolved_at_ms);
    
    if (!clusterMap.has(row.cluster_touch_id)) {
      clusterMap.set(row.cluster_touch_id, []);
    }
    clusterMap.get(row.cluster_touch_id).push(row);
  }

  let a_exited = 0;
  let a_totalDelta = 0;
  let a_goodCalls = 0;
  let a_badCalls = 0;
  let a_neutralCalls = 0;

  for (const [clusterId, members] of clusterMap.entries()) {
    if (members.length < 2) continue;

    // Process members in RESOLUTION order
    members.sort((a, b) => a.resolved_at_ms - b.resolved_at_ms);

    // Find the first member that resolved as a loss
    let loser = null;
    for (const m of members) {
      if (m.actual_pnl < 0) {
        loser = m;
        break;
      }
    }

    if (!loser) continue;

    // For every other member of the same cluster that shares the same direction
    // and has not yet resolved as of the loser's resolution time
    for (const m of members) {
      if (m.id === loser.id) continue;
      if (m.direction !== loser.direction) continue;
      if (m.resolved_at_ms > loser.resolved_at_ms) {
        // Early exit!
        const barsQ = await query(`
          SELECT close::float FROM price_bars_primary
          WHERE symbol='NQ' AND ts >= $1 ORDER BY ts ASC LIMIT 1
        `, [loser.resolved_at_text]);
        
        let exitPrice = m.entry; // fallback if no bars
        if (barsQ.rows.length > 0) {
          exitPrice = barsQ.rows[0].close;
        }

        // Calculate early exit PnL (MNQ: $2/pt, $2 round trip comm)
        const isLong = m.direction === 'LONG';
        const earlyExitPnl = isLong 
          ? (exitPrice - m.entry) * 2 - 2 
          : (m.entry - exitPrice) * 2 - 2;
        
        const delta = earlyExitPnl - m.actual_pnl;
        a_exited++;
        a_totalDelta += delta;

        if (delta > 0) a_goodCalls++;
        else if (delta < 0) a_badCalls++;
        else a_neutralCalls++;
      }
    }
  }

  output += `**Total siblings early-exited:** ${a_exited}\n`;
  output += `**Total Delta:** $${a_totalDelta.toFixed(2)}\n`;
  if (a_exited > 0) {
    output += `**Mean Delta:** $${(a_totalDelta / a_exited).toFixed(2)}\n`;
  }
  output += `**Good calls (early exit better):** ${a_goodCalls}\n`;
  output += `**Bad calls (early exit worse):** ${a_badCalls}\n`;
  output += `**Neutral calls:** ${a_neutralCalls}\n\n`;


  // === IDEA B ===
  console.log("Running Idea B...");
  output += `## Idea B: Gate the NEXT cluster touch\n\n`;
  const qB = await query(`
    SELECT setup_type, trade_date::text as trade_date,
      extract(epoch from fired_at)*1000 as fired_at_ms,
      extract(epoch from resolved_at)*1000 as resolved_at_ms,
      actual_pnl::float as actual_pnl,
      cluster_touch_id
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND actual_pnl IS NOT NULL
      AND resolved_at IS NOT NULL
      AND fired_at IS NOT NULL
  `);

  const allTradesB = qB.rows.map(t => {
    t.direction = inferDirection(t.setup_type);
    t.fired_at_ms = parseFloat(t.fired_at_ms);
    t.resolved_at_ms = parseFloat(t.resolved_at_ms);
    return t;
  }).filter(t => t.direction !== null);

  // Group by cluster_touch_id, treating null as singleton
  const bClusterMap = new Map();
  for (const t of allTradesB) {
    const cid = t.cluster_touch_id || `singleton_${Math.random()}`;
    if (!bClusterMap.has(cid)) bClusterMap.set(cid, []);
    bClusterMap.get(cid).push(t);
  }

  const clusters = [];
  for (const [cid, members] of bClusterMap.entries()) {
    const direction = members[0].direction;
    const fired_at_ms = Math.min(...members.map(m => m.fired_at_ms));
    const resolved_at_ms = Math.max(...members.map(m => m.resolved_at_ms));
    const actual_pnl = members.reduce((sum, m) => sum + m.actual_pnl, 0);
    const trade_date = members[0].trade_date;

    clusters.push({
      id: cid,
      direction,
      fired_at_ms,
      resolved_at_ms,
      actual_pnl,
      trade_date,
      membersCount: members.length
    });
  }

  const rthClusters = clusters.filter(c => isRTH(c.fired_at_ms));
  const globexClusters = clusters.filter(c => !isRTH(c.fired_at_ms));

  const sessions = [
    { name: 'RTH', clusters: rthClusters },
    { name: 'Globex', clusters: globexClusters }
  ];

  const resultsB = [];

  for (const session of sessions) {
    let longBlocked = false;
    let shortBlocked = false;
    
    let ungatedPnl = 0;
    let gatedPnl = 0;
    let suppressedCount = 0;
    
    const clusterDeltas = [];

    const events = [];
    for (const c of session.clusters) {
      events.push({ time: c.fired_at_ms, type: 'FIRE', cluster: c });
      events.push({ time: c.resolved_at_ms, type: 'RESOLVE', cluster: c });
    }

    events.sort((a, b) => {
      if (a.time !== b.time) return a.time - b.time;
      if (a.type !== b.type) return a.type === 'RESOLVE' ? -1 : 1;
      return 0;
    });

    for (const event of events) {
      const isLong = event.cluster.direction === 'LONG';
      
      if (event.type === 'FIRE') {
        const isSuppressed = isLong ? longBlocked : shortBlocked;
        event.cluster.suppressed = isSuppressed;
      } else if (event.type === 'RESOLVE') {
        const pnl = event.cluster.actual_pnl;
        const wasSuppressed = event.cluster.suppressed;
        
        ungatedPnl += pnl;
        const gatedThisCluster = wasSuppressed ? 0 : pnl;
        gatedPnl += gatedThisCluster;
        
        clusterDeltas.push({
          date: event.cluster.trade_date,
          delta: gatedThisCluster - pnl
        });
        
        if (wasSuppressed) suppressedCount++;
        
        const isLoss = pnl < 0;
        
        if (isLong) {
          if (isLoss) {
            longBlocked = true;
            if (shortBlocked) shortBlocked = false;
          }
        } else {
          if (isLoss) {
            shortBlocked = true;
            if (longBlocked) longBlocked = false;
          }
        }
      }
    }

    // Clustering check
    const byDay = new Map();
    for (const r of clusterDeltas) {
      if (!byDay.has(r.date)) byDay.set(r.date, { n: 0, d: 0 });
      byDay.get(r.date).n++;
      byDay.get(r.date).d += r.delta;
    }
    const days = [...byDay.values()].sort((a, b) => b.d - a.d);
    const totalDelta = clusterDeltas.reduce((sum, r) => sum + r.delta, 0);
    const top5 = days.slice(0, 5);
    const top5Delta = top5.reduce((sum, d) => sum + d.d, 0);
    let clusteringFlag = "No";
    if (totalDelta > 0 && top5Delta > (totalDelta * 0.5)) {
      clusteringFlag = `Yes (${(top5Delta/totalDelta*100).toFixed(1)}% in top 5)`;
    } else if (totalDelta > 0) {
      clusteringFlag = `No (${(top5Delta/totalDelta*100).toFixed(1)}% in top 5)`;
    } else {
      clusteringFlag = "N/A (Negative/Zero)";
    }

    // Chronological half split
    const chronoDays = [...byDay.keys()].sort();
    const firstHalfDays = new Set(chronoDays.slice(0, Math.ceil(chronoDays.length / 2)));
    let h1Delta = 0, h2Delta = 0;
    for (const r of clusterDeltas) {
      if (firstHalfDays.has(r.date)) h1Delta += r.delta;
      else h2Delta += r.delta;
    }

    resultsB.push({
      session: session.name,
      ungatedPnl,
      gatedPnl,
      delta: totalDelta,
      suppressedCount,
      clusteringFlag,
      h1Delta,
      h2Delta
    });
  }

  output += `| Session | Ungated Total $ | Gated Total $ | Delta | N Clusters Suppressed | Clustered? | Half 1 Delta | Half 2 Delta |\n`;
  output += `|---------|-----------------|---------------|-------|-----------------------|------------|--------------|--------------|\n`;
  for (const r of resultsB) {
    output += `| ${r.session} | $${r.ungatedPnl.toFixed(2)} | $${r.gatedPnl.toFixed(2)} | $${r.delta.toFixed(2)} | ${r.suppressedCount} | ${r.clusteringFlag} | $${r.h1Delta.toFixed(2)} | $${r.h2Delta.toFixed(2)} |\n`;
  }
  
  fs.writeFileSync('scratch/cluster_reaction_ideas_results.md', output);
  console.log("Done. Wrote results to scratch/cluster_reaction_ideas_results.md");

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
