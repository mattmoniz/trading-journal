import { query } from '../server/db.js';
import { collapseClusterSiblings, mulberry32, hashSeed } from '../server/services/rigorDiagnostics.js';
const f=x=>(x>=0?'+':'')+x.toFixed(1), mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:NaN;
const rows=(await query(`SELECT id, setup_type t, trade_date::text d, cluster_touch_id cl, is_cluster_primary prim, origin_status o, actual_pnl::float p, (rotation_65pt_gate_shadow->>'agree') ag, fired_at::text fa FROM active_setups WHERE rotation_65pt_gate_shadow IS NOT NULL AND origin_status IN ('ACTIVE','SHADOW') AND actual_pnl IS NOT NULL AND resolution IS DISTINCT FROM 'NOT_FILLED' AND ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE AND NOT (fired_at::time>='16:00' AND fired_at::time<'18:00')`)).rows;
function arm(rs){ // collapse siblings within arm
  return collapseClusterSiblings(rs.map(r=>({date:r.d,pnl:r.p,cluster_touch_id:r.cl,id:r.id}))); }
function boot(A,B,seed){ const days=[...new Set([...A,...B].map(e=>e.date))]; const ga=new Map(),gb=new Map(); for(const e of A)(ga.get(e.date)||ga.set(e.date,[]).get(e.date)).push(e.pnl); for(const e of B)(gb.get(e.date)||gb.set(e.date,[]).get(e.date)).push(e.pnl);
  const rnd=mulberry32(hashSeed(seed)); const ds=[]; for(let i=0;i<2000;i++){ let sa=0,na=0,sb=0,nb=0; for(let k=0;k<days.length;k++){const d=days[Math.floor(rnd()*days.length)]; for(const x of ga.get(d)||[]){sa+=x;na++} for(const x of gb.get(d)||[]){sb+=x;nb++}} if(na&&nb) ds.push(sa/na-sb/nb);} ds.sort((a,b)=>a-b); return [ds[Math.floor(.025*ds.length)],ds[Math.floor(.975*ds.length)]]; }
function report(label, rs){ const A=arm(rs.filter(r=>r.ag==='true')), B=arm(rs.filter(r=>r.ag==='false')); const days=new Set(rs.map(r=>r.d)).size;
  if(A.length<5||B.length<5){console.log(label.padEnd(44),`AGREE n${A.length} DISAGREE n${B.length} too thin`);return;}
  const [lo,hi]=boot(A,B,label); console.log(label.padEnd(44),`${days}d | AGREE n${A.length} ${f(mean(A.map(e=>e.pnl)))} | DISAGREE n${B.length} ${f(mean(B.map(e=>e.pnl)))} | delta ${f(mean(A.map(e=>e.pnl))-mean(B.map(e=>e.pnl)))} CI [${f(lo)},${f(hi)}]`); }

const st=(await query(`SELECT DISTINCT ON (signal_name) signal_name n, recommendation r FROM performance_audit WHERE signal_type='SETUP_STATUS' ORDER BY signal_name, run_date DESC, id DESC`)).rows; const rec=new Map(st.map(x=>[x.n,x.r]));
const by=new Map(); for(const r of rows){ if(r.t.startsWith('POC_ROTATION_JOIN')) continue; (by.get(r.t)||by.set(r.t,[]).get(r.t)).push(r); }
const MINARM=8, out=[]; let tested=0;
for(const [t,rs] of by){ const A=arm(rs.filter(r=>r.ag==='true')), B=arm(rs.filter(r=>r.ag==='false')); if(A.length<MINARM||B.length<MINARM) continue; tested++; const [lo,hi]=boot(A,B,t); const d=mean(A.map(e=>e.pnl))-mean(B.map(e=>e.pnl)); out.push({t,rec:rec.get(t)||'?',nA:A.length,nB:B.length,mA:mean(A.map(e=>e.pnl)),mB:mean(B.map(e=>e.pnl)),d,lo,hi,days:new Set(rs.map(r=>r.d)).size}); }
out.sort((a,b)=>b.d-a.d);
console.log(`types with tagged rows: ${by.size}; with >=${MINARM} events in BOTH arms: ${tested}; rows tagged since ${rows.reduce((m,r)=>r.d<m?r.d:m,'9')}`);
for(const o of out) console.log(`${o.t.padEnd(36)} ${String(o.rec).padEnd(10)} ${o.days}d AGREE n${o.nA} ${f(o.mA)} | DISAGREE n${o.nB} ${f(o.mB)} | delta ${f(o.d)} CI [${f(o.lo)},${f(o.hi)}]${o.lo>0?'  <-- CI above 0':''}`);
console.log('\nCI above zero:',out.filter(o=>o.lo>0).length,'of',tested,'(about',(0.025*tested).toFixed(1),'expected by chance one-sided at 95%)');
process.exit(0);
