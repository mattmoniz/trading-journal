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

// Trading-day dates (CLAUDE.md cv-073/cv-074, Fable audit F35, 2026-11-10). the ISO-string date slice of `new Date()` is the UTC date, which is TOMORROW's date after 19:00-20:00 ET;
// a Date built from toLocaleString('en-US', {timeZone: 'America/New_York'}) and then toISOString()'d is wrong in the other direction when the process timezone is not UTC. These two
// helpers always answer "what is the date on the New York wall clock at this instant", independent of the process timezone.
export function etDateOf(instant = new Date()) {
  return new Date(instant).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
}
export const etToday = () => etDateOf(new Date());
/** Calendar-day arithmetic on a YYYY-MM-DD string (UTC noon anchor, so no DST or timezone edge). */
export function shiftDays(dateStr, n) {
  const d = new Date(`${dateStr.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
