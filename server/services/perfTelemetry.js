// Performance / health telemetry (2026-10-19). One persisted snapshot every ~5 minutes in perf_snapshots, a DEPLOY marker at each server start,
// regression detection against the metric's OWN rolling history, and an incident bundle + OPEN_DECISION when a regression persists.
//
// Why this exists: detection-pass time, DB saturation and order latency regressed for weeks with nobody noticing, because the only
// instrumentation was a cumulative-since-boot profiler (db.js getQueryProfile) that nothing stored or compared. Every change since then
// has had to be "measured by hand". This turns that into a standing mechanism:
//   1. RECORD   perf_snapshots rows (kind SNAPSHOT) with the running git sha, plus a DEPLOY row at boot.
//   2. DETECT   each snapshot is compared with the last 14 days of SNAPSHOT rows in the SAME session bucket (RTH / GLOBEX / GAP), using the
//               distribution itself: flag when the value is above that history's p99 AND its modified z-score (median/MAD) exceeds 3.5 (the
//               standard Iglewicz-Hoaglin outlier cutoff). No fixed millisecond/percent thresholds anywhere. Needs MIN_HISTORY samples before
//               it judges anything (reports "learning" until then).
//   3. ATTRIBUTE scripts/perf_report.mjs groups the same rows by deploy_sha so a change's before/after is automatic.
//   4. RESPOND  a flag must persist 2 consecutive snapshots to show on the quick-check banner (getPerfAttention); at 3 it captures an INCIDENT
//               row (what was heaviest: query shapes, routes, pool, event loop, with the deploy that was running) and flags one OPEN_DECISION per
//               metric per day. Auto-remediation is deliberately NOT done: restarting or killing things while a real position may be open is
//               the one action this system must never take on its own.
// Recheck path: this runs forever (it IS the recheck); a persisted regression resolves itself in the banner when the metric returns to range.
import { execFileSync } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import pool, { query, getQueryProfile } from '../db.js';
import { killSwitch } from './sierraChart/orderEligibility.js';
import { getMlScoringStatus } from './mlScoringServiceManager.js';

const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
const HISTORY_DAYS = 14;
const MIN_HISTORY = 60;          // samples in the same session bucket before any judgement (about 5 hours of 5-min snapshots)
const MODIFIED_Z_CUTOFF = 3.5;   // Iglewicz & Hoaglin outlier cutoff on the modified z-score
const SHOW_AFTER = 2;            // consecutive flagged snapshots before the banner shows
const INCIDENT_AT = 3;           // consecutive flagged snapshots before an incident bundle + decision
// Higher is worse for every one of these.
const JUDGED = ['db_time_pct', 'detect_avg_ms', 'loop_p99_ms', 'poll_outages', 'entry_delay_p90_s'];

const bootId = new Date().toISOString();
let deploySha = 'unknown';
try {
  deploySha = execFileSync('git', ['rev-parse', '--short=10', 'HEAD'], { encoding: 'utf8', cwd: new URL('../..', import.meta.url).pathname }).trim();
  try { execFileSync('git', ['diff-index', '--quiet', 'HEAD', '--'], { cwd: new URL('../..', import.meta.url).pathname }); } catch (_) { deploySha += '+'; }
} catch (_) { /* not a git checkout: stays 'unknown' */ }

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

let prevAt = Date.now();
let prevShapes = new Map();   // shape -> {totalMs, calls}
let prevRoutes = new Map();   // route -> {totalMs, calls}
let prevConsecutive = {};     // metric -> consecutive flagged snapshots
let lastReport = null;        // last snapshot's regression report, for the banner
let getRequestProfile = () => [];
let timer = null;

export function etSession(date = new Date()) {
  const et = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dow = et.getDay(), min = et.getHours() * 60 + et.getMinutes();
  if (dow === 6 || (dow === 5 && min >= 1020) || (dow === 0 && min < 1080)) return 'CLOSED';
  if (dow >= 1 && dow <= 5 && min >= 570 && min < 960) return 'RTH';
  if (min >= 960 && min < 1080) return 'GAP';
  return 'GLOBEX';
}

function median(a) { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function quantile(a, q) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }

// value vs its own history. Returns null while history is too thin ("learning").
export function judgeAgainstHistory(value, history) {
  if (value == null || history.length < MIN_HISTORY) return null;
  const med = median(history);
  const mad = median(history.map(h => Math.abs(h - med)));
  let scale = 1.4826 * mad;
  if (!(scale > 0)) { const meanAbs = history.reduce((a, h) => a + Math.abs(h - med), 0) / history.length; scale = 1.253314 * meanAbs; }
  const p99 = quantile(history, 0.99);
  const z = scale > 0 ? (value - med) / scale : (value > med ? Infinity : 0);
  return { value, median: med, p99, z: Number.isFinite(z) ? +z.toFixed(2) : 999, flagged: value > p99 && z > MODIFIED_Z_CUTOFF };
}

function topDeltas(profileRows, prevMap, keyFn, totalFn, callsFn, n = 6) {
  const out = [];
  const next = new Map();
  for (const r of profileRows) {
    const k = keyFn(r), tot = totalFn(r), calls = callsFn(r);
    next.set(k, { totalMs: tot, calls });
    const p = prevMap.get(k);
    const dMs = tot - (p ? p.totalMs : 0), dCalls = calls - (p ? p.calls : 0);
    if (dMs > 0 && dCalls > 0) out.push({ key: k, totalMs: Math.round(dMs), calls: dCalls, avgMs: Math.round(dMs / dCalls) });
  }
  return { top: out.sort((a, b) => b.totalMs - a.totalMs).slice(0, n), next };
}

async function collect() {
  const now = Date.now();
  const wallMs = now - prevAt;
  const prof = getQueryProfile({ top: 2000 });
  const q = topDeltas(prof.byTotalMs, prevShapes, r => r.shape, r => r.totalMs, r => r.calls);
  const reqs = typeof getRequestProfile === 'function' ? getRequestProfile() : [];
  const rt = topDeltas(reqs, prevRoutes, r => r.route, r => r.totalMs, r => r.calls);
  const dbMs = [...q.next.values()].reduce((a, v) => a + v.totalMs, 0) - [...prevShapes.values()].reduce((a, v) => a + v.totalMs, 0);
  const dCalls = [...q.next.values()].reduce((a, v) => a + v.calls, 0) - [...prevShapes.values()].reduce((a, v) => a + v.calls, 0);
  prevShapes = q.next; prevRoutes = rt.next; prevAt = now;
  const det = rt.top.find(r => r.key.includes('/acd/setup-detection'));
  const loop = { meanMs: +(loopDelay.mean / 1e6).toFixed(1), p99Ms: +(loopDelay.percentile(99) / 1e6).toFixed(1), maxMs: +(loopDelay.max / 1e6).toFixed(1) };
  loopDelay.reset();

  const extra = {};
  const safe = async (name, fn) => { try { extra[name] = await fn(); } catch (e) { extra[name] = { error: e.message }; } };
  const intervalSql = `${Math.round(wallMs / 1000)} seconds`;
  await safe('outages', async () => (await query(`SELECT COUNT(*)::int n FROM process_log WHERE process_name='SETUP_DETECTION_POLL' AND started_at >= NOW() - $1::interval`, [intervalSql])).rows[0].n);
  await safe('entryDelay', async () => (await query(`
      SELECT COUNT(*)::int n,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (op.submitted_at - a.created_at)))::float p50,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (op.submitted_at - a.created_at)))::float p90
      FROM order_placements op JOIN active_setups a ON a.id = op.setup_id
      WHERE op.purpose='ENTRY' AND op.client_order_id NOT LIKE '%M' AND op.submitted_at >= NOW() - $1::interval`, [intervalSql])).rows[0]);
  await safe('gatedSkips', async () => (await query(`SELECT COUNT(*)::int n FROM gated_candidates WHERE gate_name LIKE 'SIERRA_%' AND evaluated_at >= NOW() - $1::interval`, [intervalSql])).rows[0].n);
  const mem = process.memoryUsage();
  const ml = (() => { try { return getMlScoringStatus(); } catch (_) { return null; } })();
  const ed = extra.entryDelay && !extra.entryDelay.error && extra.entryDelay.n > 0 ? extra.entryDelay : null;

  return {
    wallMs,
    cols: {
      db_time_pct: wallMs > 0 ? +(100 * dbMs / wallMs).toFixed(1) : null,
      query_calls: dCalls,
      detect_calls: det ? det.calls : 0,
      detect_avg_ms: det ? det.avgMs : null,
      detect_max_ms: (reqs.find(r => r.route.includes('/acd/setup-detection')) || {}).maxMs ?? null, // process-lifetime max, informational
      loop_p99_ms: loop.p99Ms,
      poll_outages: typeof extra.outages === 'number' ? extra.outages : null,
      entry_delay_p50_s: ed ? +ed.p50.toFixed(1) : null,
      entry_delay_p90_s: ed ? +ed.p90.toFixed(1) : null,
    },
    detail: {
      topQueryShapes: q.top, topRoutes: rt.top, loop,
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      memMB: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
      killSwitchArmed: !!killSwitch.isArmed(), mlScorerHealthy: ml ? !!ml.healthy : null,
      entriesInInterval: ed ? ed.n : 0, sierraGateRowsInInterval: extra.gatedSkips,
      collectErrors: Object.entries(extra).filter(([, v]) => v && v.error).map(([k, v]) => `${k}: ${v.error}`),
    },
  };
}

async function sinceDeploy() {
  const r = await query(`SELECT deploy_sha, EXTRACT(EPOCH FROM (now() - captured_at))::int AS age_s FROM perf_snapshots WHERE kind='DEPLOY' ORDER BY captured_at DESC LIMIT 1`);
  return r.rows[0] ? { sha: r.rows[0].deploy_sha, minutesAgo: Math.round(r.rows[0].age_s / 60) } : null;
}

async function judge(session, cols) {
  const report = { session, flagged: {}, learning: [] };
  if (session === 'CLOSED') return report;
  for (const m of JUDGED) {
    const hist = (await query(`SELECT ${m} AS v FROM perf_snapshots WHERE kind='SNAPSHOT' AND session=$1 AND ${m} IS NOT NULL AND captured_at >= now() - ($2 || ' days')::interval`, [session, String(HISTORY_DAYS)])).rows.map(r => Number(r.v));
    const j = judgeAgainstHistory(cols[m], hist);
    if (!j) { if (cols[m] != null) report.learning.push(`${m} (${hist.length}/${MIN_HISTORY})`); prevConsecutive[m] = 0; continue; }
    if (j.flagged) { prevConsecutive[m] = (prevConsecutive[m] || 0) + 1; report.flagged[m] = { ...j, consecutive: prevConsecutive[m] }; }
    else prevConsecutive[m] = 0;
  }
  return report;
}

export async function takeSnapshot() {
  const c = await collect();
  const session = etSession();
  const report = await judge(session, c.cols);
  let deploy = null;
  if (Object.keys(report.flagged).length) deploy = await sinceDeploy().catch(() => null);
  if (deploy) report.deploy = deploy;
  await query(`INSERT INTO perf_snapshots (kind, deploy_sha, boot_id, session, interval_s, db_time_pct, query_calls, detect_calls, detect_avg_ms, detect_max_ms, loop_p99_ms, poll_outages, entry_delay_p50_s, entry_delay_p90_s, metrics, regression)
    VALUES ('SNAPSHOT',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [deploySha, bootId, session, Math.round(c.wallMs / 1000), c.cols.db_time_pct, c.cols.query_calls, c.cols.detect_calls, c.cols.detect_avg_ms, c.cols.detect_max_ms, c.cols.loop_p99_ms, c.cols.poll_outages, c.cols.entry_delay_p50_s, c.cols.entry_delay_p90_s, JSON.stringify(c.detail), JSON.stringify(report)]);
  lastReport = report;
  for (const [metric, f] of Object.entries(report.flagged)) {
    if (f.consecutive === INCIDENT_AT) await captureIncident(metric, f, c, session, report.deploy).catch(e => console.error('[perf] incident capture failed:', e.message));
  }
  return { cols: c.cols, report };
}

async function captureIncident(metric, f, c, session, deploy) {
  await query(`INSERT INTO perf_snapshots (kind, deploy_sha, boot_id, session, interval_s, metrics, regression) VALUES ('INCIDENT',$1,$2,$3,$4,$5,$6)`,
    [deploySha, bootId, session, Math.round(c.wallMs / 1000), JSON.stringify(c.detail), JSON.stringify({ metric, ...f, deploy })]);
  const today = (await query(`SELECT CURRENT_DATE::text d`)).rows[0].d;
  const day = today.replace(/-/g, '');
  try {
    const { flagDecision } = await import('../../scripts/flag_decision.mjs');
    await flagDecision({
      slug: `perf_regression_${metric}_${day}`,
      priority: 'MEDIUM',
      sourceFile: 'server/services/perfTelemetry.js',
      sourceDate: today,
      decisionText: `${metric} stayed above its own rolling range for ${INCIDENT_AT} consecutive 5-min snapshots in the ${session} session: value ${f.value} vs median ${f.median.toFixed(1)} / p99 ${f.p99.toFixed(1)} (modified z ${f.z}). Running sha ${deploySha}${deploy ? `; the last deploy marker was ${deploy.sha}, ${deploy.minutesAgo} min before this check` : ''}. Evidence bundle: perf_snapshots kind=INCIDENT, newest row (heaviest query shapes, routes, pool, event loop in that interval). To resolve: find the cause with the bundle, fix it, and confirm the metric is back inside range in later SNAPSHOT rows (node scripts/perf_report.mjs); or, if the new level is the intended cost of a change, resolve with that explanation.`,
    });
  } catch (e) { console.error('[perf] flagDecision failed:', e.message); }
}

// For GET /api/setups/live-flags. null = nothing persistent; otherwise a plain-language banner payload.
export function getPerfAttention() {
  if (!lastReport) return null;
  const items = Object.entries(lastReport.flagged).filter(([, f]) => f.consecutive >= SHOW_AFTER);
  if (!items.length) return null;
  return {
    since: new Date().toISOString(),
    session: lastReport.session,
    deploy: lastReport.deploy || null,
    metrics: items.map(([m, f]) => ({ metric: m, value: f.value, median: +f.median.toFixed(1), p99: +f.p99.toFixed(1), consecutive: f.consecutive })),
  };
}

export function getPerfStatus() { return { deploySha, bootId, lastReport }; }

export async function startPerfTelemetry({ requestProfile } = {}) {
  if (requestProfile) getRequestProfile = requestProfile;
  try {
    await query(`INSERT INTO perf_snapshots (kind, deploy_sha, boot_id, session, metrics) VALUES ('DEPLOY',$1,$2,$3,$4)`, [deploySha, bootId, etSession(), JSON.stringify({ node: process.version, pid: process.pid })]);
    // pick the consecutive counters back up across a restart, so a regression that straddles one is still counted
    const last = (await query(`SELECT regression FROM perf_snapshots WHERE kind='SNAPSHOT' ORDER BY captured_at DESC LIMIT 1`)).rows[0];
    for (const [m, f] of Object.entries(last?.regression?.flagged || {})) prevConsecutive[m] = f.consecutive || 0;
  } catch (e) { console.error('[perf] start failed:', e.message); }
  timer = setInterval(() => { takeSnapshot().catch(e => console.error('[perf] snapshot failed:', e.message)); }, SNAPSHOT_INTERVAL_MS);
  timer.unref?.();
  console.log(`[perf] telemetry on, sha=${deploySha}, snapshot every ${SNAPSHOT_INTERVAL_MS / 60000} min`);
}
