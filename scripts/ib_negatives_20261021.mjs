import { query } from '../server/db.js';
import { collapseClusterSiblings, dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
const mean=a=>a.reduce((s,x)=>s+x,0)/a.length, f=x=>(x>=0?'+':'')+x.toFixed(1);
const types=(await query(`SELECT DISTINCT setup_type FROM active_setups WHERE setup_type LIKE 'IB\\_%' OR setup_type LIKE '%\\_IB\\_%' ORDER BY 1`)).rows.map(r=>r.setup_type);
const cur=(await query(`SELECT DISTINCT ON (signal_name) signal_name, recommendation FROM performance_audit WHERE signal_type='SETUP_STATUS' ORDER BY signal_name, run_date DESC, id DESC`)).rows; const rec=Object.fromEntries(cur.map(r=>[r.signal_name,r.recommendation]));
for (const t of types){ const rs=(await query(`SELECT trade_date::text d, cluster_touch_id cl, actual_pnl::float p FROM active_setups WHERE setup_type=$1 AND origin_status IN ('ACTIVE','SHADOW') AND trade_date>='2026-07-09' AND actual_pnl IS NOT NULL AND resolution IS DISTINCT FROM 'NOT_FILLED' AND ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE AND NOT (fired_at::time>='16:00' AND fired_at::time<'18:00')`,[t])).rows;
 const ev=collapseClusterSiblings(rs.map(r=>({date:r.d,pnl:r.p,cluster_touch_id:r.cl}))); const days=new Set(ev.map(e=>e.date)).size;
 if(!ev.length){console.log(t.padEnd(30),rec[t]||'-', 'no real rows');continue;}
 const ci=ev.length>=10?dayBlockedBootstrapCI(ev,t):null; console.log(t.padEnd(30),(rec[t]||'-').padEnd(10),`n ${ev.length}/${days}d mean ${f(mean(ev.map(e=>e.pnl)))}`, ci?`CI [${f(ci.lo)},${f(ci.hi)}]`:'thin'); }
process.exit(0);
