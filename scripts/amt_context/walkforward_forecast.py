"""Shared walk-forward forecast for the study scripts (PREREG_ROSTER_CONTEXT.md Amendment 3: the NO-TELL model). Extracted from the block that run_p3.py / run_tell_target.py / run_stop_scale.py each carry a copy of (cv-079);
those older scripts are unchanged (their recorded results stand), new scripts import this one.
Model: ridge on log E_30 over the activity design `run_p3.dm` (clock bucket, day of week, A_now, rth range so far, overnight range, minutes since open, rr15/30/60); alpha by the time-ordered inner CV in run_p2b;
refit every STEP dates; a row in block `blk` is scored by the model trained on the `build_points` rows of the dates strictly BEFORE `dates[blk]`. No outcome is read here except the training label E30 of earlier dates."""
import sys; sys.argv = sys.argv[:1]
import numpy as np, pandas as pd
import run_p2b as P
from run_p3 import dm, FIRST_TRAIN, STEP


def training_points(ctxs):
    """(df, dates): the 30-minute-complete grid points of every explore session, and the sorted ctx dates (block positions index into `dates`)."""
    df = P.build_points(ctxs, horizons=(30,)); df = df[df['full30']].reset_index(drop=True)
    return df, [str(x) for x in sorted(ctxs)]


def block_of(pos):
    """refit block of the date at position `pos` in `dates` (None while still in the first-train stretch)."""
    return None if pos < FIRST_TRAIN else FIRST_TRAIN + ((pos - FIRST_TRAIN) // STEP) * STEP


def block_forecasts(df, dates, R):
    """log E_30 forecast (ATR units, log scale) for each row of R. R needs `blk` plus the raw model inputs (forecast_features.CONT, `bucket`, `dow`)."""
    lf = np.full(len(R), np.nan)
    for blk in sorted(R.blk.unique()):
        tr = df[df.date.isin(dates[:blk])]; Xtr = dm(tr); ytr = np.log(np.maximum(tr['E30'].values, 1e-4)); sel = (R.blk == blk).values
        Z, Zte = P.standardize(Xtr, dm(R[sel])); a = P.choose_alpha(Z, ytr, tr['date'].values); ym = ytr.mean()
        lf[sel] = Zte @ P.ridge_solve(Z.T @ Z, Z.T @ (ytr - ym), a) + ym
    return lf


def expanding_cutoffs(f, seed_n, qs=(1 / 3, 2 / 3)):
    """causal cutoffs: for row k the quantiles of the forecasts of rows [:k] (rows before seed_n only seed them -> NaN). Rows must be in chronological order."""
    out = [np.full(len(f), np.nan) for _ in qs]
    for k in range(seed_n, len(f)):
        v = np.quantile(f[:k], qs)
        for j in range(len(qs)): out[j][k] = v[j]
    return out
