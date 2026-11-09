import json, glob, os, numpy as np
R='/home/mmoniz/trading-journal/scratch/volbars500_full_20261028'
J=json.load(open('/home/mmoniz/trading-journal/scratch/tell_context_20261103/shapes.json'))
NB=40; rows=[]
def wmed(t,w): o=np.argsort(t); cs=np.cumsum(w[o]); return float(t[o][np.searchsorted(cs,cs[-1]/2)])
for p in sorted(glob.glob(R+'/*.bars.tsv')):
    d=os.path.basename(p)[:10]
    if d>'2025-05-16' or d not in J: continue
    b=np.loadtxt(p,delimiter='\t',ndmin=2); v=np.loadtxt(p.replace('.bars.','.vap.'),delimiter='\t',ndmin=2)
    rth=(b[:,2]>=55800)&(b[:,2]<79200)
    if rth.sum()<100: continue
    br=b[rth]; end=dict(zip(b[:,0].astype(int),b[:,2])); idx=set(br[:,0].astype(int))
    m=np.isin(v[:,0].astype(int),list(idx)); px=v[m,1]; vol=v[m,2]; t=np.array([end[int(i)] for i in v[m,0]])
    lo,hi=px.min(),px.max(); edges=np.linspace(lo,hi+1e-9,NB+1); P,_=np.histogram(px,bins=edges,weights=vol); sm=P.copy()
    for j in range(1,NB-1): sm[j]=P[j-1:j+2].mean()
    pk=sorted([j for j in range(1,NB-1) if sm[j]>=sm[j-1] and sm[j]>sm[j+1]],key=lambda j:-sm[j]); sel=[]
    for j in pk:
        if all(abs(j-k)>=5 for k in sel): sel.append(j)
        if len(sel)==2: break
    if len(sel)<2: continue
    a,c=sorted(sel); tj=a+int(np.argmin(sm[a:c+1])); trough=lo+(tj+0.5)*(hi-lo)/NB
    def hump_time(j): mm=(px>=edges[max(0,j-2)])&(px<edges[min(NB,j+3)]); return wmed(t[mm],vol[mm])
    ta,tc=hump_time(a),hump_time(c); first_is_low=ta<tc
    migration=1 if first_is_low else -1                       # second hump above the first = +1
    o=br[0,3]; cl=br[-1,6]; H=br[:,4].max(); L=br[:,5].min()
    closes=br[:,6]; side=np.sign(closes-trough); cross=int((side[1:]*side[:-1]<0).sum())
    hours=(br[-1,2]-br[0,1])/3600.0
    rows.append(dict(d=d,bim=J[d]['bimod'],vamid=(J[d]['val']+J[d]['vah'])/2,range_pct=100*(H-L)/o,net_pct=100*(cl-o)/o,close_loc=(cl-L)/(H-L),mig=migration,cross_per_h=cross/hours,
                     trough_loc=(trough-L)/(H-L),first_hump_gap_h=abs(ta-tc)/3600))
import pandas as pd
D=pd.DataFrame(rows); print(len(D),'sessions')
q90,q10=D.bim.quantile(.9),D.bim.quantile(.1)
B=D[D.bim>=q90]; Dd=D[(D.bim<=D.bim.quantile(.25))&(D.vamid.between(1/3,2/3))]
print('strong B (top decile of bimodality): N',len(B),'| strong D (bottom quartile bimodality, VA midpoint in the middle third): N',len(Dd))
def summ(g,name):
    print(f'{name}: median range {g.range_pct.median():.2f}% | median |net| {g.net_pct.abs().median():.2f}% | median close location {g.close_loc.median():.2f} | trough crossings per hour {g.cross_per_h.median():.2f} | hump gap {g.first_hump_gap_h.median():.1f} h | trough sits at {g.trough_loc.median():.2f} of range')
summ(B,'strong B'); summ(Dd,'strong D'); summ(D,'all sessions')
# migration-aligned net move for B: second hump above first (+1): does the day close up?
B=B.copy(); B['aligned']=B.mig*B.net_pct; print('strong B: share where net move continues in the direction of the second hump (2nd hump above/below the 1st):',round(float((B.aligned>0).mean()),2),'N',len(B),'| median aligned net %.2f%%'%B.aligned.median())
Dd=Dd.copy(); Dd['aligned']=Dd.mig*Dd.net_pct; print('strong D (same computation, for contrast):',round(float((Dd.aligned>0).mean()),2))
rng=np.random.default_rng(1)
def boot(x,y,n=4000): 
    x=np.asarray(x);y=np.asarray(y); return np.quantile([rng.choice(x,len(x)).mean()-rng.choice(y,len(y)).mean() for _ in range(n)],[.025,.975])
print('range % diff (B - D) 95% CI',boot(B.range_pct,Dd.range_pct).round(2),'| abs net % diff',boot(B.net_pct.abs(),Dd.net_pct.abs()).round(2),'| crossings/h diff',boot(B.cross_per_h,Dd.cross_per_h).round(2))
