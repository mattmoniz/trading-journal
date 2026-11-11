// Scheduled-job health + de-duplicated alert digest for the Monitor & Learning page (Fable audit F07/F08, 2026-11-10; CLAUDE.md cv-110: one page).
// Why: VOL_REGIME_HIST failed every weekday for weeks and AI_DAILY_REVIEW 62 times with nobody reading process_log, and scratch/gemini_alerts.txt
// grew to 123k lines (46 MB) of the same few warnings repeated. This reads both, read-only, and answers "what is failing or stuck right now".
import fs from 'fs';
import path from 'path';
import { query } from '../db.js';
import { getLiveRoster, LIVE_ROSTER_GATE } from './setupEligibility.js';

const ALERTS_FILE = path.join(process.cwd(), 'scratch', 'gemini_alerts.txt');
const ALERT_TAIL_BYTES = 3 * 1024 * 1024;
const NOT_JOBS = ['SERVER_SHUTDOWN', 'PROCESS_UNHANDLED_REJECTION', 'SETUP_DETECTION_POLL'];        // lifecycle / recovery markers, not scheduled jobs
const clip = (s, n) => (s == null ? null : String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

/** Pure: per-job summary from process_log rows ordered newest first within each job. Exported for the unit test. */
export function summarizeJobs(rows) {
  const byJob = new Map();
  for (const r of rows) { if (!byJob.has(r.process_name)) byJob.set(r.process_name, []); byJob.get(r.process_name).push(r); }
  const jobs = [];
  for (const [name, list] of byJob) {
    const latest = list[0];
    let consecutiveFailures = 0;
    for (const r of list) { if (r.status === 'FAILED') consecutiveFailures++; else if (r.status === 'RUNNING' && r !== latest) continue; else break; }
    const lastOk = list.find((r) => r.status === 'SUCCESS') || null;
    jobs.push({
      name, latestStatus: latest.status, latestAt: latest.started, runs: list.length, failed: list.filter((r) => r.status === 'FAILED').length,
      consecutiveFailures, lastSuccessAt: lastOk ? lastOk.started : null, lastError: latest.status === 'FAILED' ? clip(latest.error_message, 240) : (list.find((r) => r.status === 'FAILED')?.error_message ? clip(list.find((r) => r.status === 'FAILED').error_message, 240) : null),
      stuck: false, // set by getJobHealth from the database clock (the stored started_at is naive ET text)
    });
  }
  return jobs;
}

/** Pure: group alert lines by tag + digit-normalized text. Newest group first. Exported for the unit test. */
export function digestAlerts(lines, maxGroups = 12) {
  const groups = new Map();
  for (const line of lines) {
    const m = /^\[([^\]]+)\]\s+\[([A-Z0-9_]+)\]\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, at, tag, text] = m;
    const key = `${tag}|${text.replace(/\d+(\.\d+)?/g, '#').slice(0, 110)}`;
    const g = groups.get(key) || { tag, count: 0, firstAt: at, lastAt: at, sample: clip(text, 260) };
    g.count++; g.lastAt = at; g.sample = clip(text, 260);
    groups.set(key, g);
  }
  const all = [...groups.values()];
  return { distinct: all.length, lines: all.reduce((a, g) => a + g.count, 0), groups: all.sort((a, b) => b.count - a.count).slice(0, maxGroups) };
}

async function readAlertTail() {
  const fh = await fs.promises.open(ALERTS_FILE, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - ALERT_TAIL_BYTES), len = size - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();                                     // drop the partial first line
    return { lines: lines.filter(Boolean), fileBytes: size, windowBytes: len };
  } finally { await fh.close(); }
}

let cache = null;
export async function getJobHealth() {
  if (cache && Date.now() - cache.at < 60000) return cache.value;
  const rows = (await query(`
    SELECT process_name, status, started_at::text AS started, error_message,
           (EXTRACT(EPOCH FROM (localtimestamp - started_at)) * 1000)::float AS age_ms
    FROM process_log WHERE started_at > localtimestamp - interval '14 days' AND process_name <> ALL($1)
    ORDER BY process_name, started_at DESC, id DESC`, [NOT_JOBS])).rows;
  const jobs = summarizeJobs(rows);
  const ageOf = new Map(); for (const r of rows) if (!ageOf.has(r.process_name)) ageOf.set(r.process_name, r.age_ms);
  for (const j of jobs) j.stuck = j.latestStatus === 'RUNNING' && ageOf.get(j.name) > 60 * 60 * 1000;   // a run still RUNNING an hour later was killed by a restart or hung
  const failing = jobs.filter((j) => j.latestStatus === 'FAILED').sort((a, b) => b.consecutiveFailures - a.consecutiveFailures);
  const stuck = jobs.filter((j) => j.stuck);
  let alerts;
  try { const t = await readAlertTail(); alerts = { state: 'OK', ...digestAlerts(t.lines), fileBytes: t.fileBytes, windowBytes: t.windowBytes }; }
  catch (e) { alerts = { state: e.code === 'ENOENT' ? 'NO_DATA' : 'ERROR', error: e.message }; }
  // F22: an EMPTY roster (calibration ran, chose nothing) and a MISSING/STALE one (calibration did not run) both fail closed identically; say which, so it is not a silent all-day SHADOW.
  let roster = null;
  try { const r = await getLiveRoster(); roster = { gateEnabled: LIVE_ROSTER_GATE.enabled, state: r.state, runDate: r.runDate, ageDays: r.ageDays ?? null, types: r.types.size }; } catch (e) { roster = { state: 'ERROR', error: e.message }; }
  const value = {
    state: 'OK', roster, generatedAt: new Date().toISOString(), window: '14 days of process_log',
    jobsTracked: jobs.length, failing, stuck, healthy: jobs.length - failing.length - stuck.length, alerts,
    nextSteps: {
      review: 'Each failing job below is a scheduled job whose newest run FAILED; read its error, fix or retire it. A job that fails 3 days running is a bug, not noise.',
      ifConfirmed: 'The list is empty for 5 trading days: close the Fable audit item F07 and stop reading process_log by hand.',
      ifFailed: 'A failure shows here with no matching process_log row (a job that never logs): add logProcess to it, then it appears.',
    },
  };
  cache = { at: Date.now(), value };
  return value;
}
