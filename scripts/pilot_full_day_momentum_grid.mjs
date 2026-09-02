import fs from 'fs';
import { query } from '../server/db.js';
import { pearson, permutationTest } from './pilot_globex_overnight_momentum_persistence_grid.mjs';

function minToTimeStr(m) {
  let mapped = m;
  if (mapped < 0) mapped += 24 * 60;
  mapped = mapped % (24 * 60);
  const h = Math.floor(mapped / 60);
  const mins = mapped % 60;
  return `${h.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
}

async function main() {
  console.log("Fetching price bars...");
  const r = await query(`
    SELECT ts::date::text as d, EXTRACT(hour FROM ts)::int as hr, EXTRACT(minute FROM ts)::int as min, close::float
    FROM price_bars_primary
    WHERE symbol='NQ'
      AND (EXTRACT(minute FROM ts) = 0 OR EXTRACT(minute FROM ts) = 30)
    ORDER BY ts
  `);
  
  const bySession = new Map();
  for (const b of r.rows) {
    let sessDate;
    if (b.hr >= 18) {
      const dt = new Date(b.d + 'T12:00:00Z'); 
      dt.setUTCDate(dt.getUTCDate() + 1);
      sessDate = dt.toISOString().slice(0, 10);
    } else {
      sessDate = b.d;
    }
    
    let mappedTime;
    if (b.hr >= 18) {
      mappedTime = (b.hr - 24) * 60 + b.min;
    } else {
      mappedTime = b.hr * 60 + b.min;
    }
    
    // Only map between 18:00 (-360) and 17:00 (1020)
    if (mappedTime >= -360 && mappedTime <= 1020) {
      if (!bySession.has(sessDate)) bySession.set(sessDate, {});
      bySession.get(sessDate)[mappedTime] = b.close;
    }
  }
  
  // Sanity check
  const sampleSessionDate = [...bySession.keys()].sort().pop();
  const sampleBars = bySession.get(sampleSessionDate);
  const sampleTimes = Object.keys(sampleBars).map(Number).sort((a,b) => a-b);
  console.log(`Sanity check: Session ${sampleSessionDate} spans from ${minToTimeStr(sampleTimes[0])} (${sampleTimes[0]}) to ${minToTimeStr(sampleTimes[sampleTimes.length-1])} (${sampleTimes[sampleTimes.length-1]}) with ${sampleTimes.length} bars.`);

  const anchors = [];
  for (let t = -360; t <= 1020; t += 30) {
    anchors.push(t);
  }

  const resultsList = [];
  let pairsTested = 0;

  for (const a of anchors) {
    for (const c of anchors) {
      if (c <= a) continue;
      
      const a_minus_60 = a - 60;
      const valid_sessions = [];
      const sortedDates = [...bySession.keys()].sort();
      
      for (const d of sortedDates) {
        const bars = bySession.get(d);
        if (bars[a_minus_60] !== undefined && bars[a] !== undefined && bars[c] !== undefined) {
          valid_sessions.push({
            mom60: bars[a] - bars[a_minus_60],
            fwd: bars[c] - bars[a]
          });
        }
      }
      
      const N = valid_sessions.length;
      let corr = null;
      let pval = null;
      
      // We only compute correlation if N >= 20. But for candidates we'll require N >= 50.
      if (N >= 20) {
        pairsTested++;
        const mom_arr = valid_sessions.map(x => x.mom60);
        const fwd_arr = valid_sessions.map(x => x.fwd);
        corr = pearson(mom_arr, fwd_arr);
        pval = permutationTest(mom_arr, fwd_arr, corr, 500); // 500 draws
      }
      
      resultsList.push({
        anchor: a,
        checkpoint: c,
        N,
        corr,
        pval
      });
    }
  }

  const bonferroniAlpha = 0.05 / pairsTested;
  console.log(`Pairs actually tested (N>=20): ${pairsTested}. Bonferroni alpha: ${bonferroniAlpha}`);

  const finalGrid = resultsList.map(r => {
    const isRawSig = r.pval !== null && r.pval <= 0.05;
    const isBonfSig = r.pval !== null && r.pval <= bonferroniAlpha;
    const meetsFloor = r.N >= 50;
    return {
      anchor_str: minToTimeStr(r.anchor),
      checkpoint_str: minToTimeStr(r.checkpoint),
      anchor: r.anchor,
      checkpoint: r.checkpoint,
      N: r.N,
      corr: r.corr,
      pval: r.pval,
      bonferroniSignificant: isBonfSig,
      candidate: meetsFloor && isBonfSig,
      rawSig: meetsFloor && isRawSig
    };
  });

  fs.writeFileSync('scratch/full_day_momentum_grid.json', JSON.stringify(finalGrid, null, 2));
  
  const candidates = finalGrid.filter(r => r.candidate).sort((a,b) => Math.abs(b.corr) - Math.abs(a.corr));
  const rawSigCount = finalGrid.filter(r => r.rawSig && !r.bonferroniSignificant).length;
  
  console.log("----- CANDIDATES -----");
  candidates.forEach(c => console.log(`${c.anchor_str} -> ${c.checkpoint_str}: corr=${c.corr?.toFixed(3)}, p=${c.pval?.toFixed(5)}, N=${c.N}`));
  console.log(`\nRaw sig (p<=0.05) but not Bonferroni: ${rawSigCount}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
