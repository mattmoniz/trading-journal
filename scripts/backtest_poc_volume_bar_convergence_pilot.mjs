// scripts/backtest_poc_volume_bar_convergence_pilot.mjs
// PILOT: does the RTH-only volume-by-price (POC) reach a price first, with the 24hr-inclusive
// volume-by-price "joining" it later, on a VOLUME-paced basis (a 500v/1000v chart) rather than
// clock-time? User's own description: "the RTH volume by price gets there first ... and then
// the volume by price that includes overnight joins later on the same volume chart."
//
// APPROXIMATION, stated up front: this DB only stores 1-minute OHLCV bars, not tick data.
// Genuine volume bars need trade-by-trade prices. Each 1-min bar's volume is spread across a
// synthetic intra-minute path (open->low->high->close if the bar closed up, open->high->low->
// close if down) to approximate where within the bar's range that volume likely traded -- a
// reasonable, standard simplification, not the real tick sequence. If this pilot shows promise,
// the real version needs genuine tick data (raw .scid files, offline Python, per this
// codebase's standing "do not ingest tick data into Postgres" architecture decision).
//
// Convergence is checked every VBAR volume units of cumulative RTH volume, not every clock
// minute -- this is the actual methodological fix requested (a 1-min-bar cadence answers "what
// time of day is it," not "how far has trading actually progressed").

import { query } from '../server/db.js';
import { computeProfile } from '../server/services/developingValueService.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const TICK = 0.25;
const RTH_START = 570, RTH_END = 959;
const PILOT_SESSIONS = 45; // smaller than the time-bar pilot: volume-bar checkpoints per
                            // session (~200-600) exceed the 390 clock bars, real cost tradeoff
const VBAR_SIZES = [500, 1000];
const H_MINUTES = 15;

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function stddev(a) { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
function percentile(sorted, p) { if (!sorted.length) return null; const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }
function statStr(a) { return `mean=${mean(a)?.toFixed(2) ?? 'n/a'} sd=${stddev(a)?.toFixed(2) ?? 'n/a'} N=${a.length}`; }
function etMinuteOfDay(ts) { const d = new Date(ts); return d.getUTCHours() * 60 + d.getUTCMinutes(); }

// v3 fix, per the real-tick design review (scratch/deepseek_poc_realtick_convergence_design_review.md
// §1.4): the raw POC (argmax) is a discontinuous statistic -- it can teleport when one leg of the
// merged profile is diffuse and the other concentrated, which is exactly the v1 bug (a 309pt jump
// on ~340 added contracts). med50 (the volume-weighted median -- first price where cumulative
// volume reaches half the total) is continuous under volume addition and is the principled fix,
// not just a band-aid like v2's SUSTAIN streak requirement (removed below, no longer needed).
function med50(profile) {
  const entries = profile.entries; // already sorted ascending by computeProfile
  const half = profile.totalVol / 2;
  let cum = 0;
  for (const e of entries) {
    cum += e.volume;
    if (cum >= half) return e.price;
  }
  return entries[entries.length - 1].price;
}

// Splits one 1-min bar's volume into sub-points along a synthetic O->L->H->C (up bar) or
// O->H->L->C (down bar) path, 5 interpolation steps per of 3 segments.
function subPoints(bar) {
  const path = bar.close >= bar.open ? [bar.open, bar.low, bar.high, bar.close] : [bar.open, bar.high, bar.low, bar.close];
  const segVol = bar.volume / 3, steps = 5, out = [];
  for (let s = 0; s < 3; s++) {
    const p0 = path[s], p1 = path[s + 1];
    for (let i = 1; i <= steps; i++) out.push({ price: p0 + (p1 - p0) * (i / steps), vol: segVol / steps, ts: bar.ts, closePx: bar.close });
  }
  return out;
}

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
    const globexBars = bars.filter(b => b.d !== t || etMinuteOfDay(b.ts) < RTH_START);
    const rthBars = bars.filter(b => b.d === t && etMinuteOfDay(b.ts) >= RTH_START && etMinuteOfDay(b.ts) <= RTH_END);
    if (rthBars.length < 300) { console.log(`  ${t}: skipped, only ${rthBars.length} RTH bars`); continue; }
    const globexPoints = globexBars.flatMap(subPoints); // fully static before RTH opens
    const rthPoints = rthBars.flatMap(subPoints);        // in time order (bars were ORDER BY ts)
    sessions.push({ t, globexPoints, rthPoints, closeAt: (ts) => { const b = rthBars.find(b => new Date(b.ts).getTime() >= new Date(ts).getTime()); return b?.close ?? rthBars[rthBars.length - 1].close; } });
  }
  console.log(`Sessions with full RTH bars: ${sessions.length}`);

  const splitIdx = Math.floor(sessions.length * 0.7);
  const trainS = sessions.slice(0, splitIdx), testS = sessions.slice(splitIdx);
  console.log(`Train: ${trainS.length}, Test: ${testS.length}`);

  for (const VBAR of VBAR_SIZES) {
    console.log(`\n========== VOLUME-BAR SIZE: ${VBAR} ==========`);

    // Reconstruct per-session checkpoint series: at each RTH-cumulative-volume multiple of
    // VBAR, compute rthPOC and bar24POC using only sub-points up to that point in time.
    for (const s of sessions) {
      s.checkpoints = [];
      let cumVol = 0, nextTarget = VBAR;
      const rthSoFar = [], globexAndRthSoFar = [...s.globexPoints];
      for (const pt of s.rthPoints) {
        rthSoFar.push(pt); globexAndRthSoFar.push(pt); cumVol += pt.vol;
        if (cumVol >= nextTarget) {
          const pRTH = computeProfile(rthSoFar.map(p => ({ high: p.price, low: p.price, volume: p.vol })));
          const p24 = computeProfile(globexAndRthSoFar.map(p => ({ high: p.price, low: p.price, volume: p.vol })));
          if (pRTH && p24) {
            s.checkpoints.push({
              ts: pt.ts,
              d50: Math.abs(med50(pRTH) - med50(p24)),   // primary (v3, robust)
              d: Math.abs(pRTH.poc - p24.poc),           // secondary (raw POC/argmax, screen-fidelity only)
              rthPOC: pRTH.poc, p24POC: p24.poc,
            });
          }
          nextTarget += VBAR;
        }
      }
    }
    const maxCk = Math.max(...sessions.map(s => s.checkpoints.length));
    console.log(`Checkpoints/session: min=${Math.min(...sessions.map(s => s.checkpoints.length))} max=${maxCk} mean=${mean(sessions.map(s => s.checkpoints.length))?.toFixed(0)}`);

    // Threshold buckets by FRACTIONAL position through the session's own checkpoint count
    // (bucket count varies by day, so this normalizes on relative progress, not absolute index)
    const NBUCKETS = 7;
    const bucketDs = Array.from({ length: NBUCKETS }, () => []);
    for (const s of trainS) s.checkpoints.forEach((c, i) => { const frac = i / s.checkpoints.length; bucketDs[Math.min(NBUCKETS - 1, Math.floor(frac * NBUCKETS))].push(c.d50); });
    const thresholds = bucketDs.map(arr => Math.max(TICK, percentile([...arr].sort((a, b) => a - b), 0.25)));
    console.log(`Bucket thresholds on d50 (train p25, floor ${TICK}): ${thresholds.map(x => x.toFixed(2)).join(', ')}`);

    // Time-matched baseline mu(t) built from train: for each 1-min ts-of-day, mean H-min fwd return
    const muByMinute = new Map();
    for (const s of trainS) {
      // build a simple ts(minute-of-day) -> close lookup is unnecessary; use rthPoints' closePx
      // Instead, approximate mu using the underlying rthBars via s (not retained) -- recompute cheaply from DB is wasteful;
      // use rthPoints' per-minute closes (one subPoint set per bar shares closePx).
    }
    // Simpler: build mu directly per session from its own rthPoints' minute closes (once), pooled across train.
    const minuteCloses = new Map(); // "HH:MM" -> [] of fwd returns across train sessions
    for (const s of trainS) {
      const uniq = [...new Map(s.rthPoints.map(p => [p.ts, p.closePx])).entries()];
      for (let i = 0; i + H_MINUTES < uniq.length; i++) {
        const key = new Date(uniq[i][0]).toISOString().slice(11, 16);
        if (!minuteCloses.has(key)) minuteCloses.set(key, []);
        minuteCloses.get(key).push(uniq[i + H_MINUTES][1] - uniq[i][1]);
      }
    }

    // Detect tau (first checkpoint where d <= bucket threshold), test set
    let censored = 0;
    const events = [];
    for (const s of testS) {
      // v3: detect on d50 (continuous, doesn't teleport) directly -- no SUSTAIN streak needed,
      // that was a band-aid for the raw-POC version's discontinuity, not a real requirement.
      let tauIdx = null;
      for (let i = 0; i < s.checkpoints.length; i++) {
        const frac = i / s.checkpoints.length;
        if (s.checkpoints[i].d50 <= thresholds[Math.min(NBUCKETS - 1, Math.floor(frac * NBUCKETS))]) { tauIdx = i; break; }
      }
      if (tauIdx == null) { censored++; continue; }
      const tauTs = s.checkpoints[tauIdx].ts;
      const uniq = [...new Map(s.rthPoints.map(p => [p.ts, p.closePx])).entries()];
      const tauMinIdx = uniq.findIndex(([ts]) => ts === tauTs);
      if (tauMinIdx === -1 || tauMinIdx + H_MINUTES >= uniq.length) continue;
      const ret = uniq[tauMinIdx + H_MINUTES][1] - uniq[tauMinIdx][1];
      const key = new Date(tauTs).toISOString().slice(11, 16);
      const baseline = mean(minuteCloses.get(key) || []);
      if (baseline == null) continue;
      events.push({ t: s.t, tauFrac: tauIdx / s.checkpoints.length, ret, baseline, delta: ret - baseline });
    }
    console.log(`Convergence events (test): ${events.length}, censored: ${censored}`);

    const deltas = events.map(e => e.delta);
    const deltaMean = mean(deltas), deltaSd = stddev(deltas);
    console.log(`Core test (H=${H_MINUTES}min): mean(delta)=${deltaMean?.toFixed(2)} sd=${deltaSd?.toFixed(2)} N=${deltas.length}`);
    console.log(`  mean tau (fraction through session): ${mean(events.map(e => e.tauFrac))?.toFixed(2)}`);

    const rigor = computeRigor(events.map(e => ({ t: e.t, delta: e.delta })), { dateField: 't', pnlFn: r => r.delta });
    console.log(`  rigor: stable=${rigor.stable} clustered=${rigor.clustered} thirds=${JSON.stringify(rigor.thirds)}`);

    const k1 = deltaSd == null || Math.abs(deltaMean) <= deltaSd;
    const k2 = rigor.stable === false;
    const k4 = events.length < 30;
    console.log(`  Kill: K1(noSignal)=${k1} K2(rigorFail)=${k2} K4(thin,N=${events.length})=${k4}`);

    const coreTripped = k1 || k2;
    const status = (!k1 && !k2 && !k4) ? 'CONFIRMED' : (events.length >= 15 ? 'PROVISIONAL' : 'REJECTED');
    await recordClaim({
      slug: `poc_volume_bar_${VBAR}v_convergence_same_session`,
      claimText: `PILOT v3 (approximate volume bars, ${VBAR}v, interpolated from 1-min OHLCV -- not real tick data). v1 was invalidated by hand-trace: the raw single-checkpoint POC distance is not a smooth signal -- the merged 24hr-so-far profile's POC is an argmax that can teleport when the overnight leg trades thin/diffuse across price (confirmed: a 309pt jump on ~340 added contracts against a 138k-contract base, one real session hand-traced). v2's SUSTAIN-streak band-aid barely changed the result. v3 replaces the primary convergence statistic with med50 (volume-weighted median), which is continuous under volume addition and cannot teleport by construction -- the principled fix identified during the real-tick design review (scratch/deepseek_poc_realtick_convergence_design_review.md), applied here to the cheaper 1-min approximation instead of real tick data at the user's request, with the known limitation that the intra-minute price path is still synthetic (O-L-H-C/O-H-L-C interpolation), not observed ticks -- this fix removes the teleport artifact but not the underlying data-resolution approximation. N=${sessions.length} sessions (train ${trainS.length}/test ${testS.length}). Checkpoints/session: mean=${mean(sessions.map(s => s.checkpoints.length))?.toFixed(0)}. Bucket thresholds on d50 (train p25 by fractional session progress, floor ${TICK}pt): ${thresholds.map(x => x.toFixed(2)).join(',')}. Convergence events N=${events.length}, censored=${censored}. Core: mean(delta)=${deltaMean?.toFixed(2)} sd=${deltaSd?.toFixed(2)}, mean tau (fraction through session)=${mean(events.map(e => e.tauFrac))?.toFixed(2)}. Rigor stable=${rigor.stable}. Kill: K1(noSignal)=${k1}, K2(rigorFail)=${k2}, K4(thin)=${k4}. Verdict: ${coreTripped ? 'K1 and/or K2 tripped -- discouraging pilot, does not support scaling as specified' : 'core kills did not trip -- worth scaling and/or building the real tick-based version'}. Real-tick rebuild remains the accuracy-maximizing next step if this looks promising; this result should be treated as directional, not decisive.`,
      sourceFile: 'scripts/backtest_poc_volume_bar_convergence_pilot.mjs',
      sampleSize: events.length,
      winRate: null,
      evPerTrade: null,
      rigorStatus: `stable=${rigor.stable} clustered=${rigor.clustered}`,
      status,
    });
    console.log(`  Persisted: poc_volume_bar_${VBAR}v_convergence_same_session, status=${status}`);
  }

  console.log('\nDONE');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
