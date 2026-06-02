#!/usr/bin/env node
/**
 * Case Engine Backtest — last 30+ trading days
 * For every trigger that fires (impactScore >= 6), measures:
 *   A) RAW MFE/MAE  — walk to session close ignoring stops/targets
 *   B) REALIZED     — respect stop/T1 order of events
 * Under both 2T-bracket and 6-bar/50% exit schemes.
 */

import { query } from '../server/db.js';
import { getNL, getPriorWeekRange, getGLine } from '../server/services/queries.js';
import { getStructuralLevels } from '../server/services/phaseChangeDetector.js';

const RTH_START  = 570;  // 9:30 ET in minutes
const PTS_PER_$  = 20;   // NQ $20/point

// ── Helpers (same logic as caseEngine.js) ────────────────────────────────────

function barMins(ts) { const d = new Date(ts); return d.getUTCHours()*60 + d.getUTCMinutes(); }

function confirmedDelta(bars, n = 3, lookback = 15) {
  const win = bars.slice(Math.max(0, bars.length - lookback));
  if (win.length < n) return null;
  for (let e = win.length-1; e >= n-1; e--) {
    const sl = win.slice(e-n+1, e+1);
    const dl = sl.map(b => Number(b.ask_volume||0) - Number(b.bid_volume||0));
    const barsAgo = win.length-1-e;
    if (dl.every(d => d > 0)) return { dir: 'LONG',  barsAgo };
    if (dl.every(d => d < 0)) return { dir: 'SHORT', barsAgo };
  }
  return null;
}

// Mirror of caseEngine detectFailedAuctions
function detectFailedAuctions(bars, resistancePrices, supportPrices, probePts = 5, lookFwd = 5) {
  let failedAbove = 0, failedBelow = 0;
  let coolAbove = -1, coolBelow = -1;
  for (let i = 0; i < bars.length - 1; i++) {
    const bar = bars[i];
    if (i > coolAbove) {
      const lvl = resistancePrices.find(l => Number(bar.high) > l + probePts);
      if (lvl != null) {
        const fwd = bars.slice(i+1, i+lookFwd+1);
        if (fwd.some(b => Number(b.close) < lvl - probePts)) { failedAbove++; coolAbove = i+lookFwd; }
      }
    }
    if (i > coolBelow) {
      const lvl = supportPrices.find(l => Number(bar.low) < l - probePts);
      if (lvl != null) {
        const fwd = bars.slice(i+1, i+lookFwd+1);
        if (fwd.some(b => Number(b.close) > lvl + probePts)) { failedBelow++; coolBelow = i+lookFwd; }
      }
    }
  }
  return { failedAuctionsAbove: failedAbove, failedAuctionsBelow: failedBelow,
           fuelLong: failedBelow >= 2, fuelShort: failedAbove >= 2 };
}

function classifyDayType(bars, nl30, acd) {
  if (bars.length < 5) return 'FORMING';
  const f5 = bars.slice(0,5);
  const open = Number(f5[0].open), c5 = Number(f5[4].close);
  const h5 = Math.max(...f5.map(b=>Number(b.high))), l5 = Math.min(...f5.map(b=>Number(b.low)));
  const drift = c5-open, r5 = h5-l5;
  let ot;
  if (drift > 20 && f5.every((b,i)=>i===0||Number(b.low)>=Number(f5[i-1].low)-3)) ot='DRIVE_L';
  else if (drift<-20 && f5.every((b,i)=>i===0||Number(b.high)<=Number(f5[i-1].high)+3)) ot='DRIVE_S';
  else if (Math.abs(drift)<12 && r5<35) ot='AUCTION';
  else if (r5>18 && l5<open-8 && c5>open+8) ot='TDL';
  else if (r5>18 && h5>open+8 && c5<open-8) ot='TDS';
  else ot='BALANCED';

  const orW = acd ? acd.or_high - acd.or_low : 0;
  const isDrive = ot==='DRIVE_L'||ot==='DRIVE_S';
  const bull = nl30>9, bear = nl30<-9;
  if (isDrive && (bull||bear) && orW>80) return 'TREND';
  if (ot==='AUCTION' || (orW<40 && !isDrive)) return 'BALANCE';
  if (orW>80 && !isDrive) return 'TURBULENT';
  return 'BALANCE';
}

function computeImpact(bars, barIdx, setup, nl30, levels, dayTypeClass, failedAuctions) {
  const isLong = /LONG|UP|BULLISH/.test(setup.setup_type);
  const stop = Number(setup.stop_level||0), t1 = Number(setup.t1_level||0);
  const entryPx = Number(setup.entry_zone_high || setup.entry_zone_low || 0);

  let impact = 1;
  const stack = ['+1 setup'];

  // Delta (15-bar lookback, barsAgo <= 8)
  const delta = confirmedDelta(bars.slice(0, barIdx+1));
  if (delta?.dir === (isLong?'LONG':'SHORT') && delta.barsAgo <= 8) {
    impact += 2; stack.push(`+2 delta(${delta.barsAgo}ago)`);
  }
  // NL30
  if ((isLong && nl30>9) || (!isLong && nl30<-9)) { impact+=2; stack.push('+2 NL30'); }
  // At-level
  const near = levels.find(l => Math.abs(l.price-entryPx)<=20 && l.stars>=2);
  if (near) { impact+=1; stack.push('+1 lvl'); }
  // R:R at current bar price
  const px = Number(bars[barIdx].close);
  if (stop && t1) {
    const tgt = Math.abs(t1-px), rsk = Math.abs(px-stop);
    if (rsk>0 && tgt/rsk>=2.0) { impact+=2; stack.push(`+2 RR=${Math.round(tgt/rsk*10)/10}`); }
  }
  // Counter-trend
  if ((isLong && nl30<-9)||(!isLong && nl30>9)) { impact-=3; stack.push('-3 counter'); }
  // Low confluence
  if (setup.confluence_score_at_detection != null && setup.confluence_score_at_detection < 4) {
    impact-=2; stack.push('-2 lowconf');
  }
  // Day-type (INTERIM n=7)
  if      (dayTypeClass === 'BALANCE')                                  { impact-=3; stack.push('-3 BALANCE(interim)'); }
  else if (dayTypeClass === 'TURBULENT' || dayTypeClass === 'TREND')    { impact+=1; stack.push(`+1 ${dayTypeClass}(interim)`); }
  // Failed auction fuel (INTERIM) — guard: skip on BALANCE days
  if (dayTypeClass !== 'BALANCE') {
    if ( isLong && failedAuctions?.fuelLong)  { impact+=1; stack.push(`+1 FA-fuel-LONG(${failedAuctions.failedAuctionsBelow}x)`); }
    if (!isLong && failedAuctions?.fuelShort) { impact+=1; stack.push(`+1 FA-fuel-SHORT(${failedAuctions.failedAuctionsAbove}x)`); }
  }
  return { impact, stack };
}

function measureOutcome(bars, fireIdx, setup) {
  const isLong = /LONG|UP|BULLISH/.test(setup.setup_type);
  const entry  = Number(bars[fireIdx].close);
  const stop   = Number(setup.stop_level||0);
  const t1     = Number(setup.t1_level||0);
  const riskPts= Math.abs(entry-stop);
  const t1Pts  = Math.abs(t1-entry);

  const fwd = bars.slice(fireIdx+1);
  if (!fwd.length) return null;

  // ── A) RAW MFE/MAE ────────────────────────────────────────────────────────
  let rawMFE=0, rawMAE=0;
  for (const b of fwd) {
    const fav = isLong ? Number(b.high)-entry : entry-Number(b.low);
    const adv = isLong ? entry-Number(b.low)  : Number(b.high)-entry;
    rawMFE = Math.max(rawMFE, fav);
    rawMAE = Math.max(rawMAE, adv);
  }

  // ── B) REALIZED — order of events ─────────────────────────────────────────
  let hitT1=false, hitStop=false, t1First=null, barsToT1=null, barsToStop=null;
  for (let i=0; i<fwd.length; i++) {
    const b = fwd[i];
    const t1hit   = t1   && (isLong ? Number(b.high)>=t1   : Number(b.low)<=t1  );
    const stophit = stop && (isLong ? Number(b.low)<=stop  : Number(b.high)>=stop);
    if (t1hit   && !hitT1)   { hitT1  =true; barsToT1  =i+1; }
    if (stophit && !hitStop) { hitStop=true; barsToStop=i+1; }
    if (hitT1 && hitStop && t1First===null) {
      if      (barsToT1 < barsToStop) t1First=true;
      else if (barsToStop < barsToT1) t1First=false;
      else t1First = isLong ? Number(b.close)>=Number(b.open) : Number(b.close)<=Number(b.open);
      break;
    }
    if (hitT1  && t1First===null) { t1First=true;  break; }
    if (hitStop&& t1First===null) { t1First=false; break; }
  }

  // 2T-bracket R  (T2 = same distance beyond T1)
  const t2 = entry + (t1-entry)*2;
  let bracket2R = null;
  if (riskPts>0) {
    if (t1First===true) {
      // Half out at T1; second half rides to T2 or BE stop
      const t2Bars = barsToT1!=null ? fwd.slice(barsToT1) : fwd;
      const t2Hit  = t2Bars.some(b => isLong ? Number(b.high)>=t2 : Number(b.low)<=t2);
      const beHit  = t2Bars.some(b => isLong ? Number(b.low)<=entry : Number(b.high)>=entry);
      if (t2Hit) {
        bracket2R = (0.5*t1Pts + 0.5*Math.abs(t2-entry)) / riskPts;
      } else if (beHit) {
        bracket2R = 0.5*t1Pts / riskPts; // half at T1, second BE'd out at 0
      } else {
        // Session close
        const lp = t2Bars.length ? Number(t2Bars[t2Bars.length-1].close) : entry;
        bracket2R = (0.5*t1Pts + 0.5*Math.max(0, isLong?lp-entry:entry-lp)) / riskPts;
      }
    } else if (t1First===false) {
      bracket2R = -1.0;
    } else {
      // Neither hit — session close
      const lp = fwd.length ? Number(fwd[fwd.length-1].close) : entry;
      bracket2R = (isLong?lp-entry:entry-lp) / riskPts;
    }
    bracket2R = Math.round(bracket2R*100)/100;
  }

  // 6-bar / 50% rule  (uses 1-min bars as proxy for 500-vol bars)
  const half50  = entry + (t1-entry)*0.5;
  let sixBarR   = null;
  if (riskPts>0 && fwd.length>0) {
    let hit50 = false;
    for (let i=0; i<Math.min(6, fwd.length); i++) {
      const b = fwd[i];
      if (isLong ? Number(b.high)>=half50 : Number(b.low)<=half50) { hit50=true; break; }
    }
    if (hit50) {
      sixBarR = bracket2R; // same resolution after clearing 50%
    } else {
      const ei = Math.min(5, fwd.length-1);
      const exitPx = Number(fwd[ei].close);
      sixBarR = Math.round(((isLong?exitPx-entry:entry-exitPx)/riskPts)*100)/100;
    }
  }

  // Flag: rawMFE >= T1 distance but trade was a loss (stop hit first)
  const mfeExceededT1ButLost = rawMFE >= t1Pts && t1First === false;

  // HOLD/TRAIL exit: half at T1, second half trails 25pts behind extreme
  // Used for TREND day comparison. Replaces the 2T-bracket fixed target.
  let trailR = null;
  if (riskPts > 0 && t1First === true && barsToT1 != null) {
    const afterT1 = fwd.slice(barsToT1);
    const t1Price  = isLong ? entry + t1Pts : entry - t1Pts;
    let trailStop  = isLong ? t1Price - 25 : t1Price + 25; // initial trail
    let bestX      = t1Price;
    let trailExitPx = t1Price; // default: exit at T1 if no afterT1 bars
    for (const b of afterT1) {
      if (isLong) {
        bestX      = Math.max(bestX, Number(b.high));
        trailStop  = Math.max(trailStop, bestX - 25);
        if (Number(b.low) <= trailStop) { trailExitPx = trailStop; break; }
      } else {
        bestX      = Math.min(bestX, Number(b.low));
        trailStop  = Math.min(trailStop, bestX + 25);
        if (Number(b.high) >= trailStop) { trailExitPx = trailStop; break; }
      }
      trailExitPx = Number(b.close); // update to session close if trail never hit
    }
    const halfR_T1    = 0.5 * t1Pts / riskPts;
    const trailPnl    = isLong ? trailExitPx - entry : entry - trailExitPx;
    const halfR_trail = 0.5 * Math.max(0, trailPnl) / riskPts;
    trailR = Math.round((halfR_T1 + halfR_trail) * 100) / 100;
  }

  return {
    entry, stop, t1, t1Pts: Math.round(t1Pts*4)/4, riskPts: Math.round(riskPts*4)/4,
    rawMFE: Math.round(rawMFE*4)/4,
    rawMAE: Math.round(rawMAE*4)/4,
    rawMFE_$: Math.round(rawMFE*PTS_PER_$),
    rawMAE_$: Math.round(rawMAE*PTS_PER_$),
    hitT1, hitStop, t1First, barsToT1, barsToStop,
    bracket2R, sixBarR, trailR,
    mfeExceededT1ButLost,
    mfeToT1Ratio: t1Pts>0 ? Math.round(rawMFE/t1Pts*100)/100 : null,
    juiceRR: riskPts>0 ? Math.round(t1Pts/riskPts*10)/10 : null,
  };
}

// ── Per-day driver ────────────────────────────────────────────────────────────

async function backtestDay(date) {
  const [barsQ, acdQ, setupsQ, nlRes, pwRes, gLineVal, structLvls] = await Promise.all([
    query(`SELECT ts, open::float, high::float, low::float, close::float,
                  volume::int, bid_volume::int, ask_volume::int
           FROM price_bars WHERE symbol='NQ' AND ts::date=$1
             AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) >= 570
             AND EXTRACT(hour FROM ts) < 16
           ORDER BY ts`, [date]),
    query(`SELECT or_high::float, or_low::float, a_up_level::float, a_down_level::float
           FROM acd_daily_log WHERE trade_date=$1`, [date]),
    query(`SELECT id, setup_type, fired_at, entry_zone_low::float, entry_zone_high::float,
                  stop_level::float, t1_level::float,
                  confluence_score_at_detection::int, nl30_at_detection::int
           FROM active_setups WHERE trade_date=$1 ORDER BY fired_at`, [date]),
    getNL({ asOf: date }),
    getPriorWeekRange(date),
    getGLine(date),
    getStructuralLevels(date).catch(() => []),
  ]);

  const bars   = barsQ.rows;
  const acd    = acdQ.rows[0] || null;
  const setups = setupsQ.rows;
  const nl30   = nlRes.nl30;
  const { pwHigh, pwLow } = pwRes;
  if (!bars.length || !setups.length) return [];

  const ibBars = bars.filter(b => barMins(b.ts) < RTH_START+60);
  const ibH    = ibBars.length ? Math.max(...ibBars.map(b=>Number(b.high))) : null;
  const ibL    = ibBars.length ? Math.min(...ibBars.map(b=>Number(b.low)))  : null;

  // Simplified level set (stars matter for at-level bonus)
  const levels = [
    ibH    && { price: ibH,   stars: 1 },
    ibL    && { price: ibL,   stars: 1 },
    acd?.a_up_level   && { price: acd.a_up_level,   stars: 2 },
    acd?.a_down_level && { price: acd.a_down_level, stars: 2 },
    pwHigh && { price: pwHigh, stars: 3 },
    pwLow  && { price: pwLow,  stars: 3 },
    gLineVal && { price: gLineVal, stars: 2 },
    ...structLvls.map(s => ({
      price: s.price,
      stars: s.type?.includes('POC') ? 2 : s.type?.includes('VAH')||s.type?.includes('VAL') ? 2 : 1
    })),
  ].filter(Boolean);

  const dayType = classifyDayType(bars, nl30, acd);

  // Compression score for this day
  const priorOrQ = await query(`
    SELECT (or_high - or_low)::float AS orw FROM acd_daily_log
    WHERE trade_date < $1 AND or_high IS NOT NULL AND or_low IS NOT NULL
    ORDER BY trade_date DESC LIMIT 6
  `, [date]);
  const priorORs = priorOrQ.rows.map(r=>Number(r.orw)).filter(w=>w>0);
  const todayOR  = acd ? (acd.or_high - acd.or_low) : 0;
  let compressionScore = 0;
  if (todayOR > 0 && priorORs.length >= 3) {
    if (todayOR < Math.min(...priorORs.slice(0,3))) compressionScore += 3;
    if (priorORs.length >= 6 && todayOR < Math.min(...priorORs)) compressionScore += 2;
    const avgOR = priorORs.reduce((a,b)=>a+b,0)/priorORs.length;
    if (todayOR < avgOR * 0.65) compressionScore += 1;
  }
  const coiled = compressionScore >= 4;

  // Failed auction detection using explicit resistance/support levels
  const resistancePx = [ibH, acd?.a_up_level, pwHigh].filter(Boolean).map(Number);
  const supportPx    = [ibL, acd?.a_down_level, pwLow].filter(Boolean).map(Number);
  const failedAuctions = detectFailedAuctions(bars, resistancePx, supportPx);

  const results = [];

  for (const setup of setups) {
    const isLong  = /LONG|UP|BULLISH/.test(setup.setup_type);
    const stop    = Number(setup.stop_level||0);
    const t1      = Number(setup.t1_level||0);
    if (!stop || !t1) continue;

    // Find bar at or after fired_at
    const firedTs = new Date(setup.fired_at);
    const startIdx = bars.findIndex(b => new Date(b.ts) >= firedTs);
    if (startIdx < 0) continue;

    // Walk forward to find first bar where impact >= 6
    let fireIdx=null, fireImpact=null, fireStack=null;
    for (let i=startIdx; i<bars.length; i++) {
      const { impact, stack } = computeImpact(bars, i, setup, nl30, levels, dayType, failedAuctions);
      if (impact >= 6) { fireIdx=i; fireImpact=impact; fireStack=stack; break; }
    }

    // Whether suppressed: compute max achievable impact at the most favorable bar
    let maxImpact = 0;
    for (let i=startIdx; i<bars.length; i++) {
      const { impact } = computeImpact(bars, i, setup, nl30, levels, dayType, failedAuctions);
      maxImpact = Math.max(maxImpact, impact);
    }

    if (fireIdx===null) {
      results.push({
        date, dayType, nl30, suppressed: true, compressionScore, coiled,
        setup_type: setup.setup_type,
        direction: isLong?'LONG':'SHORT',
        maxImpact,
        failedAuctionsAbove: failedAuctions.failedAuctionsAbove,
        failedAuctionsBelow: failedAuctions.failedAuctionsBelow,
        // Still measure outcome from setup fired_at for counter-factual
        outcome: startIdx < bars.length ? measureOutcome(bars, startIdx, setup) : null,
      });
      continue;
    }

    const outcome = measureOutcome(bars, fireIdx, setup);
    if (!outcome) continue;

    const fireBarTs = new Date(bars[fireIdx].ts).toISOString().slice(11,16);

    results.push({
      date, dayType, nl30, suppressed: false, compressionScore, coiled,
      setup_type: setup.setup_type,
      direction: isLong?'LONG':'SHORT',
      fireTime: fireBarTs,
      impactScore: fireImpact,
      impactStack: fireStack,
      failedAuctionsAbove: failedAuctions.failedAuctionsAbove,
      failedAuctionsBelow: failedAuctions.failedAuctionsBelow,
      ...outcome,
    });
  }

  return results;
}

// ── Summarize ─────────────────────────────────────────────────────────────────

function pct(n, d) { return d>0 ? Math.round(n/d*1000)/10+'%' : 'n/a'; }
function avg(arr)   { return arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length*10)/10 : null; }
function med(arr)   { if (!arr.length) return null; const s=[...arr].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; }

function summarize(all) {
  const fired     = all.filter(r => !r.suppressed);
  const suppressed= all.filter(r =>  r.suppressed);
  const days      = [...new Set(all.map(r=>r.date))].length;

  console.log('\n══════════════════════════════════════════════════════');
  console.log('  CASE ENGINE BACKTEST — FULL SUMMARY');
  console.log('══════════════════════════════════════════════════════\n');

  // ── 1. TRIGGER FREQUENCY ────────────────────────────────────────────────────
  console.log('── 1. TRIGGER FREQUENCY ───────────────────────────────');
  console.log(`  Trading days scanned : ${days}`);
  console.log(`  Total triggers fired : ${fired.length}  (${(fired.length/days).toFixed(1)}/day avg)`);
  console.log(`  Suppressed signals   : ${suppressed.length}  (never reached impact 6)`);
  console.log('');

  const bySetup = {};
  for (const r of fired) {
    bySetup[r.setup_type] = (bySetup[r.setup_type]||0)+1;
  }
  console.log('  By setup type:');
  for (const [k,v] of Object.entries(bySetup).sort((a,b)=>b[1]-a[1])) {
    console.log(`    ${k.padEnd(25)} ${v}`);
  }
  console.log('');

  const byDay = {};
  for (const r of fired) { byDay[r.dayType]=(byDay[r.dayType]||0)+1; }
  console.log('  By day type:');
  for (const [k,v] of Object.entries(byDay)) console.log(`    ${k.padEnd(20)} ${v}`);
  console.log('');

  // ── 2. OUTCOME QUALITY ──────────────────────────────────────────────────────
  console.log('── 2. OUTCOME QUALITY (REALIZED, 2T bracket) ─────────');
  const withOutcome = fired.filter(r => r.bracket2R !== null);
  const wins  = withOutcome.filter(r => r.t1First===true);
  const losses= withOutcome.filter(r => r.t1First===false);
  const open  = withOutcome.filter(r => r.t1First===null);
  console.log(`  Hit T1 first     : ${wins.length}  (${pct(wins.length, withOutcome.length)})`);
  console.log(`  Hit stop first   : ${losses.length}  (${pct(losses.length, withOutcome.length)})`);
  console.log(`  Neither (open)   : ${open.length}`);
  console.log('');
  console.log(`  Avg raw MFE      : ${avg(fired.map(r=>r.rawMFE))} pts  /  $${avg(fired.map(r=>r.rawMFE_$))}`);
  console.log(`  Avg raw MAE      : ${avg(fired.map(r=>r.rawMAE))} pts  /  $${avg(fired.map(r=>r.rawMAE_$))}`);
  console.log(`  Avg T1 distance  : ${avg(fired.map(r=>r.t1Pts))} pts`);
  console.log(`  Avg risk (stop)  : ${avg(fired.map(r=>r.riskPts))} pts`);
  console.log('');

  const mfeToT1Ratios = fired.map(r=>r.mfeToT1Ratio).filter(v=>v!=null);
  console.log(`  MFE/T1 ratio     : avg=${avg(mfeToT1Ratios)}  med=${med(mfeToT1Ratios)}`);
  const mfePastT1 = fired.filter(r => r.mfeToT1Ratio != null && r.mfeToT1Ratio >= 1.0);
  console.log(`  MFE exceeded T1  : ${mfePastT1.length}/${fired.length}  (${pct(mfePastT1.length,fired.length)})`);
  console.log('');

  // Compare exit schemes
  const br2Rs  = withOutcome.map(r=>r.bracket2R).filter(v=>v!=null);
  const sb6Rs  = withOutcome.map(r=>r.sixBarR).filter(v=>v!=null);
  console.log(`  Avg realized R — 2T bracket  : ${avg(br2Rs)}`);
  console.log(`  Avg realized R — 6-bar/50%   : ${avg(sb6Rs)}`);
  console.log(`  Median R — 2T bracket        : ${med(br2Rs)}`);
  console.log(`  Median R — 6-bar/50%         : ${med(sb6Rs)}`);
  console.log('');

  // ── 3. MFE BLEED CHECK ──────────────────────────────────────────────────────
  console.log('── 3. MFE BLEED CHECK ────────────────────────────────');
  const bleed = fired.filter(r => r.mfeExceededT1ButLost);
  console.log(`  Triggers where MFE >= T1 but stop hit first: ${bleed.length}/${fired.length}  (${pct(bleed.length,fired.length)})`);
  if (bleed.length > 0) {
    console.log(`  These had available MFE of ${avg(bleed.map(r=>r.rawMFE))} pts avg`);
    console.log(`  but were stopped for avg MAE of ${avg(bleed.map(r=>r.rawMAE))} pts`);
    console.log(`  (the trade was right directionally but the stop was hit first)`);
    console.log('  Sample bleed cases:');
    bleed.slice(0,4).forEach(r => {
      console.log(`    ${r.date} ${r.setup_type} ${r.direction}  MFE=${r.rawMFE} T1Dist=${r.t1Pts} MAE=${r.rawMAE} RiskPts=${r.riskPts}`);
    });
  }
  console.log('');

  // ── 4. BY DAY TYPE ──────────────────────────────────────────────────────────
  console.log('── 4. PERFORMANCE BY DAY TYPE ────────────────────────');
  const dayTypes = [...new Set(fired.map(r=>r.dayType))];
  for (const dt of dayTypes) {
    const dtFired = fired.filter(r => r.dayType===dt && r.bracket2R!==null);
    if (!dtFired.length) continue;
    const dtWins = dtFired.filter(r=>r.t1First===true);
    const dtR    = dtFired.map(r=>r.bracket2R).filter(v=>v!=null);
    console.log(`  ${dt.padEnd(12)} | n=${dtFired.length}  T1%=${pct(dtWins.length,dtFired.length)}  avgR=${avg(dtR)}`);
  }
  console.log('');

  // Counter-trend suppressed spot-check (5 samples)
  const ctrSupp = suppressed.filter(r => r.outcome);
  console.log(`  Counter-trend suppressed signals: ${suppressed.length} total`);
  console.log(`  Spot-check (would they have lost?): first 5 with outcomes`);
  ctrSupp.slice(0,5).forEach(r => {
    const o = r.outcome;
    const result = o.t1First===true ? `WIN  (T1 in ${o.barsToT1}b)` :
                   o.t1First===false? `LOSS (stop in ${o.barsToStop}b)` : 'OPEN';
    console.log(`    ${r.date} ${r.setup_type.padEnd(22)} ${r.direction}  maxImpact=${r.maxImpact}  → ${result}  rawMFE=${o.rawMFE} rawMAE=${o.rawMAE}`);
  });
  console.log('');

  // ── 5. JUICE VALIDATION ─────────────────────────────────────────────────────
  console.log('── 5. JUICE VALIDATION (R:R >= 2.0 at fire) ─────────');
  const juicy    = fired.filter(r => r.juiceRR!=null && r.juiceRR>=2.0 && r.bracket2R!=null);
  const notJuicy = fired.filter(r => r.juiceRR!=null && r.juiceRR < 2.0 && r.bracket2R!=null);
  const jWins    = juicy.filter(r=>r.t1First===true);
  const njWins   = notJuicy.filter(r=>r.t1First===true);
  console.log(`  juice.worthIt=true  (R:R>=2): n=${juicy.length}  T1%=${pct(jWins.length,juicy.length)}  avgR=${avg(juicy.map(r=>r.bracket2R))}`);
  console.log(`  juice.worthIt=false (R:R<2):  n=${notJuicy.length}  T1%=${pct(njWins.length,notJuicy.length)}  avgR=${avg(notJuicy.map(r=>r.bracket2R))}`);
  console.log('');

  // ── 6. COMPRESSION CORRELATION ──────────────────────────────────────────────
  console.log('── 6. COMPRESSION CORRELATION (coiled = score >= 4) ──');
  const coiledWins  = fired.filter(r => r.coiled && r.t1First === true);
  const coiledLoss  = fired.filter(r => r.coiled && r.t1First === false);
  const warmWins    = fired.filter(r => !r.coiled && r.t1First === true);
  const warmLoss    = fired.filter(r => !r.coiled && r.t1First === false);
  console.log(`  COILED days that fired: ${coiledWins.length} wins, ${coiledLoss.length} losses`);
  console.log(`  Non-coiled days fired : ${warmWins.length} wins, ${warmLoss.length} losses`);
  console.log(`  Compression scores on fired days:`);
  fired.forEach(r => {
    const res = r.t1First===true?'WIN':r.t1First===false?'LOSS':'OPEN';
    console.log(`    ${r.date} ${r.setup_type.padEnd(22)} day=${r.dayType.padEnd(10)} comprScore=${r.compressionScore}${r.coiled?' COILED':''} → ${res}`);
  });
  console.log('');

  // ── 7. HOLD/TRAIL vs 2T BRACKET (TREND days) ────────────────────────────────
  console.log('── 7. HOLD/TRAIL vs 2T BRACKET (TREND days) ─────────');
  const trendFired = fired.filter(r => r.dayType === 'TREND' && r.bracket2R !== null);
  if (!trendFired.length) {
    console.log('  No TREND day triggers in this sample.');
  } else {
    for (const r of trendFired) {
      const res = r.t1First===true ? `T1 in ${r.barsToT1}b` : r.t1First===false ? `STOP in ${r.barsToStop}b` : 'OPEN';
      console.log(`  ${r.date} ${r.setup_type}  ${res}`);
      console.log(`    2T bracket : ${r.bracket2R}R`);
      console.log(`    HOLD/TRAIL : ${r.trailR ?? 'n/a'}R  (half at T1 + trail 25pts, ${r.rawMFE}pt MFE available)`);
      if (r.trailR != null && r.bracket2R != null) {
        const delta = Math.round((r.trailR - r.bracket2R) * 100) / 100;
        console.log(`    Delta      : ${delta > 0 ? '+' : ''}${delta}R vs 2T bracket`);
      }
    }
  }
  console.log('');

  // ── 8. FAILED AUCTION FUEL SIGNAL ───────────────────────────────────────────
  console.log('── 8. FAILED AUCTION SIGNAL ──────────────────────────');
  console.log('  (fuel = 2+ failed probes at opposite extreme before trigger)');
  const withFuel = fired.filter(r => {
    const isLong = /LONG|UP|BULLISH/.test(r.setup_type);
    return (isLong && (r.failedAuctionsBelow||0) >= 2 && r.dayType !== 'BALANCE') ||
           (!isLong && (r.failedAuctionsAbove||0) >= 2 && r.dayType !== 'BALANCE');
  });
  const fuelWins = withFuel.filter(r => r.t1First===true);
  const noFuel   = fired.filter(r => !withFuel.includes(r));
  const noFuelW  = noFuel.filter(r => r.t1First===true);
  console.log(`  Fuel signal present  : n=${withFuel.length}  T1%=${pct(fuelWins.length,withFuel.length)}  avgR=${avg(withFuel.map(r=>r.bracket2R).filter(v=>v!=null))}`);
  console.log(`  No fuel signal       : n=${noFuel.length}  T1%=${pct(noFuelW.length,noFuel.length)}  avgR=${avg(noFuel.map(r=>r.bracket2R).filter(v=>v!=null))}`);
  fired.forEach(r => {
    const hasFuel = (r.failedAuctionsBelow >= 2 && /LONG|UP|BULLISH/.test(r.setup_type)) ||
                    (r.failedAuctionsAbove >= 2 && !(/LONG|UP|BULLISH/.test(r.setup_type)));
    if (r.failedAuctionsAbove > 0 || r.failedAuctionsBelow > 0) {
      console.log(`    ${r.date} ${r.setup_type.padEnd(22)} FA-above=${r.failedAuctionsAbove} FA-below=${r.failedAuctionsBelow} ${hasFuel?'→ FUEL ACTIVE':''}`);
    }
  });
  console.log('');

  // ── RAW JSON for each trigger (for reference) ────────────────────────────────
  console.log('── TRIGGER LOG (all fired) ───────────────────────────');
  for (const r of fired) {
    const res = r.t1First===true ? `T1(${r.barsToT1}b)` : r.t1First===false ? `STOP(${r.barsToStop}b)` : 'OPEN';
    const rDisp = r.bracket2R!=null ? `2T=${r.bracket2R}R  trail=${r.trailR??'n/a'}R` : 'no-outcome';
    console.log(`  ${r.date} ${(r.fireTime||'??:??').slice(0,5)} ${r.setup_type.padEnd(22)} ${r.direction.padEnd(6)} impact=${r.impactScore}  MFE=${r.rawMFE}pts($${r.rawMFE_$})  MAE=${r.rawMAE}pts  ${res}  ${rDisp}  day=${r.dayType}  comp=${r.compressionScore}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const datesQ = await query(`
    SELECT DISTINCT ts::date::text as d FROM price_bars
    WHERE symbol='NQ' AND ts::date >= CURRENT_DATE - 35 AND ts::date <= CURRENT_DATE
    ORDER BY d
  `);
  const dates = datesQ.rows.map(r => r.d);
  console.log(`Backtesting ${dates.length} trading days...`);

  const all = [];
  for (const date of dates) {
    process.stdout.write(`  ${date} ... `);
    try {
      const results = await backtestDay(date);
      all.push(...results);
      const f = results.filter(r=>!r.suppressed).length;
      const s = results.filter(r=> r.suppressed).length;
      console.log(`${f} fired, ${s} suppressed`);
    } catch(e) {
      console.log(`ERROR: ${e.message}`);
    }
  }

  summarize(all);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
