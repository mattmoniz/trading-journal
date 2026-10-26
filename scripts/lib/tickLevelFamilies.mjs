// The four volume-profile level families of compute_levels.js rebuilt from real tick volume (volume_at_price_daily, RTH column), with the SAME period definitions:
// PD = prior business day with RTH bars; PW = prior Mon-Fri week; PM = prior calendar month; 3M = (date - 3 calendar months) .. (date - 1).
// A family value is returned only when the tick table covers at least 97 percent of the period's RTH trading days. Shared by compare_stored_vs_tick_levels_20261026.mjs and build_tick_level_tables_20261026.mjs.
import { query } from '../../server/db.js';
import { profileFromRows } from '../../server/services/tickVolumeProfile.js';
export const add = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const addMonths = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const weekBounds = (s) => { const d = new Date(s + 'T12:00:00Z'), dow = d.getUTCDay(), back = dow === 0 ? 6 : dow - 1; const mon = add(s, -back); return [mon, add(mon, 4)]; };
const monthBounds = (s) => { const d = new Date(s + 'T12:00:00Z'); return [new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10), new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)]; };
export async function loadTick() {
  const vap = new Map();
  for (const r of (await query(`SELECT trade_date::text d, (price*4)::int k, vol_rth v FROM volume_at_price_daily WHERE vol_rth > 0`)).rows) { let m = vap.get(r.d); if (!m) vap.set(r.d, (m = new Map())); m.set(r.k, r.v); }
  const rthDays = (await query(`SELECT DISTINCT ts::date::text d FROM price_bars_primary WHERE symbol='NQ' AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959 ORDER BY 1`)).rows.map((r) => r.d);
  const profile = (a, b) => {
    const days = rthDays.filter((d) => d >= a && d <= b); if (!days.length) return null; let have = 0; const acc = new Map();
    for (const d of days) { const m = vap.get(d); if (!m) continue; have++; for (const [k, v] of m) acc.set(k, (acc.get(k) || 0) + v); }
    if (have / days.length < 0.97) return null;
    return profileFromRows([...acc].map(([k, v]) => ({ price: k / 4, vol: v })));
  };
  const prior = (d) => { let lo = 0, hi = rthDays.length; while (lo < hi) { const m = (lo + hi) >> 1; if (rthDays[m] < d) lo = m + 1; else hi = m; } return lo ? rthDays[lo - 1] : null; };
  return {
    families: {
      PD: (d) => { const p = prior(d); return p && profile(p, p); },
      PW: (d) => { const [mo, fr] = weekBounds(d); return profile(add(mo, -7), add(fr, -7)); },
      PM: (d) => { const [a, b] = monthBounds(addMonths(d, -1)); return profile(a, b); },
      '3M': (d) => profile(addMonths(d, -3), add(d, -1)),
    },
  };
}
