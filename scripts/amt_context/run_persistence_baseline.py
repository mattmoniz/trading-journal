"""Amendment 7 of PREREG_ROSTER_CONTEXT.md: how much of the no-tell forecast's skill is persistence of recent range plus the clock? BASE2 (notell2) minus PERSIST (ridge on rr15/rr30/rr60 + bucket + dow). EXPLORE only. READS OUTCOMES -> look logged first by log_look_persistence_baseline.mjs.
Usage: /home/mmoniz/trading-journal/venv/bin/python /home/mmoniz/trading-journal/scripts/amt_context/run_persistence_baseline.py"""
import sys; sys.argv = sys.argv[:1]
import numpy as np
import tell_state as TS, run_p2b as P
import model_compare as MC

def main():
    _, ctxs, _ = TS.sessions_and_contexts(); df = P.build_points(ctxs); print(f'decision points {len(df)} on {df.date.nunique()} dates')
    designs = {'base2': P.design(df, P.ACT + P.RR, ['bucket', 'dow']), 'persist': P.design(df, P.RR, ['bucket', 'dow'])}
    raw = {c: df[c].values for c in P.RR + ['A_now', 'rth_range_so_far_atr', 'overnight_range_atr']}
    R = MC.compare(df, designs, 'base2', 'persist', seed=20261102 + 23, raw=raw); r = R['r']
    print(f'\n{R["n_oos"]} out-of-sample rows on {R["n_dates"]} dates. Spearman: clock {r["clock"]:+.4f} (run_p2b +0.2628), BASE2 {r["base2"]:+.4f} (run_p2b notell2 +0.6467), PERSIST {r["persist"]:+.4f}')
    if round(r['base2'], 4) != 0.6467 or round(r['clock'], 4) != 0.2628: print('NOTE: BASE2/clock do not reproduce run_p2b exactly')
    print('raw model-free Spearman with realized E_30 (uncounted): ' + ', '.join(f'{k} {v:+.4f}' for k, v in R['raw'].items()))
    share = (r['persist'] - r['clock']) / (r['base2'] - r['clock'])
    print(f'\nAmendment 7 BASE2 - PERSIST: {R["diff"]:+.4f}  day-blocked CI [{R["ci"][0]:+.4f}, {R["ci"][1]:+.4f}]  permutation p {R["p"]:.4f}  halves {R["halves"][0]:+.4f} / {R["halves"][1]:+.4f}  -> {"PASS" if R["passed"] else "NOT PASSED"}')
    print(f'share of the (BASE2 - clock) gap already recovered by PERSIST: {share:.3f}')
    for a, b, rr in R['quarters']: print(f'  quarter {a}..{b}: clock {rr["clock"]:+.4f} PERSIST {rr["persist"]:+.4f} BASE2 {rr["base2"]:+.4f}')

if __name__ == '__main__': main()
