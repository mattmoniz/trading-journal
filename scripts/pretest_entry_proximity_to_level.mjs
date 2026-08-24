// Tests the user's direct hypothesis (2026-08-24): entries fire the moment price comes
// within the standard 15pt "nearLevels" window of a level (acd.js's live convention,
// entry=currentPrice — NOT the level price), and stop/target are fixed distances FROM
// ENTRY, not from the level. So an "early" entry (far from the level, anticipating the
// touch) mechanically eats into the intended stop distance if price keeps drifting toward
// the level before any real reversal begins. Concern: this may be causing premature
// stop-outs vs. waiting for price to actually touch/near the level.
//
// This is a purely RETROSPECTIVE conditioning test on real, already-resolved trades — no
// resimulation, no lookahead risk. For each real fired trade, recover the actual level price
// it was fading (setup_type -> level_name via the standard _FADE_LONG/_FADE_SHORT naming
// convention, joined against level_prices for that trade_date), compute how far the entry
// actually was from the level at fire time, and condition the REAL, ALREADY-KNOWN outcome
// on that distance. Does not yet answer "what would a tighter live rule produce" (that would
// require a real bar-by-bar resimulation with a no-lookahead entry-timing rule) -- this is
// the cheap first look to see if the hypothesis has legs before building that.
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;

function setupTypeToLevelName(setupType) {
  let s = setupType;
  s = s.replace(/_OVERNIGHT$/, '');
  s = s.replace(/_TRAIL$/, '');
  s = s.replace(/_GAP_(UP|DOWN)$/, '');
  const m = s.match(/^(.*)_FADE_(LONG|SHORT)$/);
  return m ? m[1] : null;
}

// EXCLUDE same-day-forming levels (Opening Range, Initial Balance, and anything derived
// from IB) — found live while sanity-checking this script's own output: IB_LOW isn't
// finalized until 10:30 ET, so a candidate firing at 9:45 against an in-progress IB_LOW
// gets compared here against the FINAL end-of-day value, producing a fake "77pt away"
// reading that has nothing to do with how far the entry actually was from what was live at
// fire time. Same bug class CLAUDE.md's own New Setup Type checklist item 10 already
// documents ("same-day-forming levels need their own formation gate or a re-test introduces
// lookahead") — this script hit exactly that, caught by spot-checking its own extreme
// outliers before trusting the numbers. Restricting to levels fully fixed BEFORE the
// session starts (prior-day/week/month levels, floor pivots) avoids it entirely rather than
// trying to reconstruct point-in-time IB/OR values.
const SAME_DAY_FORMING_LEVEL_PREFIXES = [
  'OR5_', 'OR10_', 'OR15_', 'OR30_', 'IB_HIGH', 'IB_LOW', 'IB_MID',
  'PD_OR_MID', '5D_OR_MID', '10D_IB_MID',
  // Also excluded: continuously-DEVELOPING levels (not same-day-FORMING, but never fixed
  // at all during the session) -- same confound CLAUDE.md already documents for confluence
  // pair calibration ("pairs involving a developing level, session VWAP/DEV_POC, are
  // excluded by design"). Found live via this script's own outlier check: RTH_VWAP_FADE_LONG
  // showed a 22.4pt "distance" that's actually just the running VWAP having moved since fire
  // time, not a stale-entry artifact.
  'RTH_VWAP', 'DEV_POC', 'MONTHLY_VWAP',
];
// Sanity cap: the live nearLevels window is 15pt (acd.js). Anything beyond ~20pt (modest
// slack for poll-cycle lag) after excluding same-day-forming/developing levels is not a real
// "how far was the entry from the level" reading -- it's stale/mismatched level_prices data.
// Found live: 5 of 13 such outliers clustered on a single date (2026-07-16), consistent with
// a real, isolated data-quality issue for that day rather than 13 independent explanations.
// Applied symmetrically (a hard cap, not a cherry-pick) rather than chasing each one down.
const MAX_SANE_ENTRY_DIST = 20;
function isSameDayForming(levelName) {
  return SAME_DAY_FORMING_LEVEL_PREFIXES.some(p => levelName.startsWith(p));
}

async function main() {
  const tradesRes = await query(`
    SELECT setup_type, bet_class, trade_date::text as trade_date, fired_at,
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
  const levelMap = new Map(); // `${date}|${levelName}` -> price
  for (const r of levelPricesRes.rows) levelMap.set(`${r.trade_date}|${r.level_name}`, r.price);

  const results = [];
  let noLevel = 0, noFadeType = 0;
  let sameDayFormingExcluded = 0, staleExcluded = 0;
  for (const t of tradesRes.rows) {
    const levelName = setupTypeToLevelName(t.setup_type);
    if (!levelName) { noFadeType++; continue; }
    if (isSameDayForming(levelName)) { sameDayFormingExcluded++; continue; }
    const levelPrice = levelMap.get(`${t.trade_date}|${levelName}`);
    if (levelPrice == null) { noLevel++; continue; }
    const entry = t.entry_zone_high ?? t.entry_zone_low;
    const entryDistFromLevel = Math.abs(entry - levelPrice);
    if (entryDistFromLevel > MAX_SANE_ENTRY_DIST) { staleExcluded++; continue; }
    const stopDist = Math.abs(entry - t.stop_level);
    results.push({
      date: t.trade_date,
      setup_type: t.setup_type,
      bet_class: t.bet_class,
      entryDistFromLevel,
      entryDistFraction: stopDist > 0 ? entryDistFromLevel / stopDist : null, // how much of the stop distance was "used up" just getting to entry
      delta: t.actual_pnl,
      isStop: t.resolution === 'STOP_HIT',
    });
  }
  console.log(`Real FADE-type resolved trades with a recoverable, fully-pre-session-fixed level price: N=${results.length} (no fade-type match=${noFadeType}, same-day-forming/developing excluded=${sameDayFormingExcluded}, stale/mismatched (>${MAX_SANE_ENTRY_DIST}pt) excluded=${staleExcluded}, no level price for that date=${noLevel})`);
  const sanityMax = Math.max(...results.map(r => r.entryDistFromLevel));
  console.log(`Sanity check: max entry-distance-from-level in this cleaned population = ${sanityMax.toFixed(1)}pt`);

  function summarize(bucket) {
    const n = bucket.length;
    const mean = bucket.reduce((s, r) => s + r.delta, 0) / n;
    const stopRate = bucket.filter(r => r.isStop).length / n;
    const distinctDates = new Set(bucket.map(r => r.date)).size;
    return { n, mean, stopRate, distinctDates };
  }

  // === Raw split by entry distance from level (points) ===
  const sorted = [...results].sort((a, b) => a.entryDistFromLevel - b.entryDistFromLevel);
  const c1 = Math.floor(sorted.length / 3), c2 = Math.floor(sorted.length * 2 / 3);
  const buckets = { CLOSE: sorted.slice(0, c1), MID: sorted.slice(c1, c2), FAR: sorted.slice(c2) };
  console.log('\n=== By entry distance from the level (points) ===');
  for (const [label, bucket] of Object.entries(buckets)) {
    const s = summarize(bucket);
    const range = `${bucket[0].entryDistFromLevel.toFixed(1)} to ${bucket[bucket.length - 1].entryDistFromLevel.toFixed(1)}pt`;
    console.log(`  ${label} (${range}): N=${s.n} mean=$${s.mean.toFixed(2)} stopRate=${(s.stopRate * 100).toFixed(1)}% distinctDates=${s.distinctDates}`);
  }
  const rigorClose = computeRigor(buckets.CLOSE.map(r => ({ t: r.date, pnl: r.delta })), { dateField: 't', pnlFn: r => r.pnl });
  const rigorFar = computeRigor(buckets.FAR.map(r => ({ t: r.date, pnl: r.delta })), { dateField: 't', pnlFn: r => r.pnl });
  console.log(`  Rigor CLOSE: stable=${rigorClose.stable} clustered=${rigorClose.clustered} clean=${rigorClose.clean}`);
  console.log(`  Rigor FAR: stable=${rigorFar.stable} clustered=${rigorFar.clustered} clean=${rigorFar.clean}`);

  // === Within the single largest level family (confound check: is this just composition?) ===
  const byType = {};
  for (const r of results) (byType[r.setup_type] ??= []).push(r);
  const largest = Object.entries(byType).sort((a, b) => b[1].length - a[1].length)[0];
  console.log(`\n=== Within-group check: largest single setup_type = ${largest[0]} (N=${largest[1].length}) ===`);
  if (largest[1].length >= 30) {
    const gs = [...largest[1]].sort((a, b) => a.entryDistFromLevel - b.entryDistFromLevel);
    const gc1 = Math.floor(gs.length / 2);
    const gBuckets = { CLOSE: gs.slice(0, gc1), FAR: gs.slice(gc1) };
    for (const [label, bucket] of Object.entries(gBuckets)) {
      const s = summarize(bucket);
      console.log(`  ${label}: N=${s.n} mean=$${s.mean.toFixed(2)} stopRate=${(s.stopRate * 100).toFixed(1)}%`);
    }
  } else {
    console.log('  (too thin to split within-group, N<30)');
  }

  // === Normalized: what fraction of the calibrated stop distance did entry timing alone "use up"? ===
  const withFrac = results.filter(r => r.entryDistFraction !== null);
  const sortedFrac = [...withFrac].sort((a, b) => a.entryDistFraction - b.entryDistFraction);
  const fc1 = Math.floor(sortedFrac.length / 3), fc2 = Math.floor(sortedFrac.length * 2 / 3);
  const fracBuckets = { LOW: sortedFrac.slice(0, fc1), MID: sortedFrac.slice(fc1, fc2), HIGH: sortedFrac.slice(fc2) };
  console.log(`\n=== By entry-distance as a FRACTION of that trade's own stop distance (N=${withFrac.length}) ===`);
  for (const [label, bucket] of Object.entries(fracBuckets)) {
    const s = summarize(bucket);
    const range = `${(bucket[0].entryDistFraction * 100).toFixed(0)}% to ${(bucket[bucket.length - 1].entryDistFraction * 100).toFixed(0)}%`;
    console.log(`  ${label} (${range} of stop distance): N=${s.n} mean=$${s.mean.toFixed(2)} stopRate=${(s.stopRate * 100).toFixed(1)}%`);
  }

  const sClose = summarize(buckets.CLOSE), sFar = summarize(buckets.FAR);
  const claimText = `Retrospective (no resimulation, real fired trades only) test of the entry-proximity hypothesis (user, 2026-08-24): does entering closer to the level being faded (vs. entering up to 15pt away, the current live nearLevels window) correlate with fewer stop-outs / better EV? N=${results.length} real FADE-type resolved trades with a recoverable level price.
By raw distance: CLOSE (closest third, ${buckets.CLOSE[0].entryDistFromLevel.toFixed(1)}-${buckets.CLOSE[buckets.CLOSE.length-1].entryDistFromLevel.toFixed(1)}pt) mean=$${sClose.mean.toFixed(2)} stopRate=${(sClose.stopRate*100).toFixed(1)}% vs FAR (farthest third, ${buckets.FAR[0].entryDistFromLevel.toFixed(1)}-${buckets.FAR[buckets.FAR.length-1].entryDistFromLevel.toFixed(1)}pt) mean=$${sFar.mean.toFixed(2)} stopRate=${(sFar.stopRate*100).toFixed(1)}%.
Rigor: CLOSE stable=${rigorClose.stable} clustered=${rigorClose.clustered} clean=${rigorClose.clean}; FAR stable=${rigorFar.stable} clustered=${rigorFar.clustered} clean=${rigorFar.clean}.
Within-group check (largest single setup_type=${largest[0]}, N=${largest[1].length}): see console output.
This is a first-look diagnostic, not a resimulated live rule -- if the direction supports the hypothesis, next step is a real bar-by-bar resimulation of a tighter entry-timing rule (no lookahead: wait for price to cross a tighter band before firing) rather than just re-labeling already-fired trades, since entries under a genuinely tighter rule would fire at different times/prices than what's in this population today.`;

  await recordClaim({
    slug: 'entry_proximity_to_level_retrospective_check',
    claimText,
    sourceFile: 'scripts/pretest_entry_proximity_to_level.mjs',
    sampleSize: results.length,
    winRate: null,
    evPerTrade: sClose.mean - sFar.mean,
    rigorStatus: `CLOSE_clean=${rigorClose.clean} FAR_clean=${rigorFar.clean}`,
    status: 'PROVISIONAL',
  });

  console.log('\nDONE');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
