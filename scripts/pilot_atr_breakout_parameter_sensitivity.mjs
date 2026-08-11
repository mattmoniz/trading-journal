import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import fs from 'fs';

const BAR_MIN = 60;

async function main() {
  const DOLLARS_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
  const COMMISSION_RT = LIVE_INSTRUMENT.commissionPerRoundTrip;

  console.log(`Fetching 1-min bars for NQ (>= 2023-12-16)...`);
  const sql = `
    SELECT
      ts, to_char(ts, 'YYYY-MM-DD HH24:MI:SS') as ts_str,
      open::float, high::float, low::float, close::float, volume,
      EXTRACT(hour FROM ts)::int as hour_part,
      EXTRACT(minute FROM ts)::int as minute_part,
      EXTRACT(dow FROM ts)::int as dow
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts >= '2023-12-16'
    ORDER BY ts ASC
  `;
  const { rows } = await query(sql);

  const buckets = new Map();
  for (const r of rows) {
    if (r.hour_part === 17) continue;
    const bucketMin = Math.floor(r.minute_part / BAR_MIN) * BAR_MIN;
    const bucketId = `${r.ts_str.substring(0, 10)} ${String(r.hour_part).padStart(2, '0')}:${String(bucketMin).padStart(2, '0')}:00`;

    if (!buckets.has(bucketId)) {
      buckets.set(bucketId, { ts: bucketId, open: r.open, high: r.high, low: r.low, close: r.close, dow: r.dow });
    } else {
      const b = buckets.get(bucketId);
      b.high = Math.max(b.high, r.high);
      b.low = Math.min(b.low, r.low);
      b.close = r.close;
    }
  }
  const mBars = Array.from(buckets.values()).sort((a, b) => a.ts.localeCompare(b.ts));

  for (let i = 0; i < mBars.length; i++) {
    if (i === 0) mBars[i].tr = mBars[i].high - mBars[i].low;
    else mBars[i].tr = Math.max(mBars[i].high - mBars[i].low, Math.abs(mBars[i].high - mBars[i-1].close), Math.abs(mBars[i].low - mBars[i-1].close));
    mBars[i].isFridayExit = mBars[i].dow === 5 && (!mBars[i+1] || mBars[i+1].dow !== 5);
  }

  function addWilderATR(bars, period, field) {
    let sumTR = 0;
    for (let i = 0; i < bars.length; i++) {
      if (i < period) { sumTR += bars[i].tr; if (i === period - 1) bars[i][field] = sumTR / period; }
      else bars[i][field] = (bars[i - 1][field] * (period - 1) + bars[i].tr) / period;
    }
  }

  function runBacktest(entryMult, stopMult, atrFast, atrSlow, useFilter) {
    for(let b of mBars) { delete b.atrFast; delete b.atrSlow; }
    addWilderATR(mBars, atrFast, 'atrFast');
    addWilderATR(mBars, atrSlow, 'atrSlow');

    let trades = [];
    let position = null;
    let entryBarIdx = null;

    for (let i = atrSlow; i < mBars.length - 1; i++) {
      const prevBar = mBars[i - 1];
      const bar = mBars[i];

      if (position) {
        let stopHit = false, exitPrice = null;
        if (bar.low <= position.stop) { stopHit = true; exitPrice = Math.min(bar.open, position.stop); }

        if (stopHit) {
          const pts = exitPrice - position.entryPrice;
          const pnl = (pts * DOLLARS_PER_POINT) - COMMISSION_RT;
          trades.push({ pnl, pts, date: bar.ts.substring(0, 10), entryTime: mBars[entryBarIdx].ts });
          position = null;
        } else if (bar.isFridayExit) {
          exitPrice = bar.close;
          const pts = exitPrice - position.entryPrice;
          const pnl = (pts * DOLLARS_PER_POINT) - COMMISSION_RT;
          trades.push({ pnl, pts, date: bar.ts.substring(0, 10), entryTime: mBars[entryBarIdx].ts });
          position = null;
        }
        continue;
      }

      if (!useFilter || prevBar.atrFast < prevBar.atrSlow) {
        const buyLevel = prevBar.open + (entryMult * prevBar.atrFast);
        if (bar.high >= buyLevel) {
          const entryPrice = Math.max(bar.open, buyLevel);
          const stop = entryPrice - (stopMult * prevBar.atrFast);
          position = { entryPrice, stop };
          entryBarIdx = i;

          if (bar.isFridayExit) {
            const exitPrice = bar.close;
            const pts = exitPrice - entryPrice;
            const pnl = (pts * DOLLARS_PER_POINT) - COMMISSION_RT;
            trades.push({ pnl, pts, date: bar.ts.substring(0, 10), entryTime: mBars[entryBarIdx].ts });
            position = null;
          }
        }
      }
    }
    return trades;
  }

  function getMetrics(trades) {
    if (!trades.length) return { N: 0, WR: 0, EV: 0, MaxDD: 0, Total: 0 };
    const WR = trades.filter(t => t.pnl > 0).length / trades.length;
    const EV = trades.reduce((s,t) => s+t.pnl, 0) / trades.length;
    let maxDD = 0, peak = 0, cum = 0;
    for (const t of trades) {
      cum += t.pnl;
      if (cum > peak) peak = cum;
      const dd = peak - cum;
      if (dd > maxDD) maxDD = dd;
    }
    return { N: trades.length, WR, EV, MaxDD: maxDD, Total: cum, trades };
  }

  let out = `# Thread 2: Parameter Sensitivity\n\n`;
  
  out += `## Grid A: Entry/Stop sensitivity (ATR 20,30)\n\n`;
  out += `| Entry Mult | Stop Mult | N | WR | EV | MaxDD |\n|---|---|---|---|---|---|\n`;
  
  const entries = [1.5, 2.0, 2.5];
  const stops = [0.4, 0.5, 0.6];
  
  let gridAResults = [];
  for (let e of entries) {
    for (let s of stops) {
      const metrics = getMetrics(runBacktest(e, s, 20, 30, true));
      out += `| ${e}x | ${s}x | ${metrics.N} | ${(metrics.WR*100).toFixed(1)}% | $${metrics.EV.toFixed(2)} | $${metrics.MaxDD.toFixed(2)} |\n`;
      gridAResults.push({ e, s, ...metrics });
    }
  }

  const baseCell = gridAResults.find(c => c.e === 2.0 && c.s === 0.5);
  const neighbors = gridAResults.filter(c => 
    (Math.abs(c.e - 2.0) <= 0.5 && c.s === 0.5 && c !== baseCell) || 
    (Math.abs(c.s - 0.5) <= 0.1 && c.e === 2.0 && c !== baseCell)
  );
  
  const posNeighbors = neighbors.filter(c => c.EV > 0);
  out += `\n**Plateau Check for (2.0x, 0.5x):** ${posNeighbors.length} of ${neighbors.length} first-degree neighbors have positive EV.\n`;

  const plateauCells = [baseCell, ...posNeighbors];
  let pooledTrades = [];
  for(const cell of plateauCells) {
    pooledTrades = pooledTrades.concat(cell.trades);
  }
  const pooledRigor = computeRigor(pooledTrades, { dateField: 'date', pnlFn: t => t.pnl });
  
  out += `\n**Pooled Plateau Rigor:**\n` + JSON.stringify(pooledRigor, null, 2) + `\n`;

  const bestA = gridAResults.reduce((max, c) => c.EV > max.EV ? c : max, gridAResults[0]);
  const noFilterMetrics = getMetrics(runBacktest(bestA.e, bestA.s, 20, 30, false));
  out += `\n**No-Filter Control at Best Grid A Cell (${bestA.e}x, ${bestA.s}x):** EV=$${noFilterMetrics.EV.toFixed(2)} (N=${noFilterMetrics.N})\n`;

  out += `\n## Grid B: Filter sensitivity at fixed Entry=${bestA.e}x, Stop=${bestA.s}x\n\n`;
  out += `| ATR Pair | N | WR | EV | MaxDD |\n|---|---|---|---|---|\n`;
  const atrPairs = [[15,25], [20,30], [25,35]];
  for (let [fast, slow] of atrPairs) {
    const metrics = getMetrics(runBacktest(bestA.e, bestA.s, fast, slow, true));
    out += `| (${fast},${slow}) | ${metrics.N} | ${(metrics.WR*100).toFixed(1)}% | $${metrics.EV.toFixed(2)} | $${metrics.MaxDD.toFixed(2)} |\n`;
  }

  out += `\n*Disclosure: N<20 per cell means individual EV points are noisy and directional-only.*\n`;

  fs.writeFileSync('scratch/atr_breakout_parameter_sensitivity_RESULTS.md', out);
  console.log('Results written to scratch/atr_breakout_parameter_sensitivity_RESULTS.md');

  await recordClaim({
    slug: 'atr_breakout_plateau',
    claimText: `ATR Breakout pooled plateau EV=+$${(pooledTrades.reduce((s,t)=>s+t.pnl,0)/pooledTrades.length).toFixed(2)} (N=${pooledTrades.length}). Neighbors > 0: ${posNeighbors.length}/${neighbors.length}.`,
    sourceFile: 'scripts/pilot_atr_breakout_parameter_sensitivity.mjs',
    sampleSize: pooledTrades.length,
    winRate: pooledTrades.filter(t=>t.pnl>0).length/pooledTrades.length,
    evPerTrade: pooledTrades.reduce((s,t)=>s+t.pnl,0)/pooledTrades.length,
    rigorStatus: pooledRigor.clean ? 'clean' : 'failed'
  });

  process.exit(0);
}
main().catch(err => { console.error(err); process.exit(1); });
