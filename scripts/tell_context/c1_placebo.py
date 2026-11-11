"""C1 S3 (docs/TELL_LIVE_GAP_C1_PREREG_20261110.md): time placebo. For each real trade (live book on dates with saved live bars, or explore) draw a random completed bar in the SAME session and the SAME clock hour as the real entry (outside the 09:30-09:35 dead zone, before the flat time), a random direction, and the trade's own stop distance; run the V1 management (run_dyn). One placebo set = one draw per trade; mean net per trade per set; N sets.
Stages: live (live window; parity of own-entry replay is descriptive) | explore (baseline; use PLACEBO_SETS). Usage: ulimit -v 4000000; python3 scripts/tell_context/c1_placebo.py live"""
import os, sys, glob, json
import numpy as np, pandas as pd
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')); sys.path.insert(0, os.path.join(REPO, 'scripts', 'tell_context', 'research_20261103'))
import tell_replay_lib as TRL
from watcher_stop_lib import run_dyn
T, V = TRL.T, TRL.V
OUT = os.path.join(REPO, 'scratch', 'tell_live_gap_c1_20261110'); os.makedirs(OUT, exist_ok=True)
def ctx_for(sess, stats, ks, d):
    i = ks.index(d)
    if i < 20: return None
    prior = ks[i - 20:i]; rngs = [stats[p][0] for p in prior if not np.isnan(stats[p][0])]
    if len(rngs) < 15: return None
    base = {h: float(np.mean([stats[p][1][h] for p in prior if h in stats[p][1]])) for h in range(24) if sum(h in stats[p][1] for p in prior) >= 15}
    return T.prep(sess[d], float(np.mean(rngs)), base)
def ea_sec(ea, d):
    t = pd.Timestamp(ea); d0 = pd.Timestamp(d) - pd.Timedelta(days=1) + pd.Timedelta(hours=18); return float((t - d0).total_seconds())
def placebo_sets(trades, sess, stats, ks, nsets, seed):
    """trades: DataFrame(date, ea_sec, risk, own_dir, ea) -> array (nsets,) of means, plus the own-entry replay mean."""
    rng = np.random.default_rng(seed); per = []; ctxs = {}
    for _, t in trades.iterrows():
        d = t['date']
        if d not in ctxs: ctxs[d] = ctx_for(sess, stats, ks, d)
        ctx = ctxs[d]
        if ctx is None: continue
        S = ctx['S']; st = np.asarray(S['start']); n = ctx['n']; hour0 = np.floor(t['ea_sec'] / 3600.0) * 3600.0
        cand = [j for j in range(n - 2) if hour0 <= st[j] < hour0 + 3600.0 and st[j] < T.FLAT_S - 600.0 and not (55800.0 <= st[j] < 56100.0)]
        if not cand: continue
        per.append((ctx, np.array(cand), float(t['risk'])))
    out = np.empty(nsets)
    for s in range(nsets):
        v = []
        for ctx, cand, risk in per:
            S = ctx['S']; j = int(rng.choice(cand)); d = int(rng.choice([-1, 1])); v.append(run_dyn(ctx, T.Prof(ctx), j + 1, d, risk, S['end'][j])[0]['net'])
        out[s] = np.mean(v)
    return out, len(per)
def main(stage):
    if stage == 'live':
        root = os.path.join(REPO, 'scratch', 'tell_live_gap_c1_bars'); lv = pd.read_csv(os.path.join(REPO, 'scratch', 'tell_live_gap_c1_live_book_20261110.csv'))
        ks_all = sorted(os.path.basename(p)[:10] for p in glob.glob(root + '/*.bars.tsv')); lv = lv[lv.d.isin(ks_all)].copy(); print(f'live trades with saved live bars: {len(lv)} on {lv.d.nunique()} dates; their own model mean {lv.net.mean():+.2f}')
        sess, stats = TRL._load(root, ks_all); ks = sorted(sess); trades = pd.DataFrame(dict(date=lv.d.values, ea_sec=[ea_sec(a, d) for a, d in zip(lv.ea, lv.d)], risk=lv.risk.values))
        nsets = int(os.environ.get('PLACEBO_SETS', 200)); pm, used = placebo_sets(trades, sess, stats, ks, nsets, 20261110)
        lm = float(lv.net.mean()); print(f'PLACEBO (live window; {used} trades used, {nsets} sets): mean per trade 5th/50th/95th {np.percentile(pm, 5):+.1f} / {np.percentile(pm, 50):+.1f} / {np.percentile(pm, 95):+.1f}; live tell mean {lm:+.2f} is at percentile {np.mean(pm <= lm):.3f}')
        json.dump(dict(placebo=pm.tolist(), live_mean=lm, used=used), open(os.path.join(OUT, 'placebo_live.json'), 'w'))
    else:
        ex = pd.read_csv(os.path.join(REPO, 'scratch', 'unified_exit_lock_20261110', 'tell_pairs.csv')); ex = ex[ex.adr20.notna()].copy(); ex = ex.assign(ea_sec=ex['ehr'], risk=ex['risk_pts'])
        sess, stats = TRL._load(TRL.EXPL_ROOT, sorted(os.path.basename(p)[:10] for p in glob.glob(TRL.EXPL_ROOT + '/*.bars.tsv') if os.path.basename(p)[:10] <= '2025-05-16')); ks = sorted(sess)
        nsets = int(os.environ.get('PLACEBO_SETS', 20)); pm, used = placebo_sets(ex[['date', 'ea_sec', 'risk']], sess, stats, ks, nsets, 20261111)
        print(f'PLACEBO (explore; {used} trades used, {nsets} sets): mean per trade 5th/50th/95th {np.percentile(pm, 5):+.1f} / {np.percentile(pm, 50):+.1f} / {np.percentile(pm, 95):+.1f}; explore tell mean {ex.base_net.mean():+.2f}')
        json.dump(dict(placebo=pm.tolist(), tell_mean=float(ex.base_net.mean()), used=used), open(os.path.join(OUT, 'placebo_explore.json'), 'w'))
if __name__ == '__main__': main(sys.argv[1] if len(sys.argv) > 1 else 'live')
