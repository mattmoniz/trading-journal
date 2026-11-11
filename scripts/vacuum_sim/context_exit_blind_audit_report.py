"""Report for look 213 (outcome-blind audit of Argon's review). Reads the three CSVs written by context_exit_blind_audit.py."""
import os, sys, bisect
import numpy as np, pandas as pd
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'scratch', 'vacuum_sim_20261108')
ev = pd.read_csv(os.path.join(D, 'context_exit_events_20261109.csv')); se = pd.read_csv(os.path.join(D, 'context_exit_sessions_20261109.csv')); rb = pd.read_csv(os.path.join(D, 'context_exit_randombars_20261109.csv'))
out = []
def say(s=''): print(s); out.append(s)
say('=== Q1: cross-era stability (outcome-blind) ===')
for tr in ('RTH', 'GBX'):
    for c in ('replication', 'primary'):
        x = ev[(ev.corpus == c) & (ev.track == tr)]; say(f'  {tr} {c}: events {len(x)}, stop (2.5 x EMA10(TR)) median {x.stop.median():.1f} pt / ADR20 median {x.adr.median():.0f} pt -> stop/ADR20 median {(x.stop / x.adr).median():.4f}, p10 {(x.stop / x.adr).quantile(.1):.4f}, p90 {(x.stop / x.adr).quantile(.9):.4f}')
a = se[se.corpus == 'replication']; b = se[se.corpus == 'primary']
for col, lab in (('med_dur_rth', 'median RTH bar duration (s)'), ('ac1', 'lag-1 autocorrelation of 500V close increments (RTH)'), ('stop_over_adr', 'session median RTH stop/ADR20')):
    m, s = a[col].mean(), a[col].std(); z = (b[col].mean() - m) / s if s > 0 else float('nan')
    say(f'  {lab}: 2023-25 mean {m:.4f} sd {s:.4f}; 2026 mean {b[col].mean():.4f} (z of the 2026 MEAN vs the 2023-25 session distribution {z:+.2f}; share of 2026 sessions outside the 2023-25 p5-p95: {100 * ((b[col] < a[col].quantile(.05)) | (b[col] > a[col].quantile(.95))).mean():.0f} percent)')
say('\n=== Q2: rolling-60-session vs expanding 2/3 quantile of E (defined events, time order, per track) ===')
ev = ev.sort_values(['date', 't']).reset_index(drop=True); d = ev[~ev.E.isna()]
for tr in ('RTH', 'GBX'):
    x = d[d.track == tr].reset_index(drop=True); exp_c = []; roll_c = []; L = []; dates = list(x.date.unique()); first = {dt: i for i, dt in enumerate(dates)}
    for i, r in x.iterrows():
        exp_c.append(np.quantile(L, 2 / 3) if len(L) >= 30 else np.nan)
        lo = max(0, first[r.date] - 60); mask = x.date.isin(dates[lo:first[r.date]]) & (x.index < i); v = x.E[mask].values
        roll_c.append(np.quantile(v, 2 / 3) if len(v) >= 30 else np.nan); bisect.insort(L, r.E)
    exp_c = np.array(exp_c); roll_c = np.array(roll_c); ok = ~np.isnan(exp_c) & ~np.isnan(roll_c)
    say(f'  {tr}: events {ok.sum()}; rolling cutoff sd {np.std(roll_c[ok]):.4f} ADR20 (range {np.min(roll_c[ok]):+.3f}..{np.max(roll_c[ok]):+.3f}); expanding cutoff sd {np.std(exp_c[ok]):.4f} (range {np.min(exp_c[ok]):+.3f}..{np.max(exp_c[ok]):+.3f}); correlation {np.corrcoef(roll_c[ok], exp_c[ok])[0, 1]:.3f}; max |rolling - expanding| {np.max(np.abs(roll_c[ok] - exp_c[ok])):.3f}; share of events whose EXTENDED flag differs {100 * np.mean((x.E.values[ok] >= roll_c[ok]) != (x.E.values[ok] >= exp_c[ok])):.1f} percent')
say('\n=== Q4: wick (share of the signal bar range given back at the thrust end; 0 = closed on the extreme) and the stricter variants ===')
for c in ('replication', 'primary'):
    for tr in ('RTH', 'GBX'):
        x = d[(d.corpus == c) & (d.track == tr)]; xs = x.sort_values(['date', 't'])
        say(f'  {c} {tr}: events with E {len(x)}; wick quantiles p25 {x.wick.quantile(.25):.3f} p50 {x.wick.median():.3f} p75 {x.wick.quantile(.75):.3f}; share wick >= 0.25 {100 * (x.wick >= .25).mean():.1f}; share wick >= 0.5 (adverse half) {100 * (x.wick >= .5).mean():.1f}; share wick == 0 {100 * (x.wick <= 1e-9).mean():.1f}')
# stricter variant survival (expanding quantiles over ALL earlier events of the track, both corpora in time order)
for tr in ('RTH', 'GBX'):
    x = d[d.track == tr].reset_index(drop=True); L = []; q67 = []; q80 = []
    for e in x.E:
        q67.append(np.quantile(L, 2 / 3) if len(L) >= 30 else np.nan); q80.append(np.quantile(L, .8) if len(L) >= 30 else np.nan); bisect.insort(L, e)
    x['q67'] = q67; x['q80'] = q80; x = x[~x.q67.isna()]
    t67 = x.E >= x.q67; t80 = x.E >= x.q80
    say(f'  {tr} (all corpora, N {len(x)}): tercile {100 * t67.mean():.1f} percent; 80th pct {100 * t80.mean():.1f}; 80th AND wick>=0.25 {100 * (t80 & (x.wick >= .25)).mean():.1f}; 80th AND wick>=0.5 {100 * (t80 & (x.wick >= .5)).mean():.1f}; tercile AND wick>=0.25 {100 * (t67 & (x.wick >= .25)).mean():.1f}')
say('\n=== Q3: ratchet R vs 30-bar hold H on RANDOM bars with random direction (not signals) ===')
for c in ('replication', 'primary'):
    for tr in ('RTH', 'GBX'):
        x = rb[(rb.corpus == c) & (rb.track == tr)]; df = x.R - x.H
        say(f'  {c} {tr}: N {len(x)} draws; H mean {x.H.mean():+.2f} sd {x.H.std():.1f}; R mean {x.R.mean():+.2f} sd {x.R.std():.1f}; paired R-H mean {df.mean():+.2f} sd {df.std():.1f} (tape-sigma proxy used in phase 1: see below); corr(R,H) {np.corrcoef(x.R, x.H)[0, 1]:.2f}')
        say(f'      hold bars R: median {x.hold_R.median():.0f} p75 {x.hold_R.quantile(.75):.0f} p90 {x.hold_R.quantile(.9):.0f}; H median {x.hold_H.median():.0f}; bars to hard flat median {x.to_flat.median():.0f}; share R still open at flat {100 * (x.hold_R >= x.to_flat).mean():.0f} percent; corr(entry hour, bars to flat) {np.corrcoef(x.hour, x.to_flat)[0, 1]:+.2f}')
open(os.path.join(D, 'context_exit_blind_audit_output.txt'), 'w').write('\n'.join(out) + '\n')
