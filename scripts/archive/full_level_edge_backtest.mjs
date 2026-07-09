import { query } from '../server/db.js';

const HORIZONS = [3, 5, 10, 20];
const PROX = 20; // proximity to count as "at level"
const CONFIRM_BARS = 1; // require 1 bar confirmation

console.log('═══ FULL LEVEL EDGE BACKTEST ═══');
console.log('Loading data...');

// Load all RTH bars
const allBars = await query(`
  SELECT ts::date::text as d, (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min,
    open::float, high::float, low::float, close::float, volume::bigint as vol,
    COALESCE(ask_volume,0)::bigint as ask_vol, COALESCE(bid_volume,0)::bigint as bid_vol
  FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= '2025-06-18'
    AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
  ORDER BY ts
`);
const barsByDate = {};
for (const b of allBars.rows) (barsByDate[b.d] ??= []).push(b);
const dates = Object.keys(barsByDate).sort();
console.log(`[1/6] Bars loaded: ${allBars.rows.length} across ${dates.length} days`);

// Load VA, day types, OR levels
const vaQ = await query(`SELECT trade_date::text as d, vah::float, val::float, poc::float, session_high::float as sh, session_low::float as sl FROM developing_value_log ORDER BY trade_date`);
const vaByDate = {};
const vaDates = [];
for (const r of vaQ.rows) { vaByDate[r.d] = r; vaDates.push(r.d); }

const dtQ = await query(`SELECT trade_date::text as d, day_type, or_high::float, or_low::float FROM acd_daily_log WHERE trade_date >= '2025-06-18'`);
const dtMap = {}, orMap = {};
for (const r of dtQ.rows) { dtMap[r.d] = r.day_type || 'UNKNOWN'; orMap[r.d] = { h: r.or_high, l: r.or_low }; }

// NL30 per day
const nlQ = await query(`
  SELECT trade_date::text as d,
    SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as nl30
  FROM acd_daily_log WHERE daily_score IS NOT NULL ORDER BY trade_date
`);
const nlMap = {};
for (const r of nlQ.rows) nlMap[r.d] = parseInt(r.nl30) || 0;

console.log(`[2/6] Reference data loaded`);

// Baseline
const bl = {};
for (const h of HORIZONS) {
  let n = 0, up = 0;
  for (const bars of Object.values(barsByDate)) {
    for (let i = 0; i < bars.length - h; i++) { n++; if (bars[i + h].close > bars[i].close) up++; }
  }
  bl[h] = { upPct: up / n * 100, dnPct: 100 - up / n * 100 };
}
console.log(`[3/6] Baseline computed`);

// Helper: get prior VA
function getPriorVA(date, n) {
  const idx = vaDates.indexOf(date);
  return idx >= n ? vaByDate[vaDates[idx - n]] : null;
}

// Composite VA
function compositeVA(date, n) {
  const idx = vaDates.indexOf(date);
  if (idx < n) return null;
  const byPx = {};
  for (let i = idx - n; i < idx; i++) {
    const d = vaDates[i];
    const dayBars = barsByDate[d];
    if (!dayBars) continue;
    for (const b of dayBars) {
      const px = Math.round(b.low / 2) * 2;
      byPx[px] = (byPx[px] || 0) + Number(b.vol);
    }
  }
  const sorted = Object.entries(byPx).sort((a, b) => b[1] - a[1]);
  if (sorted.length < 5) return null;
  const poc = parseFloat(sorted[0][0]);
  const total = sorted.reduce((s, [, v]) => s + v, 0);
  let cumUp = 0, cumDn = 0, vah = poc, val = poc;
  for (const [p, v] of sorted.filter(([p]) => parseFloat(p) >= poc).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))) {
    cumUp += v; if (cumUp <= total * 0.35) vah = parseFloat(p);
  }
  for (const [p, v] of sorted.filter(([p]) => parseFloat(p) <= poc).sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]))) {
    cumDn += v; if (cumDn <= total * 0.35) val = parseFloat(p);
  }
  return { vah, val, poc };
}

// Define all levels to test
const levelDefs = [
  { name: 'RTH VWAP', fn: (d, bars) => { let pv=0,v=0; for (const b of bars) { const tp=(b.high+b.low+b.close)/3; pv+=tp*Number(b.vol); v+=Number(b.vol); } return v>0?pv/v:null; }},
  { name: 'OR Midpoint', fn: (d) => { const or=orMap[d]; return or?.h&&or?.l?(or.h+or.l)/2:null; }},
  { name: 'PD-1 VAH', fn: (d) => getPriorVA(d,1)?.vah??null },
  { name: 'PD-1 VAL', fn: (d) => getPriorVA(d,1)?.val??null },
  { name: 'PD-1 POC', fn: (d) => getPriorVA(d,1)?.poc??null },
  { name: 'PD-2 VAH', fn: (d) => getPriorVA(d,2)?.vah??null },
  { name: 'PD-2 VAL', fn: (d) => getPriorVA(d,2)?.val??null },
  { name: 'PD High', fn: (d) => getPriorVA(d,1)?.sh??null },
  { name: 'PD Low', fn: (d) => getPriorVA(d,1)?.sl??null },
  { name: 'IB High', fn: (d, bars) => { const ib=bars.filter(b=>b.et_min>=570&&b.et_min<630); return ib.length>0?Math.max(...ib.map(b=>b.high)):null; }},
  { name: 'IB Low', fn: (d, bars) => { const ib=bars.filter(b=>b.et_min>=570&&b.et_min<630); return ib.length>0?Math.min(...ib.map(b=>b.low)):null; }},
  { name: 'PW High', fn: (d) => { const idx=vaDates.indexOf(d); if(idx<5) return null; let h=0; for(let i=idx-5;i<idx;i++){const v=vaByDate[vaDates[i]]; if(v?.sh) h=Math.max(h,v.sh);} return h||null; }},
  { name: 'PW Low', fn: (d) => { const idx=vaDates.indexOf(d); if(idx<5) return null; let l=Infinity; for(let i=idx-5;i<idx;i++){const v=vaByDate[vaDates[i]]; if(v?.sl) l=Math.min(l,v.sl);} return l<Infinity?l:null; }},
  { name: '3D VAH', fn: (d) => compositeVA(d,3)?.vah??null },
  { name: '3D VAL', fn: (d) => compositeVA(d,3)?.val??null },
  { name: '5D VAH', fn: (d) => compositeVA(d,5)?.vah??null },
  { name: '5D VAL', fn: (d) => compositeVA(d,5)?.val??null },
  { name: 'PM High', fn: (d) => { const idx=vaDates.indexOf(d); if(idx<20) return null; let h=0; for(let i=idx-20;i<idx;i++){const v=vaByDate[vaDates[i]]; if(v?.sh) h=Math.max(h,v.sh);} return h||null; }},
  { name: 'PM Low', fn: (d) => { const idx=vaDates.indexOf(d); if(idx<20) return null; let l=Infinity; for(let i=idx-20;i<idx;i++){const v=vaByDate[vaDates[i]]; if(v?.sl) l=Math.min(l,v.sl);} return l<Infinity?l:null; }},
];

console.log(`[4/6] Testing ${levelDefs.length} level types across ${dates.length} days...`);

const results = {};
let processed = 0;

for (const ldef of levelDefs) {
  const signals = []; // { date, barIdx, direction (LONG/SHORT), level, confirmed, dayType, nl30, firstTouch, touchNum, mfe, mae, fwdReturns }
  
  for (const date of dates) {
    const bars = barsByDate[date];
    if (!bars || bars.length < 30) continue;
    const level = ldef.fn(date, bars);
    if (level == null) continue;
    const dt = dtMap[date] || 'UNKNOWN';
    const nl = nlMap[date] || 0;
    
    // Track touches for first-touch vs re-test
    let touchCount = 0;
    let lastTouchBar = -999;
    
    // Only consider bars after IB close (10:30) for IB levels, after OR close for OR levels
    const startBar = ldef.name.startsWith('IB') ? bars.findIndex(b => b.et_min >= 630) :
                     ldef.name === 'OR Midpoint' ? bars.findIndex(b => b.et_min >= 575) : 5;
    if (startBar < 0) continue;
    
    for (let i = Math.max(startBar, 10); i < bars.length - 20; i++) {
      // Skip if too close to last touch (debounce — 10 bar gap)
      if (i - lastTouchBar < 10) continue;
      
      const dist = bars[i].close - level;
      if (Math.abs(dist) > PROX) continue;
      
      // Determine approach direction from prior 5 bars
      const priorCloses = bars.slice(i - 5, i).map(b => b.close);
      const priorAvg = priorCloses.reduce((a, b) => a + b, 0) / priorCloses.length;
      const fromBelow = priorAvg < level - 3;
      const fromAbove = priorAvg > level + 3;
      if (!fromBelow && !fromAbove) continue;
      
      // Confirmation: next bar rejects the level (closes back away from it)
      const nextBar = bars[i + 1];
      const confirmed = fromBelow
        ? nextBar.close < bars[i].close // rejection candle: approached from below, next bar closes lower
        : nextBar.close > bars[i].close; // approached from above, next bar closes higher
      
      // Volume on touch bar vs 20-bar avg
      const avg20Vol = bars.slice(Math.max(0, i - 20), i).reduce((s, b) => s + Number(b.vol), 0) / 20;
      const touchVol = Number(bars[i].vol);
      const highVol = touchVol > avg20Vol * 1.5;
      
      // Delta on touch bar
      const touchDelta = Number(bars[i].ask_vol) - Number(bars[i].bid_vol);
      const deltaConfirm = fromBelow ? touchDelta < 0 : touchDelta > 0; // selling at resistance, buying at support
      
      touchCount++;
      lastTouchBar = i;
      
      // The trade direction: FADE the level (expect bounce)
      const tradeDir = fromBelow ? 'SHORT' : 'LONG'; // fade: approached from below = short the resistance
      
      // Forward MFE/MAE
      const entryPx = confirmed ? nextBar.close : bars[i].close;
      const entryIdx = confirmed ? i + 1 : i;
      
      const fwd = {};
      for (const h of HORIZONS) {
        if (entryIdx + h >= bars.length) continue;
        let mfe = 0, mae = 0;
        for (let j = 1; j <= h; j++) {
          if (entryIdx + j >= bars.length) break;
          const diff = bars[entryIdx + j].close - entryPx;
          const directed = tradeDir === 'LONG' ? diff : -diff;
          mfe = Math.max(mfe, directed);
          mae = Math.min(mae, directed);
        }
        const net = tradeDir === 'LONG'
          ? bars[entryIdx + h].close - entryPx
          : entryPx - bars[entryIdx + h].close;
        fwd[h] = { win: net > 0, net, mfe, mae };
      }
      
      signals.push({
        date, barIdx: i, tradeDir, level, confirmed, highVol, deltaConfirm,
        dayType: dt, nl30: nl, touchNum: touchCount, firstTouch: touchCount === 1,
        fwd,
      });
    }
  }
  
  results[ldef.name] = signals;
  processed++;
  if (processed % 5 === 0) console.log(`  ... ${processed}/${levelDefs.length} levels done (${signals.length} signals for ${ldef.name})`);
}

console.log(`[5/6] All levels tested. Computing results...`);

// Analysis function
function analyzeGroup(signals, label, horizon = 10) {
  const withH = signals.filter(s => s.fwd[horizon]);
  if (withH.length < 5) return null;
  const wins = withH.filter(s => s.fwd[horizon].win).length;
  const wr = wins / withH.length * 100;
  const avgMfe = withH.reduce((s, r) => s + r.fwd[horizon].mfe, 0) / withH.length;
  const avgMae = withH.reduce((s, r) => s + r.fwd[horizon].mae, 0) / withH.length;
  const avgNet = withH.reduce((s, r) => s + r.fwd[horizon].net, 0) / withH.length;
  // Baseline depends on trade direction
  const longCount = withH.filter(s => s.tradeDir === 'LONG').length;
  const base = longCount > withH.length / 2 ? bl[horizon].upPct : bl[horizon].dnPct;
  return { n: withH.length, wr, base, delta: wr - base, avgMfe, avgMae, avgNet };
}

// Print full results
console.log(`\n[6/6] RESULTS\n`);
console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
console.log('FULL LEVEL EDGE BACKTEST (first touch, confirmation bar, MFE/MAE, day-type splits)');
console.log('═══════════════════════════════════════════════════════════════════════════════════════════');

const summaryRows = [];

for (const [name, signals] of Object.entries(results)) {
  if (signals.length < 10) continue;
  
  console.log(`\n═══ ${name} (${signals.length} total touches) ═══`);
  
  const printGroup = (sigs, label) => {
    for (const h of [5, 10]) {
      const r = analyzeGroup(sigs, label, h);
      if (!r) continue;
      const flag = r.n < 20 ? ' ⚠' : '';
      console.log(`  ${label.padEnd(28)} ${h}bar: N=${String(r.n).padStart(4)} WR=${r.wr.toFixed(1).padStart(5)}% base=${r.base.toFixed(1)}% Δ=${(r.delta>0?'+':'')+r.delta.toFixed(1).padStart(5)}% MFE=${r.avgMfe.toFixed(0).padStart(4)}pt MAE=${r.avgMae.toFixed(0).padStart(5)}pt net=${r.avgNet.toFixed(0).padStart(4)}pt${flag}`);
    }
  };
  
  // All signals
  printGroup(signals, 'ALL');
  
  // Confirmed vs unconfirmed
  printGroup(signals.filter(s => s.confirmed), 'Confirmed');
  printGroup(signals.filter(s => !s.confirmed), 'Unconfirmed');
  
  // First touch vs re-test
  printGroup(signals.filter(s => s.firstTouch), 'First touch of day');
  printGroup(signals.filter(s => !s.firstTouch), 'Re-test (2nd+ touch)');
  
  // High volume
  printGroup(signals.filter(s => s.highVol), 'High volume touch');
  printGroup(signals.filter(s => s.deltaConfirm), 'Delta confirms fade');
  
  // Day type splits
  for (const dt of ['TREND', 'BALANCE', 'TURBULENT']) {
    const dtSigs = signals.filter(s => s.dayType === dt);
    if (dtSigs.length >= 5) printGroup(dtSigs, dt);
  }
  
  // NL30 aligned (fade direction matches NL30)
  const aligned = signals.filter(s => (s.tradeDir === 'LONG' && s.nl30 > 9) || (s.tradeDir === 'SHORT' && s.nl30 < -9));
  const counter = signals.filter(s => (s.tradeDir === 'LONG' && s.nl30 < -9) || (s.tradeDir === 'SHORT' && s.nl30 > 9));
  if (aligned.length >= 5) printGroup(aligned, 'NL30 aligned');
  if (counter.length >= 5) printGroup(counter, 'NL30 counter');
  
  // Best result for summary
  const allR = analyzeGroup(signals, 'ALL', 10);
  const confR = analyzeGroup(signals.filter(s => s.confirmed), 'Conf', 10);
  const firstR = analyzeGroup(signals.filter(s => s.firstTouch), 'First', 10);
  const best = [allR, confR, firstR].filter(Boolean).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
  if (best) {
    summaryRows.push({ name, ...best, bestFilter: best === confR ? 'Confirmed' : best === firstR ? 'First touch' : 'ALL' });
  }
}

// Summary
console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════');
console.log('RANKED SUMMARY (10-bar, sorted by edge delta)');
console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
console.log(`${'Level'.padEnd(16)} | ${'N'.padStart(5)} | ${'WR'.padStart(6)} | ${'Base'.padStart(6)} | ${'Delta'.padStart(6)} | ${'MFE'.padStart(5)} | ${'MAE'.padStart(6)} | ${'Net'.padStart(5)} | ${'Filter'.padStart(12)} | Action`);
console.log('─'.repeat(105));

summaryRows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
for (const s of summaryRows) {
  const action = s.delta > 10 && s.n >= 20 ? '✅✅ STRONG' : s.delta > 5 && s.n >= 20 ? '✅ EDGE' : s.delta > 5 ? '⚠ LOW N' : '~ WEAK';
  console.log(`${s.name.padEnd(16)} | ${String(s.n).padStart(5)} | ${s.wr.toFixed(1).padStart(5)}% | ${s.base.toFixed(1).padStart(5)}% | ${(s.delta>0?'+':'')+s.delta.toFixed(1).padStart(5)}% | ${s.avgMfe.toFixed(0).padStart(4)}pt | ${s.avgMae.toFixed(0).padStart(5)}pt | ${s.avgNet.toFixed(0).padStart(4)}pt | ${s.bestFilter.padStart(12)} | ${action}`);
}

console.log('\n═══ BACKTEST COMPLETE ═══');
process.exit(0);
