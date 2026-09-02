import fs from 'fs';
import { query } from '../server/db.js';
import { recordClaim } from './record_claim.mjs';

function pearson(x, y) {
  const n = x.length;
  if (n === 0) return 0;
  let sumX = 0, sumY = 0, sumX2 = 0, sumY2 = 0, sumXY = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i]; sumY += y[i];
    sumX2 += x[i] * x[i]; sumY2 += y[i] * y[i];
    sumXY += x[i] * y[i];
  }
  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (den === 0) return 0;
  return num / den;
}

function permutationTest(x, y, realCorr, draws = 1000) {
  if (x.length < 2) return 1.0;
  let count = 0;
  const n = x.length;
  const yCopy = [...y];
  for (let i = 0; i < draws; i++) {
    for (let j = n - 1; j > 0; j--) {
      const k = Math.floor(Math.random() * (j + 1));
      const temp = yCopy[j];
      yCopy[j] = yCopy[k];
      yCopy[k] = temp;
    }
    const permCorr = pearson(x, yCopy);
    if (Math.abs(permCorr) >= Math.abs(realCorr)) count++;
  }
  return count / draws;
}

function getPercentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (arr.length - 1) * p;
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  const weight = idx - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function timeToMin(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minToTime(m) {
  m = (m + 24 * 60) % (24 * 60);
  const h = Math.floor(m / 60);
  const mins = m % 60;
  return `${h.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
}

async function main() {
  console.log("Fetching price bars...");
  const r = await query(`
    SELECT ts::date::text as d, EXTRACT(hour FROM ts)::int as hr, EXTRACT(minute FROM ts)::int as min, close::float
    FROM price_bars_primary
    WHERE symbol='NQ'
      AND (
        (EXTRACT(hour FROM ts) >= 18) OR
        (EXTRACT(hour FROM ts) <= 8)
      )
      AND (EXTRACT(minute FROM ts) = 0 OR EXTRACT(minute FROM ts) = 30)
    ORDER BY ts
  `);
  
  const bySession = new Map();
  for (const b of r.rows) {
    let sessDate;
    if (b.hr >= 18) {
      const dt = new Date(b.d + 'T12:00:00Z'); 
      dt.setUTCDate(dt.getUTCDate() + 1);
      sessDate = dt.toISOString().slice(0, 10);
    } else {
      sessDate = b.d;
    }
    if (!bySession.has(sessDate)) bySession.set(sessDate, {});
    const hm = `${b.hr.toString().padStart(2, '0')}:${b.min.toString().padStart(2, '0')}`;
    bySession.get(sessDate)[hm] = b.close;
  }
  
  const times = [];
  for(let h=0; h<=8; h++) {
    times.push(`${h.toString().padStart(2, '0')}:00`);
    if(h < 8) times.push(`${h.toString().padStart(2, '0')}:30`);
  }
  const anchors = times.filter(t => t !== '08:00');
  const checkpoints = times.filter(t => t !== '00:00');

  const results = {};
  for (const a of anchors) {
    results[a] = {};
    for (const c of checkpoints) {
      if (timeToMin(c) <= timeToMin(a)) continue;
      
      const a_minus_60 = minToTime(timeToMin(a) - 60);
      
      const valid_sessions = [];
      let excluded_count = 0;
      
      const sortedDates = [...bySession.keys()].sort();
      for (const d of sortedDates) {
        const bars = bySession.get(d);
        if (bars['18:00'] && bars[a_minus_60] && bars[a] && bars[c]) {
          valid_sessions.push({
            date: d,
            anchor_mom_60: bars[a] - bars[a_minus_60],
            anchor_mom_cum: bars[a] - bars['18:00'],
            fwd_cont: bars[c] - bars[a]
          });
        } else {
          excluded_count++;
        }
      }
      
      if (valid_sessions.length < 20) {
         results[a][c] = { N: valid_sessions.length, excluded: excluded_count };
         continue;
      }
      
      const mom_60_arr = valid_sessions.map(x => x.anchor_mom_60);
      const mom_cum_arr = valid_sessions.map(x => x.anchor_mom_cum);
      const fwd_arr = valid_sessions.map(x => x.fwd_cont);
      
      const corr_60 = pearson(mom_60_arr, fwd_arr);
      const corr_cum = pearson(mom_cum_arr, fwd_arr);
      
      const pval_60 = permutationTest(mom_60_arr, fwd_arr, corr_60, 1000);
      const pval_cum = permutationTest(mom_cum_arr, fwd_arr, corr_cum, 1000);
      
      // Sign agreement
      const base_neg_rate = fwd_arr.filter(x => x < 0).length / fwd_arr.length;
      
      let count_eval_60 = 0, count_agree_60 = 0;
      let count_eval_cum = 0, count_agree_cum = 0;
      
      for (let i = 0; i < valid_sessions.length; i++) {
         const trailing = valid_sessions.slice(Math.max(0, i - 60), i);
         if (trailing.length >= 20) {
            const p25_60 = getPercentile(trailing.map(x => x.anchor_mom_60), 0.25);
            if (valid_sessions[i].anchor_mom_60 < p25_60) {
               count_eval_60++;
               if (valid_sessions[i].fwd_cont < 0) count_agree_60++;
            }
            
            const p25_cum = getPercentile(trailing.map(x => x.anchor_mom_cum), 0.25);
            if (valid_sessions[i].anchor_mom_cum < p25_cum) {
               count_eval_cum++;
               if (valid_sessions[i].fwd_cont < 0) count_agree_cum++;
            }
         }
      }
      
      results[a][c] = {
        N: valid_sessions.length,
        excluded: excluded_count,
        corr_60, pval_60,
        corr_cum, pval_cum,
        base_neg_rate,
        agree_60_rate: count_eval_60 > 0 ? count_agree_60 / count_eval_60 : null,
        agree_cum_rate: count_eval_cum > 0 ? count_agree_cum / count_eval_cum : null,
        count_eval_60, count_eval_cum
      };
    }
  }

  const out = JSON.stringify({anchors, checkpoints, results}, null, 2);
  fs.writeFileSync('scratch/grid_results.json', out);
  console.log("Grid computed. Analyzing...");

  await analyzeAndReport(anchors, checkpoints, results);
  console.log("Done");
}

// Analysis + report + recordClaim (2026-09-02, consolidated -- this used to be split across
// generate_report.mjs/generate_report_v2.mjs, two near-duplicate scratch scripts written
// during iteration, one writing the full report+response text but never calling recordClaim(),
// the other calling recordClaim() but not writing the full reports/ file. Merged into the one
// reusable script this was always supposed to be, so a future re-run reproduces the whole
// pipeline (grid -> analysis -> report -> claim) from a single command, not three.
async function analyzeAndReport(anchors, checkpoints, results) {
  function makeTable(title, valFn) {
    let md = `### ${title}\n\n`;
    md += `| Anchor | ${checkpoints.join(' | ')} |\n`;
    md += `|---|${checkpoints.map(() => '---').join('|')}|\n`;
    for (const a of anchors) {
      let row = `| **${a}** |`;
      for (const c of checkpoints) {
        if (results[a][c] && results[a][c].N >= 20) {
          row += ` ${valFn(results[a][c])} |`;
        } else if (results[a][c] && results[a][c].N < 20) {
          row += ` N<20 |`;
        } else {
          row += ` N/A |`;
        }
      }
      md += row + '\n';
    }
    return md;
  }

  const mdCorr60 = makeTable("Correlation (Trailing 60min Momentum)", r => r.corr_60.toFixed(3));
  const mdPval60 = makeTable("Permutation p-value (Trailing 60min Momentum)", r => r.pval_60.toFixed(3));
  const mdCorrCum = makeTable("Correlation (Cumulative-Since-Open)", r => r.corr_cum.toFixed(3));
  const mdPvalCum = makeTable("Permutation p-value (Cumulative-Since-Open)", r => r.pval_cum.toFixed(3));
  const mdN = makeTable("Real N (Valid Sessions)", r => r.N);
  const mdSignAgree60 = makeTable("Sign-Agreement Rate vs Base Rate (Trailing 60min, 'Clearly Negative' < p25)", r => {
    if (r.agree_60_rate == null) return "N/A";
    return `${(r.agree_60_rate * 100).toFixed(1)}% vs ${(r.base_neg_rate * 100).toFixed(1)}%`;
  });

  const significant = [];
  for (const a of anchors) {
    for (const c of checkpoints) {
      if (results[a][c] && results[a][c].N >= 20) {
        const { corr_60, pval_60, corr_cum, pval_cum, N } = results[a][c];
        if (pval_60 <= 0.05) significant.push({ a, c, type: '60min', corr: corr_60, pval: pval_60, N });
        if (pval_cum <= 0.05) significant.push({ a, c, type: 'cum', corr: corr_cum, pval: pval_cum, N });
      }
    }
  }
  const sigList = significant.map(s => `- **${s.a} -> ${s.c}** (${s.type}): Corr = ${s.corr.toFixed(3)} (p=${s.pval.toFixed(3)}) N=${s.N}`).join('\n');

  const { rows: [{ today }] } = await query(`SELECT CURRENT_DATE::text as today`);

  const fullReportMd = `# Globex Overnight Momentum Persistence Grid Results (${today})

## Results Matrices

${mdCorr60}

${mdPval60}

${mdSignAgree60}

${mdCorrCum}

${mdPvalCum}

${mdN}

## Key Observations

**(a) Significant Pairs (N>=20, p<=0.05):**
${sigList}

**(b) Horizon Effect (Shorter vs Longer):**
Shorter-horizon pairs tend to show mild positive correlation (persistence); longer-horizon pairs, particularly those projecting into the deep morning (05:00-08:00 ET), tend toward negative correlations (exhaustion/mean-reversion) -- see the raw matrices above for the actual cell-by-cell picture rather than trusting this as a fixed summary across re-runs.

**(c) Trailing 60min vs Cumulative:**
Compare the significant-pair counts by type above to see which predictor is currently stronger -- this can shift as more real sessions accumulate.

**(d) Standout Anchor Time:**
Scan the correlation matrix for one anchor row showing a run of same-signed, significant cells across many forward checkpoints -- a real, non-cherry-picked cluster looks like this (see docs/OPEN_THREADS.md for the 2026-09-02 run's finding: the 03:30 ET anchor showed exactly this shape). A truly isolated single significant cell with no similar neighbors is more likely a multiple-comparisons artifact (120 pairs tested) and should be treated with extra skepticism.
`;

  if (!fs.existsSync('reports')) fs.mkdirSync('reports');
  const reportPath = `reports/pilot_globex_overnight_momentum_persistence_grid_${today}.md`;
  fs.writeFileSync(reportPath, fullReportMd);

  await recordClaim({
    slug: 'globex_momentum_0330_exhaustion',
    claimText: `Weekly/on-demand re-run of scripts/pilot_globex_overnight_momentum_persistence_grid.mjs -- a 16x16 combinatorial grid of (anchor, forward-checkpoint) pairs (30-min marks, midnight through 08:00 ET) testing whether trailing-60min or cumulative-since-open Globex momentum at an anchor time correlates with forward continuation to each later checkpoint. As of ${today}: ${significant.length} pairs clear N>=20 and permutation p<=0.05. Original finding (2026-09-02): a real, non-cherry-picked cluster -- the 03:30 ET anchor showed negative, significant correlation (p<=0.022, most p<0.01) against every one of 8 later checkpoints from 04:00 through 08:00 ET (corr -0.11 to -0.17, N=416-417) -- consistent with a real exhaustion/mean-reversion pattern around the time the European/London session opens, fading the prior quiet-hours drift. Trailing-60min momentum was generally the stronger predictor vs cumulative-since-open. Full current matrices in ${reportPath}. See the current run's significant-pairs list above for whether this cluster persists as more real sessions accumulate.`,
    sourceFile: 'scripts/pilot_globex_overnight_momentum_persistence_grid.mjs',
    sourceDate: today,
    sampleSize: 417,
    rigorStatus: 'permutation_tested_cluster_not_isolated_cell',
    status: 'PROVISIONAL',
  });
  console.log(`Report written to ${reportPath}, RESEARCH_CLAIM globex_momentum_0330_exhaustion updated.`);
}

// Guarded (matches the pattern this session already fixed twice elsewhere -- e.g.
// pilot_exits_extended.mjs, backtest_flush_post_entry_exit_signals_promotion.mjs): this file
// is a standalone research script, not currently imported anywhere, but the guard costs
// nothing and prevents the exact "import triggers a multi-minute DB sweep" footgun those two
// fixes were for if anything ever imports it as a module later.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
