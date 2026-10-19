#!/usr/bin/env node
// Weekly data-growth check (2026-10-19, run from run_weekly_backtests.sh). The post-deploy watch (server/services/perfTelemetry.js) can only see a change's
// immediate effect; this is the slow-cadence counterpart for things that get slower because the DATA grew. It needs no one to watch it: it records, judges,
// and only speaks (one plain-English OPEN_DECISION per finding per month) when something needs a human.
//   1. RECORD   table_growth: size, rows and read counters of every table in the biggest 90% of the database, plus row counts per performance_audit
//               signal_type (that table is append-only and the usual culprit).
//   2. JUDGE    vs each table's OWN earlier weekly records (same median/MAD + p99 + modified-z test as the rest of the system, minimum 4 weeks):
//               growth in rows, and growth in rows read by full scans per day. Until 4 weeks exist it says "learning" -- except two checks that need no history:
//   3. UNUSED   a big non-backup table nothing has read since the previous record (or, on the first record, ever since statistics began) -> candidate to drop.
//   4. QUERIES  the server's own 5-min snapshots (perf_snapshots) hold the heaviest query shapes with their average time; each shape's weekly average is
//               judged against its own earlier weeks, so a query creeping up as tables grow is named even though no change caused it.
// "Big" is data-derived (the tables that together hold 90% of the bytes), not a fixed MB figure.
import { query } from '../server/db.js';
import { judgeAgainstHistory } from '../server/services/perfTelemetry.js';
import { flagDecision } from './flag_decision.mjs';
const MIN_WEEKS = 4;
const today = (await query(`SELECT CURRENT_DATE::text d`)).rows[0].d;
const month = today.slice(0, 7).replace('-', '');
const findings = [];
// Big tables that are deliberately unread right now. Every entry needs the reason; it is printed on every run so it can't go stale unnoticed.
const EXPECTED_UNREAD = {
  price_bars_dedup_hist_v2: 'prepared replacement for the price-bar historical store, refreshed nightly, waiting for scripts/cutover_price_bars_failsoft_join_20260915.mjs (OPEN_DECISION contract_calendar_failsoft_join_20260915)',
};
for (const [t, why] of Object.entries(EXPECTED_UNREAD)) console.log(`expected-unread: ${t} -- ${why}`);

// 1. RECORD
const tabs = (await query(`
  SELECT c.relname, pg_total_relation_size(c.oid)::float/1048576 AS mb, c.reltuples::bigint AS est_rows,
         COALESCE(s.seq_scan,0) seq_scan, COALESCE(s.seq_tup_read,0) seq_tup_read, COALESCE(s.idx_scan,0) idx_scan, COALESCE(s.n_dead_tup,0) n_dead_tup
  FROM pg_class c LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','m') AND NOT c.relispartition ORDER BY 2 DESC`)).rows;
const total = tabs.reduce((a, t) => a + t.mb, 0);
let cum = 0; const big = [];
for (const t of tabs) { if (cum / total >= 0.9) break; big.push(t); cum += t.mb; }
const perType = (await query(`SELECT signal_type AS relname, count(*)::bigint AS n FROM performance_audit GROUP BY 1 HAVING count(*) > 0`)).rows;
const prevStamp = (await query(`SELECT max(captured_at) m FROM table_growth WHERE captured_at < now() - interval '3 days'`)).rows[0].m; // compare reads only against a record at least 3 days old
for (const t of big) await query(`INSERT INTO table_growth (relname, mb, est_rows, seq_scan, seq_tup_read, idx_scan, n_dead_tup) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [t.relname, t.mb, t.est_rows, t.seq_scan, t.seq_tup_read, t.idx_scan, t.n_dead_tup]);
for (const p of perType) await query(`INSERT INTO table_growth (relname, est_rows) VALUES ($1,$2)`, [`performance_audit:${p.relname}`.slice(0, 100), p.n]);
console.log(`recorded ${big.length} big tables (of ${tabs.length}, ${total.toFixed(0)} MB total) and ${perType.length} performance_audit signal types`);

// 2. JUDGE growth against own history
async function history(rel) { return (await query(`SELECT captured_at, mb::float, est_rows::float, seq_tup_read::float FROM table_growth WHERE relname=$1 ORDER BY captured_at`, [rel])).rows; }
function weeklyDeltas(rows, f) { const out = []; for (let i = 1; i < rows.length; i++) { const days = (rows[i].captured_at - rows[i - 1].captured_at) / 86400000; if (days >= 3) out.push((f(rows[i]) - f(rows[i - 1])) / days); } return out; }
const learning = [];
for (const rel of [...big.map(t => t.relname), ...perType.map(p => `performance_audit:${p.relname}`.slice(0, 100))]) {
  const h = await history(rel);
  for (const [label, f] of [['rows per day', r => r.est_rows], ['full-scan rows read per day', r => r.seq_tup_read]]) {
    if (label.startsWith('full') && rel.includes(':')) continue;
    const d = weeklyDeltas(h, f);
    if (d.length < MIN_WEEKS + 1) { learning.push(`${rel} ${label}`); continue; }
    const j = judgeAgainstHistory(d[d.length - 1], d.slice(0, -1), MIN_WEEKS);
    if (j?.flagged && j.value > 0) findings.push({ slug: `growth_${rel.replace(/\W+/g, '_')}_${label.startsWith('rows') ? 'rows' : 'scans'}_${month}`.slice(0, 80), priority: 'LOW',
      text: `${rel}: ${label} is ${Math.round(j.value).toLocaleString()} this week against a usual ${Math.round(j.median).toLocaleString()} (its own previous weeks). A table that grows or is scanned faster than it used to makes every query on it slower. Check what writes to or reads it, then either prune/bound it, add an index, or accept it and say why.` });
  }
}

// 3. UNUSED big tables (no history needed)
if (prevStamp) {
  const prev = new Map((await query(`SELECT DISTINCT ON (relname) relname, seq_scan::float + idx_scan::float AS reads FROM table_growth WHERE captured_at < $1 ORDER BY relname, captured_at DESC`, [prevStamp])).rows.map(r => [r.relname, r.reads]));
  for (const t of big) if (!/_backup_|^trades_backup/.test(t.relname) && !EXPECTED_UNREAD[t.relname] && prev.has(t.relname) && prev.get(t.relname) === Number(t.seq_scan) + Number(t.idx_scan))
    findings.push({ slug: `unused_${t.relname}_${month}`.slice(0, 80), priority: 'LOW', text: `${t.relname} (${t.mb.toFixed(0)} MB) has not been read at all since the previous weekly check. If nothing needs it, dropping it (after a backup, per docs/DB_MIGRATION_PROTOCOL.md) frees space and removes it from backups.` });
} else {
  for (const t of big) if (!/_backup_|^trades_backup/.test(t.relname) && !EXPECTED_UNREAD[t.relname] && Number(t.seq_scan) + Number(t.idx_scan) === 0)
    findings.push({ slug: `unused_${t.relname}_${month}`.slice(0, 80), priority: 'LOW', text: `${t.relname} (${t.mb.toFixed(0)} MB) shows zero reads since database statistics began. Check the code for a reader (grep the name); if there is none it can be dropped after a backup (docs/DB_MIGRATION_PROTOCOL.md).` });
}

// 4. QUERY SHAPES creeping up over weeks (from the server's own snapshots)
const snaps = (await query(`SELECT date_trunc('week', captured_at)::date AS wk, metrics->'topQueryShapes' AS shapes FROM perf_snapshots WHERE kind='SNAPSHOT' AND captured_at >= now() - interval '12 weeks' AND metrics ? 'topQueryShapes'`)).rows;
const byShape = new Map();
for (const s of snaps) for (const q of (s.shapes || [])) {
  const e = byShape.get(q.key) || new Map(); const w = e.get(String(s.wk)) || { ms: 0, calls: 0 };
  w.ms += q.totalMs; w.calls += q.calls; e.set(String(s.wk), w); byShape.set(q.key, e);
}
for (const [shape, weeks] of byShape) {
  const ordered = [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, w]) => w).filter(w => w.calls >= 50).map(w => w.ms / w.calls);
  if (ordered.length < MIN_WEEKS + 1) continue;
  const j = judgeAgainstHistory(ordered[ordered.length - 1], ordered.slice(0, -1), MIN_WEEKS);
  if (j?.flagged) findings.push({ slug: `slowing_query_${Buffer.from(shape).toString('base64').replace(/\W/g, '').slice(0, 24)}_${month}`, priority: 'MEDIUM',
    text: `A query got slower week over week without any single change: average ${j.value.toFixed(0)} ms this week vs a usual ${j.median.toFixed(0)} ms. Query: ${shape}. Likely cause: the table it reads grew. Fix: bound its date range, cache it for the day, or add an index; test with scripts/explain_check.mjs.` });
}
console.log(`${findings.length} finding(s); still learning (needs ${MIN_WEEKS}+ weekly records): ${learning.length} measures`);
for (const f of findings) { await flagDecision({ slug: f.slug, priority: f.priority, sourceFile: 'scripts/data_growth_check.mjs', sourceDate: today, decisionText: f.text }); console.log(` flagged ${f.slug}: ${f.text.slice(0, 140)}`); }
process.exit(0);
