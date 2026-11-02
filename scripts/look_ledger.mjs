// CLI for the look ledger.  node scripts/look_ledger.mjs --report | --family F | --check-sealed FAMILY WINDOW (exit 0 = available, 3 = spent) | --spend-sealed FAMILY WINDOW "label"
import { query } from '../server/db.js';
import { sealedSpent, spendSealedLook } from './lib/look_ledger.mjs';
const a = process.argv.slice(2);
if (a[0] === '--check-sealed') { const s = await sealedSpent(a[1], a[2]); console.log(s ? 'SPENT' : 'AVAILABLE'); process.exit(s ? 3 : 0); }
if (a[0] === '--spend-sealed') { try { const id = await spendSealedLook({ family: a[1], dataWindow: a[2], label: a[3] || 'sealed look', script: process.env.LOOK_SCRIPT || null }); console.log('sealed look recorded, id', id); process.exit(0); } catch (e) { console.error(e.message); process.exit(3); } }
const fam = a[0] === '--family' ? a[1] : null;
const r = await query(`SELECT family, data_window, window_kind, COUNT(*)::int AS looks, SUM(tests)::int AS tests, MIN(logged_at)::date::text AS first, MAX(logged_at)::date::text AS last FROM research_looks WHERE ($1::text IS NULL OR family=$1) GROUP BY 1,2,3 ORDER BY 1,2,3`, [fam]);
console.log('family | window | kind | looks | tests | first..last'); for (const x of r.rows) console.log(`${x.family} | ${x.data_window} | ${x.window_kind} | ${x.looks} | ${x.tests} | ${x.first}..${x.last}`);
const t = await query(`SELECT COUNT(*)::int AS looks, COALESCE(SUM(tests),0)::int AS tests FROM research_looks WHERE ($1::text IS NULL OR family=$1)`, [fam]); console.log(`TOTAL looks ${t.rows[0].looks}, tests ${t.rows[0].tests}`);
process.exit(0);
