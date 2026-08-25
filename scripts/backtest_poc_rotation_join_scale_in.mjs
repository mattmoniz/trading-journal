// Scale-in confirmation test (2026-08-24/25, user's own idea): instead of DELAYING entry
// to wait for confirmation (already tested, found the entry-timing cost outweighs the
// gate's real-but-modest value -- docs/OPEN_THREADS.md, poc_rotation_confirm_gate_isolated_
// selection_value), enter a BASE unit immediately at bar 0 (no delay, no timing-cost
// confound), then ADD a second unit at a fixed checkpoint bar N ONLY if a confirmation
// criterion is met. Three confirmation variants tested against two controls:
//   BASE_ONLY:     never add -- the honest "do nothing extra" baseline.
//   BLIND_DOUBLE:  always add at bar N regardless of confirmation -- isolates whether
//                  "more size" helps on its own, independent of any signal (CLAUDE.md
//                  confound checklist item 1 -- does the smarter arm still win with the
//                  intelligence stripped out).
//   HELD:          add only if the level held (2-consecutive-closes, reusing the exact
//                  convention already verified against stepPocStructuralStop() in
//                  scripts/backtest_poc_convergence_directional_and_trade.mjs).
//   HELD_FAVORABLE: HELD, AND bar N's close also moved favorably vs bar N-1's close (not
//                  just "didn't break" -- "is pushing").
//   HELD_ORDERFLOW: HELD, AND bar N's aggressor volume (computeDirImbalance(), the exact
//                  same function validated live today for the entry-pressure sizing
//                  signal) confirms in the trade's direction.
//
// FIXED 2026-08-24/25: every prior script in this thread (backtest_poc_rotation_vbp.mjs
// and everything built on it, including today's confirmation-gate work) reported raw
// price-point differences prefixed with "$", never applying MNQ's real $2/pt or the $2
// round-trip commission (LIVE_INSTRUMENT, server/config/instruments.js) -- flagged as
// OPEN_DECISION poc_rotation_thread_points_mislabeled_as_dollars (HIGH), not fixed
// retroactively in the older scripts (out of scope for this one), but NOT repeated here.
// A scale-in trade that actually adds is TWO round trips (base + add), not one -- $4
// commission total in that case, not $2. Handled explicitly below.
import fs from 'fs';
import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import { detectSignalEvents, TICK, formatET } from './backtest_poc_rotation_vbp.mjs';
import { computeDirImbalance } from '../server/services/entryPressureService.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

const PPT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMM = LIVE_INSTRUMENT.commissionPerRoundTrip;

const PATH = 'standard';
const R_PCT_REFERENCE_PRICE = 29547.75;
const R_PCT = 65 / R_PCT_REFERENCE_PRICE;
const STOP_PTS = 20;
const TIME_LIMIT_BARS = 60;
const CHECKPOINTS = [2, 3, 5, 7, 10]; // fixed add-bar candidates -- extended per user request (these are 1-min bars, 10 = 10 real minutes)

function levelHeld2Close(event, bars, upTo, long) {
  let wrongCloses = 0;
  for (let i = event.trigger_idx + 1; i <= upTo && i < bars.length; i++) {
    const closedWrong = long ? bars[i].close < event.L : bars[i].close > event.L;
    if (closedWrong) wrongCloses++; else wrongCloses = 0;
    if (wrongCloses >= 2) return false;
  }
  return true;
}

function closedFavorable(bars, checkpointIdx, long) {
  const bar = bars[checkpointIdx], prev = bars[checkpointIdx - 1];
  if (!bar || !prev) return false;
  return long ? bar.close > prev.close : bar.close < prev.close;
}

function orderflowConfirms(bars, checkpointIdx, long) {
  const bar = bars[checkpointIdx];
  if (!bar) return false;
  const p = computeDirImbalance(bar.bid_volume, bar.ask_volume, long);
  return p !== null && p > 0;
}

// Runs one unit from its own entryIdx, returns points pnl (not dollars -- converted once
// at aggregation, see runScaleInTrade).
function runUnit(bars, entryIdx, long) {
  if (entryIdx >= bars.length) return null;
  const entryPx = bars[entryIdx].open;
  const stopPx = long ? entryPx - STOP_PTS : entryPx + STOP_PTS;
  let resolution = null;
  for (let i = entryIdx; i < bars.length; i++) {
    const bar = bars[i];
    if ((i - entryIdx) >= TIME_LIMIT_BARS) { resolution = bar.close; break; }
    const stopTouched = long ? bar.low <= stopPx : bar.high >= stopPx;
    if (stopTouched) { resolution = stopPx; break; }
  }
  if (resolution == null) resolution = bars[bars.length - 1].close;
  const pnlPts = long ? resolution - entryPx : entryPx - resolution;
  return { pnlPts };
}

// One event -> one blended-dollar outcome for a given arm ('base'|'blind'|'held'|
// 'held_favorable'|'held_orderflow') at a given checkpoint bar N.
function runScaleInTrade(event, bars, checkpointN, arm) {
  const long = event.direction === 'UP';
  const baseEntryIdx = event.trigger_idx + 1;
  const base = runUnit(bars, baseEntryIdx, long);
  if (!base) return null;

  let shouldAdd = false;
  const checkpointIdx = event.trigger_idx + checkpointN;
  if (arm === 'blind') shouldAdd = true;
  else if (arm === 'held') shouldAdd = levelHeld2Close(event, bars, checkpointIdx, long);
  else if (arm === 'held_favorable') shouldAdd = levelHeld2Close(event, bars, checkpointIdx, long) && closedFavorable(bars, checkpointIdx, long);
  else if (arm === 'held_orderflow') shouldAdd = levelHeld2Close(event, bars, checkpointIdx, long) && orderflowConfirms(bars, checkpointIdx, long);
  // arm === 'base': shouldAdd stays false

  let dollars = base.pnlPts * PPT - COMM; // base unit: 1 round trip
  let added = false;
  if (shouldAdd) {
    const add = runUnit(bars, checkpointIdx + 1, long);
    if (add) { dollars += add.pnlPts * PPT - COMM; added = true; } // add unit: 2nd round trip
  }
  return { e: event, dollars, added };
}

function summarize(results) {
  const N = results.length;
  if (N === 0) return { N: 0 };
  const wins = results.filter(r => r.dollars > 0).length;
  const wr = (wins / N * 100).toFixed(1);
  const ev = (results.reduce((s, r) => s + r.dollars, 0) / N).toFixed(2);
  const addRate = (100 * results.filter(r => r.added).length / N).toFixed(1);
  let rigorStr = 'n/a (N<20)';
  if (N >= 20) {
    const rigor = computeRigor(results.map(r => ({ t: r.e.t, pnl: r.dollars })), { dateField: 't', pnlFn: r => r.pnl });
    rigorStr = `stable=${rigor.stable} cluster=${rigor.clustered}`;
  }
  return { N, wr, ev, valEV: Number(ev), addRate, rigorStr };
}

async function runConstruction(label, R, rMode, sessions) {
  const resMed = await query(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY high - low) as median_range FROM price_bars_primary WHERE symbol='NQ'`);
  const THETA = Math.max(TICK, resMed.rows[0].median_range);
  const { all_signal } = detectSignalEvents(R, PATH, THETA, sessions, rMode);
  console.log(`\n=== ${label} (signal=${all_signal.length}) ===`);

  const ARMS = ['base', 'blind', 'held', 'held_favorable', 'held_orderflow'];
  const out = {};
  for (const checkpointN of CHECKPOINTS) {
    console.log(`\n--- checkpoint bar N=${checkpointN} ---`);
    out[checkpointN] = {};
    for (const arm of ARMS) {
      const results = all_signal.map(e => {
        const session = sessions.find(s => s.t === e.t);
        return runScaleInTrade(e, session.bars, checkpointN, arm);
      }).filter(Boolean);
      const s = summarize(results);
      out[checkpointN][arm] = s;
      console.log(`  ${arm.padEnd(15)}: N=${s.N} WR=${s.wr}% EV=$${s.ev} addRate=${s.addRate}% (${s.rigorStr})`);
    }
    const held = out[checkpointN].held, blind = out[checkpointN].blind, base = out[checkpointN].base;
    const hf = out[checkpointN].held_favorable, ho = out[checkpointN].held_orderflow;
    console.log(`  HELD vs BLIND (does the signal beat blind sizing?):           $${(held.valEV - blind.valEV).toFixed(2)}`);
    console.log(`  HELD_FAVORABLE vs BLIND (stronger confirm beat blind?):       $${(hf.valEV - blind.valEV).toFixed(2)}`);
    console.log(`  HELD_ORDERFLOW vs BLIND (order-flow confirm beat blind?):     $${(ho.valEV - blind.valEV).toFixed(2)}`);
    console.log(`  BLIND vs BASE (does adding size help at all?):                $${(blind.valEV - base.valEV).toFixed(2)}`);
  }
  return { label, allSignalN: all_signal.length, byCheckpoint: out };
}

async function main() {
  const dvl = (await query(`SELECT trade_date::text as t FROM developing_value_log ORDER BY trade_date DESC`)).rows.reverse();
  const sessions = [];
  for (const row of dvl) {
    const bars = (await query(`
      SELECT ts, open::float, high::float, low::float, close::float, volume::float as volume,
        COALESCE(bid_volume,0)::float as bid_volume, COALESCE(ask_volume,0)::float as ask_volume
      FROM price_bars_primary WHERE symbol='NQ' AND ts::date=$1 ORDER BY ts
    `, [row.t])).rows.map(b => ({ ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, bid_volume: b.bid_volume, ask_volume: b.ask_volume }));
    if (bars.length > 100) sessions.push({ t: row.t, bars });
  }
  console.log(`Loaded ${sessions.length} sessions.`);

  const fixedResult = await runConstruction('FIXED_R65', 65, 'fixed', sessions);
  const pctResult = await runConstruction('PCT_R0.22pct', R_PCT, 'pct', sessions);

  fs.writeFileSync('scratch/poc_rotation_scale_in_report.json', JSON.stringify({ fixedResult, pctResult }, null, 2));
  console.log('\nDONE — wrote scratch/poc_rotation_scale_in_report.json');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
