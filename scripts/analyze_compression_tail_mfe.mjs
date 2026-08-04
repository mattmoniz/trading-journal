import { query } from '../server/db.js';
import { inferStrategyFamily } from '../server/config/setupTypes.js';
import { computeRigor, computeReplication } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

function normalCDF(x) {
  let t = 1 / (1 + 0.2316419 * Math.abs(x));
  let d = 0.3989423 * Math.exp(-x * x / 2);
  let prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - prob : prob;
}

function twoPropZTest(x1, n1, x2, n2) {
  if (n1 === 0 || n2 === 0) return { z: 0, p: 1 };
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, p: 1 };
  const z = (p1 - p2) / se;
  return { z, p: 2 * (1 - normalCDF(Math.abs(z))) };
}

function getPercentile(arr, p) {
  if (arr.length === 0) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function getMedian(arr) {
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function main() {
  const { rows } = await query(`
    SELECT id, setup_type, trade_date::text as trade_date, mfe_points, 
           va_width_pctile_60d, va_overlap_streak, ib_range_pctile_60d
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW') AND is_rth = true
      AND resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED')
      AND mfe_points IS NOT NULL
  `);

  // Map family and calculate medians
  const mfeBySetup = new Map();
  for (const r of rows) {
    if (!mfeBySetup.has(r.setup_type)) mfeBySetup.set(r.setup_type, []);
    mfeBySetup.get(r.setup_type).push(parseFloat(r.mfe_points));
  }
  const medianBySetup = new Map();
  for (const [st, arr] of mfeBySetup.entries()) {
    medianBySetup.set(st, getMedian(arr));
  }

  // Pre-process trades
  const trades = rows.map(r => {
    const family = inferStrategyFamily(r.setup_type);
    const median = medianBySetup.get(r.setup_type);
    const isTail = parseFloat(r.mfe_points) >= 2 * median;
    return {
      ...r,
      family,
      isTail,
      va_width: r.va_width_pctile_60d !== null ? parseFloat(r.va_width_pctile_60d) : null,
      va_overlap: r.va_overlap_streak !== null ? parseInt(r.va_overlap_streak, 10) : null,
      ib_range: r.ib_range_pctile_60d !== null ? parseFloat(r.ib_range_pctile_60d) : null
    };
  }).filter(t => t.family !== null);

  const vaWidths = trades.filter(t => t.va_width !== null).map(t => t.va_width);
  const ibRanges = trades.filter(t => t.ib_range !== null).map(t => t.ib_range);
  const vaOverlaps = trades.filter(t => t.va_overlap !== null).map(t => t.va_overlap);

  const cuts = {
    va_width: [getPercentile(vaWidths, 0.33), getPercentile(vaWidths, 0.25), getPercentile(vaWidths, 0.10)],
    ib_range: [getPercentile(ibRanges, 0.33), getPercentile(ibRanges, 0.25), getPercentile(ibRanges, 0.10)],
    va_overlap: [getPercentile(vaOverlaps, 0.67), getPercentile(vaOverlaps, 0.75), getPercentile(vaOverlaps, 0.90)]
  };

  const alpha = 0.05 / 18; // 0.00278
  
  const cells = [
    { metric: 'va_width', dir: 'low', levels: cuts.va_width },
    { metric: 'ib_range', dir: 'low', levels: cuts.ib_range },
    { metric: 'va_overlap', dir: 'high', levels: cuts.va_overlap }
  ];

  const resultsByFamily = { 'MEAN_REVERSION': [], 'CONTINUATION': [] };

  for (const family of ['MEAN_REVERSION', 'CONTINUATION']) {
    const fTrades = trades.filter(t => t.family === family);
    
    for (const cell of cells) {
      for (const level of cell.levels) {
        if (level === null) continue;
        
        const metricTrades = fTrades.filter(t => t[cell.metric] !== null);
        
        const isCompressed = t => cell.dir === 'low' ? t[cell.metric] <= level : t[cell.metric] >= level;
        const compressed = metricTrades.filter(isCompressed);
        const uncompressed = metricTrades.filter(t => !isCompressed(t));
        
        const cHits = compressed.filter(t => t.isTail).length;
        const cN = compressed.length;
        const uHits = uncompressed.filter(t => t.isTail).length;
        const uN = uncompressed.length;
        
        const cRate = cN > 0 ? cHits / cN : 0;
        const uRate = uN > 0 ? uHits / uN : 0;
        const diff = cRate - uRate;
        
        const test = twoPropZTest(cHits, cN, uHits, uN);
        const pass = test.p <= alpha;
        
        const rigor = computeRigor(compressed, { dateField: 'trade_date', pnlFn: e => e.isTail ? 1 : -1 });
        
        resultsByFamily[family].push({
          metric: cell.metric, level, diff, cRate, uRate, cN, uN, test, pass, rigor,
          setupTypeData: metricTrades.reduce((acc, t) => {
            if (!acc[t.setup_type]) acc[t.setup_type] = { cHits:0, cN:0, uHits:0, uN:0 };
            if (isCompressed(t)) { acc[t.setup_type].cN++; if (t.isTail) acc[t.setup_type].cHits++; }
            else { acc[t.setup_type].uN++; if (t.isTail) acc[t.setup_type].uHits++; }
            return acc;
          }, {})
        });
      }
    }
  }

  // Replication and recording
  for (const family of ['MEAN_REVERSION', 'CONTINUATION']) {
    const results = resultsByFamily[family];
    console.log(`\n=== Family: ${family} ===`);
    
    let bestCell = null;
    let maxEffect = 0;
    
    for (const res of results) {
      console.log(`Cell: ${res.metric} (level ${res.level}) | diff: ${(res.diff*100).toFixed(1)}% | p-value: ${res.test.p.toExponential(2)} | PASS Bonferroni: ${res.pass} | Rigor Clean: ${res.rigor.clean}`);
      console.log(`  Compressed N=${res.cN} rate=${(res.cRate*100).toFixed(1)}% | Uncompressed N=${res.uN} rate=${(res.uRate*100).toFixed(1)}%`);
      
      if (Math.abs(res.diff) > Math.abs(maxEffect) && res.cN > 0) {
        maxEffect = res.diff;
        bestCell = res;
      }
    }
    
    if (!bestCell) {
      console.log('No valid cells found.');
      continue;
    }
    
    // computeReplication on the best cell
    const units = Object.keys(bestCell.setupTypeData).map(st => ({ id: st, ...bestCell.setupTypeData[st] }));
    const idFn = u => u.id;
    const metricFn = u => {
      if (u.cN === 0 || u.uN === 0) return null;
      const cRate = u.cHits / u.cN;
      const uRate = u.uHits / u.uN;
      return { n: u.cN + u.uN, value: cRate - uRate };
    };
    
    const pooledSign = Math.sign(bestCell.diff);
    const selectedIds = units.filter(u => {
      const m = metricFn(u);
      return m && Math.sign(m.value) === pooledSign;
    }).map(u => u.id);
    
    const rep = computeReplication(units, { idFn, metricFn, selectedIds });
    console.log(`\nReplication for best cell (${bestCell.metric} lvl ${bestCell.level}):`, JSON.stringify(rep));
    
    // Record Claim
    const slug = `compression_tail_mfe_${family.toLowerCase()}`;
    const claimText = `Best metric: ${bestCell.metric} (level ${bestCell.level}). Effect size: ${(bestCell.diff*100).toFixed(1)}%. Bonferroni: ${bestCell.pass}, Rigor: ${bestCell.rigor.clean}, Replicates: ${rep.replicates}.`;
    
    await recordClaim({
      slug,
      claimText,
      sourceFile: 'scripts/analyze_compression_tail_mfe.mjs',
      sampleSize: bestCell.cN + bestCell.uN,
      winRate: null,
      evPerTrade: null,
      rigorStatus: bestCell.rigor.clean ? 'clean' : 'not_clean',
      status: bestCell.pass && bestCell.rigor.clean && rep.replicates ? 'CONFIRMED' : 'PROVISIONAL'
    });
  }
  
  process.exit(0);
}

main().catch(console.error);
