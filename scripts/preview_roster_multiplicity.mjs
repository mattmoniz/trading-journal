// READ-ONLY preview (changes nothing live): what a Holm family-wise correction across ALL tested setup types would do to the current live roster. Opus review 2026-11-08: the roster rule screens every type nightly at MIN_DAYS = 5
// with a per-type 95 percent bound and no multiplicity correction. Same population and collapse as scripts/calibrate_live_roster.mjs; one-sided day-block bootstrap p for 'mean pnl > 0'.
// Usage: node scripts/preview_roster_multiplicity.mjs [alpha=0.10]
import { query } from '../server/db.js';
import { logLook } from './lib/look_ledger.mjs';
import { collapseClusterSiblings } from '../server/services/rigorDiagnostics.js';
import { MIN_DAYS } from './calibrate_live_roster.mjs';
const alpha = Number(process.argv[2] || 0.10), NB = 4000; let seed = 20261108; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
await logLook({ family: 'roster_multiplicity_preview_20261108', dataWindow: 'explore_2026-07-09_to_today', kind: 'EXPLORE', tests: 0, ref: `roster_multiplicity_preview_${new Date().toISOString().slice(0, 10)}`, label: 'Read-only preview: Holm-corrected roster vs the current uncorrected roster rule (no live change)', script: 'scripts/preview_roster_multiplicity.mjs' });
const rows = (await query(`SELECT setup_type t, trade_date::text d, cluster_touch_id cl, actual_pnl::float p FROM active_setups WHERE origin_status IN ('ACTIVE','SHADOW') AND trade_date >= '2026-07-09' AND actual_pnl IS NOT NULL AND resolution IS DISTINCT FROM 'NOT_FILLED' AND ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE AND stale_levels_basis IS NOT TRUE AND NOT (fired_at::time >= '16:00' AND fired_at::time < '18:00') AND setup_type NOT LIKE 'POC_ROTATION_JOIN%'`)).rows;
const by = new Map(); for (const r of rows) (by.get(r.t) || by.set(r.t, []).get(r.t)).push(r);
const res = [];
for (const [t, rs] of by) {
  const ev = collapseClusterSiblings(rs.map((r) => ({ date: r.d, pnl: r.p, cluster_touch_id: r.cl }))); const days = new Map(); for (const e of ev) { if (!days.has(e.date)) days.set(e.date, []); days.get(e.date).push(e.pnl); }
  const g = [...days.values()]; if (g.length < MIN_DAYS) continue;
  const mean = ev.reduce((s, e) => s + e.pnl, 0) / ev.length; let le = 0;
  for (let b = 0; b < NB; b++) { let s = 0, n = 0; for (let i = 0; i < g.length; i++) { const x = g[Math.floor(rnd() * g.length)]; for (const v of x) { s += v; n++; } } if (s / n <= 0) le++; }
  res.push({ t, n: ev.length, days: g.length, mean, p: (le + 1) / (NB + 1) });
}
res.sort((a, b) => a.p - b.p); const m = res.length; let stop = false;
res.forEach((r, i) => { r.holm = alpha / (m - i); if (!stop && r.p <= r.holm) r.pass = true; else stop = true; });
const roster = (await query(`SELECT notes FROM performance_audit WHERE signal_type='LIVE_ROSTER' AND signal_name='CURRENT' ORDER BY run_date DESC, id DESC LIMIT 1`)).rows[0]; const n = typeof roster.notes === 'string' ? JSON.parse(roster.notes) : roster.notes; const cur = new Set(n.roster.map((x) => x.type));
console.log(`${m} types with at least ${MIN_DAYS} days; Holm family-wise alpha ${alpha}; the smallest p can be ${(1 / (NB + 1)).toExponential(1)}; current roster (${cur.size}): ${[...cur].join(', ')}`);
console.log('type'.padEnd(40), 'N'.padStart(4), 'days'.padStart(4), 'mean'.padStart(8), 'boot p'.padStart(8), 'Holm thr'.padStart(9), 'Holm pass', 'on roster');
for (const r of res.filter((x) => cur.has(x.t) || x.pass || res.indexOf(x) < 8)) console.log(r.t.padEnd(40), String(r.n).padStart(4), String(r.days).padStart(4), r.mean.toFixed(1).padStart(8), r.p.toFixed(4).padStart(8), r.holm.toExponential(1).padStart(9), String(!!r.pass).padEnd(9), cur.has(r.t));
console.log(`\nHolm-passing types: ${res.filter((r) => r.pass).length} of ${m}; of the ${cur.size} on the roster, ${res.filter((r) => r.pass && cur.has(r.t)).length} would survive. Expected false promotions with NO correction at a per-type one-sided p<0.025 across ${m} types: about ${(m * 0.025).toFixed(1)} even if every type were null.`);
process.exit(0);
