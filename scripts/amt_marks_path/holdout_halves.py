"""Pre-specified criterion the hold-out printout omitted (PREREG_SINGLE.md: 'same sign in the first and second half of the hold-out'). Same code, same seed, same rng sequence as run_single.py --holdout; NOT a new look. Verifies it reproduces the printed S1/S2 numbers first."""
import sys, numpy as np
sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_80rule'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_exhaust'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_marks_path')
import engine as E, run_path as RP, run_single as RS
raw = E.load_sessions(); allS = E.build_eligible(raw); rng = np.random.default_rng(RS.SEED)
rows, _ = RS.run([s for s in allS if s['d'] > RP.SPLIT or True], 5, 75, rng, 'HOLD-OUT'); rows = [r for r in rows if r['d'] > RP.SPLIT]
rows.sort(key=lambda r: r['d']); m = len(rows) // 2
for mode in ('S1', 'S2'):
    P = [r[mode] for r in rows]; D = [r[mode] - r[mode + '_plc'] for r in rows]
    print(f"{mode}: reproduced mean daily P&L {np.mean(P):.2f}, real-placebo {np.mean(D):.2f} (printed S1 -12.47/22.11, S2 -19.33/32.19)")
    for lab, sl in (('first half', slice(0, m)), ('second half', slice(m, None))):
        print(f"   {lab} ({rows[sl][0]['d']}..{rows[sl][-1]['d']}, {len(P[sl])} days): real {np.mean(P[sl]):.2f}, placebo {np.mean([r[mode + '_plc'] for r in rows[sl]]):.2f}, real-placebo {np.mean(D[sl]):.2f}")
