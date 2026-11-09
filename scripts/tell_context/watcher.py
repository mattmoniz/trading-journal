"""Day-state watcher (docs/TELL_WATCHER_AND_SHADOW_BOOKS_DESIGN_20261103.md, section 1 + amendment A1 + scope doc section 20). Pure, causal, read-only: from the completed 500-contract bars of ONE session it returns the displayed state at every bar
(UNKNOWN, BALANCE_FORMING, BALANCE_CONFIRMED, DRIVE_UP, DRIVE_DOWN, DRIVE_UP_BUILDING, DRIVE_DOWN_BUILDING) with hysteresis, the list of state CHANGES with their evidence, and the stability numbers. A bar t uses only bars 0..t. Every window below is a CONVENTION
(the tell's own 20-bar stride window and 10-bar flow window, two stride windows = 40 bars), NOT calibrated; the backtest treats them as a robustness grid. Nothing here places orders or gates anything."""
import numpy as np

RTH_OPEN, FLOOR_S = 55800.0, 3600.0          # 09:30 ET; the state is UNKNOWN until 60 RTH minutes have passed (the tell's IB window)
STRIDE = 20                                  # the tell's stride window (trade.py)
DRIVE_RECENCY = 40                           # a drive needs a new extreme within this many bars (a stalled drive ends); two stride windows
BALANCE_AGE = 40                             # both RTH extremes must be at least this many bars old for BALANCE_CONFIRMED
INSIDE_EXIT = 10                             # a drive ends when the last 10 closes are all back inside
APPROACH_R, RETREAT_R, DENY_WINDOW = 1.0, 2.0, 20
CONFIRM_BARS, MIN_DWELL = 3, 10              # hysteresis
MATERIAL = 0.5                               # in units of the 20-bar median range
DEFENDED = 2                                 # an edge that denied at least this many approaches is flagged defended in the evidence (user: the second and third attempts get denied); BALANCE_CONFIRMED needs only one denial (the defended-edge version did not sharpen the D call and was reverted)
FIGHT_MIN = 10                               # a FIGHT = at least this many bars between two material new extremes beyond the overnight level, price staying outside the whole time; the next extreme is the push
STATES = ('UNKNOWN', 'BALANCE_FORMING', 'BALANCE_CONFIRMED', 'DRIVE_UP', 'DRIVE_DOWN', 'DRIVE_UP_BUILDING', 'DRIVE_DOWN_BUILDING')    # *_BUILDING = a drive that has had one or more fights and pushes (user: price pushes out of value, a fight, then keeps pushing out)


def _rolling_r20(h, l):
    d = h - l; out = np.empty(len(d))
    for t in range(len(d)): out[t] = np.median(d[max(0, t - STRIDE + 1):t + 1])
    return out


class _Side:
    """Incremental denied-approach counter for ONE day extreme (side +1 = the day high, -1 = the day low). Reset whenever a new extreme is set. An approach episode starts at a bar whose extreme is within 1 r20 of the
    day extreme without exceeding it; it is DENIED if a close retreats at least 2 r20 from that bar's extreme within 20 bars; the episode ends at the first such retreat, so a grind near the extreme counts once."""
    def __init__(self, side): self.side = side; self.reset(None)
    def reset(self, j): self.j = j; self.approaches = 0; self.denials = 0; self.ep = None
    def update(self, t, H, L, C, R, ext):
        sd = self.side
        if self.ep is not None:
            ref, r0, start = self.ep
            if (ref - C[t] if sd == 1 else C[t] - ref) >= RETREAT_R * r0:
                if t - start <= DENY_WINDOW: self.denials += 1
                self.ep = None
            return
        gap = (ext - H[t]) if sd == 1 else (L[t] - ext)
        if t > self.j and 0 <= gap <= APPROACH_R * R[t]:
            self.approaches += 1; self.ep = (H[t] if sd == 1 else L[t], R[t], t)


def raw_states(end, h, l, c):
    """Memoryless-per-bar raw state plus its evidence, one pass O(n). Arrays are the session's completed bars in order."""
    n = len(end); on = end < RTH_OPEN
    if not on.any(): return ['UNKNOWN'] * n, [dict(reason='no overnight bars')] * n
    onh, onl = float(h[on].max()), float(l[on].min()); raw, ev = [], []; R = _rolling_r20(h, l)
    ib = (end >= RTH_OPEN) & (end < RTH_OPEN + FLOOR_S); ibh = float(h[ib].max()) if ib.any() else None; ibl = float(l[ib].min()) if ib.any() else None
    ub = max(onh, ibh) if ibh is not None else onh; lb = min(onl, ibl) if ibl is not None else onl      # a drive has to be past the IB high/low or the overnight high/low: the outer of the two, the tell's own boundary (trade.boundary)
    run_hi = run_lo = None; j_hi = j_lo = None; up_ext = []; dn_ext = []; closed_up = closed_dn = False; hi_side, lo_side = _Side(1), _Side(-1)
    fights_up = fights_dn = 0
    for t in range(n):
        if end[t] >= RTH_OPEN:
            new_hi = run_hi is None or h[t] > run_hi; new_lo = run_lo is None or l[t] < run_lo
            if new_hi: run_hi, j_hi = float(h[t]), t; hi_side.reset(t)
            if new_lo: run_lo, j_lo = float(l[t]), t; lo_side.reset(t)
            if not new_hi: hi_side.update(t, h, l, c, R, run_hi)
            if not new_lo: lo_side.update(t, h, l, c, R, run_lo)
            ibdone = end[t] >= RTH_OPEN + FLOOR_S                                              # drive tracking starts once the IB is complete (before that the IB itself is still being set)
            m = MATERIAL * R[t]
            if ibdone: closed_up = closed_up or bool(c[t] > ub); closed_dn = closed_dn or bool(c[t] < lb)                                                                # a new extreme counts only if it extends at least half a typical range past the last one (a few ticks inside a range is not a drive)
            if ibdone and h[t] > ub + m and (not up_ext or h[t] > h[up_ext[-1]] + m) and h[t] >= run_hi:
                if up_ext and t - up_ext[-1] >= FIGHT_MIN and (c[up_ext[-1]:t] > ub).all(): fights_up += 1          # a stall outside, then a new extreme: fight, then push
                up_ext.append(t)
            if ibdone and l[t] < lb - m and (not dn_ext or l[t] < l[dn_ext[-1]] - m) and l[t] <= run_lo:
                if dn_ext and t - dn_ext[-1] >= FIGHT_MIN and (c[dn_ext[-1]:t] < lb).all(): fights_dn += 1
                dn_ext.append(t)
        if end[t] < RTH_OPEN + FLOOR_S: raw.append('UNKNOWN'); ev.append(dict(reason='RTH younger than 60 minutes')); continue
        up_live = closed_up and len(up_ext) >= 2 and t - up_ext[-1] <= DRIVE_RECENCY and not (c[max(0, t - INSIDE_EXIT + 1):t + 1] <= ub).all()
        dn_live = closed_dn and len(dn_ext) >= 2 and t - dn_ext[-1] <= DRIVE_RECENCY and not (c[max(0, t - INSIDE_EXIT + 1):t + 1] >= lb).all()
        base = dict(onh=onh, onl=onl, ibh=ibh, ibl=ibl, upper=ub, lower=lb, rth_high=run_hi, rth_low=run_lo, up_new_extremes=len(up_ext), down_new_extremes=len(dn_ext), up_fights=fights_up, down_fights=fights_dn)
        if up_live or dn_live:
            up = up_live and (not dn_live or up_ext[-1] >= dn_ext[-1])
            name = ('DRIVE_UP_BUILDING' if fights_up >= 1 else 'DRIVE_UP') if up else ('DRIVE_DOWN_BUILDING' if fights_dn >= 1 else 'DRIVE_DOWN')
            raw.append(name); ev.append(base); continue
        if (t - j_hi >= BALANCE_AGE) and (t - j_lo >= BALANCE_AGE) and hi_side.denials + lo_side.denials >= 1:
            raw.append('BALANCE_CONFIRMED'); ev.append(dict(base, denials_high=hi_side.denials, denials_low=lo_side.denials, defended_high=hi_side.denials >= 2, defended_low=lo_side.denials >= 2)); continue
        raw.append('BALANCE_FORMING'); ev.append(base)
    return raw, ev


def run(end, h, l, c):
    """Displayed states with hysteresis, the list of changes, and stability numbers. A change needs the new raw state for CONFIRM_BARS consecutive bars and the old state to have lasted MIN_DWELL bars
    (the first state after the 60-minute floor is immediate)."""
    raw, ev = raw_states(np.asarray(end, float), np.asarray(h, float), np.asarray(l, float), np.asarray(c, float)); shown = []; changes = []; cur = 'UNKNOWN'; since = 0; streak = 0; cand = None
    for t, r in enumerate(raw):
        if cur == 'UNKNOWN':
            if r != 'UNKNOWN': cur, since = r, t; changes.append(dict(bar_idx=t, state=cur, prev='UNKNOWN', evidence=ev[t]))
        elif r == cur: streak = 0; cand = None
        else:
            if cand == r: streak += 1
            else: cand, streak = r, 1
            if streak >= CONFIRM_BARS and t - since >= MIN_DWELL:
                changes.append(dict(bar_idx=t, state=r, prev=cur, evidence=ev[t])); cur, since, streak, cand = r, t, 0, None
        shown.append(cur)
    known = [x for x in shown if x != 'UNKNOWN']
    return dict(shown=shown, changes=changes, evidence=ev, current=(shown[-1] if shown else 'UNKNOWN'), n_changes=max(0, len(changes) - 1), bars_known=len(known))
