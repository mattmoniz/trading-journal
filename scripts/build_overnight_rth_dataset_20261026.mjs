// Dataset builder for docs/BAR_CONTEXT_STUDIES_PREREG_A_20261026.md (overnight-to-RTH). One row per RTH date: features known before 09:30 (and, for the
// Globex analogue, before 00:00), and forward outcomes measured strictly after. Writes scratch/overnight_rth_dataset_20261026.json.
//   node scripts/build_overnight_rth_dataset_20261026.mjs [--counts]   (--counts prints state frequencies only, no outcome statistics)
import fs from 'fs';
import { query } from '../server/db.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { computeProfile } from '../server/services/developingValueService.js';

export const WINDOW_START = '2023-03-06';
const SPARSE_FROM = '2025-09-28', SPARSE_TO = '2025-11-19';
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dow = (d) => new Date(d + 'T12:00:00Z').getUTCDay();
const modOf = (ts) => { const m = ts.match(/(\d{2}):(\d{2}):/); return +m[1] * 60 + +m[2]; };
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function bars(from, to) {
  return (await query(`SELECT ts::text ts, open::float open, high::float high, low::float low, close::float close, volume::float volume FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= $1::timestamp AND ts < $2::timestamp ORDER BY ts`, [from, to])).rows.map((b) => ({ ...b, mod: modOf(b.ts) }));
}
const profile = (bs) => { const p = computeProfile(bs); return p ? { poc: p.poc, vah: p.vah, val: p.val } : null; };

export async function buildDataset(endDate) {
  const stats = (await query(`SELECT trade_date::text d, rth_range::float rng, n_bars FROM daily_rth_stats WHERE trade_date >= ($1::date - 60) AND trade_date <= $2::date ORDER BY trade_date`, [WINDOW_START, endDate])).rows;
  const rows = []; const excl = { sparse: 0, roll: 0, rthDensity: 0, noPrior: 0 };
  const rthCache = new Map();
  const getRth = async (d) => { if (!rthCache.has(d)) rthCache.set(d, (await bars(`${d} 09:30:00`, `${d} 16:00:00`))); return rthCache.get(d); };
  for (let i = 20; i < stats.length; i++) {
    const D = stats[i].d, PD = stats[i - 1].d;
    if (D < WINDOW_START) continue;
    if (D >= SPARSE_FROM && D <= SPARSE_TO) { excl.sparse++; continue; }
    if (isInsideNqRollWeek(D) || isInsideNqRollWeek(PD)) { excl.roll++; continue; }
    if (stats[i].n_bars < 371) { excl.rthDensity++; continue; }
    const atr = stats.slice(i - 20, i).reduce((s, x) => s + x.rng, 0) / 20;
    const rth = await getRth(D), prth = await getRth(PD);
    if (rth.length < 371 || prth.length < 371) { excl.rthDensity++; continue; }
    const onAll = await bars(`${PD} 16:00:00`, `${D} 09:30:00`);
    const on = onAll.filter((b) => b.mod >= 1080 || b.mod < 570);
    if (on.length < 60) { excl.noPrior++; continue; }
    const pp = profile(prth), onp = profile(on);
    if (!pp || !onp) { excl.noPrior++; continue; }
    const priorClose = prth[prth.length - 1].close;
    const O = rth[0].open, at = (k) => rth[Math.min(k, rth.length) - 1].close;
    const onL = Math.min(...on.map((b) => b.low)), onH = Math.max(...on.map((b) => b.high));
    const fh = on.filter((b) => b.mod >= 1080), sh = on.filter((b) => b.mod < 570);
    const fhL = fh.length ? Math.min(...fh.map((b) => b.low)) : null, fhH = fh.length ? Math.max(...fh.map((b) => b.high)) : null;
    const shBase = sh.length ? sh[0].open : null, shAt = (k) => (sh.length >= k ? sh[k - 1].close : null);
    rows.push({
      date: D, dow: dow(D), atr, O, priorClose, VAL: pp.val, VAH: pp.vah, onL, onH, onPoc: onp.poc, onOpen: on[0].open, onClose: on[on.length - 1].close,
      onBars: on.length, onVol: on.reduce((s, b) => s + b.volume, 0), fhVol: fh.reduce((s, b) => s + b.volume, 0), fhBars: fh.length, fhL, fhH,
      shBars: sh.length, shBase, sh60: shAt(60), sh180: shAt(180), shEnd: sh.length ? sh[sh.length - 1].close : null,
      r15: (at(15) - O) / atr, r30: (at(30) - O) / atr, r60: (at(60) - O) / atr, rClose: (rth[rth.length - 1].close - O) / atr,
      rthRangeAtr: stats[i].rng / atr, rthHigh: Math.max(...rth.map((b) => b.high)), rthLow: Math.min(...rth.map((b) => b.low)),
      pdRangeAtr: (Math.max(...prth.map((b) => b.high)) - Math.min(...prth.map((b) => b.low))) / atr, gapAtr: (O - priorClose) / atr,
    });
    if (rthCache.size > 4) rthCache.delete(rthCache.keys().next().value);
  }
  // overnight density screen: per weekday-type (Monday sessions start Sunday evening and are longer) vs that type's median bar count
  const medMon = median(rows.filter((r) => r.dow === 1).map((r) => r.onBars)), medOth = median(rows.filter((r) => r.dow !== 1).map((r) => r.onBars));
  const kept = rows.filter((r) => r.onBars >= 0.8 * (r.dow === 1 ? medMon : medOth));
  excl.onDensity = rows.length - kept.length;
  return { rows: kept, excl, endDate };
}

async function main() {
  const endDate = (await query(`SELECT max(trade_date)::text d FROM daily_rth_stats WHERE n_bars >= 371 AND trade_date < CURRENT_DATE`)).rows[0].d;
  const ds = await buildDataset(endDate);
  fs.writeFileSync(new URL('../scratch/overnight_rth_dataset_20261026.json', import.meta.url), JSON.stringify(ds));
  const R = ds.rows;
  console.log(`window ${WINDOW_START}..${endDate}: valid days ${R.length}; excluded`, ds.excl);
  const c = (f) => R.filter(f).length;
  console.log('A1 inventory: ABOVE', c((r) => r.onL >= r.VAH), 'BELOW', c((r) => r.onH <= r.VAL), 'INSIDE/other', c((r) => !(r.onL >= r.VAH) && !(r.onH <= r.VAL)));
  console.log('A2 open vs ON range: ABOVE_ON', c((r) => r.O > r.onH), 'BELOW_ON', c((r) => r.O < r.onL), 'INSIDE', c((r) => r.O <= r.onH && r.O >= r.onL));
  console.log('A3 open vs ON POC: ABOVE', c((r) => r.O > r.onPoc), 'BELOW', c((r) => r.O < r.onPoc));
  const exp = Math.floor(R.length * 0.6);
  console.log(`explore ${exp} days (${R[0].date}..${R[exp - 1].date}), hold-out ${R.length - exp} days (${R[exp].date}..${R[R.length - 1].date})`);
  console.log('A1 in explore: ABOVE', R.slice(0, exp).filter((r) => r.onL >= r.VAH).length, 'BELOW', R.slice(0, exp).filter((r) => r.onH <= r.VAL).length, '| in hold-out: ABOVE', R.slice(exp).filter((r) => r.onL >= r.VAH).length, 'BELOW', R.slice(exp).filter((r) => r.onH <= r.VAL).length);
  console.log('G1 first-half vs prior VA: ABOVE', c((r) => r.fhL != null && r.fhL >= r.VAH), 'BELOW', c((r) => r.fhH != null && r.fhH <= r.VAL));
}
if (import.meta.url === `file://${process.argv[1]}`) main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
