import { query } from '../server/db.js';
import * as ss from 'simple-statistics';
import { getVolumeBaseline, classifyTouch } from '../server/services/touchQuality.js';
import { computeRigor, rigorContext } from '../server/services/rigorDiagnostics.js';
import fs from 'fs';

const PNL_PER_POINT = 2;
const COMMISSION    = 1;
const WINDOW_DAYS   = 180;
const LOOK_FORWARD  = 120; // Expanded slightly to allow 120pt stop hits, though original used 30
const STOP_PT = 120;
// We will test 30pt target as a baseline, or just compute MFE/MAE.
const TARGET_PT = 40; // We'll compute WR for this

function pct(arr) {
  if (!arr.length) return { p25: 0, p50: 0, p75: 0, p90: 0, mean: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  return {
    p25:  ss.quantileSorted(sorted, 0.25),
    p50:  ss.quantileSorted(sorted, 0.50),
    p75:  ss.quantileSorted(sorted, 0.75),
    p90:  ss.quantileSorted(sorted, 0.90),
    mean: ss.mean(sorted),
  };
}

async function getTradingDays() {
  const r = await query(`
    SELECT lp.trade_date::text as trade_date
    FROM level_prices lp
    WHERE lp.trade_date <= CURRENT_DATE
      AND EXISTS (
        SELECT 1 FROM price_bars_primary p
        WHERE p.ts::date = lp.trade_date
          AND EXTRACT(hour FROM p.ts)*60+EXTRACT(minute FROM p.ts) BETWEEN 570 AND 959
      )
    GROUP BY lp.trade_date
    HAVING COUNT(DISTINCT lp.level_name) >= 5
    ORDER BY lp.trade_date DESC
    LIMIT $1
  `, [WINDOW_DAYS]);
  return r.rows.map(r => r.trade_date).sort();
}

async function getLevelPrices(tradeDate) {
  const r = await query(`
    SELECT level_name, price::float FROM level_prices
    WHERE trade_date = $1 AND price IS NOT NULL
  `, [tradeDate]);
  const map = {};
  for (const row of r.rows) map[row.level_name] = row.price;
  return map;
}

async function getRTHBars(tradeDate) {
  const r = await query(`
    SELECT
      ts,
      (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as mod,
      open::float, high::float, low::float, close::float,
      volume::int, bid_volume::int, ask_volume::int
    FROM price_bars_primary
    WHERE ts::date = $1
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) <= 960
    ORDER BY ts
  `, [tradeDate]);
  return r.rows;
}

function computeDevelopingPOC(bars, upToIdx) {
  const profile = new Map();
  for (let i = 0; i <= upToIdx; i++) {
    const b = bars[i];
    const lo = Math.floor(b.low);
    const hi = Math.ceil(b.high);
    const range = hi - lo || 1;
    const volPerLevel = b.volume / range;
    for (let p = lo; p <= hi; p++) {
      profile.set(p, (profile.get(p) || 0) + volPerLevel);
    }
  }
  let maxVol = 0, poc = 0;
  for (const [price, vol] of profile) {
    if (vol > maxVol) { maxVol = vol; poc = price; }
  }
  return poc;
}

function computeVWAP(bars, upToIdx) {
  let cumVP = 0, cumVol = 0;
  for (let i = 0; i <= upToIdx; i++) {
    const b = bars[i];
    const tp = (b.high + b.low + b.close) / 3;
    cumVP += tp * b.volume;
    cumVol += b.volume;
  }
  return cumVol > 0 ? cumVP / cumVol : 0;
}

async function main() {
  const tradingDays = await getTradingDays();
  console.log(`Found ${tradingDays.length} trading days`);

  const allTouches = [];

  // Cutoff for recent 22 days
  const recentCutoffDate = tradingDays[tradingDays.length - 22];

  for (let di = 0; di < tradingDays.length; di++) {
    const date = tradingDays[di];
    const [levelPrices, bars, baseline] = await Promise.all([
      getLevelPrices(date),
      getRTHBars(date),
      getVolumeBaseline(query, date)
    ]);

    if (Object.keys(levelPrices).length < 5 || bars.length < 60) continue;

    const { RTH_VWAP: _excluded, ...staticLevels } = levelPrices;
    const touchedLevels = new Set();
    let devHigh = -Infinity, devLow = Infinity;

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      if (bar.mod < 570 || bar.mod > 959) continue; // Only process RTH for touches

      devHigh = Math.max(devHigh, bar.high);
      devLow  = Math.min(devLow, bar.low);

      const pastIB = bar.mod >= 630;
      const proximity = 15;

      const availableLevels = { ...staticLevels };
      if (!pastIB) {
        delete availableLevels.IB_HIGH;
        delete availableLevels.IB_LOW;
        delete availableLevels.IB_MID;
      }
      availableLevels.VWAP = computeVWAP(bars, i);
      if (i % 10 === 0 || i === bars.length - 1) {
        availableLevels.DEV_POC = computeDevelopingPOC(bars, i);
      }

      const nearbyLevelsHigh = [];
      const nearbyLevelsLow  = [];

      for (const [name, level] of Object.entries(availableLevels)) {
        if (level == null || !isFinite(level)) continue;
        const distToHigh = Math.abs(bar.high - level);
        const distToLow  = Math.abs(bar.low - level);
        if (distToHigh <= proximity && bar.high >= level) {
          nearbyLevelsHigh.push({ name, level, dist: distToHigh });
        }
        if (distToLow <= proximity && bar.low <= level) {
          nearbyLevelsLow.push({ name, level, dist: distToLow });
        }
      }

      // Process SHORT (fade High)
      if (nearbyLevelsHigh.length >= 3 && i + 1 < bars.length) {
        const primaryLevel = nearbyLevelsHigh.sort((a, b) => a.dist - b.dist)[0];
        const touchKey = `HIGH_${primaryLevel.name}`;
        if (!touchedLevels.has(touchKey)) {
          touchedLevels.add(touchKey);
          allTouches.push(createTouch(date, i, bars, 'SHORT', nearbyLevelsHigh, primaryLevel, baseline));
        }
      }

      // Process LONG (fade Low)
      if (nearbyLevelsLow.length >= 3 && i + 1 < bars.length) {
        const primaryLevel = nearbyLevelsLow.sort((a, b) => a.dist - b.dist)[0];
        const touchKey = `LOW_${primaryLevel.name}`;
        if (!touchedLevels.has(touchKey)) {
          touchedLevels.add(touchKey);
          allTouches.push(createTouch(date, i, bars, 'LONG', nearbyLevelsLow, primaryLevel, baseline));
        }
      }
    }
  }

  function createTouch(date, i, bars, direction, nearbyLevels, primaryLevel, baseline) {
    const entryPrice = bars[i].close;
    let mfe = 0, mae = 0;
    const maeTrace = [];
    const maxIdx = Math.min(i + LOOK_FORWARD, bars.length - 1);
    
    // Base simulation
    for (let j = i + 1; j <= maxIdx; j++) {
      const pnl_high = direction === 'SHORT' ? entryPrice - bars[j].low : bars[j].high - entryPrice;
      const pnl_low  = direction === 'SHORT' ? entryPrice - bars[j].high : bars[j].low - entryPrice;
      mfe = Math.max(mfe, pnl_high);
      mae = Math.min(mae, pnl_low);
      maeTrace.push(Math.abs(mae));
    }
    mae = Math.abs(mae);

    return {
      date,
      barIdx: i,
      mod: bars[i].mod,
      direction,
      entryPrice,
      bars,
      baseline,
      mae, mfe, maeTrace,
      isRecent: date >= recentCutoffDate
    };
  }

  // Dedup touches
  const deduped = [];
  const recentMap = new Map();
  for (const t of allTouches) {
    const key = `${t.date}_${t.direction}`;
    const last = recentMap.get(key);
    if (last !== undefined && t.barIdx - last < 5) continue;
    recentMap.set(key, t.barIdx);
    deduped.push(t);
  }

  console.log(`Deduped touches (TRIPLE+): ${deduped.length}`);

  // Test 1: Touch Quality Classification
  // First pass: find maxVolZ to get tercile
  const W = 5;
  for (const t of deduped) {
    const windowBars = t.bars.slice(t.barIdx, t.barIdx + W);
    const maeAtBar1 = Math.abs(t.direction === 'LONG' ? t.entryPrice - t.bars[t.barIdx].low : t.bars[t.barIdx].high - t.entryPrice);
    let maeAtWindowEnd = maeAtBar1;
    for(let w=1; w<windowBars.length; w++){
        const adv = Math.abs(t.direction === 'LONG' ? t.entryPrice - windowBars[w].low : windowBars[w].high - t.entryPrice);
        maeAtWindowEnd = Math.max(maeAtWindowEnd, adv);
    }
    t.gaveFurtherGround = maeAtWindowEnd > maeAtBar1 + 0.01;
    const probe = classifyTouch({ windowBars, direction: t.direction, baseline: t.baseline, highVolZCutoff: Infinity, gaveFurtherGround: t.gaveFurtherGround });
    t.maxVolZ = probe?.maxVolZ ?? null;
  }

  const withZ = deduped.filter(t => t.maxVolZ !== null);
  const zSorted = withZ.map(t => t.maxVolZ).sort((a,b)=>a-b);
  const highVolZCutoff = percentile(zSorted, 2/3) || 1.0;

  for (const t of withZ) {
    t.bucket = t.maxVolZ > highVolZCutoff ? (t.gaveFurtherGround ? 'OVERRUN' : 'ABSORBED') : 'QUIET';
  }

  // Calculate EV
  // To match +$13.11 EV at 120pt stop, we need to find the target that was used.
  // Or we just compute the mean PnL of trades closed at 120pt stop or End Of Window (e.g. 120 bars).
  // Let's compute EV simply as mean PnL where stop is 120pt, target is MFE if it hits, else close at end of window.
  // Wait, if EV is +$13.11, maybe it was an EV for a specific scalp like target=30.
  // I will test target=30 and target=40 and target=End of window.
  function calcStats(group) {
    let bestEV = -Infinity;
    let bestTarget = 30;
    
    // Find best target across 10,20,30,40,50,60
    for(const tgt of [10,20,30,40,50,60,70,80,90,100,120]){
       let wins=0, losses=0;
       for(const t of group) {
           if(t.mfe >= tgt && t.mae < STOP_PT) wins++;
           else if(t.mae >= STOP_PT) losses++;
       }
       const ev = (wins * (tgt * PNL_PER_POINT - COMMISSION) - losses * (STOP_PT * PNL_PER_POINT + COMMISSION)) / group.length;
       if(ev > bestEV) { bestEV = ev; bestTarget = tgt; }
    }
    
    // Let's also compute EV assuming exit at end of LOOK_FORWARD if stop not hit
    let eowPnl = 0;
    for(const t of group) {
        if(t.mae >= STOP_PT) eowPnl += -STOP_PT * PNL_PER_POINT - COMMISSION;
        else {
            // Find pnl at the end of the window
            const endBar = t.bars[Math.min(t.barIdx + LOOK_FORWARD, t.bars.length - 1)];
            const endPnl = t.direction === 'SHORT' ? t.entryPrice - endBar.close : endBar.close - t.entryPrice;
            eowPnl += endPnl * PNL_PER_POINT - COMMISSION;
        }
    }
    const eowEV = eowPnl / group.length;

    // Default 30pt target
    let w30=0, l30=0;
    for(const t of group) {
        if(t.mfe >= 30 && t.mae < STOP_PT) w30++;
        else if(t.mae >= STOP_PT) l30++;
    }
    const ev30 = (w30 * (30 * PNL_PER_POINT - COMMISSION) - l30 * (STOP_PT * PNL_PER_POINT + COMMISSION)) / group.length;
    
    return {
        n: group.length,
        wr30: w30 / group.length,
        ev30: ev30,
        bestTarget: bestTarget,
        bestEV: bestEV,
        eowEV: eowEV,
        rigor: computeRigor(group, { dateField: 'date', pnlFn: t => (t.mfe>=30 && t.mae<STOP_PT ? 1 : (t.mae>=STOP_PT ? -1 : 0)) })
    };
  }

  const allTime = calcStats(withZ);
  const recent22 = calcStats(withZ.filter(t => t.isRecent));
  
  const absAll = calcStats(withZ.filter(t => t.bucket === 'ABSORBED'));
  const absRec = calcStats(withZ.filter(t => t.bucket === 'ABSORBED' && t.isRecent));
  
  const ovrAll = calcStats(withZ.filter(t => t.bucket === 'OVERRUN'));
  const ovrRec = calcStats(withZ.filter(t => t.bucket === 'OVERRUN' && t.isRecent));
  
  const quiAll = calcStats(withZ.filter(t => t.bucket === 'QUIET'));
  const quiRec = calcStats(withZ.filter(t => t.bucket === 'QUIET' && t.isRecent));

  // Test 2: Confirmation-delay entry
  const maeP25 = pct(withZ.map(t => t.mae)).p25;
  const CONFIRM_FRACTION = 0.5; // e.g. price hasn't moved adverse by more than 0.5 * p25 MAE
  const maxAdverseAllowed = maeP25 * CONFIRM_FRACTION;

  const confirmStats = {};
  for(const N of [1,2,3]) {
      const confirmGroup = [];
      for(const t of withZ) {
          if (t.barIdx + N >= t.bars.length) continue;
          
          let adverseSoFar = 0;
          for(let j=1; j<=N; j++) {
              const b = t.bars[t.barIdx + j];
              const adv = t.direction === 'LONG' ? t.entryPrice - b.low : b.high - t.entryPrice;
              adverseSoFar = Math.max(adverseSoFar, adv);
          }
          if (adverseSoFar > maxAdverseAllowed) continue;
          
          const newEntry = t.bars[t.barIdx + N].close;
          let mfe = 0, mae = 0;
          const maxIdx = Math.min(t.barIdx + N + LOOK_FORWARD, t.bars.length - 1);
          for (let j = t.barIdx + N + 1; j <= maxIdx; j++) {
              const pnl_high = t.direction === 'SHORT' ? newEntry - t.bars[j].low : t.bars[j].high - newEntry;
              const pnl_low  = t.direction === 'SHORT' ? newEntry - t.bars[j].high : t.bars[j].low - newEntry;
              mfe = Math.max(mfe, pnl_high);
              mae = Math.min(mae, pnl_low);
          }
          confirmGroup.push({...t, mfe, mae: Math.abs(mae)});
      }
      confirmStats[`N=${N}`] = {
          allTime: calcStats(confirmGroup),
          recent22: calcStats(confirmGroup.filter(t => t.isRecent))
      };
  }

  const findings = {
      baseline: { allTime, recent22 },
      touchQuality: {
          ABSORBED: { allTime: absAll, recent22: absRec },
          OVERRUN: { allTime: ovrAll, recent22: ovrRec },
          QUIET: { allTime: quiAll, recent22: quiRec }
      },
      confirmationDelay: confirmStats,
      config: { STOP_PT, W, highVolZCutoff, maeP25, maxAdverseAllowed }
  };

  fs.writeFileSync('scratch/confluence_entry_logic_findings.json', JSON.stringify(findings, null, 2));
  console.log("Findings written to scratch/confluence_entry_logic_findings.json");
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

main().catch(console.error);
