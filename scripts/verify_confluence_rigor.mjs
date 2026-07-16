import fs from 'fs';
import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import * as ss from 'simple-statistics';

const PNL_PER_POINT = 2;
const COMMISSION = 1;
const WINDOW_DAYS = 180;
const LOOK_FORWARD = 30;

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

function getFormationGate(levelName) {
  if (['OR_HIGH', 'OR_LOW'].includes(levelName)) return 575;
  if (['IB_HIGH', 'IB_LOW', 'IB_MID', 'OR_MID', 'PD_IB_HIGH', 'PD_IB_LOW'].includes(levelName)) return 630;
  return 570;
}

async function run() {
  console.log('Fetching trading days...');
  const daysRes = await query(`
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
  const tradingDays = daysRes.rows.map(r => r.trade_date).sort();

  console.log('Fetching acd_daily_log day_types...');
  const dayTypeRes = await query(`SELECT trade_date::text as trade_date, day_type FROM acd_daily_log WHERE day_type IS NOT NULL`);
  const dayTypes = {};
  for (const r of dayTypeRes.rows) dayTypes[r.trade_date] = r.day_type;

  console.log('Fetching active setups...');
  const res = await query(`
    SELECT id, trade_date::text as trade_date, setup_type, fired_at, actual_pnl::float as actual_pnl 
    FROM active_setups 
    WHERE (setup_type LIKE '%_FADE_LONG' OR setup_type LIKE '%_FADE_SHORT')
      AND actual_pnl IS NOT NULL
      AND resolution IN ('WIN', 'LOSS', 'STOP_HIT', 'TARGET_HIT')
  `);
  const setupsByDate = {};
  for (const s of res.rows) {
    if (!setupsByDate[s.trade_date]) setupsByDate[s.trade_date] = [];
    setupsByDate[s.trade_date].push(s);
  }

  const rawCandidates = JSON.parse(fs.readFileSync('scratch/rotation_sizing_candidates.json', 'utf8'));
  const top15Candidates = rawCandidates.sort((a, b) => b.deltaEV - a.deltaEV).slice(0, 15);

  const proximities = [10, 15, 20];
  const allTouches = { 10: [], 15: [], 20: [] };
  
  // Results for rotation sizing (Check 2 & 3)
  // candidates[prox][candIdx][dayType] -> { base: [], cond: [] }
  const candResults = { 10: [], 15: [], 20: [] };
  for (const prox of proximities) {
    candResults[prox] = top15Candidates.map(() => ({}));
  }

  for (let di = 0; di < tradingDays.length; di++) {
    const date = tradingDays[di];
    if (di % 30 === 0) console.log(`Processing day ${di + 1}/${tradingDays.length}: ${date}`);

    const [levelPricesRes, barsRes] = await Promise.all([
      query(`SELECT level_name, price::float FROM level_prices WHERE trade_date = $1 AND price IS NOT NULL`, [date]),
      query(`
        SELECT ts, EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) as tod,
               open::float, high::float, low::float, close::float,
               volume::int, bid_volume::int, ask_volume::int
        FROM price_bars_primary
        WHERE ts::date = $1 AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
        ORDER BY ts
      `, [date])
    ]);

    const levelPrices = {};
    for (const row of levelPricesRes.rows) levelPrices[row.level_name] = row.price;
    const bars = barsRes.rows;

    if (Object.keys(levelPrices).length < 5 || bars.length < 60) continue;

    const { RTH_VWAP: _excluded, ...staticLevels } = levelPrices;

    for (const prox of proximities) {
      // 1. Process setups for rotation sizing check
      const setupsToday = setupsByDate[date] || [];
      for (const setup of setupsToday) {
        const setupLevelBase = setup.setup_type.replace('_FADE_LONG', '').replace('_FADE_SHORT', '');
        const priorTouches = new Set();

        for (const bar of bars) {
          if (new Date(bar.ts).getTime() >= new Date(setup.fired_at).getTime()) break;
          const tod = bar.tod;
          for (const [name, level] of Object.entries(levelPrices)) {
            if (level == null || !isFinite(level) || tod < getFormationGate(name) || name === setupLevelBase) continue;
            if (Math.abs(bar.high - level) <= prox && bar.high >= level) priorTouches.add(`${name}_SHORT`);
            if (Math.abs(bar.low - level) <= prox && bar.low <= level) priorTouches.add(`${name}_LONG`);
          }
        }

        // Apply 10:30 ET gate for day_type
        const setupTod = new Date(setup.fired_at).getUTCHours() * 60 + new Date(setup.fired_at).getUTCMinutes() - 240; // Approx EST
        // More robust: use bar TOD from the bar before fired_at
        let actualTod = 0;
        for (const bar of bars) {
            if (new Date(bar.ts).getTime() >= new Date(setup.fired_at).getTime()) break;
            actualTod = bar.tod;
        }

        if (actualTod >= 630 && dayTypes[date]) {
          const dType = dayTypes[date];
          for (let ci = 0; ci < top15Candidates.length; ci++) {
            const cand = top15Candidates[ci];
            if (setup.setup_type === cand.setupType) {
              if (!candResults[prox][ci][dType]) candResults[prox][ci][dType] = { base: [], cond: [] };
              const pnl = setup.actual_pnl;
              candResults[prox][ci][dType].base.push({ date, pnl });
              if (priorTouches.has(cand.priorKey)) {
                candResults[prox][ci][dType].cond.push({ date, pnl });
              }
            }
          }
        }
      }

      // 2. Process touches for confluence check
      const touchedLevels = new Set();
      let devHigh = -Infinity, devLow = Infinity;

      for (let i = 0; i < bars.length; i++) {
        const bar = bars[i];
        const pastIB = bar.tod >= 630;
        const availableLevels = { ...staticLevels };
        if (!pastIB) {
          delete availableLevels.IB_HIGH; delete availableLevels.IB_LOW; delete availableLevels.IB_MID;
        }
        availableLevels.VWAP = computeVWAP(bars, i);
        if (i % 10 === 0 || i === bars.length - 1) availableLevels.DEV_POC = computeDevelopingPOC(bars, i);

        const nearbyLevelsHigh = [];
        const nearbyLevelsLow  = [];

        for (const [name, level] of Object.entries(availableLevels)) {
          if (level == null || !isFinite(level)) continue;
          const distToHigh = Math.abs(bar.high - level);
          const distToLow  = Math.abs(bar.low - level);
          if (distToHigh <= prox && bar.high >= level) nearbyLevelsHigh.push({ name, level, dist: distToHigh });
          if (distToLow <= prox && bar.low <= level) nearbyLevelsLow.push({ name, level, dist: distToLow });
        }

        if (nearbyLevelsHigh.length > 0 && i + LOOK_FORWARD < bars.length) {
          const confluenceCount = nearbyLevelsHigh.length;
          const entryPrice = bar.close;
          let mfe = 0, mae = 0;
          for (let j = i + 1; j <= Math.min(i + LOOK_FORWARD, bars.length - 1); j++) {
            mfe = Math.max(mfe, entryPrice - bars[j].low);
            mae = Math.min(mae, entryPrice - bars[j].high);
          }
          mae = Math.abs(mae);
          allTouches[prox].push({ date, barIdx: i, direction: 'SHORT', confluenceCount, nearbyLevelNames: nearbyLevelsHigh.map(l => l.name).sort(), mae, mfe });
        }

        if (nearbyLevelsLow.length > 0 && i + LOOK_FORWARD < bars.length) {
          const confluenceCount = nearbyLevelsLow.length;
          const entryPrice = bar.close;
          let mfe = 0, mae = 0;
          for (let j = i + 1; j <= Math.min(i + LOOK_FORWARD, bars.length - 1); j++) {
            mfe = Math.max(mfe, bars[j].high - entryPrice);
            mae = Math.min(mae, bars[j].low - entryPrice);
          }
          mae = Math.abs(mae);
          allTouches[prox].push({ date, barIdx: i, direction: 'LONG', confluenceCount, nearbyLevelNames: nearbyLevelsLow.map(l => l.name).sort(), mae, mfe });
        }
      }
    }
  }

  const results = { checks: [] };

  // --- CHECK 1 & 3 (Confluence Tiers & Parameter Sensitivity) ---
  const confluenceResults = {};
  for (const prox of proximities) {
    const deduped = [];
    const recentTouches = new Map();
    for (const t of allTouches[prox]) {
      const key = `${t.date}_${t.direction}_${t.nearbyLevelNames.join('+')}`;
      const last = recentTouches.get(key);
      if (last !== undefined && t.barIdx - last < 5) continue;
      recentTouches.set(key, t.barIdx);
      deduped.push(t);
    }

    const tiers = {
      SINGLE: deduped.filter(t => t.confluenceCount === 1),
      DOUBLE: deduped.filter(t => t.confluenceCount === 2),
      TRIPLE: deduped.filter(t => t.confluenceCount === 3),
      QUAD_PLUS: deduped.filter(t => t.confluenceCount >= 4),
    };

    confluenceResults[prox] = {};
    for (const [tierName, touches] of Object.entries(tiers)) {
      confluenceResults[prox][tierName] = {};
      for (const stop of [60, 90, 120]) {
        const events = touches.map(t => {
          const w = t.mfe >= 30 && t.mae < stop;
          const l = t.mae >= stop;
          const pnl = w ? (30 * PNL_PER_POINT - COMMISSION) : (l ? -(stop * PNL_PER_POINT + COMMISSION) : 0);
          return { date: t.date, pnl, mfe: t.mfe, mae: t.mae };
        });
        
        // Remove 0 pnl (no trigger) if desired, but script counts them as length denominator.
        // Wait, backtest_confluence uses group.length for EV denominator.
        // computeRigor uses events.length. So we keep all.
        const rigor = computeRigor(events, { dateField: 'date', pnlFn: e => e.pnl });
        
        const wCount = events.filter(e => e.pnl > 0).length;
        const lCount = events.filter(e => e.pnl < 0).length;
        const ev = events.reduce((s, e) => s + e.pnl, 0) / (events.length || 1);
        
        confluenceResults[prox][tierName][stop] = { n: events.length, wr: wCount / (events.length || 1), ev, rigor };
      }
    }
  }

  // --- CHECK 2 & 3 (Rotation Sizing Day-Type Control) ---
  const rotationResults = {};
  for (const prox of proximities) {
    rotationResults[prox] = [];
    for (let ci = 0; ci < top15Candidates.length; ci++) {
      const cand = top15Candidates[ci];
      const dtRes = candResults[prox][ci];
      const byDayType = {};
      
      let totalBaseEV = 0, totalBaseN = 0;
      let totalCondEV = 0, totalCondN = 0;

      for (const [dt, data] of Object.entries(dtRes)) {
        const baseEV = data.base.reduce((s, x) => s + x.pnl, 0) / (data.base.length || 1);
        const condEV = data.cond.reduce((s, x) => s + x.pnl, 0) / (data.cond.length || 1);
        byDayType[dt] = {
          baseN: data.base.length, baseEV,
          condN: data.cond.length, condEV,
          lift: condEV - baseEV
        };
        totalBaseEV += data.base.reduce((s, x) => s + x.pnl, 0);
        totalBaseN += data.base.length;
        totalCondEV += data.cond.reduce((s, x) => s + x.pnl, 0);
        totalCondN += data.cond.length;
      }
      
      rotationResults[prox].push({
        setupType: cand.setupType,
        priorKey: cand.priorKey,
        baseN: totalBaseN, baseEV: totalBaseN ? totalBaseEV / totalBaseN : 0,
        condN: totalCondN, condEV: totalCondN ? totalCondEV / totalCondN : 0,
        byDayType
      });
    }
  }

  results.confluence = confluenceResults;
  results.rotation = rotationResults;

  fs.writeFileSync('scratch/verification_findings.json', JSON.stringify(results, null, 2));
  console.log('Done, wrote verification_findings.json');
}

run().catch(console.error);
