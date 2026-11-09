// Exporter for docs/OVN_ORDERFLOW_VARIATIONS_PREREG_20261104.md: per trade date, the pre-midnight summary of the overnight session (18:00 previous day to 23:59: open, high, low, last close, the 18:00-21:00 ask / bid volume, confirmed R=65 rotation legs by midnight with the real detector)
// (plus legs_close = the LIVE detector's definition: legs counted on the 1-minute CLOSES only, and c00 = the 00:00 bar close; plus the leg counts for a grid of reversal sizes 20..200, for the scaled-threshold variant) and the 1-minute open / high / low / close PATH from 00:00 to 15:59 ET (minute m since 00:00; 09:30 = 570, 14:30 = 870). Output scratch/ovn_orderflow_20261104/days.json
import fs from 'fs';
import path from 'path';
import { query } from '../../../server/db.js';
import { detectRotationLegs } from '../../../server/services/rotationDetector.js';
const repo = path.resolve(new URL('.', import.meta.url).pathname, '..', '..', '..'); const out = path.join(repo, 'scratch', 'ovn_orderflow_20261104'); fs.mkdirSync(out, { recursive: true });
const addDays = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const F = JSON.parse(fs.readFileSync(path.join(repo, 'scratch', 'tell_context_20261103', 'b_d_formation_rows.json'), 'utf8'));
const hold = fs.readdirSync(path.join(repo, 'scratch', 'volbars500_holdout_20261103')).filter(f => f.endsWith('.bars.tsv')).map(f => f.slice(0, 10));
const dates = [...new Set([...Object.keys(F), ...hold])].sort(); for (const d of ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03']) if (!dates.includes(d)) dates.push(d);
const GRID = []; for (let r = 20; r <= 200; r += 10) GRID.push(r);
const res = {}; const CH = 40;
for (let i = 0; i < dates.length; i += CH) {
  const ch = dates.slice(i, i + CH); const lo = addDays(ch[0], -1) + ' 17:59:00', hi = ch[ch.length - 1] + ' 16:00:00';
  const r = await query(`SELECT (ts + interval '6 hours')::date::text AS d, (EXTRACT(hour FROM ts)::int * 60 + EXTRACT(minute FROM ts)::int) AS hm, EXTRACT(hour FROM ts)::int AS h, open::float AS o, high::float AS hh, low::float AS l, close::float AS c, COALESCE(ask_volume,0)::float AS av, COALESCE(bid_volume,0)::float AS bv
    FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::timestamp AND ts < $2::timestamp AND (EXTRACT(hour FROM ts) >= 18 OR EXTRACT(hour FROM ts) < 16) ORDER BY ts`, [lo, hi]);
  const by = new Map(ch.map(d => [d, []])); for (const x of r.rows) { const b = by.get(x.d); if (b) b.push(x); }
  for (const d of ch) {
    const bars = by.get(d); const pre = bars.filter(x => x.h >= 18), post = bars.filter(x => x.h < 16); if (pre.length < 300 || post.length < 800) continue;
    const flow = pre.filter(x => x.hm < 21 * 60); const legs = detectRotationLegs(pre.map(x => ({ high: x.hh, low: x.l })), 65);
    res[d] = { open18: pre[0].o, hi_pre: Math.max(...pre.map(x => x.hh)), lo_pre: Math.min(...pre.map(x => x.l)), c_pre: pre[pre.length - 1].c, ask: flow.reduce((s, x) => s + x.av, 0), bid: flow.reduce((s, x) => s + x.bv, 0), legs: legs.length, legs_close: detectRotationLegs(pre.map(x => ({ high: x.c, low: x.c })), 65).length, c00: post.length ? post[0].c : null, legs_grid: Object.fromEntries(GRID.map(R => [R, detectRotationLegs(pre.map(x => ({ high: x.hh, low: x.l })), R).length])), n_pre: pre.length,
      m: post.map(x => x.hm), o: post.map(x => x.o), h: post.map(x => x.hh), l: post.map(x => x.l), c: post.map(x => x.c) };
  }
}
fs.writeFileSync(path.join(out, 'days.json'), JSON.stringify(res)); const ds = Object.keys(res); console.log(ds.length, 'dates', ds[0], ds[ds.length - 1], '; with >= 6 legs by midnight:', ds.filter(d => res[d].legs >= 6).length); process.exit(0);
