// Event-driven scale-in test, landmark-stratified design (2026-08-25, DeepSeek design
// critique: scratch/deepseek_scale_in_control_design.md). Base lot enters immediately at
// bar 0 in every arm (identical, cancels exactly). The question is whether an ADD lot,
// triggered when a confirmation criterion fires within a bounded window, beats blind/
// ambient sizing -- WITHOUT the immortal-time bias a naive "confirmed vs not" comparison
// would introduce (DeepSeek's proof: even a pure-noise trigger would show a fake positive
// under that naive comparison, because trades that survive longer are mechanically
// selected for better outcomes independent of any real signal).
//
// Fix: landmark stratification. Every arm is standardized to the SAME per-bar weights
// w_k (Arm A's own realized confirm-timing distribution), computed within strata of
// "trades alive at bar k" so survival bias cancels identically across arms. Four arms:
//   A (SIGNAL)          = confirmed-at-k trades, the real tradeable policy
//   B (LANDMARK_BLIND)  = ALL alive-at-k trades (blind to the trigger, not to KILL)
//   C (AMBIENT_BLIND)   = ALL base-open-at-k trades (blind to KILL too)
//   D (TIMING_WITHIN_SELECTED, diagnostic only, NOT tradeable) = trades that eventually
//     confirm SOMEWHEN, added at exactly bar k -- conditions on future info, reported only
//     to separate "which trades" from "which bar" effects.
// Prohibited comparisons (would reintroduce the bias): confirmed vs not-confirmed;
// add-lot EV vs base-lot/wait=0 EV; pooling across k against one unconditional baseline.
import fs from 'fs';
import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import { detectSignalEvents, TICK } from './backtest_poc_rotation_vbp.mjs';
import { computeDirImbalance } from '../server/services/entryPressureService.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

const PPT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMM = LIVE_INSTRUMENT.commissionPerRoundTrip;
const PATH = 'standard';
const R_PCT_REFERENCE_PRICE = 29547.75;
const R_PCT = 65 / R_PCT_REFERENCE_PRICE;
const STOP_PTS = 20;
const TIME_LIMIT_BARS = 60;
const K = 8; // primary config per DeepSeek 2.5 -- max bars the confirmation window tracks
const N_PERM = 5000;

// KILL(k): 2 consecutive wrong closes through event.L by bar k. Reuses the exact
// convention already verified against stepPocStructuralStop() in this thread.
function killedByBar(event, bars, upTo, long) {
  let wrongCloses = 0;
  for (let i = event.trigger_idx + 1; i <= upTo && i < bars.length; i++) {
    const closedWrong = long ? bars[i].close < event.L : bars[i].close > event.L;
    if (closedWrong) wrongCloses++; else wrongCloses = 0;
    if (wrongCloses >= 2) return true;
  }
  return false;
}

// favClose: close vs OWN OPEN, NOT vs L (DeepSeek 2.1 -- vs L is near-tautological right
// after a JOIN trigger and degenerates the timing distribution to k=1).
function favClose(bar, long) {
  return long ? bar.close > bar.open : bar.close < bar.open;
}

function pressureOK(bar, long, tau) {
  const p = computeDirImbalance(bar.bid_volume, bar.ask_volume, long);
  return p !== null && p >= tau;
}

// Per-lot, independent exit (DeepSeek 2.3, PRIMARY) -- own 20pt stop, own 60-bar limit,
// from its own entry. Returns null if data-insufficient (used for eligibility too).
function runLot(bars, entryIdx, long) {
  if (entryIdx >= bars.length) return null;
  const entryPx = bars[entryIdx].open;
  const stopPx = long ? entryPx - STOP_PTS : entryPx + STOP_PTS;
  let exitPx = null;
  for (let i = entryIdx; i < bars.length; i++) {
    const bar = bars[i];
    if ((i - entryIdx) >= TIME_LIMIT_BARS) { exitPx = bar.close; break; }
    const stopTouched = long ? bar.low <= stopPx : bar.high >= stopPx;
    if (stopTouched) { exitPx = stopPx; break; }
  }
  if (exitPx == null) exitPx = bars[bars.length - 1].close;
  const pnlPts = long ? exitPx - entryPx : entryPx - exitPx;
  return { pnlPts, dollars: pnlPts * PPT - COMM };
}

// One event's full landmark profile: base lot, per-k alive/kill/positive/dataOK state,
// and the addLot() result at every k (computed once, reused by every arm -- this is what
// makes the 4 arms directly comparable rather than 4 separately-run scripts).
function buildEventProfile(event, bars, tau) {
  const long = event.direction === 'UP';
  const baseEntryIdx = event.trigger_idx + 1;
  const base = runLot(bars, baseEntryIdx, long);
  if (!base) return null;

  // Eligibility (DeepSeek 7.4): fixed window regardless of k, applied identically to
  // every arm -- session must have enough bars for the FULL K window + a full add-lot
  // time-limit, not just enough for whichever k a given trade happens to use.
  const maxEntryIdx = event.trigger_idx + K + 1;
  if (maxEntryIdx + TIME_LIMIT_BARS >= bars.length) return null;

  // Data-completeness (DeepSeek 7.5): every bar in the confirmation window must have
  // real bid/ask volume, applied to ALL arms so a data gap doesn't shrink Arm A's
  // population alone.
  for (let i = event.trigger_idx + 1; i <= event.trigger_idx + K; i++) {
    if ((bars[i].bid_volume + bars[i].ask_volume) <= 0) return null;
  }

  // baseOpenAt(k+1): base lot must still be open (not yet stopped) for an add at k to be
  // a real scale-in. Determine per-k by re-walking the base lot's own path once.
  const baseStopPx = long ? base && (bars[baseEntryIdx].open - STOP_PTS) : (bars[baseEntryIdx].open + STOP_PTS);
  let baseStoppedAtIdx = Infinity;
  for (let i = baseEntryIdx; i < Math.min(bars.length, baseEntryIdx + K + 2); i++) {
    const stopTouched = long ? bars[i].low <= baseStopPx : bars[i].high >= baseStopPx;
    if (stopTouched) { baseStoppedAtIdx = i; break; }
  }

  let killed = false;
  let confirmBar = null;
  const perK = {}; // k -> { alive (S_k membership: !killed && baseOpen), baseStillOpen (E_k membership), addResult }
  for (let k = 1; k <= K; k++) {
    const bar = bars[event.trigger_idx + k];
    if (killedByBar(event, bars, event.trigger_idx + k, long)) killed = true; // latches
    const baseStillOpen = (event.trigger_idx + k + 1) < baseStoppedAtIdx;
    const alive = !killed && baseStillOpen;
    let isPositive = false;
    if (!killed) isPositive = favClose(bar, long) && pressureOK(bar, long, tau);
    if (alive && isPositive && confirmBar === null) confirmBar = k; // KILL wins at ties (killed=true blocks alive)
    // addResult computed whenever the BASE lot is still open, regardless of killed --
    // EV_C (ambient-blind) needs this for bars where the level already broke but a
    // trader ignoring the level entirely would still add. S_k/C_k (signal-aware arms)
    // filter down to `alive` (which requires !killed) when consuming this.
    perK[k] = { alive, baseStillOpen, addResult: baseStillOpen ? runLot(bars, event.trigger_idx + k + 1, long) : null };
  }

  return { e: event, base, confirmBar, perK };
}

function summarizeArm(rows) {
  const N = rows.length;
  if (N === 0) return { N: 0, ev: 'n/a', wr: 'n/a' };
  const wins = rows.filter(r => r.dollars > 0).length;
  const ev = rows.reduce((s, r) => s + r.dollars, 0) / N;
  let rigorStr = 'n/a (N<20)';
  if (N >= 20) {
    const rigor = computeRigor(rows.map(r => ({ t: r.t, pnl: r.dollars })), { dateField: 't', pnlFn: r => r.pnl });
    rigorStr = `stable=${rigor.stable} cluster=${rigor.clustered}`;
  }
  return { N, ev: ev.toFixed(2), valEV: ev, wr: (100 * wins / N).toFixed(1), rigorStr };
}

async function runConstruction(label, R, rMode, sessions) {
  const resMed = await query(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY high - low) as median_range FROM price_bars_primary WHERE symbol='NQ'`);
  const THETA = Math.max(TICK, resMed.rows[0].median_range);
  const { all_signal } = detectSignalEvents(R, PATH, THETA, sessions, rMode);
  console.log(`\n=== ${label} (raw signal=${all_signal.length}) ===`);

  // tau: top-tercile of computeDirImbalance() pooled over all eligible events' bars
  // trigger_idx+1..trigger_idx+K (DeepSeek 2.5) -- computed BEFORE building profiles.
  const pressureSamples = [];
  for (const e of all_signal) {
    const session = sessions.find(s => s.t === e.t);
    if (!session) continue;
    const long = e.direction === 'UP';
    for (let k = 1; k <= K; k++) {
      const bar = session.bars[e.trigger_idx + k];
      if (!bar) continue;
      const p = computeDirImbalance(bar.bid_volume, bar.ask_volume, long);
      if (p !== null) pressureSamples.push(p);
    }
  }
  pressureSamples.sort((a, b) => a - b);
  const tau = pressureSamples[Math.floor(pressureSamples.length * 2 / 3)];
  console.log(`tau (top-tercile dirImbalance) = ${tau.toFixed(4)}, from ${pressureSamples.length} bar-samples`);

  const profiles = all_signal.map(e => {
    const session = sessions.find(s => s.t === e.t);
    return session ? buildEventProfile(e, session.bars, tau) : null;
  }).filter(Boolean);
  console.log(`Eligible (full-window data, K=${K}): N=${profiles.length}/${all_signal.length}`);

  // w_k: Arm A's realized confirm-timing distribution.
  const confirmed = profiles.filter(p => p.confirmBar !== null);
  const addRateA = confirmed.length / profiles.length;
  const wCounts = {};
  for (const p of confirmed) wCounts[p.confirmBar] = (wCounts[p.confirmBar] || 0) + 1;
  const w = {};
  for (let k = 1; k <= K; k++) w[k] = (wCounts[k] || 0) / confirmed.length;
  console.log(`Arm A add rate: ${(100 * addRateA).toFixed(1)}% (N=${confirmed.length}), timing weights w_k:`, Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v.toFixed(3)])));

  // Per-k landmark sets and per-k arm means.
  const perKStats = {};
  for (let k = 1; k <= K; k++) {
    const S_k = profiles.filter(p => p.perK[k].alive); // alive regardless of trigger
    const C_k = S_k.filter(p => p.confirmBar === k);
    const S_k_minus_C_k = S_k.filter(p => p.confirmBar !== k);
    const E_k = profiles.filter(p => p.perK[k].addResult !== null || p.perK[k].alive || true); // base-open-at-k+1, blind to KILL too -- approximate via addResult presence check below
    perKStats[k] = { S_k, C_k, S_k_minus_C_k, N_S: S_k.length, N_C: C_k.length, f_k: S_k.length ? C_k.length / S_k.length : null };
  }

  // EV_A, EV_B, EV_C, EV_D per DeepSeek's formulas, all standardized to w_k.
  let EV_A = 0, EV_B = 0, EV_C = 0, EV_D = 0, SIGNAL_STRAT = 0;
  const rowsA = [], rowsB = [];
  for (let k = 1; k <= K; k++) {
    if (w[k] === 0) continue;
    const { S_k, C_k, S_k_minus_C_k } = perKStats[k];
    const evC_k = C_k.length ? C_k.reduce((s, p) => s + p.perK[k].addResult.dollars, 0) / C_k.length : 0;
    const evS_k = S_k.length ? S_k.reduce((s, p) => s + p.perK[k].addResult.dollars, 0) / S_k.length : 0;
    const evSminusC_k = S_k_minus_C_k.length ? S_k_minus_C_k.reduce((s, p) => s + p.perK[k].addResult.dollars, 0) / S_k_minus_C_k.length : 0;
    EV_A += w[k] * evC_k;
    EV_B += w[k] * evS_k;
    SIGNAL_STRAT += w[k] * (evC_k - evSminusC_k);
    for (const p of C_k) rowsA.push({ t: p.e.t, dollars: p.perK[k].addResult.dollars });
    for (const p of S_k) rowsB.push({ t: p.e.t, dollars: p.perK[k].addResult.dollars });
  }
  // EV_C: ambient-blind, base-open-at-k+1 regardless of KILL (E_k membership uses
  // baseStillOpen, NOT alive -- this is what makes it blind to the level breaking, not
  // just blind to the confirmation trigger).
  for (let k = 1; k <= K; k++) {
    if (w[k] === 0) continue;
    const E_k = profiles.filter(p => p.perK[k].baseStillOpen);
    const rows = E_k.map(p => p.perK[k].addResult).filter(Boolean);
    const evE_k = rows.length ? rows.reduce((s, r) => s + r.dollars, 0) / rows.length : 0;
    EV_C += w[k] * evE_k;
  }
  // EV_D: diagnostic, trades that eventually confirm SOMEWHEN, priced as if added at k.
  for (let k = 1; k <= K; k++) {
    if (w[k] === 0) continue;
    const evEver = confirmed.filter(p => p.perK[k].alive).map(p => p.perK[k].addResult).filter(Boolean);
    const evD_k = evEver.length ? evEver.reduce((s, r) => s + r.dollars, 0) / evEver.length : 0;
    EV_D += w[k] * evD_k;
  }

  const Q2 = EV_A - EV_B, Q3 = EV_A - EV_C, SURVIVAL_VALUE = EV_B - EV_C, TIMING_PRECISION = EV_A - EV_D;
  const identityCheck = Math.abs(Q3 - (Q2 + SURVIVAL_VALUE));

  console.log(`\nEV_A (SIGNAL)          = $${EV_A.toFixed(2)}`);
  console.log(`EV_B (LANDMARK_BLIND)  = $${EV_B.toFixed(2)}`);
  console.log(`EV_C (AMBIENT_BLIND)   = $${EV_C.toFixed(2)}`);
  console.log(`EV_D (diagnostic only) = $${EV_D.toFixed(2)}`);
  console.log(`Q1 SIGNAL_STRAT (mechanism)      = $${SIGNAL_STRAT.toFixed(2)}`);
  console.log(`Q2 POLICY_VS_LANDMARK (A-B)      = $${Q2.toFixed(2)}`);
  console.log(`Q3 POLICY_VS_AMBIENT (A-C)       = $${Q3.toFixed(2)}`);
  console.log(`SURVIVAL_VALUE (B-C)             = $${SURVIVAL_VALUE.toFixed(2)}`);
  console.log(`TIMING_PRECISION (A-D)           = $${TIMING_PRECISION.toFixed(2)}`);
  console.log(`Identity check |Q3-(Q2+SURVIVAL)| = ${identityCheck.toFixed(6)} (should be ~0)`);
  console.log(`f_k per checkpoint:`, Object.fromEntries(Object.entries(perKStats).map(([k, v]) => [k, v.f_k != null ? v.f_k.toFixed(2) : 'n/a'])));

  // Day-blocked permutation null for Q1 (SIGNAL_STRAT), 5000 reps, per-k stratified.
  const sessionDates = [...new Set(profiles.map(p => p.e.t))];
  let extremeCount = 0;
  const observedAbs = Math.abs(SIGNAL_STRAT);
  for (let r = 0; r < N_PERM; r++) {
    // Shuffle confirmed/not labels WITHIN each S_k stratum, day-blocked: permute whole
    // sessions' worth of confirmed-labels together so within-session correlation of
    // overlapping trades is preserved (DeepSeek 5, N-shuffle section).
    let permStat = 0;
    for (let k = 1; k <= K; k++) {
      if (w[k] === 0) continue;
      const { S_k, N_C } = perKStats[k];
      if (S_k.length === 0) continue;
      const shuffled = [...S_k];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const pseudoC = shuffled.slice(0, N_C);
      const pseudoRest = shuffled.slice(N_C);
      const evPC = pseudoC.length ? pseudoC.reduce((s, p) => s + p.perK[k].addResult.dollars, 0) / pseudoC.length : 0;
      const evPR = pseudoRest.length ? pseudoRest.reduce((s, p) => s + p.perK[k].addResult.dollars, 0) / pseudoRest.length : 0;
      permStat += w[k] * (evPC - evPR);
    }
    if (Math.abs(permStat) >= observedAbs) extremeCount++;
  }
  const permP = extremeCount / N_PERM;
  console.log(`Permutation test on SIGNAL_STRAT: p=${permP.toFixed(4)} (${extremeCount}/${N_PERM} as extreme as observed)`);

  return { label, N: profiles.length, addRateA, EV_A, EV_B, EV_C, EV_D, Q2, Q3, SURVIVAL_VALUE, TIMING_PRECISION, SIGNAL_STRAT, permP, identityCheck, perKStats: Object.fromEntries(Object.entries(perKStats).map(([k, v]) => [k, { N_S: v.N_S, N_C: v.N_C, f_k: v.f_k }])) };
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
  console.log(`Loaded ${sessions.length} sessions. K=${K}, N_PERM=${N_PERM}.`);

  const fixedResult = await runConstruction('FIXED_R65', 65, 'fixed', sessions);
  const pctResult = await runConstruction('PCT_R0.22pct', R_PCT, 'pct', sessions);

  fs.writeFileSync('scratch/poc_rotation_scale_in_landmark_report.json', JSON.stringify({ fixedResult, pctResult }, null, 2));
  console.log('\nDONE — wrote scratch/poc_rotation_scale_in_landmark_report.json');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
