"""Prefix-invariance PARITY for tell_state.state_at (the marks-framework pattern, docs/MARKS_BUILD_FRAMEWORK_20261029.md): the state at time ts computed from ONLY the bars up to ts must equal the state computed on the
full session. Plus MUTATION tests: two deliberately leaky variants must be caught, otherwise the harness proves nothing.  Usage: ../../venv/bin/python parity_state.py [--sessions N] [--cuts K]   exit 1 on any violation or an uncaught mutation."""
import sys, argparse, math
import numpy as np
import tell_state as TS, trade as T

def same(a, b):
    if a is None or b is None: return a is b
    if isinstance(a, float) or isinstance(b, float):
        return (a is None) == (b is None) and (math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-9) or (math.isnan(a) and math.isnan(b)))
    return a == b

def diff(sa, sb):
    if sa is None or sb is None: return [] if sa is sb else ['presence']
    bad = [k for k in set(sa) | set(sb) if k not in sa or k not in sb or not same(sa[k], sb[k])]
    return sorted(bad)

def cut_times(S, K):
    """K clock times spread over 09:35-14:30, each at a completed bar's end so the cut lands on a real bar boundary, plus mid-bar times (+17 s) to exercise the age field."""
    e = S['end']; ok = np.where(S['comp'] & (e >= TS.STATE_FROM + 300) & (e <= 73800))[0]
    if len(ok) < K: return []
    pick = ok[np.linspace(0, len(ok) - 1, K).astype(int)]
    return [float(e[i]) for i in pick] + [float(e[i]) + 17.0 for i in pick[::3]]

def run(n_sessions, K, mutate=None):
    sess, ctxs, inputs = TS.sessions_and_contexts(); ks = sorted(ctxs); pool = ks[::max(1, len(ks) // n_sessions)][:n_sessions]
    checked = 0; violations = []; fast_flags = {}
    for d in pool:
        S, ctx = sess[d], ctxs[d]
        full_ctx = ctx
        if mutate == 'leaky_overnight': full_ctx = dict(ctx); full_ctx['onh'] = float(S['h'].max()); full_ctx['onl'] = float(S['l'].min())   # the research overnight range taken over the WHOLE session
        for ts in cut_times(S, K):
            i0 = int(np.where(S['comp'] & (S['end'] <= ts))[0][-1])
            atr, base = inputs[d]; pctx = T.prep(TS.prefix_session(S, i0), atr, base)
            if pctx is None: continue
            got = TS.state_at(pctx, ts); want = TS.state_at(full_ctx, ts, leak=2 if mutate == 'leak_2min' else 0)
            if mutate is None:
                fl = fast_flags.setdefault(d, TS.bar_flags(full_ctx)); bad_fast = diff(TS.state_at(full_ctx, ts, flags=fl), want)
                if bad_fast: violations.append((d, ts, ['fast_path:' + k for k in bad_fast]))
            checked += 1; bad = diff(got, want)
            if bad: violations.append((d, ts, bad))
    return checked, violations

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--sessions', type=int, default=60); ap.add_argument('--cuts', type=int, default=12); a = ap.parse_args()
    n, v = run(a.sessions, a.cuts); print(f'REAL: {n} cut points on {a.sessions} sessions, violations {len(v)}', v[:3])
    fail = bool(v)
    for m in ('leak_2min', 'leaky_overnight'):
        n2, v2 = run(max(8, a.sessions // 4), a.cuts, mutate=m); caught = len(v2) > 0
        print(f'MUTATION {m}: {n2} cut points, violations {len(v2)} -> {"CAUGHT" if caught else "NOT CAUGHT (harness is blind)"}'); fail |= not caught
    print('PARITY OK' if not fail else 'PARITY FAILED'); sys.exit(1 if fail else 0)
