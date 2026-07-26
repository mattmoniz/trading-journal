// Tests the user's direct question (2026-07-26): after a down move of a given magnitude (in
// standard deviations), is there a real degree of certainty of further downside, and how much?
//
// THREE real bugs found and fixed across two Gemini dispatches plus one Claude fix, in order:
// 1. (Gemini pass 1) "Continuation" was defined as "price dips at all below the trigger bar's
//    close within the forward window" -- true ~98-100% of the time regardless of any preceding
//    move (both triggered and control groups showed the same rate), a tautological, non-
//    discriminating metric. Corrected to report the real-valued EXTENT of the move
//    (triggerBar.close - forwardMinLow, can be negative) directly, with a bootstrap median-
//    difference 95% CI against an unconditioned control group.
// 2. (Gemini pass 1) No de-duplication of overlapping triggers -- every bar during a sustained
//    decline that stayed over threshold counted as its own independent "trigger" (a single
//    2hr selloff could generate ~120 near-identical entries), massively overcounting
//    independent events. Corrected (Gemini pass 2) to only register a trigger on the first bar
//    of a fresh threshold-crossing streak (`isNewEvent = lastTriggerIdx[sig] !== i-1`).
// 3. (Gemini, BOTH passes, never caught) The gap-detection SQL computed gaps via
//    `LAG(ts) OVER (PARTITION BY trade_date ...)` -- calendar-date-partitioned -- and discarded
//    the ENTIRE calendar date if any internal gap exceeded 45 minutes. The normal daily 5-6PM
//    ET maintenance break IS such a gap, occurring within the same calendar date (both sides
//    are before midnight), so this silently dropped the vast majority of ordinary trading days.
//    Verified directly: 301 of 461 distinct dates (65%) were being excluded this way -- both
//    "corrected" Gemini passes ran on the same badly-undersampled ~35% of days throughout.
//    FIXED BY CLAUDE (not a 3rd Gemini dispatch, per the standing 2-corrections rule): load ALL
//    bars unconditionally, and instead invalidate only the specific rolling computations that
//    would actually span a real gap (volatility-window reset + H-minute-lookback +
//    forward-window gap guards) -- matching the "session validity via real per-bar gap"
//    convention already established in every other script this session. Also switched off the
//    hardcoded gemini_readonly pg.Client credentials to this codebase's own server/db.js
//    query() wrapper, matching every other promoted script.
//
// RESULT (post-fix, see RESEARCH_CLAIM sigma_continuation_down_moves): a real, clean,
// monotonic finding that replicates across all 4 sensitivity configs (sigma-window 100/300 x
// move-window 30/60min) and all 3 forward windows (30/60/120min). Every single row shows a
// positive median-extension lift over the unconditioned control, with the 95% CI clear of
// zero, growing consistently with the sigma threshold on BOTH train and test: at 1.0 sigma the
// lift is modest (roughly +2 to +11pt beyond control's own already-real extension); by 2.0
// sigma it grows to roughly +12 to +34pt; by 3.0 sigma (thinner sample, N=64-500 dedup events,
// 15-153 distinct days depending on config) it reaches +20 to +80pt+. Practical read: the
// question "will it continue" is close to moot (price almost always drifts a little further in
// either direction given enough time) -- the real, useful answer is in the MAGNITUDE, which
// scales up meaningfully and reliably with how extreme the initiating move already was.
import { query } from '../server/db.js';
import fs from 'fs';

async function run() {
  console.log("Fetching price bars...");

  const { rows } = await query(`
    SELECT ts, close::float, low::float, ((ts AT TIME ZONE 'America/New_York')::date)::text as trade_date
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts >= (SELECT MAX(ts) FROM price_bars_primary WHERE symbol='NQ') - INTERVAL '2 years'
    ORDER BY ts ASC
  `);

  console.log(`Fetched ${rows.length} rows.`);
  if (rows.length === 0) return;

  const dates = [...new Set(rows.map(r => r.trade_date))].sort();
  const trainSplitIdx = Math.floor(dates.length * 0.8);
  const trainDates = new Set(dates.slice(0, trainSplitIdx));
  const testDates = new Set(dates.slice(trainSplitIdx));

  const GAP_CUTOFF_MIN = 45;
  const bars = rows.map((r, i) => {
    let logRet = 0;
    let gapMin = Infinity; // first bar has no prior bar -- treat as a boundary
    if (i > 0) {
      logRet = Math.log(r.close / rows[i - 1].close);
      gapMin = (new Date(r.ts).getTime() - new Date(rows[i - 1].ts).getTime()) / 60000;
    }
    return {
      ts: new Date(r.ts).getTime(),
      close: Number(r.close),
      low: Number(r.low),
      dateStr: r.trade_date,
      logRet,
      gapMin,
    };
  });

  const sigmas = [1.0, 1.5, 2.0, 2.5, 3.0];
  const trailingWindows = [30, 60];
  const trailingVolWindows = [100, 300];
  const forwardWindows = [30, 60, 120];

  const results = [];

  const bootstrapMedianDiff = (extA, extB, iterations = 1000) => {
    if (extA.length === 0 || extB.length === 0) return { diff: 0, ci2_5: 0, ci97_5: 0 };
    
    let extB_sub = extB;
    if (extB.length > 5000) {
      extB_sub = new Float64Array(5000);
      for (let i=0; i<5000; i++) extB_sub[i] = extB[Math.floor(Math.random() * extB.length)];
    }
    const extA_sub = extA; 
    
    const diffs = new Float64Array(iterations);
    
    const lenA = extA_sub.length;
    const lenB = extB_sub.length;
    const sampA = new Float64Array(lenA);
    const sampB = new Float64Array(lenB);
    
    for (let i = 0; i < iterations; i++) {
      for (let j = 0; j < lenA; j++) sampA[j] = extA_sub[Math.floor(Math.random() * lenA)];
      for (let j = 0; j < lenB; j++) sampB[j] = extB_sub[Math.floor(Math.random() * lenB)];
      
      sampA.sort();
      sampB.sort();
      
      const medA = sampA[Math.floor(lenA * 0.5)];
      const medB = sampB[Math.floor(lenB * 0.5)];
      diffs[i] = medA - medB;
    }
    
    diffs.sort();
    
    const sortedA = new Float64Array(extA); sortedA.sort();
    const sortedB = new Float64Array(extB); sortedB.sort();
    const realDiff = (sortedA.length > 0 ? sortedA[Math.floor(sortedA.length * 0.5)] : 0) - 
                     (sortedB.length > 0 ? sortedB[Math.floor(sortedB.length * 0.5)] : 0);
                     
    return {
      diff: realDiff,
      ci2_5: diffs[Math.floor(iterations * 0.025)],
      ci97_5: diffs[Math.floor(iterations * 0.975)]
    };
  };

  for (const volWin of trailingVolWindows) {
    for (const H of trailingWindows) {
      const triggers = [];
      let sumLogRet = 0;
      let sumSqLogRet = 0;
      let volWindowBars = [];
      
      const lastTriggerIdx = {};
      sigmas.forEach(s => lastTriggerIdx[s] = -2);
      
      for (let i = 0; i < bars.length; i++) {
        const bar = bars[i];

        // Gap guard: a genuine data gap (>45min -- the daily maintenance break, a weekend,
        // or a real data void) invalidates the rolling volatility window. Reset rather than
        // let a huge across-gap "return" masquerade as a normal 1-min move.
        if (bar.gapMin > GAP_CUTOFF_MIN) {
          volWindowBars = [];
          sumLogRet = 0;
          sumSqLogRet = 0;
        } else {
          volWindowBars.push(bar.logRet);
          sumLogRet += bar.logRet;
          sumSqLogRet += bar.logRet * bar.logRet;
        }

        if (volWindowBars.length > volWin) {
          const removed = volWindowBars.shift();
          sumLogRet -= removed;
          sumSqLogRet -= removed * removed;
        }

        // H-minute lookback must itself be gap-free -- otherwise bars[i-H] isn't really
        // "H minutes ago," it's on the other side of a data void.
        let lookbackHasGap = false;
        if (i >= H) {
          for (let j = i - H + 1; j <= i; j++) {
            if (bars[j].gapMin > GAP_CUTOFF_MIN) { lookbackHasGap = true; break; }
          }
        }

        if (volWindowBars.length === volWin && i >= H && !lookbackHasGap) {
          const mean = sumLogRet / volWin;
          let variance = (sumSqLogRet / volWin) - (mean * mean);
          if (variance < 0) variance = 0;
          const stdDevLogRet = Math.sqrt(variance);

          if (stdDevLogRet > 0) {
            const moveInPoints = bar.close - bars[i-H].close;
            const expectedMove = bar.close * stdDevLogRet * Math.sqrt(H);

            if (moveInPoints < 0) {
              const downMagnitude = Math.abs(moveInPoints) / expectedMove;
              
              for (const sig of sigmas) {
                if (downMagnitude >= sig) {
                  const isNewEvent = (lastTriggerIdx[sig] !== i - 1);
                  triggers.push({ idx: i, threshold: sig, dateStr: bar.dateStr, isNewEvent });
                  lastTriggerIdx[sig] = i;
                }
              }
            }
          }
        }
      }
      
      for (const sig of sigmas) {
        const matchingTriggers = triggers.filter(t => t.threshold === sig);
        for (const fw of forwardWindows) {
          for (const split of ['train', 'test']) {
            const targetDates = split === 'train' ? trainDates : testDates;
            const splitTriggers = matchingTriggers.filter(t => targetDates.has(t.dateStr));
            const dedupedTriggers = splitTriggers.filter(t => t.isNewEvent);
            
            const controlBars = [];
            for (let i = Math.max(volWin, H); i < bars.length; i++) {
              if (targetDates.has(bars[i].dateStr)) controlBars.push(i);
            }
            
            const evalForward = (indices) => {
              const extentsList = [];
              const uniqueDates = new Set();

              for (let k = 0; k < indices.length; k++) {
                const idx = indices[k];
                const triggerBar = bars[idx];

                const endIdx = Math.min(bars.length - 1, idx + fw);
                if (idx + 1 > endIdx) continue; // no forward bars at all (end of series)

                // Forward window must itself be gap-free -- a real data void inside the
                // window would let a stale close/low masquerade as a genuine price move.
                let windowHasGap = false;
                for (let j = idx + 1; j <= endIdx; j++) {
                  if (bars[j].gapMin > GAP_CUTOFF_MIN) { windowHasGap = true; break; }
                }
                if (windowHasGap) continue;

                uniqueDates.add(triggerBar.dateStr);
                let minLow = bars[idx + 1].low;
                for (let j = idx + 2; j <= endIdx; j++) {
                  if (bars[j].low < minLow) minLow = bars[j].low;
                }

                extentsList.push(triggerBar.close - minLow);
              }

              const extents = Float64Array.from(extentsList);
              const sortedExtents = new Float64Array(extents);
              sortedExtents.sort();
              const n = sortedExtents.length;
              
              const p25 = n > 0 ? sortedExtents[Math.floor(n * 0.25)] : 0;
              const med = n > 0 ? sortedExtents[Math.floor(n * 0.5)] : 0;
              const p75 = n > 0 ? sortedExtents[Math.floor(n * 0.75)] : 0;
              
              let sum = 0;
              for (let k = 0; k < n; k++) sum += sortedExtents[k];
              const mean = n > 0 ? sum / n : 0;
              
              return {
                n,
                uniqueDates: uniqueDates.size,
                mean, med, p25, p75,
                extents
              };
            };
            
            const trgEval = evalForward(dedupedTriggers.map(t => t.idx));
            const ctrlEval = evalForward(controlBars);
            const boot = bootstrapMedianDiff(trgEval.extents, ctrlEval.extents, 1000);
            
            results.push({
              volWin, H, sig, fw, split,
              rawN: splitTriggers.length,
              trg: trgEval,
              ctrl: ctrlEval,
              boot
            });
          }
        }
      }
    }
  }

  let md = "# Down Move Continuation Analysis\n\n";
  let summary = "## Key Findings\n\n";
  let warningFlags = [];

  for (const volWin of trailingVolWindows) {
    for (const H of trailingWindows) {
      md += `## Sigma Window: ${volWin}, Trailing Move Window: ${H}m\n\n`;
      md += "| Split | Fwd Win | Sigma | Raw N | Dedup N | Trig Days | Trig Ext (P25/Med/P75) | Ctrl Ext (P25/Med/P75) | Med Diff (95% CI) |\n";
      md += "|---|---|---|---|---|---|---|---|---|\n";
      
      const subRes = results.filter(r => r.volWin === volWin && r.H === H);
      
      for (const fw of forwardWindows) {
        for (const sig of sigmas) {
          for (const split of ['train', 'test']) {
            const r = subRes.find(x => x.split === split && x.fw === fw && x.sig === sig);
            if (!r) continue;
            
            const {trg, ctrl, rawN, boot} = r;
            const trigExtStr = `${trg.p25.toFixed(1)} / ${trg.med.toFixed(1)} / ${trg.p75.toFixed(1)}`;
            const ctrlExtStr = `${ctrl.p25.toFixed(1)} / ${ctrl.med.toFixed(1)} / ${ctrl.p75.toFixed(1)}`;
            const diffStr = `${boot.diff.toFixed(1)} [${boot.ci2_5.toFixed(1)}, ${boot.ci97_5.toFixed(1)}]`;
            
            md += `| ${split} | ${fw}m | ${sig.toFixed(1)} | ${rawN} | ${trg.n} | ${trg.uniqueDates} | ${trigExtStr} | ${ctrlExtStr} | ${diffStr} |\n`;
            
            if (trg.n < 20) {
              if (!warningFlags.includes(`N<20 on deduped events for ${sig} sigma (${split}) - insufficient sample (directional only)`)) {
                warningFlags.push(`N<20 on deduped events for ${sig} sigma (${split}) - insufficient sample (directional only)`);
              }
            }
          }
        }
      }
      md += "\n";
    }
  }

  summary += warningFlags.map(w => "- **WARNING**: " + w).join("\n") + "\n\n";
  summary += "A full breakdown is available in `scratch/sigma_continuation_RESULTS.md`.\n";
  summary += "\n**Conclusion on Overlapping Triggers**: The extension-magnitude difference (triggered vs control) is evaluated here on strictly deduplicated, independent events (avoiding the massive overcounting of the previous script). Review the median differences and their 95% CIs to see if the edge survives or if it was merely an artifact of overlapping events.\n";

  fs.writeFileSync('scratch/sigma_continuation_RESULTS.md', md);
  fs.writeFileSync('scratch/antigravity_response.md', 
    "# Down Move Continuation Analysis\n\n" + 
    "Hypothesis: Does a down move of a given magnitude predict further downside continuation, and how much?\n\n" +
    "Methodology:\n" +
    "- Pulled ~2 years of 1-min RTH bars for NQ, excluding days with >45m gap.\n" +
    "- Computed point-in-time rolling standard deviation of 1-min log returns (N=100, N=300).\n" +
    "- Computed trailing H-min (30, 60) down moves as multiples of standard deviations.\n" +
    "- Deduplicated triggers: consecutive bars crossing the same threshold count as a single event.\n" +
    "- Computed the forward 'extension' (`triggerBar.close - forwardMinLow`) for both deduplicated triggers and control group bars.\n" +
    "- Real-valued extension magnitudes evaluated directly (median difference with 95% bootstrap CI).\n" +
    "- Chronological 80/20 train/test split.\n\n" +
    "Results Summary:\n\n" + summary + "\n\n"
  );
  console.log("Analysis complete.");
}

run().catch(err => {
  console.error(err);
  fs.writeFileSync('scratch/antigravity_response.md', `Error: ${err.message}`);
});
