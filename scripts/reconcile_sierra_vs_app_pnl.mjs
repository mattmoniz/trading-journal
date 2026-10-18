// Reconciles what Sierra Chart shows (real broker fills on the trade account) against what the app's
// quick-check page shows (model P&L for every live row, most of which never reach the broker).
// Usage: node scripts/reconcile_sierra_vs_app_pnl.mjs <trade_date> [<trade_date_to>] [--through HH:MM] [--sierra <number>]
//   --through  only count trades resolved by that ET clock time on the last day (to match a screenshot)
//   --sierra   the figure Sierra showed (e.g. DPL), printed next to the broker total for comparison
// Broker P&L here is rebuilt from the order fills (same as brokerPnl.js: points * $2 - $2 commission); it is
// what Sierra's own trade P&L should equal, within its own commission setting.
import { query } from '../server/db.js';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const through = flag('--through');
const sierra = flag('--sierra');
const from = args[0];
const to = args[1] || args[0];
if (!from) { console.error('usage: node scripts/reconcile_sierra_vs_app_pnl.mjs <trade_date> [<trade_date_to>] [--through HH:MM] [--sierra N]'); process.exit(1); }

const rows = (await query(`
  SELECT a.id, a.setup_type, a.trade_date::text AS trade_date, TO_CHAR(a.fired_at, 'MM-DD HH24:MI') AS fired,
         TO_CHAR(a.resolved_at, 'MM-DD HH24:MI') AS resolved, a.resolution, a.actual_pnl::float AS model_pnl,
         a.broker_pnl::float AS broker_pnl, a.is_cluster_primary,
         e.status AS entry_status, e.avg_fill_price::float AS entry_px, e.side,
         (SELECT x.avg_fill_price::float FROM order_placements x WHERE x.setup_id = a.id AND x.purpose IN ('STOP','EXIT','TARGET') AND x.status = 'FILLED' ORDER BY x.id DESC LIMIT 1) AS exit_px,
         (SELECT COUNT(*) FROM order_placements x WHERE x.setup_id = a.id AND x.client_order_id LIKE 'RECON-FLAT-%')::int AS flat_estimated
  FROM active_setups a
  LEFT JOIN order_placements e ON e.setup_id = a.id AND e.purpose = 'ENTRY'
  WHERE a.origin_status = 'ACTIVE' AND a.trade_date BETWEEN $1 AND $2
  ORDER BY a.fired_at`, [from, to])).rows;

const cut = through ? `${to.slice(5)} ${through}` : null; // 'MM-DD HH:MM' string compare against resolved/fired
const inWindow = (r) => !cut || (r.resolved ? r.resolved <= cut : r.fired <= cut);
const money = (v) => (v == null ? '      n/a' : (v >= 0 ? '+' : '-') + '$' + Math.abs(v).toFixed(2).padStart(7));

const byDay = new Map();
for (const r of rows.filter(inWindow)) { if (!byDay.has(r.trade_date)) byDay.set(r.trade_date, []); byDay.get(r.trade_date).push(r); }

for (const [day, list] of byDay) {
  const filled = list.filter(r => r.entry_status === 'FILLED');
  const never = list.filter(r => r.entry_status !== 'FILLED');
  const primaryAll = list.filter(r => r.is_cluster_primary !== false && r.model_pnl != null);
  const brokerSum = filled.reduce((s, r) => s + (r.broker_pnl ?? 0), 0);
  const unknown = filled.filter(r => r.broker_pnl == null);
  const modelSameTrades = filled.reduce((s, r) => s + (r.model_pnl ?? 0), 0);
  const modelAllLive = primaryAll.reduce((s, r) => s + r.model_pnl, 0);

  console.log(`\n=== trade_date ${day}${cut ? ` (through ${through} ET)` : ''} ===`);
  console.log('trades that reached the broker (filled entry):');
  console.log('  id      setup'.padEnd(46) + 'fired        resolved     resolution     model P&L   broker P&L  note');
  for (const r of filled) {
    const note = r.flat_estimated ? 'closed outside app, exit ESTIMATED' : r.broker_pnl == null ? 'broker P&L UNKNOWN' : '';
    console.log(`  ${String(r.id).padEnd(7)} ${r.setup_type.padEnd(34)}${(r.fired || '').padEnd(13)}${(r.resolved || 'open').padEnd(13)}${(r.resolution || '').padEnd(15)}${money(r.model_pnl)}  ${money(r.broker_pnl)}  ${note}`);
  }
  console.log('');
  console.log(`  Live rows that day: ${list.length}  |  reached the broker: ${filled.length}  |  never reached it: ${never.length}`);
  console.log(`  BROKER total (what Sierra should show): ${money(brokerSum)}${unknown.length ? `   (+ ${unknown.length} trade(s) with unknown broker P&L)` : ''}`);
  console.log(`  App MODEL total for those same trades:   ${money(modelSameTrades)}`);
  console.log(`  App MODEL total for ALL live primary rows (what quick-check "Live" shows): ${money(modelAllLive)}  (${primaryAll.length} resolved rows)`);
  if (sierra != null) console.log(`  Sierra showed ${money(Number(sierra))}  -> difference vs broker total: ${money(Number(sierra) - brokerSum)}`);
  const byRes = new Map();
  for (const r of never) byRes.set(r.resolution || 'open', (byRes.get(r.resolution || 'open') || 0) + 1);
  if (never.length) console.log(`  Rows that never reached the broker, by outcome: ${[...byRes].map(([k, v]) => `${k}=${v}`).join(', ')}`);
}
if (!byDay.size) console.log('no live rows in that range');
process.exit(0);
