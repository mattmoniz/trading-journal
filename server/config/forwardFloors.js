// Pre-registered forward evidence floors, one copy for every card that shows progress toward one (docs/FORECAST_SERVICE_20261102.md: a look needs 20 x (looks done + 2) complete forward days;
// docs/REGIME_GAUGE_20261102.md: 30 realized outlooks; docs/AMT_TELL_LIVE_PROJECT_SPEC_20261028.md section 10: about 150 tell trades on at least 60 dates, also the floor of the forward stop-placement books,
// docs/TELL_STOP_PLACEMENT_ARMS_PREREG_20261104.md section 7).
export const FORWARD_FLOORS = { forecastSpanDays: 20, regimeOutlooks: 30, tellTrades: 150, tellDates: 60 };
