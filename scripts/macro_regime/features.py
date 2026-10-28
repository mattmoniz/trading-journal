import numpy as np
import pandas as pd

# ==========================================
# 1. SHARED VALIDATION & EX-ANTE FEATURES
# ==========================================

# Strictly DST-aware IANA/pytz Eastern zones (fixed-offset EDT/EST excluded)
ALLOWED_ET_TZS = {"US/Eastern", "America/New_York"}


def validate_prior_va(prior_vah: float, prior_val: float) -> bool:
    """Shared strict predicate for VAH/VAL validity across pre-flight and features."""
    if pd.isna(prior_vah) or pd.isna(prior_val):
        return False
    if prior_vah <= 0 or prior_val <= 0:
        return False
    if prior_vah <= prior_val:
        return False
    return True


def validate_et_index(session_df: pd.DataFrame) -> tuple:
    """
    Validates that the DataFrame index is a DatetimeIndex and either tz-naive (assumed ET by contract)
    or explicitly localized to US/Eastern or America/New_York.
    Returns: (is_valid: bool, reason: str)
    """
    if not isinstance(session_df.index, pd.DatetimeIndex):
        return False, "bad_index"
    if session_df.index.tz is not None:
        if str(session_df.index.tz) not in ALLOWED_ET_TZS:
            return False, "non_et_tz"
    return True, "ok"


def compute_initial_balance_features(
    session_df: pd.DataFrame,
    prior_vah: float,
    prior_val: float,
    volume_assignment: str = "close"
) -> dict:
    """
    Computes strict ex-ante macro features using ONLY the Initial Balance window (09:30:00 to 10:29:59 ET).
    Contract: tz-naive DatetimeIndex is assumed to be in US/Eastern (ET) wall-clock time.
    """
    if not validate_prior_va(prior_vah, prior_val):
        return None

    idx_ok, _ = validate_et_index(session_df)
    if not idx_ok:
        return None

    required_cols = {'Open', 'High', 'Low', 'Close', 'Volume'}
    if not required_cols.issubset(session_df.columns):
        raise ValueError(f"Missing required columns. Found: {session_df.columns.tolist()}")

    ib_df = session_df.sort_index().between_time('09:30', '10:29')
    
    if len(ib_df) != 60:
        return None

    ib_high = ib_df['High'].max()
    ib_low = ib_df['Low'].min()
    ib_range = ib_high - ib_low

    if ib_range <= 0:
        return None

    q_step = ib_range / 4.0
    q1_top = ib_low + q_step
    q3_top = ib_low + (3 * q_step)

    if volume_assignment == "close":
        ref_price = ib_df['Close']
    elif volume_assignment == "tp":
        ref_price = (ib_df['High'] + ib_df['Low'] + ib_df['Close']) / 3.0
    else:
        raise ValueError(f"Unknown volume_assignment: {volume_assignment}")

    outer_mask = (ref_price <= q1_top) | (ref_price >= q3_top)
    
    vol_q1_q4 = ib_df.loc[outer_mask, 'Volume'].sum()
    vol_q2_q3 = ib_df.loc[~outer_mask, 'Volume'].sum()

    ib_vol_ratio = float(vol_q1_q4 / vol_q2_q3) if vol_q2_q3 > 0 else np.inf

    open_price = ib_df.iloc[0]['Open']
    if open_price > prior_vah:
        open_location = 1
    elif open_price < prior_val:
        open_location = -1
    else:
        open_location = 0

    return {
        'ib_range': float(ib_range),
        'ib_vol_ratio': ib_vol_ratio,
        'open_location': int(open_location)
    }


# ==========================================
# 2. EXHAUSTIVE SESSION TYPOLOGY CLASSIFIER
# ==========================================

def classify_session_regime(
    current_ib_range: float,
    current_vol_ratio: float,
    current_open_location: int,
    prior_ib_ranges: list,
    min_window: int = 40,
    lookback_window: int = 120,
    today_already_appended: bool = False
) -> tuple:
    """
    Classifies a session into Regime A, B, C, or D (Unclassified) using strictly 
    trailing rolling percentiles of IB_Range itself.
    Returns: (regime_str, p50, p65, p75) computed at classification time.
    """
    if today_already_appended:
        raise ValueError("Contract violation: today_already_appended must be False when classifying.")

    if len(prior_ib_ranges) < min_window:
        return 'UNCLASSIFIED_WARMUP', np.nan, np.nan, np.nan

    window_data = prior_ib_ranges[-lookback_window:]
    
    p50_ib = float(np.percentile(window_data, 50))
    p65_ib = float(np.percentile(window_data, 65))
    p75_ib = float(np.percentile(window_data, 75))

    if current_ib_range < p50_ib and current_vol_ratio < 1.0:
        regime = 'REGIME_A_BALANCED'
    elif current_ib_range >= p65_ib and current_open_location != 0 and current_vol_ratio >= 1.5:
        regime = 'REGIME_B_TREND'
    elif current_ib_range > p75_ib and current_vol_ratio < 0.8:
        regime = 'REGIME_C_MID_CONCENTRATION'
    else:
        regime = 'REGIME_D_UNCLASSIFIED'

    return regime, p50_ib, p65_ib, p75_ib
