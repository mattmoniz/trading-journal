// Calibration script for RTH_FLUSH_LONG/SHORT and GLOBEX_FLUSH_LONG/SHORT -- the flush/balance/
// resolution pattern from docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md sec 4.4-4.14. Reuses the
// exact validated mechanism from server/services/flushMechanics.js (shared with the two live
// detectors, per CLAUDE.md's "export the real function, never reimplement" rule) and the exact
// trigger logic already validated in scratch/rth_ib_vs_on_overlap.mjs (RTH stacked IB/ONH-ONL
// trigger) and scratch/flush_pace_widener_test.mjs (Globex pace-tiered target).
//
// Design notes / deliberate scope limits (2026-08-27):
// - RTH_FLUSH trigger: whichever fires first each day, IB break (>=10:30 ET) or ONH/ONL break
//   (from 9:30 ET) -- sec 4.14's best-supported RTH design (N=336, WR=66.1%, EV=$34.31, clean+
//   stable+rising). Target: flat p50 MFE (sec 4.10) -- NOT pace/volume-adjusted, since neither
//   signal is independently rigor-clean on the RTH side (sec 4.13's own recommendation).
// - GLOBEX_FLUSH trigger: REDESIGNED 2026-08-28 (see the section below for the full writeup).
//   The original "first 60 minutes of session open" trigger (elbow-threshold or otherwise) is
//   gone entirely -- it never matched sec 4.8's own finding that the real overnight move happens
//   a median ~5 hours after value departure, nor the user's original description of the pattern.
//   New trigger: did price leave prior-day value by RTH close (checked through 30 min into the
//   extended session)? If so, that departure bar itself is the trigger -- no magnitude filter
//   needed, watched continuously through the whole overnight session. Both directions (leaving
//   below PD_VAL, leaving above PD_VAH) are tested fresh rather than assuming the old DOWN-only
//   scope carries over.
// - GLOBEX_FLUSH target: MODE + pace + volume-building tiered (revised same day). A flat pooled
//   target was tried first (pace-vs-MFE correlation looked weak, 0.04-0.14) but that pooling was
//   itself hiding the signal: splitting by MODE (does departure direction agree with the eventual
//   resolution direction -- CONTINUATION -- or disagree -- REVERSAL) reveals a real, tercile-clean
//   pace effect within each mode (e.g. DOWN-departure REVERSAL, slowest tercile: EV=$105.96/trade
//   vs the mode's own pooled $37/trade). Each of the 4 (departure x resolution) combinations gets
//   its own pace/volume-building 3-tier combined score (sec 4.13's exact design: count of
//   {NOT-fast pace, building volume}, each score 0/1/2 targeted at its own p75 MFE), computed on
//   that mode's own population, not pooled. CONTINUATION setup_types keep the plain LONG/SHORT
//   names; REVERSAL setup_types get a `_REVERSAL_` infix (matches this codebase's conditional-
//   variant naming convention, direction suffix stays at the very end for inferDirection()).
// - Both directions (LONG/SHORT) get separate SETUP_STATUS/OPTIMAL_STOP rows -- entry direction
//   is whichever way the balance actually resolves (matches sec 4.4's "Strategy A" design,
//   agnostic to which way the balance breaks, not forced to match the trigger's own direction).
// - This script writes BACKTEST-based SETUP_STATUS rows (informational reference, matching
//   MOMENTUM_60m_60m_TREND's precedent in scripts/backtest_momentum60_daytype.mjs) -- the actual
//   live SHADOW/ACTIVE gate is computed fresh by each detector's own getLiveStatus() from REAL
//   active_setups rows, never from this backtest's blended N.
//
// Run: node scripts/backtest_flush_patterns.mjs
// Schedule: added to run_weekly_backtests.sh.

import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeBalanceAndResolution, computeEntryPace } from '../server/services/flushMechanics.js';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const IB_END_MOD = 630;

function percentile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * p, base = Math.floor(pos), rest = pos - base;
  return s[base + 1] !== undefined ? s[base] + rest * (s[base + 1] - s[base]) : s[base];
}
function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { cov += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; vy += (ys[i] - my) ** 2; }
  return (vx > 0 && vy > 0) ? cov / Math.sqrt(vx * vy) : 0;
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
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (checkpointDates[mid] <= td) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return best === -1 ? null : denseLevelMap[checkpointDates[best]];
  };
  return { getLevelsForDate };
}

function evalFromTrigger(sessBars, triggerIdx) {
  const postBars = sessBars.slice(triggerIdx + 1);
  const res = computeBalanceAndResolution(postBars);
  if (!res) return null;
  const entryIdx = triggerIdx + 1 + res.resolutionIdx;
  const entryBar = sessBars[entryIdx];
  const pace = computeEntryPace(sessBars[0].open, sessBars[0].ts, res.entryPrice, entryBar.ts);
  let mfe = 0;
  for (let i = entryIdx + 1; i < sessBars.length; i++) {
    const b = sessBars[i];
    const favorable = res.resolutionDir === 'UP' ? b.high - res.entryPrice : res.entryPrice - b.low;
    if (favorable > mfe) mfe = favorable;
  }
  // Volume-building: from the trigger bar (exclusive) through the entry bar (inclusive) -- fully
  // known at the moment of entry, no lookahead (found real for RTH_FLUSH 2026-08-28,
  // scratch/rth_mode_pace_volume_retest.mjs -- unlike Globex, this signal holds POOLED, no
  // continuation/reversal mode split needed; pace does NOT hold for RTH, confirmed unchanged from
  // sec 4.13's original finding).
  const preEntryBars = sessBars.slice(triggerIdx + 1, entryIdx + 1);
  const volZs = preEntryBars.map(b => b.volZ).filter(v => v !== null);
  const avgVolZ = volZs.length >= 5 ? volZs.reduce((a, b) => a + b, 0) / volZs.length : null;
  const volZTrend = volZs.length >= 5 ? pearson(Array.from({ length: volZs.length }, (_, i) => i), volZs) : null;
  return { resolutionDir: res.resolutionDir, entryPrice: res.entryPrice, stopPrice: res.stopPrice, entryIdx, pace, mfe, avgVolZ, volZTrend, sessBars };
}

function simulateExit(setup, targetPts) {
  const { resolutionDir, entryPrice, entryIdx, stopPrice, sessBars } = setup;
  const targetPrice = resolutionDir === 'UP' ? entryPrice + targetPts : entryPrice - targetPts;
  const closePrice = sessBars[sessBars.length - 1].close;
  let exitPrice = closePrice;
  for (let i = entryIdx + 1; i < sessBars.length; i++) {
    const b = sessBars[i];
    const stopHit = resolutionDir === 'UP' ? b.low <= stopPrice : b.high >= stopPrice;
    const hitTarget = resolutionDir === 'UP' ? b.high >= targetPrice : b.low <= targetPrice;
    if (stopHit) { exitPrice = stopPrice; break; }
    if (hitTarget) { exitPrice = targetPrice; break; }
  }
  const win = resolutionDir === 'UP' ? exitPrice > entryPrice : exitPrice < entryPrice;
  const pnl = resolutionDir === 'UP' ? (exitPrice - entryPrice) * PNL_PER_POINT - COMMISSION : (entryPrice - exitPrice) * PNL_PER_POINT - COMMISSION;
  return { pnl, win, stopDist: Math.abs(entryPrice - stopPrice), targetDist: targetPts };
}

async function persist(type, n, wr, ev, totalPnl, notesObj, stopPts, targetPts, extraNotes) {
  if (n === 0) { console.log(`  ${type}: N=0, skipping persist.`); return; }
  const rec = n < 20 ? 'THIN_N' : (ev < -5 ? 'SUPPRESS' : 'ACTIVE');
  await query(`
    INSERT INTO performance_audit
      (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl, recommendation, notes)
    VALUES (CURRENT_DATE, 0, 'SETUP_STATUS', $1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
      sample_size=EXCLUDED.sample_size, win_rate=EXCLUDED.win_rate, ev_per_trade=EXCLUDED.ev_per_trade,
      total_pnl=EXCLUDED.total_pnl, recommendation=EXCLUDED.recommendation, notes=EXCLUDED.notes
  `, [type, n, wr, ev, totalPnl, rec, JSON.stringify({ source: 'backtest_flush_patterns.mjs', ...notesObj })]);

  await query(`
    INSERT INTO performance_audit
      (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade,
       optimal_stop, optimal_target, notes)
    VALUES (CURRENT_DATE, 9999, 'OPTIMAL_STOP', $1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
      sample_size=EXCLUDED.sample_size, win_rate=EXCLUDED.win_rate, ev_per_trade=EXCLUDED.ev_per_trade,
      optimal_stop=EXCLUDED.optimal_stop, optimal_target=EXCLUDED.optimal_target, notes=EXCLUDED.notes
  `, [type, n, wr, ev, stopPts, targetPts, JSON.stringify({ source: 'backtest_flush_patterns.mjs', method: 'structural-stop-mfe-target', ...(extraNotes || {}) })]);

  console.log(`  Persisted ${type}: N=${n} -> ${rec} (avg structural stop~${stopPts?.toFixed?.(1)}pt informational, target=${targetPts?.toFixed?.(1)}pt)`);
}

async function main() {
  console.log('Loading levels (for ONH/ONL)...');
  const { getLevelsForDate } = await loadLevels();

  console.log('Loading bars with volume...');
  const barsRes = await query(`
    SELECT ts, open::float, high::float, low::float, close::float,
           COALESCE(bid_volume,0)+COALESCE(ask_volume,0) as volume,
           (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as mod
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const allBars = barsRes.rows;

  // volZ: 90-bar per-minute-of-day rolling baseline, this codebase's established convention
  // (matches getTouchQualityBaseline()/hivolLopace's own construction) -- used by both RTH_FLUSH's
  // and GLOBEX_FLUSH's volume-building signals below.
  const modQueues = Array.from({ length: 1440 }, () => []);
  for (const b of allBars) {
    const q = modQueues[b.mod];
    let volZ = null;
    if (q.length >= 30) {
      const mean = q.reduce((a, x) => a + x, 0) / q.length;
      const std = Math.sqrt(q.reduce((a, x) => a + (x - mean) ** 2, 0) / q.length);
      if (std > 0) volZ = (Number(b.volume) - mean) / std;
    }
    b.volZ = volZ;
    q.push(Number(b.volume));
    if (q.length > 90) q.shift();
  }

  const rthByDate = new Map();
  for (const b of allBars) {
    if (b.mod < 570 || b.mod > 959) continue;
    const d = b.ts.toISOString().slice(0, 10);
    if (!rthByDate.has(d)) rthByDate.set(d, []);
    rthByDate.get(d).push(b);
  }
  // mod>=1020 (5PM ET) date-bump, NOT mod>=960 (4PM, RTH close) -- corrected 2026-08-27 after a
  // real, previously-unnoticed bug was isolated with a direct side-by-side diagnostic
  // (/tmp/diagnose_elbow_discrepancy.mjs): every mechanism-simulation script in this thread since
  // scratch/verify_structural_stop.mjs (which FIRST validated $36.79/N=24) has bumped the date at
  // mod>=960, immediately at RTH close -- but there IS real trading between 4-5PM ET (the daily
  // maintenance halt is 5-6PM, not 4-6PM), so that convention silently reassigns the CLOSING day's
  // own 4-5PM hour to the FOLLOWING calendar day's Globex session bucket, contaminating that
  // following session's own "session open" reference price and its first-60-minutes window with
  // an hour of data that isn't really its own. Confirmed directly: for shared calendar-date keys,
  // the two conventions' "max down move" values differ by 2-3x on the same nominal date (e.g.
  // 2023-11-22: 24.25pt under mod>=1020 vs 76.75pt under mod>=960) -- not noise, a real
  // misattribution. scratch/move_distribution.mjs happened to use mod>=1020 already (for an
  // unrelated reason -- SQL-side trade_date convenience), which is WHY its own elbow citation
  // (119.50pt) doesn't match a mod>=960 recompute (75.75pt): mod>=1020 was actually the more
  // correct convention the whole time, not a mismatched one-off. This changes more than the
  // elbow -- every Globex EV/WR number in docs/LIQUIDITY_ZONES_DEFENDED_LEVELS_SPEC.md sec
  // 4.6-4.13 was computed under the flawed mod>=960 boundary and should be treated as
  // provisional pending a re-derivation; see OPEN_DECISION
  // globex_session_boundary_4to5pm_misattribution_bug for the fuller writeup and re-derivation
  // status. This script uses the corrected mod>=1020 boundary throughout, including the
  // first-60-minute window check below (real elapsed time, not mod-arithmetic, to avoid any
  // separate midnight-wraparound risk).
  // mod 960-1019 (4-5PM ET) is EXCLUDED entirely, not just left unbumped -- DeepSeek review
  // (2026-08-27, F4) caught that the 1020 fix above only stopped that hour from contaminating
  // the FOLLOWING session; without also dropping it, it instead sits as a temporally-discontiguous
  // orphan block glued onto the END of the CURRENT (preceding) session's bar array (the real
  // session ends ~9:29 the next morning, then the array jumps 6.5 hours forward to that same
  // afternoon's 4-5PM bars). Since the balance/resolution/MFE walk below is strictly sequential,
  // that orphan block would corrupt any trade still open at 9:29 (scored against the wrong hour,
  // skipping the entire RTH session in between) -- dropping it entirely is correct either way,
  // since these bars belong to neither a clean overnight session nor the live detector's own
  // window (which stops querying at 9:30 AM, see globexFlushDetector.js).
  const globexByTradeDate = new Map();
  for (const b of allBars) {
    if (b.mod >= 570 && b.mod <= 1019) continue;
    const d = new Date(b.ts);
    if (b.mod >= 1020) d.setUTCDate(d.getUTCDate() + 1);
    const key = d.toISOString().slice(0, 10);
    if (!globexByTradeDate.has(key)) globexByTradeDate.set(key, []);
    globexByTradeDate.get(key).push(b);
  }
  for (const arr of globexByTradeDate.values()) arr.sort((a, b) => a.ts.getTime() - b.ts.getTime());

  // ============================= RTH_FLUSH =============================
  console.log('\n=== RTH_FLUSH (stacked IB/ONH-ONL trigger) ===');
  const rthSetups = [];
  for (const [date, sessBars] of rthByDate) {
    const ibBars = sessBars.filter(b => b.mod < IB_END_MOD);
    let ibTrigger = null;
    if (ibBars.length >= 30) {
      const ibHigh = Math.max(...ibBars.map(b => b.high)), ibLow = Math.min(...ibBars.map(b => b.low));
      for (let i = 0; i < sessBars.length; i++) {
        if (sessBars[i].mod < IB_END_MOD) continue;
        if (sessBars[i].close > ibHigh) { ibTrigger = { idx: i }; break; }
        if (sessBars[i].close < ibLow) { ibTrigger = { idx: i }; break; }
      }
    }
    const levels = getLevelsForDate(date);
    const onh = levels ? levels['ONH'] : null, onl = levels ? levels['ONL'] : null;
    let onTrigger = null;
    if (onh != null && onl != null) {
      for (let i = 0; i < sessBars.length; i++) {
        if (sessBars[i].close > onh) { onTrigger = { idx: i }; break; }
        if (sessBars[i].close < onl) { onTrigger = { idx: i }; break; }
      }
    }
    let chosenIdx = null;
    if (ibTrigger && onTrigger) chosenIdx = Math.min(ibTrigger.idx, onTrigger.idx);
    else if (ibTrigger) chosenIdx = ibTrigger.idx;
    else if (onTrigger) chosenIdx = onTrigger.idx;
    if (chosenIdx === null) continue;
    const setup = evalFromTrigger(sessBars, chosenIdx);
    if (setup) rthSetups.push({ date, ...setup });
  }
  console.log(`N=${rthSetups.length} resolved RTH_FLUSH setups`);
  const rthTarget = percentile(rthSetups.map(s => s.mfe), 0.5);

  // Volume-building 2-tier target (added 2026-08-28, scratch/rth_mode_pace_volume_retest.mjs):
  // checked whether RTH_FLUSH had the same hidden mode-specific pace/volume effect Globex did --
  // it doesn't need a mode split (pooling by continuation/reversal made RTH noisier, not
  // clearer), but volume-building holds up cleanly POOLED: BUILDING N=68 EV=$40.79/trade clean+
  // stable, NOT-building N=249 EV=$14.72/trade clean+stable, both individually past the N>=20
  // floor. Pace does NOT hold for RTH (confirmed unchanged from sec 4.13's original finding --
  // still noisy/inconsistent once split any way tested). Median split computed on the POOLED
  // population (not per-direction), matching how the effect was actually found.
  const withVol = rthSetups.filter(s => s.avgVolZ !== null && s.volZTrend !== null);
  const rthAvgVolMed = percentile(withVol.map(s => s.avgVolZ).sort((a, b) => a - b), 0.5);
  const rthTrendMed = percentile(withVol.map(s => s.volZTrend).sort((a, b) => a - b), 0.5);
  const rthBuilding = (s) => s.avgVolZ !== null && s.volZTrend !== null && s.avgVolZ > rthAvgVolMed && s.volZTrend > rthTrendMed;
  const rthBuildingTarget = percentile(rthSetups.filter(rthBuilding).map(s => s.mfe), 0.75);
  console.log(`Volume-building split: avgVolZ median=${rthAvgVolMed.toFixed(2)}, volZTrend median=${rthTrendMed.toFixed(2)}. NOT-building target=${rthTarget.toFixed(1)}pt (p50 MFE, unchanged), BUILDING target=${rthBuildingTarget.toFixed(1)}pt (p75 MFE of the building group).`);

  const rthResults = rthSetups.map(s => ({ date: s.date, dir: s.resolutionDir, building: rthBuilding(s), stopDist: Math.abs(s.entryPrice - s.stopPrice), ...simulateExit(s, rthBuilding(s) ? rthBuildingTarget : rthTarget) }));
  for (const dir of ['UP', 'DOWN']) {
    const bucket = rthResults.filter(r => r.dir === dir);
    const type = `RTH_FLUSH_${dir === 'UP' ? 'LONG' : 'SHORT'}`;
    if (!bucket.length) { console.log(`  ${type}: N=0`); continue; }
    const n = bucket.length, wins = bucket.filter(r => r.win).length, ev = bucket.reduce((s, r) => s + r.pnl, 0) / n;
    const rigor = n >= 20 ? computeRigor(bucket, { dateField: 'date', pnlFn: r => r.pnl }) : null;
    const avgStop = bucket.reduce((s, r) => s + r.stopDist, 0) / n;
    console.log(`  ${type}: N=${n}, WR=${(100 * wins / n).toFixed(1)}%, EV=$${ev.toFixed(2)}` + (rigor ? `, clean=${rigor.clean} stable=${rigor.stable}` : ' (N<20)'));
    await persist(type, n, wins / n, ev, ev * n,
      { method: 'stacked-ib-onh-onl-trigger-volume-building-tiered', target_method: 'p50-mfe-or-p75-mfe-if-building', rigor: rigor ? { clean: rigor.clean, stable: rigor.stable, thirds: rigor.thirds } : null },
      avgStop, rthTarget,
      { note: 'stopPts is INFORMATIONAL avg observed balance-zone width; live stop is structural (opposite balance edge), computed per-instance. optimal_target holds the NOT-building (baseline) target; buildingTarget/avgVolZMedian/volZTrendMedian below are what the live detector actually reads to pick between the two.',
        buildingTarget: +rthBuildingTarget.toFixed(1), avgVolZMedian: +rthAvgVolMed.toFixed(3), volZTrendMedian: +rthTrendMed.toFixed(3) });
  }

  // ============================= GLOBEX_FLUSH (value-departure-by-close design) =============
  // REDESIGNED 2026-08-28 -- the original "biggest move in the first 60 minutes of session open"
  // trigger (sec 4.6-4.13) was never actually what the user asked about or what sec 4.8 itself
  // found: sec 4.8's own (CONFIRMED) research shows price typically leaves prior-day value BY
  // RTH close (median ~4:15 PM), and the REAL acceleration move happens a median of ~5 HOURS
  // later, spread anywhere from 9 PM to past 2 AM -- never within a 60-minute window anchored at
  // session open. The two threads were never reconciled; this replaces the trigger entirely to
  // match sec 4.8's actual finding, while keeping the SAME balance/resolution/structural-stop
  // mechanism (the user's own "footing, then second move" description, unchanged and still
  // validated for RTH_FLUSH).
  //
  // Trigger = the value-departure bar itself (checked at RTH close through 30 min into the
  // extended session, matching sec 4.8's median 4:15 PM timing) -- NO extra magnitude filter.
  // An elbow-threshold trigger (require some minimum further movement before counting) was
  // tried first and left only 5-7 usable trades -- because "left value by close" is ALREADY a
  // real, meaningful, binary flush-defining event here, unlike the old 60-min-window design
  // where a magnitude filter was needed to separate a genuine flush from ordinary noise.
  // Balance/resolution then watches CONTINUOUSLY through the whole overnight session (no cap)
  // instead of a fixed window, matching sec 4.8's own "a watcher needs to run continuously"
  // conclusion.
  console.log('\n=== GLOBEX_FLUSH (value-departure-by-close trigger, continuous overnight watch, mode+pace+volume tiered) ===');

  const barsByDate = new Map();
  for (const b of allBars) {
    const d = b.ts.toISOString().slice(0, 10);
    if (!barsByDate.has(d)) barsByDate.set(d, []);
    barsByDate.get(d).push(b);
  }
  for (let i = 0; i < allBars.length; i++) allBars[i]._idx = i;

  const departures = [];
  for (const date of rthByDate.keys()) {
    const levels = getLevelsForDate(date);
    const val = levels?.PD_VAL, vah = levels?.PD_VAH;
    if (val == null || vah == null) continue;
    const closeWindow = barsByDate.get(date).filter(b => b.mod >= 959 && b.mod <= 989);
    let dir = null, departurePrice = null, globalIdx = null;
    for (const b of closeWindow) {
      if (b.close < val) { dir = 'DOWN'; departurePrice = b.close; globalIdx = b._idx; break; }
      if (b.close > vah) { dir = 'UP'; departurePrice = b.close; globalIdx = b._idx; break; }
    }
    if (dir) departures.push({ date, dir, departurePrice, globalIdx });
  }
  console.log(`Value-departure-by-close qualifying days: ${departures.length} (DOWN=${departures.filter(d => d.dir === 'DOWN').length}, UP=${departures.filter(d => d.dir === 'UP').length})`);

  // Continuous sequence from the departure bar through the next RTH open -- a direct global-array
  // slice, NOT globexByTradeDate (which starts hours later, at 5PM, well after the departure
  // already happened around 4-4:30 PM).
  function sequenceFor(dep) {
    const out = [];
    for (let i = dep.globalIdx; i < allBars.length; i++) {
      const b = allBars[i];
      if (i > dep.globalIdx && b.mod >= 570 && b.mod <= 959) break;
      out.push(b);
    }
    return out;
  }

  // MODE-AWARE design (2026-08-28, user-requested review): pooling all resolutions by direction
  // alone (the first version of this redesign) hid a real, much stronger effect. Pace and
  // volume-building show almost nothing in the pooled population (correlation 0.04-0.14) but a
  // real, tercile-clean pattern once split by MODE -- whether the departure direction and the
  // eventual resolution direction agree (CONTINUATION) or disagree (REVERSAL). This matches
  // sec 4.11-4.13's own methodology (tercile splits + a 3-tier pace/volume combined score, not a
  // raw correlation, which can miss a real non-linear/threshold effect entirely) applied
  // per-mode instead of pooled, since pooling is what erased the signal.
  const globexSetups = [];
  for (const dep of departures) {
    const seq = sequenceFor(dep);
    if (seq.length < 60) continue;
    const postBars = seq.slice(1); // strictly after the departure/trigger bar
    const res = computeBalanceAndResolution(postBars);
    if (!res) continue;
    const entryIdx = 1 + res.resolutionIdx;
    const entryBar = seq[entryIdx];
    const pace = computeEntryPace(dep.departurePrice, seq[0].ts, res.entryPrice, entryBar.ts);
    let mfe = 0;
    for (let i = entryIdx + 1; i < seq.length; i++) {
      const b = seq[i];
      const favorable = res.resolutionDir === 'UP' ? b.high - res.entryPrice : res.entryPrice - b.low;
      if (favorable > mfe) mfe = favorable;
    }
    // Volume-building: bars from departure (exclusive) through the ENTRY bar (inclusive) --
    // fully known at the moment of entry, no lookahead (the original design's bug let this
    // window extend PAST the entry bar; fixed here by construction).
    const preEntryBars = seq.slice(1, entryIdx + 1);
    const volZs = preEntryBars.map(b => b.volZ).filter(v => v !== null);
    const avgVolZ = volZs.length >= 5 ? volZs.reduce((a, b) => a + b, 0) / volZs.length : null;
    let volZTrend = null;
    if (volZs.length >= 5) {
      const n = volZs.length, xs = Array.from({ length: n }, (_, i) => i);
      const mx = xs.reduce((a, b) => a + b, 0) / n, my = volZs.reduce((a, b) => a + b, 0) / n;
      let cov = 0, vx = 0, vy = 0;
      for (let i = 0; i < n; i++) { cov += (xs[i] - mx) * (volZs[i] - my); vx += (xs[i] - mx) ** 2; vy += (volZs[i] - my) ** 2; }
      volZTrend = (vx > 0 && vy > 0) ? cov / Math.sqrt(vx * vy) : 0;
    }
    const mode = dep.dir === res.resolutionDir ? 'CONTINUATION' : 'REVERSAL';
    globexSetups.push({ date: dep.date, departureDir: dep.dir, resolutionDir: res.resolutionDir, mode, entryPrice: res.entryPrice, stopPrice: res.stopPrice, entryIdx, sessBars: seq, pace, mfe, avgVolZ, volZTrend });
  }
  console.log(`N=${globexSetups.length} resolved GLOBEX_FLUSH setups`);

  for (const [depDir, resDir, mode] of [['UP', 'UP', 'CONTINUATION'], ['DOWN', 'UP', 'REVERSAL'], ['DOWN', 'DOWN', 'CONTINUATION'], ['UP', 'DOWN', 'REVERSAL']]) {
    const bucket = globexSetups.filter(s => s.departureDir === depDir && s.resolutionDir === resDir);
    const long = resDir === 'UP';
    const type = mode === 'CONTINUATION' ? `GLOBEX_FLUSH_${long ? 'LONG' : 'SHORT'}` : `GLOBEX_FLUSH_REVERSAL_${long ? 'LONG' : 'SHORT'}`;
    if (bucket.length < 15) { console.log(`  ${type} (${depDir}->${resDir}): N=${bucket.length}, too few to calibrate`); continue; }

    // Pace tercile + volume-building median split, computed on THIS MODE's own population --
    // sec 4.13's exact combined-score design (count of {NOT-fast pace, building volume}, 0/1/2),
    // each score tier's target from its OWN p75 MFE.
    const withPace = bucket.filter(s => s.pace !== null);
    const paces = withPace.map(s => s.pace).sort((a, b) => a - b);
    const paceT2 = percentile(paces, 2 / 3); // top third = FAST
    const withVol = bucket.filter(s => s.avgVolZ !== null && s.volZTrend !== null);
    const avgVolMed = percentile(withVol.map(s => s.avgVolZ).sort((a, b) => a - b), 0.5);
    const trendMed = percentile(withVol.map(s => s.volZTrend).sort((a, b) => a - b), 0.5);

    function scoreOf(s) {
      let score = 0;
      if (s.pace !== null && s.pace <= paceT2) score++; // NOT-fast
      if (s.avgVolZ !== null && s.volZTrend !== null && s.avgVolZ > avgVolMed && s.volZTrend > trendMed) score++; // building
      return score;
    }
    const tierTargets = {};
    for (const score of [0, 1, 2]) {
      const tierBucket = bucket.filter(s => scoreOf(s) === score);
      tierTargets[score] = tierBucket.length >= 8 ? percentile(tierBucket.map(s => s.mfe), 0.75) : percentile(bucket.map(s => s.mfe), 0.5);
    }
    const targetFn = (s) => tierTargets[scoreOf(s)];

    const results = bucket.map(s => ({ date: s.date, stopDist: Math.abs(s.entryPrice - s.stopPrice), score: scoreOf(s), ...simulateExit(s, targetFn(s)) }));
    const n = results.length, wins = results.filter(r => r.win).length, ev = results.reduce((s, r) => s + r.pnl, 0) / n;
    const rigor = n >= 20 ? computeRigor(results, { dateField: 'date', pnlFn: r => r.pnl }) : null;
    const avgStop = results.reduce((s, r) => s + r.stopDist, 0) / n;
    console.log(`  ${type} (${depDir}->${resDir} ${mode}): N=${n}, WR=${(100 * wins / n).toFixed(1)}%, EV=$${ev.toFixed(2)}, tierTargets=[${[0,1,2].map(s=>tierTargets[s].toFixed(0)).join(',')}]pt` + (rigor ? `, clean=${rigor.clean} stable=${rigor.stable} thirds=${JSON.stringify(rigor.thirds)}` : ' (N<20)'));
    for (const score of [0, 1, 2]) {
      const sb = results.filter(r => r.score === score);
      if (sb.length) console.log(`    score=${score}: N=${sb.length}, EV=$${(sb.reduce((s,r)=>s+r.pnl,0)/sb.length).toFixed(2)}/trade`);
    }
    await persist(type, n, wins / n, ev, ev * n,
      { method: 'value-departure-mode-pace-volume-tiered', mode, rigor: rigor ? { clean: rigor.clean, stable: rigor.stable, thirds: rigor.thirds } : null },
      avgStop, tierTargets[1],
      { note: 'stopPts is INFORMATIONAL avg observed balance-zone width; live stop is structural, computed per-instance. optimal_target holds the score=1 (middle) tier; tierTargets/paceCutoffPtsPerMin/avgVolZMedian/volZTrendMedian below are what the live detector actually reads to pick the tier.',
        tierTargets: { 0: +tierTargets[0].toFixed(1), 1: +tierTargets[1].toFixed(1), 2: +tierTargets[2].toFixed(1) },
        paceCutoffPtsPerMin: +paceT2.toFixed(4), avgVolZMedian: +avgVolMed.toFixed(3), volZTrendMedian: +trendMed.toFixed(3) });
  }

  console.log('\n[backtest_flush_patterns] Done.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
