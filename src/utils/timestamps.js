// Timestamp utilities — all date/time formatting in one place.
// Timezone: always America/New_York (ET).
// Spec: "Today at 9:42 AM ET" / "Yesterday at 4:15 PM ET" / "May 15 at 11:03 AM ET"

const TZ = 'America/New_York';

function toETDate(ts) {
  const d = new Date(ts);
  return new Date(d.toLocaleString('en-US', { timeZone: TZ }));
}

function todayETString() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // 'YYYY-MM-DD'
}

/**
 * Full timestamp display.
 * Returns: "Today at 9:42 AM ET" | "Yesterday at 4:15 PM ET" | "May 15 at 11:03 AM ET"
 * Returns "Not yet logged" for null/undefined.
 */
export function formatTimestamp(ts) {
  if (!ts) return 'Not yet logged';

  const d = new Date(ts);
  const tsDay = d.toLocaleDateString('en-CA', { timeZone: TZ });
  const todayStr = todayETString();
  const yesterdayStr = new Date(Date.now() - 86400000)
    .toLocaleDateString('en-CA', { timeZone: TZ });

  const timeStr = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: TZ,
  }) + ' ET';

  if (tsDay === todayStr)     return `Today at ${timeStr}`;
  if (tsDay === yesterdayStr) return `Yesterday at ${timeStr}`;

  const dateStr = d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: TZ,
  });
  return `${dateStr} at ${timeStr}`;
}

/**
 * Short form for field-level timestamps (inline in rows).
 * Returns: "9:42 AM" for today | "May 15" for other days | null for missing.
 */
export function formatFieldTimestamp(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  const tsDay = d.toLocaleDateString('en-CA', { timeZone: TZ });
  if (tsDay === todayETString()) {
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: TZ,
    });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: TZ });
}

/**
 * Returns true if the timestamp is older than hoursThreshold hours,
 * or if ts is null/undefined.
 */
export function isStale(ts, hoursThreshold = 24) {
  if (!ts) return true;
  return Date.now() - new Date(ts).getTime() > hoursThreshold * 3600000;
}

/**
 * Latest of several nullable timestamps (for phase headers).
 * Returns the most recent non-null value, or null.
 */
export function latestOf(...timestamps) {
  const valid = timestamps.filter(Boolean).sort();
  return valid.length ? valid[valid.length - 1] : null;
}
