"""Outcome-blind delta-flip tagger for live tell fires (PREREG_FLIP_DISAGREE_FORWARD.md). For one COMPLETED trade date: rebuild the 500-contract bars with the sidecar's own validated builder
(bootstrap.build_sessions), compute the DDY flip (approximate) and write amt_tell_flip_tags for every V1 split tell row of that date. NEVER reads net_dollars or any outcome column.
Usage: python3 tag_flips_day.py DATE [--dry]      (idempotent upsert on tell_trade_id)"""
import os, sys, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import persist, bootstrap
from ddy_flip import ddy_flip_approx
RULE = 'split'

def main():
    d = sys.argv[1]; dry = '--dry' in sys.argv; conn = persist.connect()
    with conn.cursor() as c:
        c.execute("SELECT id, sig_idx, direction FROM amt_tell_trades WHERE trade_date=%s AND bar_rule=%s AND book='V1' ORDER BY id", (d, RULE)); rows = c.fetchall()
        c.execute("SELECT n_bars FROM amt_tell_sessions WHERE trade_date=%s AND bar_rule=%s", (d, RULE)); sr = c.fetchone()
    if not rows: print(f'{d}: no V1 tell rows'); return
    sess, ok, info = bootstrap.build_sessions(conn, d, [RULE])
    if sess is None: print(f'{d}: cannot rebuild bars ({info})'); sys.exit(2)
    bars = sess[RULE].sb.done; n = len(bars); stored = sr[0] if sr else None
    print(f'{d}: rebuilt {n} bars (stored session n_bars {stored}), validated vs the database RTH volume: {ok}')
    if stored is not None and abs(stored - n) > 3: print('REFUSED: rebuilt bar count differs from the live session by more than 3 bars'); sys.exit(3)
    flip, prior = ddy_flip_approx([b['bid'] for b in bars], [b['ask'] for b in bars]); out = []
    for tid, sig, dr in rows:
        w10 = flip[max(0, sig - 9):sig + 1]; w30 = flip[max(0, sig - 29):sig + 1]; nz = w10[w10 != 0]; vote = int(nz[-1]) if len(nz) else 0
        pidx = np.where(w30 != 0)[0]; ps = int(prior[max(0, sig - 29):sig + 1][pidx[-1]]) if len(pidx) else 0
        grp = 'NONE' if vote == 0 else ('AGREE' if vote == dr else 'DISAGREE'); out.append((tid, d, RULE, sig, dr, vote, grp, ps, int((w30 != 0).sum()), 'approx_wma10_v1', bool(ok), n))
    import collections; print('groups:', dict(collections.Counter(o[6] for o in out)))
    if dry: print('dry run, nothing written'); return
    with conn.cursor() as c:
        for o in out: c.execute("""INSERT INTO amt_tell_flip_tags (tell_trade_id, trade_date, bar_rule, sig_idx, tell_dir, vote, grp, prior_streak, n_flips_30, flip_source, validated, bars_n)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (tell_trade_id) DO UPDATE SET vote=EXCLUDED.vote, grp=EXCLUDED.grp, prior_streak=EXCLUDED.prior_streak, n_flips_30=EXCLUDED.n_flips_30, validated=EXCLUDED.validated, bars_n=EXCLUDED.bars_n, tagged_at=now()""", o)
    conn.commit(); print(f'tagged {len(out)} rows')

main()
