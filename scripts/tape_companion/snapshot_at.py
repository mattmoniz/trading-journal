"""Tape state at the moment of a logged call, rebuilt from the tick files (no live display needed).
Input: JSON list of calls [{"id": "...", "ts": "2026-11-03T10:42:13-05:00" (ISO; no offset = ET), "level": 24510.5, "direction": "LONG"|"SHORT"}]
LONG = the level acts as support and you want a bounce up; SHORT = resistance, bounce down. Flow numbers are aligned: POSITIVE = toward your direction ("a push my way").
RTH only (09:30-16:00 ET); Globex calls return OUTSIDE_RTH (no per-second Globex data yet). Usage: snapshot_at.py calls.json [out.csv]
Features are the SAME function as the hold-or-slice study (lib.tape_features); no outcome is read and nothing is scored here."""
import sys, os, json, datetime, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/tick_microstructure'); sys.path.insert(0, '/home/mmoniz/trading-journal/scripts/amt_tell_live')
import numpy as np, pandas as pd, lib
from zoneinfo import ZoneInfo
ET = ZoneInfo('America/New_York')

def ensure_day(d):
    """per-second file for date d: the bulk extract if present, else extract from the front-month .scid into scratch/persec_snap (price sanity-checked against price_bars_primary)."""
    if os.path.exists(f'{lib.PERSEC}/{d}.tsv') or os.path.exists(f'{lib.PERSEC_SNAP}/{d}.tsv'): return 'exists'
    import persist, extract_cells_20261020 as E, extract_stuffed_20261020 as X
    conn = persist.connect()
    with conn.cursor() as c:
        c.execute("SELECT contract FROM price_bars_contract_calendar WHERE symbol='NQ' AND trade_date=%s", (d,)); r = c.fetchone()
        c.execute("SELECT open::float FROM price_bars_primary WHERE symbol='NQ' AND ts >= %s::timestamp AND ts < (%s::timestamp + interval '2 minutes') ORDER BY ts LIMIT 1", (d + ' 09:30:00', d + ' 09:30:00'))
        o = c.fetchone()
    if not r or not o: return 'no_calendar_or_price'
    for code in E.candidate_codes(r[0]):
        for p in E.scid_paths(code):
            try: tk = X.ticks_for(p, d)
            except ValueError: continue
            if tk and abs(tk[0][1] - o[0]) < 100:
                agg = {}
                for s, px, sz, ag, u in tk:
                    i = int(s); cc = agg.get(i)
                    if cc is None: cc = agg[i] = [0, 0, px, px, px]
                    if ag == 'BUY': cc[0] += sz
                    elif ag == 'SELL': cc[1] += sz
                    cc[2] = min(cc[2], px); cc[3] = max(cc[3], px); cc[4] = px
                os.makedirs(lib.PERSEC_SNAP, exist_ok=True); fp = f'{lib.PERSEC_SNAP}/{d}.tsv'
                with open(fp + '.tmp', 'w') as f:
                    for i in sorted(agg): cc = agg[i]; f.write(f'{i}\t{cc[0]}\t{cc[1]}\t{cc[2]:.2f}\t{cc[3]:.2f}\t{cc[4]:.2f}\n')
                os.replace(fp + '.tmp', fp); return f'extracted {len(agg)} seconds from {os.path.basename(p)}'
    return 'no_tick_file_matched'

def baselines_for(d):
    ds = lib.persec_dates()
    if os.path.isdir(lib.PERSEC_SNAP): ds = sorted(set(ds) | {os.path.basename(x)[:10] for x in os.listdir(lib.PERSEC_SNAP) if x.endswith('.tsv')})
    prev = [x for x in ds if x < d][-20:]
    B = lib.Baselines(ds)
    for p in prev: B.prep(p)
    return float(np.median([B.sc[p] for p in prev])), np.median(np.vstack([B.vr[p] for p in prev]), 0), (datetime.date.fromisoformat(d) - datetime.date.fromisoformat(prev[-1])).days

def snap_calls(calls):
    out = []; cache = {}
    for c in calls:
        ts = datetime.datetime.fromisoformat(c['ts']); ts = ts.replace(tzinfo=ET) if ts.tzinfo is None else ts.astimezone(ET)
        d = ts.date().isoformat(); sod = ts.hour * 3600 + ts.minute * 60 + ts.second; idx = sod - lib.RTH0; row = dict(id=c.get('id'), ts_et=ts.isoformat(), level=c['level'], direction=c['direction'])
        if not (60 <= idx < lib.N - 1): out.append(dict(row, status='OUTSIDE_RTH')); continue
        if d not in cache:
            st = ensure_day(d); cache[d] = (st, None)
            if st in ('exists',) or st.startswith('extracted'): cache[d] = (st, lib.load_day(d), baselines_for(d))
        st, A, *bl = cache[d]
        if A is None: out.append(dict(row, status='NO_TICK_DATA:' + st)); continue
        scale, vr, stale_days = bl[0]
        f = lib.snapshot(A, idx, c['level'], c['direction'], scale, vr); f['baseline_age_days'] = stale_days; f['scale_pts'] = scale
        out.append(dict(row, **{k: (round(v, 4) if isinstance(v, float) else v) for k, v in f.items()}))
    return out

if __name__ == '__main__':
    calls = json.load(open(sys.argv[1])); res = pd.DataFrame(snap_calls(calls))
    if len(sys.argv) > 2: res.to_csv(sys.argv[2], index=False)
    with pd.option_context('display.width', 250, 'display.max_columns', 40): print(res.drop(columns=[c for c in res.columns if c.startswith('fam_')], errors='ignore').to_string(index=False))
