// Setup D "big-break" population -- does the COMBINATION of opening-range width and
// relative volume (RVol = today's OR-window volume / trailing-N-day average for that
// same window, prior days only, no lookahead) predict real trade outcome, not just
// session range alone? User's own idea (2026-08-31), following up on the monster-day
// early-warning screen (RESEARCH_CLAIM setup_d_monster_day_predictors_corrected_still_negative)
// which found OR range alone predicts big-but-choppier days, not better ones.
//
// Deliberately sweeps 5 RVol lookback windows (10/15/20/25/30 days) BEFORE trusting any
// single one -- the user's own habitual 10-day convention initially looked good, then
// reversed sign under a chronological-stability check; sweeping the neighborhood shows
// 15/20/25/30 all agree (direction holds in both chronological halves) while only the
// thinnest, 10-day version disagrees -- consistent with 10-day being the noisy outlier,
// not the "true" answer. RESEARCH_CLAIM setup_d_range_rvol_combo_robust_across_windows.
//
// Run: node scripts/backtest_setup_d_range_rvol_combo.mjs
import { classifyACDOpeningCall } from '../server/services/openingCallClassifier.js';
import { resolve, loadData } from './backtest_unified.js';

const WIN = { orEndMin: 585, confirmEndMin: 615 };
const WALK_MAX_BARS = 240;
const STOP = 159, TARGET = 80;
function pnl(entry, exitPrice, long) { return (long ? (exitPrice - entry) : (entry - exitPrice)) * 2 - 2; }

async function buildRecords(rvolWindow) {
  const { barsByDate, acdByDate, dates } = await loadData();
  const orRangeHistory = [], orVolHistory = [];
  const records = [];
  for (const date of dates) {
    let bars = barsByDate.get(date);
    const acd = acdByDate.get(date);
    if (!bars || !acd) continue;
    bars = bars.map(b => ({ ...b, mod: Number(b.tod) }));
    const orBars = bars.filter(b => b.tod >= 570 && b.tod < WIN.orEndMin);
    const confirmBars = bars.filter(b => b.tod >= 570 && b.tod < WIN.confirmEndMin);
    if (orBars.length < 3 || confirmBars.length < 5) continue;
    const orH = Math.max(...orBars.map(b => b.high));
    const orL = Math.min(...orBars.map(b => b.low));
    const orRange = orH - orL || 1;
    const orVol = orBars.reduce((s, b) => s + (b.bid_vol + b.ask_vol), 0);
    const priorOrVols = orVolHistory.slice(-rvolWindow);
    const avgPriorOrVol = priorOrVols.length >= 5 ? priorOrVols.reduce((s,v)=>s+v,0)/priorOrVols.length : null;
    const rvol = avgPriorOrVol ? orVol / avgPriorOrVol : null;
    orVolHistory.push(orVol);
    orRangeHistory.push(orRange);
    const call = classifyACDOpeningCall(confirmBars, orH, orL);
    if (!call || call.type !== 'OPEN_DRIVE') continue;
    const isLong = call.driveDirection === 'UP';
    const direction = isLong ? 'LONG' : 'SHORT';
    const confirmEndIdx = bars.findIndex(b => b.tod >= WIN.confirmEndMin);
    if (confirmEndIdx === -1) continue;
    const confirmCloseBar = bars[confirmEndIdx];
    const driveMag = isLong ? (confirmCloseBar.close - orH) / orRange : (orL - confirmCloseBar.close) / orRange;
    if (driveMag < 0.479) continue;
    if (rvol == null) continue;
    const entry = confirmCloseBar.close;
    const stopPx = isLong ? entry - STOP : entry + STOP;
    const targetPx = isLong ? entry + TARGET : entry - TARGET;
    const res = resolve(bars, confirmEndIdx, direction, entry, stopPx, targetPx, WALK_MAX_BARS);
    let realPnl = res.result !== 'EXPIRED' ? res.pnl : (() => {
      const cutoff = bars[Math.min(bars.length - 1, confirmEndIdx + WALK_MAX_BARS)];
      return pnl(entry, cutoff.close, direction === 'LONG');
    })();
    records.push({ date, orRange, rvol, pnl: realPnl });
  }
  return records;
}

function meanOf(pop) { return pop.length ? pop.reduce((s,r)=>s+r.pnl,0)/pop.length : null; }

async function testWindow(rvolWindow) {
  const records = await buildRecords(rvolWindow);
  const sorted = [...records].sort((a,b)=>a.date.localeCompare(b.date));
  const rangeMed = [...records].sort((a,b)=>a.orRange-b.orRange)[Math.floor(records.length/2)].orRange;
  const rvolMed = [...records].sort((a,b)=>a.rvol-b.rvol)[Math.floor(records.length/2)].rvol;

  const hh = records.filter(r=>r.orRange>=rangeMed && r.rvol>=rvolMed);
  const ll = records.filter(r=>r.orRange<rangeMed && r.rvol<rvolMed);

  const half = Math.floor(sorted.length/2);
  const firstHalf = sorted.slice(0, half), secondHalf = sorted.slice(half);
  const hhFirst = firstHalf.filter(r=>r.orRange>=rangeMed && r.rvol>=rvolMed);
  const llFirst = firstHalf.filter(r=>r.orRange<rangeMed && r.rvol<rvolMed);
  const hhSecond = secondHalf.filter(r=>r.orRange>=rangeMed && r.rvol>=rvolMed);
  const llSecond = secondHalf.filter(r=>r.orRange<rangeMed && r.rvol<rvolMed);

  console.log(`\n=== RVol window = ${rvolWindow} days ===`);
  console.log(`Full sample: HIGH+HIGH N=${hh.length} avgPnL=$${meanOf(hh)?.toFixed(2)} | LOW+LOW N=${ll.length} avgPnL=$${meanOf(ll)?.toFixed(2)}`);
  console.log(`First half:  HIGH+HIGH N=${hhFirst.length} avgPnL=$${meanOf(hhFirst)?.toFixed(2)} | LOW+LOW N=${llFirst.length} avgPnL=$${meanOf(llFirst)?.toFixed(2)}`);
  console.log(`Second half: HIGH+HIGH N=${hhSecond.length} avgPnL=$${meanOf(hhSecond)?.toFixed(2)} | LOW+LOW N=${llSecond.length} avgPnL=$${meanOf(llSecond)?.toFixed(2)}`);
  const firstHalfDirectionOk = meanOf(llFirst) > meanOf(hhFirst);
  const secondHalfDirectionOk = meanOf(llSecond) > meanOf(hhSecond);
  console.log(`Direction consistent (LOW+LOW beats HIGH+HIGH) in both halves? First: ${firstHalfDirectionOk}, Second: ${secondHalfDirectionOk}`);
}

async function main() {
  for (const w of [10, 15, 20, 25, 30]) {
    await testWindow(w);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
