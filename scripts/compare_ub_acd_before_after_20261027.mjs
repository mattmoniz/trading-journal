// Effect of the 2026-10-27 acd_daily_log repair on the unified backtest: same code, same (repaired) level_prices, only the ACD table differs: original (acd_daily_log_repair_backup_20261027) vs repaired (acd_daily_log).
// Dumps from backtest_unified.js with UB_ACD_TABLE / UB_DUMP. Read-only.
import fs from 'fs';
const A = JSON.parse(fs.readFileSync('scratch/ub_acd_old_20261027.json')), B = JSON.parse(fs.readFileSync('scratch/ub_acd_new_20261027.json')), rep = new Set(JSON.parse(fs.readFileSync('scratch/acd_or_repaired_dates_20261027.json')));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN), f = (x) => (Number.isNaN(x) ? 'n/a' : (x >= 0 ? '+' : '') + x.toFixed(1));
const types = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort(); let nA = 0, nB = 0, oA = 0, oB = 0; const rows = [];
for (const t of types) { const a = A[t] || [], b = B[t] || []; nA += a.length; nB += b.length; oA += a.filter((x) => rep.has(x.date)).length; oB += b.filter((x) => rep.has(x.date)).length;
  const ka = new Set(a.map((x) => x.date + x.direction + x.pnl)), kb = new Set(b.map((x) => x.date + x.direction + x.pnl)); const same = [...ka].filter((k) => kb.has(k)).length;
  rows.push({ t, na: a.length, nb: b.length, ma: mean(a.map((x) => x.pnl)), mb: mean(b.map((x) => x.pnl)), changed: a.length - same + (b.length - same), offrep: [...a, ...b].filter((x) => !rep.has(x.date)).length }); }
const diff = rows.filter((r) => r.changed > 0);
console.log(`types ${types.length}; trades old ${nA}, new ${nB}; trades on the 51 repaired dates old ${oA}, new ${oB}; types with any changed trade: ${diff.length}`);
console.log('type | trades old -> new | mean $/trade old -> new | trades that differ'); for (const r of diff.sort((x, y) => y.changed - x.changed).slice(0, 30)) console.log(`${r.t.padEnd(30)} ${String(r.na).padStart(4)} -> ${String(r.nb).padStart(4)} | ${f(r.ma).padStart(7)} -> ${f(r.mb).padStart(7)} | ${r.changed}`);
// changes outside the 51 dates (nl30 rolling score reaches 30 days forward, so some are expected within ~30 trading days after a repaired date)
const out = []; for (const t of types) { const a = (A[t] || []).filter((x) => !rep.has(x.date)).map((x) => x.date + x.direction + x.pnl), b = new Set((B[t] || []).filter((x) => !rep.has(x.date)).map((x) => x.date + x.direction + x.pnl)); const n = a.filter((k) => !b.has(k)).length; if (n) out.push(`${t}:${n}`); }
console.log('\ntrades that differ on dates OUTSIDE the 51 (spillover through the rolling 30-day NL30 score):', out.length ? out.slice(0, 20).join(' ') : 'none');
const pa = types.flatMap((t) => A[t] || []), pb = types.flatMap((t) => B[t] || []); console.log(`pooled mean $/trade old ${f(mean(pa.map((x) => x.pnl)))} (n=${pa.length}) -> new ${f(mean(pb.map((x) => x.pnl)))} (n=${pb.length})`);
process.exit(0);
