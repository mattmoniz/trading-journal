import json, glob, os, numpy as np
R='/home/mmoniz/trading-journal/scratch/volbars500_full_20261028'; L='/home/mmoniz/trading-journal/scratch/amt_tell_live'
J=json.load(open('/home/mmoniz/trading-journal/scratch/tell_context_20261103/shapes.json')); cut=json.load(open('/home/mmoniz/trading-journal/scratch/tell_context_20261103/cut.json'))['cut']
def paths(d):
    if d>'2025-05-16': return f'{L}/{d}.split.bars.tsv',f'{L}/{d}.split.vap.tsv'
    return f'{R}/{d}.bars.tsv',f'{R}/{d}.vap.tsv'
def wmed(tt,ww): o=np.argsort(tt); cs=np.cumsum(ww[o]); return float(tt[o][np.searchsorted(cs,cs[-1]/2)])
out={}
for d,f in J.items():
    if 'so far' in d: continue
    vam=(f['val']+f['vah'])/2
    if f['bimod']>=cut or 1/3<=vam<=2/3: continue
    letter='P' if vam>2/3 else 'b'
    pb,pv=paths(d); b=np.loadtxt(pb,delimiter='\t',ndmin=2); v=np.loadtxt(pv,delimiter='\t',ndmin=2)
    rth=(b[:,2]>=55800)&(b[:,2]<79200); end=dict(zip(b[:,0].astype(int),b[:,2])); idx=set(b[rth,0].astype(int))
    m=np.isin(v[:,0].astype(int),list(idx)); px=v[m,1]; vol=v[m,2]; t=np.array([end[int(i)] for i in v[m,0]])
    pos=(px-px.min())/(px.max()-px.min()); tail=(pos<f['val']) if letter=='P' else (pos>=f['vah']); body=(pos>=f['val'])&(pos<f['vah'])
    if tail.sum()<3 or body.sum()<3: continue
    out[d]=dict(letter=letter,hours=(wmed(t[body],vol[body])-wmed(t[tail],vol[tail]))/3600)
json.dump(out,open('/home/mmoniz/trading-journal/scratch/tell_context_20261103/order.json','w'))
h=np.array([v['hours'] for v in out.values()])
print('P/b candidates',len(out),'tail first (hours>0):',int((h>0).sum()),'late tail:',int((h<=0).sum()),'median hours',round(float(np.median(h)),1),'quartiles',np.quantile(h,[.25,.75]).round(1))
for l in 'Pb':
    hh=np.array([v['hours'] for v in out.values() if v['letter']==l]); print(l,len(hh),'tail first',int((hh>0).sum()))
