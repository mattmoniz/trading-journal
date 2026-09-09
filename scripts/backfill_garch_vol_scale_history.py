import psycopg2
import pandas as pd
import numpy as np
from arch import arch_model
import json
import datetime
import calendar as cal_module


def nq_roll_week_dates(year):
    """NQ's quarterly (Mar/Jun/Sep/Dec) roll week for a given year: the 2nd Thursday of the
    contract month (where volume typically starts shifting to the next contract, per user
    guidance 2026-09-08) through the official CME roll date (the Monday before the 3rd Friday
    -- CME's own methodology, independently confirmed via web search of
    cmegroup.com/trading/equity-index/rolldates the same day: "The equity products roll date is
    the Monday prior to the third Friday of the expiration month," applies to ES/NQ/RTY/YM
    alike on the shared H/M/U/Z quarterly cycle). Returns a set of dates (inclusive) to exclude
    from return computation for that year's 4 roll weeks."""
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

# EXPANDING window (all history from day zero), NOT rolling. This flip-flopped THREE times on
# 2026-09-08 before landing here for good -- read the full history before touching this again:
#   1. Originally built expanding. Kept that way at first based on a QLIKE mean-comparison that
#      seemed to show expanding was more accurate.
#   2. A DeepSeek review found that comparison was diluted (rolling-250 is mathematically
#      identical to expanding for i<=250) and statistically meaningless (per-day QLIKE noise an
#      order of magnitude bigger than the observed gap -- independently re-verified the
#      theoretical E[QLIKE]~=1.27 constant behind that argument by hand).
#   3. A properly-scoped, scipy-validated re-test found rolling-250 SIGNIFICANTLY better
#      (one-sided Wilcoxon p=0.0054) -- switched to rolling on that evidence.
#   4. Investigating "how has this forecast the biggest real moves" (a direct user question)
#      surfaced two real DATA bugs contaminating the returns series the whole comparison in
#      step 3 was built on: price_bars_primary has 6 multi-month gaps (a quarterly-contract-roll
#      artifact) AND several roll-week price discontinuities that don't show up as gaps (see
#      nq_roll_week_dates() below and the exclusion logic further down). Once those are properly
#      excluded, re-running the SAME comparison REVERSES it: expanding is now significantly
#      BETTER (one-sided Wilcoxon p=0.018, N=169, median delta flips from -0.037 favoring
#      rolling on contaminated data to +0.0056 favoring expanding on clean data). Mechanistic
#      explanation, not just a coincidence: a short rolling window is far more sensitive to a
#      single extreme fake data point than an expanding window with years of history diluting
#      it -- the earlier "rolling wins" result was really "rolling is more vulnerable to this
#      specific contamination," not a genuine finding about window choice on real data.
# This is the one round of the four that was caused by a real data bug, not a statistical
# methodology fix -- worth remembering that a clean-looking statistical result is still only as
# trustworthy as the data it was computed on.
GARCH_WARMUP_DAYS = 100

def load_env():
    env_vars = {}
    with open('/home/mmoniz/trading-journal/.env', 'r') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#'):
                key, val = line.split('=', 1)
                env_vars[key] = val
    return env_vars

def main():
    print("Loading DB...")
    env_vars = load_env()
    conn = psycopg2.connect(
        host=env_vars.get('DB_HOST', 'localhost'), port=env_vars.get('DB_PORT', '5432'),
        dbname=env_vars.get('DB_NAME', 'trading_journal'), user=env_vars.get('DB_USER', 'trader'),
        password=env_vars.get('DB_PASSWORD', 'trader123'))
    conn.autocommit = True
    cursor = conn.cursor()

    print("Loading daily RTH bars for GARCH...")
    # symbol='NQ' is required -- price_bars_primary has documented ES contamination
    # 2023-11-16 to 2023-12-14 (docs/OPEN_THREADS.md data-sanity audit). Without this
    # filter, that month's daily OHLC mixes ES (~4000-5000) and NQ (~15000-20000+)
    # bars together, producing nonsense ranges right inside the GARCH walk-forward
    # warmup window -- and since the fit uses an expanding window, that corrupted
    # month stays in every subsequent day's training history forever. Found 2026-07-18
    # while investigating why every fitted alpha[1] came back ~0.
    query = """
        SELECT ts::date as date, open, high, low, close
        FROM price_bars_primary
        WHERE symbol = 'NQ'
          AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
        ORDER BY ts ASC
    """
    df_bars = pd.read_sql_query(query, conn)
    daily = df_bars.groupby('date').agg({'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last'}).reset_index()
    daily['date'] = pd.to_datetime(daily['date']).dt.date
    # MISLABEL WORTH KNOWING (DeepSeek review, 2026-09-08): bars are filtered to RTH-only
    # (570-959 = 9:30am-4pm ET) so each day's OWN high/low/open only reflect the RTH session --
    # but the RETURN computed just below is close(t)/close(t-1), i.e. RTH-close to RTH-close.
    # That return SPANS the entire overnight Globex session between the two closes. So the
    # model's "daily volatility" is close-to-close (overnight-inclusive), not a measure of
    # pure intraday RTH range -- consistent between this script and every scratch/test_garch_*
    # script that reuses this same query, just worth knowing when interpreting a reading.
    daily.set_index('date', inplace=True)
    daily['log_ret'] = np.log(daily['close'] / daily['close'].shift(1)) * 100

    # REAL BUG, FOUND AND FIXED 2026-09-08 (user question "how has this forecast the biggest
    # moves" led directly to this): price_bars_primary has 6 gaps of 63-70 CALENDAR days each,
    # spaced almost exactly once a quarter -- the signature of NQ's quarterly futures contract
    # roll not being stitched into a continuous series. `close.shift(1)` doesn't know about the
    # gap -- it silently computes log_ret across whatever two rows happen to be adjacent in the
    # dataframe, so the row immediately after a gap gets a "1-day return" that's actually 2-3
    # months of real cumulative price action (verified: the 2023-12-14 -> 2024-02-15 gap alone
    # produced a fake +1502pt "single day" move, a >5-sigma outlier; a smaller 2025-09-18 ->
    # 2025-09-29 gap sits INSIDE the current live 250-day rolling window right now, contributing
    # a real +631pt / +2.55% (~1.9 sigma) fake data point to the model that's actually live).
    # MAX_NORMAL_GAP_DAYS=4 covers every legitimate weekend/holiday combination in this dataset
    # (a normal weekend is 3 calendar days, a 3-day weekend for a Mon/Fri holiday is 4) without
    # false-positiving on real trading gaps -- verified via a direct gap-day-delta scan
    # (scratch/test_garch_recent_performance.py's investigation) before picking this threshold,
    # not guessed. The row immediately after a real gap gets its log_ret excluded (NaN'd, then
    # dropped) -- that day's true single-session return is unknowable from close-to-close data
    # alone anyway, so it's honest to have no output for it rather than a fabricated one. Every
    # OTHER day's return, including the one computed FROM that excluded day forward, is
    # unaffected -- shift(1) already captured the correct prior close before this exclusion runs.
    MAX_NORMAL_GAP_DAYS = 4
    calendar_gap = pd.Series(daily.index, index=daily.index).diff().apply(lambda d: d.days if pd.notnull(d) else None)
    gap_mask = calendar_gap > MAX_NORMAL_GAP_DAYS
    if gap_mask.sum() > 0:
        print(f"Excluding {gap_mask.sum()} gap-spanning return(s) (>{MAX_NORMAL_GAP_DAYS} calendar days since the prior trading day):")
        for d in daily.index[gap_mask]:
            print(f"  {d}: gap={calendar_gap[d]:.0f} calendar days, would-be log_ret={daily.loc[d,'log_ret']:.2f}% -- EXCLUDED")
        daily.loc[gap_mask, 'log_ret'] = np.nan

    # SECOND, RELATED BUG found the same night by digging further into the first fix's own
    # verification (a user question about the biggest real moves led here): even after removing
    # calendar-gap contamination, several of the remaining largest "moves" clustered exactly in
    # NQ's quarterly roll week -- e.g. 2026-06-09/10/11/15 (2nd Thursday through the official
    # Monday roll date) each showed internally-consistent-looking but implausibly wide day
    # ranges. Unlike the multi-month gap bug, this doesn't show up as a missing-days gap --
    # price_bars_primary has bars every day through the roll, but very plausibly blends
    # front-month and next-month contract prices without a continuous-contract back-adjustment,
    # producing a real intraday-consistent-looking but still-fake price discontinuity. Excludes
    # the whole roll week (2nd Thursday through the Monday CME roll date, both confirmed per
    # nq_roll_week_dates()'s own docstring) from the return series the same way as the gap
    # exclusion above -- same reasoning: that week's true single-session returns aren't reliably
    # knowable from this data, so no output is more honest than a fabricated one.
    # HONEST GAP, not fully closed: 2 further large moves (2026-06-23, 2026-06-29) sit just
    # outside this precise window and remain unexplained -- could be real post-roll volatility,
    # could be a longer-lingering version of the same issue. Not excluded here since widening
    # the window further isn't justified by anything beyond this one quarter's own outliers --
    # flagged via flag_decision.mjs as a genuinely open question, not silently absorbed into a
    # wider guess.
    roll_years = range(daily.index.min().year, daily.index.max().year + 2)
    roll_dates = set()
    for y in roll_years:
        roll_dates |= nq_roll_week_dates(y)
    roll_mask = pd.Series(daily.index, index=daily.index).isin(roll_dates)
    # A date already excluded by the calendar-gap check above has log_ret already NaN --
    # avoid double-counting it in this print.
    newly_excluded = roll_mask & daily['log_ret'].notna()
    if newly_excluded.sum() > 0:
        print(f"Excluding {newly_excluded.sum()} roll-week return(s) (2nd Thursday through the official CME Monday roll date):")
        for d in daily.index[newly_excluded]:
            print(f"  {d}: would-be log_ret={daily.loc[d,'log_ret']:.2f}% -- EXCLUDED (roll week)")
    daily.loc[roll_mask, 'log_ret'] = np.nan

    daily.dropna(subset=['log_ret'], inplace=True)

    print(f"Loaded {len(daily)} trading days. Fitting GARCH walk-forward...")
    returns = daily['log_ret']
    dates = daily.index.tolist()
    
    garch_records = []
    scales = []
    # Numerical safeguard: when 1-alpha-beta is near zero (near-unit-root/IGARCH fit),
    # unc_vol = sqrt(omega/(1-alpha-beta)) blows up or collapses -- not a real signal,
    # a known degeneracy of this formula. Found 2026-07-18: real data shows a clean
    # bimodal split (44/317 days with 1-alpha-beta ~0, the rest sitting at 0.07-0.13
    # with a real gap between the two clusters) rather than a continuum, so this
    # threshold sits in that gap, not picked by feel. On a degenerate day, carry
    # forward the most recent VALID day's unc_vol instead of trusting that day's own
    # blown-up value.
    PERSISTENCE_FLOOR = 0.02
    last_valid_unc_vol = None

    for i in range(GARCH_WARMUP_DAYS, len(dates)):
        d = dates[i]
        hist_ret = returns.iloc[:i]
        am = arch_model(hist_ret, vol='Garch', p=1, q=1, dist='Normal', rescale=False)
        degenerate = False
        try:
            res = am.fit(disp='off')
            fcast = res.forecast(horizon=1, align='origin')
            pred_vol = np.sqrt(fcast.variance.iloc[-1, 0])
            omega = res.params.get('omega', 0)
            alpha = res.params.get('alpha[1]', 0)
            beta = res.params.get('beta[1]', 0)
            persistence_gap = 1 - alpha - beta
            if persistence_gap > PERSISTENCE_FLOOR:
                unc_vol = np.sqrt(omega / persistence_gap)
                last_valid_unc_vol = unc_vol
            elif last_valid_unc_vol is not None:
                unc_vol = last_valid_unc_vol
                degenerate = True
            else:
                unc_vol = pred_vol  # no valid history yet (very early days only)
                degenerate = True
            scale = pred_vol / unc_vol
        except Exception:
            pred_vol = 1.0
            unc_vol = last_valid_unc_vol if last_valid_unc_vol is not None else 1.0
            scale = pred_vol / unc_vol
            alpha = None
            beta = None
            degenerate = True

        scales.append(scale)
        garch_records.append((d, pred_vol, unc_vol, scale, alpha, beta, degenerate))
        if i % 100 == 0:
            print(f"GARCH progress: {i}/{len(dates)}  alpha={alpha}  beta={beta}  degenerate={degenerate}")

    p01 = np.percentile(scales, 1)
    p99 = np.percentile(scales, 99)
    print(f"1st percentile scale: {p01:.4f}")
    print(f"99th percentile scale: {p99:.4f}")

    # "LATEST" forward-looking reading (2026-09-08, standalone monitoring only, added after
    # user asked "shouldn't the cron be in the morning?"). The walk-forward loop above labels
    # each row `d` using `hist_ret = returns.iloc[:i]` -- data strictly BEFORE `d` -- so its
    # last row is "the forecast FOR today, made using yesterday's close." By the time this
    # script runs (8:20 PM ET, after today's close), today has already happened -- that value
    # is retrospective, not a live reading. What a monitor checked the next morning actually
    # wants is the forecast for the NEXT session, which requires today's own return as input
    # and is only computable after today's close. Rather than compute a specific "next trading
    # day" calendar date (would need market-calendar weekend/holiday logic just to label it),
    # this fits ONE more model on the FULL return series (today included, no held-out day,
    # expanding just like every other fit in this script -- see the window-choice history
    # above) and stores it under signal_name='LATEST' instead of a date -- the monitor always
    # reads the single most recent LATEST row (ORDER BY run_date DESC LIMIT 1), no date
    # arithmetic needed. run_date is the last bar's own date (dates[-1], from
    # price_bars_primary's DB-native America/New_York date), not Python's system clock --
    # matches this codebase's own SQL-CURRENT_DATE-not-JS/Python-local-date convention. Each
    # day's LATEST becomes its own row (run_date differs daily), so this doubles as a running
    # history of "what was the forward view, as of that night" -- useful later for checking
    # forecast-vs-realized.
    am_latest = arch_model(returns, vol='Garch', p=1, q=1, dist='Normal', rescale=False)
    latest_degenerate = False
    try:
        res_latest = am_latest.fit(disp='off')
        fcast_latest = res_latest.forecast(horizon=1, align='origin')
        latest_pred_vol = np.sqrt(fcast_latest.variance.iloc[-1, 0])
        omega_l = res_latest.params.get('omega', 0)
        alpha_l = res_latest.params.get('alpha[1]', 0)
        beta_l = res_latest.params.get('beta[1]', 0)
        persistence_gap_l = 1 - alpha_l - beta_l
        if persistence_gap_l > PERSISTENCE_FLOOR:
            latest_unc_vol = np.sqrt(omega_l / persistence_gap_l)
        elif last_valid_unc_vol is not None:
            latest_unc_vol = last_valid_unc_vol
            latest_degenerate = True
        else:
            latest_unc_vol = latest_pred_vol
            latest_degenerate = True
        latest_scale = latest_pred_vol / latest_unc_vol
    except Exception:
        latest_pred_vol = 1.0
        latest_unc_vol = last_valid_unc_vol if last_valid_unc_vol is not None else 1.0
        latest_scale = latest_pred_vol / latest_unc_vol
        alpha_l = None
        beta_l = None
        latest_degenerate = True
    latest_run_date = dates[-1]
    print(f"LATEST (as of {latest_run_date} close, forecast for next session): scale={latest_scale:.4f} degenerate={latest_degenerate}")

    print("Upserting into performance_audit...")
    # FIXED 2026-09-08 (DeepSeek design critique, caught before the dual-barrier shadow
    # work was built on top of this): run_date used to be datetime.date.today() -- the day
    # the SCRIPT ran, shared by every row in a given run -- rather than `d`, the actual
    # trading day each row describes. Since the real UNIQUE constraint is
    # (run_date, window_days, signal_type, signal_name), a later re-run with a new
    # run_date but the same signal_name (=str(d)) would INSERT a duplicate row instead of
    # updating the existing one -- the ON CONFLICT target would simply never match. Using
    # run_date=d makes the key naturally idempotent per trading day regardless of when the
    # script (or a future incremental daily version of it) actually runs. The 317
    # pre-existing rows were migrated to this convention in the same session (backup:
    # performance_audit_garch_rundate_backup_20260908, see docs/DB_BACKUP_CATALOG.md).
    for d, pred_vol, unc_vol, scale, alpha, beta, degenerate in garch_records:
        notes_json = json.dumps({
            'trade_date': str(d),
            'forecast_vol': float(pred_vol),
            'unc_vol': float(unc_vol),
            'scale': float(scale),
            'alpha': float(alpha) if alpha is not None else None,
            'beta': float(beta) if beta is not None else None,
            'degenerate_fallback': bool(degenerate),
        })
        cursor.execute("""
            INSERT INTO performance_audit (
                run_date, window_days, signal_type, signal_name, sample_size, notes
            ) VALUES (%s, 0, 'GARCH_VOL_SCALE', %s, 1, %s)
            ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
                notes = EXCLUDED.notes
        """, (d, str(d), notes_json))

    latest_notes_json = json.dumps({
        'as_of_close': str(latest_run_date),
        'forecast_vol': float(latest_pred_vol),
        'unc_vol': float(latest_unc_vol),
        'scale': float(latest_scale),
        'alpha': float(alpha_l) if alpha_l is not None else None,
        'beta': float(beta_l) if beta_l is not None else None,
        'degenerate_fallback': bool(latest_degenerate),
        # p01/p99 included here so a downstream consumer (server/services/volatilityRegime.js)
        # can show where this reading sits within its own recent historical range (purely
        # descriptive context, not a hot/normal/cold classification -- that label was tested
        # and removed, see volatilityRegime.js's header comment), instead of re-deriving
        # percentiles from the full historical series itself.
        'p01': float(p01),
        'p99': float(p99),
    })
    cursor.execute("""
        INSERT INTO performance_audit (
            run_date, window_days, signal_type, signal_name, sample_size, notes
        ) VALUES (%s, 0, 'GARCH_VOL_SCALE', 'LATEST', 1, %s)
        ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
            notes = EXCLUDED.notes
    """, (latest_run_date, latest_notes_json))

    print("Backfill complete.")

if __name__ == "__main__":
    main()
