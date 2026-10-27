// Integrity audit of stored level_prices against the bars: the stored prior-day / prior-week / prior-month HIGH and LOW (same definitions as compute_levels.js: RTH bars 09:30-15:59; PD = prior business day
// with RTH bars; PW = the Mon-Fri week before D's week; PM = the calendar month before D's month) must equal the real values; and every stored VA/POC must lie inside its own period's range.
// Prints bad dates per family; with --write-list writes scratch/level_bad_dates_20261027.json. Read-only.
import fs from 'fs';
import { query } from '../server/db.js';
const days = new Map(); for (const r of (await query(`SELECT ts::date::text d, MAX(high)::float h, MIN(low)::float l FROM price_bars_primary WHERE symbol='NQ' AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959 GROUP BY 1 ORDER BY 1`)).rows) days.set(r.d, r);
const rth = [...days.keys()].sort();
const add = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const rng = (a, b) => { let h = -Infinity, l = Infinity, n = 0; for (const d of rth) if (d >= a && d <= b) { const x = days.get(d); h = Math.max(h, x.h); l = Math.min(l, x.l); n++; } return n ? { h, l, n } : null; };
const prior = (d) => { let lo = 0, hi = rth.length; while (lo < hi) { const m = (lo + hi) >> 1; if (rth[m] < d) lo = m + 1; else hi = m; } return lo ? rth[lo - 1] : null; };
const wk = (s) => { const d = new Date(s + 'T12:00:00Z'), dow = d.getUTCDay(), back = dow === 0 ? 6 : dow - 1, mon = add(s, -back); return [add(mon, -7), add(mon, -3)]; };
const mo = (s) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); return [new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10), new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)]; };
const st = new Map(); for (const r of (await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE trade_date >= '2023-11-01' AND level_name ~ '^(PD|PW|PM)_(HIGH|LOW|VAH|VAL|POC)$'`)).rows) { let m = st.get(r.d); if (!m) st.set(r.d, (m = {})); m[r.n] = r.p; }
const bad = { PD: [], PW: [], PM: [] }, why = {};
for (const [d, s] of [...st].sort()) {
  const chk = (fam, a, b) => { const x = rng(a, b); if (!x || x.n < 3 && fam !== 'PD') return; const H = s[fam + '_HIGH'], L = s[fam + '_LOW']; let bad1 = false; const rs = [];
    if (H != null && Math.abs(H - x.h) > 0.3) { bad1 = true; rs.push(`HIGH ${H} vs ${x.h}`); } if (L != null && Math.abs(L - x.l) > 0.3) { bad1 = true; rs.push(`LOW ${L} vs ${x.l}`); }
    for (const k of ['VAH', 'VAL', 'POC']) { const v = s[fam + '_' + k]; if (v != null && (v > x.h + 1 || v < x.l - 1)) { bad1 = true; rs.push(`${k} ${v} outside ${x.l}-${x.h}`); } }
    if (bad1) { bad[fam].push(d); why[fam + d] = rs.join('; '); } };
  const p = prior(d); if (p) chk('PD', p, p); const [wa, wb] = wk(d); chk('PW', wa, wb); const [ma, mb] = mo(d); chk('PM', ma, mb);
}
for (const f of Object.keys(bad)) console.log(`${f}: ${bad[f].length} bad dates of ${st.size}`, bad[f].slice(0, 6).map((d) => `${d} (${why[f + d].slice(0, 70)})`).join(' | '));
const all = [...new Set([...bad.PD, ...bad.PW, ...bad.PM])].sort(); console.log('union of bad dates:', all.length, JSON.stringify(all.slice(0, 60)));
if (process.argv.includes('--write-list')) fs.writeFileSync('scratch/level_bad_dates_20261027.json', JSON.stringify({ PD: bad.PD, PW: bad.PW, PM: bad.PM, all, why }));
process.exit(0);
