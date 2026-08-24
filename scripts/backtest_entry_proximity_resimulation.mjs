// The FULL resimulation of the entry-proximity idea (user, 2026-08-24) — not a re-sort of
// already-fired trades (that was scripts/pretest_entry_proximity_to_level.mjs, inconclusive),
// but an actual replay: for every real historical touch event, what would have happened
// under a genuinely TIGHTER entry rule instead of the live 15pt-window/fire-immediately rule?
//
// Population: same clean, pre-session-fixed level family as the pretest script (excludes
// same-day-forming levels like IB/OR, and continuously-developing ones like RTH_VWAP, plus
// the same >20pt stale-level-price sanity filter that caught a real data issue on one date).
//
// For each real fired trade (which already tells us WHEN price first entered the current
// 15pt window and WHAT the calibrated stop/target point-distances are for that setup_type):
//   1. Walk forward bar-by-bar from fired_at.
//   2. Under each candidate tighter threshold, check whether price gets that close to the
//      level BEFORE either (a) drifting back outside the original 15pt window (the
//      opportunity is gone -- counted as MISSED, not just "worse"), or (b) session end.
//   3. If it does get close enough, that bar's close is the NEW entry -- reapply the SAME
//      stop/target point-distances the original trade used (isolates the effect of entry
//      TIMING alone, not a different risk model), then walk forward for the real outcome.
//   4. If it never gets close enough, this candidate is a MISSED trade under the tighter
//      rule -- its real, actual original outcome is what would have been given up, reported
//      explicitly rather than silently dropped from the comparison.
// Sweeps several candidate thresholds (not one hardcoded number) so the answer, if any, is
// data-supported rather than guessed.
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const CURRENT_WINDOW = 15; // live nearLevels convention -- also the "gave up, drifted away" invalidation bound
const CANDIDATE_THRESHOLDS = [1, 2, 3, 5, 8, 12];
const MAX_WALK_BARS = 500;

const SAME_DAY_FORMING_LEVEL_PREFIXES = [
  'OR5_', 'OR10_', 'OR15_', 'OR30_', 'IB_HIGH', 'IB_LOW', 'IB_MID',
  'PD_OR_MID', '5D_OR_MID', '10D_IB_MID', 'RTH_VWAP', 'DEV_POC', 'MONTHLY_VWAP',
];
const MAX_SANE_ENTRY_DIST = 20;

function setupTypeToLevelName(setupType) {
  let s = setupType.replace(/_OVERNIGHT$/, '').replace(/_TRAIL$/, '').replace(/_GAP_(UP|DOWN)$/, '');
  const m = s.match(/^(.*)_FADE_(LONG|SHORT)$/);
  return m ? m[1] : null;
}
function isSameDayForming(levelName) {
  return SAME_DAY_FORMING_LEVEL_PREFIXES.some(p => levelName.startsWith(p));
}
function pnlAt(entry, price, long) {
  const points = long ? price - entry : entry - price;
  return points * PNL_PER_POINT - COMMISSION;
}

async function main() {
  const tradesRes = await query(`
    SELECT setup_type, trade_date::text as trade_date, fired_at,
      entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
      stop_level::float as stop_level, t1_level::float as t1_level,
      resolution, actual_pnl::float as actual_pnl
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW') AND resolution IN ('STOP_HIT','TARGET_HIT')
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
      AND actual_pnl IS NOT NULL
    ORDER BY fired_at ASC
  `);
  const levelPricesRes = await query(`SELECT trade_date::text as trade_date, level_name, price::float as price FROM level_prices WHERE price IS NOT NULL`);
  const levelMap = new Map();
  for (const r of levelPricesRes.rows) levelMap.set(`${r.trade_date}|${r.level_name}`, r.price);

  const barsRes = await query(`SELECT ts, close::float as close, high::float as high, low::float as low FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), tsText: new Date(b.ts).toISOString(), close: b.close, high: b.high, low: b.low }));
  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function isSessionEndUtc(ts) {
    const d = new Date(ts);
    const etHour = Number(new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' })).getHours());
    return etHour >= 16;
  }

  const candidates = [];
  let excludedForm = 0, excludedStale = 0, excludedNoLevel = 0, excludedNoDir = 0;
  for (const t of tradesRes.rows) {
    const levelName = setupTypeToLevelName(t.setup_type);
    if (!levelName || isSameDayForming(levelName)) { excludedForm++; continue; }
    const levelPrice = levelMap.get(`${t.trade_date}|${levelName}`);
    if (levelPrice == null) { excludedNoLevel++; continue; }
    const direction = inferDirection(t.setup_type);
    if (!direction) { excludedNoDir++; continue; }
    const long = direction === 'LONG';
    const entry = t.entry_zone_high ?? t.entry_zone_low;
    if (Math.abs(entry - levelPrice) > MAX_SANE_ENTRY_DIST) { excludedStale++; continue; }

    candidates.push({
      setup_type: t.setup_type, trade_date: t.trade_date, fired_at_ms: new Date(t.fired_at).getTime(),
      long, levelPrice, origEntry: entry,
      stopDist: Math.abs(entry - t.stop_level), targetDist: Math.abs(t.t1_level - entry),
      origPnl: t.actual_pnl,
    });
  }
  console.log(`Clean candidate population: N=${candidates.length} (excluded: same-day-forming/developing=${excludedForm}, stale-level=${excludedStale}, no-level-price=${excludedNoLevel}, no-direction=${excludedNoDir})`);

  function walkOutcome(entry, stop, target, long, startIdx) {
    for (let i = startIdx; i < Math.min(allBars.length, startIdx + MAX_WALK_BARS); i++) {
      const bar = allBars[i];
      const stopHit = long ? bar.low <= stop : bar.high >= stop;
      const targetHit = long ? bar.high >= target : bar.low <= target;
      if (stopHit && targetHit) return pnlAt(entry, stop, long); // conservative stop-first, matches every other branch in this codebase
      if (stopHit) return pnlAt(entry, stop, long);
      if (targetHit) return pnlAt(entry, target, long);
      if (isSessionEndUtc(bar.ts)) return pnlAt(entry, bar.close, long);
    }
    const last = allBars[Math.min(allBars.length - 1, startIdx + MAX_WALK_BARS)];
    return pnlAt(entry, last.close, long);
  }

  function simulateUnderThreshold(cand, threshold) {
    const startIdx = firstIndexAfter(cand.fired_at_ms);
    let newEntryIdx = null;
    for (let i = startIdx; i < Math.min(allBars.length, startIdx + MAX_WALK_BARS); i++) {
      const bar = allBars[i];
      const dist = Math.abs(bar.close - cand.levelPrice);
      if (dist <= threshold) { newEntryIdx = i; break; }
      if (dist > CURRENT_WINDOW) break; // drifted away -- opportunity gone, MISSED
      if (isSessionEndUtc(bar.ts)) break; // session ended -- MISSED
    }
    if (newEntryIdx === null) return { fired: false };
    const newEntry = allBars[newEntryIdx].close;
    const newStop = cand.long ? newEntry - cand.stopDist : newEntry + cand.stopDist;
    const newTarget = cand.long ? newEntry + cand.targetDist : newEntry - cand.targetDist;
    const pnl = walkOutcome(newEntry, newStop, newTarget, cand.long, newEntryIdx + 1);
    return { fired: true, pnl, barsWaited: newEntryIdx - startIdx };
  }

  console.log('\n=== Sweep: candidate tighter thresholds vs the current (15pt, fire-immediately) rule ===');
  const currentTotal = candidates.reduce((s, c) => s + c.origPnl, 0);
  console.log(`CURRENT rule (baseline, all ${candidates.length} candidates fire): total=$${currentTotal.toFixed(0)}, mean=$${(currentTotal / candidates.length).toFixed(2)}/candidate (includes trades that ultimately lost)`);

  const sweepResults = {};
  for (const threshold of CANDIDATE_THRESHOLDS) {
    const sims = candidates.map(c => ({ cand: c, sim: simulateUnderThreshold(c, threshold) }));
    const fired = sims.filter(s => s.sim.fired);
    const missed = sims.filter(s => !s.sim.fired);
    const firedTotal = fired.reduce((s, r) => s + r.sim.pnl, 0);
    const missedOrigTotal = missed.reduce((s, r) => s + r.cand.origPnl, 0); // what we'd give up
    const netTotal = firedTotal; // dollars actually captured under the tighter rule (missed = $0, not traded)
    const firedNeg = fired.filter(r => r.sim.pnl < 0).length;
    const missedWereWinners = missed.filter(r => r.cand.origPnl > 0).length;

    sweepResults[threshold] = { fired, missed, firedTotal, missedOrigTotal, netTotal, firedNeg, missedWereWinners };

    console.log(`\nThreshold=${threshold}pt:`);
    console.log(`  Fires: ${fired.length}/${candidates.length} (${(fired.length / candidates.length * 100).toFixed(1)}%) -- missed: ${missed.length} (${missed.length > 0 ? (missedWereWinners / missed.length * 100).toFixed(0) : 0}% of missed would have been real winners under the current rule, worth $${missedOrigTotal.toFixed(0)} total)`);
    console.log(`  Of the ones that DID fire: mean=$${(firedTotal / fired.length).toFixed(2)}/trade, neg=${firedNeg}/${fired.length} (${(firedNeg / fired.length * 100).toFixed(1)}%)`);
    console.log(`  FULL PICTURE -- total dollars actually captured (fired trades only, missed=$0 not $current): $${netTotal.toFixed(0)} vs current rule's $${currentTotal.toFixed(0)} on the identical ${candidates.length}-candidate population -- delta $${(netTotal - currentTotal).toFixed(0)}`);
  }

  // Rigor on the most promising-looking threshold's fired subset (informational).
  const bestThreshold = CANDIDATE_THRESHOLDS.reduce((best, t) =>
    sweepResults[t].netTotal > sweepResults[best].netTotal ? t : best, CANDIDATE_THRESHOLDS[0]);
  const bestFired = sweepResults[bestThreshold].fired;
  const rigorBest = computeRigor(bestFired.map(r => ({ t: r.cand.trade_date, pnl: r.sim.pnl })), { dateField: 't', pnlFn: r => r.pnl });

  console.log(`\n=== Best-looking threshold on total dollars: ${bestThreshold}pt (net $${sweepResults[bestThreshold].netTotal.toFixed(0)} vs current $${currentTotal.toFixed(0)}) ===`);
  console.log(`Rigor on its fired subset: stable=${rigorBest.stable} clustered=${rigorBest.clustered} clean=${rigorBest.clean}`);

  const summaryLines = CANDIDATE_THRESHOLDS.map(t => {
    const s = sweepResults[t];
    return `${t}pt: fires=${s.fired.length}/${candidates.length}, net=$${s.netTotal.toFixed(0)} (delta $${(s.netTotal - currentTotal).toFixed(0)} vs current), missed-were-winners=${s.missedWereWinners}/${s.missed.length}`;
  }).join('; ');

  const claimText = `Full resimulation (real bar-by-bar replay, no lookahead -- entries walk forward from fired_at using only past/current bars) of the entry-proximity idea (user, 2026-08-24): would tightening the entry-trigger distance from the live 15pt window improve outcomes, once accounting for trades that would be MISSED entirely under a tighter rule (not just re-sorting trades that already fired)?
Population: N=${candidates.length} real fired trades on pre-session-fixed, non-developing levels (PD/PW/PM/CAM/FLOOR/monthly families), current-rule baseline total=$${currentTotal.toFixed(0)}.
Sweep across ${CANDIDATE_THRESHOLDS.join('/')}pt candidate thresholds: ${summaryLines}.
Best on total dollars: ${bestThreshold}pt threshold (rigor: stable=${rigorBest.stable} clustered=${rigorBest.clustered} clean=${rigorBest.clean}).
Methodology: same calibrated stop/target POINT-DISTANCES reapplied from the new (tighter) entry, isolating entry-timing alone; a candidate that drifts back beyond the original 15pt window before reaching the tighter threshold is counted as a genuine MISS (its real original P&L reported as foregone opportunity, not silently dropped).`;

  await recordClaim({
    slug: 'entry_proximity_full_resimulation',
    claimText,
    sourceFile: 'scripts/backtest_entry_proximity_resimulation.mjs',
    sampleSize: candidates.length,
    winRate: null,
    evPerTrade: (sweepResults[bestThreshold].netTotal - currentTotal) / candidates.length,
    rigorStatus: `bestThreshold=${bestThreshold}pt stable=${rigorBest.stable} clustered=${rigorBest.clustered} clean=${rigorBest.clean}`,
    status: 'PROVISIONAL',
  });

  console.log('\nDONE');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
