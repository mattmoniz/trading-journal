// Part 2 (scoped) replay: IB_BULLISH / IB_BEARISH setup detection under CURRENT
// rules (server/routes/acd.js ~lines 2557-2607), replayed across all historical
// sessions. REPORT ONLY — does not touch live tables or logic.
//
// Mirrors the live detection exactly for the parts that affect entry/stop/target:
//  - IB window = price_bars between minute 570-599 ET (9:30-9:59)
//  - ibBullish = ibClose > ibMid && totalAsk > totalBid
//  - ibBearish = ibClose < ibMid && totalBid > totalAsk
//  - First-trigger scan: minutes 600-719 (10:00-11:59 ET, before noNewEntries at noon)
//    for first bar where currentPrice is on the "priceSide" of ibMid
//  - entry = round(currentPrice); stop = ibLow-2 (bull) / ibHigh+2 (bear)
//  - target = pdVAH/pdVAL if on correct side, else IB extension by 0.5*orRange
//  - Resolution: walk bars from fired_at to session end (13:00 ET), PRICE_CLEAN /
//    SAME_BAR_TIEBREAK (same logic as backfill_setup_resolutions.mjs), else EXPIRED.
//
// NOT replayed (informational-only in live, doesn't affect entry/stop/target/resolution):
//  - aUpFired/aDownFired "conflicting" WEAK/NORMAL signalQuality label

import pg from 'pg';
const pool = new pg.Pool({ host: 'localhost', port: 5432, database: 'trading_journal', user: 'trader', password: 'trader123' });
const q = (t, p) => pool.query(t, p);

const ET_IB_START = 570, ET_IB_END = 599;     // 9:30-9:59
const ET_TRIGGER_START = 600, ET_TRIGGER_END = 719; // 10:00-11:59
const ET_SESSION_END = 780; // 13:00

const sessionsQ = await q(`
  SELECT trade_date::text, or_high::float as or_high, or_low::float as or_low,
         a_up_level::float as a_up_level, a_up_fired, a_down_level::float as a_down_level, a_down_fired,
         day_type
  FROM acd_daily_log
  WHERE or_high IS NOT NULL AND or_low IS NOT NULL AND trade_date < CURRENT_DATE
  ORDER BY trade_date
`);

const results = [];
let priorDayVA = null; // { date, vah, val } cache for previous iteration

for (const sess of sessionsQ.rows) {
  const trade_date = sess.trade_date;
  const orH = sess.or_high, orL = sess.or_low;
  const orRange = (orH != null && orL != null) ? orH - orL : null;

  // IB bars (9:30-9:59)
  const ibBarsR = await q(`
    SELECT high::float, low::float, close::float, open::float,
           COALESCE(ask_volume,0)::int as ask_vol, COALESCE(bid_volume,0)::int as bid_vol
    FROM price_bars WHERE symbol='NQ' AND ts::date=$1
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN $2 AND $3
    ORDER BY ts
  `, [trade_date, ET_IB_START, ET_IB_END]);
  const ibBars = ibBarsR.rows;
  if (ibBars.length < 3) { results.push({ trade_date, outcome: 'NO_FIRE', reason: 'insufficient IB bars' }); continue; }

  const ibHigh = Math.max(...ibBars.map(b => b.high));
  const ibLow = Math.min(...ibBars.map(b => b.low));
  const ibMid = (ibHigh + ibLow) / 2;
  const ibClose = ibBars[ibBars.length - 1].close;
  const totalAsk = ibBars.reduce((s, b) => s + b.ask_vol, 0);
  const totalBid = ibBars.reduce((s, b) => s + b.bid_vol, 0);
  const ibBullish = ibClose > ibMid && totalAsk > totalBid;
  const ibBearish = ibClose < ibMid && totalBid > totalAsk;

  if (!ibBullish && !ibBearish) { results.push({ trade_date, outcome: 'NO_FIRE', reason: 'IB neither bullish nor bearish' }); continue; }
  const isBull = ibBullish;

  // signalQuality (conviction): conflicting if A-level tested in IB but didn't "fire"
  const aUpLevel = sess.a_up_level, aDownLevel = sess.a_down_level;
  const aUpFired = !!sess.a_up_fired, aDownFired = !!sess.a_down_fired;
  const aUpTestedInIB = aUpLevel && ibBars.some(b => b.high >= aUpLevel);
  const aDownTestedInIB = aDownLevel && ibBars.some(b => b.low <= aDownLevel);
  const conflicting = isBull ? (aUpTestedInIB && !aUpFired) : (aDownTestedInIB && !aDownFired);
  const signalQuality = conflicting ? 'WEAK' : 'NORMAL';

  // Prior day value area (VPOC, 35% either side), mirrors acd.js ~2233-2238
  const priorDayQ = await q(`SELECT MAX(ts::date)::text as d FROM price_bars WHERE symbol='NQ' AND ts::date < $1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [trade_date]);
  const priorDay = priorDayQ.rows[0]?.d;
  let pdVAH = null, pdVAL = null;
  if (priorDay) {
    const vaQ = await q(`
      WITH vp AS (SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol FROM price_bars WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ROUND(low/0.25)*0.25),
      total AS (SELECT SUM(vol) as t FROM vp), poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
      SELECT
        (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) cv FROM vp WHERE px>=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as vah,
        (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) cv FROM vp WHERE px<=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as val
      FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
    `, [priorDay]);
    if (vaQ.rows[0]) { pdVAH = vaQ.rows[0].vah; pdVAL = vaQ.rows[0].val; }
  }

  // Trigger scan: first bar 10:00-11:59 where currentPrice is on the priceSide of ibMid
  const triggerBarsR = await q(`
    SELECT ts, close::float FROM price_bars WHERE symbol='NQ' AND ts::date=$1
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN $2 AND $3
    ORDER BY ts
  `, [trade_date, ET_TRIGGER_START, ET_TRIGGER_END]);

  let fired = null;
  for (const bar of triggerBarsR.rows) {
    const priceSide = isBull ? bar.close > ibMid : bar.close < ibMid;
    if (priceSide) { fired = bar; break; }
  }
  if (!fired) { results.push({ trade_date, outcome: 'NO_FIRE', reason: 'priceSide never satisfied 10:00-11:59' }); continue; }

  const currentPrice = fired.close;
  const entry = +currentPrice.toFixed(0);
  const stop = isBull ? +(ibLow - 2).toFixed(0) : +(ibHigh + 2).toFixed(0);
  const target = isBull
    ? (pdVAH && pdVAH > currentPrice ? Math.round(pdVAH) : Math.round(ibHigh + (orRange || 0) * 0.5))
    : (pdVAL && pdVAL < currentPrice ? Math.round(pdVAL) : Math.round(ibLow - (orRange || 0) * 0.5));

  // Safety guard (mirrors live ~2832-2841)
  let t1 = target;
  if (t1 != null) {
    if ((isBull && t1 <= entry) || (!isBull && t1 >= entry)) t1 = null;
  }

  const setupType = isBull ? 'IB_BULLISH' : 'IB_BEARISH';

  if (t1 == null || stop == null) {
    results.push({ trade_date, outcome: 'NO_VIABLE_TARGET', setupType, entry, stop, t1: target });
    continue;
  }

  // Resolve: walk bars from fired_at (exclusive) to session end (13:00 ET)
  const resBarsR = await q(`
    SELECT ts, open::float, high::float, low::float, close::float
    FROM price_bars WHERE symbol='NQ' AND ts > $1 AND ts::date=$2
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) <= $3
    ORDER BY ts
  `, [fired.ts, trade_date, ET_SESSION_END]);

  let resolution = 'EXPIRED', method = null, resolvedAt = null, priceAtRes = null;
  for (const bar of resBarsR.rows) {
    const t1Hit = isBull ? bar.high >= t1 : bar.low <= t1;
    const stopHit = isBull ? bar.low <= stop : bar.high >= stop;
    if (t1Hit && stopHit) {
      const towardT1 = isBull ? (bar.open > entry) : (bar.open < entry);
      resolution = towardT1 ? 'TARGET_HIT' : 'STOP_HIT';
      method = 'SAME_BAR_TIEBREAK'; resolvedAt = bar.ts; priceAtRes = towardT1 ? t1 : stop;
      break;
    } else if (t1Hit) {
      resolution = 'TARGET_HIT'; method = 'PRICE_CLEAN'; resolvedAt = bar.ts; priceAtRes = t1; break;
    } else if (stopHit) {
      resolution = 'STOP_HIT'; method = 'PRICE_CLEAN'; resolvedAt = bar.ts; priceAtRes = stop; break;
    }
  }

  let pnl = null;
  if (resolution === 'TARGET_HIT') pnl = (isBull ? (t1 - entry) : (entry - t1)) * 5 - 5;
  else if (resolution === 'STOP_HIT') pnl = (isBull ? (stop - entry) : (entry - stop)) * 5 - 5;
  if (pnl != null) pnl = Math.round(pnl * 100) / 100;

  results.push({
    trade_date, outcome: 'FIRED', setupType, firedAt: fired.ts, entry, stop, t1, t1Source: target === t1 ? (isBull ? (pdVAH && pdVAH > currentPrice ? 'pdVAH' : 'IB_ext') : (pdVAL && pdVAL < currentPrice ? 'pdVAL' : 'IB_ext')) : null,
    resolution, method, resolvedAt, priceAtRes, pnl,
    riskPts: isBull ? entry - stop : stop - entry,
    rewardPts: isBull ? t1 - entry : entry - t1,
    signalQuality, dayType: sess.day_type,
  });
}

// ---- Report ----
const fired = results.filter(r => r.outcome === 'FIRED');
const noFire = results.filter(r => r.outcome === 'NO_FIRE');
const noViable = results.filter(r => r.outcome === 'NO_VIABLE_TARGET');

console.log(`Total sessions evaluated: ${results.length}`);
console.log(`Fired: ${fired.length}, No fire: ${noFire.length}, No viable target: ${noViable.length}`);

for (const type of ['IB_BULLISH', 'IB_BEARISH']) {
  const typeFired = fired.filter(r => r.setupType === type);
  const hits = typeFired.filter(r => r.resolution === 'TARGET_HIT').length;
  const stops = typeFired.filter(r => r.resolution === 'STOP_HIT').length;
  const expired = typeFired.filter(r => r.resolution === 'EXPIRED').length;
  const decided = hits + stops;
  console.log(`\n${type}: fired ${typeFired.length} times`);
  console.log(`  TARGET_HIT: ${hits}, STOP_HIT: ${stops}, EXPIRED: ${expired}`);
  console.log(`  Win rate (decided only): ${decided ? (hits/decided*100).toFixed(1) : 'n/a'}% (n=${decided})`);
  const avgRisk = typeFired.reduce((s,r)=>s+r.riskPts,0)/typeFired.length;
  const avgReward = typeFired.reduce((s,r)=>s+r.rewardPts,0)/typeFired.length;
  console.log(`  Avg risk: ${avgRisk.toFixed(1)}pts, avg reward: ${avgReward.toFixed(1)}pts`);
  const tiebreaks = typeFired.filter(r => r.method === 'SAME_BAR_TIEBREAK').length;
  console.log(`  SAME_BAR_TIEBREAK resolutions: ${tiebreaks}`);
  const negRisk = typeFired.filter(r => r.riskPts <= 0).length;
  const negReward = typeFired.filter(r => r.rewardPts <= 0).length;
  if (negRisk) console.log(`  WARNING: ${negRisk} setups with non-positive risk (stop on wrong side)`);
  if (negReward) console.log(`  WARNING: ${negReward} setups with non-positive reward (T1 on wrong side)`);
}

if (noViable.length) {
  console.log(`\nNo-viable-target sessions (T1 safety guard rejected):`);
  for (const r of noViable) console.log(`  ${r.trade_date} ${r.setupType} entry=${r.entry} stop=${r.stop} target=${r.t1}`);
}

console.log(`\nNo-fire reasons breakdown:`);
const reasonCounts = {};
for (const r of noFire) reasonCounts[r.reason] = (reasonCounts[r.reason]||0)+1;
for (const [reason, count] of Object.entries(reasonCounts)) console.log(`  ${reason}: ${count}`);

// ---- Part 3: cross-reference by ground-truth day type and conviction (signalQuality) ----
console.log(`\n\n=== PART 3: cross-reference (IB_BULLISH + IB_BEARISH combined) ===`);

function summarize(rows, label) {
  const decided = rows.filter(r => r.resolution === 'TARGET_HIT' || r.resolution === 'STOP_HIT');
  const hits = rows.filter(r => r.resolution === 'TARGET_HIT').length;
  const stops = rows.filter(r => r.resolution === 'STOP_HIT').length;
  const expired = rows.filter(r => r.resolution === 'EXPIRED').length;
  const wr = decided.length ? (hits/decided.length*100).toFixed(1) : 'n/a';
  const flag = decided.length < 20 ? '  [LIMITED SAMPLE n<20]' : '';
  console.log(`  ${label.padEnd(28)} n=${String(rows.length).padEnd(4)} TARGET_HIT=${String(hits).padEnd(3)} STOP_HIT=${String(stops).padEnd(3)} EXPIRED=${String(expired).padEnd(3)} winRate(decided)=${wr}% (n=${decided.length})${flag}`);
}

console.log(`\nBy ground-truth day type:`);
for (const dt of ['TREND', 'BALANCE', 'TURBULENT', null]) {
  const subset = fired.filter(r => r.dayType === dt);
  if (subset.length) summarize(subset, dt || '(no day_type)');
}

console.log(`\nBy conviction (signalQuality):`);
for (const sq of ['NORMAL', 'WEAK']) {
  const subset = fired.filter(r => r.signalQuality === sq);
  if (subset.length) summarize(subset, sq);
}

console.log(`\nBy day type x conviction:`);
for (const dt of ['TREND', 'BALANCE', 'TURBULENT']) {
  for (const sq of ['NORMAL', 'WEAK']) {
    const subset = fired.filter(r => r.dayType === dt && r.signalQuality === sq);
    if (subset.length) summarize(subset, `${dt} / ${sq}`);
  }
}

// Per-trade detail for cross-reference (Part 3)
import fs from 'fs';
fs.writeFileSync('/tmp/ib_replay_results.json', JSON.stringify(results, null, 2));

await pool.end();
