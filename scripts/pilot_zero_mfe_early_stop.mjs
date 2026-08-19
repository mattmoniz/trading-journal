// Pilot (read-only, not persisted to performance_audit): does tightening the stop early on a
// trade showing zero favorable excursion improve EV? Built 2026-08-18, revised same day after:
// (1) a Gemini first draft mistakenly borrowed a stop-distance noise floor (1.5x 30-day median
//     bar range, ~15pt) as the "is MFE actually zero" tolerance -- fixed to test both that loose
//     floor and a strict ~1pt near-tick one, so the sensitivity to this choice stays visible.
// (2) user observation: trades tend to move against entry faster than they move favorably, so
//     N=1..4 (not just 3/6/10) needs testing, and a "big drop early" refinement is worth trying
//     alongside plain zero-MFE.
// (3) confound checklist (CLAUDE.md): a "tighter stop looks better" result can be purely
//     mechanical (cutting losses short reduces average loss almost by arithmetic) regardless of
//     whether the zero-MFE condition carries real information. ALL_BLIND_CONTROL below tightens
//     EVERY real trade's stop with no MFE/MAE filter at all, so any zero-MFE-conditioned delta
//     can be judged against what blind tightening alone would produce.
//
// Every population below is evaluated with the SAME counterfactual mechanics (see
// counterfactualForTrade) so the only thing that varies is which trades are in the bucket:
//   ALL_BLIND_CONTROL        -- every real trade, no MFE/MAE filter (structural control)
//   ZERO_MFE_strict          -- MFE stayed <=1pt through bar N (the honest "never moved
//                                favorably" test)
//   ZERO_MFE_loose           -- MFE stayed <=~15pt through bar N (Gemini's original, kept for
//                                comparison -- really "weak early momentum", not "never moved")
//   ZERO_MFE_strict_BIG_MAE  -- of the strict bucket, the half with the LARGER adverse move by
//                                bar N (median-split within the bucket -- data-derived, not an
//                                arbitrary constant) -- the user's "big drop early" refinement
//   ZERO_MFE_strict_SMALL_MAE-- the other half (same selection, no big-drop signal) -- isolates
//                                whether the MAE-magnitude condition adds anything beyond plain
//                                zero-MFE, same 3-way logic as pilot_cvd_divergence.mjs's
//                                SIGNAL/SAME_SELECTION_NO_SIGNAL/NEVER_SELECTED split

import pg from 'pg';
import dotenv from 'dotenv';
import { resolveDirection } from '../server/config/setupTypes.js';
dotenv.config();

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'trading_journal',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

const DOLLARS_PER_POINT = 2;
const COMMISSION = 2;

function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function naive(ts) {
  return ts.toISOString().slice(0, 19).replace('T', ' ');
}

async function run() {
  try {
    const medianBarRangeRes = await pool.query(`
      SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (high - low)) as median_range
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts >= NOW() - INTERVAL '30 days'
    `);
    const medianBarRange = +medianBarRangeRes.rows[0].median_range;
    const STRICT_FLOOR = 1.0;
    const LOOSE_FLOOR = 1.5 * medianBarRange;
    console.log(`Strict MFE floor: ${STRICT_FLOOR.toFixed(2)}pt (near-tick)`);
    console.log(`Loose MFE floor: ${LOOSE_FLOOR.toFixed(2)}pt (1.5 * 30d median bar range ${medianBarRange.toFixed(2)}pt)\n`);

    const tradesRes = await pool.query(`
      SELECT id, trade_date, setup_type, fired_at, entry_zone_low, entry_zone_high,
        stop_level, t1_level, actual_pnl, resolution, replay_resolution, origin_status,
        resolved_at, resolution_bar_time
      FROM active_setups
      WHERE origin_status IN ('ACTIVE','SHADOW')
        AND status='RESOLVED'
        AND (entry_zone_high IS NOT NULL OR entry_zone_low IS NOT NULL)
        AND fired_at IS NOT NULL
        AND stop_level IS NOT NULL
    `);
    const trades = tradesRes.rows;
    if (trades.length === 0) { console.log('No trades found.'); process.exit(0); }

    let minTs = trades[0].fired_at, maxTs = trades[0].fired_at;
    for (const t of trades) {
      if (t.fired_at < minTs) minTs = t.fired_at;
      if (t.fired_at > maxTs) maxTs = t.fired_at;
    }
    const barsRes = await pool.query(`
      SELECT ts, open::float, high::float, low::float, close::float
      FROM price_bars_primary
      WHERE symbol='NQ'
        AND ts >= $1::timestamp - INTERVAL '1 hour'
        AND ts <= $2::timestamp + INTERVAL '14 days'
      ORDER BY ts ASC
    `, [naive(minTs), naive(maxTs)]);
    const allBars = barsRes.rows;
    console.log(`Fetched ${allBars.length} bars for ${trades.length} candidate trades.\n`);

    function getBarIndex(targetTsNaive) {
      let left = 0, right = allBars.length - 1, ans = -1;
      const targetTime = new Date(targetTsNaive + 'Z').getTime();
      while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const midTime = new Date(naive(allBars[mid].ts) + 'Z').getTime();
        if (midTime <= targetTime) { ans = mid; left = mid + 1; } else { right = mid - 1; }
      }
      return ans;
    }

    const enriched = [];
    for (const t of trades) {
      const direction = resolveDirection(t);
      if (!direction) continue;
      const entry = Number(t.entry_zone_high ?? t.entry_zone_low);
      const startIndex = getBarIndex(naive(t.fired_at));
      if (startIndex === -1) continue;
      const resAt = t.resolution_bar_time || t.resolved_at;
      const resolvedAtTime = resAt ? new Date(naive(resAt) + 'Z').getTime() : Infinity;
      enriched.push({ t, direction, entry, startIndex, resolvedAtTime });
    }
    console.log(`Usable real trades (direction resolved, bar-indexed): ${enriched.length}\n`);

    // STILL-OPEN-AT-N FILTER -- added 2026-08-18 after DeepSeek review found the original
    // version silently included trades that had ALREADY resolved before checkpoint bar N.
    // "Tighten the stop at bar N" is not a real, executable action on a trade that's already
    // closed by then -- those rows were inflating every bucket (DeepSeek measured 21%-57% of
    // the strict buckets, rising with N, exactly matching the "effect grows with N" pattern).
    // Applied to EVERY population including ALL_BLIND_CONTROL, so the comparison stays fair --
    // the control must represent "tighten every trade that's still open at N," not "every trade
    // regardless of whether N even applies to it."
    function stillOpenAtN(item, N) {
      if (item.startIndex + N >= allBars.length) return false;
      const barNTime = new Date(naive(allBars[item.startIndex + N].ts) + 'Z').getTime();
      return item.resolvedAtTime > barNTime;
    }

    const Ns = [1, 2, 3, 4, 6, 10];
    const fractions = [0.25, 0.5, 0.75];

    function mfeMaeAtBar(item, N) {
      const { direction, entry, startIndex } = item;
      if (startIndex + N >= allBars.length) return null;
      let mfe = 0, mae = 0;
      for (let i = 0; i <= N; i++) {
        const b = allBars[startIndex + i];
        const mfeAtBar = direction === 'LONG' ? Math.max(0, b.high - entry) : Math.max(0, entry - b.low);
        const maeAtBar = direction === 'LONG' ? Math.max(0, entry - b.low) : Math.max(0, b.high - entry);
        mfe = Math.max(mfe, mfeAtBar);
        mae = Math.max(mae, maeAtBar);
      }
      return { mfe, mae };
    }

    // Same mechanics for every population -- only the input bucket differs. No lookahead: the
    // bucket CLASSIFICATION (mfeMaeAtBar above) only ever reads bars 0..N; this function walks
    // bars N+1 onward, which is legitimate for a historical counterfactual (using the trade's
    // own real recorded continuation), never for a live decision.
    //
    // BUG FOUND + FIXED 2026-08-18 (Claude, caught before sending to DeepSeek; DeepSeek then
    // found a residual issue in this same fix -- see below): the original version only checked
    // for a tightened-stop hit from bar N+1 onward, silently assuming price was still on the
    // near side of the tightened stop AT bar N. That's false whenever MAE by bar N already
    // exceeds the tightened distance -- exactly the trades the BIG_MAE bucket is built to
    // select. Fix: check bar N itself against the tightened stop FIRST; only fall through to
    // the forward walk if bar N hasn't already breached it.
    //
    // RESIDUAL BUG FIXED 2026-08-18 (DeepSeek review): the checkpoint-bar check originally used
    // `close`, while every other bar in the walk uses `low`/`high` -- a bar-N low that crossed
    // the tightened stop and then closed back on the near side was silently missed. The correct
    // precedent is `replayBars()`'s own stop-hit test (maeMfeReplay.js:52-53), not
    // `computeBar6Checkpoint`'s `bar6Close` (a decision-point close for a different exit rule,
    // not a stop-hit detector). Fixed to use `low`/`high` at the checkpoint bar too, matching
    // every subsequent bar.
    function counterfactualForTrade(item, N, frac) {
      const { t, direction, entry, startIndex, resolvedAtTime } = item;
      if (startIndex + N >= allBars.length) return null;
      const originalStop = Number(t.stop_level);
      const originalTarget = t.t1_level != null ? Number(t.t1_level) : null;
      const originalStopDist = Math.abs(entry - originalStop);
      const tightenDist = originalStopDist * frac;
      const tightenedStop = direction === 'LONG' ? entry - tightenDist : entry + tightenDist;
      const realPnl = Number(t.actual_pnl) || 0;

      const barN = allBars[startIndex + N];
      const alreadyBreachedAtCheckpoint = direction === 'LONG'
        ? barN.low <= tightenedStop
        : barN.high >= tightenedStop;

      let hitTightenedStop = alreadyBreachedAtCheckpoint;
      if (!alreadyBreachedAtCheckpoint) {
        for (let i = N + 1; startIndex + i < allBars.length; i++) {
          const b = allBars[startIndex + i];
          const bTime = new Date(naive(b.ts) + 'Z').getTime();
          if (bTime > resolvedAtTime) break;
          if (direction === 'LONG') {
            if (b.low <= tightenedStop) { hitTightenedStop = true; break; }
            if (originalTarget && b.high >= originalTarget) break;
          } else {
            if (b.high >= tightenedStop) { hitTightenedStop = true; break; }
            if (originalTarget && b.low <= originalTarget) break;
          }
        }
      }

      let cfPnl = realPnl, rescued = false, correctlyCut = false;
      if (hitTightenedStop) {
        cfPnl = direction === 'LONG'
          ? (tightenedStop - entry) * DOLLARS_PER_POINT - COMMISSION
          : (entry - tightenedStop) * DOLLARS_PER_POINT - COMMISSION;
        if (realPnl > 0) rescued = true; else correctlyCut = true;
      }
      return { realPnl, cfPnl, rescued, correctlyCut, alreadyBreachedAtCheckpoint };
    }

    function summarizeBucket(items, N, frac) {
      let realSum = 0, cfSum = 0, rescued = 0, correctlyCut = 0, n = 0;
      const dateCounts = {};
      for (const item of items) {
        const cf = counterfactualForTrade(item, N, frac);
        if (!cf) continue;
        realSum += cf.realPnl; cfSum += cf.cfPnl;
        if (cf.rescued) rescued++;
        if (cf.correctlyCut) correctlyCut++;
        n++;
        const d = item.t.trade_date.toISOString().split('T')[0];
        dateCounts[d] = (dateCounts[d] || 0) + 1;
      }
      const topDates = Object.entries(dateCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
      const top5Pct = n > 0 ? (topDates.reduce((s, [, c]) => s + c, 0) / n * 100).toFixed(1) : '0.0';
      return { n, avgReal: n ? realSum / n : 0, avgCf: n ? cfSum / n : 0, delta: n ? (cfSum - realSum) / n : 0, rescued, correctlyCut, top5Pct, topDates };
    }

    // Exclude-dominant-date sensitivity check: does BIG_MAE's delta survive with its single
    // most-represented date removed entirely? A real effect should degrade gracefully, not
    // evaporate or reverse -- this project's own standing convention for a thin, clustered
    // bucket before trusting it (docs/CONVENTIONS_DETAIL.md's confound checklist item 4 in
    // spirit, applied directly here since N is too thin for computeReplication()'s own bar).
    function summarizeBucketExcludingDate(items, N, frac, excludeDate) {
      const filtered = items.filter(item => item.t.trade_date.toISOString().split('T')[0] !== excludeDate);
      return summarizeBucket(filtered, N, frac);
    }

    const results = [];
    const bucketLog = [];

    for (const N of Ns) {
      // Base population for THIS checkpoint is every trade still genuinely open at bar N --
      // computed once per N and used as the input to every bucket below, including the blind
      // control, so "tighten at N" is always a real action on a real still-open trade.
      const stillOpen = enriched.filter(item => stillOpenAtN(item, N));

      const strictBucket = [], looseBucket = [];
      for (const item of stillOpen) {
        const mm = mfeMaeAtBar(item, N);
        if (!mm) continue;
        if (mm.mfe <= STRICT_FLOOR) strictBucket.push({ ...item, maeAtN: mm.mae });
        if (mm.mfe <= LOOSE_FLOOR) looseBucket.push(item);
      }
      const maeVals = strictBucket.map(x => x.maeAtN);
      const maeMedian = median(maeVals);
      const bigMaeBucket = maeMedian != null ? strictBucket.filter(x => x.maeAtN >= maeMedian) : [];
      const smallMaeBucket = maeMedian != null ? strictBucket.filter(x => x.maeAtN < maeMedian) : [];

      bucketLog.push(`N=${N}: still-open=${stillOpen.length}/${enriched.length} (${(100 - stillOpen.length / enriched.length * 100).toFixed(1)}% already resolved by N, excluded) -> strict n=${strictBucket.length} (MAE median split @ ${maeMedian != null ? maeMedian.toFixed(2) : 'n/a'}pt -> big=${bigMaeBucket.length}, small=${smallMaeBucket.length}), loose n=${looseBucket.length}`);

      for (const frac of fractions) {
        const pops = [
          ['ALL_BLIND_CONTROL', stillOpen],
          ['ZERO_MFE_strict', strictBucket],
          ['ZERO_MFE_loose', looseBucket],
          ['ZERO_MFE_strict_BIG_MAE', bigMaeBucket],
          ['ZERO_MFE_strict_SMALL_MAE', smallMaeBucket],
        ];
        for (const [label, items] of pops) {
          const s = summarizeBucket(items, N, frac);
          results.push({
            N, Fraction: frac, Population: label, Count: s.n,
            AvgRealPnL: s.avgReal.toFixed(2), AvgCfPnL: s.avgCf.toFixed(2), Delta: s.delta.toFixed(2),
            Rescued: s.rescued, CorrectlyCut: s.correctlyCut,
            Top5DatePct: s.n >= 20 ? `${s.top5Pct}%` : 'N<20',
          });
          if (label === 'ZERO_MFE_strict_BIG_MAE' && frac === 0.25 && s.n > 0) {
            const topDate = s.topDates[0]?.[0];
            const excl = topDate ? summarizeBucketExcludingDate(items, N, frac, topDate) : null;
            bucketLog.push(`  [BIG_MAE, N=${N}, frac=0.25] dates: ${s.topDates.map(([d, c]) => `${d}(${c})`).join(', ')} | excl-top-date: n=${excl?.n ?? 0}, delta=${excl ? excl.delta.toFixed(2) : 'n/a'} (full delta was ${s.delta.toFixed(2)})`);
          }
        }
      }
    }

    console.table(results);
    console.log('\nBucket sizes / MAE-median split per checkpoint bar N:');
    for (const line of bucketLog) console.log(line);

    // =========================================================================================
    // PART 2 -- dynamic checkpoint (added 2026-08-18, user's own refinement): instead of
    // checking every trade at the SAME fixed bar count, check each trade at ITS OWN moment --
    // the first bar where its adverse move (MAE) reaches a fraction of its own original stop
    // distance. This fixes the core weakness of the bar-N design: trades move at different
    // speeds, so a fixed bar count checks fast movers too late (already resolved) and slow
    // movers too early (nothing meaningful has happened yet). A MAE-fraction trigger is
    // self-timing -- it only fires once a trade is meaningfully underwater, whenever that
    // happens to occur, and it's naturally "still open" almost by construction (you can't
    // reach 50%/75% of the way to a stop AFTER that stop has already been hit, except a gap
    // straight through both levels in one bar).
    //
    // triggerFraction = how deep into the ORIGINAL stop distance before we even look (0.5, 0.75)
    // tightenFrac      = how much of the original stop distance remains after tightening (reuse
    //                     the same 0.25/0.5/0.75 grid as Part 1, though 0.5/0.75 are the ones
    //                     that actually match "leave wiggle room" per the user's own framing)
    function findDynamicCheckpoint(item, triggerFraction, requireZeroMfe) {
      const { t, direction, entry, startIndex, resolvedAtTime } = item;
      const originalStop = Number(t.stop_level);
      const originalStopDist = Math.abs(entry - originalStop);
      const maeTarget = originalStopDist * triggerFraction;
      let mfeSoFar = 0;
      for (let i = 0; startIndex + i < allBars.length; i++) {
        const b = allBars[startIndex + i];
        const bTime = new Date(naive(b.ts) + 'Z').getTime();
        if (bTime > resolvedAtTime) return null; // trade resolved before ever reaching the threshold
        const mfeAtBar = direction === 'LONG' ? Math.max(0, b.high - entry) : Math.max(0, entry - b.low);
        const maeAtBar = direction === 'LONG' ? Math.max(0, entry - b.low) : Math.max(0, b.high - entry);
        mfeSoFar = Math.max(mfeSoFar, mfeAtBar);
        if (requireZeroMfe && mfeSoFar > STRICT_FLOOR) return null; // ticked favorable before reaching the MAE trigger
        if (maeAtBar >= maeTarget) return { checkpointOffset: i };
      }
      return null; // ran out of bars without reaching the threshold
    }

    // TAUTOLOGY GUARD -- added 2026-08-18 after noticing Rescued+CorrectlyCut hits the FULL
    // bucket size exactly where moveUpPct crosses (100% - triggerPct%). Reason: the bucket is
    // SELECTED for having already reached `triggerFraction` of the stop distance AT the
    // checkpoint bar. If the tightened stop's remaining distance (1-moveUp) is <= that same
    // triggerFraction, the tightened stop is, by construction, ALREADY behind where price sits
    // at the very moment we're checking -- alreadyBreachedAtCheckpoint fires for ~100% of the
    // bucket, and the test stops measuring real forward price behavior at all. It degenerates
    // into "which of two already-known losses is smaller," which is true by arithmetic for any
    // tighter level, not evidence the tighter level would have helped. `alreadyBreachedPct`
    // below makes this visible per row instead of leaving it to be inferred from Rescued+Cut.
    function summarizeDynamicBucket(items, frac) {
      let realSum = 0, cfSum = 0, rescued = 0, correctlyCut = 0, n = 0, alreadyBreached = 0;
      const dateCounts = {};
      for (const item of items) {
        const cf = counterfactualForTrade(item, item.checkpointOffset, frac);
        if (!cf) continue;
        realSum += cf.realPnl; cfSum += cf.cfPnl;
        if (cf.rescued) rescued++;
        if (cf.correctlyCut) correctlyCut++;
        if (cf.alreadyBreachedAtCheckpoint) alreadyBreached++;
        n++;
        const d = item.t.trade_date.toISOString().split('T')[0];
        dateCounts[d] = (dateCounts[d] || 0) + 1;
      }
      const topDates = Object.entries(dateCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
      const top5Pct = n > 0 ? (topDates.reduce((s, [, c]) => s + c, 0) / n * 100).toFixed(1) : '0.0';
      const alreadyBreachedPct = n > 0 ? (alreadyBreached / n * 100).toFixed(1) : '0.0';
      return { n, avgReal: n ? realSum / n : 0, avgCf: n ? cfSum / n : 0, delta: n ? (cfSum - realSum) / n : 0, rescued, correctlyCut, top5Pct, topDates, alreadyBreachedPct };
    }

    // Fine 5%-increment sweep on the tighten amount, 0-80% "move up" (user's own framing --
    // "falling knife" avoidance: how far can the stop be moved up before it starts hurting more
    // than it helps). moveUpFrac=0 means no tighten at all (a sanity-check row, delta should be
    // ~0); moveUpFrac=0.80 means the new stop sits at just 20% of the original distance.
    const tightenFractionsFine = [];
    for (let moveUp = 0; moveUp <= 0.80 + 1e-9; moveUp += 0.05) {
      tightenFractionsFine.push(Math.round((1 - moveUp) * 100) / 100);
    }

    const triggerFractions = [0.5, 0.75];
    const results2 = [];
    const bucketLog2 = [];

    for (const triggerFraction of triggerFractions) {
      const signalItems = [], controlItems = [];
      for (const item of enriched) {
        const sig = findDynamicCheckpoint(item, triggerFraction, true);
        if (sig) signalItems.push({ ...item, checkpointOffset: sig.checkpointOffset });
        const ctl = findDynamicCheckpoint(item, triggerFraction, false);
        if (ctl) controlItems.push({ ...item, checkpointOffset: ctl.checkpointOffset });
      }
      const offsets = signalItems.map(x => x.checkpointOffset).sort((a, b) => a - b);
      const offsetMedian = median(offsets);
      bucketLog2.push(`trigger=${(triggerFraction * 100).toFixed(0)}%-of-stop: signal(zero-MFE reached it) n=${signalItems.length} (median bar-to-trigger=${offsetMedian ?? 'n/a'}), control(reached it regardless of MFE) n=${controlItems.length}`);

      for (const tightenFrac of tightenFractionsFine) {
        for (const [label, items] of [['DYNAMIC_CONTROL_reached_threshold', controlItems], ['DYNAMIC_SIGNAL_zero_mfe_reached_threshold', signalItems]]) {
          const s = summarizeDynamicBucket(items, tightenFrac);
          const moveUpPct = Math.round((1 - tightenFrac) * 100);
          results2.push({
            TriggerAtStopPct: `${(triggerFraction * 100).toFixed(0)}%`, MoveUpPct: `${moveUpPct}%`, Population: label,
            Count: s.n, AvgRealPnL: s.avgReal.toFixed(2), AvgCfPnL: s.avgCf.toFixed(2), Delta: s.delta.toFixed(2),
            AlreadyBreachedPct: `${s.alreadyBreachedPct}%`,
            Rescued: s.rescued, CorrectlyCut: s.correctlyCut, Top5DatePct: s.n >= 20 ? `${s.top5Pct}%` : 'N<20',
          });
        }
      }
    }

    console.log('\n\n=== PART 2: dynamic MAE-fraction-of-stop checkpoint (per-trade timing, not a fixed bar count) ===\n');
    console.table(results2);
    console.log('\nBucket sizes per trigger threshold:');
    for (const line of bucketLog2) console.log(line);

    // =========================================================================================
    // PART 3 -- added 2026-08-18 per DeepSeek's review of Part 2: depth alone barely
    // discriminates in this population (median bars-to-trigger = 0 for both thresholds -- half
    // of all trades reach 50-75% of their stop distance on the ENTRY BAR itself). The user's
    // actual goal is avoiding a "falling knife" (fast, sustained adverse move), which is a SPEED
    // concept, not a depth concept. This is the cheapest possible test of that: no counterfactual
    // simulation at all (so it's unaffected by the moveUp=0 sanity-check discrepancy still being
    // chased down) -- just a straight contingency of (bars taken to reach the trigger depth) vs
    // (the trade's REAL, already-recorded final outcome). If fast-to-get-deep trades really do
    // stop out more than slow ones, the "falling knife" framing has real empirical support and is
    // worth building real machinery for. If not, the framing doesn't hold in this data.
    console.log('\n\n=== PART 3: velocity (bars-to-depth) vs real outcome -- no simulation, no counterfactual ===\n');

    for (const triggerFraction of triggerFractions) {
      const reached = [];
      for (const item of enriched) {
        const ctl = findDynamicCheckpoint(item, triggerFraction, false);
        if (ctl) reached.push({ ...item, checkpointOffset: ctl.checkpointOffset });
      }
      const offsets = reached.map(x => x.checkpointOffset).sort((a, b) => a - b);
      const offsetMedian = median(offsets);
      // Raw distribution, not just the median -- verify DeepSeek's "median=0" finding directly.
      const histogram = {};
      for (const o of offsets) {
        const bucket = o === 0 ? '0' : o <= 2 ? '1-2' : o <= 5 ? '3-5' : o <= 10 ? '6-10' : '11+';
        histogram[bucket] = (histogram[bucket] || 0) + 1;
      }
      console.log(`\ntrigger=${(triggerFraction * 100).toFixed(0)}%-of-stop: n=${reached.length}, median bars-to-depth=${offsetMedian}`);
      console.log(`  bars-to-depth histogram: ${JSON.stringify(histogram)}`);

      // FAST = reached the depth on bar 0 or 1 (i.e. immediately/near-immediately -- matches
      // the "gap through, no warning" shape of an actual falling knife). SLOW = took 2+ bars.
      const fast = reached.filter(x => x.checkpointOffset <= 1);
      const slow = reached.filter(x => x.checkpointOffset >= 2);

      for (const [label, group] of [['FAST (<=1 bar)', fast], ['SLOW (>=2 bars)', slow]]) {
        const n = group.length;
        const stopHit = group.filter(x => x.t.resolution === 'STOP_HIT').length;
        const targetHit = group.filter(x => x.t.resolution === 'TARGET_HIT').length;
        const timeExpired = group.filter(x => x.t.resolution === 'TIME_EXPIRED').length;
        const other = n - stopHit - targetHit - timeExpired;
        const avgPnl = n > 0 ? group.reduce((s, x) => s + (Number(x.t.actual_pnl) || 0), 0) / n : 0;
        const dateCounts = {};
        for (const x of group) {
          const d = x.t.trade_date.toISOString().split('T')[0];
          dateCounts[d] = (dateCounts[d] || 0) + 1;
        }
        const topDates = Object.entries(dateCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
        const top5Pct = n > 0 ? (topDates.reduce((s, [, c]) => s + c, 0) / n * 100).toFixed(1) : '0.0';
        const distinctDays = Object.keys(dateCounts).length;
        console.log(`  ${label}: n=${n}, STOP_HIT=${stopHit} (${n ? (stopHit / n * 100).toFixed(1) : 0}%), TARGET_HIT=${targetHit} (${n ? (targetHit / n * 100).toFixed(1) : 0}%), TIME_EXPIRED=${timeExpired}, other=${other}, avgRealPnL=${avgPnl.toFixed(2)}, top5DatePct=${top5Pct}%, distinctDays=${distinctDays}`);
      }
    }

    // =========================================================================================
    // PART 4 -- added 2026-08-18 per DeepSeek's review of Part 3. The robust half of Part 3's
    // finding is the SLOW side ("a trade taking 2+ bars to reach 75% of its stop distance stops
    // out 83.7% of the time, vs a ~40% unconditional rate, and this survives excluding its own
    // biggest days"). This tests whether ACTING on that -- exiting at market once a trade is
    // confirmed slow -- would actually help, using a MARKET EXIT at the confirmation bar's close
    // instead of a placed stop. No stop level, no moveUp sweep, no "is the new stop already
    // behind price" question -- so this sidesteps BOTH open Part-2 problems (the checkpoint-
    // relative-to-current-price fix and the still-unresolved moveUp=0 sanity bug) entirely.
    // Three arms (mirrors Part 2's SIGNAL/CONTROL/blind-control structure so the claim can't be
    // credited to "exiting deep trades in general" instead of "exiting SLOW ones specifically"):
    //   BLIND  -- exit every trade that reaches the depth, regardless of speed
    //   SIGNAL -- exit only the SLOW ones (the actionable claim)
    //   CONTROL(fast) -- exit only the FAST ones (expected: little/no help, since Part 3 found
    //                     "fast is safe" doesn't survive excluding 2026-07-29/07-30)
    console.log('\n\n=== PART 4: market-exit-at-confirmation (SLOW vs FAST vs BLIND) -- no stop placement, no tautology ===\n');

    function summarizeExit(group) {
      let realSum = 0, exitSum = 0, improved = 0, hurt = 0, n = 0;
      const dateCounts = {};
      for (const item of group) {
        const { t, direction, entry, startIndex, resolvedAtTime, checkpointOffset } = item;
        const barIdx = startIndex + checkpointOffset;
        const bar = allBars[barIdx];
        const bTime = new Date(naive(bar.ts) + 'Z').getTime();
        // Ill-defined exit if the trade already resolved at or before the confirmation bar --
        // exclude per DeepSeek's recommendation rather than guess a fill.
        if (bTime >= resolvedAtTime) continue;
        const exitPrice = bar.close;
        const exitPnl = direction === 'LONG'
          ? (exitPrice - entry) * DOLLARS_PER_POINT - COMMISSION
          : (entry - exitPrice) * DOLLARS_PER_POINT - COMMISSION;
        const realPnl = Number(t.actual_pnl) || 0;
        realSum += realPnl; exitSum += exitPnl;
        if (exitPnl > realPnl) improved++; else if (exitPnl < realPnl) hurt++;
        n++;
        const d = t.trade_date.toISOString().split('T')[0];
        dateCounts[d] = (dateCounts[d] || 0) + 1;
      }
      const topDates = Object.entries(dateCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
      const top5Pct = n > 0 ? (topDates.reduce((s, [, c]) => s + c, 0) / n * 100).toFixed(1) : '0.0';
      return { n, avgReal: n ? realSum / n : 0, avgExit: n ? exitSum / n : 0, delta: n ? (exitSum - realSum) / n : 0, improved, hurt, top5Pct, topDates };
    }

    for (const triggerFraction of triggerFractions) {
      const reached = [];
      for (const item of enriched) {
        const ctl = findDynamicCheckpoint(item, triggerFraction, false);
        if (ctl) reached.push({ ...item, checkpointOffset: ctl.checkpointOffset });
      }
      const fast = reached.filter(x => x.checkpointOffset <= 1);
      const slow = reached.filter(x => x.checkpointOffset >= 2);

      console.log(`\ntrigger=${(triggerFraction * 100).toFixed(0)}%-of-stop:`);
      for (const [label, group] of [['BLIND (all)', reached], ['SIGNAL (SLOW >=2 bars)', slow], ['CONTROL (FAST <=1 bar)', fast]]) {
        const s = summarizeExit(group);
        console.log(`  ${label}: n=${s.n}, avgRealPnL=${s.avgReal.toFixed(2)}, avgExitPnL=${s.avgExit.toFixed(2)}, delta=${s.delta.toFixed(2)}, improved=${s.improved}, hurt=${s.hurt}, top5DatePct=${s.n >= 20 ? s.top5Pct + '%' : 'N<20'}`);
        if (label === 'SIGNAL (SLOW >=2 bars)' && s.n > 0) {
          const topDate = s.topDates[0]?.[0];
          if (topDate) {
            const filtered = group.filter(item => item.t.trade_date.toISOString().split('T')[0] !== topDate);
            const excl = summarizeExit(filtered);
            console.log(`    excl-top-date(${topDate}): n=${excl.n}, delta=${excl.delta.toFixed(2)} (full delta was ${s.delta.toFixed(2)})`);
          }
        }
      }
    }

  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

run();
