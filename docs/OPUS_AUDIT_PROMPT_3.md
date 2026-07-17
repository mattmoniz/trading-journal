# AUTONOMOUS — OPUS STRATEGIC AUDIT (AUDIT #3): closed-loop learning / lost-state audit

You are Claude Opus 4.8. **Audits 1 and 2 covered code/data integrity and strategy-alignment.** This audit answers a narrower, more urgent question that came up mid-session 2026-07-17: **can this system actually prove it's learning, or does it just relabel things and move on?**

Deliverable: `scratch/opus_audit_3_results.md` — structured findings + a concrete design recommendation. Same format as Audits 1/2. No code for immediate paste — action items specific enough that Sonnet can execute cold, including a schema/migration plan if you recommend one.

---

## What triggered this audit (read this first, it's the whole point)

Investigating "can we tell if the system is learning," Sonnet found:

1. **`SETUP_STATUS` (`performance_audit`, weekly recalibration via `backtest_setup_status.mjs`) genuinely flips recommendations based on fresh data** — 41 real flips across history, not just re-confirmations (e.g. `PD_VAL_FADE_LONG` went `ACTIVE→SUPPRESS→PROMOTE` within two days, 07-14/07-15). This part works.
2. **But there is no closed loop.** The mechanism that should validate a suppression decision — firing a suppressed (`SUPPRESS`/`THIN_N`) setup as `status='SHADOW'` so its real forward outcome can be checked against the decision that suppressed it — has **zero live rows right now**, and worse: **`active_setups` has no field that survives resolution to say whether a resolved trade originated as `ACTIVE` (real, live-visible) or `SHADOW` (suppressed, background-only).** Every `UPDATE active_setups SET status='RESOLVED', ...` (grep `server/routes/acd.js` for `status='RESOLVED'` — 6+ call sites) overwrites the `SHADOW` label the instant a trade resolves. `resolution_method` (the only other candidate field) only records HOW a trade resolved (`PRICE_CLEAN`/`BACKFILL`/`SAME_BAR_STOP_FIRST`/`EARLY_TOUCH_BACKFILL`), not WHETHER it was ever live.
3. **Practical consequence**: every dollar figure this session computed from `active_setups.actual_pnl` (a 1-year walk-forward backtest, a weekly P&L readout, a DLL Monte Carlo sweep) may silently mix real, user-visible trades with suppressed, background-only ones, with no way after the fact to separate them. Not confirmed how much this actually distorted any specific number — that's part of what this audit should help scope.
4. **Also found the same day**: `expireStaleSetups()` (`server/routes/acd.js` ~line 519-538) does `DELETE FROM active_setups WHERE status = 'SHADOW' AND trade_date < $1` — a genuine cleanup (purges abandoned candidates that never resolved same-day, prevents unique-constraint conflicts), but it means any SHADOW candidate that never resolves same-day is destroyed with **zero trace**, not even a resolved-with-null-outcome row. Whether this cleanup is itself contributing to the "SHADOW row count = 0" finding, or is orthogonal to it, needs checking.

## Three questions this audit must answer

### 1. Can SHADOW origin be reconstructed for historical data?

`performance_audit`'s `SETUP_STATUS` rows retain a `run_date` per calibration run (confirmed: not overwritten in place, a real history exists — check how far back it actually goes, a prior check this session found `OPTIMAL_STOP`'s history only goes back ~10 days, `SETUP_STATUS`'s depth is unconfirmed). In principle, for any historical `active_setups` row, you could look up the most recent `SETUP_STATUS` row for that `setup_type` with `run_date <= trade_date` and infer whether it would have been eligible (`ACTIVE`/`PROMOTE`/`DAY_TYPE_MANAGED`) or suppressed (`SUPPRESS`/`THIN_N`) at the moment it fired — i.e., reconstruct the origin via the SAME point-in-time methodology Sonnet already used for this session's walk-forward backtest (`scratch/backtest_prop_1yr_walkforward.mjs`, `scratch/backtest_prop_1yr_sweep.mjs` — read these for the exact pattern already built).
- Is this reconstruction actually sound, or does it silently break down somewhere (e.g., `SETUP_STATUS` history doesn't go back far enough to cover most of `active_setups`' history, or the live insert path's actual SHADOW/ACTIVE decision uses something other than the latest `SETUP_STATUS` row at insert time — check `liveStats._suppressedSetups`, referenced in CLAUDE.md's own hard-rules section, to see exactly what the live decision is actually keyed on)?
- If reconstruction is sound for some date range but not others, say exactly where the line is and why.
- Give a concrete verdict: reconstructable (with what confidence, what date range), or not reconstructable (and therefore historical dollar figures relying on ACTIVE-only filtering should be treated as approximate, not exact, until a certain date).

### 2. What would a real closed-loop validation mechanism look like, going forward?

Design, don't just gesture at "track it better." Concretely:
- What schema change is needed (a new immutable-at-insert column, e.g. `origin_status`, set once and never touched by any `UPDATE ... SET status=...` resolution call — audit every INSERT site in `acd.js`/`minuteBarSignalDetector.js` to confirm all of them can populate it)?
- Should `expireStaleSetups()`'s SHADOW purge change (e.g., resolve-then-purge instead of delete-unresolved, or extend the purge window so same-day-fired SHADOW candidates get a real chance to resolve before being swept)?
- What's the actual validation query/report that should run periodically — e.g., "for every setup_type currently or previously `SUPPRESS`ed, what did its `origin_status='SHADOW'` trades actually do after suppression, and does that EV agree with the decision that suppressed it"? Where should this surface — a new `session-start.sh` hook section (matching the existing `DTM_WATCH`/`FEEDBACK_COVERAGE` pattern), a new `RESEARCH_CLAIM`-style recurring check, or something else?
- Is `SHADOW` firing even happening reliably right now for every currently-`SUPPRESS`ed/`THIN_N` type, or is there a live gap in the firing logic itself (separate from the tracking-after-the-fact problem) that also needs fixing? Check the actual insert-time SHADOW-vs-ACTIVE branch logic in `acd.js`.

### 3. Same pattern search — where else does this codebase silently discard state needed for later validation?

The core defect here is a general shape: **a field gets overwritten on state transition, destroying information a future audit/validation would need, with no one noticing until someone goes looking.** This is a different failure mode than the wrong-$/pt-constant bug (found 4 times this session, already tracked) — it's about lost provenance, not wrong values. Search for the same shape elsewhere:
- Any other `status` or classification field in this schema that gets overwritten on resolution/completion without a preserved "what was it before" trail (check `pattern_discoveries`, `daily_coaching`, `active_setups`' other status-like fields, `dll_daily_events`, `profit_lock_events` if relevant).
- Any place a "was this decision correct" question is implicitly unanswerable because the state needed to check it was discarded — not necessarily in `active_setups`, could be in the coaching/behavioral system, the pattern-discovery lifecycle, or the risk-guardrail tables.
- For each one found, the same verdict format as above: is it live-fixable going forward, and is historical reconstruction possible or not.

---

## Hard rules (same as prior audits)

1. N≥20 before citing any stat as meaningful. Below that, say "N=X (thin)" and do not recommend action.
2. No lookahead — any reconstruction methodology must only use data that existed as of the historical moment being reconstructed (same standard as `scratch/backtest_prop_1yr_walkforward.mjs`).
3. Never fabricate a stat. Query the DB, cite the count.
4. Check `docs/OPEN_THREADS.md` before raising anything already tracked there — search for "SHADOW", "learning", "closed loop" to see what's already documented from this session.
5. Do not implement anything. Do not generate code for immediate paste. Write action items specific enough that Sonnet can execute cold, including exact file/line references where you found something.

## Read first (in this order)

1. `CLAUDE.md` — hard rules, architecture overview, especially the "Setup type checklist" section (items 7/8 already document a related-but-different SHADOW promotion gap)
2. `docs/OPEN_THREADS.md` — search for "SHADOW", "MAE/MFE", "$5", "DLL" to see everything found in this session (2026-07-17 entries)
3. `ARCHITECTURE.md` — table/route inventory
4. `server/routes/acd.js` — search for every `active_setups` INSERT and every `SET status=` UPDATE
5. `scratch/backtest_prop_1yr_walkforward.mjs` and `scratch/backtest_prop_1yr_sweep.mjs` — the point-in-time reconstruction pattern already built this session, reusable for question 1 above
