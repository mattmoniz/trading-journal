import sys; sys.argv=sys.argv[:1]; sys.path.insert(0,'/home/mmoniz/trading-journal/scripts/amt_context')
import numpy as np, tell_state as TS, vbars as V, trade as T
from run_tell_range_break import break_event
_, ctxs, _ = TS.sessions_and_contexts(); acc = {a: dict(n=0, agree_pre=0, firstbreak=0, fbn=0, sign={5:[0,0],15:[0,0],30:[0,0],60:[0,0]}, touch={10:[0,0],25:[0,0],50:[0,0]}) for a in ('TELL','CONTROL')}
def run(S, i, dr, A):
    c,h,l,end,comp=S['c'],S['h'],S['l'],S['end'],S['comp']; n=len(c); t0=end[i]
    for H in (5,15,30,60):
        if end[comp].max() < t0+H*60-60: continue
        w=np.where(comp&(end>t0)&(end<=t0+H*60))[0]
        if len(w)==0: continue
        mv=dr*(c[w[-1]]-c[i]); 
        if mv!=0: A['sign'][H][0]+= mv>0; A['sign'][H][1]+=1
    w=np.where(comp&(end>t0)&(end<=t0+3600))[0]
    for k in (10,25,50):
        up=dn=None
        for j in w:
            if up is None and h[j]>=c[i]+k: up=j
            if dn is None and l[j]<=c[i]-k: dn=j
            if up is not None and dn is not None: break
        a=up if dr==1 else dn; b=dn if dr==1 else up
        if a is None and b is None: continue
        if b is None or (a is not None and a<b): A['touch'][k][0]+=1
        elif a==b: continue
        A['touch'][k][1]+=1
for d,ctx in ctxs.items():
    S=ctx['S']; end,comp=S['end'],S['comp']; prof=T.Prof(ctx)
    tells=[(int(t['sig']),int(t['dir'])) for t in T.simulate(ctx,'V1',dict(fires=0,skip=0,trades=0,fallback=0))]
    ctl=[(i,0) for i in range(ctx['n']-1) if i%10==0 and V.DEC_FIRST<=end[i]<=V.DEC_LAST and comp[i] and (ctx['moving1'][i] or ctx['moving-1'][i]) and not any(T.ncomp_at(ctx,prof,i,dd,need_nodes=False)[1] for dd in (1,-1))]
    for arm,pts in (('TELL',tells),('CONTROL',ctl)):
        A=acc[arm]
        for i,td in pts:
            if i<10 or i+5>=ctx['n']: continue
            pre=int(np.sign(S['c'][i]-S['c'][i-10])); 
            if pre==0: continue
            dr=td if arm=='TELL' else pre; A['n']+=1; A['agree_pre']+= (td==pre) if arm=='TELL' else 1
            ev=break_event(S,i)
            if ev and ev['S'] is not None: A['fbn']+=1; A['firstbreak']+= ev['S'][0]==pre
            run(S,i,dr,A)
for a,A in acc.items():
    print(a,'N',A['n'],'| tell direction equals the prior-10-bar move direction:',f"{100*A['agree_pre']/A['n']:.0f}%" if a=='TELL' else 'n/a','| first break of the 10-bar range goes the pre-move direction:',f"{100*A['firstbreak']/A['fbn']:.1f}% (N {A['fbn']})")
    print('   share of fires where the move at +5/15/30/60 min is in the fire direction:', ', '.join(f"{H}m {100*v[0]/v[1]:.1f}%" for H,v in A['sign'].items()))
    print('   first to reach +k before -k within 60 min (fire direction):', ', '.join(f"k={k}: {100*v[0]/v[1]:.1f}% (N {v[1]})" for k,v in A['touch'].items()))
