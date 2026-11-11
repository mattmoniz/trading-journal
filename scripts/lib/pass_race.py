"""Prop-account pass race: one shared implementation (2026-11-10, CLAUDE.md cv-077 / cv-079).

The account (memory reference_prop_account_rules_20261102, user's words, nothing guessed beyond them): a $2,000 loss limit that
TRAILS THE END-OF-DAY BALANCE (floor = best end-of-day balance so far minus $2,000, starting at -$2,000), a $3,000 profit target, no
daily loss limit. The memory note says nothing about the floor stopping its climb at the starting balance, so it does NOT stop here
(if the real rule caps the floor at the start, P(pass) is somewhat higher than this module reports).
The breach is judged on end-of-day balances only; PASS = an end-of-day balance at or above the target, BUST = an end-of-day balance at
or below the floor, whichever comes first.

Contents
  _walk(bal, floor, target)       the one place where a matrix of end-of-day balances becomes first-pass / first-bust days.
  race_arms(day_vals, ...)        the paired-arms version used by scripts/vacuum_sim/unified_exit_lock.py (moved here unchanged).
  race(day_pnl, ...)              one stream of daily dollars -> P(pass), P(bust), P(unresolved), median days to finish.
  apply_rules(trades, rules)      replays a time-ordered list of trades through skip rules.
  risk_cap / same_direction_lockout / session_off   the three rule builders. Their parameters have NO default value on purpose: the
                                  values are chosen in a pre-registration, never here.
This module only builds the tool. It chooses no parameter value and runs nothing on real trades.
"""
import numpy as np

ACCOUNT_FLOOR = 2000.0   # account rule (memory reference_prop_account_rules_20261102), not a tunable threshold
ACCOUNT_TARGET = 3000.0  # account rule, same source
NEVER = 10 ** 6


def _walk(bal, floor, target):
    """bal: (paths, days) end-of-day balances. Returns (first pass day, first bust day) per path; NEVER where it does not happen.
    The floor follows the highest end-of-day balance so far, starting from a high-water mark of 0."""
    hwm = np.maximum(0.0, np.maximum.accumulate(bal, axis=1))
    ps = bal >= target
    fl = bal <= hwm - floor
    tp = np.where(ps.any(1), ps.argmax(1), NEVER)
    tf = np.where(fl.any(1), fl.argmax(1), NEVER)
    return tp, tf


def race_arms(day_vals, B=100, P=10000, H=250, seed=4242, floor=ACCOUNT_FLOOR, target=ACCOUNT_TARGET):
    """day_vals: {arm: array of daily net dollars over the SAME ordered calendar}. Returns per arm P(pass), P(fail), P(unresolved) (means over B
    day-pool replicas) and DELTA P(pass) vs 'base' with a 90 percent interval over the replicas. Every arm walks the SAME paths. Moved unchanged
    from scripts/vacuum_sim/unified_exit_lock.py on 2026-11-10 (output verified identical)."""
    arms = list(day_vals); nd = len(next(iter(day_vals.values()))); rng = np.random.default_rng(seed); res = {a: [] for a in arms}
    for b in range(B):
        pool = rng.integers(0, nd, nd); idx = pool[rng.integers(0, nd, (P, H))]
        for a in arms:
            bal = np.cumsum(day_vals[a][idx], axis=1)
            tp, tf = _walk(bal, floor, target)
            res[a].append((np.mean(tp < tf), np.mean(tf < tp), np.mean((tp == NEVER) & (tf == NEVER))))
    out = {a: tuple(np.mean(np.array(res[a]), axis=0)) for a in arms}
    d = {a: (np.mean([x[0] - y[0] for x, y in zip(res[a], res['base'])]), np.percentile([x[0] - y[0] for x, y in zip(res[a], res['base'])], 5),
             np.percentile([x[0] - y[0] for x, y in zip(res[a], res['base'])], 95)) for a in arms if a != 'base'}
    return out, d


def race(day_pnl, n_paths, horizon_days, block_days, floor, target, seed, chunk=1000):
    """One stream. day_pnl: array of daily net dollars in calendar order. Draws n_paths paths of horizon_days days by a day-BLOCK bootstrap
    (consecutive blocks of block_days days, starting at a random day, wrapping around the end; block_days=1 is an ordinary day bootstrap),
    walks the end-of-day trailing floor and returns a dict: p_pass, p_bust, p_unresolved, median_days_to_finish (over finished paths, 1-based
    day count, None if none finished), n_paths. Paths are processed in chunks so memory stays at about chunk x horizon_days x 8 bytes x 5."""
    day_pnl = np.asarray(day_pnl, float); nd = len(day_pnl)
    if nd == 0 or horizon_days < 1 or block_days < 1 or n_paths < 1: raise ValueError('race: need data and positive sizes')
    rng = np.random.default_rng(seed)
    nblocks = -(-horizon_days // block_days); offs = np.arange(block_days)
    n_pass = n_bust = n_unres = 0; finish = []
    for lo in range(0, n_paths, chunk):
        m = min(chunk, n_paths - lo)
        starts = rng.integers(0, nd, (m, nblocks))
        idx = ((starts[:, :, None] + offs[None, None, :]) % nd).reshape(m, -1)[:, :horizon_days]
        tp, tf = _walk(np.cumsum(day_pnl[idx], axis=1), floor, target)
        won = tp < tf; lost = tf < tp
        n_pass += int(won.sum()); n_bust += int(lost.sum()); n_unres += int(((tp == NEVER) & (tf == NEVER)).sum())
        finish.append(np.where(won, tp, np.where(lost, tf, -1))[won | lost] + 1)
    fin = np.concatenate(finish) if finish else np.array([])
    return dict(p_pass=n_pass / n_paths, p_bust=n_bust / n_paths, p_unresolved=n_unres / n_paths,
                median_days_to_finish=(float(np.median(fin)) if len(fin) else None), n_paths=n_paths)


# ---------------------------------------------------------------- skip rules
def _time_key(t):
    return (str(t['date']), str(t['entry_time']))


def is_full_stop(t):
    """A trade that was stopped for its whole risk. Uses the field 'full_stop' when the trade dict has it, else net <= -risk_dollars."""
    if 'full_stop' in t: return bool(t['full_stop'])
    return float(t['net']) <= -float(t['risk_dollars'])


def apply_rules(trades, rules, floor=ACCOUNT_FLOOR):
    """trades: list of dicts with at least date, entry_time, direction, risk_dollars, net, session, stream. rules: list of callables
    (trade, state) -> bool (True = take). Trades are evaluated in time order (date, entry_time; ties keep the input order). A trade is taken
    only if every rule returns True. state holds, as of the moment before the trade: balance (sum of net of the trades TAKEN so far),
    eod_peak (best end-of-day balance so far, at least 0), cushion (balance minus the trailing floor eod_peak - floor), day, day_trades
    (taken trades earlier today, in order), taken (all taken trades so far). Returns the taken trades in their ORIGINAL input order, so
    with no rules the result equals the input. The input dicts are not modified."""
    rules = list(rules)
    if not rules: return list(trades)
    order = sorted(range(len(trades)), key=lambda i: (_time_key(trades[i]), i))
    taken_idx = set(); taken = []; balance = 0.0; eod_peak = 0.0; day = None; day_trades = []
    for i in order:
        t = trades[i]; d = str(t['date'])
        if day is not None and d != day:        # the previous day closed: its end-of-day balance moves the high-water mark
            eod_peak = max(eod_peak, balance); day_trades = []
        day = d
        state = dict(balance=balance, eod_peak=eod_peak, cushion=balance - (eod_peak - floor), day=d, day_trades=list(day_trades), taken=list(taken))
        if all(rule(t, state) for rule in rules):
            taken_idx.add(i); taken.append(t); day_trades.append(t); balance += float(t['net'])
    return [t for i, t in enumerate(trades) if i in taken_idx]


def risk_cap(fraction_of_cushion):
    """Skip a trade whose risk_dollars is more than fraction_of_cushion x the current cushion (balance minus the trailing floor). A cushion at or
    below zero skips every trade. No default value: choose it in a pre-registration."""
    def rule(t, s): return s['cushion'] > 0 and float(t['risk_dollars']) <= fraction_of_cushion * s['cushion']
    return rule


def same_direction_lockout():
    """Skip a trade when the most recent TAKEN trade of the same stream, same day and same direction was a full stop (see is_full_stop)."""
    def rule(t, s):
        prev = [x for x in s['day_trades'] if x['stream'] == t['stream'] and x['direction'] == t['direction']]
        return not (prev and is_full_stop(prev[-1]))
    return rule


def session_off(session_name):
    """Skip every trade whose session equals session_name. No default value."""
    def rule(t, s): return t['session'] != session_name
    return rule
