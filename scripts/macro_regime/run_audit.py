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
    return df_all, verdict


if __name__ == '__main__':
    main(sys.argv[1])
