# Open Threads Archive

Completed items from [OPEN_THREADS.md](OPEN_THREADS.md). Added here when done rather than deleted, so the record of what was built and why is preserved without bloating the active file.

---

## 2026-07-13

- **`/api/antigravity/edges-context` speed-up complete.** Cold: 1.19s → 1.19s (unchanged — limited by parallel barsQ+medQ). Warm: 270ms → 21-43ms (6-13x faster). Changes: (1) parallelized all 18+ sequential queries into a single Promise.all wave; (2) cached medQ (198ms efficiency percentile) in edgesHistoryCache alongside barsQ; (3) split gapQ (132ms) into cacheable `_prevCloseResult` + fresh 2ms `todayOpenQ`; (4) split priorRTHQ (136ms) into cacheable `_priorRTHResult`; (5) eliminated redundant pvQ (confLevelsQ already had VAH/VAL). Bug found & fixed: prior-day queries used `ts::date < $1` which caught overnight Globex bars with UTC date spill (Friday night crosses into Saturday UTC); fixed by scoping subqueries to dates with actual RTH bars. File: `server/routes/antigravityEdges.js`, function `getLiveEdgesContext()`.

## 2026-07-12

- **App.jsx code-splitting complete.** App.jsx reduced from 17,752 → 1,838 lines (-90%). Main bundle: 1,977 kB → 1,245 kB (-37%). All views extracted to `src/views/`: ACDView (6,556 lines), BacktestView (2,854), CalendarView (2,303), PlaybookView (1,564), ScenarioTesterView (827), AllTradesView (723), LongTermStructureView (529), RiskView (523), TearsheetView (484), SetupHistoryView (219), SettingsView (199). Lazy-loaded chunks: BacktestView, AllTradesView, RiskView, LongTermStructureView, ScenarioTesterView, TearsheetView, SettingsView, SetupHistoryView. Static imports (no splitting): ACDView (Sidebar uses QuickTradeLog + SystemHealthSummary named exports), PlaybookView (ACDView uses LevelConfluenceReference, ConditionBacktestInline, PatternStatsPanel). Future optimization: extract Sidebar to its own file → ACDView can become lazy-split.
