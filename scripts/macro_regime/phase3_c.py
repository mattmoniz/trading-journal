"""
Phase 3, Regime C only: trigger/exit/friction backtest. Rules and every open detail are frozen in
PHASE3_C_PREREG.md and PHASE3_CONFIG (hashed into phase3_c.lock on first run; drift raises).
Research backtest only; nothing here touches live code or order placement.
"""
import sys, json, hashlib, pathlib, datetime
import numpy as np
import pandas as pd

PHASE3_CONFIG = {
    "regime": "REGIME_C_MID_CONCENTRATION",
    "ib_window": ["09:30", "10:29"],
    "vol_ma_bars": 20, "reclaim_window_bars": 5, "atr_bars": 14,
    "stop_atr_mult": 0.75, "min_rr": 1.0,
    "tick": 0.25, "slippage_ticks_per_side": 1,
    "last_entry_bar": "15:57", "flatten_bar": "15:58",
    "max_trades_per_direction": 1, "max_trades_per_day": 2,
    "dollars_per_point": 2.0, "commission_rt": 2.0, "commission_rt_sensitivity": 4.0,
    "placebo_trials": 200, "bootstrap_iters": 5000, "seed": 20261027,
}
C = PHASE3_CONFIG
TICK = C["tick"]
SLIP = C["slippage_ticks_per_side"] * TICK


def verify_or_create_lock(lock="phase3_c.lock"):
    h = hashlib.sha256(json.dumps(C, sort_keys=True).encode()).hexdigest()
    p = pathlib.Path(lock)
    if p.exists():
        if json.loads(p.read_text())["hash"] != h:
            raise RuntimeError("PHASE3 CONFIG DRIFTED FROM FROZEN PREREG")
        print(f"Phase 3 prereg verified against lock (hash {h[:12]})")
    else:
        p.write_text(json.dumps({"locked_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                 "config": C, "hash": h}, indent=2, sort_keys=True))
        print(f"Phase 3 prereg locked (hash {h[:12]})")


def _hm(ts):
    return ts.hour * 60 + ts.minute


def simulate_exit(arr, i0, direction, stop, target, entry_fill, slip=SLIP):
    """arr: dict of numpy arrays (minute, open, high, low, close). i0 = entry bar index (entry at its open).
    direction +1 long / -1 short. Returns (exit_price_after_slippage, reason, exit_index)."""
    last_entry = int(C["last_entry_bar"][:2]) * 60 + int(C["last_entry_bar"][3:])
    flat = int(C["flatten_bar"][:2]) * 60 + int(C["flatten_bar"][3:])
    n = len(arr['minute'])
    for i in range(i0, n):
        m = arr['minute'][i]
        if m >= flat:
            return arr['open'][i] - direction * slip, 'FLATTEN', i
        o, h, l = arr['open'][i], arr['high'][i], arr['low'][i]
        if direction == -1:                       # short: stop above, target below
            if i > i0 and o >= stop:
                return o + slip, 'STOP', i
            if h >= stop:
                return stop + slip, 'STOP', i
            if i > i0 and o <= target:
                return o + slip, 'TARGET', i
            if l <= target:
                return target + slip, 'TARGET', i
        else:                                     # long: stop below, target above
            if i > i0 and o <= stop:
                return o - slip, 'STOP', i
            if l <= stop:
                return stop - slip, 'STOP', i
            if i > i0 and o >= target:
                return o - slip, 'TARGET', i
            if h >= target:
                return target - slip, 'TARGET', i
    return arr['close'][n - 1] - direction * slip, 'FLATTEN', n - 1


def find_signals(df):
    """Yield completed reclaim signals for one session in time order. df: tz-naive ET minute index."""
    ib = df.between_time(*C["ib_window"])
    ib_high, ib_low = ib['High'].max(), ib['Low'].min()
    full = df.sort_index()
    arr = {k: full[c].to_numpy(float) for k, c in
           (('open', 'Open'), ('high', 'High'), ('low', 'Low'), ('close', 'Close'), ('volume', 'Volume'))}
    arr['minute'] = np.array([_hm(t) for t in full.index])
    start = int(np.argmax(arr['minute'] >= 10 * 60 + 30)) if (arr['minute'] >= 10 * 60 + 30).any() else len(arr['minute'])
    prev_close = np.concatenate([[np.nan], arr['close'][:-1]])
    tr = np.maximum(arr['high'] - arr['low'], np.maximum(np.abs(arr['high'] - prev_close), np.abs(arr['low'] - prev_close)))
    signals = []
    state, ep_side, ep_start, ep_ok = 'inside', 0, None, False
    i = start
    n = len(arr['minute'])
    while i < n:
        c = arr['close'][i]
        side = 1 if c > ib_high else (-1 if c < ib_low else 0)
        if state == 'inside':
            if side != 0:
                state, ep_side, ep_start = 'outside', side, i
                ep_ok = i >= C["vol_ma_bars"] and arr['volume'][i] < arr['volume'][i - C["vol_ma_bars"]:i].mean()
        else:
            if side == 0:                                   # closed back inside
                if ep_ok and 1 <= i - ep_start <= C["reclaim_window_bars"]:
                    j0 = ep_start
                    sweep = arr['high'][j0:i + 1].max() if ep_side == 1 else arr['low'][j0:i + 1].min()
                    atr = tr[i - C["atr_bars"] + 1:i + 1].mean()
                    signals.append(dict(reclaim_idx=i, direction=-ep_side, sweep=float(sweep), atr=float(atr)))
                state = 'inside'
            elif side != ep_side:                           # jumped to the opposite side: failed, new episode
                state, ep_side, ep_start = 'outside', side, i
                ep_ok = i >= C["vol_ma_bars"] and arr['volume'][i] < arr['volume'][i - C["vol_ma_bars"]:i].mean()
        i += 1
    return signals, arr, ib_high, ib_low


def trade_session(df, date):
    """All taken trades for one session under the frozen rules."""
    signals, arr, ib_high, ib_low = find_signals(df)
    last_entry = int(C["last_entry_bar"][:2]) * 60 + int(C["last_entry_bar"][3:])
    trades, per_dir, busy_until = [], {1: 0, -1: 0}, -1
    for s in signals:
        e = s['reclaim_idx'] + 1
        if e >= len(arr['minute']) or arr['minute'][e] > last_entry:
            continue
        if e <= busy_until or len(trades) >= C["max_trades_per_day"] or per_dir[s['direction']] >= C["max_trades_per_direction"]:
            continue
        d = s['direction']
        entry = arr['open'][e] + d * SLIP
        if d == -1:
            stop = np.ceil((s['sweep'] + C["stop_atr_mult"] * s['atr']) / TICK) * TICK
            target = ib_low
            ok = stop > entry > target
            rr = (entry - target) / (stop - entry) if ok else np.nan
        else:
            stop = np.floor((s['sweep'] - C["stop_atr_mult"] * s['atr']) / TICK) * TICK
            target = ib_high
            ok = stop < entry < target
            rr = (target - entry) / (entry - stop) if ok else np.nan
        if not ok or not rr >= C["min_rr"]:
            continue
        px, reason, xi = simulate_exit(arr, e, d, stop, target, entry)
        pts = (px - entry) * d
        risk = abs(entry - stop)
        trades.append(dict(date=date, dir=d, entry_idx=e, entry=float(entry), stop=float(stop), target=float(target),
                           exit=float(px), reason=reason, pts=float(pts), risk_pts=float(risk), rr=float(rr),
                           open_raw=float(arr['open'][e])))
        per_dir[d] += 1
        busy_until = xi
    return trades, arr


# ==========================================
# Evaluation (frozen in PHASE3_C_PREREG.md)
# ==========================================
def dollars(t, comm):
    return t['pts'] * C["dollars_per_point"] - comm


def by_day(trades, comm):
    g = {}
    for t in trades:
        g.setdefault(t['date'], []).append(dollars(t, comm))
    return {d: np.array(v) for d, v in g.items()}


def day_blocked_ci(groups, rng, iters):
    keys = list(groups)
    arrs = [groups[k] for k in keys]
    means = np.empty(iters)
    for b in range(iters):
        idx = rng.integers(0, len(arrs), len(arrs))
        means[b] = np.concatenate([arrs[j] for j in idx]).mean()
    return float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))


def summarize(trades, comm, rng, label):
    if not trades:
        print(f"  {label}: 0 trades")
        return None
    pnl = np.array([dollars(t, comm) for t in trades])
    groups = by_day(trades, comm)
    lo, hi = day_blocked_ci(groups, rng, C["bootstrap_iters"])
    r = np.array([t['pts'] / t['risk_pts'] for t in trades])
    day_tot = sorted(((v.sum(), d) for d, v in groups.items()), reverse=True)
    top5 = sum(x for x, _ in day_tot[:5])
    mix = pd.Series([t['reason'] for t in trades]).value_counts(normalize=True) * 100.0
    print(f"  {label}: N={len(trades)} days={len(groups)} WR={100.0 * (pnl > 0).mean():.1f}% "
          f"mean=${pnl.mean():.2f}/trade (sum/N) meanR={r.mean():.3f} total=${pnl.sum():.2f}")
    print(f"     day-blocked 95% CI of mean $/trade: [{lo:.2f}, {hi:.2f}] | median=${np.median(pnl):.2f} | "
          f"top-5-days P&L=${top5:.2f} of total ${pnl.sum():.2f}")
    print(f"     exits: " + ", ".join(f"{k} {v:.0f}%" for k, v in mix.items()) +
          f" | dir: long {sum(t['dir'] == 1 for t in trades)} short {sum(t['dir'] == -1 for t in trades)}")
    return dict(n=len(trades), mean=float(pnl.mean()), lo=lo, hi=hi)


def placebo(trades, arrs, rng):
    """Same entry bar/price, stop distance and target distance in points; random direction. Returns trial means ($)."""
    means = []
    for _ in range(C["placebo_trials"]):
        pnl = []
        for t in trades:
            d = 1 if rng.random() < 0.5 else -1
            sd, td = abs(t['entry'] - t['stop']), abs(t['target'] - t['entry'])
            entry = t['open_raw'] + d * SLIP
            stop, target = entry - d * sd, entry + d * td
            px, _, _ = simulate_exit(arrs[t['date']], t['entry_idx'], d, stop, target, entry)
            pnl.append((px - entry) * d * C["dollars_per_point"] - C["commission_rt"])
        means.append(np.mean(pnl))
    return np.array(means)


def delta_ci(c_tr, n_tr, comm, rng):
    gc, gn = by_day(c_tr, comm), by_day(n_tr, comm)
    days = [(d, 'c', v) for d, v in gc.items()] + [(d, 'n', v) for d, v in gn.items()]
    out = []
    for _ in range(C["bootstrap_iters"]):
        idx = rng.integers(0, len(days), len(days))
        c = [days[j][2] for j in idx if days[j][1] == 'c']
        n = [days[j][2] for j in idx if days[j][1] == 'n']
        if c and n:
            out.append(np.concatenate(c).mean() - np.concatenate(n).mean())
    pc = np.mean([dollars(t, comm) for t in c_tr]); pn = np.mean([dollars(t, comm) for t in n_tr])
    return float(pc - pn), float(np.percentile(out, 2.5)), float(np.percentile(out, 97.5))


def main():
    from loader import load_raw_sessions
    from run_classifier import Tee
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    tee = Tee(f"phase3_c_run_{ts}.log")
    sys.stdout = tee
    try:
        verify_or_create_lock()
        labels = pd.read_csv('regime_labels.csv', dtype={'date': str})
        labels = labels[labels['regime'] != 'UNCLASSIFIED_WARMUP']
        sessions = load_raw_sessions()
        missing = set(labels['date']) - set(sessions)
        if missing:
            raise RuntimeError(f"labels without sessions: {sorted(missing)[:5]}")
        rng = np.random.default_rng(C["seed"])
        all_tr, arrs = [], {}
        for _, row in labels.iterrows():
            tr, arr = trade_session(sessions[row['date']], row['date'])
            arrs[row['date']] = arr
            for t in tr:
                t['regime'], t['split'] = row['regime'], row['split']
            all_tr += tr
        print(f"Engine ran on {len(labels)} classified sessions; {len(all_tr)} trades across all regimes (A/B/C/D).")
        for split in ('TRAIN', 'HOLDOUT'):
            lab = labels[labels['split'] == split]
            cn = int((lab['regime'] == C["regime"]).sum())
            print("\n" + "=" * 78)
            print(f"{split}: {len(lab)} classified sessions, {cn} Regime C sessions")
            print("=" * 78)
            c_tr = [t for t in all_tr if t['split'] == split and t['regime'] == C["regime"]]
            n_tr = [t for t in all_tr if t['split'] == split and t['regime'] != C["regime"]]
            res = summarize(c_tr, C["commission_rt"], rng, "Regime C, $2.00 RT commission (HEADLINE)")
            summarize(c_tr, C["commission_rt_sensitivity"], rng, "Regime C, $4.00 RT commission (sensitivity)")
            if res:
                pl = placebo(c_tr, arrs, rng)
                p5, p50, p95 = np.percentile(pl, [5, 50, 95])
                print(f"  Placebo (random direction, same geometry, {C['placebo_trials']} trials): mean $/trade "
                      f"p5={p5:.2f} p50={p50:.2f} p95={p95:.2f} | trials >= real mean: {100.0 * (pl >= res['mean']).mean():.1f}%")
            print("  -- same engine on every regime (does the regime filter matter?) --")
            for reg in ('REGIME_A_BALANCED', 'REGIME_B_TREND', 'REGIME_C_MID_CONCENTRATION', 'REGIME_D_UNCLASSIFIED'):
                tr = [t for t in all_tr if t['split'] == split and t['regime'] == reg]
                nsess = int((lab['regime'] == reg).sum())
                if tr:
                    p = np.array([dollars(t, C["commission_rt"]) for t in tr]); r = np.array([t['pts'] / t['risk_pts'] for t in tr])
                    print(f"     {reg:28s} sessions={nsess:3d} trades={len(tr):3d} mean=${p.mean():8.2f} meanR={r.mean():7.3f} WR={100.0 * (p > 0).mean():.1f}%")
                else:
                    print(f"     {reg:28s} sessions={nsess:3d} trades=0")
            if c_tr and n_tr:
                d, lo, hi = delta_ci(c_tr, n_tr, C["commission_rt"], rng)
                print(f"  C minus non-C per-trade mean: ${d:.2f}, day-blocked 95% CI [{lo:.2f}, {hi:.2f}]")
        print("\nReading is pre-registered (PHASE3_C_PREREG.md): 'a lead' only if hold-out CI lower bound > 0 AND hold-out real mean >= placebo p95 "
              "AND train mean > 0; otherwise 'no demonstrated edge'. Descriptive only; no parameter changes after this look.")
    finally:
        tee.close()


if __name__ == '__main__':
    main()
