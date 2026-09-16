// Order-flow confirmation on top of the price-drift direction gate -- Phase 0b, NOT wired
// live. Builds on backtest_price_drift_gate_phase0.mjs's SAME-SETUP_TYPE-scoped result (the
// only scope that survived the first-touch-confound fix): a repeat fire at a worse price than
// the last real same-setup_type/direction fire underperforms one at a same-or-better price,
// concentrated in fast repeats (<10min, <60min) and absent/reversed beyond ~4hr.
//
// User's follow-up (2026-09-16, prompted by a real same-day example: 10:47 OR30_HIGH_FADE_
// SHORT@29481.5 stopped, 10:48 IB_HIGH_FADE_SHORT@29469.5 stopped, 10:51 bar shows delta
// flipping positive -- buying right at the session low -- ~13min before 11:04's IB_HIGH_FADE_
// SHORT@29485.25 also stopped): "a second fire in the wrong direction, if there's buying
// there, should be scrutinized." Operationalized here as: the single CLOSED 1-min bar
// immediately preceding the candidate's own fired_at (no lookahead -- the bar still forming at
// fired_at is never used) shows order flow AGAINST the trade's own direction -- net buying
// (ask_volume > bid_volume) for a SHORT, net selling for a LONG.
//
// Real bid_volume/ask_volume columns exist on price_bars (server/schema.sql) -- confirmed via
// a direct pull for the motivating example, not assumed.
//
// Test: within the GATED (worse-priced repeat) bucket, does "adverse order flow in the prior
// closed bar" predict an even worse outcome than gated trades without it? Run the same split
// on KEPT as a control -- if adverse-flow predicts badness everywhere regardless of the price/
// time gate, it's a generic bad-sign, not something that specifically sharpens this mechanism.

import { query } from '../server/db.js';
import { loadRealTrades, simulate, bucketStats } from './backtest_price_drift_gate_phase0.mjs';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';

async function attachOrderFlow(trades) {
  // Closed-bar timestamp = floor(fired_at to the minute) - 1 minute (the bar that had already
  // fully closed by the time this candidate fired -- matches this codebase's own no-lookahead
  // "closed bars only" convention, agreed with the user earlier this session).
  const closedTsList = trades.map(t => {
    const d = new Date(t.fired_at);
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() - 1);
    return d.toISOString();
  });
  // Explicit lower AND upper bound (price_bars_primary convention) -- batched into one query
  // via ts = ANY(...) rather than one query per trade.
  const minTs = closedTsList.reduce((a, b) => a < b ? a : b);
  const maxTs = closedTsList.reduce((a, b) => a > b ? a : b);
  // NOT casting ts to text: pg's own driver parses a "timestamp without time zone" column by
  // reading its raw components and calling Date.UTC(...) directly (naive-as-UTC, no ambient-
  // timezone dependency) -- exactly how fired_at is already handled correctly elsewhere in this
  // script. Casting to text and re-parsing via `new Date(str)` bypasses that and goes through
  // V8's own string parser instead, which for a space-separated 'YYYY-MM-DD HH:MM:SS' string
  // (no 'T', no 'Z') parses as LOCAL time -- this process's TZ is America/New_York, so that
  // path silently shifted every lookup by 4-5 hours and made ~99% of matches fail. Caught by
  // checking the match RATE (420/424 missing was implausibly high for real data gaps), not by
  // guessing -- confirmed directly: `new Date('2026-07-14 11:41:00').toISOString()` -> 15:41Z.
  const r = await query(`
    SELECT ts, bid_volume::int AS bid_volume, ask_volume::int AS ask_volume
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= $1::timestamp AND ts <= $2::timestamp
      AND ts = ANY($3::timestamp[])
  `, [minTs, maxTs, closedTsList]);
  const barMap = new Map(r.rows.map(row => [row.ts.toISOString(), row.ask_volume - row.bid_volume]));

  return trades.map((t, i) => {
    const delta = barMap.has(closedTsList[i]) ? barMap.get(closedTsList[i]) : null;
    const adverseFlow = delta == null ? null : (t.dir === 'SHORT' ? delta > 0 : delta < 0);
    return { ...t, priorBarDelta: delta, adverseFlow };
  });
}

function reportSplit(label, rows) {
  const withFlag = rows.filter(t => t.adverseFlow === true);
  const withoutFlag = rows.filter(t => t.adverseFlow === false);
  const noBar = rows.filter(t => t.adverseFlow == null).length;
  const wf = bucketStats(withFlag), wof = bucketStats(withoutFlag);
  console.log(`${label}: total N=${rows.length} (${noBar} missing a matching bar)`);
  console.log(`  ADVERSE-FLOW (buying-for-short/selling-for-long in prior closed bar): N=${wf.n} WR=${wf.wr}% EV=$${wf.ev}/trade`);
  console.log(`  NO adverse flow:                                                     N=${wof.n} WR=${wof.wr}% EV=$${wof.ev}/trade`);
  return { withFlag, withoutFlag, wf, wof };
}

async function main() {
  const todayR = await query(`SELECT CURRENT_DATE::text AS today`);
  const today = todayR.rows[0].today;

  const allTrades = await loadRealTrades();
  const tagged = simulate(allTrades, (t, dir) => `${dir}|${t.setup_type}`); // same-setup_type scope, the validated one
  const repeats = tagged.filter(t => !t.isFirstTouch);
  const gated = repeats.filter(t => t.wouldBeGated);
  const kept = repeats.filter(t => !t.wouldBeGated);
  const gatedFast = gated.filter(t => t.minutesSinceRef < 60); // the validated core (<10min + 10-60min buckets)
  const keptFast = kept.filter(t => t.minutesSinceRef < 60);

  console.log(`GATED (all gaps) N=${gated.length}, GATED (<60min, the validated core) N=${gatedFast.length}`);
  console.log(`KEPT  (all gaps) N=${kept.length}, KEPT  (<60min) N=${keptFast.length}`);

  const gatedFastTagged = await attachOrderFlow(gatedFast);
  const keptFastTagged = await attachOrderFlow(keptFast);
  const gatedAllTagged = await attachOrderFlow(gated);

  console.log(`\n=== Within GATED, <60min (the validated core) ===`);
  const coreSplit = reportSplit('GATED <60min', gatedFastTagged);

  console.log(`\n=== Control: within KEPT, <60min (does adverse flow predict badness generically?) ===`);
  const controlSplit = reportSplit('KEPT <60min', keptFastTagged);

  console.log(`\n=== Robustness: within GATED, all time gaps ===`);
  const allGapsSplit = reportSplit('GATED all gaps', gatedAllTagged);

  let rigor = { clustered: null, stable: null, top5DayPct: null, distinctDates: null };
  if (coreSplit.wf.n >= 20) {
    rigor = computeRigor(coreSplit.withFlag, { dateField: 'trade_date', pnlFn: t => t.pnl });
    console.log(`\nRigor on GATED+adverse-flow bucket: clustered=${rigor.clustered} stable=${rigor.stable} top5DayPct=${rigor.top5DayPct}% distinctDates=${rigor.distinctDates}`);
  } else {
    console.log(`\nGATED+adverse-flow bucket N=${coreSplit.wf.n} < 20 -- too thin for a rigor check.`);
  }

  const verdict = coreSplit.wf.n >= 20 && coreSplit.wf.ev < coreSplit.wof.ev
    ? 'ADVERSE_FLOW_SHARPENS_THE_GATE'
    : coreSplit.wf.n >= 20 && coreSplit.wf.ev >= coreSplit.wof.ev
    ? 'ADVERSE_FLOW_NO_ADDED_VALUE_OR_REVERSED'
    : 'THIN_N';
  console.log(`\nVerdict: ${verdict}`);

  await recordClaim({
    slug: 'price_drift_gate_orderflow_confirmation_phase0b_20260916',
    claimText: `Order-flow confirmation on top of the SAME-SETUP_TYPE-scoped price-drift gate (Phase 0, ` +
      `same session): does the single closed 1-min bar immediately before a worse-priced repeat fire ` +
      `showing order flow against the trade's own direction (net buying for a SHORT, net selling for a ` +
      `LONG -- real bid_volume/ask_volume delta, no lookahead) predict an even worse outcome? Within the ` +
      `validated core (GATED, same-setup_type, <60min since the last same-direction fire): ADVERSE-FLOW ` +
      `N=${coreSplit.wf.n} EV=$${coreSplit.wf.ev}/trade vs NO-adverse-flow N=${coreSplit.wof.n} EV=$${coreSplit.wof.ev}/trade. ` +
      `Control (same split inside KEPT/<60min, i.e. same-or-better-priced repeats, to check this isn't just ` +
      `a generic bad-sign): ADVERSE-FLOW N=${controlSplit.wf.n} EV=$${controlSplit.wf.ev}/trade vs NO-adverse-flow ` +
      `N=${controlSplit.wof.n} EV=$${controlSplit.wof.ev}/trade. Robustness (GATED, all time gaps, not just <60min): ` +
      `ADVERSE-FLOW N=${allGapsSplit.wf.n} EV=$${allGapsSplit.wf.ev}/trade vs NO-adverse-flow N=${allGapsSplit.wof.n} EV=$${allGapsSplit.wof.ev}/trade. ` +
      `Rigor on the core ADVERSE-FLOW bucket: clustered=${rigor.clustered}, stable=${rigor.stable}, ` +
      `top5DayPct=${rigor.top5DayPct}%, distinctDates=${rigor.distinctDates}. Verdict: ${verdict}. Motivated by a real ` +
      `2026-09-16 same-day example (10:47/10:48 back-to-back worse-priced shorts, both stopped; the 10:50-10:51 ` +
      `bars show delta flipping positive right at the session low, ~13min before the 11:04 repeat, also stopped) ` +
      `-- checked directly and confirms this specific tell arrives too late for the first two fires but in time ` +
      `for the third. Phase 0b only -- single-bar lookback, no placebo control, no multi-bar/divergence-shape ` +
      `version tested, not wired anywhere.`,
    sourceFile: 'scripts/backtest_price_drift_gate_orderflow_phase0b.mjs',
    sourceDate: today,
    sampleSize: coreSplit.wf.n,
    evPerTrade: coreSplit.wf.ev,
    rigorStatus: rigor.clustered ? 'day_clustered' : rigor.stable ? 'stable' : (coreSplit.wf.n >= 20 ? 'stable' : 'not_checked'),
    status: 'PROVISIONAL',
  });
  console.log(`\nRecorded RESEARCH_CLAIM price_drift_gate_orderflow_confirmation_phase0b_20260916.`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
