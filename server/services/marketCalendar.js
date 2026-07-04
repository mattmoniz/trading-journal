// NYSE / CME NQ market calendar — holidays and early closes.
// Early close = 1:00 PM ET (RTH ends at 13:00 instead of 16:00).
// Covers 2024–2026. Add future years as needed.

const HOLIDAYS = new Set([
  // 2024
  '2024-01-01', // New Year's Day
  '2024-01-15', // MLK Day
  '2024-02-19', // Presidents' Day
  '2024-03-29', // Good Friday
  '2024-05-27', // Memorial Day
  '2024-06-19', // Juneteenth
  '2024-07-04', // Independence Day
  '2024-09-02', // Labor Day
  '2024-11-28', // Thanksgiving
  '2024-12-25', // Christmas

  // 2025
  '2025-01-01', // New Year's Day
  '2025-01-09', // National Day of Mourning (Jimmy Carter)
  '2025-01-20', // MLK Day
  '2025-02-17', // Presidents' Day
  '2025-04-18', // Good Friday
  '2025-05-26', // Memorial Day
  '2025-06-19', // Juneteenth
  '2025-07-04', // Independence Day
  '2025-09-01', // Labor Day
  '2025-11-27', // Thanksgiving
  '2025-12-25', // Christmas

  // 2026
  '2026-01-01', // New Year's Day
  '2026-01-19', // MLK Day
  '2026-02-16', // Presidents' Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed — Jul 4 is Saturday)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
]);

// 1:00 PM ET early close (RTH ends at etMin 780 instead of 960)
const EARLY_CLOSES = new Map([
  // 2024
  ['2024-07-03', 'July 4th eve'],
  ['2024-11-29', 'day after Thanksgiving'],
  ['2024-12-24', 'Christmas Eve'],

  // 2025
  ['2025-07-03', 'July 4th eve'],
  ['2025-11-28', 'day after Thanksgiving'],
  ['2025-12-24', 'Christmas Eve'],

  // 2026
  ['2026-07-02', 'July 4th eve'],
  ['2026-11-27', 'day after Thanksgiving'],
  ['2026-12-24', 'Christmas Eve'],
]);

const HOLIDAY_NAMES = new Map([
  ['01-01', "New Year's Day"],
  ['01-09', 'National Day of Mourning'],
  ['01-15', 'MLK Day'], ['01-19', 'MLK Day'], ['01-20', 'MLK Day'],
  ['02-16', "Presidents' Day"], ['02-17', "Presidents' Day"], ['02-19', "Presidents' Day"],
  ['03-29', 'Good Friday'], ['04-03', 'Good Friday'], ['04-18', 'Good Friday'],
  ['05-25', 'Memorial Day'], ['05-26', 'Memorial Day'], ['05-27', 'Memorial Day'],
  ['06-19', 'Juneteenth'],
  ['07-03', 'Independence Day (observed)'], ['07-04', 'Independence Day'],
  ['09-01', 'Labor Day'], ['09-02', 'Labor Day'], ['09-07', 'Labor Day'],
  ['11-26', 'Thanksgiving'], ['11-27', 'Thanksgiving'], ['11-28', 'Thanksgiving'],
  ['12-25', 'Christmas'],
]);

/**
 * Returns null if normal trading day, or an object describing the special status:
 *   { type: 'HOLIDAY', name: 'Independence Day' }
 *   { type: 'EARLY_CLOSE', name: 'July 4th eve', rthCloseEtMin: 780 }
 */
export function getMarketStatus(dateStr) {
  if (HOLIDAYS.has(dateStr)) {
    const mmdd = dateStr.slice(5);
    const name = HOLIDAY_NAMES.get(mmdd) || 'Market Holiday';
    return { type: 'HOLIDAY', name };
  }
  const earlyCloseLabel = EARLY_CLOSES.get(dateStr);
  if (earlyCloseLabel) {
    return { type: 'EARLY_CLOSE', name: earlyCloseLabel, rthCloseEtMin: 780 }; // 1:00 PM ET
  }
  return null;
}

export function isHoliday(dateStr) {
  return HOLIDAYS.has(dateStr);
}

export function getEarlyCloseMinute(dateStr) {
  return EARLY_CLOSES.has(dateStr) ? 780 : null; // 780 = 1:00 PM ET; null = normal 4 PM close
}
