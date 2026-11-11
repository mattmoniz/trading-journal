// Shared time / ADR20 / overnight helpers for the level-context scripts (capitulation_exit_shadow.mjs, level_confluence_tags.mjs). Extracted 2026-11-09 night from the logger (cv-079); behaviour unchanged.
// Naive ET timestamps are handled by arithmetic only (cv-074); both ts bounds on every price_bars_primary query (cv-009).
import { query } from '../../server/db.js';
export const fmtUTC = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');        // naive ET strings by arithmetic only (cv-074)
export const tsMs = (s) => { const t = s.slice(0, 19); return Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 1, +t.slice(8, 10), +t.slice(11, 13), +t.slice(14, 16), +t.slice(17, 19) || 0); };
const adrCache = new Map();
export async function adr20(tradeDate) {                              // 20 latest RTH sessions strictly before the trade date; both ts bounds on the view (cv-009)
  if (adrCache.has(tradeDate)) return adrCache.get(tradeDate);
  const r = await query(`SELECT d, h - l AS rng FROM (SELECT ts::date d, max(high) h, min(low) l FROM price_bars_primary WHERE symbol='NQ' AND ts >= ($1::date - 50) AND ts < $1::date
    AND ts::time >= '09:30' AND ts::time < '16:00' GROUP BY 1) q ORDER BY d DESC LIMIT 20`, [tradeDate]);
  const v = r.rows.length >= 15 ? r.rows.reduce((s, x) => s + Number(x.rng), 0) / r.rows.length : NaN; adrCache.set(tradeDate, v); return v;
}

export const sessionStartMs = (tradeDate) => { const [y, m, d] = tradeDate.split('-').map(Number); return Date.UTC(y, m - 1, d - 1, 18, 0, 0); };

/** Overnight high/low of the session up to min(fire, 09:30 ET of the trade date), from minute bars. */
export async function overnightExtremes(tradeDate, fireMs) {
  const lim = Math.min(fireMs, Date.UTC(+tradeDate.slice(0, 4), +tradeDate.slice(5, 7) - 1, +tradeDate.slice(8, 10), 9, 30, 0));
  const r = await query(`SELECT max(high)::float h, min(low)::float l FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::timestamp AND ts < $2::timestamp`, [fmtUTC(sessionStartMs(tradeDate)), fmtUTC(lim)]);
  return r.rows[0]?.h != null ? { ONH: r.rows[0].h, ONL: r.rows[0].l } : null;
}
