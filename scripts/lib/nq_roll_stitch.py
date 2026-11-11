"""Python reader for scripts/lib/data/nq_roll_stitches.json (built by scripts/build_nq_roll_stitches.mjs from the
bars themselves; logic and definitions in scripts/lib/nqRollStitch.mjs). Research scripts use this INSTEAD of the
calendar rule (roll_calendar.nq_roll_week_dates), which says when the live front month switches, not where the
stored bar series is stitched. No detection logic lives here: this file only reads the JSON."""
import datetime
import json
import os

STITCH_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'nq_roll_stitches.json')


def load(path=STITCH_FILE):
    return json.load(open(path))


def _norm(t):
    return (t.isoformat(sep=' ') if isinstance(t, (datetime.datetime,)) else str(t).replace('T', ' '))[:19]


def crosses_stitch(data, t0, t1):
    """A price difference taken between t0 and t1 (naive ET) spans a contract stitch."""
    a, b = _norm(t0), _norm(t1)
    return any(a < s['ts'] <= b for s in data['stitches'])


def touches_bad_date(data, t0, t1):
    a, b = _norm(t0)[:10], _norm(t1)[:10]
    return any(a <= x['date'] <= b for x in data['bad_dates'])


def unsafe_dates(data, days_before=0, days_after=0, include_bad_dates=True):
    """Set of 'YYYY-MM-DD': stitch dates (widened) plus bad-bar dates."""
    out = set()
    for s in data['stitches']:
        d0 = datetime.date.fromisoformat(s['prev_ts'][:10]); d1 = datetime.date.fromisoformat(s['ts'][:10])
        for k in range(-days_before, 1): out.add((d0 + datetime.timedelta(days=k)).isoformat())
        for k in range(0, days_after + 1): out.add((d1 + datetime.timedelta(days=k)).isoformat())
    if include_bad_dates:
        out.update(x['date'] for x in data['bad_dates'])
    return out
