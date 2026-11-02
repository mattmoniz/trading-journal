// COUNT-ONLY status of the forward forecast data (no skill statistic is ever printed here, so nightly runs cannot cause optional stopping). Skill is read only at the pre-set looks in docs/FORECAST_SERVICE_20261102.md.
import { query } from '../../server/db.js';
const m = await query(`SELECT version, horizon_min, role, trained_through::text FROM forecast_models WHERE role IN ('CHAMPION','CHALLENGER') ORDER BY id`);
const p = await query(`SELECT COUNT(*)::int n, COUNT(DISTINCT trade_date)::int days, COUNT(*) FILTER (WHERE realized IS NOT NULL AND realized->>'30' IS NOT NULL)::int complete FROM forecast_points`);
const t = await query(`SELECT kind, COUNT(*)::int n, COUNT(*) FILTER (WHERE in_primary_window)::int primary_n, COUNT(DISTINCT trade_date)::int days FROM forecast_tags GROUP BY 1 ORDER BY 1`);
console.log('forecast models:', m.rows.map(r => `${r.version}[${r.role}]`).join(', ') || 'none');
console.log(`forward points ${p.rows[0].n} on ${p.rows[0].days} days (complete 30-min windows ${p.rows[0].complete}); tags: ` + (t.rows.map(r => `${r.kind} ${r.n} (${r.primary_n} in 10:00-14:30) on ${r.days} days`).join('; ') || 'none'));
process.exit(0);
