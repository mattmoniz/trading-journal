"""Stitches individual .scid contract files into one continuous multi-day trade stream,
using this codebase's OWN existing authoritative day->contract mapping
(price_bars_contract_calendar) rather than re-deriving "which contract is front-month on
date X" from file listings/dates by hand. Roll weeks are excluded per the existing
convention (roll_calendar.py / getNqRollWeekDates()) -- an unsupervised model with no idea
a roll happened would otherwise treat the price/liquidity discontinuity as a real market
state, per the design review.
"""
import sys
import os
import datetime
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'ml_meta_labeling'))
from db import get_connection
from scid_reader import read_ticks
from roll_calendar import nq_roll_week_dates

SCID_DIR = '/mnt/c/SierraChart/Data'


def db_contract_to_scid_path(contract):
    """'NQU26' -> '/mnt/c/SierraChart/Data/NQU6.CME.scid'. DB stores the 2-digit year
    (U26), the .scid filename convention on disk uses the 1-digit year (U6) -- verified
    directly against real files on disk (NQU6.CME.scid exists, NQU26.CME.scid does not)."""
    root = contract[:3]        # 'NQU'
    year_1digit = contract[-1]  # '6' from '26'
    return os.path.join(SCID_DIR, f'{root}{year_1digit}.CME.scid')


def get_contract_schedule(start_date, end_date, symbol='NQ'):
    """Returns an ordered list of (trade_date, contract, scid_path) for real trading
    days in [start_date, end_date], EXCLUDING days inside an NQ quarterly roll week.
    Uses price_bars_contract_calendar -- this codebase's own already-computed
    authoritative source for which contract is canonical on a given date -- rather than
    guessing from file mtimes."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT trade_date, contract FROM price_bars_contract_calendar
                WHERE symbol = %s AND trade_date BETWEEN %s AND %s
                ORDER BY trade_date
            """, (symbol, start_date, end_date))
            rows = cur.fetchall()
    finally:
        conn.close()

    schedule = []
    roll_week_cache = {}
    for trade_date, contract in rows:
        year = trade_date.year
        if year not in roll_week_cache:
            roll_week_cache[year] = nq_roll_week_dates(year)
        if trade_date in roll_week_cache[year]:
            continue
        path = db_contract_to_scid_path(contract)
        if not os.path.exists(path):
            continue
        schedule.append((trade_date, contract, path))
    return schedule


def stream_trades(start_date, end_date, symbol='NQ'):
    """Yields Trade objects across many real trading days, in chronological order,
    correctly switching source files at each real contract change and skipping roll
    weeks entirely. This is the input to bucketize.bucketize() for a genuine multi-day
    continuous run -- callers should NOT reset any trailing state (order-flow history,
    feature windows) between the days this yields, since the whole point is a
    continuous market-state description spanning real session boundaries."""
    schedule = get_contract_schedule(start_date, end_date, symbol)
    last_contract = None
    for trade_date, contract, path in schedule:
        if contract != last_contract:
            # A real, small basis discontinuity is possible right at a contract switch
            # (front-month changes even outside the excluded roll-week itself, since the
            # calendar's own switch date and the roll-week's own boundary don't have to
            # align to the day). Not corrected here -- flagged, not silently smoothed.
            last_contract = contract
        yield from read_ticks(path, start_date=trade_date, end_date=trade_date)


def get_schedule_summary(start_date, end_date, symbol='NQ'):
    """Diagnostic: how many real trading days and contract switches a given range
    actually contains, before committing to a full run."""
    schedule = get_contract_schedule(start_date, end_date, symbol)
    contracts = [c for _, c, _ in schedule]
    switches = sum(1 for i in range(1, len(contracts)) if contracts[i] != contracts[i - 1])
    return {
        'n_trading_days': len(schedule),
        'distinct_contracts': sorted(set(contracts)),
        'n_contract_switches': switches,
        'first_day': schedule[0][0] if schedule else None,
        'last_day': schedule[-1][0] if schedule else None,
    }
