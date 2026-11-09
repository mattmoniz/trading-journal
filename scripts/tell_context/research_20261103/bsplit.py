import json, glob, os, numpy as np, pandas as pd
R='/home/mmoniz/trading-journal/scratch/volbars500_full_20261028'; NB=40
J=json.load(open('/home/mmoniz/trading-journal/scratch/tell_context_20261103/shapes.json')); cut=0.365
rows=[]
for p in sorted(glob.glob(R+'/*.bars.tsv')):
    d=os.path.basename(p)[:10]
    if d>'2025-05-16' or d not in J: continue
    b=np.loadtxt(p,delimiter='\t',ndmin=2); v=np.loadtxt(p.replace('.bars.','.vap.'),delimiter='\t',ndmin=2)
    rth=(b[:,2]>=55800)&(b[:,2]<79200)
    if rth.sum()<100: continue
    br=b[rth]; idx=set(br[:,0].astype(int)); m=np.isin(v[:,0].astype(int),list(idx)); px=v[m,1]; vol=v[m,2]
    lo,hi=px.min(),px.max(); P,_=np.histogram(px,bins=np.linspace(lo,hi+1e-9,NB+1),weights=vol); sm=P.copy()
    for j in range(1,NB-1): sm[j]=P[j-1:j+2].mean()
    pk=sorted([j for j in range(1,NB-1) if sm[j]>=sm[j-1] and sm[j]>sm[j+1]],key=lambda j:-sm[j]); sel=[]
    for j in pk:
        if all(abs(j-k)>=5 for k in sel): sel.append(j)
    big=sm[sel[0]]; n_hum=sum(1 for j in sel if sm[j]>=0.5*big)          # humps at least half the biggest
    f=J[d]; o=br[0,3]; cl=br[-1,6]; H=br[:,4].max(); L=br[:,5].min()
    tails=f['val']-(1-f['vah'])                                         # lower tail minus upper tail (fraction of range)
    letter='P' if tails>1/3 else ('b' if tails<-1/3 else 'D')           # = VA midpoint thirds
    rows.append(dict(d=d,bim=f['bimod'],n_hum=n_hum,letter=letter,range_pct=100*(H-L)/o,net_abs=abs(100*(cl-o)/o)))
D=pd.DataFrame(rows); D['B']=D.bim>=cut
print(len(D),'sessions; old B bucket',int(D.B.sum()))
Bk=D[D.B]; print('inside the B bucket, humps >= half the biggest:',Bk.n_hum.value_counts().sort_index().to_dict())
print('B bucket by the tails/POC letter:',Bk.letter.value_counts().to_dict())
for name,g in (('B, exactly 2 big humps',Bk[Bk.n_hum==2]),('B, 3+ big humps',Bk[Bk.n_hum>=3]),('not B, 2 big humps',D[(~D.B)&(D.n_hum==2)]),('not B, 1 big hump',D[(~D.B)&(D.n_hum==1)])):
    print(f'{name}: N {len(g)} | median range {g.range_pct.median():.2f}% | median |net| {g.net_abs.median():.2f}%')
