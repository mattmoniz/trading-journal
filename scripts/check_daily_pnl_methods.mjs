// F16 (Fable audit 2026-11-10): the two daily-P&L methods in the codebase side by side, so the open question "does a prop-account reset break the CumPL diff?"
// is answered from data instead of from two contradictory comments (CLAUDE.md hr-004 says CumPL diff only; server/routes/dailyLogs.js sums FlatToFlat on purpose).
// READ-ONLY, touches no endpoint. Per day on accounts LIKE '%-PRO%': CumPL diff (last end-of-position fill's Cumulative P/L minus the previous day's, per account)
// versus the sum of FlatToFlat P/L. A day where they differ is a day the choice matters; a negative or huge CumPL jump marks an account reset.
//   node scripts/check_daily_pnl_methods.mjs [days=60]
import { query } from '../server/db.js';
const days = Number(process.argv[2] || 60);
const rows = (await query(`
  WITH ep AS (
    SELECT log_date, custom_fields->>'account' AS account, exit_time,
           CASE WHEN custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)')::numeric END AS cum_pl,
           CASE WHEN custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)? *F$' THEN replace(replace(custom_fields->'sierra_data'->>'FlatToFlat Profit/Loss (C)','F',''),' ','')::numeric END AS ftf
    FROM trades WHERE custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP' AND exit_time IS NOT NULL AND custom_fields->>'account' LIKE '%-PRO%'
  ), last_ep AS (SELECT DISTINCT ON (log_date, account) log_date, account, cum_pl FROM ep ORDER BY log_date, account, exit_time DESC),
  diff AS (SELECT log_date, account, cum_pl, cum_pl - COALESCE(LAG(cum_pl) OVER (PARTITION BY account ORDER BY log_date), 0) AS cum_diff FROM last_ep WHERE cum_pl IS NOT NULL),
  f AS (SELECT log_date, account, SUM(ftf) AS ftf FROM ep GROUP BY 1, 2)
  SELECT d.log_date::text AS d, d.account, d.cum_pl::float AS cum_pl, d.cum_diff::float AS cum_diff, f.ftf::float AS ftf
  FROM diff d LEFT JOIN f USING (log_date, account) WHERE d.log_date >= CURRENT_DATE - $1::int ORDER BY d.account, d.log_date`, [days])).rows;
let differ = 0, resets = 0;
for (const r of rows) {
  const delta = r.ftf == null ? null : Math.round((r.cum_diff - r.ftf) * 100) / 100;
  const flag = delta == null ? 'no-ftf' : Math.abs(delta) > 0.5 ? 'DIFFERS' : 'same';
  if (flag === 'DIFFERS') differ++;
  console.log(`${r.d}  ${r.account.padEnd(18)} cumPL ${String(r.cum_pl).padStart(10)}  cumDiff ${String(r.cum_diff).padStart(9)}  FTF ${String(r.ftf).padStart(9)}  ${flag}${delta ? ` (${delta})` : ''}`);
}
console.log(`\n${rows.length} account-days in the last ${days} days; ${differ} where CumPL-diff and FlatToFlat differ by more than $0.50`);
process.exit(0);
