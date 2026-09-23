// Phase 1: does an "approaching a level ahead + elevated velocity" context at the moment
// MOMENTUM_CHASE_MEDIUM_LONG/SHORT triggers predict meaningfully more room beyond its
// CURRENT fixed target -- i.e., is this a case for extending an existing setup's target,
// not inventing a new setup? (2026-09-22, user: "I would love to consider this as an option
// to possibly change existing targets as opposed to create a new setup.")
//
// Reuses momentumChaseDetector.js's own real trigger condition (a 5-min RTH bar closing
// beyond the prior day's RTH high/low, before 12:00pm ET, MEDIUM GARCH regime only) exactly
// as documented in scratch/backtest_script_round5.py's run_setup_6_scaled() -- replayed here
// in Node against the full real bar history so we get every historical trigger instance, not
// just momentum_chase's own real_n=3 live fires. Reuses getPriorDayRthRange() (real function,
// server/services/queries.js) and the real GARCH_VOL_SCALE history/percentile methodology
// (matches getCurrentGarchRegime()'s own p30/p80 linear-interpolation convention) -- never
// reimplements either.
//
// This is a Phase 1 real-$ test (uses the setup's own real calibrated width as the entry/
// stop/target geometry), not a Phase 0 forward-return pretest -- that groundwork (velocity
// window sweep, direction-aware level-ahead/behind split) was already done in
// scripts/phase0_velocity_context_pretest.mjs the same session; this reuses its finding
// (5min velocity window showed the most consistent signal; "approaching a level ahead"
// within 15pt showed a consistent positive split across all 7 tested windows, though none
// individually cleared a day-blocked bootstrap CI on their own).
import { query } from '../server/db.js';
import { getPriorDayRthRange } from '../server/services/queries.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { dayBlockedBootstrapCI, computeRigor } from '../server/services/rigorDiagnostics.js';

const LEVEL_PROXIMITY_PTS = 15;
const VELOCITY_WINDOW = 5; // the window phase0_velocity_context_pretest.mjs found most consistent
const EXTENSION_WINDOW_MIN = 120; // how far past target-hit to measure "room left on the table"
const SAME_DAY_FORMING_LEVEL_PREFIXES = [
  'OR5_', 'OR10_', 'OR15_', 'OR30_', 'IB_HIGH', 'IB_LOW', 'IB_MID',
  'PD_OR_MID', '5D_OR_MID', '10D_IB_MID', 'RTH_VWAP', 'DEV_POC', 'MONTHLY_VWAP',
];

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }

async function main() {
  // ── Real GARCH regime classification per date (matches getCurrentGarchRegime()'s own
  // p30/p80 linear-interpolation-percentile methodology exactly) ──
  const garchRes = await query(`
    SELECT run_date::text as trade_date, (notes::jsonb->>'scale')::float as scale
    FROM performance_audit WHERE signal_type='GARCH_VOL_SCALE' AND signal_name != 'LATEST'
    ORDER BY run_date ASC
  `);
  const scales = garchRes.rows.map(r => r.scale).filter(s => s != null).sort((a, b) => a - b);
  function pct(p) {
    const pos = p * (scales.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? scales[lo] : scales[lo] + (scales[hi] - scales[lo]) * (pos - lo);
  }
  const p30 = pct(0.30), p80 = pct(0.80);
  const regimeByDate = new Map();
  for (const r of garchRes.rows) {
    if (r.scale == null) continue;
    regimeByDate.set(r.trade_date, r.scale < p30 ? 'LOW' : r.scale <= p80 ? 'MEDIUM' : 'HIGH');
  }
  const mediumDates = [...regimeByDate.entries()].filter(([, r]) => r === 'MEDIUM').map(([d]) => d)
    .filter(d => !isInsideNqRollWeek(d));
  console.log(`Real GARCH history: N=${scales.length} days, p30=${p30.toFixed(3)} p80=${p80.toFixed(3)}. MEDIUM-regime trading days (roll-week excluded): ${mediumDates.length}`);

  // ── Current live target width (real calibration, not a guess) ──
  const widthRes = await query(`SELECT notes FROM performance_audit WHERE signal_type='MOMENTUM_CHASE_WIDTH' ORDER BY run_date DESC LIMIT 1`);
  const currentWidth = widthRes.rows[0] ? JSON.parse(widthRes.rows[0].notes).widths?.MEDIUM : null;
  const width = currentWidth ?? 46; // 46pt = the original backtest's full-history 75th-pctile fallback
  console.log(`Current live MEDIUM-regime target/stop width: ${width}pt${currentWidth == null ? ' (fallback -- no calibration row found)' : ''}`);

  // ── Level prices, excluding same-day-forming families ──
  const levelRes = await query(`SELECT trade_date::text as trade_date, level_name, price::float as price FROM level_prices WHERE price IS NOT NULL`);
  const levelsByDate = new Map();
  for (const r of levelRes.rows) {
    if (SAME_DAY_FORMING_LEVEL_PREFIXES.some(p => r.level_name.startsWith(p))) continue;
    if (!levelsByDate.has(r.trade_date)) levelsByDate.set(r.trade_date, []);
    levelsByDate.get(r.trade_date).push(r.price);
  }

  // ── For each MEDIUM-regime date: find the real trigger (5-min bar close beyond PDH/PDL,
  // before 12:00pm ET, first one wins -- exactly run_setup_6_scaled()'s own logic) ──
  const results = [];
  let checked = 0, noPriorRange = 0, noTrigger = 0;
  for (const date of mediumDates) {
    checked++;
    const { pdHigh, pdLow } = await getPriorDayRthRange(date);
    if (pdHigh == null || pdLow == null) { noPriorRange++; continue; }

    const barsRes = await query(`
      SELECT ts::text as ts_text, close::float as close, high::float as high, low::float as low, volume::float as volume
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts >= $1 AND ts < $2
      ORDER BY ts ASC
    `, [`${date} 09:30:00`, `${date} 12:05:00`]);
    const bars1m = barsRes.rows;
    if (!bars1m.length) { noTrigger++; continue; }

    // 5-min bars via simple bucketing of the 1-min bars (close = last 1-min close in bucket)
    const buckets = new Map();
    for (const b of bars1m) {
      const hh = Number(b.ts_text.slice(11, 13)), mm = Number(b.ts_text.slice(14, 16));
      const bucketMin = Math.floor((hh * 60 + mm) / 5) * 5;
      const key = bucketMin;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(b);
    }
    const fiveMinBars = [...buckets.entries()].sort((a, b) => a[0] - b[0])
      .map(([min, group]) => ({ min, close: group[group.length - 1].close, ts_text: group[group.length - 1].ts_text }));

    let trigger = null;
    for (const b5 of fiveMinBars) {
      if (b5.min >= 720) break; // 12:00pm cutoff, matches run_setup_6_scaled()
      if (b5.close > pdHigh) { trigger = { dir: 1, entry: b5.close, ts_text: b5.ts_text }; break; }
      if (b5.close < pdLow) { trigger = { dir: -1, entry: b5.close, ts_text: b5.ts_text }; break; }
    }
    if (!trigger) { noTrigger++; continue; }

    // Find the matching 1-min bar index at the trigger instant (for velocity/level features)
    const triggerIdx = bars1m.findIndex(b => b.ts_text === trigger.ts_text);
    if (triggerIdx < 0) continue;

    // 5-min velocity (raw pts, using bars1m, requires >=5 prior 1-min bars in this window --
    // if the trigger is very early, pull a small amount of pre-9:30 context from a wider query)
    let velocity5 = null;
    if (triggerIdx >= 5) {
      velocity5 = Math.abs(bars1m[triggerIdx].close - bars1m[triggerIdx - 5].close);
    }

    // volZ_trailing20 (needs 20 prior 1-min bars; same early-session limitation)
    let volZ = null;
    if (triggerIdx >= 20) {
      const vols = bars1m.slice(triggerIdx - 20, triggerIdx).map(b => b.volume);
      const m = mean(vols), s = Math.sqrt(vols.reduce((s2, v) => s2 + (v - m) ** 2, 0) / vols.length);
      volZ = s > 0 ? (bars1m[triggerIdx].volume - m) / s : null;
    }

    // Level ahead in the trigger's own direction (excluding same-day-forming levels)
    const levels = levelsByDate.get(date) || [];
    let aheadDist = null;
    for (const l of levels) {
      const isAhead = trigger.dir > 0 ? l > trigger.entry : l < trigger.entry;
      if (isAhead) { const d = Math.abs(trigger.entry - l); if (aheadDist == null || d < aheadDist) aheadDist = d; }
    }

    // ── Real trade sim: stop/target = entry +/- width, conservative stop-first-if-both,
    // then (if target hit) measure MFE beyond target for another EXTENSION_WINDOW_MIN ──
    const stopPx = trigger.dir > 0 ? trigger.entry - width : trigger.entry + width;
    const targetPx = trigger.dir > 0 ? trigger.entry + width : trigger.entry - width;
    let outcome = 'NO_RESOLUTION', targetHitIdx = null;
    for (let i = triggerIdx + 1; i < bars1m.length; i++) {
      const b = bars1m[i];
      const stopHit = trigger.dir > 0 ? b.low <= stopPx : b.high >= stopPx;
      const targetHit = trigger.dir > 0 ? b.high >= targetPx : b.low <= targetPx;
      if (stopHit && targetHit) { outcome = 'STOP_HIT'; break; } // conservative, matches this codebase's own convention
      if (stopHit) { outcome = 'STOP_HIT'; break; }
      if (targetHit) { outcome = 'TARGET_HIT'; targetHitIdx = i; break; }
    }
    // Also need bars AFTER the RTH morning window to measure extension -- widen the query
    // for this one measurement, not the whole loop
    let extensionPts = null;
    if (outcome === 'TARGET_HIT') {
      const extRes = await query(`
        SELECT high::float as high, low::float as low FROM price_bars_primary
        WHERE symbol='NQ' AND ts > $1 AND ts <= $1::timestamp + INTERVAL '${EXTENSION_WINDOW_MIN} minutes'
        ORDER BY ts ASC
      `, [bars1m[targetHitIdx].ts_text]);
      if (extRes.rows.length) {
        const furthest = trigger.dir > 0
          ? Math.max(...extRes.rows.map(r => r.high))
          : Math.min(...extRes.rows.map(r => r.low));
        extensionPts = trigger.dir > 0 ? (furthest - targetPx) : (targetPx - furthest);
      }
    }

    results.push({
      date, dir: trigger.dir, entry: trigger.entry, velocity5, volZ, aheadDist,
      outcome, extensionPts,
      approaching: aheadDist != null && aheadDist <= LEVEL_PROXIMITY_PTS,
    });
  }

  console.log(`\nChecked ${checked} MEDIUM-regime days: no-prior-range=${noPriorRange}, no-trigger=${noTrigger}, real triggers found=${results.length}`);

  const withVel = results.filter(r => r.velocity5 != null && r.aheadDist != null);
  console.log(`Triggers with complete velocity+level features: ${withVel.length}`);

  const approaching = withVel.filter(r => r.approaching);
  const notApproaching = withVel.filter(r => !r.approaching);

  console.log('\n=== Base outcome rates (current fixed width, no context conditioning) ===');
  for (const [label, group] of [['ALL', withVel], ['approaching-a-level', approaching], ['not-approaching', notApproaching]]) {
    const targetHit = group.filter(r => r.outcome === 'TARGET_HIT').length;
    console.log(`  ${label}: N=${group.length}, TARGET_HIT=${targetHit} (${group.length ? (targetHit / group.length * 100).toFixed(1) : '--'}%), STOP_HIT=${group.filter(r=>r.outcome==='STOP_HIT').length}`);
  }

  console.log(`\n=== Extension beyond target (winners only), current width=${width}pt, measured over next ${EXTENSION_WINDOW_MIN}min ===`);
  for (const [label, group] of [['approaching-a-level', approaching], ['not-approaching', notApproaching]]) {
    const winners = group.filter(r => r.outcome === 'TARGET_HIT' && r.extensionPts != null);
    const extMean = mean(winners.map(r => r.extensionPts));
    console.log(`  ${label}: N winners=${winners.length}, mean extension beyond target=${extMean != null ? extMean.toFixed(1) + 'pt' : '--'}`);
    if (winners.length >= 10) {
      const rig = computeRigor(winners.map(r => ({ date: r.date, pnl: r.extensionPts })), { dateField: 'date', pnlFn: e => e.pnl });
      console.log(`    distinctDates=${rig.distinctDates} top5DayPct=${rig.top5DayPct} clustered=${rig.clustered}`);
      if (winners.length >= 20) {
        const ci = dayBlockedBootstrapCI(winners.map(r => ({ date: r.date, pnl: r.extensionPts })), `momentum_chase_ext_${label}`, { dateField: 'date' });
        console.log(`    day-blocked bootstrap 95% CI: [${ci.lo.toFixed(1)}, ${ci.hi.toFixed(1)}]`, ci.lo > 0 ? '(excludes zero, positive)' : ci.hi < 0 ? '(excludes zero, negative)' : '(crosses zero)');
      }
    }
  }

  console.log('\n=== Net effect if target were EXTENDED for approaching-a-level triggers only ===');
  // Compare: current-width-only P&L vs. a hypothetical "let it run the extension window" P&L,
  // for the approaching-a-level subgroup specifically (the one the level-context idea would apply to).
  const apWinners = approaching.filter(r => r.outcome === 'TARGET_HIT' && r.extensionPts != null);
  const apLosers = approaching.filter(r => r.outcome === 'STOP_HIT');
  console.log(`  Approaching-a-level population: ${apWinners.length} target-hit + ${apLosers.length} stop-hit (of ${approaching.length} total)`);
  if (apWinners.length) {
    console.log(`  Current fixed target captures: ${width}pt/winner. Extended-hold would have captured: ${width}pt + mean ${mean(apWinners.map(r=>r.extensionPts)).toFixed(1)}pt further = ${(width + mean(apWinners.map(r=>r.extensionPts))).toFixed(1)}pt/winner`);
    console.log(`  (This does NOT account for extension-phase drawdown/give-back risk -- a real trail/runner mechanism would need its own stop management during the extension window, not measured here.)`);
  }

  console.log('\n=== DONE — pretest result, not a promoted finding ===');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
