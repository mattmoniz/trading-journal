// User point 2026-10-26: the overnight order-flow SHORT fired 60-95 points above a visible floor ("very obviously should have been a long"). The detector reads no price levels.
// Descriptive check on the calibration population (54-56 nights): for each trade, distance (in A15) to the nearest STORED level in the trade direction (a short: the nearest level below
// entry; a long: the nearest above), from level_prices PD/PW/PM/3M/PY value-area edges and POC and PD high/low. "Blocked" = within 1 A15. One split, pre-stated; N is thin.
import { query } from '../server/db.js';
import { loadBars, prep, mean } from './lib/floorEngine.mjs';
import { fetchTrades } from './calibrate_overnight_orderflow_entry.mjs';
const { trades } = await fetchTrades();
const NQ = prep(await loadBars('price_bars_primary', `symbol='NQ'`, '2025-10-01', (await query(`SELECT (CURRENT_DATE - 1)::text d`)).rows[0].d));
const lv = (await query(`SELECT trade_date::text d, level_name n, price::float p FROM level_prices WHERE level_name ~ '^(PD|PW|PM|3M|PY)_(VAL|VAH|POC)$' OR level_name IN ('PD_HIGH','PD_LOW') ORDER BY 1`)).rows;
const byDay = new Map(); for (const r of lv) (byDay.get(r.d) || byDay.set(r.d, []).get(r.d)).push(r);
const STOP = 300, EXIT = '13:30', cap = (t) => (t.maeAtExitIdx[EXIT] >= STOP ? -STOP : (t.priceAtExit(EXIT) - t.entryPrice) * t.direction);
const rows = trades.map((t) => { const a = NQ.A15[t.tDay], levels = byDay.get(t.tDay) || []; if (!a || !levels.length) return null; const dist = t.direction < 0 ? levels.filter((l) => l.p < t.entryPrice).map((l) => (t.entryPrice - l.p) / a) : levels.filter((l) => l.p > t.entryPrice).map((l) => (l.p - t.entryPrice) / a); return { day: t.tDay, dir: t.direction, d: dist.length ? Math.min(...dist) : null, cap: cap(t) }; }).filter((r) => r && r.d != null);
const f = (x) => (x >= 0 ? '+' : '') + x.toFixed(0), blocked = rows.filter((r) => r.d <= 1), free = rows.filter((r) => r.d > 1);
console.log(`trades with levels ${rows.length}; nearest stored level in the trade direction within 1 A15: ${blocked.length}; farther: ${free.length}`);
console.log(`BLOCKED (level within 1 A15 ahead): mean capture ${blocked.length ? f(mean(blocked.map((r) => r.cap))) : 'n/a'} pt, hit ${blocked.length ? (100 * blocked.filter((r) => r.cap > 0).length / blocked.length).toFixed(0) : 'n/a'}% | FREE: ${f(mean(free.map((r) => r.cap)))} pt, hit ${(100 * free.filter((r) => r.cap > 0).length / free.length).toFixed(0)}%`);
for (const [nm, k] of [['SHORTS', -1], ['LONGS', 1]]) { const b = blocked.filter((r) => r.dir === k), fr = free.filter((r) => r.dir === k); console.log(`${nm}: blocked n=${b.length} mean ${b.length ? f(mean(b.map((r) => r.cap))) : 'n/a'} | free n=${fr.length} mean ${fr.length ? f(mean(fr.map((r) => r.cap))) : 'n/a'}`); }
const tonight = (await query(`SELECT level_name n, price::float p FROM level_prices WHERE trade_date='2026-10-26' AND (level_name ~ '^(PD|PW|PM|3M|PY)_(VAL|VAH|POC)$' OR level_name IN ('PD_HIGH','PD_LOW')) AND price < 29118.75 ORDER BY price DESC LIMIT 3`)).rows; console.log('tonight, nearest stored levels below the 29118.75 short entry:', tonight.map((l) => `${l.n} ${l.p} (${((29118.75 - l.p) / NQ.A15['2026-10-26']).toFixed(2)} A15)`).join(', '), `| A15 ${NQ.A15['2026-10-26']?.toFixed(0)}`);
process.exit(0);
