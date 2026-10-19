// RESEARCH ONLY. Tests the user's discretionary rule (2026-10-18): "once an IB low/high is broken, somewhat tested and holds,
// we're breaking out" -- at BAR level first (CLAUDE.md: market hypotheses go through bar history before setup N).
// Population: RTH sessions 2025-11-20 .. 2026-10-16 (clean window, roll weeks excluded). IB = 09:30-10:30 ET high/low.
// Event: first 1-min CLOSE beyond the IB level after 10:30 (confirmation bar tc, must be <= 13:30). HELD = no 1-min close back
// inside the IB during the next 20 bars. Decision time td = tc+20 (all as-of). Outcome = direction-signed move from close(td) to the
// RTH close (15:59), points. Pre-registered cells (K=3): C1 held vs same-clock-time unconditional drift control (sign-matched);
// C2 held vs reclaimed (closed back inside within 20 bars); C3 within held: heavy velocity (trailing 15-min signed move at tc in
// the fastest 10% for that time-of-day vs the prior 60 sessions) vs not. Descriptive only (not tested): distance to the nearest
// OPEN single print (30-min TPO from PRIOR sessions only; open = no later low/high has traded through its far edge) and whether it
// was reached by the close. Low-break and high-break reported separately (pooled hides opposite signs). Per-event point estimates.
import { mulberry32, hashSeed } from '../server/services/rigorDiagnostics.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { query } from '../server/db.js';
const raw=(await query(`SELECT ts::text ts, high::float h, low::float l, close::float c FROM price_bars_primary WHERE symbol='NQ' AND ts >= '2025-11-20' AND ts < '2026-10-17' AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) BETWEEN 570 AND 959 ORDER BY ts`)).rows;
const mod=b=>+b.ts.slice(11,13)*60+ +b.ts.slice(14,16);
const by=new Map(); for(const b of raw){const d=b.ts.slice(0,10); if(!by.has(d)) by.set(d,[]); by.get(d).push(b);}
const dates=[...by.keys()].sort().filter(d=>by.get(d).length>=385&&!isInsideNqRollWeek(d));
const clsAt=new Map(dates.map(d=>[d,new Map(by.get(d).map(b=>[mod(b),b.c]))]));
const mean=a=>a.reduce((s,x)=>s+x,0)/(a.length||1);
const pctOf=(arr,v)=>100*arr.filter(x=>x<v).length/(arr.length||1);
// single-print zones from prior sessions (30-min TPO, 0.25 ticks, run >= 12 pts)
const T=0.25, zones=[];
for(const d of dates){ const per=new Map(); for(const b of by.get(d)){ const p=Math.floor((mod(b)-570)/30); for(let k=Math.round(b.l/T);k<=Math.round(b.h/T);k++){ if(!per.has(k)) per.set(k,new Set()); per.get(k).add(p);} }
  let run=[]; const runs=[]; for(const k of [...per.keys()].sort((a,b)=>a-b)){ if(per.get(k).size===1){ if(run.length&&k!==run[run.length-1]+1){runs.push(run);run=[];} run.push(k);} else if(run.length){runs.push(run);run=[];} } if(run.length) runs.push(run);
  for(const r of runs){ const lo=r[0]*T,hi=r[r.length-1]*T; if(hi-lo>=12) zones.push({d,lo,hi}); } }
const dayExt=new Map(dates.map(d=>[d,{lo:Math.min(...by.get(d).map(b=>b.l)),hi:Math.max(...by.get(d).map(b=>b.h))}]));
function openBelow(d,px){ const di=dates.indexOf(d); return zones.filter(z=>z.d<d&&z.hi<px&&!dates.slice(dates.indexOf(z.d)+1,di).some(x=>dayExt.get(x).lo<=z.lo)).sort((a,b)=>b.hi-a.hi)[0]||null; }
function openAbove(d,px){ const di=dates.indexOf(d); return zones.filter(z=>z.d<d&&z.lo>px&&!dates.slice(dates.indexOf(z.d)+1,di).some(x=>dayExt.get(x).hi>=z.hi)).sort((a,b)=>a.lo-b.lo)[0]||null; }
const ev=[];
for(const d of dates){ const bs=by.get(d), ib=bs.filter(b=>mod(b)<630), H=Math.max(...ib.map(b=>b.h)), L=Math.min(...ib.map(b=>b.l)), post=bs.filter(b=>mod(b)>=630);
  for(const dir of [-1,1]){ const lvl=dir<0?L:H; const i=post.findIndex(b=>dir<0? b.c<lvl : b.c>lvl); if(i<0) continue; const tc=mod(post[i]); if(tc>810) continue;
    const next=post.slice(i+1,i+21); if(next.length<20) continue; const held=!next.some(b=>dir<0? b.c>=lvl : b.c<=lvl); const td=mod(next[19]);
    const px=next[19].c, close=bs[bs.length-1].c; const out=dir*(close-px);
    // velocity at tc: trailing 15-min signed move vs prior 60 sessions same minute +-5
    const cur=dir*(post[i].c-(clsAt.get(d).get(tc-15)??post[i].c)); const di=dates.indexOf(d), ref=[];
    for(const pd of dates.slice(Math.max(0,di-60),di)) for(let k=tc-5;k<=tc+5;k++){ const a=clsAt.get(pd).get(k), z=clsAt.get(pd).get(k-15); if(a!=null&&z!=null) ref.push(dir*(a-z)); }
    const fast=ref.length>50&&pctOf(ref,cur)>=90;
    const z=dir<0?openBelow(d,px):openAbove(d,px); const dist=z? (dir<0? px-z.hi : z.lo-px):null; const reached=z? (dir<0? Math.min(...bs.filter(b=>mod(b)>td).map(b=>b.l))<=z.hi : Math.max(...bs.filter(b=>mod(b)>td).map(b=>b.h))>=z.lo):null;
    ev.push({d,dir,held,td,out,fast,dist,reached,ibr:H-L}); } }
// same-clock-time unconditional drift baseline (sign-matched), mean over all days
function baseline(e){ const v=[]; for(const d of dates){ if(d===e.d) continue; const a=clsAt.get(d).get(e.td), c=clsAt.get(d).get(959)??clsAt.get(d).get(958); if(a!=null&&c!=null) v.push(e.dir*(c-a)); } return mean(v); }
for(const e of ev) e.base=baseline(e);
function boot(a,b,tag,N=3000){ if(a.length<6||b.length<6) return null; const r=mulberry32(hashSeed('IBH|'+tag)),o=[]; for(let k=0;k<N;k++){ let s1=0,s2=0; for(let q=0;q<a.length;q++) s1+=a[Math.floor(r()*a.length)]; for(let q=0;q<b.length;q++) s2+=b[Math.floor(r()*b.length)]; o.push(s1/a.length-s2/b.length);} o.sort((x,y)=>x-y); return [o[Math.floor(N*.025)],o[Math.floor(N*.975)]]; }
const f=(v,d=0)=>Number.isFinite(v)?v.toFixed(d):'n/a';
console.log(`sessions ${dates.length}; events ${ev.length}; single-print zones ${zones.length}`);
for(const [nm,dir] of [['IB-LOW breaks (down)',-1],['IB-HIGH breaks (up)',1]]){
  const E=ev.filter(e=>e.dir===dir), H=E.filter(e=>e.held), R=E.filter(e=>!e.held);
  console.log(`\n=== ${nm}: confirmed ${E.length} | held 20 bars ${H.length} | reclaimed ${R.length} ===`);
  console.log(`  held: mean signed move decision->close ${f(mean(H.map(e=>e.out)))} pts (median ${f([...H.map(e=>e.out)].sort((a,b)=>a-b)[H.length>>1])}); % continuing ${f(100*H.filter(e=>e.out>0).length/(H.length||1))}%`);
  console.log(`  reclaimed: ${f(mean(R.map(e=>e.out)))} pts; ${f(100*R.filter(e=>e.out>0).length/(R.length||1))}% continuing`);
  const c1=boot(H.map(e=>e.out),H.map(e=>e.base),nm+'C1'); console.log(`  C1 held minus same-clock unconditional drift: ${f(mean(H.map(e=>e.out-e.base)))} pts  (unconditional ${f(mean(H.map(e=>e.base)))}); CI ${c1?`[${f(c1[0])}, ${f(c1[1])}]`:'n/a'}`);
  const c2=boot(H.map(e=>e.out),R.map(e=>e.out),nm+'C2'); console.log(`  C2 held minus reclaimed: ${f(mean(H.map(e=>e.out))-mean(R.map(e=>e.out)))} pts; CI ${c2?`[${f(c2[0])}, ${f(c2[1])}]`:'n/a'}`);
  const Hf=H.filter(e=>e.fast), Hn=H.filter(e=>!e.fast); const c3=boot(Hf.map(e=>e.out),Hn.map(e=>e.out),nm+'C3');
  console.log(`  C3 within held: fast-velocity n=${Hf.length} mean ${f(mean(Hf.map(e=>e.out)))} vs not n=${Hn.length} ${f(mean(Hn.map(e=>e.out)))}; diff CI ${c3?`[${f(c3[0])}, ${f(c3[1])}]`:'n/a (n<6 in an arm)'}`);
  const Hz=H.filter(e=>e.dist!=null); console.log(`  descriptive: held breaks with an OPEN single print in the break direction: ${Hz.length}/${H.length}; median distance ${f([...Hz.map(e=>e.dist)].sort((a,b)=>a-b)[Hz.length>>1])} pts; reached by the close ${f(100*Hz.filter(e=>e.reached).length/(Hz.length||1))}%  | held without one: mean move ${f(mean(H.filter(e=>e.dist==null).map(e=>e.out)))} (n=${H.filter(e=>e.dist==null).length}) vs with: ${f(mean(Hz.map(e=>e.out)))}`);
}
const last=ev.filter(e=>e.d>='2026-10-12'); console.log('\nlast week events:',last.map(e=>`${e.d.slice(5)} ${e.dir<0?'LOW':'HIGH'}-break held=${e.held} td=${Math.floor(e.td/60)}:${String(e.td%60).padStart(2,'0')} out=${f(e.out)} fast=${e.fast} dist=${f(e.dist)}`).join(' | '));
process.exit(0);
