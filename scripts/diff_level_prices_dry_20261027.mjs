// Compares stored level_prices with a fresh recomputation by the PRODUCTION code (scripts/compute_levels.js <date> --dry, saved per date in scratch/level_dry/) for every level type.
// Output: per level name: dates compared, dates differing (|diff| > tolerance), median/p90/max absolute difference; levels stored but not recomputed and the reverse; the dates with the most differences.
// Read-only. Differences are not automatically errors: levels computed intraday (same-day-forming OR/IB, VWAPs) or under an older definition legitimately differ from a full-day recomputation; the report groups by level so each family can be judged.
import fs from 'fs';
import { query } from '../server/db.js';
const dir = 'scratch/level_dry', files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
const stored = new Map(); for (const r of (await query(`SELECT trade_date::text d, level_name n, price::float p, category c FROM level_prices WHERE trade_date >= '2023-11-01'`)).rows) { let m = stored.get(r.d); if (!m) stored.set(r.d, (m = new Map())); m.set(r.n, { p: r.p, c: r.c }); }
const stat = {}, perDate = {}; let datesDone = 0, notDry = 0;
const tol = (n) => (/VWAP/.test(n) ? 0.5 : 0.01);
for (const f of files) {
  const d = f.slice(0, 10), txt = fs.readFileSync(`${dir}/${f}`, 'utf8'); if (!txt.includes('DRY RUN')) { notDry++; continue; }
  const rec = new Map(); for (const line of txt.split('\n')) { const m = line.match(/^\s{2}(\S+)\s+(-?[\d.]+)\s+\[(\w+)\]/); if (m) rec.set(m[1], { p: +m[2], c: m[3] }); }
  const st = stored.get(d); if (!st) continue; datesDone++;
  const names = new Set([...rec.keys(), ...st.keys()]);
  for (const n of names) { const s = (stat[n] ||= { cmp: 0, diff: 0, abs: [], onlyStored: 0, onlyRec: 0, cat: (rec.get(n) || st.get(n)).c });
    const a = st.get(n), b = rec.get(n); if (a && !b) { s.onlyStored++; continue; } if (!a && b) { s.onlyRec++; continue; }
    s.cmp++; const dd = Math.abs(a.p - b.p); if (dd > tol(n)) { s.diff++; s.abs.push(dd); (perDate[d] ||= []).push(n); } }
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
console.log(`dates compared ${datesDone} (files not finished/dry: ${notDry})`);
console.log('level name | category | compared | differing | share | median abs diff | p90 | max | stored-only | recomputed-only');
const rows = Object.entries(stat).sort((a, b) => b[1].diff / Math.max(1, b[1].cmp) - a[1].diff / Math.max(1, a[1].cmp));
for (const [n, s] of rows) console.log(`${n.padEnd(14)} ${String(s.cat).padEnd(13)} ${String(s.cmp).padStart(4)} ${String(s.diff).padStart(4)} ${(100 * s.diff / Math.max(1, s.cmp)).toFixed(0).padStart(3)}%  med ${q(s.abs, 0.5).toFixed(2).padStart(8)}  p90 ${q(s.abs, 0.9).toFixed(2).padStart(8)}  max ${Math.max(0, ...s.abs).toFixed(1).padStart(8)}  stored-only ${s.onlyStored}  recomputed-only ${s.onlyRec}`);
const worst = Object.entries(perDate).sort((a, b) => b[1].length - a[1].length).slice(0, 15); console.log('\nDates with the most differing levels:', worst.map(([d, v]) => `${d} (${v.length})`).join(', '));
const byCat = {}; for (const [n, s] of rows) { const c = (byCat[s.cat] ||= { cmp: 0, diff: 0 }); c.cmp += s.cmp; c.diff += s.diff; } console.log('\nBy category:', Object.entries(byCat).map(([c, v]) => `${c} ${v.diff}/${v.cmp} (${(100 * v.diff / Math.max(1, v.cmp)).toFixed(0)}%)`).join(' | '));
fs.writeFileSync('scratch/level_diff_20261027.json', JSON.stringify({ perDate, rows: rows.map(([n, s]) => [n, s.cat, s.cmp, s.diff, s.onlyStored, s.onlyRec]) }));
process.exit(0);
