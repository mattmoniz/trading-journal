// Forward report for PREREG_FLIP_DISAGREE_FORWARD.md: the live tell when the delta flip (approximate) DISAGREES. Read-only. One look per milestone (100 / 200 / 300 DISAGREE fires): do not re-run between milestones.
// Usage: node scripts/report_flip_disagree_forward.mjs [--log-look]   (--log-look records this look in the look ledger BEFORE printing the numbers)
import { query } from '../server/db.js';
import { logLook } from './lib/look_ledger.mjs';
import { mulberry32, hashSeed } from '../server/services/rigorDiagnostics.js';
const FROM = '2026-11-02', BOOT = 2000;
const r = await query(`SELECT t.id, t.trade_date::text d, g.grp, t.net_dollars::float AS net FROM amt_tell_trades t JOIN amt_tell_flip_tags g ON g.tell_trade_id = t.id WHERE t.bar_rule='split' AND t.book='V1' AND t.status='CLOSED' AND t.net_dollars IS NOT NULL AND t.trade_date >= $1`, [FROM]);
const rows = r.rows; const dis = rows.filter(x => x.grp === 'DISAGREE'), rest = rows.filter(x => x.grp !== 'DISAGREE'), days = new Set(dis.map(x => x.d)).size;
const mean = (a) => a.length ? a.reduce((s, x) => s + x.net, 0) / a.length : NaN;
function ci(a, b) {   // day-blocked: resample trading days, pool the rows of the resampled days per group
  const ds = [...new Set(rows.map(x => x.d))], by = (g) => { const m = new Map(); for (const x of g) (m.get(x.d) || m.set(x.d, []).get(x.d)).push(x.net); return m; }, A = by(a), B = by(b), rng = mulberry32(hashSeed('flipdis_fwd')), out = [];
  for (let i = 0; i < BOOT; i++) { let sa = 0, na = 0, sb = 0, nb = 0; for (let k = 0; k < ds.length; k++) { const d = ds[(rng() * ds.length) | 0]; for (const v of A.get(d) || []) { sa += v; na++; } for (const v of B.get(d) || []) { sb += v; nb++; } } if (na && nb) out.push([sa / na, sb / nb]); }
  const q = (f) => { const v = out.map(f).sort((x, y) => x - y); return [v[Math.floor(0.025 * v.length)], v[Math.floor(0.975 * v.length)]]; }; return { a: q(o => o[0]), b: q(o => o[1]), d: q(o => o[0] - o[1]) };
}
console.log(`forward rows (V1 split, closed, tagged, trade_date >= ${FROM}): ${rows.length}; DISAGREE ${dis.length} fires on ${days} distinct days; rest ${rest.length}`);
const floor = dis.length >= 100 && days >= 50;
if (process.argv.includes('--count')) { console.log(floor ? 'MILESTONE REACHED: run `node scripts/report_flip_disagree_forward.mjs --log-look` ONCE (one look per milestone: 100 / 200 / 300 DISAGREE fires)' : 'count only (no outcome is printed before a milestone)'); process.exit(0); }
if (!floor) { console.log(`Milestone not reached (first look at 100 DISAGREE fires on >= 50 days). No numbers are reported before then (one look per milestone).`); process.exit(0); }
if (process.argv.includes('--log-look')) await logLook({ family: 'AMT_TELL_FLIP_DISAGREE_FWD', dataWindow: 'FORWARD_LIVE_FROM_2026-11-02', kind: 'FORWARD', tests: 1, label: `milestone look at ${dis.length} DISAGREE fires`, script: 'scripts/report_flip_disagree_forward.mjs', prereg: 'scripts/amt_vbars/PREREG_FLIP_DISAGREE_FORWARD.md', outcome: 'PENDING', ref: `flipdis_fwd_${Math.floor(dis.length / 100) * 100}` });
const c = ci(dis, rest);
console.log(`DISAGREE mean ${mean(dis).toFixed(2)} CI [${c.a[0].toFixed(2)}, ${c.a[1].toFixed(2)}] | rest mean ${mean(rest).toFixed(2)} CI [${c.b[0].toFixed(2)}, ${c.b[1].toFixed(2)}] | DISAGREE minus rest ${(mean(dis) - mean(rest)).toFixed(2)} CI [${c.d[0].toFixed(2)}, ${c.d[1].toFixed(2)}]`);
console.log(`READING: ${c.a[0] > 0 && c.d[0] > 0 ? 'SUPPORTED (a lead for a user decision, never an automatic change)' : (c.a[1] < 0 || c.d[1] < 0) ? 'CLOSED (CI entirely below zero)' : 'not supported yet; continue to the next milestone'}`);
process.exit(0);
