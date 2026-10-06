# Day management scope (RTH)

Status: scope only, not built. Written 2026-10-06 as the reference for the OCO build.
Audience: the trader, and whoever builds or reviews the order path.

## Before the open
- Confirm the Sierra Chart switch state and the broker connection. Halt if either is unknown.
- Confirm the broker is flat. If a position is open from before, flag it and do not place new entries.
- Cancel any resting orders left from the prior session.
- Load the day's fixed levels (prior-day levels now; opening-range and initial-balance levels as they form).

## One position at a time
- Only one position may be open at the broker at once. This is enforced in the database, not only in code.
- Opposite-direction entries are blocked while a position is open. Same-direction entries are allowed.
- A setup that has just traded is blocked from re-firing for a cooldown.

## Each entry
- Entry is a limit at the setup's level.
- When the entry fills, one OCO is placed with the fixed stop and the fixed target. Whichever fills first cancels the other.
- Step-trail, runner and breakeven variants are out of scope until a second stage (they need cancel-and-replace on every move).
- The app records the broker's fill, not its own estimate.

## Between trades
- Track the day's realized P&L from broker fills against the daily loss limit (server/routes/dll.js). When the limit is hit, halt new entries for the rest of the day.
- Log every skipped setup with a reason: switch off, position already open, suppressed, cooldown, outside time window, entry already traded through.
- Dead zones: no new entries 9:30 to 9:35 ET, and none 4:00 to 6:00 PM ET.

## Session end
- Cancel every resting entry.
- Confirm the broker is flat. If not, flag loudly. Do not assume closed.
- Write the daily summary: broker fills, skipped setups with reasons, P&L from broker fills.

## Monitoring
- Sierra Chart page: live trades, activity log, unconfirmed closes.
- Anything the app cannot confirm with the broker is flagged for review. The app does not halt on its own unless the owner changes that rule.

## Not in this scope
- Re-entry on the same level after a stop-out.
- Globex.
- Morning pre-placed limits (a separate pilot; see the morning-orders note).
