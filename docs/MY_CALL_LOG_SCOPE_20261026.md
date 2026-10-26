# Scope (NOT built): "My call" log — forward scoring of the user's discretionary reads — 2026-10-26

## Why
Over 2026-10-26 about ten pre-registered bar-history studies (floor entries, ES agreement/confirmation, volume/volatility/calendar/structure contexts, NQ-ES divergence, heavy-night range playbook, multi-day drop + floor on our own setups) found no rule, condition or context that beats a matched control after costs on one MNQ contract. The user keeps reading something on the chart that the studies do not capture (example 2026-10-26: a multi-day drop, then a distinct floor, "very obviously a long"; four hits at the floor overnight in shadow, but that setup is roughly flat over its history). The pattern is rare (the strict multi-day drop + twice-retested floor occurs on about 7 percent of dates), so 3.5 years of bars cannot resolve it (38 dates, +58 points over 24h, CI about -33..+165). Idea: capture the read AS IT HAPPENS and score it forward with no hindsight.

## What it is
Two buttons on `server/public/quick-check.html`: LONG and SHORT. A tap writes a row: time (ET), NQ last price, direction, session (RTH/Globex), the overnight tripwire level, the stored levels within a few A15 of price, and optionally the user's target, stop, and quick-pick reasons ("support held", "multi-day drop then base", "heavy volume", "break and retest", free note). No orders, no sizing, no gating, no change to any setup. New table `discretionary_calls`; new isolated route and service file; new nightly scoring script; pre-registration of the scoring rule and the look schedule written BEFORE the first call.

## Scoring (frozen before the first call)
Entry = open of the first minute bar after the tap. Direction-signed forward return in points at +60, +240 and +1,440 minutes, plus MFE and MAE. Control: blind same-direction entries at the same clock time (within 30 minutes) on other days (up to 10 draws), so a call's EXCESS = its return minus the control mean (units of the day's typical range D20 for comparability, points shown too). If the user gave a target and stop: which was touched first (descriptive). Nothing judged before 20 calls and >= 10 distinct days; one scheduled look at that point, then one per 10 further calls; day-blocked bootstrap CI on mean excess at +240 (primary) and +1,440, chronological halves; the smallest detectable effect is always printed so a null reads "no edge above X", never "no edge". Reasons are analysed only descriptively until >= 40 calls.

## Also
Optional second input path: the user tells Claude in chat ("call: long at 29,060") and Claude writes the row (lower timestamp precision, same scoring, flagged `via_chat`). Estimated effort 1.5-2 hours; one server restart; one tunnel allowlist line to add and verify. Alerts to the phone are NOT part of this.

## Expectations stated up front
20-30 calls takes weeks; a plausible outcome is inconclusive; a positive result would be used only to derive rules from the tapped reasons and test those shadow-only; nothing trades from it automatically.
