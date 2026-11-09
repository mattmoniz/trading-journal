"""Report for b_d_formation.py (reads scratch/tell_context_20261103/b_d_formation_rows.json; descriptive, hindsight, uncounted). Prints group counts FIRST, then median [IQR] curves per group, the first clock time B and D separate,
the order-and-side table, the crossing-and-skipping table, TPO vs volume, width at the close with a session-bootstrap CI, watcher state at checkpoints, and example dates. Usage: venv/bin/python scripts/tell_context/research_20261103/b_d_formation_report.py"""
import os, json, collections
import numpy as np
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
R = json.load(open(os.path.join(REPO, 'scratch', 'tell_context_20261103', 'b_d_formation_rows.json'))); CUT = json.load(open(os.path.join(REPO, 'scripts', 'tell_context', 'shape_cuts.json')))['bimod_top_tercile_cut']
D = sorted(R); bim = np.array([R[d]['final']['bimod'] for d in D]); q90, q25 = float(np.quantile(bim, .9)), float(np.quantile(bim, .25))
G = {'STRONG B': [d for d in D if R[d]['final']['bimod'] >= q90], 'STRONG D': [d for d in D if R[d]['final']['bimod'] <= q25 and R[d]['final']['letter'] == 'D'],
     'MULTI-HUMP': [d for d in D if R[d]['final']['bimod'] >= CUT], 'letter P': [d for d in D if R[d]['final']['letter'] == 'P'], 'letter b': [d for d in D if R[d]['final']['letter'] == 'b'], 'ALL': D}
print(f'{len(D)} sessions; strong-B cut (top decile) {q90:.2f}; strong-D = bottom quartile of bimodality (<= {q25:.2f}) with letter D; multi-hump cut {CUT}')
for g, ds in G.items(): print(f'  {g:11s} N={len(ds)}')
CP = ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30']
def q(x): x = [v for v in x if v is not None and not (isinstance(v, float) and np.isnan(v))]; return (np.quantile(x, [.25, .5, .75]) if len(x) >= 5 else None, len(x))
def curve(name, f, groups=('STRONG B', 'STRONG D', 'ALL')):
    print(f'\n{name}  (median [Q1-Q3])'); print('  time  ' + ''.join(f'{g:>26s}' for g in groups)); sep = None
    for k in CP:
        st = {g: q([f(R[d], k) for d in G[g]]) for g in groups}; cells = []
        for g in groups:
            a, n = st[g]; cells.append('n/a' if a is None else f'{a[1]:.2f} [{a[0]:.2f}-{a[2]:.2f}]')
        b_, d_ = st['STRONG B'][0], st['STRONG D'][0]
        if sep is None and b_ is not None and d_ is not None and (b_[1] > d_[2] or b_[1] < d_[0]) and (d_[1] > b_[2] or d_[1] < b_[0]): sep = k
        print(f'  {k:5s} ' + ''.join(f'{c:>26s}' for c in cells))
    print(f'  -> first checkpoint where the B and D medians are each outside the other IQR: {sep}')
dv = lambda key: (lambda r, k: r['dev'][k][key] if r['dev'].get(k) else None)
curve('Profile extent so far, % of the open', dv('ext_pct'))
curve('Profile extent so far, in units of the prior-20-session average range', lambda r, k: (r['dev'][k]['ext'] / r['adr20']) if r['dev'].get(k) and r.get('adr20') else None)
curve('Value-area width, share of the extent so far', dv('va_share'))
curve('Bimodality of the developing profile', dv('bimod'))
curve('Number of humps (>= half the biggest)', dv('humps'))
curve('Distance between the two highest peaks, % of the open', lambda r, k: 100 * r['dev'][k]['sep'] / r['open'] if r['dev'].get(k) else None)
print('\nFINAL (close) width, B minus D, session-bootstrap 95% CI of the difference in medians (uncounted, descriptive)')
rng = np.random.default_rng(7)
for name, f in (('extent % of open', lambda r: r['final']['ext_pct']), ('extent in prior-20 ranges', lambda r: r['final']['ext'] / r['adr20'] if r.get('adr20') else None), ('value-area share', lambda r: r['final']['va_share'])):
    b = np.array([v for v in (f(R[d]) for d in G['STRONG B']) if v is not None]); dd = np.array([v for v in (f(R[d]) for d in G['STRONG D']) if v is not None])
    diff = [np.median(rng.choice(b, len(b))) - np.median(rng.choice(dd, len(dd))) for _ in range(2000)]
    print(f'  {name:26s} B {np.median(b):.2f} (N={len(b)})  D {np.median(dd):.2f} (N={len(dd)})  diff {np.median(b)-np.median(dd):+.2f}  CI [{np.quantile(diff,.025):+.2f}, {np.quantile(diff,.975):+.2f}]')
def pct(ds, f): v = [f(R[d]) for d in ds]; v = [x for x in v if x is not None]; return v
print('\nWHEN a second hump (>= half the first) first appears, and when the multi-hump flag (bimodality >= cut) settles for good, minutes after 9:30 (median [IQR]; N with one)')
for key, lab in (('first_second_hump_min', 'first second hump seen'), ('flag_settled_min', 'flag settled (stays at/above cut)')):
    for g in ('STRONG B', 'STRONG D', 'MULTI-HUMP', 'ALL'):
        v = pct(G[g], lambda r: r[key]); a, n = q(v); print(f'  {lab:34s} {g:11s} N with one {n:3d}/{len(G[g]):3d}  ' + ('n/a' if a is None else f'{a[1]:.0f} [{a[0]:.0f}-{a[2]:.0f}]'))
print('\nWHERE and IN WHAT ORDER the two areas build (final two highest peaks split at the thin zone; order by the volume-weighted median time of each area; same_block = both medians in one of open-11:00 / 11:00-13:00 / 13:00-close)')
for g in ('STRONG B', 'STRONG D', 'MULTI-HUMP', 'ALL'):
    ar = [R[d]['areas'] for d in G[g] if 'areas' in R[d]]; c = collections.Counter(a['order'] for a in ar); gp = [a['gap_h'] for a in ar]
    print(f'  {g:11s} with two areas {len(ar):3d}/{len(G[g]):3d}: ' + '  '.join(f'{k} {100*v/len(ar):.0f}%' for k, v in sorted(c.items())) + f'   median gap between areas {np.median(gp):.1f} h' + f'   larger area upper {100*np.mean([a["larger"]=="upper" for a in ar]):.0f}%   thin-zone volume {100*np.median([a["vol_share_thin"] for a in ar]):.1f}%')
for g in ('STRONG B', 'STRONG D'):
    c = collections.Counter((tuple(R[d]['areas']['blocks']) ) for d in G[g] if 'areas' in R[d]); print(f'  {g} (lower-area block, upper-area block):', ', '.join(f'{a}/{b} {n}' for (a, b), n in c.most_common(5)))
print('\nVISITS and CROSSINGS (bar closes across the thirds of the final extent; crossings of the thin-zone price)')
for g in ('STRONG B', 'STRONG D', 'MULTI-HUMP', 'ALL'):
    vs = [R[d]['visits'] for d in G[g] if 'visits' in R[d]]
    print(f'  {g:11s} N={len(vs):3d} visits {np.median([v["n_visits"] for v in vs]):.0f}  swings outer third to outer third {np.median([v["swings"] for v in vs]):.0f}  middle-third share: time {100*np.median([v["mid_time_share"] for v in vs]):.0f}% bars {100*np.median([v["mid_bar_share"] for v in vs]):.0f}%  crossings {np.median([v["crossings"] for v in vs]):.0f} ({np.median([v["cross_per_h"] for v in vs]):.2f}/h)  first crossing at {np.nanmedian([v["first_cross_min"] if v["first_cross_min"] is not None else np.nan for v in vs]):.0f} min')
print('\nTRAVERSALS between the outer thirds (minutes from the last bar in one outer third to the first bar in the other): the FASTEST traversal per session and the clock time it ended (median [IQR] over sessions with one)')
for g in ('STRONG B', 'STRONG D', 'MULTI-HUMP', 'ALL'):
    vs = [R[d]['visits'] for d in G[g] if R[d].get('visits') and R[d]['visits']['trav_min']]; fast = [min(v['trav_min']) for v in vs]; allt = [x for v in vs for x in v['trav_min']]; first = [v['trav_at_min'][0] for v in vs]
    f = np.quantile(fast, [.25, .5, .75]); a = np.quantile(first, [.25, .5, .75]); print(f'  {g:11s} sessions with a traversal {len(vs):3d}/{len(G[g]):3d}  fastest {f[1]:.0f} [{f[0]:.0f}-{f[2]:.0f}] min   first traversal ends at {a[1]:.0f} [{a[0]:.0f}-{a[2]:.0f}] min after 9:30   all traversals: median {np.median(allt):.0f} min')
print('\nWHEN CAN THE MULTI-HUMP FLAG BE SEEN: developing bimodality >= the cut at the checkpoint, vs the FINAL flag (hindsight, N sessions)')
fin = {d: R[d]['final']['bimod'] >= CUT for d in D}
for k in CP:
    ok = [d for d in D if R[d]['dev'].get(k)]; on = {d: R[d]['dev'][k]['bimod'] >= CUT for d in ok}; tp = sum(on[d] and fin[d] for d in ok); nf = sum(fin[d] for d in ok); fp = sum(on[d] and not fin[d] for d in ok)
    print(f'  {k}: final-flag days already showing it {100*tp/nf:3.0f}%   of the days showing it, {100*tp/max(1,tp+fp):3.0f}% end flagged (base {100*nf/len(ok):.0f}%)   strong-B days showing it {100*np.mean([on[d] for d in G["STRONG B"] if d in on]):3.0f}%   strong-D days showing it {100*np.mean([on[d] for d in G["STRONG D"] if d in on]):3.0f}%')
print('\nTIME (TPO) vs VOLUME in the second (smaller) area: minutes after 9:30 by which 25% / 50% of its final volume and of its final TPO marks had accumulated (median)')
for g in ('STRONG B', 'STRONG D', 'ALL'):
    t = [R[d]['tpo'] for d in G[g] if 'tpo' in R[d]]
    print(f'  {g:11s} N={len(t):3d} volume 25%/50% {np.median([x["second_vol25"] for x in t]):.0f}/{np.median([x["second_vol50"] for x in t]):.0f}   TPO 25%/50% {np.median([x["second_tpo25"] for x in t]):.0f}/{np.median([x["second_tpo50"] for x in t]):.0f}   TPO and volume agree on the larger area {100*np.mean([x["agree"] for x in t]):.0f}%')
print('\nWATCHER STATE at checkpoints (share of sessions in each state; strong B / strong D)')
for k in ('11:00', '12:00', '13:00'):
    for g in ('STRONG B', 'STRONG D'):
        c = collections.Counter(R[d]['dev'][k]['state'] for d in G[g] if R[d]['dev'].get(k)); n = sum(c.values()); print(f'  {k} {g:9s} ' + '  '.join(f'{s} {100*v/n:.0f}%' for s, v in c.most_common()))
print('\nEXAMPLE DAYS for the eye (selected by the final profile, not by any outcome)')
bim_of = lambda d: R[d]['final']['bimod']
print('  strongest B :', ', '.join(sorted(G['STRONG B'], key=bim_of)[-6:]))
print('  typical D   :', ', '.join(sorted(G['STRONG D'], key=bim_of)[:3] + sorted(G['STRONG D'], key=bim_of)[-3:]))
mid = [d for d in D if q25 < bim_of(d) < CUT and R[d]['final']['letter'] == 'D']; mid = sorted(mid, key=bim_of)
print('  in between (D letter, bimodality between the D quartile and the multi-hump cut):', ', '.join(mid[::max(1, len(mid) // 6)][:6]))
