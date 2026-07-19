// Third pass at the post-resolution excursion question (see docs/OPEN_THREADS.md
// "Post-resolution excursion research" for the full thread). The first two passes
// (backtest_post_stop_recovery.mjs, backtest_post_target_runup.mjs) only recorded the
// two EXTREME points (max favorable, max adverse) over a flat 4-hour window -- with no
// record of which happened first. That's not just imprecise, it's actively misleading:
// "price ran further our way, then gave some back" (real, capturable) and "price dropped
// hard against us first, and only recovered to a new extreme much later" (you'd have
// been shaken out before ever seeing it) produce similar summary numbers under that
// method, but mean opposite things.
//
// This version tracks the actual SEQUENCE of new favorable/adverse extremes (not every
// bar -- just the moments a new high or low is set), with real ET clock time on each,
// so we can answer:
//   1. After resolution, which comes first -- a new favorable extreme or a new adverse
//      one -- and how long after resolution?
//   2. Efficiency: what fraction of the eventual true extreme (within the window) did
//      the current target/stop actually capture? (User's own framing: "capture profit
//      within 10% of the actual bottom if calibrated properly.")
//   3. Tests the user's specific domain claim directly rather than assuming it: do
//      adverse extensions on STOP_HIT trades cluster in the first ~2 hours and then
//      taper off around 11:00-12:00 ET? Independently, scripts/archive/backtest_post_flush.js
//      already found whole-session flush resolution averages 11:52 AM (45% in the 11 AM
//      hour) -- this checks whether the SAME per-trade pattern holds for setup-level
//      stop-outs specifically, not just whole-day flushes.
//
// Same entry-price/favorable/adverse convention as acd.js's live resolution path,
// reused not reinvented. Window still capped at EXTENSION_WINDOW_BARS (240, ~4hr) as an
// outer bound, but the interesting output here is WHEN things happen within that window,
// not just whether they happen at all.
//
// Run: node scripts/backtest_post_resolution_sequence.mjs
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';

const EXTENSION_WINDOW_BARS = 240;

function etClockString(ts) {
  const d = new Date(ts);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const h = parts.find(p => p.type === 'hour').value;
  const m = parts.find(p => p.type === 'minute').value;
  return `${h}:${m}`;
}
function etMinuteOfDay(ts) {
  const d = new Date(ts);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(d);
  const h = +parts.find(p => p.type === 'hour').value;
  const m = +parts.find(p => p.type === 'minute').value;
  return h * 60 + m;
}

async function loadTrades(resolutionType) {
  const res = await query(`
    SELECT setup_type, fired_at, resolved_at, entry_zone_low::float as entry_zone_low,
      entry_zone_high::float as entry_zone_high, stop_level::float as stop_level,
      t1_level::float as t1_level, mae_points::float as mae_points, mfe_points::float as mfe_points
    FROM active_setups
    WHERE resolution = $1 AND mae_points IS NOT NULL AND mfe_points IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300 AND resolved_at IS NOT NULL
      AND entry_zone_low IS NOT NULL AND t1_level IS NOT NULL
    ORDER BY resolved_at ASC
  `, [resolutionType]);
  return res.rows;
}

async function main() {
  console.log('Loading trades and bars...');
  const stopHitTrades = await loadTrades('STOP_HIT');
  const targetHitTrades = await loadTrades('TARGET_HIT');
  console.log(`${stopHitTrades.length} STOP_HIT, ${targetHitTrades.length} TARGET_HIT.`);

  const barsRes = await query(`SELECT ts, high::float as high, low::float as low FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low }));
  console.log(`${allBars.length} bars loaded.`);

  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  // For one trade, walk the extension window and return the sequence of NEW extremes
  // (favorable and adverse), each tagged with bars-since-resolution and ET clock time.
  function walkSequence(trade) {
    const direction = inferDirection(trade.setup_type);
    if (!direction) return null;
    const long = direction === 'LONG';
    const entry = trade.entry_zone_high ?? trade.entry_zone_low;
    const resolvedTime = new Date(trade.resolved_at).getTime();
    const startIdx = firstIndexAfter(resolvedTime);
    const endIdx = Math.min(allBars.length, startIdx + EXTENSION_WINDOW_BARS);

    let runFavorable = long ? trade.mfe_points : trade.mfe_points; // seed from already-known pre-resolution value
    let runAdverse = trade.mae_points;
    let firstNewFavorableAt = null; // { barsSince, etTime, value }
    let firstNewAdverseAt = null;
    let lastNewAdverseAt = null; // when the adverse excursion FINALLY stops getting worse -- the real test of "does the down move taper off by 11-12"
    let finalFavorable = runFavorable;
    let finalAdverse = runAdverse;

    for (let i = startIdx; i < endIdx; i++) {
      const bar = allBars[i];
      const favorable = long ? bar.high - entry : entry - bar.low;
      const adverse = long ? entry - bar.low : bar.high - entry;
      const barsSince = i - startIdx + 1;

      if (favorable > runFavorable) {
        runFavorable = favorable;
        finalFavorable = favorable;
        if (!firstNewFavorableAt) firstNewFavorableAt = { barsSince, etTime: etClockString(bar.ts), etMin: etMinuteOfDay(bar.ts) };
      }
      if (adverse > runAdverse) {
        runAdverse = adverse;
        finalAdverse = adverse;
        if (!firstNewAdverseAt) firstNewAdverseAt = { barsSince, etTime: etClockString(bar.ts), etMin: etMinuteOfDay(bar.ts) };
        lastNewAdverseAt = { barsSince, etTime: etClockString(bar.ts), etMin: etMinuteOfDay(bar.ts) };
      }
    }

    let whichFirst = null;
    if (firstNewFavorableAt && firstNewAdverseAt) {
      whichFirst = firstNewFavorableAt.barsSince <= firstNewAdverseAt.barsSince ? 'FAVORABLE_FIRST' : 'ADVERSE_FIRST';
    } else if (firstNewFavorableAt) whichFirst = 'FAVORABLE_ONLY';
    else if (firstNewAdverseAt) whichFirst = 'ADVERSE_ONLY';
    else whichFirst = 'NEITHER';

    const targetDistance = Math.abs(trade.t1_level - entry);
    // Efficiency: what fraction of the eventual true favorable extreme (within this
    // window) does the setup's own target distance capture? User's framing: a
    // well-calibrated setup should land >=90% (within 10% of the actual extreme).
    const efficiency = finalFavorable > 0 ? +(Math.min(targetDistance, finalFavorable) / finalFavorable * 100).toFixed(1) : null;

    return {
      setup_type: trade.setup_type,
      resolvedEtTime: etClockString(resolvedTime),
      resolvedEtMin: etMinuteOfDay(resolvedTime),
      originalMfe: trade.mfe_points, originalMae: trade.mae_points,
      finalFavorable, finalAdverse, targetDistance, efficiency,
      whichFirst, firstNewFavorableAt, firstNewAdverseAt, lastNewAdverseAt,
    };
  }

  function summarize(trades, label, signalTypeSuffix) {
    const results = trades.map(walkSequence).filter(Boolean);
    const bySetup = {};
    for (const r of results) (bySetup[r.setup_type] ||= []).push(r);

    console.log(`\n=== ${label}: sequencing summary (N>=20) ===`);
    const summary = [];
    for (const [setup, rows] of Object.entries(bySetup)) {
      if (rows.length < 20) continue;
      const favFirst = rows.filter(r => r.whichFirst === 'FAVORABLE_FIRST').length;
      const advFirst = rows.filter(r => r.whichFirst === 'ADVERSE_FIRST').length;
      const favOnly = rows.filter(r => r.whichFirst === 'FAVORABLE_ONLY').length;
      const advOnly = rows.filter(r => r.whichFirst === 'ADVERSE_ONLY').length;
      const neither = rows.filter(r => r.whichFirst === 'NEITHER').length;
      const effVals = rows.map(r => r.efficiency).filter(e => e != null);
      const avgEfficiency = effVals.length ? +(effVals.reduce((s,e)=>s+e,0)/effVals.length).toFixed(1) : null;
      summary.push({ setup_type: setup, n: rows.length, favFirstPct: +(100*favFirst/rows.length).toFixed(1), advFirstPct: +(100*advFirst/rows.length).toFixed(1), favOnlyPct: +(100*favOnly/rows.length).toFixed(1), advOnlyPct: +(100*advOnly/rows.length).toFixed(1), neitherPct: +(100*neither/rows.length).toFixed(1), avgEfficiency });
    }
    console.log(JSON.stringify(summary.sort((a,b)=>b.advFirstPct-a.advFirstPct), null, 2));
    return { results, summary, signalTypeSuffix };
  }

  const stopSummarized = summarize(stopHitTrades, 'STOP_HIT (does adverse deepen before recovery, or does it recover cleanly?)', 'STOP');
  const stopResults = stopSummarized.results;
  const targetSummarized = summarize(targetHitTrades, 'TARGET_HIT (does price run further first, or drop against us first?)', 'TARGET');
  const targetResults = targetSummarized.results;

  // Test the specific time-of-day claim PROPERLY this time -- the first attempt
  // bucketed the FIRST new-adverse tick by raw clock time, which mostly just measured
  // when stop-outs happen to occur in the first place (91.7% "before 10am", a real but
  // uninformative confound -- level-fade stop-outs cluster in the morning session
  // regardless of this question). The actual claim ("down moves continue ~2hrs, then
  // TRY to retrace around 11-noon") is about when the adverse excursion FINALLY STOPS
  // GETTING WORSE, conditioned on trades whose stop-out already happened in the morning
  // (matching "down moves happen quickly early") -- not raw clock time of any tick.
  // Second correction (2026-07-18): also require the extension to be SUBSTANTIAL
  // (>=50pt beyond the stop, matching backtest_level_continuation_magnitude.mjs's own
  // "real continuation, not noise" threshold) -- otherwise a 3-point tick 2 minutes
  // after the stop counts the same as a genuine 100pt continuation, which was still
  // conflating "when do stop-outs happen" with "does the down move actually taper off."
  const SUBSTANTIAL_EXTENSION_PTS = 50;
  const morningStopHits = stopResults.filter(r =>
    r.resolvedEtMin < 660 && r.lastNewAdverseAt && (r.finalAdverse - r.originalMae) >= SUBSTANTIAL_EXTENSION_PTS
  ); // resolved before 11:00 ET, AND kept extending adverse afterward, AND that extension was real (>=50pt)
  const lastAdverseBuckets = { 'before 10am': 0, '10-11am': 0, '11am-12pm': 0, '12-1pm': 0, 'after 1pm': 0 };
  for (const r of morningStopHits) {
    const m = r.lastNewAdverseAt.etMin;
    if (m < 600) lastAdverseBuckets['before 10am']++;
    else if (m < 660) lastAdverseBuckets['10-11am']++;
    else if (m < 720) lastAdverseBuckets['11am-12pm']++;
    else if (m < 780) lastAdverseBuckets['12-1pm']++;
    else lastAdverseBuckets['after 1pm']++;
  }
  console.log(`\n=== Corrected time-of-day test v2: STOP_HIT trades resolved before 11am ET with a SUBSTANTIAL (>=${SUBSTANTIAL_EXTENSION_PTS}pt) adverse extension afterward -- when does it finally stop getting worse? ===`);
  console.log(`N=${morningStopHits.length} (of ${stopResults.filter(r => r.resolvedEtMin < 660).length} total morning stop-outs)`);
  console.log(lastAdverseBuckets);
  const pctByNoon = morningStopHits.length ? +(100 * (lastAdverseBuckets['before 10am'] + lastAdverseBuckets['10-11am'] + lastAdverseBuckets['11am-12pm']) / morningStopHits.length).toFixed(1) : null;
  console.log(`${pctByNoon}% of these finish extending adverse by 12:00 ET.`);

  const today = (await query(`SELECT CURRENT_DATE::text as d`)).rows[0].d;

  // Persist the corrected time-of-day distribution
  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes)
    VALUES ($1, 0, 'POST_RES_SEQ', 'adverse_taper_timing', $2, $3)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET sample_size=EXCLUDED.sample_size, notes=EXCLUDED.notes
  `, [today, morningStopHits.length, JSON.stringify({ buckets: lastAdverseBuckets, pctByNoon })]);

  // Persist the main sequencing/efficiency summaries per setup_type -- "might have to
  // save this test" (user, 2026-07-18) -- this is the actual finding, not just the
  // time-of-day side test.
  for (const s of stopSummarized.summary) {
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, notes)
      VALUES ($1, 0, 'POST_RES_SEQ', $2, $3, $4, $5)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
        SET sample_size=EXCLUDED.sample_size, ev_per_trade=EXCLUDED.ev_per_trade, notes=EXCLUDED.notes
    `, [today, `STOP_${s.setup_type}`.slice(0, 60), s.n, s.avgEfficiency, JSON.stringify({ resolutionType: 'STOP_HIT', ...s })]);
  }
  for (const s of targetSummarized.summary) {
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, notes)
      VALUES ($1, 0, 'POST_RES_SEQ', $2, $3, $4, $5)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
        SET sample_size=EXCLUDED.sample_size, ev_per_trade=EXCLUDED.ev_per_trade, notes=EXCLUDED.notes
    `, [today, `TARGET_${s.setup_type}`.slice(0, 60), s.n, s.avgEfficiency, JSON.stringify({ resolutionType: 'TARGET_HIT', ...s })]);
  }
  console.log(`\nPersisted corrected time-of-day test + ${stopSummarized.summary.length + targetSummarized.summary.length} per-setup sequencing summaries to performance_audit (signal_type='POST_RES_SEQ').`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
