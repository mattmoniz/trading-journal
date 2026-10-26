// Volume profiles (POC / VAH / VAL) built from REAL volume at each 0.25 price, from the tick files (table volume_at_price_daily, built by
// scripts/tick_microstructure/build_vap_daily_20261026.py and loaded by scripts/load_vap_daily.mjs). Sessions: 'all' (whole trade-date session, 18:00 ET
// prior day to 17:00 ET), 'rth' (09:30-16:00 ET), 'globex' (all minus rth: overnight plus the 16:00-17:00 hour). Any period = a sum of days.
//
// Why this exists: the stored period levels (compute_levels.js) spread each 1-minute bar's volume evenly over its high-low, which flips the POC on two-peaked
// profiles (2026-10-26: the current 3-month block gave POC 31,237 by spread vs 29,780 by real volume, and the user's Sierra line says 29,779.75).
// Value area rule: start at the POC; repeatedly compare the volume of the next two prices above with the next two prices below and add the heavier side's next
// price until 70 percent of total volume is enclosed (the convention developingValueService.computeProfile uses, here at tick resolution). Sierra's documentation
// does not state its own expansion rule, so VAH/VAL can differ from Sierra's by a few ticks; POC does not depend on it.
const TICK = 0.25, VA_FRACTION = 0.7;

export function profileFromRows(rows) { // rows: [{ price, vol }]
  const h = new Map(); let tot = 0;
  for (const r of rows) { const k = Math.round(Number(r.price) / TICK); const v = Number(r.vol); if (v > 0) { h.set(k, (h.get(k) || 0) + v); tot += v; } }
  if (!h.size) return null;
  const keys = [...h.keys()].sort((a, b) => a - b), kmax = keys[keys.length - 1], kmin = keys[0], get = (k) => h.get(k) || 0;
  let poc = keys[0]; for (const k of keys) if (get(k) > get(poc)) poc = k;
  let lo = poc, hi = poc, acc = get(poc);
  while (acc < VA_FRACTION * tot && (hi < kmax || lo > kmin)) {
    const up = get(hi + 1) + get(hi + 2), dn = get(lo - 1) + get(lo - 2);
    const goUp = hi < kmax && (lo <= kmin || up >= dn);
    if (goUp) { hi += 1; acc += get(hi); } else { lo -= 1; acc += get(lo); }
  }
  return { poc: poc * TICK, vah: hi * TICK, val: lo * TICK, totalVolume: tot, high: kmax * TICK, low: kmin * TICK };
}

const COL = { all: 'vol_all', rth: 'vol_rth', globex: '(vol_all - vol_rth)' };
// One profile over trade dates startDate..endDate inclusive (strings 'YYYY-MM-DD', trade-date convention: the 18:00 ET evening belongs to the NEXT trade date).
export async function getPeriodProfile(queryFn, { startDate, endDate, session = 'all' }) {
  const col = COL[session]; if (!col) throw new Error('session must be all|rth|globex');
  const r = await queryFn(`SELECT price::float AS price, SUM(${col})::float AS vol FROM volume_at_price_daily WHERE trade_date BETWEEN $1 AND $2 GROUP BY price`, [startDate, endDate]);
  const p = profileFromRows(r.rows); if (!p) return null;
  const d = await queryFn(`SELECT COUNT(*)::int AS n, MIN(trade_date)::text AS first, MAX(trade_date)::text AS last FROM volume_at_price_days WHERE trade_date BETWEEN $1 AND $2`, [startDate, endDate]);
  return { ...p, session, startDate, endDate, daysLoaded: d.rows[0].n, firstDay: d.rows[0].first, lastDay: d.rows[0].last };
}
// One profile per trade date in the range (daily profiles for the chosen session).
export async function getDailyProfiles(queryFn, { startDate, endDate, session = 'all' }) {
  const col = COL[session]; if (!col) throw new Error('session must be all|rth|globex');
  const r = await queryFn(`SELECT trade_date::text AS d, price::float AS price, ${col}::float AS vol FROM volume_at_price_daily WHERE trade_date BETWEEN $1 AND $2 ORDER BY trade_date`, [startDate, endDate]);
  const by = new Map(); for (const x of r.rows) (by.get(x.d) || by.set(x.d, []).get(x.d)).push(x);
  const out = {}; for (const [d, rows] of by) out[d] = profileFromRows(rows); return out;
}
