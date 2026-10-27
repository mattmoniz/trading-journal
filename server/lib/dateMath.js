// Calendar month arithmetic that cannot overflow. `Date.setUTCMonth(getUTCMonth() - n)` asks for a day that may not exist in the target month
// (July 31 minus one month = "June 31" = July 1), so the result silently lands in the CURRENT month. Found 2026-10-27: compute_levels.js used it for the
// prior-month levels and the 3-month window start, so 17 trading dates since 2023-03 (every 31st after a 30-day month, plus March 29-31) carried the CURRENT
// month's high/low/value area as "prior month". Always shift by whole months through this helper: the day of month is clamped to the target month's last day.
export function shiftMonthsClamped(dateStr, n) {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  const t = Date.UTC(y, m - 1 + n, 1), ty = new Date(t).getUTCFullYear(), tm = new Date(t).getUTCMonth();
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ty, tm, Math.min(d, last))).toISOString().slice(0, 10);
}
