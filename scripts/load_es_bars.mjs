// Loads ES 1-minute bar CSVs (scratch/es_bars/<contract>.csv from scripts/tick_microstructure/build_1m_bars_from_scid.py, bars validated against Sierra's own export) into price_bars_es,
// then rebuilds es_front_calendar. Idempotent (ON CONFLICT DO NOTHING; calendar is rebuilt from scratch each run), so new contracts or a later 2026 export just add rows.
//   node scripts/load_es_bars.mjs [--csv-dir scratch/es_bars]
// Roll rule (data-derived, no fixed dates): per trade date the front contract is the one with the most RTH (09:30-16:00) volume, but a roll only moves FORWARD to a later contract and never back.
import fs from 'fs';
import path from 'path';
import { query } from '../server/db.js';
const dir = process.argv.includes('--csv-dir') ? process.argv[process.argv.indexOf('--csv-dir') + 1] : 'scratch/es_bars';
const files = fs.readdirSync(dir).filter((f) => /^ES[HMUZ]\d\.csv$/.test(f)).sort();
let total = 0;
for (const f of files) {
  const contract = f.replace('.csv', ''), lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').slice(1);
  let ins = 0;
  for (let i = 0; i < lines.length; i += 20000) {
    const rows = lines.slice(i, i + 20000).map((l) => l.split(','));
    const col = (k) => rows.map((r) => r[k]);
    const r = await query(`INSERT INTO price_bars_es (contract, ts, open, high, low, close, volume, num_trades, bid_volume, ask_volume)
      SELECT $1, ts::timestamp, o::numeric, h::numeric, l::numeric, c::numeric, v::int, n::int, bv::int, av::int FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[]) AS t(ts, o, h, l, c, v, n, bv, av)
      ON CONFLICT (contract, ts) DO NOTHING`, [contract, col(0), col(1), col(2), col(3), col(4), col(5), col(6), col(7), col(8)]);
    ins += r.rowCount;
  }
  total += ins; console.log(`${contract}: ${lines.length} csv rows, ${ins} inserted`);
}
// ---- calendar ----
const vols = (await query(`SELECT ts::date d, contract, SUM(volume)::bigint v, COUNT(*)::int mins FROM price_bars_es WHERE ts::time >= '09:30' AND ts::time < '16:00' GROUP BY 1, 2 ORDER BY 1`)).rows;
// rank by EXPIRY (year digit, then H<M<U<Z), NOT by first data date: the ESU5 file starts before ESM5's and a first-date rank made the roll skip ESU5 (found 2026-10-25). Digits 0-2 are read as 2030-2032.
const order = (await query(`SELECT contract FROM price_bars_es GROUP BY contract`)).rows.map((r) => r.contract), expiryKey = (c) => ((+c[3] < 3 ? +c[3] + 10 : +c[3]) * 10) + 'HMUZ'.indexOf(c[2]), rank = Object.fromEntries(order.map((c) => [c, expiryKey(c)]));
const byDay = new Map(); for (const r of vols) { if (!byDay.has(r.d.toISOString ? r.d.toISOString().slice(0, 10) : String(r.d))) byDay.set(r.d.toISOString ? r.d.toISOString().slice(0, 10) : String(r.d), []); byDay.get(r.d.toISOString ? r.d.toISOString().slice(0, 10) : String(r.d)).push({ c: r.contract, v: Number(r.v), m: r.mins }); }
const days = [...byDay.keys()].sort(); let cur = null; const cal = [];
for (const d of days) {
  const arr = byDay.get(d), lead = arr.reduce((a, b) => (b.v > a.v ? b : a)); let roll = false;
  if (cur === null) cur = lead.c; else if (rank[lead.c] > rank[cur]) { cur = lead.c; roll = true; }
  cal.push({ d, c: cur, roll, fv: arr.find((x) => x.c === cur)?.v ?? 0, lv: lead.v, lc: lead.c, mins: arr.find((x) => x.c === cur)?.m ?? 0 });
}
// carry the contract through every calendar date (weekends/holidays) so evening bars always map
const fill = []; for (let i = 0; i < cal.length; i++) { fill.push(cal[i]); const nxt = cal[i + 1]; if (!nxt) break; for (let t = new Date(cal[i].d + 'T00:00:00Z'); ; ) { t.setUTCDate(t.getUTCDate() + 1); const s = t.toISOString().slice(0, 10); if (s >= nxt.d) break; fill.push({ d: s, c: cal[i].c, roll: false, fv: null, lv: null, lc: null, mins: null }); } }
await query('DELETE FROM es_front_calendar');
for (let i = 0; i < fill.length; i += 2000) { const x = fill.slice(i, i + 2000);
  await query(`INSERT INTO es_front_calendar (trade_date, contract, is_roll_day, basis, rth_volume_front, rth_volume_leader, leader_contract, rth_minutes) SELECT d::date, c, r::boolean, 'RTH_VOLUME_LEADER_FORWARD_ONLY', fv::bigint, lv::bigint, lc, m::int FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) AS t(d, c, r, fv, lv, lc, m)`, [x.map((r) => r.d), x.map((r) => r.c), x.map((r) => String(r.roll)), x.map((r) => (r.fv == null ? null : String(r.fv))), x.map((r) => (r.lv == null ? null : String(r.lv))), x.map((r) => r.lc), x.map((r) => (r.mins == null ? null : String(r.mins)))]); }
console.log(`loaded ${total} new bars; calendar ${fill.length} dates; rolls:`, cal.filter((x) => x.roll).map((x) => `${x.d}->${x.c}`).join(' '));
process.exit(0);
