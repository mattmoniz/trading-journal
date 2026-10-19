#!/usr/bin/env node
// Per-deploy performance report from perf_snapshots (server/services/perfTelemetry.js). For each session bucket, groups SNAPSHOT rows by the
// git sha that was running and prints each metric's median + p90, then the change from the previous sha with enough data. A "before/after" for any
// change is therefore automatic: run `node scripts/perf_report.mjs` a few hours after deploying. Also lists open INCIDENT bundles.
//   node scripts/perf_report.mjs [days=14] [--incidents]
// Informational. A sha needs MIN_SNAPSHOTS snapshots in a session bucket to be compared (else shown as "thin"). The comparison is descriptive,
// not a significance test -- use it to decide where to look, then confirm with the incident bundle / query profile.
import { query } from '../server/db.js';
const days = Number(process.argv.find(a => /^\d+$/.test(a))) || 14;
const MIN_SNAPSHOTS = 12; // one hour of 5-min snapshots
const METRICS = ['db_time_pct', 'detect_avg_ms', 'loop_p99_ms', 'poll_outages', 'entry_delay_p50_s', 'entry_delay_p90_s'];
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const q90 = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(0.9 * s.length))]; };
const f = (x) => x == null ? '   n/a' : Number(x).toFixed(1).padStart(6);

const rows = (await query(`SELECT deploy_sha, session, captured_at, ${METRICS.join(',')} FROM perf_snapshots WHERE kind='SNAPSHOT' AND session <> 'CLOSED' AND captured_at >= now() - ($1 || ' days')::interval ORDER BY captured_at`, [String(days)])).rows;
const deploys = (await query(`SELECT deploy_sha, MIN(captured_at) first FROM perf_snapshots WHERE kind='DEPLOY' AND captured_at >= now() - ($1 || ' days')::interval GROUP BY deploy_sha ORDER BY first`, [String(days)])).rows;
console.log(`perf_snapshots: ${rows.length} snapshots, ${deploys.length} deploys in last ${days} days`);
for (const session of ['RTH', 'GLOBEX', 'GAP']) {
  const bySha = new Map();
  for (const r of rows.filter(r => r.session === session)) { if (!bySha.has(r.deploy_sha)) bySha.set(r.deploy_sha, []); bySha.get(r.deploy_sha).push(r); }
  if (!bySha.size) continue;
  console.log(`\n== ${session} == (median / p90 per metric)`);
  console.log('sha            n   ' + METRICS.map(m => m.padEnd(26)).join(''));
  let prev = null;
  for (const [sha, rs] of bySha) {
    const thin = rs.length < MIN_SNAPSHOTS;
    const line = METRICS.map(m => { const v = rs.map(r => r[m]).filter(v => v != null).map(Number); return `${f(med(v))} /${f(q90(v))}`.padEnd(26); }).join('');
    console.log(`${sha.padEnd(13)} ${String(rs.length).padStart(3)}  ${line}${thin ? ' [thin]' : ''}`);
    if (!thin) {
      if (prev) {
        const ch = METRICS.map(m => { const a = med(prev.rs.map(r => r[m]).filter(v => v != null).map(Number)), b = med(rs.map(r => r[m]).filter(v => v != null).map(Number)); return a != null && b != null && a !== b ? `${m} ${a.toFixed(1)}->${b.toFixed(1)}` : null; }).filter(Boolean);
        if (ch.length) console.log(`   vs ${prev.sha}: ${ch.join(', ')}`);
      }
      prev = { sha, rs };
    }
  }
}
const inc = (await query(`SELECT captured_at::text at, session, deploy_sha, regression FROM perf_snapshots WHERE kind='INCIDENT' AND captured_at >= now() - ($1 || ' days')::interval ORDER BY captured_at DESC LIMIT 10`, [String(days)])).rows;
console.log(`\nincident bundles in window: ${inc.length}`);
for (const i of inc) console.log(`  ${i.at} ${i.session} sha=${i.deploy_sha} ${i.regression?.metric} value=${i.regression?.value} median=${Number(i.regression?.median).toFixed(1)}`);
process.exit(0);
