// Step 2 of docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md's build sequence (section 3.1's
// "one cheap test of the breakout branch"): does level context (idea C's acceptedTimeFrac)
// filter the already-validated, stable compression-volume-breakout population
// (scripts/backtest_compression_volume_breakout.mjs's NO_COMPRESSION_CONTROL arm,
// reports/compression_breakout_stop_target_sim.md, N=1516, best cell +++ STABLE $11.13/trade
// at stop=138/target=102)?
//
// Pre-registered kill condition (written before this run, per the spec, so it can't be
// picked post-hoc): headline cell is 138/102. If the undefended arm does not beat the
// no-level-nearby arm by >= $4-5/trade at that cell while holding +++ stability, "undefended
// level -> trade the breakout instead" is closed permanently.
//
// Deliberately does NOT reimplement the breakout-detection or stop/target-grid logic from
// scratch -- both are copied verbatim from the two already-validated scripts above (same
// ATR/compression/volZ detection, same MAE/MFE-percentile candidate grid, same chronological
// stability + day-clustering check) with exactly one addition: a per-event level-context
// classification using the same acceptedTimeFrac bar-walk already built and rigor-tested in
// scratch/pilot_liquidity_zones_idea_c_a.mjs (idea C -- confirmed dead as a fade-EV predictor,
// but that is a different population/hypothesis; this test is what the spec calls "the enabling
// feature," not a re-run of the same claim).
import { query } from '../server/db.js';
import fs from 'fs';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

const SAME_DAY_FORMING_MINUTE = {
  OR5_HIGH: 575, OR5_LOW: 575, OR5_MID: 575,
  OR10_HIGH: 580, OR10_LOW: 580, OR10_MID: 580,
  OR30_HIGH: 600, OR30_LOW: 600, OR30_MID: 600,
  IB_HIGH: 630, IB_LOW: 630, IB_MID: 630,
};

function etMinutesOfDay(tsDate) {
  const d = new Date(tsDate.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return d.getHours() * 60 + d.getMinutes();
}

async function loadLevels() {
  const res = await query(`SELECT trade_date::text as trade_date, level_name, price::float FROM level_prices ORDER BY trade_date ASC`);
  const levelsByDate = {};
  let currentTradeDate = null, latestLevels = {};
  for (const row of res.rows) {
    if (row.trade_date !== currentTradeDate) {
      if (currentTradeDate !== null) levelsByDate[currentTradeDate] = { ...latestLevels };
      currentTradeDate = row.trade_date;
    }
    latestLevels[row.level_name] = row.price;
  }
  if (currentTradeDate !== null) levelsByDate[currentTradeDate] = { ...latestLevels };
  const denseLevelMap = {};
  let runningLevels = {};
  const allCalendarDates = await query(`SELECT DISTINCT trade_date::text as d FROM level_prices ORDER BY d ASC`);
  const checkpointDates = [];
  for (const row of allCalendarDates.rows) {
    const d = row.d;
    if (levelsByDate[d]) runningLevels = { ...runningLevels, ...levelsByDate[d] };
    denseLevelMap[d] = { ...runningLevels };
    checkpointDates.push(d);
  }
  const getLevelsForDate = (td) => {
    let lo = 0, hi = checkpointDates.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (checkpointDates[mid] <= td) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best === -1 ? null : denseLevelMap[checkpointDates[best]];
  };
  return { getLevelsForDate };
}

async function main() {
  console.log('Loading levels...');
  const { getLevelsForDate } = await loadLevels();

  console.log('Loading bars...');
  const barsRes = await query(`
    SELECT ts, TO_CHAR(ts, 'YYYY-MM-DD HH24:MI:SS') as ts_str,
           open::float, high::float, low::float, close::float,
           COALESCE(bid_volume,0)+COALESCE(ask_volume,0) as volume,
           (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as mod
    FROM price_bars_primary
    WHERE symbol='NQ'
    ORDER BY ts ASC
  `);
  const allBars = barsRes.rows;
  console.log(`Loaded ${allBars.length} bars`);

  // --- Verbatim breakout detection from backtest_compression_volume_breakout.mjs ---
  const WINDOW_RATIO = 5000, WINDOW_ATR1 = 5, WINDOW_ATR2 = 100, MAX_HIGH_LOW_WINDOW = 30;
  let trQueue = [], sortedRatios = [], ratioQueue = [];
  let modQueues = Array.from({ length: 1440 }, () => []);
  let barsSinceLongBreakout = 100, barsSinceShortBreakout = 100;
  const results = [];
  let prevClose = null, highQueue = [], lowQueue = [];

  for (let i = 0; i < allBars.length; i++) {
    const bar = allBars[i];
    let tr = bar.high - bar.low;
    if (prevClose !== null) tr = Math.max(tr, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
    prevClose = bar.close;
    trQueue.push(tr);
    if (trQueue.length > WINDOW_ATR2) trQueue.shift();

    let ratio = null;
    if (trQueue.length === WINDOW_ATR2) {
      let sum5 = 0; for (let j = trQueue.length - WINDOW_ATR1; j < trQueue.length; j++) sum5 += trQueue[j];
      let sum100 = 0; for (let j = 0; j < trQueue.length; j++) sum100 += trQueue[j];
      const atr5 = sum5 / WINDOW_ATR1, atr100 = sum100 / WINDOW_ATR2;
      if (atr100 > 0) ratio = atr5 / atr100;
    }
    let p20 = null;
    if (sortedRatios.length >= 1000) p20 = sortedRatios[Math.floor(sortedRatios.length * 0.20)];
    if (ratio !== null) {
      ratioQueue.push(ratio);
      let lo = 0, hi = sortedRatios.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (sortedRatios[mid] < ratio) lo = mid + 1; else hi = mid; }
      sortedRatios.splice(lo, 0, ratio);
      if (ratioQueue.length > WINDOW_RATIO) {
        const oldRatio = ratioQueue.shift();
        let l = 0, h = sortedRatios.length;
        while (l < h) { const mid = (l + h) >>> 1; if (sortedRatios[mid] < oldRatio) l = mid + 1; else h = mid; }
        if (sortedRatios[l] === oldRatio) sortedRatios.splice(l, 1);
        else { const idx = sortedRatios.indexOf(oldRatio); if (idx !== -1) sortedRatios.splice(idx, 1); }
      }
    }
    const isCompressed = p20 !== null && ratio !== null && ratio < p20;

    highQueue.push(bar.high); lowQueue.push(bar.low);
    if (highQueue.length > MAX_HIGH_LOW_WINDOW + 1) { highQueue.shift(); lowQueue.shift(); }

    let breakoutLong = false, breakoutShort = false;
    if (highQueue.length === MAX_HIGH_LOW_WINDOW + 1) {
      let maxHigh30 = -Infinity, minLow30 = Infinity;
      for (let j = 0; j < MAX_HIGH_LOW_WINDOW; j++) { if (highQueue[j] > maxHigh30) maxHigh30 = highQueue[j]; if (lowQueue[j] < minLow30) minLow30 = lowQueue[j]; }
      if (bar.close > maxHigh30) { if (barsSinceLongBreakout >= 15) { breakoutLong = true; barsSinceLongBreakout = 0; } else barsSinceLongBreakout++; } else barsSinceLongBreakout++;
      if (bar.close < minLow30) { if (barsSinceShortBreakout >= 15) { breakoutShort = true; barsSinceShortBreakout = 0; } else barsSinceShortBreakout++; } else barsSinceShortBreakout++;
    } else { barsSinceLongBreakout++; barsSinceShortBreakout++; }

    const q = modQueues[bar.mod];
    let volZ = null;
    if (q.length >= 30) {
      let sum = 0; for (let j = 0; j < q.length; j++) sum += q[j];
      const mean = sum / q.length;
      let sumSq = 0; for (let j = 0; j < q.length; j++) sumSq += (q[j] - mean) * (q[j] - mean);
      const std = Math.sqrt(sumSq / q.length);
      if (std > 0) volZ = (bar.volume - mean) / std;
    }
    q.push(bar.volume);
    if (q.length > 90) q.shift();

    if (volZ !== null && p20 !== null && (breakoutLong || breakoutShort) && bar.mod >= 570 && bar.mod <= 959) {
      results.push({ idx: i, dir: breakoutLong ? 1 : -1, isCompressed, volZ, ts_str: bar.ts_str, mod: bar.mod, date: bar.ts_str.substring(0, 10), entryPrice: bar.close });
    }
  }

  const noCompressionControl = results.filter(r => r.volZ >= 1.0);
  console.log(`NO_COMPRESSION_CONTROL (the already-validated arm): N=${noCompressionControl.length}`);

  // --- NEW: level-context classification per event ---
  let noLevelPrices = 0;
  for (const ev of noCompressionControl) {
    const td = ev.date;
    const levels = getLevelsForDate(td);
    ev.nearestLevel = null;
    ev.nearestDist = Infinity;
    if (!levels) { noLevelPrices++; continue; }
    const etMin = ev.mod;
    for (const [ln, lp] of Object.entries(levels)) {
      const formationMin = SAME_DAY_FORMING_MINUTE[ln];
      if (formationMin !== undefined && etMin < formationMin) continue; // not formed yet -- skip
      const dist = Math.abs(ev.entryPrice - lp);
      if (dist <= 15 && dist < ev.nearestDist) { ev.nearestLevel = ln; ev.nearestPrice = lp; ev.nearestDist = dist; }
    }
  }
  console.log(`Events with no level_prices row for their date at all: ${noLevelPrices}`);

  // acceptedTimeFrac for events that have a nearby level -- RTH session start 9:30 ET same day
  // (all these events are RTH bars, mod 570-959, by construction of the detection loop above).
  for (const ev of noCompressionControl) {
    ev.acceptedTimeFrac = null;
    if (ev.nearestLevel == null) continue;
    const lp = ev.nearestPrice;
    // direction convention matches the fade classifier: price above the level = approached
    // FROM_ABOVE-equivalent (far side = below); price below = far side above.
    const farSideBelow = ev.entryPrice > lp;
    let sessionBars = 0, acceptedBars = 0;
    for (let k = ev.idx - 1; k >= 0; k--) {
      const b = allBars[k];
      if (b.mod < 570 || b.mod > 959) break; // walked back past today's own RTH open
      if (b.ts_str.substring(0, 10) !== ev.date) break;
      sessionBars++;
      if (farSideBelow) { if (b.close < lp) acceptedBars++; } else { if (b.close > lp) acceptedBars++; }
    }
    ev.acceptedTimeFrac = sessionBars > 0 ? acceptedBars / sessionBars : null;
  }

  const withLevel = noCompressionControl.filter(ev => ev.nearestLevel != null && ev.acceptedTimeFrac != null);
  const noLevel = noCompressionControl.filter(ev => ev.nearestLevel == null);
  console.log(`Events with a nearby (<=15pt) formation-gated level and computable acceptedTimeFrac: ${withLevel.length}`);
  console.log(`Events with no nearby level: ${noLevel.length}`);

  // Terciles computed from the pooled "level nearby" population itself -- no static threshold.
  const sortedAcc = [...withLevel].map(e => e.acceptedTimeFrac).sort((a, b) => a - b);
  const t1 = sortedAcc[Math.floor(sortedAcc.length / 3)];
  const t2 = sortedAcc[Math.floor(2 * sortedAcc.length / 3)];
  console.log(`acceptedTimeFrac tercile cutoffs (data-derived): t1=${t1?.toFixed(3)} t2=${t2?.toFixed(3)}`);

  const defended = withLevel.filter(e => e.acceptedTimeFrac <= t1);   // bottom tercile = defended
  const undefended = withLevel.filter(e => e.acceptedTimeFrac >= t2); // top tercile = undefended
  console.log(`DEFENDED arm N=${defended.length}, UNDEFENDED arm N=${undefended.length} (middle tercile excluded from this comparison, per spec)`);

  // Confound check: is UNDEFENDED just a proxy for time-of-day (late session = more elapsed
  // bars = easier to accumulate a high acceptedTimeFrac) or for isCompressed?
  function meanOf(arr, fn) { return arr.length ? arr.reduce((s, e) => s + fn(e), 0) / arr.length : null; }
  for (const [label, arr] of [['NO_LEVEL', noLevel], ['DEFENDED', defended], ['UNDEFENDED', undefended]]) {
    const meanMod = meanOf(arr, e => e.mod);
    const hh = Math.floor(meanMod / 60), mm = Math.round(meanMod % 60);
    const compFrac = meanOf(arr, e => e.isCompressed ? 1 : 0);
    console.log(`[confound check] ${label}: mean ET time-of-day = ${hh}:${String(mm).padStart(2,'0')} (mod=${meanMod.toFixed(0)}), isCompressed frac = ${(compFrac*100).toFixed(1)}%`);
  }

  // --- Verbatim grid simulation from backtest_compression_breakout_stop_target_sim.mjs ---
  function getPercentile(arr, p) {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  }

  function prepareEvents(events) {
    for (const item of events) {
      item.tradeDir = item.dir; // NO_COMPRESSION_CONTROL trades WITH the breakout direction
      let maxBars = 0;
      for (let k = item.idx + 1; k < allBars.length; k++) {
        const b = allBars[k];
        if (b.mod >= 960 || b.mod < 570) break;
        maxBars++;
      }
      item.maxBars = maxBars;
      let mae = 0, mfe = 0, lastClose = item.entryPrice;
      for (let k = item.idx + 1; k <= item.idx + maxBars && k < allBars.length; k++) {
        const b = allBars[k];
        const adverse = item.tradeDir === 1 ? item.entryPrice - b.low : b.high - item.entryPrice;
        const favorable = item.tradeDir === 1 ? b.high - item.entryPrice : item.entryPrice - b.low;
        if (adverse > mae) mae = adverse;
        if (favorable > mfe) mfe = favorable;
        lastClose = b.close;
      }
      item.overallMae = mae; item.overallMfe = mfe;
      item.mtmPts = item.tradeDir === 1 ? lastClose - item.entryPrice : item.entryPrice - lastClose;
    }
  }

  prepareEvents(noLevel);
  prepareEvents(defended);
  prepareEvents(undefended);
  prepareEvents(noCompressionControl); // for the pre-registered headline cell (full population reference)

  const MAE_PCTS = [0.25, 0.40, 0.50, 0.60, 0.75, 0.90];
  const MFE_PCTS = [0.60, 0.75, 0.90];
  const HEADLINE_S = 138, HEADLINE_T = 102; // pre-registered, cited from the existing report before this run

  function simulateOne(ev, S, T) {
    let hitStop = false, hitTarget = false, pnl = 0;
    for (let k = ev.idx + 1; k <= ev.idx + ev.maxBars && k < allBars.length; k++) {
      const b = allBars[k];
      const adverse = ev.tradeDir === 1 ? ev.entryPrice - b.low : b.high - ev.entryPrice;
      const favorable = ev.tradeDir === 1 ? b.high - ev.entryPrice : ev.entryPrice - b.low;
      if (adverse > S) { hitStop = true; pnl = -S; break; }
      if (favorable >= T) { hitTarget = true; pnl = T; break; }
    }
    if (!hitStop && !hitTarget) pnl = ev.mtmPts;
    return pnl * LIVE_INSTRUMENT.dollarsPerPoint - LIVE_INSTRUMENT.commissionPerRoundTrip;
  }

  function simulatePopulation(name, events) {
    if (events.length === 0) return { name, N: 0, combinations: [], headline: null };
    const allMae = events.map(e => e.overallMae), allMfe = events.map(e => e.overallMfe);
    let stopCandidates = [...new Set(MAE_PCTS.map(p => Math.round(getPercentile(allMae, p))))].sort((a, b) => a - b);
    let targetCandidates = [...new Set(MFE_PCTS.map(p => Math.round(getPercentile(allMfe, p))))].sort((a, b) => a - b);
    if (!stopCandidates.includes(HEADLINE_S)) stopCandidates.push(HEADLINE_S);
    if (!targetCandidates.includes(HEADLINE_T)) targetCandidates.push(HEADLINE_T);

    const combinations = [];
    for (const S of stopCandidates) {
      for (const T of targetCandidates) {
        const pnlList = events.map(ev => ({ date: ev.date, dollars: simulateOne(ev, S, T) }));
        const pnlSum = pnlList.reduce((s, x) => s + x.dollars, 0);
        const wins = pnlList.filter(x => x.dollars > 0).length;
        const third = Math.floor(events.length / 3);
        const p1 = third > 0 ? pnlList.slice(0, third).reduce((a, x) => a + x.dollars, 0) / third : 0;
        const p2 = third > 0 ? pnlList.slice(third, 2 * third).reduce((a, x) => a + x.dollars, 0) / third : 0;
        const p3 = (events.length - 2 * third) > 0 ? pnlList.slice(2 * third).reduce((a, x) => a + x.dollars, 0) / (events.length - 2 * third) : 0;
        const signs = [p1, p2, p3].map(v => v > 0 ? '+' : '-').join('');
        const dateCounts = {};
        events.forEach(e => dateCounts[e.date] = (dateCounts[e.date] || 0) + 1);
        const top5Sum = Object.values(dateCounts).sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0);
        combinations.push({ S, T, evPerTrade: pnlSum / events.length, totalPnl: pnlSum, winRate: wins / events.length, signs, stable: signs === '+++' || signs === '---', top5Frac: top5Sum / events.length, distinctDates: Object.keys(dateCounts).length });
      }
    }
    combinations.sort((a, b) => b.evPerTrade - a.evPerTrade);
    const headline = combinations.find(c => c.S === HEADLINE_S && c.T === HEADLINE_T) || null;
    return { name, N: events.length, combinations, headline };
  }

  const rNoLevel = simulatePopulation('NO_LEVEL_NEARBY', noLevel);
  const rDefended = simulatePopulation('LEVEL_NEARBY_DEFENDED', defended);
  const rUndefended = simulatePopulation('LEVEL_NEARBY_UNDEFENDED', undefended);
  const rFull = simulatePopulation('FULL_NO_COMPRESSION_CONTROL_REFERENCE', noCompressionControl);

  function fmtTable(r) {
    let out = `\n### ${r.name} (N=${r.N})\n\n`;
    if (r.N === 0) return out + '(empty)\n';
    out += `| Stop | Target | EV/Trade | Win Rate | Stability | Top5DayFrac | DistinctDates |\n|---|---|---|---|---|---|---|\n`;
    for (const c of r.combinations) {
      out += `| ${c.S} | ${c.T} | $${c.evPerTrade.toFixed(2)} | ${(c.winRate * 100).toFixed(1)}% | ${c.signs} ${c.stable ? '(STABLE)' : '(MIXED)'} | ${(c.top5Frac * 100).toFixed(1)}% | ${c.distinctDates} |\n`;
    }
    return out;
  }

  let output = `# Compression Breakout — Level Context Test (Step 2 of docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md)\n\n`;
  output += `## Population\nFull NO_COMPRESSION_CONTROL (already-validated arm): N=${noCompressionControl.length}\n`;
  output += `- No level within 15pt (formation-gated): N=${rNoLevel.N}\n`;
  output += `- Level nearby, DEFENDED (bottom tercile acceptedTimeFrac, cutoff<=${t1?.toFixed(3)}): N=${rDefended.N}\n`;
  output += `- Level nearby, UNDEFENDED (top tercile acceptedTimeFrac, cutoff>=${t2?.toFixed(3)}): N=${rUndefended.N}\n`;
  output += `- Level nearby, middle tercile (excluded from this comparison): N=${withLevel.length - rDefended.N - rUndefended.N}\n\n`;

  output += `## Pre-registered kill condition (S=${HEADLINE_S}/T=${HEADLINE_T})\n\n`;
  output += `| Arm | N | EV/Trade | Stability |\n|---|---|---|---|\n`;
  output += `| NO_LEVEL_NEARBY (i) | ${rNoLevel.headline?.N ?? rNoLevel.N} | $${rNoLevel.headline ? rNoLevel.headline.evPerTrade.toFixed(2) : 'n/a'} | ${rNoLevel.headline ? rNoLevel.headline.signs : 'n/a'} |\n`;
  output += `| DEFENDED (ii) | ${rDefended.N} | $${rDefended.headline ? rDefended.headline.evPerTrade.toFixed(2) : 'n/a'} | ${rDefended.headline ? rDefended.headline.signs : 'n/a'} |\n`;
  output += `| UNDEFENDED (iii) | ${rUndefended.N} | $${rUndefended.headline ? rUndefended.headline.evPerTrade.toFixed(2) : 'n/a'} | ${rUndefended.headline ? rUndefended.headline.signs : 'n/a'} |\n`;
  output += `| FULL_REFERENCE | ${rFull.N} | $${rFull.headline ? rFull.headline.evPerTrade.toFixed(2) : 'n/a'} | ${rFull.headline ? rFull.headline.signs : 'n/a'} |\n\n`;

  if (rUndefended.headline && rNoLevel.headline) {
    const delta = rUndefended.headline.evPerTrade - rNoLevel.headline.evPerTrade;
    output += `**Delta (iii) - (i) at headline cell: $${delta.toFixed(2)}/trade.** `;
    output += delta >= 4 && rUndefended.headline.stable
      ? `Clears the pre-registered $4-5/trade bar with +++ stability.\n\n`
      : `Does NOT clear the pre-registered $4-5/trade bar with +++ stability -- per the spec, "undefended level -> trade the breakout instead" is CLOSED PERMANENTLY.\n\n`;
  } else {
    output += `**Cannot evaluate the kill condition — one or both arms have no data at the headline cell.**\n\n`;
  }

  output += `## Full grids (best cell first)\n`;
  output += fmtTable(rNoLevel);
  output += fmtTable(rDefended);
  output += fmtTable(rUndefended);
  output += fmtTable(rFull);

  fs.writeFileSync('reports/compression_breakout_level_context_test.md', output);
  console.log('Wrote reports/compression_breakout_level_context_test.md');
}

main().catch(console.error);
