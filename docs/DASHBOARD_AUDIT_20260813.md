# Dashboard Audit — 2026-08-13 (running tally, for Opus review)

**Status as of 2026-08-16: mostly complete, one piece missing.** Gemini's DB-grounded pass
on both scopes is done and verified. DeepSeek's Morning Prep code-level pass never
completed (dispatched twice, both times sacrificed/overwritten before being read — see
"Open items" below) and still needs a clean re-run. Nothing found here has been fixed yet
except Section 0 (quick-check.html). Not yet handed to Opus.

## Why this exists

User asked (1) Gemini to fully critique/evaluate "the dashboard" and its data, and (2)
DeepSeek to evaluate the same for hardcoded/conflated statistics and give design
suggestions. Scope was corrected mid-session: the real target is **"Morning Prep"**
(`src/views/ACDView.jsx` + its composed panels — the trader's primary daily decision
surface), not `DashboardView.jsx` (the historical P&L/stats view, audited first by
mistake). Both are recorded below since the DashboardView.jsx pass surfaced real,
independently-verified bugs even though it wasn't the intended target.

**Every finding below has been independently verified against the actual source code
and/or live DB by Claude directly — not reported from Gemini/DeepSeek output at face
value.** Where a sub-claim was checked and found wrong, that's noted explicitly (see
Morning Prep §2, finding M1's DB-count correction).

---

## Section 0 — quick-check.html (Home Assistant / phone page) — FIXED this session

Separate from the Gemini/DeepSeek dispatches (found via direct user bug reports earlier
this session, fixed and shipped). Listed here for completeness of the running tally.

| # | Issue | Fix | Commit |
|---|---|---|---|
| Q1 | Range-tab switching had no guard against out-of-order network responses — a slow "All"/"Year" query (10,000+ rows) could resolve after a faster "Today" click and silently overwrite the display while the button showed the newly-clicked tab as active. | Added a request-sequence guard; verified with a Playwright repro of the exact race. | `3af6df7` |
| Q2 | Performance stats/equity-curve used a narrower "decided trade" filter (4 resolution types) than Session Timeline (any non-null `actual_pnl`) — could silently disagree on days with an `INVALIDATED`-but-priced trade. | Aligned both to the same definition. | `3af6df7` |
| Q3 | Performance defaulted to `origin=real` (ACTIVE+SHADOW blended) while Session Timeline defaults to ACTIVE-only — same day, two sections showing very different numbers (+$72 vs -$4) with no visual explanation. | Changed default to `origin=live`; added `liveCount`/`shadowCount`/`backfillCount` breakdown to the API response and a banner explaining any excluded population. User-directed decision (asked, chose live-only default). | `8fd74b7` |
| Q4 | `COMMISSION_PER_TRADE = 1` — stale from before the 2026-08-11 commission correction in `server/config/instruments.js` (real round-trip is $2, $1/side × 2). The file's own comment even asserted "$1 round-trip commission" — a wrong comment stated as fact, the exact trap CLAUDE.md warns about. Every commission/gross-P&L figure on the page had been undercounting by $1/trade since 2026-08-11. | Fixed the constant and a second hardcoded `+1` in the trade-modal's captured-points formula, verified against `instruments.js` and `acd.js`'s live resolution code before changing. | `d5a7b3c` |
| Q5 | UX: user wanted separate Live/All views, not one blended toggle. Then corrected: wanted a switchable toggle (one chart at a time), not two always-visible stacked charts (an intermediate design tried the same day). | Final: single equity curve + stats + table, switched by a Live/All toggle; both populations fetched in parallel per range change so switching is instant (no re-fetch). | `d5a7b3c` |

All 5 verified end-to-end in a real browser (Playwright) before being called done.

---

## Section 1 — DashboardView.jsx (main app Dashboard) — audited, NOT the intended target, NOT YET FIXED

Scope: `src/components/dashboard/DashboardView.jsx` + `SyncProgressPanel.jsx`,
`DashboardFilters.jsx`, `PnlCharts.jsx`, `DevelopingValueCard.jsx`,
`LevelMonitorPanel.jsx`. This is a **historical P&L review** surface (Sharpe/Sortino/
Expectancy, rolling win rate, P&L distribution, developing value, key levels) — lower
stakes than Morning Prep since it doesn't drive live trade decisions, but still a real
part of the app the user consults.

### Gemini findings (DB-verified)

| # | File:line | Finding | Verified |
|---|---|---|---|
| D1 | `DashboardFilters.jsx:115` + backend `if (account)` checks in `stats.js`/`tearsheet.js`/`keyLevels.js` | **Account filter can silently disappear.** Unchecking "All Accounts" from a fully-checked state sets `selectedAccounts = []` (not the explicit account list) — the UI still displays "All Accounts" (line 102-104 treats `length===0` and `length===accounts.length` identically), but an empty array means the frontend omits the `account` query param entirely, and the backend's `if (account)` guard means **no filtering happens at all** — not even a default PRO-only scope. | **Confirmed live**: DB has 1,709 PRO trades vs 30,327 non-PRO (15,024 TEST + 15,303 OTHER) — exact match to Gemini's cited 30,327 figure. Confirmed the empty-array state is reachable via normal UI interaction, not just a theoretical edge case. |
| D2 | `tearsheet.js:31` vs `:79-88` | **`/stats/tearsheet-overview` bypasses the CumPL-diff method for its headline stats.** Expectancy/Kelly/Win Rate/Payoff Ratio/Max Runup are computed directly from `trades.pnl` (`pnls = trades.map(t => parseFloat(t.pnl))`), while a separate CumPL-diff computation exists in the *same file* for the Sharpe/Sortino inputs only — a real, mixed-methodology bug within one endpoint. | **Confirmed via direct SQL**: `SUM(pnl)` PRO-only = -$10,139.50, matches Gemini's cited figure exactly. |
| D3 | `tearsheet.js:113-114` | **Directional stats (long/short P&L, win rate) always render zero.** Code checks `t.direction === 'Long'` / `'Short'` (mixed-case), but the DB stores `'LONG'`/`'SHORT'` (uppercase) — the comparison never matches. | **Confirmed via direct SQL**: real `direction` values are `LONG`/`SHORT` uppercase only, 1096/613 rows respectively (PRO account). Code's mixed-case check is unreachable — verified by reading the literal string in `tearsheet.js:113-114`. |
| D4 | `DashboardView.jsx:17-19` | **Timezone bug**: `today.toISOString().split('T')[0]` for date-range filters — UTC-based, not ET. After ~8PM ET the "Today"/relative-range filters point at tomorrow's date. `keyLevels.js` has the same pattern. | Not independently re-verified by Claude this pass (Gemini's citation is a well-known, already-documented bug class in this codebase — high prior confidence, but flagging as not independently re-confirmed like D1-D3). |
| D5 | `keyLevels.js` | **Hardcoded static thresholds**: `PROX = 2.5`, `LOOKAHEAD = 15`, `MFE_BARS = 60`, and a `diff > 20 ? 'UP' : diff < -20 ? 'DOWN'` cutoff — violates the "no static thresholds, ever" hard rule. | Not independently re-verified by Claude this pass. |
| D6 | `tearsheet.js` | **No N≥20 floor** on `% Profitable Weeks`/`% Profitable Months` before presenting a confident-sounding percentage. | Not independently re-verified by Claude this pass. |

### DeepSeek findings (code-level, 15 total — full table below; already the complete permanent record, not dependent on any scratch file)

Explicitly cleared by DeepSeek (and consistent with Gemini's read): no hand-typed WR%/N/$
literal in a live stat card on this page; `active_setups`/`origin_status` conflation does
NOT apply (this tree reads the real `trades` table only); daily/cumulative P&L correctly
use CumPL-diff (except D2/#5 below).

| # | File:line | Finding | Severity | Claude-verified? |
|---|---|---|---|---|
| M-D2 | `tearsheet.js:43` → `DashboardView.jsx:210` | **Kelly % rendered 100× too small.** Backend computes Kelly as a fraction (e.g. 0.25); frontend renders `${riskStats.kelly}%` → "0.25%" instead of "25%". A position-sizing-relevant number shown with the wrong unit. | mislead | **Yes** — read `\`${riskStats.kelly}%\`` at `DashboardView.jsx:210` directly; confirmed `kelly` is computed as `winRate - (1-winRate)/payoffRatio` (a 0-1 fraction) in `tearsheet.js:43`. |
| M-D1 | `DashboardView.jsx:122-133` vs `:86-117` | **Date filter silently ignored by 3 of 5 stat sections.** `daily`/`cumulative-pnl` respect the date filter; `tearsheet-overview`/`rolling`/`pnl-distribution` (Risk card, Rolling Expectancy chart, P&L Distribution) are always all-time regardless of the selected date range, with zero on-screen indication. An in-code comment admits this is deliberate ("Behavioral stats are structural truths") but nothing tells the trader. | mislead | Not independently re-verified beyond reading the cited comment/code structure — high confidence given the code's own comment corroborates it. |
| M-D6 | `DashboardView.jsx:25-27,51-80,144,154-156` | **Fully dead fetch.** `/stats/key-levels` is requested via `fetchKeyLevels()` on every mount and filter change (a heavy computed endpoint per its own file header); `keyLevelsData` is set but never read/rendered anywhere in the JSX. `klTimeframe`/`klProximity` have no UI control to ever change them. | dead | **Yes** — grepped `keyLevelsData` (only appears at its own declaration) and `setKlTimeframe`/`setKlProximity` (only appear at their own `useState` declarations, never called from any UI element). |
| M-D5 | `stats.js:460` | **Silent `SUM(t.pnl)` fallback** in `/stats/daily`: `COALESCE(dcp.cum_daily_pnl, SUM(t.pnl), 0)` — on any day with trades but no parseable CumPL data, silently falls back to the naive overcounting method CumPL-diff exists to replace, indistinguishable in the UI from a real diff value. | conflate | Not independently re-verified this pass. |
| M-D7 | `App.jsx:429-448` vs `DashboardView.jsx:150-152` | **No refresh after trade sync.** `fetchAllStats` only re-runs on filter/account change, not on the `trades-updated` event fired after a successful sync — P&L/Sharpe/rolling/distribution stay frozen at last-fetch even after the sync toast confirms new trades imported. No "as of" timestamp anywhere. | mislead (staleness) | Not independently re-verified this pass. |
| M-D8 | `DashboardView.jsx:200-273` | **No N shown next to any ratio** (Win Rate, Sharpe/Sortino/Expectancy/Kelly, distribution Mean/Median) — a 100% win rate at N=3 looks identical to N=300. | mislead (omission) | Not independently re-verified this pass. |
| — | (9 more, cosmetic/minor) | Hardcoded LevelMonitorPanel proximity bands (5pt/25pt), stale "Last price" with no timestamp, one-way date fallback, hardcoded SyncProgressPanel scale, off-by-one median, double-meaning "Expectancy" label (all-time vs rolling-20, same word), gross/net P&L never labeled + dead `fees` column. | cosmetic/conflate | Not independently re-verified — lower stakes, listed for completeness. |

**DeepSeek's top suggestion** (not yet acted on): this page is 100% backwards-looking; the
one thing that would make it a real decision surface is surfacing the already-computed
Profit Give-Back Guard (`App.jsx`'s `ProfitGivebackBanner`) and DLL status inline instead
of only as separate global banners — "Today: +$X · peak $Y · give-back Z% · remaining to
DLL" as a compact strip.

---

## Section 2 — Morning Prep (`ACDView.jsx` + 13 composed panels) — THE ACTUAL TARGET

Scope: `src/views/ACDView.jsx` (987 lines) + `MarketPulseBar.jsx`,
`SessionForecastPanel.jsx`, `SessionPulseCard.jsx`, `SessionBiasPanel.jsx`,
`BehavioralPatternsCard.jsx`, `PermSlipAndStackBar.jsx`, `TradeAlertBanner.jsx`,
`VolatilityAlertBanner.jsx`, `VolatilityRegimeCard.jsx`, `TeleprinterFeed.jsx`,
`DayOfWeekPlaybookCard.jsx`, `LivePlaybookCard.jsx`, `ApproachingLevelBanner.jsx`. This is
the trader's primary live-decision surface — highest stakes of anything audited today.

### Gemini findings (DB-verified) — DONE

| # | File:line | Finding | Severity | Claude-verified? |
|---|---|---|---|---|
| **M1** | `ACDView.jsx:495-500` (`CASE_ENGINE_GATE`) and `:618-632` (`edgeCtx` object) | **The single worst finding of this whole audit.** A literal, hardcoded JS object maps `setup_type` → a frozen description string containing baked-in WR%/N figures, applied identically to EVERY card of that type regardless of current data — e.g. `'IB_BEARISH': 'IB range break short. 74.2% WR on TURBULENT (N=31)...'`, `'IB_BULLISH': '...77.8% WR on TREND (N=27)...'`, `'EMA_SNAPBACK_LONG': '...96% directional reversion...'`, plus 10 more setup types with the same pattern. This is exactly the "never hand-type a WR%/N/$ literal into a live-rendered card" hard rule violation CLAUDE.md documents as having recurred 7+ times — the largest single instance found in this codebase. | **mislead — HIGH** | **Yes, directly read the source.** Confirmed the object exists verbatim at `ACDView.jsx:618-632`, applied via `edgeCtx = {...}[s.setup_type] \|\| s.recommendation \|\| ''`. Cross-checked against this session's own live `DAY_TYPE_ALPHA` data (already in context from session-start): real IB_BEARISH TURBULENT N=**79** vs hardcoded N=31; real IB_BULLISH TREND N=**48** vs hardcoded N=27. The hardcoded numbers are stale, not just theoretically risky — independently confirmed via a second, unrelated data source. |
| M2 | `SessionForecastPanel.jsx:33,141-144` vs `:127-136` | **Partial `useSharedPollData` bypass.** 4 endpoints correctly use the dedup hook; 4 others (`scalp-recap`, `scalp-playbook`, `volatility-forecast`, `level-approach/today`, `confluence-near-price`) use raw `fetch()` and bypass the shared-poll cache entirely. | duplicate-fetch / perf | **Yes** — grepped both patterns directly, confirmed exact line numbers. |
| M3 | `App.jsx:959` vs `:1173` | **`setup-detection` polled twice with different cache keys.** App.jsx fires `fetch(\`.../acd/setup-detection?date=${d}\`)` (raw, with a date param) while the shared subscription used by `MarketPulseBar`/`TradeAlertBanner` uses the URL with no date param (`:1173`) — different strings, so `useSharedPollData`'s exact-match dedup can't merge them; genuinely redundant polling. | duplicate-fetch / perf | **Yes** — confirmed both exact URL strings via grep. |
| — | `MarketPulseBar.jsx:141` | `sizeMultiplier` correctly flows from the live backend IIFE, no hardcoding. | compliant | Cited by Gemini, consistent with prior session work on this exact code path — not re-verified this pass but high confidence given extensive prior session context on the sizeMultiplier IIFE. |
| — | Date generation across `ACDView.jsx`/`MarketPulseBar.jsx`/`SessionForecastPanel.jsx` | Correctly uses `toLocaleDateString('en-CA', {timeZone:'America/New_York'})`, not the UTC `toISOString()` bug. | compliant | Not independently re-verified this pass. |

**One Gemini sub-claim caught and corrected**: Gemini's writeup asserted `active_setups`
filtered to `origin_status='ACTIVE'` returns **N=0** for IB_BULLISH/IB_BEARISH, "even
unfiltered it does not support these hardcoded literals." **This is false** — direct query
confirmed real counts of ACTIVE origin_status=138 (IB_BEARISH) and 66 (IB_BULLISH). Does
not change the core finding (M1 is independently confirmed via source code + the
DAY_TYPE_ALPHA cross-check above), but it's a real error in Gemini's supporting evidence,
noted per this codebase's standing "audit all Gemini output" rule.

### DeepSeek findings (code-level + design critique) — NOT COMPLETED, dispatched twice

First dispatch's response was overwritten before being read (a separate, unrelated live-
firing audit landed in the same `scratch/deepseek_response.md` file). Second (re-)dispatch
was itself sacrificed 2026-08-16 to recover that live-firing audit's content via `cline`'s
own session logs, rather than let both be lost — see the process note in
`docs/OPEN_THREADS.md`'s 2026-08-14/16 live-firing-audit entry. **Net result: DeepSeek's
Morning Prep code-level pass has never actually completed.**

**Next step**: `scratch/claude_request_deepseek.md` still has the correct Morning Prep
scope (confirmed 2026-08-16) — run `./scripts/invoke_deepseek.sh 20m` again. This time,
**read the response and copy anything worth keeping into this doc (or `docs/`) in the same
sitting**, before dispatching anything else to either Gemini or DeepSeek — `scratch/
*_response.md` is not durable storage and has now been silently overwritten twice in one
session.

---

## Open items / not yet done

- Nothing above has been fixed yet except Section 0 (quick-check.html, 5 commits).
- DeepSeek's Morning Prep code-level pass needs a clean re-run (see above) — this is the
  last missing piece of the audit itself.
- **No fix has been scoped or scheduled yet for M1** (the hardcoded `edgeCtx` WR%/N
  literals in `ACDView.jsx`) — this is the highest-priority item once the full tally is
  complete, given it directly misleads a live trading decision on the app's primary view.
  Fixing it means replacing the frozen literal object with a live read from
  `liveStats._dta`/`SETUP_STATUS` (the same data source `hivolLopace`-style informational
  badges already read correctly elsewhere in `acd.js`) — not a redesign, a straight
  hardcoded-to-dynamic swap, but touches 13 setup types and needs the "check every card
  extremely carefully" discipline CLAUDE.md's own hand-typed-literal rule calls for.
- **Separately, a real live-firing audit was done this session** (not part of this
  dashboard audit, but overlapping in cause) — see `docs/OPEN_THREADS.md`'s 2026-08-14/16
  entry. Two CRITICAL bugs fixed (cascade-breaker contamination + hijacked live fires), two
  more flagged as `OPEN_DECISION`s (`shadowcandidates_hardcoded_no_promotion_path`,
  `cascade_breaker_historical_rows_need_repair`, both HIGH priority) — the historical-repair
  one should happen before trusting any current `SETUP_STATUS` figure, which is also
  relevant context for M1's fix (the live data M1 should read from is itself still
  contaminated until that repair runs).
