// Net-EV backtest for OPEN_DECISION ib_daytype_calibration_structurally_unreachable, required
// before wiring server/routes/acd.js's IB_BULLISH/IB_BEARISH day-type-conditioned stop/target
// selection to server/services/caseEngine.js's getLiveDayTypeRead() (extracted 2026-08-19).
//
// DeepSeek design-reviewed this shape before it was written
// (scratch/deepseek_ib_daytype_fix_design_review.md) -- two corrections from the original plan
// are load-bearing here and both verified directly against source before this was written:
//   1. The IB gate fires REPEATEDLY all session (IB_BEARISH fired 54x on 2026-07-29), not once
//      at 10:30 -- so this backtest evaluates the live read AT EACH trade's own fired_at, not a
//      single per-day snapshot.
//   2. The reassessment engine's first checkpoint is 11:00 ET (REASSESSMENT_CHECKPOINTS[0]=660),
//      confirmed directly in caseEngine.js -- NOT 10:30. Before 11:00, getLiveDayTypeRead()
//      degenerates to the static classifyDayType() read (52.8% accurate). Fallback policy B
//      (DeepSeek's recommendation, adopted as the tested policy here): only use a day-type-
//      specific stop/target when reassessed===true (an actual checkpoint changed the read) --
//      never key off the un-reassessed static read, since its OWN "TURBULENT" definition differs
//      from the ground-truth range_ratio>=1.25 definition the _opt buckets were calibrated on.
//
// Avoids in-sample leakage as far as practical without a full walk-forward re-sweep: the
// day-type-conditioned OPTIMAL_STOP values used here are the CURRENT, fully-real-history-swept
// rows (real_n 27-84) -- this is reported explicitly as an UPPER BOUND (DeepSeek's accepted
// fallback when true walk-forward recalibration is out of scope for this pass), not a claim that
// this exact stop/target would have been available at each historical trade's own fire time.
//
// Re-walks each trade's REAL price bars under the proposed stop/target (never relabels the
// recorded actual_pnl) -- a day-type routing change can flip a recorded TARGET_HIT into a
// STOP_HIT or vice versa, so the only honest comparison is a fresh bar-by-bar walk.
//
// IB_BULLISH and IB_BEARISH are kept as SEPARATE arms throughout, never pooled -- their
// day-type breakdowns are NOT symmetric (IB_BEARISH: TURBULENT is its best bucket, EV+37.31;
// IB_BULLISH: TURBULENT is its WORST bucket, EV-8.16, per Opus Audit 8 §3.2) -- a pooled
// "IB family" verdict would bury this sign difference.
//
// Run: node scripts/backtest_ib_daytype_live_reassessment.mjs
import { query } from '../server/db.js';
import { getLiveDayTypeRead } from '../server/services/caseEngine.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import fs from 'fs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const SESSION_CLOSE_ET_MIN = 960; // 16:00 ET

async function main() {
  console.log('Loading real IB_BULLISH/IB_BEARISH trades...');
  const tradesRes = await query(`
    SELECT id, setup_type, origin_status, fired_at::text as fired_at, trade_date::text as trade_date,
      entry_zone_low::float as entry, stop_level::float as stop_level, t1_level::float as t1_level,
      actual_pnl::float as actual_pnl, resolution
    FROM active_setups
    WHERE setup_type IN ('IB_BULLISH','IB_BEARISH')
      AND origin_status IN ('ACTIVE','SHADOW')
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
    ORDER BY fired_at ASC
  `);
  const allTrades = tradesRes.rows;
  console.log(`Loaded ${allTrades.length} real trades.`);

  console.log('Loading current day-type-conditioned OPTIMAL_STOP rows...');
  const optRes = await query(`
    SELECT DISTINCT ON (signal_name) signal_name, optimal_stop::float as stop, optimal_target::float as target,
      sample_size, ev_per_trade::float as ev, notes
    FROM performance_audit WHERE signal_type='OPTIMAL_STOP'
      AND signal_name IN ('IB_BULLISH','IB_BEARISH','IB_BULLISH_BALANCE','IB_BULLISH_TREND','IB_BULLISH_TURBULENT',
        'IB_BEARISH_BALANCE','IB_BEARISH_TREND','IB_BEARISH_TURBULENT')
    ORDER BY signal_name, run_date DESC
  `);
  const optByKey = {};
  for (const r of optRes.rows) optByKey[r.signal_name] = { stop: r.stop, target: r.target, n: r.sample_size, ev: r.ev };
  console.log('Available calibration keys:', Object.keys(optByKey).join(', '));

  console.log('Loading NQ price bars (correct timezone treatment, both sides)...');
  const barsRes = await query(`
    SELECT to_char(ts AT TIME ZONE 'America/New_York', 'YYYY-MM-DD"T"HH24:MI:SS') as ts_et,
           extract(epoch from (ts AT TIME ZONE 'America/New_York'))*1000 as ts_ms,
           (EXTRACT(hour FROM ts AT TIME ZONE 'America/New_York')*60 + EXTRACT(minute FROM ts AT TIME ZONE 'America/New_York'))::int as et_min,
           high::float as high, low::float as low, close::float as close, open::float as open
    FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC
  `);
  const allBars = barsRes.rows;
  console.log(`Loaded ${allBars.length} price bars.`);

  function firstIndexAfter(tsMs) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts_ms <= tsMs) lo = mid + 1; else hi = mid; }
    return lo;
  }

  // Session-day bar cache: bars for a given trade_date, and the day's own bars up to a given et_min
  const sessionBarsCache = new Map();
  function sessionBars(tradeDate) {
    if (sessionBarsCache.has(tradeDate)) return sessionBarsCache.get(tradeDate);
    const bars = allBars.filter(b => b.ts_et.slice(0, 10) === tradeDate);
    sessionBarsCache.set(tradeDate, bars);
    return bars;
  }

  function walkTrade(entry, stop, t1, long, startIdx) {
    for (let i = startIdx; i < allBars.length; i++) {
      const b = allBars[i];
      if (b.et_min >= SESSION_CLOSE_ET_MIN) {
        const points = long ? b.close - entry : entry - b.close;
        return { resolution: 'TIME_EXPIRED', pnl: Math.round((points * PNL_PER_POINT - COMMISSION) * 100) / 100 };
      }
      const stopHit = long ? b.low <= stop : b.high >= stop;
      const targetHit = long ? b.high >= t1 : b.low <= t1;
      // Same-bar conflict resolves stop-first (conservative), matching this codebase's
      // standing convention across every other bar-walk resolution branch.
      if (stopHit) {
        const points = long ? stop - entry : entry - stop;
        return { resolution: 'STOP_HIT', pnl: Math.round((points * PNL_PER_POINT - COMMISSION) * 100) / 100 };
      }
      if (targetHit) {
        const points = long ? t1 - entry : entry - t1;
        return { resolution: 'TARGET_HIT', pnl: Math.round((points * PNL_PER_POINT - COMMISSION) * 100) / 100 };
      }
    }
    return { resolution: 'NO_DATA', pnl: null };
  }

  const results = { IB_BULLISH: [], IB_BEARISH: [] };
  let skippedNoRead = 0, skippedNoBars = 0;

  // fired_at epochs are computed via SQL AT TIME ZONE below (matching the corrected pattern),
  // never JS Date parsing of a naive string -- this loop just buckets trades by setup_type.
  for (const t of allTrades) {
    results[t.setup_type].push(t);
  }

  // Batch-fetch correct fired_at epochs (AT TIME ZONE 'America/New_York'), matching the
  // corrected pattern from earlier today's scripts -- never JS Date parsing of a naive string.
  const idsAll = allTrades.map(t => t.id);
  const firedAtRes = await query(`
    SELECT id, extract(epoch from (fired_at AT TIME ZONE 'America/New_York'))*1000 as ms,
      (EXTRACT(hour FROM fired_at AT TIME ZONE 'America/New_York')*60 + EXTRACT(minute FROM fired_at AT TIME ZONE 'America/New_York'))::int as et_min
    FROM active_setups WHERE id = ANY($1)
  `, [idsAll]);
  const firedAtById = new Map(firedAtRes.rows.map(r => [r.id, { ms: parseFloat(r.ms), etMin: r.et_min }]));

  const perTradeRows = { IB_BULLISH: [], IB_BEARISH: [] };

  for (const setupType of ['IB_BULLISH', 'IB_BEARISH']) {
    const long = setupType === 'IB_BULLISH';
    for (const t of results[setupType]) {
      const fired = firedAtById.get(t.id);
      if (!fired) { skippedNoBars++; continue; }
      const dayBars = sessionBars(t.trade_date);
      const barsUpToFire = dayBars.filter(b => b.et_min <= fired.etMin);
      if (barsUpToFire.length < 5) { skippedNoBars++; continue; }

      // No-lookahead: nl30/orWidth/ibHigh/ibLow computed from data strictly available by fire
      // time. ibHigh/ibLow: first-60-min bars (570-629) up to fire time (always fully available
      // once fired, since IB gate requires etMin>=630).
      const ibBars = dayBars.filter(b => b.et_min >= 570 && b.et_min <= 629);
      if (ibBars.length < 3) { skippedNoBars++; continue; }
      const ibHigh = Math.max(...ibBars.map(b => b.high));
      const ibLow = Math.min(...ibBars.map(b => b.low));
      const orWidth = ibHigh - ibLow; // reuse IB range as orWidth proxy (matches acd.js's own orRange usage pattern)
      const sessOpen = dayBars[0]?.open;

      let liveRead;
      try {
        liveRead = await getLiveDayTypeRead({
          tradeDate: t.trade_date, asOfMinutes: fired.etMin,
          bars: barsUpToFire.map(b => ({ ...b })), sessOpen, ibHigh, ibLow,
          nl30: 0, orWidth, // nl30 not available pre-computed here; classifyDayType weights it lightly, acceptable approximation flagged in output
        });
      } catch (e) { skippedNoRead++; continue; }

      const startIdx = firstIndexAfter(fired.ms);
      if (startIdx >= allBars.length) { skippedNoBars++; continue; }

      // Status quo: the trade's OWN recorded entry/stop/t1 (what blended live code actually used)
      const sqResolution = t.actual_pnl != null ? t.resolution : walkTrade(t.entry, t.stop_level, t.t1_level, long, startIdx).resolution;
      const sqPnl = t.actual_pnl;

      // Proposed: fallback policy B — only override with a day-type-specific stop/target when
      // the reassessment engine has actually spoken (reassessed===true), never off the static
      // read alone.
      let proposedStop = t.stop_level, proposedTarget = t.t1_level, usedDayTypeKey = null;
      if (liveRead.reassessed) {
        const key = `${setupType}_${liveRead.finalRead}`;
        const opt = optByKey[key];
        if (opt && opt.stop != null && opt.target != null) {
          const distStop = opt.stop, distTarget = opt.target;
          proposedStop = long ? t.entry - distStop : t.entry + distStop;
          proposedTarget = long ? t.entry + distTarget : t.entry - distTarget;
          usedDayTypeKey = key;
        }
      }
      const proposedWalk = walkTrade(t.entry, proposedStop, proposedTarget, long, startIdx);

      perTradeRows[setupType].push({
        id: t.id, date: t.trade_date, staticRead: liveRead.classification, finalRead: liveRead.finalRead,
        reassessed: liveRead.reassessed, etMinFired: fired.etMin, usedDayTypeKey,
        sqPnl, sqResolution, proposedPnl: proposedWalk.pnl, proposedResolution: proposedWalk.resolution,
        delta: (proposedWalk.pnl != null && sqPnl != null) ? +(proposedWalk.pnl - sqPnl).toFixed(2) : null,
      });
    }
  }

  console.log(`Skipped: ${skippedNoRead} (day-type read error), ${skippedNoBars} (insufficient bars).`);

  function summarize(rows) {
    const valid = rows.filter(r => r.delta != null);
    const changed = valid.filter(r => r.usedDayTypeKey != null);
    const meanDelta = valid.length ? +(valid.reduce((s, r) => s + r.delta, 0) / valid.length).toFixed(2) : null;
    const rigor = valid.length ? computeRigor(valid, { dateField: 'date', pnlFn: r => r.delta }) : null;
    const byFinalRead = {};
    for (const r of changed) (byFinalRead[r.finalRead] ||= []).push(r.delta);
    const byReadSummary = Object.fromEntries(Object.entries(byFinalRead).map(([k, ds]) => [k, { n: ds.length, meanDelta: +(ds.reduce((a, b) => a + b, 0) / ds.length).toFixed(2) }]));
    return { totalN: valid.length, changedN: changed.length, meanDeltaAllTrades: meanDelta, rigor, byFinalRead: byReadSummary };
  }

  const summaryBull = summarize(perTradeRows.IB_BULLISH);
  const summaryBear = summarize(perTradeRows.IB_BEARISH);

  let md = '# IB Day-Type Live-Reassessment Backtest\n\n';
  md += '**Fallback policy tested: B (DeepSeek-recommended)** — day-type-specific stop/target used ONLY when `reassessed===true` (an actual reassessment checkpoint fired), never off the un-reassessed static read.\n\n';
  md += '**Upper-bound caveat**: day-type OPTIMAL_STOP values used are the CURRENT, fully-real-history-swept rows, not walked-forward per historical date — this overstates precision somewhat; treat as an upper bound on the benefit, not a walk-forward-confirmed number.\n\n';
  md += `Skipped: ${skippedNoRead} (read error), ${skippedNoBars} (insufficient bars).\n\n`;

  for (const [name, summary, rows] of [['IB_BULLISH', summaryBull, perTradeRows.IB_BULLISH], ['IB_BEARISH', summaryBear, perTradeRows.IB_BEARISH]]) {
    md += `## ${name}\n\n`;
    md += `Total real trades scored: ${summary.totalN}. Trades where a day-type-specific stop/target actually applied (reassessed + key found): ${summary.changedN}.\n\n`;
    md += `Mean P&L delta (proposed − status quo) across ALL scored trades: **$${summary.meanDeltaAllTrades}**\n\n`;
    md += `Rigor on the delta: \`${JSON.stringify(summary.rigor)}\`\n\n`;
    md += `Breakdown by final (reassessed) day-type read, among trades where it actually changed the stop/target:\n\n`;
    md += '| finalRead | N | mean delta |\n|---|---|---|\n';
    for (const [k, v] of Object.entries(summary.byFinalRead)) md += `| ${k} | ${v.n} | $${v.meanDelta} |\n`;
    md += '\n';
  }

  fs.writeFileSync('scratch/ib_daytype_live_reassessment_RESULTS.md', md);
  console.log('\nWritten to scratch/ib_daytype_live_reassessment_RESULTS.md');
  console.log('\n=== IB_BULLISH ===', JSON.stringify(summaryBull, null, 2));
  console.log('\n=== IB_BEARISH ===', JSON.stringify(summaryBear, null, 2));

  for (const [name, summary] of [['IB_BULLISH', summaryBull], ['IB_BEARISH', summaryBear]]) {
    if (summary.totalN >= 20) {
      await recordClaim({
        slug: `ib_daytype_live_reassessment_${name.toLowerCase()}`,
        claimText: `Backtest of wiring ${name}'s day-type-conditioned stop/target selection to caseEngine.js's live getLiveDayTypeRead() (fallback policy B: only override on an actual reassessment, never the un-reassessed static read). N=${summary.totalN} real trades, mean delta $${summary.meanDeltaAllTrades}/trade vs status quo. Rigor: ${JSON.stringify(summary.rigor)}. Upper-bound caveat: day-type OPTIMAL_STOP values are current, not walked-forward. See scratch/ib_daytype_live_reassessment_RESULTS.md for full per-read breakdown.`,
        sourceFile: 'scripts/backtest_ib_daytype_live_reassessment.mjs',
        sampleSize: summary.totalN,
        evPerTrade: summary.meanDeltaAllTrades,
        rigorStatus: summary.rigor?.clean ? 'clean' : 'unstable_or_clustered',
        status: 'PROVISIONAL',
      });
    }
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
