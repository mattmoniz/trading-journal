"""
Entry point for the NQ Macro-Regime Auction Classifier train-set frequency audit.
Runs the spec's pre-run checklist (6.1 VA self-test, 6.4 loader print), an independent cross-check of
compute_va_fn against the real JS computeProfile(), then run_full_pipeline_audit().
Usage (from this directory): ../../venv/bin/python run_audit.py <node_va.json>
  node crosscheck_va_node.mjs <node_va.json>   # produces the reference file first
"""
import sys
import json
import numpy as np
import pandas as pd
from loader import load_raw_sessions, build_prior_va_dict, compute_va_fn, DEFAULT_START, DEFAULT_END
from run_classifier import run_full_pipeline_audit


def main(node_json: str):
    sessions = load_raw_sessions()
    # The loader gate asserts on the FIRST session only. Trim leading sessions that cannot satisfy it
    # (series begins 2023-03-03, a partial day). Leading-edge trim only: mid-series bad sessions stay in
    # so pre-flight's drop-rate check still counts them.
    trimmed = []
    for d in sorted(sessions.keys()):
        f = sessions[d].sort_index()
        if len(f.between_time('09:30', '10:29')) == 60 and f.index[0].time() == pd.Timestamp('09:30').time():
            break
        trimmed.append(d)
        del sessions[d]
    print(f"Leading sessions trimmed (incomplete IB): {trimmed}")
    print(f"Pinned window: {DEFAULT_START} .. {DEFAULT_END} (exclusive) | sessions loaded: {len(sessions)}")

    # --- 6.1 compute_va_fn self-test ---
    first = sorted(sessions.keys())[0]
    df = sessions[first].sort_index()
    va50, va70, va90 = (compute_va_fn(df, pct=p) for p in (0.50, 0.70, 0.90))
    assert va50['vah'] <= va70['vah'] <= va90['vah'], "pct not respected on VAH (monotonicity failure)"
    assert va50['val'] >= va70['val'] >= va90['val'], "pct not respected on VAL (monotonicity failure)"
    assert va70['val'] < va70['vah'], "VAL >= VAH"
    print(f"compute_va_fn sanity OK: VAL={va70['val']:.2f}, VAH={va70['vah']:.2f}")

    # --- independent cross-check vs the real JS computeProfile() on EVERY session ---
    ref = json.load(open(node_json))
    n_cmp = n_bad = 0
    worst = 0.0
    for d, sdf in sessions.items():
        r = ref.get(d)
        if r is None:
            continue
        mine = compute_va_fn(sdf, pct=0.70)
        dv = max(abs(mine['vah'] - r['vah']), abs(mine['val'] - r['val']))
        n_cmp += 1
        worst = max(worst, dv)
        if not dv <= 1e-9:
            n_bad += 1
            if n_bad <= 5:
                print(f"  VA MISMATCH {d}: py=({mine['vah']},{mine['val']}) js=({r['vah']},{r['val']})")
    print(f"compute_va_fn vs JS computeProfile(): {n_cmp} sessions compared, {n_bad} mismatches, worst abs diff {worst:g}")
    if n_bad:
        raise RuntimeError("compute_va_fn does not reproduce the codebase's reference volume profile -- stop.")

    # --- 6.4 loader sanity print ---
    ib = df.between_time('09:30', '10:29')
    print(f"First session: {first} | IB bars: {len(ib)} (must be 60) | IB first: {ib.index[0]} | IB last: {ib.index[-1]} | tz: {df.index.tz}")

    prior_va, st = build_prior_va_dict(sessions, pct=0.70)
    print(f"Prior-VA construction: {st}")

    df_all, verdict = run_full_pipeline_audit(
        sessions_dict=sessions, prior_va_dict=prior_va, compute_va_fn=compute_va_fn,
        enable_log_tee=True, strict_mode=False)
    post_verdict_decomposition(df_all, verdict)
    df_all.to_csv('regime_labels.csv', index=False)   # consumed by phase3_c.py; hold-out rows are NOT printed anywhere
    return df_all, verdict


def post_verdict_decomposition(df_all, verdict):
    """Printed immediately under the pooled verdict (train-only; computed, never hand-typed).
    The pooled B+C headline stands; this is the structural finding that qualifies it."""
    tr = df_all[(df_all['split'] == 'TRAIN') & (df_all['regime'] != 'UNCLASSIFIED_WARMUP')]
    n = len(tr)
    nb = int((tr['regime'] == 'REGIME_B_TREND').sum())
    nc = int((tr['regime'] == 'REGIME_C_MID_CONCENTRATION').sum())
    vr = tr['ib_vol_ratio'].replace([np.inf, -np.inf], np.nan).dropna()
    p90 = float(np.percentile(vr, 90))
    p_vol = float((tr['ib_vol_ratio'] >= 1.5).mean())
    p_rng = float((tr['ib_range'] >= tr['p65_at_class']).mean())
    p_loc = float((tr['open_location'] != 0).mean())
    hist = tr[(tr['ib_range'] >= tr['p65_at_class'])]
    lines = [
        "POST-VERDICT STRUCTURAL FINDING (train only; pooled headline above is unchanged)",
        f"  Headline: B+C = {nb + nc}/{n} = {100.0 * (nb + nc) / n:.2f}%  |  verdict: {verdict['verdict']}",
        f"  Note: {nc}/{nb + nc} B+C sessions are Regime C; Regime B = {nb} sessions ({100.0 * nb / n:.2f}%).",
        f"  Regime B's vol-ratio floor (1.5) is above the train p90 of ib_vol_ratio ({p90:.3f}); {100.0 * p_vol:.1f}% of train sessions reach it.",
        f"  B condition marginals (train): vol>=1.5 {100.0 * p_vol:.1f}% | ib_range>=p65 {100.0 * p_rng:.1f}% | open_location!=0 {100.0 * p_loc:.1f}%"
        f"  | independence product {100.0 * p_vol * p_rng * p_loc:.2f}% vs observed {100.0 * nb / n:.2f}%",
        f"  Among ib_range>=p65 sessions (N={len(hist)}), vol>=1.5 reached by {100.0 * float((hist['ib_vol_ratio'] >= 1.5).mean()):.1f}%.",
        "  B is structurally under-armed as specified: a null result by construction, not an empirical outcome.",
        "  The pooled gate passed on C's sample alone; it is a false positive for B. See prereg_retrospective_20261027.md.",
    ]
    txt = "\n".join(lines)
    print("\n" + txt)
    open('post_verdict_decomposition.txt', 'w').write(txt + "\n")


if __name__ == '__main__':
    main(sys.argv[1])
