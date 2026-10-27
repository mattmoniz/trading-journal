// Effect of the 2026-10-27 level_prices repair on the unified backtest: the SAME detectors and exits run on the table as it stood before the repair (level_prices_repair_backup_20261027) and after
// (level_prices); dumps from backtest_unified.js with UB_LEVELS_TABLE / UB_DUMP (scratch/ub_before_repair_20261027.json, scratch/ub_after_repair_20261027.json). Also counts the real/shadow/backfill
// active_setups rows that were fired on a repaired date. Read-only.
import fs from 'fs';
import { query } from '../server/db.js';
const A = JSON.parse(fs.readFileSync('scratch/ub_before_repair_20261027.json')), B = JSON.parse(fs.readFileSync('scratch/ub_after_repair_20261027.json')), bad = new Set(JSON.parse(fs.readFileSync('scratch/level_repaired_dates_all_20261027.json')).all);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN), f = (x) => (Number.isNaN(x) ? 'n/a' : (x >= 0 ? '+' : '') + x.toFixed(1));
const types = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort(); let nA = 0, nB = 0, onBadA = 0, onBadB = 0; const rows = [];
for (const t of types) { const a = A[t] || [], b = B[t] || []; nA += a.length; nB += b.length; onBadA += a.filter((x) => bad.has(x.date)).length; onBadB += b.filter((x) => bad.has(x.date)).length;
  const ka = new Set(a.map((x) => x.date + x.direction)), kb = new Set(b.map((x) => x.date + x.direction)); const same = [...ka].filter((k) => kb.has(k)).length;
  rows.push({ t, na: a.length, nb: b.length, ma: mean(a.map((x) => x.pnl)), mb: mean(b.map((x) => x.pnl)), changed: a.length - same + (b.length - same) }); }
console.log(`unified backtest, all ${types.length} setup types: trades before ${nA}, after ${nB}; trades on repaired dates before ${onBadA}, after ${onBadB} (${(100 * onBadB / nB).toFixed(0)}% of all trades after)`);
const big = rows.filter((r) => r.changed > 0 && (Math.abs(r.mb - r.ma) >= 3 || Math.abs(r.nb - r.na) / Math.max(1, r.na) >= 0.05 || r.changed / Math.max(1, r.na) >= 0.1)).sort((x, y) => Math.abs(y.mb - y.ma) - Math.abs(x.mb - x.ma));
console.log(`setup types with a material change (mean pnl +/-3 dollars, or count +/-5 percent, or 10 percent of trades differ): ${big.length} of ${types.length}`);
console.log('type | trades before -> after | mean $/trade before -> after | trades that differ'); for (const r of big.slice(0, 40)) console.log(`${r.t.padEnd(28)} ${String(r.na).padStart(4)} -> ${String(r.nb).padStart(4)} | ${f(r.ma).padStart(7)} -> ${f(r.mb).padStart(7)} | ${r.changed}`);
const fam = rows.filter((r) => /^(PD|PW|PM|3M|PY|CAM|FLOOR|WPP|WR|WS|MPP|MR|MS|M1|M3|2D_POC|5D|10D|PD2)/.test(r.t)); const pa = fam.flatMap((r) => A[r.t] || []), pb = fam.flatMap((r) => B[r.t] || []);
console.log(`\nlevel-derived families pooled (${fam.length} types): trades ${pa.length} -> ${pb.length}, mean $/trade ${f(mean(pa.map((x) => x.pnl)))} -> ${f(mean(pb.map((x) => x.pnl)))}`);
const as = await query(`SELECT origin_status o, COUNT(*)::int n, COUNT(*) FILTER (WHERE setup_type ~ '^(PD|PW|PM|3M|PY|CAM|FLOOR|W|M[0-9PRS]|10D|5D|2D)')::int fam FROM active_setups WHERE trade_date = ANY($1::date[]) AND (is_cluster_primary IS NULL OR is_cluster_primary) GROUP BY 1 ORDER BY 1`, [[...bad]]);
console.log('\nactive_setups primary rows fired on a repaired date (total, of which on a level-derived setup type):', as.rows.map((r) => `${r.o}: ${r.n} (${r.fam})`).join(' | '));
process.exit(0);
