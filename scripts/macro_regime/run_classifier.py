import sys
import datetime
import pandas as pd
import numpy as np
import json
import hashlib
import pathlib
from features import (
    compute_initial_balance_features,
    classify_session_regime,
    validate_prior_va,
    validate_et_index
)

# ==========================================
# 0. PREREGISTRATION CONFIGURATION
# ==========================================
CONFIG = {
    "min_window": 40,
    "lookback_window": 120,
    "train_ratio": 0.6,
    "volume_assignment": "close",
    "va_pct": 0.70,
    "timezone_contract": "US/Eastern or America/New_York (or tz-naive strictly representing US/Eastern wall clock)",
    "thresholds": {
        "regime_a": {"ib_percentile": 50, "vol_ratio_max": 1.0},
        "regime_b": {"ib_percentile": 65, "vol_ratio_min": 1.5},
        "regime_c": {"ib_percentile": 75, "vol_ratio_max": 0.8}
    },
    "pre_commitment_gates": {
        "bc_pct_proceed": 20.0,
        "bc_pct_underpowered": 12.0,
        "min_confirmatory_holdout_n": 80,
        "policy_under_80": "DESCRIPTIVE_ONLY_NOT_CONFIRMATORY"
    }
}


class Tee:
    """Context-safe stdout tee that always restores sys.stdout and closes the log handle."""
    def __init__(self, filename):
        self.terminal = sys.stdout
        self.log = open(filename, "w", encoding="utf-8")

    def write(self, message):
        self.terminal.write(message)
        self.log.write(message)
        self.log.flush()
        return len(message)

    def flush(self):
        self.terminal.flush()
        self.log.flush()

    def close(self):
        sys.stdout = self.terminal
        self.log.close()


def verify_or_create_prereg_lock(config: dict, lock_filename: str = "prereg.lock") -> str:
    config_hash = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
    lock_path = pathlib.Path(lock_filename)
    if lock_path.exists():
        stored = json.loads(lock_path.read_text(encoding="utf-8"))
        if stored.get("hash") != config_hash:
            raise RuntimeError(
                f"CONFIG DRIFTED FROM FROZEN PREREG ({lock_path}). "
                f"Expected {stored.get('hash')}, got {config_hash}."
            )
        print(f"Prereg verified against lock: {lock_path} (Hash: {config_hash})")
    else:
        payload = {
            "locked_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "config": config,
            "hash": config_hash
        }
        lock_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
        print(f"Prereg locked: {lock_path} (Hash: {config_hash})")
    return config_hash


# ==========================================
# 1. DEFINITIVE LOADER & t-1 DERIVATION GATE
# ==========================================
def verify_loader_integrity(
    sessions_dict: dict,
    prior_va_dict: dict,
    compute_va_fn,
    pct: float = 0.70,
):
    """
    Pre-execution gate. Contract: sessions_dict and prior_va_dict are RAW dicts (pre-preflight),
    date keys are ISO-sortable strings (or Timestamp-convertible), and prior_va_dict[d] is derived strictly from d-1.
    compute_va_fn signature: fn(session_df, pct=0.70) -> {'vah': float, 'val': float}
    """
    dates = sorted(sessions_dict.keys(), key=pd.Timestamp)
    if len(dates) < 2:
        raise RuntimeError("Need >= 2 sessions to verify loader integrity.")

    # --- 1. Timezone / session-span / IB-window assertions ---
    first = sessions_dict[dates[0]].sort_index()
    if len(first) == 0:
        raise RuntimeError(f"First session {dates[0]} is empty.")
    ib = first.between_time('09:30', '10:29')

    print("=" * 66)
    print("PRE-EXECUTION LOADER INTEGRITY CHECK")
    print("=" * 66)
    print(f"First session: {dates[0]} | tz: {first.index.tz}")
    print(f"Full span: {first.index[0]} -> {first.index[-1]} ({len(first)} bars)")
    print(f"IB slice: {len(ib)} bars | {ib.index[0] if len(ib) else 'N/A'} -> {ib.index[-1] if len(ib) else 'N/A'}")

    session_hours = (first.index[-1] - first.index[0]).total_seconds() / 3600.0
    if session_hours > 8.0:
        raise RuntimeError(
            f"Session span {session_hours:.1f}h > 8h. Expect 6.75h RTH. "
            f"If this is a 24h feed with tz-naive UTC, IB 09:30–10:29 is actually 04:30–05:29 ET."
        )
    if first.index[0].time() != datetime.time(9, 30):
        raise RuntimeError(f"First bar at {first.index[0].time()}, expected 09:30.")
    if len(ib) != 60:
        raise RuntimeError(f"IB slice returned {len(ib)} bars, expected 60.")
    if ib.index[0].time() != datetime.time(9, 30) or ib.index[-1].time() != datetime.time(10, 29):
        raise RuntimeError(f"IB slice window {ib.index[0].time()}–{ib.index[-1].time()}, expected 09:30–10:29.")

    # --- 2. Exact t-1 derivation check: recompute VA from d-1, assert equality ---
    common_keys = set(sessions_dict.keys()) & set(prior_va_dict.keys())
    if len(common_keys) < len(sessions_dict) - 1:
        raise RuntimeError(
            f"Key type mismatch: only {len(common_keys)} of {len(sessions_dict)} sessions_dict keys "
            f"found in prior_va_dict. Verify both dicts use the same key type (str vs Timestamp)."
        )

    print(f"\n--- t-1 Exact Derivation Check (all {len(dates)-1} pairs) ---")
    mismatches = []
    checked = 0
    skipped = 0
    for idx in range(1, len(dates)):
        d_prev, d_curr = dates[idx - 1], dates[idx]
        actual = prior_va_dict.get(d_curr)
        if not actual or actual.get('vah') is None or pd.isna(actual.get('vah')):
            skipped += 1
            continue
        expected = compute_va_fn(sessions_dict[d_prev], pct=pct)
        d_vah = abs(expected['vah'] - actual['vah'])
        d_val = abs(expected['val'] - actual['val'])
        checked += 1
        if d_vah > 1e-6 or d_val > 1e-6:
            mismatches.append((d_curr, d_prev, actual, expected))

    print(f"Checked {checked} pairs, skipped {skipped} (missing prior VA), mismatches {len(mismatches)}")
    if mismatches:
        print("First 5 mismatches (date, prev, actual, expected_from_prev):")
        for m in mismatches[:5]:
            print(f"  {m[0]} <- {m[1]}: actual VAH/VAL=({m[2]['vah']:.2f},{m[2]['val']:.2f}) "
                  f"vs expected=({m[3]['vah']:.2f},{m[3]['val']:.2f})")
        raise RuntimeError(
            f"t-1 DERIVATION FAILURE: {len(mismatches)}/{checked} prior-VA values do not match "
            f"recomputed VA from the strictly prior session. "
            f"Likely causes: t vs t-1 off-by-one, wrong POC method, wrong VA percentage."
        )

    print("=" * 66)


# ==========================================
# 2. MECHANICAL PRE-COMMITMENT VERDICT
# ==========================================
def evaluate_pre_commitment(bc_count: int, bc_pct: float, n_ho_cls: int, a_pct: float, d_pct: float) -> dict:
    reasons = []
    expected_ho_bc = int(round((bc_pct / 100.0) * n_ho_cls))
    
    proceed_gate = CONFIG["pre_commitment_gates"]["bc_pct_proceed"]
    underpowered_gate = CONFIG["pre_commitment_gates"]["bc_pct_underpowered"]
    min_conf_n = CONFIG["pre_commitment_gates"]["min_confirmatory_holdout_n"]
    under_80_policy = CONFIG["pre_commitment_gates"]["policy_under_80"]
    
    if bc_pct >= proceed_gate:
        verdict = "PROCEED TO PHASE 3 (EXECUTION LAYER)"
    elif bc_pct >= underpowered_gate:
        verdict = "PROCEED WITH UNDERPOWERED CAVEAT"
        reasons.append(
            f"B+C train rate {bc_pct:.2f}% is in [{underpowered_gate:.1f}%, {proceed_gate:.1f}%) band "
            f"(raw train B+C = {bc_count})"
        )
    else:
        verdict = "NEGATIVE RESULT — REDESIGN ON TRAIN, FRESH HOLDOUT REQUIRED"
        reasons.append(f"B+C train rate {bc_pct:.2f}% < {underpowered_gate:.1f}% floor (raw train B+C = {bc_count})")

    if expected_ho_bc < min_conf_n:
        if verdict.startswith("PROCEED"):
            verdict = f"{verdict} — {under_80_policy}"
        reasons.append(
            f"POWER LOCK ({under_80_policy}): Projected Hold-Out B+C sessions (~{expected_ho_bc}) < {min_conf_n} "
            f"confirmatory minimum. Hold-Out evaluation is a descriptive sanity check, not confirmatory proof."
        )

    if verdict.startswith("PROCEED"):
        reasons.append(
            "Clarification: PROCEED gates the decision to BUILD Phase 3. "
            "POWER LOCK gates the decision to INTERPRET Hold-Out results as confirmatory."
        )

    if a_pct > 80.0:
        reasons.append(f"Regime A {a_pct:.1f}% > 80% ceiling (report, do not tune)")
    if a_pct < 40.0:
        reasons.append(f"Regime A {a_pct:.1f}% < 40% floor (report, do not tune)")
    if d_pct > 50.0:
        reasons.append(f"Regime D {d_pct:.1f}% > 50% dead zone threshold (do not widen on current hold-out)")

    print("\n" + "="*75)
    print("AUTOMATED PRE-COMMITTED DECISION VERDICT")
    print("="*75)
    print(f"VERDICT: {verdict}")
    print(f"Train B+C Raw: {bc_count} | Train B+C %: {bc_pct:.2f}% | Projected Hold-Out B+C Days: ~{expected_ho_bc}")
    for r in reasons:
        print(f"  - {r}")
    if verdict.startswith("NEGATIVE"):
        print("  [!] NEGATIVE RESULT — Do not proceed to Phase 3. Fresh hold-out required for any redesign.")
    print("="*75)
    return {
        "verdict": verdict,
        "bc_count": int(bc_count),
        "bc_pct": float(bc_pct),
        "projected_holdout_bc_days": expected_ho_bc,
        "reasons": reasons
    }


# ==========================================
# 3. ROBUST PRE-FLIGHT AUDIT WITH CACHING
# ==========================================
def preflight_audit(sessions_dict: dict, prior_va_dict: dict):
    print("\n--- Running Pre-Flight Data Audit ---")
    clean_cache = {}
    drop_reasons = {
        'bad_index': 0,
        'non_et_tz': 0,
        'missing_columns': 0,
        'invalid_prior_va': 0,
        'bad_bar_count': 0,
        'zero_range': 0
    }
    required_cols = {'Open', 'High', 'Low', 'Close', 'Volume'}

    for date_str in sorted(sessions_dict.keys(), key=pd.Timestamp):
        session_df = sessions_dict[date_str]
        idx_ok, idx_reason = validate_et_index(session_df)
        if not idx_ok:
            drop_reasons[idx_reason] += 1
            continue

        if not required_cols.issubset(session_df.columns):
            drop_reasons['missing_columns'] += 1
            continue

        prior_va = prior_va_dict.get(date_str, {'vah': np.nan, 'val': np.nan})
        if not validate_prior_va(prior_va['vah'], prior_va['val']):
            drop_reasons['invalid_prior_va'] += 1
            continue

        feats = compute_initial_balance_features(
            session_df,
            prior_va['vah'],
            prior_va['val'],
            volume_assignment=CONFIG["volume_assignment"]
        )
        if feats is None:
            ib_df = session_df.sort_index().between_time('09:30', '10:29')
            if len(ib_df) != 60:
                drop_reasons['bad_bar_count'] += 1
            else:
                drop_reasons['zero_range'] += 1
            continue

        clean_cache[date_str] = (session_df, feats)

    total = len(sessions_dict)
    drop_count = total - len(clean_cache)
    drop_pct = drop_count / total if total > 0 else 0.0

    print(f"Pre-flight complete. Total raw: {total} | Clean: {len(clean_cache)} | Drop Rate: {drop_pct:.2%}")
    print(f"Drop breakdown: {drop_reasons}")

    if total > 0 and drop_reasons['bad_bar_count'] == total:
        raise RuntimeError(
            f"ALL sessions ({total}) dropped on bar count — check timestamp convention (open vs close) "
            f"or timeframe. Breakdown: {drop_reasons}"
        )
    
    if drop_pct > 0.05:
        raise RuntimeError(f"Pre-flight drop rate {drop_pct:.1%} > 5% limit — pipeline problem. Check: {drop_reasons}")

    return clean_cache


# ==========================================
# 4. SEMANTIC D-BUCKET DECOMPOSITION
# ==========================================
def why_d(row):
    if row['ib_range'] < row['p50_at_class']:
        return "small_range_vol>=1.0 (A-reject on vol)"
    if row['ib_range'] < row['p65_at_class']:
        return "moderate_range_p50-p65"
    if row['ib_range'] <= row['p75_at_class'] and row['ib_vol_ratio'] < 0.8:
        return "moderate_range_vol<0.8 (C-reject on range)"
    if row['open_location'] == 0 and row['ib_vol_ratio'] >= 1.5:
        return "open_inside (B-reject on location)"
    if row['ib_vol_ratio'] < 1.5:
        return "vol_in_[0.8, 1.5) (B/C-reject on vol)"
    return "UNEXPECTED — investigate"


# ==========================================
# 5. FULL PIPELINE EXECUTION
# ==========================================
def run_full_pipeline_audit(
    sessions_dict: dict,
    prior_va_dict: dict,
    compute_va_fn=None,
    enable_log_tee: bool = True,
    strict_mode: bool = False
):
    tee_instance = None
    if enable_log_tee:
        timestamp_str = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        log_filename = f"run_{timestamp_str}.log"
        tee_instance = Tee(log_filename)
        sys.stdout = tee_instance
        print(f"Logging stdout to {log_filename}")

    try:
        if compute_va_fn is not None:
            verify_loader_integrity(
                sessions_dict=sessions_dict,
                prior_va_dict=prior_va_dict,
                compute_va_fn=compute_va_fn,
                pct=CONFIG["va_pct"]
            )
        else:
            raise RuntimeError("compute_va_fn must be passed to run_full_pipeline_audit to prove exact t-1 VA derivation.")

        verify_or_create_prereg_lock(CONFIG)

        clean_cache = preflight_audit(sessions_dict, prior_va_dict)
        dates = sorted(list(clean_cache.keys()), key=pd.Timestamp)
        
        total_clean = len(dates)
        if total_clean < 300:
            raise RuntimeError(f"Clean session count {total_clean} < 300 minimum required.")

        train_cutoff_idx = int(total_clean * CONFIG["train_ratio"])
        train_dates = dates[:train_cutoff_idx]
        holdout_dates = dates[train_cutoff_idx:]
        
        print(f"\nSplit Structure: Total Clean = {total_clean} | Train = {len(train_dates)} | Hold-Out = {len(holdout_dates)}")

        historical_ib_ranges = []
        all_records = []
        
        for split_name, date_list in [('TRAIN', train_dates), ('HOLDOUT', holdout_dates)]:
            for date_str in date_list:
                _, features = clean_cache[date_str]
                
                regime, p50, p65, p75 = classify_session_regime(
                    current_ib_range=features['ib_range'],
                    current_vol_ratio=features['ib_vol_ratio'],
                    current_open_location=features['open_location'],
                    prior_ib_ranges=historical_ib_ranges,
                    min_window=CONFIG["min_window"],
                    lookback_window=CONFIG["lookback_window"],
                    today_already_appended=False
                )
                
                window_size = min(len(historical_ib_ranges), CONFIG["lookback_window"])
                
                all_records.append({
                    'date': date_str,
                    'split': split_name,
                    'regime': regime,
                    'ib_range': features['ib_range'],
                    'ib_vol_ratio': features['ib_vol_ratio'],
                    'open_location': features['open_location'],
                    'window_size': window_size,
                    'p50_at_class': p50,
                    'p65_at_class': p65,
                    'p75_at_class': p75
                })
                
                historical_ib_ranges.append(features['ib_range'])

        df_all = pd.DataFrame(all_records)
        
        df_train = df_all[df_all['split'] == 'TRAIN']
        df_holdout = df_all[df_all['split'] == 'HOLDOUT']
        
        ho_warmup = (df_holdout['regime'] == 'UNCLASSIFIED_WARMUP').sum()
        if ho_warmup != 0:
            raise RuntimeError(f"ROLLING CARRY-OVER BROKEN: {ho_warmup} warmup rows found in hold-out.")

        n_train_cls = int((df_train['regime'] != 'UNCLASSIFIED_WARMUP').sum())
        n_ho_cls = int((df_holdout['regime'] != 'UNCLASSIFIED_WARMUP').sum())
        classified_split_ratio = n_train_cls / (n_train_cls + n_ho_cls) if (n_train_cls + n_ho_cls) > 0 else 0.0
        
        expected_cls_ratio = (len(train_dates) - CONFIG["min_window"]) / (total_clean - CONFIG["min_window"])
        min_allowed_ratio = expected_cls_ratio - 0.02
        
        print(f"\nClassified split ratio check: train={n_train_cls}, holdout={n_ho_cls}, "
              f"ratio={classified_split_ratio:.3f} (Expected: {expected_cls_ratio:.3f})")
        if classified_split_ratio < min_allowed_ratio:
            raise RuntimeError(f"Classified split ratio {classified_split_ratio:.3f} drifted below {min_allowed_ratio:.3f}.")

        print("(Note: Hold-Out classified; frequency table withheld by prereg policy to prevent peeking.)")

        df_train_classified = df_train[df_train['regime'] != 'UNCLASSIFIED_WARMUP'].copy()

        print("\n==========================================")
        print("TRAIN SET DIAGNOSTICS & FEATURE DISTRIBUTIONS")
        print("==========================================")
        print(f"Raw Train Rows: {len(df_train)} | Warmup: {(df_train['regime']=='UNCLASSIFIED_WARMUP').sum()} | Classified Train: {len(df_train_classified)}")
        
        bc_mask = df_train_classified['regime'].isin(['REGIME_B_TREND', 'REGIME_C_MID_CONCENTRATION'])
        bc_count = int(bc_mask.sum())
        bc_pct = (bc_count / len(df_train_classified) * 100.0) if len(df_train_classified) > 0 else 0.0
        print(f"B+C Raw Count: {bc_count}")
        print(f"B+C / Classified Train ({len(df_train_classified)}): {bc_pct:.2f}%")
        print(f"B+C / Total Raw Train ({len(df_train)}): {(bc_count / len(df_train) * 100.0):.2f}%")
        
        inf_count = int((df_train_classified['ib_vol_ratio'] == np.inf).sum())
        print(f"Infinite ib_vol_ratio count: {inf_count}")

        print("\n--- Feature Distributions (Classified Train) ---")
        print("1. IB Range Percentiles (10, 25, 50, 75, 90):")
        print(np.percentile(df_train_classified['ib_range'], [10, 25, 50, 75, 90]))
        
        print("\n2. IB Vol Ratio Summary (Finite Values):")
        valid_vol = df_train_classified['ib_vol_ratio'].replace([np.inf, -np.inf], np.nan).dropna()
        print(valid_vol.describe(percentiles=[0.25, 0.5, 0.75, 0.9]))

        print("\n3. Open Location Distribution (-1=Below VAL, 0=Inside VA, +1=Above VAH):")
        print(df_train_classified['open_location'].value_counts().sort_index())

        print("\n4. Window Size Cross-Tabulation against Regime:")
        df_train_classified['ws_bucket'] = pd.cut(
            df_train_classified['window_size'],
            bins=[-1, 60, 90, 119.999, 121],
            labels=['40-60', '61-90', '91-119', '120 (full window)']
        )
        print(pd.crosstab(df_train_classified['regime'], df_train_classified['ws_bucket']))

        d_rows = df_train_classified[df_train_classified['regime'] == 'REGIME_D_UNCLASSIFIED'].copy()
        if len(d_rows) > 0:
            d_rows['d_reason'] = d_rows.apply(why_d, axis=1)
            print(f"\n5. D-Bucket Decomposition ({len(d_rows)} total D rows):")
            d_counts = d_rows['d_reason'].value_counts()
            d_pcts = (d_rows['d_reason'].value_counts(normalize=True) * 100.0).round(2)
            print(pd.DataFrame({'Count': d_counts, 'Pct_of_D (%)': d_pcts}))
        else:
            print("\n5. No D rows found in train set.")

        print("\n6. Per-Regime Clean Medians & Finite Counts:")
        df_train_classified['ib_vol_ratio_clean'] = df_train_classified['ib_vol_ratio'].replace([np.inf, -np.inf], np.nan)
        print(df_train_classified.groupby('regime')[['ib_range', 'ib_vol_ratio_clean']].agg(['median', 'count']))

        print("\n==========================================")
        print("TRAIN SET REGIME FREQUENCY TABLE")
        print("==========================================")
        counts = df_train_classified['regime'].value_counts()
        percentages = df_train_classified['regime'].value_counts(normalize=True) * 100.0
        summary_df = pd.DataFrame({'Raw Count': counts, 'Percentage (%)': percentages.round(2)})
        print(summary_df)
        print("==========================================")

        a_pct = float(percentages.get('REGIME_A_BALANCED', 0.0))
        d_pct = float(percentages.get('REGIME_D_UNCLASSIFIED', 0.0))
        verdict_dict = evaluate_pre_commitment(bc_count, bc_pct, n_ho_cls, a_pct, d_pct)

        if strict_mode and verdict_dict["verdict"].startswith("NEGATIVE"):
            raise RuntimeError(f"Strict mode abort: {verdict_dict['verdict']}")

        return df_all, verdict_dict

    finally:
        if tee_instance is not None:
            tee_instance.close()
