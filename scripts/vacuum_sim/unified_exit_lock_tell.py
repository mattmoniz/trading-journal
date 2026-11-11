"""Row 45, TELL arms (docs/UNIFIED_EXIT_LOCK_PREREG_20261110.md): P / K / S stop-lock arms on the 1,760 explore tell entries through the V1 replay engine (watcher_stop_lib.run_dyn); writes tell_pairs.csv. Runs in its own process because the tell
library's `shadow` module is not the vacuum detector's. Usage: ulimit -v 4000000; python3 scripts/vacuum_sim/unified_exit_lock_tell.py"""
import os, sys, csv, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, '..', 'tell_context', 'research_20261103'))
from exit_lock_common import *

# ---------------------------------------------------------------- tell arms through the V1 replay engine
def tell_pairs():
    import tell_replay_lib as TRL
    from watcher_stop_lib import run_dyn
    T = TRL.T
    ADR = load_adr(); CL = load_climaxes()
    def extra(S, allb, sig, trd, ctxf):
        ctx = S['_ctx']; d = int(trd['dir']); ei = int(trd['ei']); risk = float(trd['risk']); end_i = S['end'][sig]; date = trd['date']; o, h, l, c, end, start = S['o'], S['h'], S['l'], S['c'], S['end'], S['start']; n = len(end)
        entry = float(o[ei]) + d * T.SLIP; run = lambda sf=None, ex=None: run_dyn(ctx, T.Prof(ctx), ei, d, risk, end_i, stop_fn=sf, exit_at_sec=ex)[0]
        base = run(); out = dict(adr20=ADR.get(date), base_net=base['net'], base_pts=base['pts'], base_why=base['reason'], risk_pts=risk, ehr=float(start[ei]))
        if date not in ADR: return out
        gate = TELL_GATE * ADR[date]
        def mkP(g, f):
            def fn(j, best, stop):
                exc = d * (best - entry); return lock_price(d, entry, exc, f) if exc >= g else None
            return fn
        # same-direction climaxes: first trigger bar (a climax completing inside the bar, open gain > 0 at its close); not-fast variant for S
        cls = [(tc, fast) for tc, dr, fast in CL.get(date, []) if dr == d]; jK = jS = None
        for j in range(ei, n):
            lo_t = float(start[ei]) if j == ei else float(end[j - 1]); gain = d * (float(c[j]) - entry)
            if gain <= 0: continue
            inside = [(tc, fast) for tc, fast in cls if lo_t < tc <= float(end[j]) and tc >= float(end[ei]) - 1e-9]
            if inside and jK is None: jK = j
            if any(not fast for _, fast in inside) and jS is None: jS = j
            if jK is not None and jS is not None: break
        def mkK(j0, f=LOCK_F):
            def fn(j, best, stop):
                if j < j0: return None
                exc = d * (best - entry); return lock_price(d, entry, max(exc, 0.0), f)
            return fn
        pP = run(mkP(gate, LOCK_F)); out.update(P_net=pP['net'], P_pts=pP['pts'], P_why=pP['reason'])
        pK = run(mkK(jK)) if jK is not None else base; out.update(K_net=pK['net'], K_pts=pK['pts'], K_why=pK['reason'], K_trig=jK is not None)
        pS = run(mkP(gate, LOCK_F), float(end[jS]) if jS is not None else None); out.update(S_net=pS['net'], S_pts=pS['pts'], S_why=pS['reason'], S_trig=jS is not None)
        # descriptive: timing placebo for K (the same lock at a random in-profit completed bar of the same trade before the baseline exit), sensitivities of P
        cand = [j for j in range(ei, min(int(base['xj']), n)) if d * (float(c[j]) - entry) > 0]
        if jK is not None and cand:
            rng = np.random.default_rng(int(date.replace('-', '')) * 10000 + ei % 10000); pr = run(mkK(int(rng.choice(cand)))); out.update(Kpl_net=pr['net'])
        else: out.update(Kpl_net=base['net'])
        for nm, g, f in SENS: r = run(mkP(g * ADR[date], f)); out[f'P_{nm}_net'] = r['net']
        return out
    R, bad = TRL.replay_rows(extra)
    R = R[R.adr20.notna()].copy(); par = float(np.abs(R['base_net'] - R['csv_net']).max()); nd = int((np.abs(R['base_net'] - R['csv_net']) > 0.01).sum())
    assert nd == 0, f'tell V1 parity failed: {nd} trades differ, max {par}'
    R.to_csv(os.path.join(OUT, 'tell_pairs.csv'), index=False); return R, par


if __name__ == '__main__':
    R, par = tell_pairs(); print(f'TELL: {len(R)} explore entries on {R.date.nunique()} dates; V1 parity with the stored results: max |diff| {par:.4f}, 0 trades differ')
    for arm in ('P', 'K', 'S'):
        a = (np.abs(R[f'{arm}_net'] - R['base_net']) > 1e-9); print(f'  arm {arm}: acted (the path changed) on {int(a.sum())} trades on {R[a].date.nunique()} days' + (f'; triggers {int(R[arm + "_trig"].sum())}' if arm in ('K', 'S') else ''))
