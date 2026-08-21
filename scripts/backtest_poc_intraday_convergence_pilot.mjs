// scripts/backtest_poc_intraday_convergence_pilot.mjs
// PILOT (per DeepSeek design review, scratch/deepseek_poc_intraday_convergence_design_review.md):
// does the developing RTH POC converging with the developing 24hr (Globex+RTH) POC, live during
// the session, predict a same-session price reaction shortly after? Written directly by Claude
// (not dispatched to Gemini) after the completed-session test's first Gemini dispatch produced a
// crashed script with fabricated recordClaim() data -- see docs/OPEN_THREADS.md.
//
// Two load-bearing design choices, both required per the review, both different from the
// completed-session test: (1) the proximity threshold is time-bucketed (7 buckets across the RTH
// session), calibrated on train, NOT the completed-session's static end-of-day threshold -- a
// static threshold would just re-encode "what time of day is it" as the intraday distance drifts
// toward zero mechanically as the session progresses. (2) the baseline is the time-matched
// cross-sectional forward return at the same bar index, not an unconditional whole-population mean.

import { query } from '../server/db.js';
import { computeProfile } from '../server/services/developingValueService.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const TICK = 0.25;
const RTH_START = 570, RTH_END = 959;
const PILOT_SESSIONS = 75; // per review's 60-90 recommendation

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function stddev(a) { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
function percentile(sorted, p) { if (!sorted.length) return null; const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }
function statStr(a) { return `mean=${mean(a)?.toFixed(2) ?? 'n/a'} sd=${stddev(a)?.toFixed(2) ?? 'n/a'} N=${a.length}`; }
function etMinuteOfDay(ts) { const d = new Date(ts); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
function bucketOf(min) { return Math.min(6, Math.floor((min - RTH_START) / 60)); } // 6 buckets of 60min + 1 close bucket

async function main() {
  const dvl = (await query(`SELECT trade_date::text as t FROM developing_value_log ORDER BY trade_date DESC LIMIT ${PILOT_SESSIONS}`)).rows.reverse();
  console.log(`Pilot population: ${dvl.length} sessions, ${dvl[0].t} -> ${dvl[dvl.length - 1].t}`);

  const sessions = [];
  for (const row of dvl) {
    const t = row.t;
    const bars = (await query(`
      SELECT ts, ts::date::text as d, high::float, low::float, close::float, open::float, volume::float as volume
      FROM price_bars_primary WHERE symbol='NQ' AND (
        (ts::date = $1::date - 1 AND EXTRACT(hour FROM ts) >= 18) OR
        (ts::date = $1 AND EXTRACT(hour FROM ts) < 17)
      ) ORDER BY ts`, [t])).rows;
    // globexLeg = everything before today's RTH open: all of the prior-evening bars, plus
    // today's own pre-9:30 bars (8:30-9:29 pre-open session). Fully static before RTH opens.
    const globex = bars.filter(b => b.d !== t || etMinuteOfDay(b.ts) < RTH_START);
    const rthBars = bars.filter(b => b.d === t && etMinuteOfDay(b.ts) >= RTH_START && etMinuteOfDay(b.ts) <= RTH_END);
    if (rthBars.length < 300) { console.log(`  ${t}: skipped, only ${rthBars.length} RTH bars`); continue; }
    sessions.push({ t, globex, rthBars });
  }
  console.log(`Sessions with full RTH bars: ${sessions.length}`);

  // Bar-by-bar reconstruction
  for (const s of sessions) {
    s.byBar = [];
    for (let N = 0; N < s.rthBars.length; N++) {
      if (N + 1 < 10) { s.byBar.push(null); continue; }
      const rthSlice = s.rthBars.slice(0, N + 1).map(b => ({ high: b.high, low: b.low, volume: b.volume }));
      const merged = [...s.globex.map(b => ({ high: b.high, low: b.low, volume: b.volume })), ...rthSlice];
      const pRTH = computeProfile(rthSlice), p24 = computeProfile(merged);
      if (!pRTH || !p24) { s.byBar.push(null); continue; }
      s.byBar.push({ d: Math.abs(pRTH.poc - p24.poc), sign: Math.sign(pRTH.poc - p24.poc), close: s.rthBars[N].close });
    }
  }

  const splitIdx = Math.floor(sessions.length * 0.7);
  const trainS = sessions.slice(0, splitIdx), testS = sessions.slice(splitIdx);
  console.log(`Train: ${trainS.length}, Test: ${testS.length}`);

  // Time-bucketed threshold, calibrated on train
  const bucketDs = Array.from({ length: 7 }, () => []);
  for (const s of trainS) for (let N = 0; N < s.byBar.length; N++) { const b = s.byBar[N]; if (b) bucketDs[bucketOf(RTH_START + N)].push(b.d); }
  const thresholds = bucketDs.map(arr => Math.max(TICK, percentile([...arr].sort((a, b) => a - b), 0.25)));
  console.log(`Bucket thresholds (train p25, floor ${TICK}): ${thresholds.map(t => t.toFixed(2)).join(', ')}`);

  // Time-matched cross-sectional baseline mu_N for H=15, from TRAIN sessions only
  const H = 15;
  const muByBar = new Array(390).fill(null).map(() => []);
  for (const s of trainS) for (let N = 0; N + H < s.rthBars.length; N++) muByBar[N].push(s.rthBars[N + H].close - s.rthBars[N].close);
  const mu = muByBar.map(arr => mean(arr));

  // Detect tau per test session, compute delta_t
  let censored = 0;
  const events = [];
  for (const s of testS) {
    let tau = null;
    for (let N = 9; N < s.byBar.length; N++) { const b = s.byBar[N]; if (b && b.d <= thresholds[bucketOf(RTH_START + N)]) { tau = N; break; } }
    if (tau == null) { censored++; continue; }
    if (tau + H >= s.rthBars.length) continue; // horizon would exit RTH
    const ret = s.rthBars[tau + H].close - s.rthBars[tau].close;
    const baseline = mu[tau];
    if (baseline == null) continue;
    const dOpen = s.byBar[9]?.d ?? null;
    const rangeAtTau = Math.max(...s.rthBars.slice(0, tau + 1).map(b => b.high)) - Math.min(...s.rthBars.slice(0, tau + 1).map(b => b.low));
    events.push({ t: s.t, tau, ret, baseline, delta: ret - baseline, dOpen, rangeAtTau, sign: s.byBar[tau].sign, fullRange: Math.max(...s.rthBars.map(b => b.high)) - Math.min(...s.rthBars.map(b => b.low)) });
  }
  console.log(`\nConvergence events (test): ${events.length}, censored (never converged): ${censored}`);

  // Core test
  const deltas = events.map(e => e.delta);
  const uncondPooled = mean(trainS.flatMap(s => muByBar.flat())); // rough unconditional H-return, secondary only
  console.log(`\nCore test (H=${H}min): mean(delta)=${mean(deltas)?.toFixed(2)} sd=${stddev(deltas)?.toFixed(2)} N=${deltas.length}`);
  console.log(`  raw ret: ${statStr(events.map(e => e.ret))} | time-matched baseline: mean=${mean(events.map(e => e.baseline))?.toFixed(2)}`);
  console.log(`  magnitude |delta|: ${statStr(deltas.map(Math.abs))}`);

  const rigorCore = computeRigor(events.map(e => ({ t: e.t, delta: e.delta })), { dateField: 't', pnlFn: r => r.delta });
  console.log(`  rigor: stable=${rigorCore.stable} clustered=${rigorCore.clustered} thirds=${JSON.stringify(rigorCore.thirds)}`);

  const deltaSd = stddev(deltas), deltaMean = mean(deltas);
  const kCore1 = deltaSd == null || Math.abs(deltaMean) <= deltaSd;
  const kCore2 = rigorCore.stable === false;
  const kCore4 = events.length < 30;
  console.log(`  Kill: K1(noSignal)=${kCore1} K2(rigorFail)=${kCore2} K4(thin,N=${events.length})=${kCore4}`);

  // Angle 1: range-conditioned (predictive) + descriptive full-range split
  const rangeSorted = events.map(e => e.rangeAtTau).sort((a, b) => a - b);
  const rT1 = percentile(rangeSorted, 1 / 3), rT2 = percentile(rangeSorted, 2 / 3);
  const byRangeTercile = { low: [], mid: [], high: [] };
  for (const e of events) { const b = e.rangeAtTau <= rT1 ? 'low' : e.rangeAtTau <= rT2 ? 'mid' : 'high'; byRangeTercile[b].push(e.delta); }
  console.log(`\nAngle 1 (predictive, range_tau-conditioned delta):`);
  for (const k of ['low', 'mid', 'high']) console.log(`  ${k}: ${statStr(byRangeTercile[k])}`);
  const fullRangeMed = percentile(events.map(e => e.fullRange).sort((a, b) => a - b), 0.5);
  console.log(`Angle 1 (descriptive, realized full-session range split, median=${fullRangeMed?.toFixed(0)}):`);
  console.log(`  small-move days: ${statStr(events.filter(e => e.fullRange <= fullRangeMed).map(e => e.tau))} (tau)`);
  console.log(`  large-move days: ${statStr(events.filter(e => e.fullRange > fullRangeMed).map(e => e.tau))} (tau)`);

  // Angle 2: tau vs d_open
  const validOpen = events.filter(e => e.dOpen != null);
  const dOpenSorted = validOpen.map(e => e.dOpen).sort((a, b) => a - b);
  const oT1 = percentile(dOpenSorted, 1 / 3), oT2 = percentile(dOpenSorted, 2 / 3);
  console.log(`\nAngle 2 (tau vs opening gap d_open, terciles):`);
  for (const [label, filt] of [['near-open', e => e.dOpen <= oT1], ['mid-open', e => e.dOpen > oT1 && e.dOpen <= oT2], ['far-open', e => e.dOpen > oT2]]) {
    const sub = validOpen.filter(filt);
    console.log(`  ${label}: tau ${statStr(sub.map(e => e.tau))} | delta ${statStr(sub.map(e => e.delta))}`);
  }

  // Secondary: direction of approach
  const approachHi = events.filter(e => e.sign > 0).map(e => e.delta); // RTH POC above 24hr POC at convergence
  const approachLo = events.filter(e => e.sign < 0).map(e => e.delta);
  console.log(`\nSecondary (direction of approach at tau): from-above ${statStr(approachHi)} | from-below ${statStr(approachLo)}`);

  const coreKillsTripped = kCore1 || kCore2; // K4 (thin) alone doesn't mean "no effect", just "can't tell yet"
  const statusCore = (!kCore1 && !kCore2 && !kCore4) ? 'CONFIRMED' : (events.length >= 15 ? 'PROVISIONAL' : 'REJECTED');
  await recordClaim({
    slug: 'poc_intraday_convergence_same_session_reaction',
    claimText: `PILOT, N=${sessions.length} sessions (train ${trainS.length}/test ${testS.length}), H=${H}min. Time-bucketed thresholds: ${thresholds.map(t => t.toFixed(2)).join(',')}. Convergence events N=${events.length}, censored=${censored}. Core: mean(delta)=${deltaMean?.toFixed(2)} sd=${deltaSd?.toFixed(2)}, rigor stable=${rigorCore.stable}. Kill: K1(noSignal)=${kCore1}, K2(rigorFail)=${kCore2}, K4(thin)=${kCore4}. Angle1 range-conditioned deltas: low=${mean(byRangeTercile.low)?.toFixed(2)} mid=${mean(byRangeTercile.mid)?.toFixed(2)} high=${mean(byRangeTercile.high)?.toFixed(2)}. Angle2 tau-vs-dOpen: near-open tau=${mean(validOpen.filter(e=>e.dOpen<=oT1).map(e=>e.tau))?.toFixed(0)} far-open tau=${mean(validOpen.filter(e=>e.dOpen>oT2).map(e=>e.tau))?.toFixed(0)}. This is a PILOT (${sessions.length} of ~437 available sessions) per the review's cost/prior tradeoff -- ${coreKillsTripped ? 'K1 and/or K2 tripped on the core test; per the design review\'s own decision rule, this does NOT support scaling to the full history as currently specified (a discouraging pilot result, not a decisive final negative given N is still thin)' : 'core kill criteria did not trip; worth scaling to the full history'}.`,
    sourceFile: 'scripts/backtest_poc_intraday_convergence_pilot.mjs',
    sampleSize: events.length,
    winRate: null,
    evPerTrade: null,
    rigorStatus: `stable=${rigorCore.stable} clustered=${rigorCore.clustered}`,
    status: statusCore,
  });
  console.log(`\nPersisted: status=${statusCore}`);
  console.log('DONE');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
