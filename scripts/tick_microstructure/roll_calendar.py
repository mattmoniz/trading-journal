"""NQ quarterly roll-week dates. This is a Python copy of the canonical logic in
server/services/acdShared.js's getNqRollWeekDates() -- NOT a fresh reimplementation.

Why a copy instead of an import: acdShared.js is JS, and the existing Python copy of this
exact function (scripts/backfill_garch_vol_scale_history.py's nq_roll_week_dates(),
verified byte-identical to the JS version per acdShared.js's own header comment) lives in
a script that imports `arch` (the GARCH library) at module level, which isn't installed in
this environment and isn't otherwise needed here -- importing that whole module just for
one pure date-math function would add a real, unrelated dependency. This is the SAME
precedent that codebase already established (JS canonical, one standalone Python copy)
applied to a second Python consumer, not a new/5th hand-copy of a still-undocumented
version.
"""
import datetime
import calendar as cal_module


def nq_roll_week_dates(year):
    """NQ's quarterly (Mar/Jun/Sep/Dec) roll week: 2nd Thursday of the contract month
    through the Monday before the 3rd Friday (CME's official roll date). Returns a set
    of datetime.date to exclude from any continuous-series construction."""
    excluded = set()
    for month in (3, 6, 9, 12):
        c = cal_module.monthcalendar(year, month)
        thursdays = [datetime.date(year, month, week[3]) for week in c if week[3] != 0]
        fridays = [datetime.date(year, month, week[4]) for week in c if week[4] != 0]
        second_thursday = thursdays[1]
        third_friday = fridays[2]
        monday_before_third_friday = third_friday - datetime.timedelta(days=4)
        d = second_thursday
        while d <= monday_before_third_friday:
            excluded.add(d)
            d += datetime.timedelta(days=1)
    return excluded


def is_inside_roll_week(d):
    """d: datetime.date."""
    return d in nq_roll_week_dates(d.year)
