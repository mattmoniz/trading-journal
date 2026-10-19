// RESEARCH ONLY. User hypothesis (2026-10-18): "a few large Globex moves ... then it bled into RTH a day or two later."
// Bar-level test on clean NQ history 2025-11-20..2026-10-16 (roll weeks excluded). Legs: Globex = 18:00 -> 09:29 next morning
// session label, RTH = 09:30 -> 15:59. Heaviness is AS-OF: a leg is "heavy" if its normalised net (net / median range of the
// prior 40 same-type legs) is in the top/bottom 15% of those prior 40 legs, in its own direction. Outcome = direction-signed RTH net
// (points) in sessions t+0 (same morning), t+1, t+2. Pre-registered cells (K=3, Holm-reported): H1 one heavy Globex leg ->
// aligned RTH net at lag 1; H2 same -> lag 2; H3 two+ heavy same-direction Globex legs in the last 3 sessions -> aligned RTH
// net summed over the next 2 sessions. Lag 0 reported descriptively. Control = unconditional mean of direction-signed RTH net
// (sign-matched). 5-session block bootstrap for the CI (overlapping windows). Per-event point estimates.
import { mulberry32, hashSeed } from '../server/services/rigorDiagnostics.js';
import { isInsideNqRollWeek } from '../server/services/acdShared.js';
import { query } from '../server/db.js';
const raw=(await query(`SELECT ts::text ts, open::float o, high::float h, low::float l, close::float c FROM price_bars_primary WHERE symbol='NQ' AND ts >= '2025-11-20 18:00' AND ts < '2026-10-17' ORDER BY ts`)).rows;
const S=new Map();
for(const b of raw){ const hr=+b.ts.slice(11,13), mod=hr*60+ +b.ts.slice(14,16); if(mod>=1020&&mod<1080) continue;
  const d=new Date(Date.UTC(+b.ts.slice(0,4),+b.ts.slice(5,7)-1,+b.ts.slice(8,10)+(hr>=18?1:0))).toISOString().slice(0,10); if(!S.has(d)) S.set(d,[]); S.get(d).push({...b,mod}); }
const med=a=>{const s=[...a].sort((x,y)=>x-y);return s[s.length>>1]}; const mean=a=>a.reduce((s,x)=>s+x,0)/(a.length||1);
const days=[]; for(const d of [...S.keys()].sort()){ const bs=S.get(d); const g=bs.filter(b=>b.mod>=1080||b.mod<570), r=bs.filter(b=>b.mod>=570&&b.mod<960); if(g.length<300||r.length<300||isInsideNqRollWeek(d)) continue;
  const rng=a=>Math.max(...a.map(b=>b.h))-Math.min(...a.map(b=>b.l)); days.push({d,gNet:g[g.length-1].c-g[0].o,gRng:rng(g),rNet:r[r.length-1].c-r[0].o,rRng:rng(r)}); }
// as-of heaviness
for(let i=0;i<days.length;i++){ const t=days.slice(Math.max(0,i-40),i); if(t.length<25){days[i].ok=false;continue;} days[i].ok=true; const mr=med(t.map(x=>x.gRng)); const cur=days[i].gNet/mr; const ref=t.map(x=>x.gNet/mr);
  const pct=100*ref.filter(x=>x<cur).length/ref.length; days[i].gHeavy= pct<=15?-1: pct>=85?1:0; days[i].gN=cur; }
const evs=[]; for(let i=2;i+2<days.length;i++){ const L=days[i]; if(!L.ok) continue; const w=days.slice(i-2,i+1).filter(x=>x.ok); const sign=L.gHeavy;
  const stack=sign!==0 && w.filter(x=>x.gHeavy===sign).length>=2;
  evs.push({i,d:L.d,sign,stack,
    r0:(days[i].rNet),r1:days[i+1].rNet,r2:days[i+2].rNet}); }
const f=(v,d=0)=>Number.isFinite(v)?v.toFixed(d):'n/a';
function boot(sel,key,tag,N=3000){ const blk=5,nb=Math.ceil(evs.length/blk),rand=mulberry32(hashSeed('GLR|'+tag)),o=[];
  for(let k=0;k<N;k++){ let sa=0,na=0,sb=0,nb2=0; for(let q=0;q<nb;q++){ const s=Math.floor(rand()*nb)*blk; for(let j=s;j<Math.min(evs.length,s+blk);j++){ const e=evs[j]; if(sel(e)){ sa+=e.sign*key(e); na++; } sb+=1*key(e)*(Math.sign(e.sign)||1)*0 ; nb2++; } } if(na) o.push(sa/na); }
  o.sort((x,y)=>x-y); return [o[Math.floor(o.length*.025)],o[Math.floor(o.length*.975)]]; }
const uncondAbs=(key)=>mean(evs.map(e=>Math.abs(key(e)))); // for scale only
console.log(`sessions ${days.length}; scored ${evs.length}; heavy-down Globex legs ${evs.filter(e=>e.sign<0).length}, heavy-up ${evs.filter(e=>e.sign>0).length}; stacked(>=2 same dir in last 3) ${evs.filter(e=>e.stack).length}`);
console.log(`unconditional mean RTH net: lag0 ${f(mean(evs.map(e=>e.r0)))}, lag1 ${f(mean(evs.map(e=>e.r1)))}, lag2 ${f(mean(evs.map(e=>e.r2)))} pts (market drift; outcomes below are direction-signed so drift cancels only partly -- reported)`);
for(const [nm,sel,keys] of [['H1/H2 one heavy Globex leg (either direction, outcome signed by leg direction)',e=>e.sign!==0,[['lag0 (same morning, descriptive)',e=>e.r0],['H1 lag1',e=>e.r1],['H2 lag2',e=>e.r2]]],['H3 stacked: >=2 heavy same-direction Globex legs in last 3 sessions',e=>e.stack,[['next2 sum',e=>e.r1+e.r2]]]]){
  console.log('\n'+nm);
  for(const [k,key] of keys){ const A=evs.filter(sel); const aligned=A.map(e=>e.sign*key(e)); const ci=boot(sel,key,nm+k); const down=A.filter(e=>e.sign<0), up=A.filter(e=>e.sign>0);
    console.log(`  ${k.padEnd(30)} n=${A.length} (${new Set(A.map(e=>e.d)).size} days) mean aligned RTH net ${f(mean(aligned))} pts, median ${f([...aligned].sort((a,b)=>a-b)[aligned.length>>1])}, share aligned ${f(100*aligned.filter(x=>x>0).length/(aligned.length||1))}%, CI [${f(ci[0])}, ${f(ci[1])}] | after heavy DOWN n=${down.length}: ${f(mean(down.map(e=>-key(e))))} ; after heavy UP n=${up.length}: ${f(mean(up.map(e=>key(e))))}`); } }
console.log('\nstacked events (date: dir, then RTH net t+1, t+2):', evs.filter(e=>e.stack).map(e=>`${e.d.slice(5)} ${e.sign<0?'DN':'UP'} ${f(e.r1)}/${f(e.r2)}`).join(' | '));
process.exit(0);
