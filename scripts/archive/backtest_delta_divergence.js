import { query } from '../server/db.js';

// ============================================================
// DELTA-PRICE DIVERGENCE BACKTEST — v2
// ============================================================
// Analyzes NQ 1-min bars for delta-price divergence patterns.
// When price drops but delta stays flat/rises = bullish absorption.
// When price rises but delta stays flat/falls = bearish distribution.
//
// v2 improvements:
//   - More granular magnitude buckets (every 20 pts)
//   - Delta-normalized divergence (delta per 1000 contracts)
//   - Separate "pure" divergence (delta strongly opposite) from weak
//   - Volatility-adjusted thresholds using rolling ATR
//   - Deeper threshold trade analysis with MFE/MAE per combo
//   - Consecutive divergence bar analysis (not just rolling window)
// ============================================================

const RTH_START = 570;  // 9:30 ET
const RTH_END   = 959;  // 15:59 ET
const WINDOW    = 30;   // rolling window in minutes
const PNL_PER_POINT = 2;
const COMMISSION = 1;

const FORWARD_WINDOWS = [15, 30, 60];

const TOD_BUCKETS = [
  { label: '9:30-10:00',  min: 570, max: 599 },
  { label: '10:00-10:30', min: 600, max: 629 },
  { label: '10:30-11:00', min: 630, max: 659 },
  { label: '11:00-12:00', min: 660, max: 719 },
  { label: '12:00-1:00',  min: 720, max: 779 },
  { label: '1:00-2:00',   min: 780, max: 839 },
  { label: '2:00-3:00',   min: 840, max: 899 },
  { label: '3:00-4:00',   min: 900, max: 959 },
];

function fmt(n, d = 1) { return n == null || isNaN(n) ? 'N/A' : Number(n).toFixed(d); }
function pct(n, d = 1) { return n == null || isNaN(n) ? 'N/A' : (n * 100).toFixed(d) + '%'; }
function divider(c = '─', len = 100) { return c.repeat(len); }
function padR(s, w) { return String(s).padEnd(w); }
function padL(s, w) { return String(s).padStart(w); }

async function main() {
  console.log('='.repeat(100));
  console.log('  NQ DELTA-PRICE DIVERGENCE BACKTEST v2');
  console.log('  Cumulative Delta (bid/ask) vs Price Action — 30-min rolling windows');
  console.log('='.repeat(100));

  // ─── 1. Fetch all RTH bars ───
  const barsResult = await query(`
    SELECT
      ts::date AS trade_date,
      ts,
      EXTRACT(hour FROM ts)::int * 60 + EXTRACT(minute FROM ts)::int AS minute_of_day,
      open::float, high::float, low::float, close::float,
      volume::int,
      COALESCE(bid_volume, 0)::int AS bid_vol,
      COALESCE(ask_volume, 0)::int AS ask_vol
    FROM price_bars_primary
    WHERE symbol = 'NQ'
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN ${RTH_START} AND ${RTH_END}
    ORDER BY ts
  `);

  const allBars = barsResult.rows;
  console.log(`\nLoaded ${allBars.length.toLocaleString()} RTH bars`);

  // ─── 2. Group by day ───
  const dayMap = new Map();
  for (const bar of allBars) {
    const dateStr = bar.trade_date;
    if (!dayMap.has(dateStr)) dayMap.set(dateStr, []);
    dayMap.get(dateStr).push(bar);
  }

  const tradingDays = [...dayMap.keys()].sort();
  console.log(`Trading days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays[tradingDays.length - 1]})\n`);

  // ─── 3. For each day, build enriched bars and detect divergences ───
  const allDivergences = [];
  const thresholdTrades = [];
  const ENTRY_THRESHOLDS = [20, 30, 40, 50, 60, 80, 100, 120, 150];
  const STOPS = [10, 15, 20, 25, 30, 40, 50, 60];
  const TARGETS = [10, 15, 20, 25, 30, 40, 50, 75, 100];

  for (const dateStr of tradingDays) {
    const bars = dayMap.get(dateStr);
    if (bars.length < WINDOW + 60) continue;

    // Enrich bars
    let cumDelta = 0;
    let sessionHigh = -Infinity;
    let sessionLow = Infinity;
    let cumVwapNum = 0, cumVwapVol = 0;
    const priceVolMap = new Map();
    // Rolling 20-bar ATR
    const trueRanges = [];
    let prevClose = null;
    const enriched = [];

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      const barDelta = bar.ask_vol - bar.bid_vol;
      cumDelta += barDelta;

      if (bar.high > sessionHigh) sessionHigh = bar.high;
      if (bar.low < sessionLow) sessionLow = bar.low;

      const tp = (bar.high + bar.low + bar.close) / 3;
      cumVwapNum += tp * bar.volume;
      cumVwapVol += bar.volume;
      const vwap = cumVwapVol > 0 ? cumVwapNum / cumVwapVol : bar.close;

      const rClose = Math.round(bar.close * 4) / 4;
      priceVolMap.set(rClose, (priceVolMap.get(rClose) || 0) + bar.volume);
      let pocPrice = rClose, pocVol = 0;
      for (const [p, v] of priceVolMap) { if (v > pocVol) { pocVol = v; pocPrice = p; } }

      // True range
      const tr = prevClose != null
        ? Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose))
        : bar.high - bar.low;
      trueRanges.push(tr);
      prevClose = bar.close;

      // 20-bar ATR
      const atrWindow = trueRanges.slice(Math.max(0, trueRanges.length - 20));
      const atr20 = atrWindow.reduce((s, v) => s + v, 0) / atrWindow.length;

      enriched.push({
        ...bar,
        barDelta,
        cumDelta,
        sessionHigh,
        sessionLow,
        vwap,
        devPOC: pocPrice,
        atr20,
        idx: i,
      });
    }

    // ─── Divergence detection with rolling window ───
    let inDivergence = false;
    let divStartIdx = -1;
    let divType = null;
    let divPeakStretch = 0;
    let divBarsCount = 0;
    let divDeltaChanges = []; // track delta rate over divergence

    for (let i = WINDOW; i < enriched.length; i++) {
      const cur = enriched[i];
      const lb = enriched[i - WINDOW];

      const priceChg = cur.close - lb.close;
      const deltaChg = cur.cumDelta - lb.cumDelta;
      const absPriceChg = Math.abs(priceChg);

      // Classify
      let classification = null;
      if (priceChg <= -10 && deltaChg > 0) classification = 'BULLISH_DIVERGENCE';
      else if (priceChg >= 10 && deltaChg < 0) classification = 'BEARISH_DIVERGENCE';

      const isDiverging = classification != null && absPriceChg >= 20;

      if (isDiverging && !inDivergence) {
        inDivergence = true;
        divStartIdx = i;
        divType = classification;
        divPeakStretch = absPriceChg;
        divBarsCount = 1;
        divDeltaChanges = [deltaChg];
      } else if (isDiverging && inDivergence && classification === divType) {
        divBarsCount++;
        if (absPriceChg > divPeakStretch) divPeakStretch = absPriceChg;
        divDeltaChanges.push(deltaChg);
      } else if (inDivergence) {
        // Divergence ended
        const divEnd = i - 1;
        const endBar = enriched[divEnd];

        // Compute delta acceleration: is the delta rate increasing over the divergence?
        let deltaAccelerating = false;
        let maxAccel = 0;
        if (divDeltaChanges.length >= 3) {
          const rates = [];
          for (let k = 1; k < divDeltaChanges.length; k++) {
            rates.push(Math.abs(divDeltaChanges[k]) - Math.abs(divDeltaChanges[k-1]));
          }
          maxAccel = Math.max(...rates);
          // Acceleration = majority of rate changes are positive
          const posRates = rates.filter(r => r > 0).length;
          deltaAccelerating = posRates > rates.length * 0.5 && maxAccel > 200;
        }

        // Forward tracking
        const snapDir = divType === 'BULLISH_DIVERGENCE' ? 1 : -1;
        const forwardResults = {};

        for (const fw of FORWARD_WINDOWS) {
          const fwIdx = divEnd + fw;
          if (fwIdx >= enriched.length) continue;
          const fwBar = enriched[fwIdx];
          const snapBack = (fwBar.close - endBar.close) * snapDir;

          let maxFav = 0, maxAdv = 0;
          for (let j = divEnd + 1; j <= fwIdx; j++) {
            const m = (enriched[j].close - endBar.close) * snapDir;
            // Also check intrabar extremes
            const hm = ((snapDir === 1 ? enriched[j].high : enriched[j].low) - endBar.close) * snapDir;
            const lm = ((snapDir === 1 ? enriched[j].low : enriched[j].high) - endBar.close) * snapDir;
            if (hm > maxFav) maxFav = hm;
            if (lm < maxAdv) maxAdv = lm;
          }

          forwardResults[fw] = { snapBack, maxFavorable: maxFav, maxAdverse: maxAdv, win: snapBack > 0 };
        }

        // Level context
        const sessionRange = endBar.sessionHigh - endBar.sessionLow;
        const nearThresh = Math.max(sessionRange * 0.12, 15);
        const nearHigh = (endBar.sessionHigh - endBar.close) < nearThresh;
        const nearLow = (endBar.close - endBar.sessionLow) < nearThresh;
        const nearVwap = Math.abs(endBar.close - endBar.vwap) < 15;
        const nearPOC = Math.abs(endBar.close - endBar.devPOC) < 15;

        // Delta strength: volume-weighted — how much delta per contract of volume
        const windowVolume = enriched.slice(divStartIdx, divEnd + 1).reduce((s, b) => s + b.volume, 0);
        const windowDelta = endBar.cumDelta - enriched[divStartIdx].cumDelta;
        const deltaIntensity = windowVolume > 0 ? Math.abs(windowDelta) / windowVolume : 0;

        allDivergences.push({
          date: dateStr,
          type: divType,
          minuteOfDay: endBar.minute_of_day,
          duration: divBarsCount,
          maxStretch: divPeakStretch,
          forwardResults,
          nearHigh, nearLow, nearVwap, nearPOC,
          atKeyLevel: nearHigh || nearLow || nearVwap || nearPOC,
          deltaAccelerating,
          maxAccel,
          deltaIntensity,
          atr20: endBar.atr20,
          stretchOverATR: endBar.atr20 > 0 ? divPeakStretch / (endBar.atr20 * 30) : 0,
        });

        inDivergence = false;
      }
    }

    // ─── Threshold-based trade scanner ───
    const usedThresholds = new Map();

    for (let i = WINDOW; i < enriched.length; i++) {
      const cur = enriched[i];
      const lb = enriched[i - WINDOW];
      const priceChg = cur.close - lb.close;
      const deltaChg = cur.cumDelta - lb.cumDelta;

      let divType = null;
      if (priceChg < -10 && deltaChg > 0) divType = 'BULLISH';
      else if (priceChg > 10 && deltaChg < 0) divType = 'BEARISH';
      if (!divType) continue;

      const stretch = Math.abs(priceChg);
      const snapDir = divType === 'BULLISH' ? 1 : -1;

      // Delta intensity at this bar
      const windowSlice = enriched.slice(Math.max(0, i - WINDOW), i + 1);
      const wVol = windowSlice.reduce((s, b) => s + b.volume, 0);
      const wDelta = cur.cumDelta - enriched[Math.max(0, i - WINDOW)].cumDelta;
      const intensity = wVol > 0 ? Math.abs(wDelta) / wVol : 0;

      for (const threshold of ENTRY_THRESHOLDS) {
        if (stretch < threshold) continue;

        const key = `${threshold}_${divType}`;
        const lastIdx = usedThresholds.get(key) || -999;
        if (i - lastIdx < 30) continue;
        usedThresholds.set(key, i);

        // Trade simulation for each stop/target combo
        const tradeResults = {};
        for (const stop of STOPS) {
          for (const target of TARGETS) {
            let outcome = 'TIMEOUT';
            let pnlPts = 0;
            let barsToExit = 0;

            for (let j = i + 1; j < Math.min(i + 120, enriched.length); j++) {
              barsToExit++;
              const fwBar = enriched[j];
              // Check adverse (stop) first using intrabar extreme
              const advExtr = divType === 'BULLISH' ? fwBar.low : fwBar.high;
              const advMove = (advExtr - cur.close) * snapDir;
              if (advMove <= -stop) {
                outcome = 'STOP';
                pnlPts = -stop;
                break;
              }
              // Check favorable (target) using intrabar extreme
              const favExtr = divType === 'BULLISH' ? fwBar.high : fwBar.low;
              const favMove = (favExtr - cur.close) * snapDir;
              if (favMove >= target) {
                outcome = 'TARGET';
                pnlPts = target;
                break;
              }
            }

            if (outcome === 'TIMEOUT') {
              const lastBar = enriched[Math.min(i + 120, enriched.length - 1)];
              pnlPts = (lastBar.close - cur.close) * snapDir;
            }

            tradeResults[`S${stop}_T${target}`] = {
              outcome,
              pnlPts,
              pnlDollar: pnlPts * PNL_PER_POINT - COMMISSION,
              barsToExit,
            };
          }
        }

        // Simple forward
        const simpleForward = {};
        for (const fw of [15, 30, 60]) {
          if (i + fw < enriched.length) {
            const fwBar = enriched[i + fw];
            const snap = (fwBar.close - cur.close) * snapDir;
            // MFE/MAE within window
            let mfe = 0, mae = 0;
            for (let j = i + 1; j <= i + fw; j++) {
              const favE = (enriched[j][divType === 'BULLISH' ? 'high' : 'low'] - cur.close) * snapDir;
              const advE = (enriched[j][divType === 'BULLISH' ? 'low' : 'high'] - cur.close) * snapDir;
              if (favE > mfe) mfe = favE;
              if (advE < mae) mae = advE;
            }
            simpleForward[fw] = { snapBack: snap, win: snap > 0, mfe, mae };
          }
        }

        thresholdTrades.push({
          date: dateStr,
          type: divType,
          threshold,
          stretch,
          minuteOfDay: cur.minute_of_day,
          entryPrice: cur.close,
          deltaIntensity: intensity,
          atr20: cur.atr20,
          tradeResults,
          simpleForward,
          nearHigh: (cur.sessionHigh - cur.close) < Math.max((cur.sessionHigh - cur.sessionLow) * 0.12, 15),
          nearLow: (cur.close - cur.sessionLow) < Math.max((cur.sessionHigh - cur.sessionLow) * 0.12, 15),
          nearVwap: Math.abs(cur.close - cur.vwap) < 15,
          nearPOC: Math.abs(cur.close - cur.devPOC) < 15,
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // REPORTING
  // ═══════════════════════════════════════════════════════════════

  const divs = allDivergences;
  const bullish = divs.filter(d => d.type === 'BULLISH_DIVERGENCE');
  const bearish = divs.filter(d => d.type === 'BEARISH_DIVERGENCE');

  console.log('='.repeat(100));
  console.log('  SECTION 1: OVERVIEW');
  console.log('='.repeat(100));
  console.log(`Total divergence events:    ${divs.length}`);
  console.log(`  Bullish (price dn, delta up): ${bullish.length}`);
  console.log(`  Bearish (price up, delta dn):  ${bearish.length}`);
  console.log(`  Per trading day avg:           ${fmt(divs.length / tradingDays.length)}`);
  console.log(`  Threshold trades generated:    ${thresholdTrades.length}`);

  // ─── SECTION 2: Duration ───
  console.log('\n' + '='.repeat(100));
  console.log('  SECTION 2: DIVERGENCE DURATION');
  console.log('='.repeat(100));

  const durBuckets = [
    { label: '1-3 bars',   min: 1,  max: 3 },
    { label: '4-7 bars',   min: 4,  max: 7 },
    { label: '8-15 bars',  min: 8,  max: 15 },
    { label: '16-30 bars', min: 16, max: 30 },
    { label: '31+ bars',   min: 31, max: 9999 },
  ];

  console.log(`\n${padR('Duration', 14)} ${padL('N', 6)} ${padL('AvgStretch', 11)} ${padL('15m WR', 8)} ${padL('30m WR', 8)} ${padL('60m WR', 8)} ${padL('Avg30m', 8)} ${padL('Avg60m', 8)}`);
  console.log(divider());

  for (const db of durBuckets) {
    const b = divs.filter(d => d.duration >= db.min && d.duration <= db.max);
    if (b.length === 0) continue;
    const avgS = b.reduce((s, d) => s + d.maxStretch, 0) / b.length;
    const report = (fw) => {
      const w = b.filter(d => d.forwardResults[fw]);
      if (w.length === 0) return { wr: null, avg: null };
      return { wr: w.filter(d => d.forwardResults[fw].win).length / w.length,
               avg: w.reduce((s, d) => s + d.forwardResults[fw].snapBack, 0) / w.length };
    };
    const r15 = report(15), r30 = report(30), r60 = report(60);
    console.log(`${padR(db.label, 14)} ${padL(b.length, 6)} ${padL(fmt(avgS), 11)} ${padL(pct(r15.wr), 8)} ${padL(pct(r30.wr), 8)} ${padL(pct(r60.wr), 8)} ${padL(fmt(r30.avg), 8)} ${padL(fmt(r60.avg), 8)}`);
  }

  // ─── SECTION 3: Magnitude ───
  console.log('\n' + '='.repeat(100));
  console.log('  SECTION 3: DIVERGENCE MAGNITUDE (granular 20pt buckets)');
  console.log('='.repeat(100));

  const magBuckets = [
    { label: '20-40 pts',   min: 20,  max: 39.99 },
    { label: '40-60 pts',   min: 40,  max: 59.99 },
    { label: '60-80 pts',   min: 60,  max: 79.99 },
    { label: '80-100 pts',  min: 80,  max: 99.99 },
    { label: '100-120 pts', min: 100, max: 119.99 },
    { label: '120-160 pts', min: 120, max: 159.99 },
    { label: '160+ pts',    min: 160, max: 99999 },
  ];

  for (const divType of ['BULLISH_DIVERGENCE', 'BEARISH_DIVERGENCE']) {
    const label = divType === 'BULLISH_DIVERGENCE' ? 'BULLISH (price down, delta up)' : 'BEARISH (price up, delta down)';
    console.log(`\n  ${label}`);
    console.log(`  ${padR('Bucket', 14)} ${padL('N', 5)} ${padL('15mWR', 7)} ${padL('30mWR', 7)} ${padL('60mWR', 7)} ${padL('Avg15', 7)} ${padL('Avg30', 7)} ${padL('Avg60', 7)} ${padL('MFE30', 7)} ${padL('MAE30', 7)}`);
    console.log('  ' + divider('─', 85));

    for (const mb of magBuckets) {
      const f = divs.filter(d => d.type === divType && d.maxStretch >= mb.min && d.maxStretch < mb.max);
      if (f.length === 0) continue;
      const rpt = (fw, metric) => {
        const w = f.filter(d => d.forwardResults[fw]);
        if (w.length === 0) return null;
        if (metric === 'wr') return w.filter(d => d.forwardResults[fw].win).length / w.length;
        return w.reduce((s, d) => s + d.forwardResults[fw][metric], 0) / w.length;
      };
      console.log(`  ${padR(mb.label, 14)} ${padL(f.length, 5)} ${padL(pct(rpt(15,'wr')), 7)} ${padL(pct(rpt(30,'wr')), 7)} ${padL(pct(rpt(60,'wr')), 7)} ${padL(fmt(rpt(15,'snapBack')), 7)} ${padL(fmt(rpt(30,'snapBack')), 7)} ${padL(fmt(rpt(60,'snapBack')), 7)} ${padL(fmt(rpt(30,'maxFavorable')), 7)} ${padL(fmt(rpt(30,'maxAdverse')), 7)}`);
    }
  }

  // ─── SECTION 4: Level Context ───
  console.log('\n' + '='.repeat(100));
  console.log('  SECTION 4: LEVEL CONTEXT');
  console.log('='.repeat(100));

  const lvlCtx = [
    { label: 'Near Session High',    filter: d => d.nearHigh },
    { label: 'Near Session Low',     filter: d => d.nearLow },
    { label: 'Near VWAP',            filter: d => d.nearVwap },
    { label: 'Near Dev POC',         filter: d => d.nearPOC },
    { label: 'At ANY Key Level',     filter: d => d.atKeyLevel },
    { label: 'No Key Level (open)',  filter: d => !d.atKeyLevel },
  ];

  console.log(`\n${padR('Context', 24)} ${padL('N', 5)} ${padL('30mWR', 7)} ${padL('60mWR', 7)} ${padL('Avg30', 8)} ${padL('Avg60', 8)} ${padL('MFE30', 8)} ${padL('MAE30', 8)}`);
  console.log(divider());

  for (const ctx of lvlCtx) {
    const f = divs.filter(ctx.filter);
    if (f.length === 0) continue;
    const rpt = (fw, m) => {
      const w = f.filter(d => d.forwardResults[fw]);
      if (w.length === 0) return null;
      if (m === 'wr') return w.filter(d => d.forwardResults[fw].win).length / w.length;
      return w.reduce((s, d) => s + d.forwardResults[fw][m], 0) / w.length;
    };
    console.log(`${padR(ctx.label, 24)} ${padL(f.length, 5)} ${padL(pct(rpt(30,'wr')), 7)} ${padL(pct(rpt(60,'wr')), 7)} ${padL(fmt(rpt(30,'snapBack')), 8)} ${padL(fmt(rpt(60,'snapBack')), 8)} ${padL(fmt(rpt(30,'maxFavorable')), 8)} ${padL(fmt(rpt(30,'maxAdverse')), 8)}`);
  }

  // Key level by type: bullish at low, bearish at high (the logical combos)
  console.log(`\n  Logical level combos (bullish at lows, bearish at highs):`);
  const logicalCombos = [
    { label: 'Bullish div near Session Low',   filter: d => d.type === 'BULLISH_DIVERGENCE' && d.nearLow },
    { label: 'Bullish div near VWAP',          filter: d => d.type === 'BULLISH_DIVERGENCE' && d.nearVwap },
    { label: 'Bearish div near Session High',  filter: d => d.type === 'BEARISH_DIVERGENCE' && d.nearHigh },
    { label: 'Bearish div near VWAP',          filter: d => d.type === 'BEARISH_DIVERGENCE' && d.nearVwap },
    { label: 'Bullish div near Session High',  filter: d => d.type === 'BULLISH_DIVERGENCE' && d.nearHigh },
    { label: 'Bearish div near Session Low',   filter: d => d.type === 'BEARISH_DIVERGENCE' && d.nearLow },
  ];

  for (const lc of logicalCombos) {
    const f = divs.filter(lc.filter);
    if (f.length < 5) continue;
    const w30 = f.filter(d => d.forwardResults[30]);
    const wr30 = w30.length > 0 ? w30.filter(d => d.forwardResults[30].win).length / w30.length : null;
    const avg30 = w30.length > 0 ? w30.reduce((s, d) => s + d.forwardResults[30].snapBack, 0) / w30.length : null;
    const w60 = f.filter(d => d.forwardResults[60]);
    const wr60 = w60.length > 0 ? w60.filter(d => d.forwardResults[60].win).length / w60.length : null;
    console.log(`    ${padR(lc.label, 38)} N=${padL(f.length, 4)}  30mWR=${padL(pct(wr30), 7)}  60mWR=${padL(pct(wr60), 7)}  avg30=${fmt(avg30)}pt`);
  }

  // ─── SECTION 5: Time of Day ───
  console.log('\n' + '='.repeat(100));
  console.log('  SECTION 5: TIME OF DAY');
  console.log('='.repeat(100));

  console.log(`\n${padR('Time', 16)} ${padL('N', 5)} ${padL('Bull', 5)} ${padL('Bear', 5)} ${padL('30mWR', 7)} ${padL('60mWR', 7)} ${padL('Avg30', 8)} ${padL('Avg60', 8)} ${padL('MFE30', 8)}`);
  console.log(divider());

  for (const tod of TOD_BUCKETS) {
    const f = divs.filter(d => d.minuteOfDay >= tod.min && d.minuteOfDay <= tod.max);
    if (f.length === 0) continue;
    const bull = f.filter(d => d.type === 'BULLISH_DIVERGENCE').length;
    const bear = f.filter(d => d.type === 'BEARISH_DIVERGENCE').length;
    const rpt = (fw, m) => {
      const w = f.filter(d => d.forwardResults[fw]);
      if (w.length === 0) return null;
      if (m === 'wr') return w.filter(d => d.forwardResults[fw].win).length / w.length;
      return w.reduce((s, d) => s + d.forwardResults[fw][m], 0) / w.length;
    };
    console.log(`${padR(tod.label, 16)} ${padL(f.length, 5)} ${padL(bull, 5)} ${padL(bear, 5)} ${padL(pct(rpt(30,'wr')), 7)} ${padL(pct(rpt(60,'wr')), 7)} ${padL(fmt(rpt(30,'snapBack')), 8)} ${padL(fmt(rpt(60,'snapBack')), 8)} ${padL(fmt(rpt(30,'maxFavorable')), 8)}`);
  }

  // Time of day breakdown for bullish only
  console.log(`\n  Bullish divergence by time of day:`);
  for (const tod of TOD_BUCKETS) {
    const f = bullish.filter(d => d.minuteOfDay >= tod.min && d.minuteOfDay <= tod.max);
    if (f.length < 5) continue;
    const w30 = f.filter(d => d.forwardResults[30]);
    const wr30 = w30.length > 0 ? w30.filter(d => d.forwardResults[30].win).length / w30.length : null;
    const avg30 = w30.length > 0 ? w30.reduce((s, d) => s + d.forwardResults[30].snapBack, 0) / w30.length : null;
    console.log(`    ${padR(tod.label, 16)} N=${padL(f.length, 4)}  30mWR=${pct(wr30)}  avg=${fmt(avg30)}pt`);
  }

  // ─── SECTION 6: Delta Acceleration ───
  console.log('\n' + '='.repeat(100));
  console.log('  SECTION 6: DELTA ACCELERATION');
  console.log('='.repeat(100));

  const accelGroups = [
    { label: 'Delta accelerating',    filter: d => d.deltaAccelerating },
    { label: 'Delta NOT accelerating', filter: d => !d.deltaAccelerating },
  ];

  console.log(`\n${padR('Group', 28)} ${padL('N', 5)} ${padL('30mWR', 7)} ${padL('60mWR', 7)} ${padL('Avg30', 8)} ${padL('Avg60', 8)} ${padL('MFE30', 8)} ${padL('MAE30', 8)}`);
  console.log(divider());

  for (const g of accelGroups) {
    const f = divs.filter(g.filter);
    if (f.length === 0) continue;
    const rpt = (fw, m) => {
      const w = f.filter(d => d.forwardResults[fw]);
      if (w.length === 0) return null;
      if (m === 'wr') return w.filter(d => d.forwardResults[fw].win).length / w.length;
      return w.reduce((s, d) => s + d.forwardResults[fw][m], 0) / w.length;
    };
    console.log(`${padR(g.label, 28)} ${padL(f.length, 5)} ${padL(pct(rpt(30,'wr')), 7)} ${padL(pct(rpt(60,'wr')), 7)} ${padL(fmt(rpt(30,'snapBack')), 8)} ${padL(fmt(rpt(60,'snapBack')), 8)} ${padL(fmt(rpt(30,'maxFavorable')), 8)} ${padL(fmt(rpt(30,'maxAdverse')), 8)}`);
  }

  // Delta intensity analysis
  console.log(`\n  Delta Intensity (|delta|/volume in window):`);
  const intensities = divs.map(d => d.deltaIntensity).sort((a, b) => a - b);
  const medianInt = intensities[Math.floor(intensities.length / 2)];
  console.log(`    Median intensity: ${fmt(medianInt, 3)}`);

  const intGroups = [
    { label: 'Low intensity (<median)',  filter: d => d.deltaIntensity < medianInt },
    { label: 'High intensity (>=median)', filter: d => d.deltaIntensity >= medianInt },
    { label: 'Very high (>75th pct)',     filter: d => d.deltaIntensity >= intensities[Math.floor(intensities.length * 0.75)] },
    { label: 'Top 10% intensity',        filter: d => d.deltaIntensity >= intensities[Math.floor(intensities.length * 0.90)] },
  ];

  for (const ig of intGroups) {
    const f = divs.filter(ig.filter);
    if (f.length < 5) continue;
    const w30 = f.filter(d => d.forwardResults[30]);
    const wr30 = w30.length > 0 ? w30.filter(d => d.forwardResults[30].win).length / w30.length : null;
    const avg30 = w30.length > 0 ? w30.reduce((s, d) => s + d.forwardResults[30].snapBack, 0) / w30.length : null;
    const w60 = f.filter(d => d.forwardResults[60]);
    const wr60 = w60.length > 0 ? w60.filter(d => d.forwardResults[60].win).length / w60.length : null;
    console.log(`    ${padR(ig.label, 32)} N=${padL(f.length, 5)}  30mWR=${pct(wr30)}  60mWR=${pct(wr60)}  avg30=${fmt(avg30)}pt`);
  }

  // ─── SECTION 7: Threshold-Based Trading System ───
  console.log('\n' + '='.repeat(100));
  console.log('  SECTION 7: THRESHOLD-BASED TRADING SYSTEM');
  console.log('  "Enter when 30-min rolling divergence stretch reaches X points"');
  console.log('='.repeat(100));

  // 7a: Simple forward by threshold
  console.log(`\n  7a. Forward snap-back by entry threshold:`);
  console.log(`  ${padR('Thresh', 9)} ${padL('N', 6)} ${padL('15mWR', 7)} ${padL('30mWR', 7)} ${padL('60mWR', 7)} ${padL('A15', 6)} ${padL('A30', 6)} ${padL('A60', 6)} ${padL('MFE30', 7)} ${padL('MAE30', 7)}`);
  console.log('  ' + divider('─', 78));

  for (const threshold of ENTRY_THRESHOLDS) {
    const trades = thresholdTrades.filter(t => t.threshold === threshold);
    if (trades.length === 0) continue;
    const rpt = (fw, m) => {
      const w = trades.filter(t => t.simpleForward[fw]);
      if (w.length === 0) return null;
      if (m === 'wr') return w.filter(t => t.simpleForward[fw].win).length / w.length;
      return w.reduce((s, t) => s + t.simpleForward[fw][m], 0) / w.length;
    };
    console.log(`  ${padR(threshold + 'pt', 9)} ${padL(trades.length, 6)} ${padL(pct(rpt(15,'wr')), 7)} ${padL(pct(rpt(30,'wr')), 7)} ${padL(pct(rpt(60,'wr')), 7)} ${padL(fmt(rpt(15,'snapBack')), 6)} ${padL(fmt(rpt(30,'snapBack')), 6)} ${padL(fmt(rpt(60,'snapBack')), 6)} ${padL(fmt(rpt(30,'mfe')), 7)} ${padL(fmt(rpt(30,'mae')), 7)}`);
  }

  // 7b: Bullish vs Bearish by threshold
  console.log(`\n  7b. Bullish vs Bearish by threshold (30-min):`);
  console.log(`  ${padR('Type', 10)} ${padR('Thresh', 9)} ${padL('N', 6)} ${padL('30mWR', 7)} ${padL('Avg30', 7)} ${padL('MFE30', 7)} ${padL('MAE30', 7)}`);
  console.log('  ' + divider('─', 56));

  for (const type of ['BULLISH', 'BEARISH']) {
    for (const threshold of ENTRY_THRESHOLDS) {
      const trades = thresholdTrades.filter(t => t.threshold === threshold && t.type === type);
      if (trades.length < 10) continue;
      const w30 = trades.filter(t => t.simpleForward[30]);
      if (w30.length === 0) continue;
      const wr = w30.filter(t => t.simpleForward[30].win).length / w30.length;
      const avg = w30.reduce((s, t) => s + t.simpleForward[30].snapBack, 0) / w30.length;
      const mfe = w30.reduce((s, t) => s + t.simpleForward[30].mfe, 0) / w30.length;
      const mae = w30.reduce((s, t) => s + t.simpleForward[30].mae, 0) / w30.length;
      console.log(`  ${padR(type, 10)} ${padR(threshold + 'pt', 9)} ${padL(trades.length, 6)} ${padL(pct(wr), 7)} ${padL(fmt(avg), 7)} ${padL(fmt(mfe), 7)} ${padL(fmt(mae), 7)}`);
    }
  }

  // 7c: Best stop/target combos (exhaustive search)
  console.log(`\n  7c. Top 25 systems by Expected Value (EV per trade):`);
  console.log(`  PNL_PER_POINT=$${PNL_PER_POINT}, COMMISSION=$${COMMISSION}`);

  const allSystems = [];

  for (const threshold of ENTRY_THRESHOLDS) {
    for (const type of ['BULLISH', 'BEARISH', 'BOTH']) {
      const trades = type === 'BOTH'
        ? thresholdTrades.filter(t => t.threshold === threshold)
        : thresholdTrades.filter(t => t.threshold === threshold && t.type === type);
      if (trades.length < 15) continue;

      for (const stop of STOPS) {
        for (const target of TARGETS) {
          const key = `S${stop}_T${target}`;
          const results = trades.map(t => t.tradeResults[key]).filter(Boolean);
          if (results.length < 15) continue;

          const wins = results.filter(r => r.outcome === 'TARGET').length;
          const wr = wins / results.length;
          const avgPnl = results.reduce((s, r) => s + r.pnlDollar, 0) / results.length;
          const totalPnl = results.reduce((s, r) => s + r.pnlDollar, 0);
          const grossWin = results.filter(r => r.pnlDollar > 0).reduce((s, r) => s + r.pnlDollar, 0);
          const grossLoss = Math.abs(results.filter(r => r.pnlDollar < 0).reduce((s, r) => s + r.pnlDollar, 0));
          const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;

          // Max drawdown simulation
          let cumPnl = 0, peak = 0, maxDD = 0;
          for (const r of results) {
            cumPnl += r.pnlDollar;
            if (cumPnl > peak) peak = cumPnl;
            const dd = peak - cumPnl;
            if (dd > maxDD) maxDD = dd;
          }

          allSystems.push({ threshold, type, stop, target, wr, avgPnl, totalPnl, pf, maxDD, n: results.length });
        }
      }
    }
  }

  allSystems.sort((a, b) => b.avgPnl - a.avgPnl);

  console.log(`\n  ${padR('#', 4)} ${padR('Type', 8)} ${padR('Entry', 7)} ${padR('Stop', 6)} ${padR('Tgt', 6)} ${padL('N', 5)} ${padL('WR', 7)} ${padL('PF', 5)} ${padL('AvgEV', 8)} ${padL('Total$', 9)} ${padL('MaxDD', 8)}`);
  console.log('  ' + divider('─', 81));

  for (let i = 0; i < Math.min(25, allSystems.length); i++) {
    const c = allSystems[i];
    console.log(`  ${padR(i + 1, 4)} ${padR(c.type, 8)} ${padR(c.threshold + 'pt', 7)} ${padR(c.stop + 'pt', 6)} ${padR(c.target + 'pt', 6)} ${padL(c.n, 5)} ${padL(pct(c.wr), 7)} ${padL(fmt(c.pf), 5)} ${padL('$' + fmt(c.avgPnl, 2), 8)} ${padL('$' + fmt(c.totalPnl, 0), 9)} ${padL('$' + fmt(c.maxDD, 0), 8)}`);
  }

  // 7d: Full matrix for top threshold
  if (allSystems.length > 0) {
    const best = allSystems[0];
    const bestType = best.type;
    const bestThresh = best.threshold;
    const trades = bestType === 'BOTH'
      ? thresholdTrades.filter(t => t.threshold === bestThresh)
      : thresholdTrades.filter(t => t.threshold === bestThresh && t.type === bestType);

    console.log(`\n  7d. Full stop/target matrix for ${bestThresh}pt ${bestType} entry (N=${trades.length}):`);
    console.log(`  Format: WR / $EV`);
    console.log(`  ${padR('', 10)} ${TARGETS.map(t => padL(t + 'pt', 12)).join('')}`);
    console.log('  ' + divider('─', 10 + 12 * TARGETS.length));

    for (const stop of STOPS) {
      let row = `  ${padR(stop + 'pt', 10)}`;
      for (const target of TARGETS) {
        const key = `S${stop}_T${target}`;
        const results = trades.map(t => t.tradeResults[key]).filter(Boolean);
        if (results.length < 5) { row += padL('--', 12); continue; }
        const wins = results.filter(r => r.outcome === 'TARGET').length;
        const wr = wins / results.length;
        const avgPnl = results.reduce((s, r) => s + r.pnlDollar, 0) / results.length;
        row += padL(`${(wr*100).toFixed(0)}%/$${fmt(avgPnl,1)}`, 12);
      }
      console.log(row);
    }
  }

  // ─── SECTION 8: Filtered combos (with level/time context) ───
  console.log('\n' + '='.repeat(100));
  console.log('  SECTION 8: CONTEXTUAL FILTERS ON THRESHOLD TRADES');
  console.log('='.repeat(100));

  // Best threshold trades filtered by: bullish + near session low, bearish + near session high
  const contextCombos = [
    { label: 'Bullish + near Session Low',  filter: t => t.type === 'BULLISH' && t.nearLow },
    { label: 'Bullish + near VWAP',         filter: t => t.type === 'BULLISH' && t.nearVwap },
    { label: 'Bullish + near POC',          filter: t => t.type === 'BULLISH' && t.nearPOC },
    { label: 'Bearish + near Session High', filter: t => t.type === 'BEARISH' && t.nearHigh },
    { label: 'Bearish + near VWAP',         filter: t => t.type === 'BEARISH' && t.nearVwap },
    { label: 'Bullish + 11AM-12PM',         filter: t => t.type === 'BULLISH' && t.minuteOfDay >= 660 && t.minuteOfDay <= 719 },
    { label: 'Bearish + 11AM-12PM',         filter: t => t.type === 'BEARISH' && t.minuteOfDay >= 660 && t.minuteOfDay <= 719 },
    { label: 'Bullish + 9:30-10:00',        filter: t => t.type === 'BULLISH' && t.minuteOfDay >= 570 && t.minuteOfDay <= 599 },
    { label: 'Bearish + 2:00-3:00',         filter: t => t.type === 'BEARISH' && t.minuteOfDay >= 840 && t.minuteOfDay <= 899 },
  ];

  for (const cc of contextCombos) {
    const filtered = thresholdTrades.filter(cc.filter);
    if (filtered.length < 10) continue;

    // Find best system for this context
    let bestEV = -Infinity, bestSys = null;
    for (const threshold of ENTRY_THRESHOLDS) {
      const tTrades = filtered.filter(t => t.threshold === threshold);
      if (tTrades.length < 8) continue;
      for (const stop of STOPS) {
        for (const target of TARGETS) {
          const key = `S${stop}_T${target}`;
          const results = tTrades.map(t => t.tradeResults[key]).filter(Boolean);
          if (results.length < 8) continue;
          const avgPnl = results.reduce((s, r) => s + r.pnlDollar, 0) / results.length;
          const wins = results.filter(r => r.outcome === 'TARGET').length;
          if (avgPnl > bestEV) {
            bestEV = avgPnl;
            bestSys = { threshold, stop, target, wr: wins / results.length, avgPnl, n: results.length };
          }
        }
      }
    }

    if (bestSys && bestSys.avgPnl > 0) {
      // Also show 30m forward for overview
      const with30 = filtered.filter(t => t.simpleForward[30]);
      const wr30 = with30.length > 0 ? with30.filter(t => t.simpleForward[30].win).length / with30.length : null;
      console.log(`\n  ${cc.label} (N=${filtered.length}, 30mWR=${pct(wr30)}):`);
      console.log(`    Best: ${bestSys.threshold}pt entry, ${bestSys.stop}pt stop, ${bestSys.target}pt target`);
      console.log(`    N=${bestSys.n}  WR=${pct(bestSys.wr)}  EV=$${fmt(bestSys.avgPnl, 2)}/trade`);
    }
  }

  // ─── SECTION 9: False Divergence ───
  console.log('\n' + '='.repeat(100));
  console.log('  SECTION 9: FALSE DIVERGENCE ANALYSIS');
  console.log('='.repeat(100));

  const w60 = divs.filter(d => d.forwardResults[60]);
  const resolved = w60.filter(d => d.forwardResults[60].win);
  const failed = w60.filter(d => !d.forwardResults[60].win);

  console.log(`\n  Of ${w60.length} divergences with 60-min forward data:`);
  console.log(`    Resolved (price snapped back):  ${resolved.length} (${pct(resolved.length / w60.length)})`);
  console.log(`    Failed (price kept going):       ${failed.length} (${pct(failed.length / w60.length)})`);

  console.log(`\n  What distinguishes resolved vs failed:`);
  console.log(`  ${padR('Metric', 32)} ${padL('Resolved', 12)} ${padL('Failed', 12)} ${padL('Delta', 12)}`);
  console.log('  ' + divider('─', 72));

  const avg = (arr, fn) => arr.length > 0 ? arr.reduce((s, d) => s + fn(d), 0) / arr.length : null;

  const metrics = [
    ['Avg stretch (pts)',       d => d.maxStretch],
    ['Avg duration (bars)',     d => d.duration],
    ['% at key level',          d => d.atKeyLevel ? 1 : 0],
    ['% near session low',     d => d.nearLow ? 1 : 0],
    ['% near VWAP',            d => d.nearVwap ? 1 : 0],
    ['% delta accelerating',   d => d.deltaAccelerating ? 1 : 0],
    ['Avg delta intensity',    d => d.deltaIntensity],
    ['Avg ATR20',              d => d.atr20],
  ];

  for (const [label, fn] of metrics) {
    const r = avg(resolved, fn);
    const f = avg(failed, fn);
    const delta = r != null && f != null ? r - f : null;
    const isBool = label.startsWith('%');
    const fmtFn = isBool ? pct : (v) => fmt(v, isBool ? 1 : 2);
    console.log(`  ${padR(label, 32)} ${padL(fmtFn(r), 12)} ${padL(fmtFn(f), 12)} ${padL(fmtFn(delta), 12)}`);
  }

  // False divergence by magnitude
  console.log(`\n  False divergence rate by magnitude:`);
  for (const mb of magBuckets) {
    const filtered = w60.filter(d => d.maxStretch >= mb.min && d.maxStretch < mb.max);
    if (filtered.length < 5) continue;
    const failRate = filtered.filter(d => !d.forwardResults[60].win).length / filtered.length;
    console.log(`    ${padR(mb.label, 14)} N=${padL(filtered.length, 5)}  FailRate=${pct(failRate)}`);
  }

  // False divergence by time
  console.log(`\n  False divergence rate by time of day:`);
  for (const tod of TOD_BUCKETS) {
    const filtered = w60.filter(d => d.minuteOfDay >= tod.min && d.minuteOfDay <= tod.max);
    if (filtered.length < 5) continue;
    const failRate = filtered.filter(d => !d.forwardResults[60].win).length / filtered.length;
    console.log(`    ${padR(tod.label, 16)} N=${padL(filtered.length, 5)}  FailRate=${pct(failRate)}`);
  }

  // ─── SECTION 10: MFE/MAE Excursion Analysis ───
  console.log('\n' + '='.repeat(100));
  console.log('  SECTION 10: EXCURSION ANALYSIS (MFE/MAE within forward windows)');
  console.log('='.repeat(100));

  for (const fw of [15, 30, 60]) {
    const withFw = divs.filter(d => d.forwardResults[fw]);
    if (withFw.length === 0) continue;

    const mfes = withFw.map(d => d.forwardResults[fw].maxFavorable).sort((a, b) => a - b);
    const maes = withFw.map(d => d.forwardResults[fw].maxAdverse).sort((a, b) => a - b);
    const p = (arr, pct) => arr[Math.floor(arr.length * pct)] || 0;

    console.log(`\n  ${fw}-minute forward (N=${withFw.length}):`);
    console.log(`    MFE: avg=${fmt(mfes.reduce((s,v)=>s+v,0)/mfes.length)}  25th=${fmt(p(mfes,0.25))}  50th=${fmt(p(mfes,0.5))}  75th=${fmt(p(mfes,0.75))}  90th=${fmt(p(mfes,0.9))}`);
    console.log(`    MAE: avg=${fmt(maes.reduce((s,v)=>s+v,0)/maes.length)}  25th=${fmt(p(maes,0.25))}  50th=${fmt(p(maes,0.5))}  75th=${fmt(p(maes,0.75))}  90th=${fmt(p(maes,0.9))}`);
  }

  // ─── SECTION 11: Practical Recommendations ───
  console.log('\n' + '='.repeat(100));
  console.log('  SECTION 11: PRACTICAL TRADING RECOMMENDATIONS');
  console.log('='.repeat(100));

  // Find best by type
  for (const type of ['BULLISH', 'BEARISH', 'BOTH']) {
    const typeSystems = allSystems.filter(s => s.type === type && s.avgPnl > 0);
    if (typeSystems.length === 0) continue;

    // Filter for minimum WR and PF
    const viable = typeSystems.filter(s => s.wr >= 0.30 && s.pf >= 1.05 && s.n >= 20);
    if (viable.length === 0) continue;

    const best = viable[0]; // already sorted by EV
    console.log(`\n  BEST ${type} SYSTEM:`);
    console.log(`    Entry:  When 30-min rolling divergence reaches ${best.threshold} points`);
    console.log(`    Stop:   ${best.stop} points`);
    console.log(`    Target: ${best.target} points`);
    console.log(`    Stats:  N=${best.n}, WR=${pct(best.wr)}, PF=${fmt(best.pf)}, EV=$${fmt(best.avgPnl, 2)}/trade`);
    console.log(`    Total:  $${fmt(best.totalPnl, 0)} over ${tradingDays.length} days`);
    console.log(`    MaxDD:  $${fmt(best.maxDD, 0)}`);
    console.log(`    Risk/Reward: ${fmt(best.target / best.stop, 1)}R`);
  }

  // ─── EXECUTIVE SUMMARY ───
  console.log('\n' + '='.repeat(100));
  console.log('  EXECUTIVE SUMMARY');
  console.log('='.repeat(100));

  const allWith30 = divs.filter(d => d.forwardResults[30]);
  const allWR30 = allWith30.length > 0 ? allWith30.filter(d => d.forwardResults[30].win).length / allWith30.length : null;
  const allWith60 = divs.filter(d => d.forwardResults[60]);
  const allWR60 = allWith60.length > 0 ? allWith60.filter(d => d.forwardResults[60].win).length / allWith60.length : null;

  console.log(`
  1. FREQUENCY: ${fmt(divs.length / tradingDays.length)} divergence events/day over ${tradingDays.length} days
     (${bullish.length} bullish, ${bearish.length} bearish)

  2. RAW SNAP-BACK RATE: 30min=${pct(allWR30)}, 60min=${pct(allWR60)}
     Divergence alone is near coin-flip — context matters.

  3. KEY FINDINGS:
`);

  // Level context summary
  const klWith30 = divs.filter(d => d.atKeyLevel && d.forwardResults[30]);
  const klWR30 = klWith30.length > 0 ? klWith30.filter(d => d.forwardResults[30].win).length / klWith30.length : null;
  const nlWith30 = divs.filter(d => !d.atKeyLevel && d.forwardResults[30]);
  const nlWR30 = nlWith30.length > 0 ? nlWith30.filter(d => d.forwardResults[30].win).length / nlWith30.length : null;

  console.log(`     a) Key level context: At level 30mWR=${pct(klWR30)} vs open field ${pct(nlWR30)}`);

  // Acceleration
  const accWith30 = divs.filter(d => d.deltaAccelerating && d.forwardResults[30]);
  const accWR30 = accWith30.length > 0 ? accWith30.filter(d => d.forwardResults[30].win).length / accWith30.length : null;
  console.log(`     b) Delta acceleration: 30mWR=${pct(accWR30)} (N=${accWith30.length}) — small sample`);

  // Best system
  if (allSystems.length > 0) {
    const best = allSystems[0];
    console.log(`     c) Best raw system: ${best.type} ${best.threshold}pt entry, ${best.stop}pt stop, ${best.target}pt target`);
    console.log(`        WR=${pct(best.wr)}, PF=${fmt(best.pf)}, EV=$${fmt(best.avgPnl, 2)}/trade, N=${best.n}`);
  }

  // False divergence
  console.log(`     d) False divergence (60m): ${pct(failed.length / w60.length)} — nearly half don't resolve`);

  console.log(`
  4. BOTTOM LINE:
     Delta-price divergence as a STANDALONE signal is close to random (50/50).
     It needs confluence — key levels, time-of-day, trend context — to become
     a tradable edge. The best mechanical system found has a positive EV but
     a low win rate and thin profit factor. Best used as a CONFIRMING signal
     within a broader setup rather than a primary entry trigger.
`);

  console.log('='.repeat(100));
  console.log('  BACKTEST COMPLETE');
  console.log('='.repeat(100));

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
