"""Report 2 for look 215 (outcome-blind audit of Argon's follow-up). Reads the CSVs of context_exit_blind_audit.py."""
import os, bisect
import numpy as np, pandas as pd
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'scratch', 'vacuum_sim_20261108')
ev = pd.read_csv(os.path.join(D, 'context_exit_events_20261109.csv')).sort_values(['date', 't']).reset_index(drop=True); rb = pd.read_csv(os.path.join(D, 'context_exit_randombars_20261109.csv'))
out = []
def say(s=''): print(s); out.append(s)
# classify EXTENDED with the frozen expanding rule (both corpora in time order)
ev['ext'] = np.nan
for tr in ('RTH', 'GBX'):
    L = []; idx = ev.index[(ev.track == tr) & ~ev.E.isna()]
    for i in idx:
        if len(L) >= 30: ev.at[i, 'ext'] = float(ev.at[i, 'E'] >= np.quantile(L, 2 / 3))
        bisect.insort(L, ev.at[i, 'E'])
say('=== Q2: EXTENDED share and |E| by ET clock hour (frozen expanding rule; both corpora) ===')
for c in ('replication', 'primary'):
    for tr in ('RTH',):
        x = ev[(ev.corpus == c) & (ev.track == tr) & ~ev.ext.isna()]
        say(f'  {c} {tr}: ' + '; '.join(f'{h}h {100 * x[x.hour == h].ext.mean():.0f}% (N {len(x[x.hour == h])}, median|E| {x[x.hour == h].E.abs().median():.2f})' for h in sorted(x.hour.unique())))
x = ev[(ev.track == 'RTH') & ~ev.ext.isna()]; am = x[(x.hour >= 9) & (x.hour <= 11)].ext.mean(); pm = x[(x.hour >= 13)].ext.mean(); say(f'  RTH all: share EXTENDED 09:35-11:59 {100 * am:.1f}% vs 13:00-15:50 {100 * pm:.1f}% (difference {100 * (pm - am):+.1f} points)')
say('\n=== Q8: raw |ROC10| (points) at the onset of |Z_ROC10| > 2 by ET clock hour, per corpus ===')
for c in ('replication', 'primary'):
    for tr in ('RTH', 'GBX'):
        x = ev[(ev.corpus == c) & (ev.track == tr)]; g = x.groupby('hour').roc.apply(lambda v: v.abs().mean()); say(f'  {c} {tr}: ' + '; '.join(f'{h}h {v:.1f}' for h, v in g.items()) + f'; max/min across hours {g.max() / g.min():.2f}')
        if tr == 'RTH': say(f'      RTH ratio of mean |ROC10| (13:00-15:59 / 09:35-10:59): {x[x.hour >= 13].roc.abs().mean() / x[x.hour <= 10].roc.abs().mean():.2f}; events per hour: ' + ', '.join(f'{h}h {n}' for h, n in x.groupby('hour').size().items()))
say('\n=== Q4: share of thrust onsets where bar t+1 FAILS to close beyond bar t\'s extreme in the thrust direction (causal at t+1) ===')
for c in ('replication', 'primary'):
    for tr in ('RTH', 'GBX'):
        x = ev[(ev.corpus == c) & (ev.track == tr) & ~ev.fail1.isna()]; xe = x.merge(ev[['corpus', 'date', 'k', 'track', 'ext']], on=['corpus', 'date', 'k', 'track'], suffixes=('', '_y'))
        say(f'  {c} {tr}: fail share all {100 * x.fail1.mean():.1f}% (N {len(x)}); among EXTENDED {100 * xe[xe.ext_y == 1].fail1.mean():.1f}% (N {int((xe.ext_y == 1).sum())}); median duration of bar t+1 {x.dur1.median():.1f} s, p90 {x.dur1.quantile(.9):.1f} s')
say('\n=== Q3: dynamic distance after +1R (min of entry distance and 2.5 x current EMA10(TR)) vs frozen distance, RANDOM bars ===')
for c in ('replication', 'primary'):
    for tr in ('RTH', 'GBX'):
        x = rb[(rb.corpus == c) & (rb.track == tr)]
        say(f'  {c} {tr}: N {len(x)}; mean giveback (peak MFE minus realised gross) frozen {x.give_R.mean():.1f} vs dynamic {x.give_R2.mean():.1f}; mean P&L R {x.R.mean():+.2f} vs R2 {x.R2.mean():+.2f}; paired R2-R {np.mean(x.R2 - x.R):+.2f} sd {np.std(x.R2 - x.R):.1f}; hold median R {x.hold_R.median():.0f} vs R2 {x.hold_R2.median():.0f}')
say('\n=== Q1: zero-padded all-event estimator vs per-extended-event estimator, simulation on RANDOM-bar P&L (replication RTH) ===')
rng = np.random.default_rng(7); r = rb[(rb.corpus == 'replication') & (rb.track == 'RTH')].copy(); e = ev[(ev.corpus == 'replication') & (ev.track == 'RTH') & ~ev.ext.isna()]
pd_ = e.groupby('date').ext.mean(); days = sorted(r.date.unique()); pday = pd_.reindex(days).fillna(pd_.mean()).values
by = {d: r[r.date == d].H.values for d in days}
mu = float(r.H.mean())                                                    # centre the random-bar P&L so that "no effect" really is zero (raw random bars lose the 2 pt cost, which would make any skip look profitable)
def stat(flags_by_day, delta, B=150):
    allv, subv, cnt = [], [], []
    for d, f in zip(days, flags_by_day):
        h = by[d] - mu; v = -(h - np.where(f, delta, 0.0))                  # skip benefit of an extended trade = -(P&L) + delta (delta = true extra loss avoided)
        allv.append(np.where(f, v, 0.0)); subv.append(v[f]); cnt.append(len(h))
    def boot(parts, denom_all):
        m = []
        for _ in range(B):
            ix = rng.integers(0, len(days), len(days)); a = np.concatenate([parts[i] for i in ix]); n = sum(cnt[i] for i in ix) if denom_all else len(a); m.append(a.sum() / max(n, 1))
        return m
    m_all = boot(allv, True); m_sub = boot(subv, False)
    pa = np.concatenate(allv).sum() / sum(cnt); ps = np.concatenate(subv).sum() / max(sum(len(x) for x in subv), 1)
    return pa / (np.std(m_all) + 1e-9), ps / (np.std(m_sub) + 1e-9)
for delta in (0.0, 3.0, 6.0):
    za, zs, n = [], [], 80
    for _ in range(n):
        flags = [rng.random(len(by[d])) < pday[i] for i, d in enumerate(days)]; a, s = stat(flags, delta); za.append(a); zs.append(s)
    say(f'  true effect {delta:.0f} pt per extended trade: mean z all-event zero-padded {np.mean(za):.2f} vs per-extended-event {np.mean(zs):.2f}; share with z > 1.28 (one-sided 10 percent): {100 * np.mean(np.array(za) > 1.28):.0f}% vs {100 * np.mean(np.array(zs) > 1.28):.0f}%')
open(os.path.join(D, 'context_exit_blind_audit2_output.txt'), 'w').write('\n'.join(out) + '\n')
