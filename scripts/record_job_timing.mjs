#!/usr/bin/env node
// usage: node scripts/record_job_timing.mjs <job> <step> <duration_s> <exit_code>   (called by scripts/lib/job_timing.sh after every scheduled step)
// Stores the duration in job_timings and judges it against that same step's earlier runs (median/MAD, p99 AND modified z > 3.5 -- the same test the
// server's post-deploy watch uses, minimum 8 earlier runs). A step that got clearly slower opens one OPEN_DECISION per step per day, naming the git
// sha it ran under and the shas of the earlier runs, so a slowdown in a nightly/weekly job is tied to the change that came before it.
import { execFileSync } from 'node:child_process';
import { query } from '../server/db.js';
import { judgeAgainstHistory } from '../server/services/perfTelemetry.js';
const MIN_RUNS = 8;
const [job, step, durS, exitCode] = process.argv.slice(2);
const dur = Number(durS);
if (!job || !step || !Number.isFinite(dur)) process.exit(0);
let sha = 'unknown';
try { sha = execFileSync('git', ['rev-parse', '--short=10', 'HEAD'], { encoding: 'utf8' }).trim(); } catch (_) {}
const hist = (await query(`SELECT duration_s::float AS d, git_sha FROM job_timings WHERE job=$1 AND step=$2 AND exit_code = 0 AND started_at >= now() - interval '120 days' ORDER BY started_at`, [job, step])).rows;
const j = Number(exitCode) === 0 ? judgeAgainstHistory(dur, hist.map(r => r.d), MIN_RUNS) : null;
await query(`INSERT INTO job_timings (job, step, duration_s, exit_code, git_sha, verdict) VALUES ($1,$2,$3,$4,$5,$6)`, [job, step, dur, Number(exitCode), sha, j ? JSON.stringify(j) : null]);
if (j?.flagged) {
  const { flagDecision } = await import('./flag_decision.mjs');
  const today = (await query(`SELECT CURRENT_DATE::text d`)).rows[0].d;
  const shas = [...new Set(hist.slice(-8).map(r => r.git_sha))].join(', ');
  await flagDecision({
    slug: `job_slower_${job}_${step.replace(/\W+/g, '_')}_${today.replace(/-/g, '')}`.slice(0, 80),
    priority: 'LOW', sourceFile: 'scripts/record_job_timing.mjs', sourceDate: today,
    decisionText: `Scheduled step ${job}/${step} took ${dur}s, above its own earlier runs (median ${j.median.toFixed(0)}s, p99 ${j.p99.toFixed(0)}s over ${hist.length} runs, modified z ${j.z}). It ran under ${sha}; its recent earlier runs were under: ${shas || 'n/a'}. Look at what changed in that step's inputs or code between those versions, or whether the data it reads simply grew (then the query needs a bound or an index). History: SELECT * FROM job_timings WHERE job='${job}' AND step='${step}' ORDER BY started_at. Resolve when the cause is found and fixed or accepted.`,
  });
}
process.exit(0);
