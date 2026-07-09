// Coiling + Volume Dry-Up Edge Backtest
//
// Entry conditions:
//   1. 15-bar rolling range < 40 pts (compressed price)
//   2. 15-bar avg volume < 40% of session baseline (volume dried up)
//   3. Pop surge: last bar vol >= 1.8x prior 8-bar avg AND price within 10 pts of coil boundary
//
// Key level check at pop boundary (within 15 pts):
//   PDH / PDL / PDC (from prior session), A-Up / A-Down (acd_daily_log),
//   IB High / IB Low (bars 9:30–10:30), VWAP (running from session open)
//
// Outcome tracked over next 60 bars (stop comes first):
//   Stop: price reverses through opposite coil boundary
//   T50: +50 pts from entry before stop
//   T100: +100 pts from entry before stop
//   VWAP: reaches VWAP before stop
//
// Segments: all / key level at boundary / no key level / high-eff / low-eff /
//           morning / midday / afternoon / key level + high eff

import pg from 'pg';
import { config } from 'dotenv';
config();

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'trading_journal',
  user: process.env.DB_USER || 'trader',
  password: process.env.DB_PASSWORD || 'trader123',
});

async function dbQuery(sql, params = []) {
  const client = await pool.connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}

function efficiencyRatio(bars) {
  if (bars.length < 2) return null;
  const closes = bars.map(b => b.close);
  const net = Math.abs(closes[closes.length - 1] - closes[0]);
  const path = closes.slice(1).reduce((s, c, i) => s + Math.abs(c - closes[i]), 0);
  return path > 0 ? net / path : 0;
}

function nearestLevel(price, levels, maxPts = 15) {
  let best = null, bestDist = Infinity;
  for (const kl of levels) {
    if (!kl || kl.value == null) continue;
    const dist = Math.abs(kl.value - price);
    if (dist <= maxPts && dist < bestDist) { best = kl; bestDist = dist; }
  }
  return best ? { ...best, dist: Math.round(bestDist * 10) / 10 } : null;
}

function statsBlock(subset, label) {
  const n = subset.length;
  if (!n) { console.log(`\n${label} (N=0) — no data`); return; }

  const stopOnly    = subset.filter(r => r.outcome === 'stop').length;
  const t50First    = subset.filter(r => r.t50Hit && r.outcome !== 'stop').length;
  const t100First   = subset.filter(r => r.t100Hit && r.outcome !== 'stop').length;
  const vwapFirst   = subset.filter(r => r.vwapHit && r.outcome !== 'stop').length;
  const expired     = subset.filter(r => r.outcome === 'expired').length;

  const avgStop  = subset.reduce((s, r) => s + r.stopDist, 0) / n;
  const vwapSub  = subset.filter(r => r.vwapDist != null);
  const avgVwap  = vwapSub.length ? vwapSub.reduce((s, r) => s + r.vwapDist, 0) / vwapSub.length : null;
  const avgVolSurge = subset.reduce((s, r) => s + r.volSurge, 0) / n;

  console.log(`\n${label} (N=${n})`);
  console.log(`  Stop hit (loss):  ${stopOnly.toString().padStart(3)}  ${(stopOnly/n*100).toFixed(1)}%`);
  console.log(`  +50 pts (win):    ${t50First.toString().padStart(3)}  ${(t50First/n*100).toFixed(1)}%`);
  console.log(`  +100 pts (win):   ${t100First.toString().padStart(3)}  ${(t100First/n*100).toFixed(1)}%`);
  console.log(`  VWAP hit (win):   ${vwapFirst.toString().padStart(3)}  ${(vwapFirst/n*100).toFixed(1)}%`);
  console.log(`  Expired (no out): ${expired.toString().padStart(3)}  ${(expired/n*100).toFixed(1)}%`);
  console.log(`  Avg stop dist:    ${avgStop.toFixed(1)} pts`);
  if (avgVwap != null) console.log(`  Avg VWAP dist:    ${avgVwap.toFixed(1)} pts  (avg target distance)`);
  console.log(`  Avg vol surge:    ${avgVolSurge.toFixed(1)}x`);
}

async function main() {
  console.log('=== Coiling + Volume Dry-Up Edge Backtest ===');
  console.log('Loading bar data...');

  const barsQ = await dbQuery(`
    SELECT
      ts::date::text as trade_date,
      (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
      open::float, high::float, low::float, close::float,
      COALESCE(volume, 0)::int as volume
    FROM price_bars_primary
    WHERE symbol = 'NQ'
      AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
    ORDER BY ts
  `);
  console.log(`Loaded ${barsQ.rows.length} bars.`);

  const acdQ = await dbQuery(`
    SELECT trade_date::text, a_up_level::float, a_down_level::float
    FROM acd_daily_log
  `);
  const acdByDate = new Map(acdQ.rows.map(r => [r.trade_date, r]));

  // Group bars by date
  const byDate = new Map();
  for (const row of barsQ.rows) {
    if (!byDate.has(row.trade_date)) byDate.set(row.trade_date, []);
    byDate.get(row.trade_date).push(row);
  }

  const sortedDates = [...byDate.keys()].sort();
  const sessionSummaries = new Map(); // prior day H/L/C

  const results = [];
  let daysProcessed = 0;
  let totalCoilEpisodes = 0;

  for (let di = 1; di < sortedDates.length; di++) {
    const date = sortedDates[di];
    const bars = byDate.get(date);
    if (!bars || bars.length < 300) continue;

    // Prior session
    const prevDate = sortedDates[di - 1];
    const prev = sessionSummaries.get(prevDate) || null;

    // Save today's summary for future iterations
    sessionSummaries.set(date, {
      high:  Math.max(...bars.map(b => b.high)),
      low:   Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1].close,
    });

    // Session baseline volume (full session average)
    const sessionBaselineVol = bars.reduce((s, b) => s + b.volume, 0) / bars.length;

    // IB bars (9:30–10:30 = et_min 570–629)
    const ibBars = bars.filter(b => b.et_min >= 570 && b.et_min <= 629);
    const ibHigh = ibBars.length > 0 ? Math.max(...ibBars.map(b => b.high)) : null;
    const ibLow  = ibBars.length > 0 ? Math.min(...ibBars.map(b => b.low)) : null;
    const ibComplete = bars.some(b => b.et_min >= 630); // past 10:30

    // ACD levels
    const acd = acdByDate.get(date) || null;

    // Session efficiency (full-session, used as regime label)
    const er = efficiencyRatio(bars);
    const isHighEff = er != null && er >= 0.0942;

    // Pre-compute running VWAP for each bar index
    const runningVwap = [];
    let vwapNum = 0, vwapDen = 0;
    for (const b of bars) {
      const tp = (b.high + b.low + b.close) / 3;
      vwapNum += tp * b.volume;
      vwapDen += b.volume;
      runningVwap.push(vwapDen > 0 ? vwapNum / vwapDen : null);
    }

    // Scan for coiling + pop
    let inCoil = false;
    let coilStartIdx = -1;
    let popFiredInEpisode = false;

    for (let i = 35; i < bars.length; i++) {
      const bar = bars[i];
      const vwap = runningVwap[i];

      // 15-bar rolling window
      const win15 = bars.slice(i - 14, i + 1);
      const rollHigh = Math.max(...win15.map(b => b.high));
      const rollLow  = Math.min(...win15.map(b => b.low));
      const rollRange = rollHigh - rollLow;
      const rollVol   = win15.reduce((s, b) => s + b.volume, 0) / 15;

      let isCoiling = false;
      let compStartIdx = i - 14;

      if (rollRange < 40) {
        // Walk backward to find the start of the compression period
        for (let j = i - 14; j >= 20; j--) {
          const win3 = bars.slice(j, j + 3);
          const wHi = Math.max(...win3.map(b => b.high));
          const wLo = Math.min(...win3.map(b => b.low));
          if (wHi - wLo < 35) {
            compStartIdx = j;
          } else {
            break;
          }
        }

        // Preceding 20-bar baseline before the compression period
        const win20Base = bars.slice(Math.max(0, compStartIdx - 20), compStartIdx);
        const baselineAvgVol = win20Base.length > 0
          ? win20Base.reduce((s, b) => s + b.volume, 0) / win20Base.length
          : 0;

        isCoiling = baselineAvgVol > 0 && rollVol < baselineAvgVol * 0.40;
      }

      if (isCoiling) {
        if (!inCoil) {
          inCoil = true;
          coilStartIdx = compStartIdx;
          popFiredInEpisode = false;
          totalCoilEpisodes++;
        }

        // Only fire one pop per coil episode
        if (!popFiredInEpisode && i >= coilStartIdx + 4) { // at least 5 bars in coil
          const prior8 = bars.slice(Math.max(0, i - 8), i);
          const prior8Avg = prior8.length > 0
            ? prior8.reduce((s, b) => s + b.volume, 0) / prior8.length
            : 0;
          const volSurge = prior8Avg > 0 ? bar.volume / prior8Avg : 0;

          if (volSurge >= 1.8) {
            const distToHigh = Math.abs(bar.close - rollHigh);
            const distToLow  = Math.abs(bar.close - rollLow);
            const popDir = distToHigh <= 10 ? 'up' : distToLow <= 10 ? 'down' : null;

            if (popDir) {
              popFiredInEpisode = true;

              const entryPrice = popDir === 'up' ? rollHigh : rollLow;
              const stopPrice  = popDir === 'up' ? rollLow  : rollHigh;
              const stopDist   = Math.abs(entryPrice - stopPrice);

              // Key levels at the pop boundary
              const ibHighNow = ibComplete ? ibHigh : null;
              const ibLowNow  = ibComplete ? ibLow  : null;
              const levelList = [
                prev?.high  != null && { label: 'PDH',    value: prev.high },
                prev?.low   != null && { label: 'PDL',    value: prev.low },
                prev?.close != null && { label: 'PDC',    value: prev.close },
                ibHighNow   != null && { label: 'IB High', value: ibHighNow },
                ibLowNow    != null && { label: 'IB Low',  value: ibLowNow },
                acd?.a_up_level   != null && { label: 'A-Up',   value: acd.a_up_level },
                acd?.a_down_level != null && { label: 'A-Down', value: acd.a_down_level },
                vwap != null && { label: 'VWAP', value: vwap },
              ].filter(Boolean);

              const boundaryLevel = nearestLevel(entryPrice, levelList);
              const vwapDist = vwap != null
                ? (popDir === 'up' ? vwap - entryPrice : entryPrice - vwap)
                : null;

              const coilDuration = i - coilStartIdx + 1;
              const timeOfDay = bar.et_min < 690 ? 'morning'
                : bar.et_min < 810 ? 'midday' : 'afternoon';

              // Outcome: track next 60 bars
              const futBars = bars.slice(i + 1, i + 61);
              let outcome = 'expired';
              let t50Hit = false, t100Hit = false, vwapHit = false;
              let barsToOutcome = futBars.length;

              for (let fi = 0; fi < futBars.length; fi++) {
                const fb = futBars[fi];
                if (popDir === 'up') {
                  if (fb.low <= stopPrice)           { outcome = 'stop'; barsToOutcome = fi + 1; break; }
                  if (!t50Hit  && fb.high >= entryPrice + 50)  t50Hit  = true;
                  if (!t100Hit && fb.high >= entryPrice + 100) t100Hit = true;
                  if (!vwapHit && vwap != null && fb.high >= vwap) vwapHit = true;
                } else {
                  if (fb.high >= stopPrice)           { outcome = 'stop'; barsToOutcome = fi + 1; break; }
                  if (!t50Hit  && fb.low <= entryPrice - 50)  t50Hit  = true;
                  if (!t100Hit && fb.low <= entryPrice - 100) t100Hit = true;
                  if (!vwapHit && vwap != null && fb.low <= vwap) vwapHit = true;
                }
              }

              results.push({
                date,
                et_min: bar.et_min,
                timeOfDay,
                popDir,
                entryPrice,
                stopPrice,
                stopDist,
                boundaryLevel: boundaryLevel?.label || null,
                boundaryLevelDist: boundaryLevel?.dist || null,
                vwapDist,
                coilRange: rollRange,
                coilDuration,
                volSurge: Math.round(volSurge * 10) / 10,
                isHighEff,
                er: er != null ? Math.round(er * 1000) / 1000 : null,
                outcome,
                t50Hit,
                t100Hit,
                vwapHit,
                barsToOutcome,
              });
            }
          }
        }
      } else {
        inCoil = false;
        popFiredInEpisode = false;
      }
    }

    daysProcessed++;
  }

  console.log(`\nProcessed ${daysProcessed} sessions`);
  console.log(`Total coil episodes: ${totalCoilEpisodes}`);
  console.log(`Pop setups found:    ${results.length}`);
  console.log(`Avg pops/day:        ${(results.length / daysProcessed).toFixed(2)}`);

  // ── Main stats ────────────────────────────────────────────────────────────
  statsBlock(results, 'ALL POPS');

  const withLevel = results.filter(r => r.boundaryLevel);
  const noLevel   = results.filter(r => !r.boundaryLevel);
  statsBlock(withLevel, 'WITH KEY LEVEL at boundary');
  statsBlock(noLevel,   'NO key level at boundary');

  statsBlock(results.filter(r => r.isHighEff),  'HIGH EFFICIENCY days');
  statsBlock(results.filter(r => !r.isHighEff), 'LOW EFFICIENCY days');

  statsBlock(results.filter(r => r.timeOfDay === 'morning'),   'MORNING   (9:30–11:30)');
  statsBlock(results.filter(r => r.timeOfDay === 'midday'),    'MIDDAY    (11:30–1:30)');
  statsBlock(results.filter(r => r.timeOfDay === 'afternoon'), 'AFTERNOON (1:30–4:00)');

  statsBlock(results.filter(r => r.boundaryLevel && r.isHighEff),  'KEY LEVEL + HIGH EFF  ← primary edge');
  statsBlock(results.filter(r => r.boundaryLevel && !r.isHighEff), 'KEY LEVEL + LOW EFF');
  statsBlock(results.filter(r => !r.boundaryLevel && r.isHighEff), 'NO LEVEL + HIGH EFF');

  // ── Level type breakdown ──────────────────────────────────────────────────
  console.log('\n=== Level Types at Boundary ===');
  const lvlMap = new Map();
  for (const r of results) {
    const lbl = r.boundaryLevel || '(none)';
    if (!lvlMap.has(lbl)) lvlMap.set(lbl, { n: 0, wins50: 0, stops: 0 });
    const entry = lvlMap.get(lbl);
    entry.n++;
    if (r.t50Hit && r.outcome !== 'stop') entry.wins50++;
    if (r.outcome === 'stop') entry.stops++;
  }
  for (const [lbl, v] of [...lvlMap.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const wr = v.n > 0 ? (v.wins50 / v.n * 100).toFixed(1) : '—';
    const sr = v.n > 0 ? (v.stops  / v.n * 100).toFixed(1) : '—';
    console.log(`  ${lbl.padEnd(10)} N=${v.n.toString().padStart(3)}  +50 win ${wr}%  stop ${sr}%`);
  }

  // ── Direction breakdown ───────────────────────────────────────────────────
  console.log('\n=== Pop Direction ===');
  statsBlock(results.filter(r => r.popDir === 'up'),   'UP pops');
  statsBlock(results.filter(r => r.popDir === 'down'), 'DOWN pops');

  await pool.end();
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
