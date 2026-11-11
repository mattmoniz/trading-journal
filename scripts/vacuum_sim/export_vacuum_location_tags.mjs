// Location tags (Row 33 definitions) for every vacuum onset of the research event set, computed per trade date in memory (docs/VACUUM_LOCATION_EXTENSION_PREREG_20261109.md). Reads level_prices and minute bars only; NO outcome.
// Same level set, causality and distance definitions as scripts/level_confluence_tags.mjs (ONH/ONL causal for events 02:00-17:00 ET, IB only 10:30-16:00 ET, distances in ADR20). Output scratch/vacuum_sim_20261108/vac_location_tags.json
import fs from 'fs';
import { query } from '../../server/db.js';
import { adr20, tsMs, fmtUTC } from '../lib/levelContext.mjs';
const IN = 'scratch/vacuum_sim_20261108/vac_events_for_tags.json', OUT = 'scratch/vacuum_sim_20261108/vac_location_tags.json';
const events = JSON.parse(fs.readFileSync(IN)).filter((e) => !e.skip); const byDate = new Map(); for (const e of events) (byDate.get(e.date) || byDate.set(e.date, []).get(e.date)).push(e);
const STATIC = ['PD_HIGH', 'PD_LOW', 'PD_VAH', 'PD_VAL', 'PW_HIGH', 'PW_LOW', 'IB_HIGH', 'IB_LOW'];
const out = {}; let done = 0, noadr = 0, nolev = 0;
for (const [d, evs] of [...byDate.entries()].sort()) {
  const adr = await adr20(d); if (!Number.isFinite(adr) || adr <= 0) { noadr += evs.length; continue; }
  const lv = Object.fromEntries((await query(`SELECT level_name, price::float p FROM level_prices WHERE trade_date = $1::date AND level_name = ANY($2)`, [d, STATIC])).rows.map((r) => [r.level_name, r.p]));
  if (!STATIC.slice(0, 6).some((n) => lv[n] != null)) { nolev += evs.length; continue; }
  const s0 = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) - 1, 18, 0, 0), s1 = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), 17, 0, 0);
  const bars = (await query(`SELECT to_char(ts,'YYYY-MM-DD HH24:MI:SS') t, high::float h, low::float l, close::float c FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::timestamp AND ts < $2::timestamp ORDER BY ts`, [fmtUTC(s0), fmtUTC(s1)])).rows.map((x) => ({ ms: tsMs(x.t), h: x.h, l: x.l, c: x.c }));
  const pmax = [], pmin = []; let mx = -Infinity, mn = Infinity; for (const b of bars) { mx = Math.max(mx, b.h); mn = Math.min(mn, b.l); pmax.push(mx); pmin.push(mn); }
  const upTo = (ms) => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].ms < ms) lo = m + 1; else hi = m; } return lo; };   // index of the first bar at or after ms
  for (const e of evs) {
    const fMs = tsMs(e.f), m = +e.f.slice(11, 13) * 60 + +e.f.slice(14, 16), px = e.px, dr = e.dir, L = {};
    for (const n of STATIC) if (lv[n] != null) L[n] = lv[n];
    if (m < 630 || m >= 960) { delete L.IB_HIGH; delete L.IB_LOW; }
    if (m >= 120 && m < 1020) { const lim = Math.min(fMs, Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), 9, 30, 0)), i = upTo(lim) - 1; if (i >= 0) { L.ONH = pmax[i]; L.ONL = pmin[i]; } }
    const sd = Object.entries(L).map(([name, price]) => ({ name, price, sgn: (price - px) * dr, dist: Math.abs(price - px) / adr }));
    const ahead = sd.filter((x) => x.sgn > 0).sort((a, b) => a.dist - b.dist)[0] || null, behind = sd.filter((x) => x.sgn <= 0).sort((a, b) => a.dist - b.dist)[0] || null;
    let cross = null; if (behind) { const i1 = upTo(fMs), i0 = upTo(fMs - 30 * 60000); for (let i = i1 - 1; i >= i0; i--) if ((bars[i].c - behind.price) * dr < 0) { cross = (fMs - bars[i].ms) / 60000; break; } }
    out[e.key] = { ahead_name: ahead?.name ?? null, ahead_dist: ahead?.dist ?? null, behind_name: behind?.name ?? null, behind_dist: behind?.dist ?? null, behind_cross_min: cross, adr, n_levels: sd.length };
    done++;
  }
}
fs.writeFileSync(OUT, JSON.stringify(out)); console.log('tagged', done, 'no ADR20', noadr, 'no level rows', nolev, 'events (non-skip)', events.length); process.exit(0);
