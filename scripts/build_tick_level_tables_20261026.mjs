// Builds two MATCHED comparison tables for the paired backtest (docs/OPEN_THREADS.md 2026-10-26): level_prices_cmp_stored and level_prices_cmp_tick.
// Every level_prices row is copied to both, EXCEPT the PD/PW/PM/3M VAH/VAL/POC rows: where the tick table covers the period (>= 97 percent of its RTH days) both tables keep that
// (date, family) with stored values in one and tick values in the other; where it does not, the family's rows are removed from BOTH, so the two runs see identical coverage.
// New research tables only (nothing existing altered). Drop them when the comparison is finished. Run the backtests with UB_LEVELS_TABLE=<table> (scripts/backtest_unified.js).
import { query } from '../server/db.js';
import { loadTick } from './lib/tickLevelFamilies.mjs';
const { families } = await loadTick();
for (const t of ['level_prices_cmp_stored', 'level_prices_cmp_tick']) { await query(`DROP TABLE IF EXISTS ${t}`); await query(`CREATE TABLE ${t} (LIKE level_prices INCLUDING DEFAULTS)`); await query(`ALTER TABLE ${t} ADD PRIMARY KEY (trade_date, level_name)`); }
const FAM = ['PD', 'PW', 'PM', '3M'], isFam = "level_name ~ '^(PD|PW|PM|3M)_(VAH|VAL|POC)$'";
for (const t of ['level_prices_cmp_stored', 'level_prices_cmp_tick']) await query(`INSERT INTO ${t} SELECT * FROM level_prices WHERE NOT (${isFam})`);
const dates = (await query(`SELECT DISTINCT trade_date::text d FROM level_prices WHERE trade_date >= '2023-11-01' ORDER BY 1`)).rows.map((r) => r.d);
const st = new Map(); for (const r of (await query(`SELECT trade_date::text d, level_name n, price::float p, category c FROM level_prices WHERE ${isFam}`)).rows) { let m = st.get(r.d); if (!m) st.set(r.d, (m = {})); m[r.n] = { p: r.p, c: r.c }; }
const cnt = { PD: 0, PW: 0, PM: 0, '3M': 0 }, skipped = { PD: 0, PW: 0, PM: 0, '3M': 0 };
for (const d of dates) {
  const s = st.get(d) || {};
  for (const fam of FAM) {
    if (s[`${fam}_POC`] == null) continue; const t = families[fam](d); if (!t) { skipped[fam]++; continue; }
    const vals = { VAH: t.vah, VAL: t.val, POC: t.poc };
    for (const k of ['VAH', 'VAL', 'POC']) { const nm = `${fam}_${k}`; if (!s[nm]) continue;
      await query(`INSERT INTO level_prices_cmp_stored (trade_date, level_name, price, category) VALUES ($1, $2, $3, $4)`, [d, nm, s[nm].p, s[nm].c]);
      await query(`INSERT INTO level_prices_cmp_tick (trade_date, level_name, price, category) VALUES ($1, $2, $3, $4)`, [d, nm, vals[k], s[nm].c]); }
    cnt[fam]++; }
}
console.log('families kept in both tables (dates):', JSON.stringify(cnt), '| removed from both (no tick coverage):', JSON.stringify(skipped));
const n = async (t) => (await query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n; console.log('rows', await n('level_prices_cmp_stored'), await n('level_prices_cmp_tick'));
process.exit(0);
