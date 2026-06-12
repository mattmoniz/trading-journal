# Dashboard & Tearsheet Inventory
### Evidence-Driven Rebuild Reference — 2026-06-08

---

## 1. ALWAYS-VISIBLE SIDEBAR (4 panels, every view)

| Panel | What It Shows | Data Source | Decision It Informs |
|---|---|---|---|
| PostLossCooldown | Countdown timer after a loss; blocks trading during cooldown period | /api/cooldown/status (live) | ACTIVE BRAKE — enforces a behavioral rule in real time |
| SystemHealthSummary | Sync health, last import time, fill counts, stale-data warnings | /api/health | Navigation only — "do I need to re-import?" |
| LiveReadPanel | Live ACD key levels, A Up/Down fired status, structural state for current session | /api/live-signal | PRE-TRADE — A Up/Down status, structural context |
| LiveSessionPanel | Current session P&L, open position, running trade count | Live/DB | IN-SESSION — are you up or down, should you stop? |

Classification: PostLossCooldown = DECISION-RELEVANT. LiveReadPanel = DECISION-RELEVANT. LiveSessionPanel = DECISION-RELEVANT. SystemHealthSummary = REFERENCE.

---

## 2. GLOBAL MODALS (5 modal/banner interrupts)

| Modal | Trigger Condition | Action Required |
|---|---|---|
| DLLBlockingBanner | Daily loss limit hit on any account | Blocks — must stop |
| ProfitGivebackBanner | Profit-lock threshold breached (gave back X% of peak) | Warning — consider stopping |
| OnePMReminderModal | Clock hits 1 PM ET | Reminds to check 1 PM P&L vs rule |
| UpAndDoneNudge | P&L hits "up and done" threshold | Nudge to stop trading |
| SetupEventModal | Trade entry detected | Prompt to tag setup |

Classification: All 5 = DECISION-RELEVANT (active intervention logic).

---

## 3. DASHBOARD TAB

### 3a. Header Row

| Item | What It Shows | Classification |
|---|---|---|
| SyncProgressPanel | Import sync status, progress bar, last sync timestamp | REFERENCE |
| DashboardFilters | Date range selector, account filter | REFERENCE (controls everything below) |
| DashboardQuickNav | Jump links to chart sections | VANITY — anchor links on a single-scroll page |

### 3b. WeeklyReportPanel

Shows current week's daily P&L by day, week total, grade per day. Data: /api/stats/weekly.
Classification: REFERENCE — useful context, rarely changes a same-day decision.

### 3c. MarketRecapPanel

Shows most recent setup event tags with expandable chart modal. Data: /api/recap.
Classification: REFERENCE — review/learning, not real-time.

### 3d. StatsGrid (10 KPI cards)

| Metric | Classification |
|---|---|
| Total P&L | REFERENCE (duplicated in Tearsheet §1) |
| Win Rate | REFERENCE (duplicated in Tearsheet §2 and PerformanceVisuals) |
| Avg Trade | REFERENCE (duplicated in Tearsheet §1) |
| Best Trade | VANITY (duplicated in Tearsheet §1; single outlier, never actionable) |
| Worst Trade | VANITY (duplicated in Tearsheet §1; single outlier, never actionable) |
| Total Trades | REFERENCE (duplicated in Tearsheet §2) |
| Profit Factor | REFERENCE (duplicated in Tearsheet §2 and PerformanceVisuals) |
| Avg Win / Loss | REFERENCE (duplicated in Tearsheet §1) |
| Max Drawdown | REFERENCE (duplicated in Tearsheet §3) |
| Win/Loss Streaks | REFERENCE (duplicated in Tearsheet §2) |

NOTE: All 10 cards are exact duplicates of Tearsheet §1–§3. Nothing here is exclusive.

### 3e. PerformanceVisuals (3 cards)

| Item | What It Shows | Classification |
|---|---|---|
| Duration Analysis | Most profitable/highest WR/most common/best avg P&L duration bucket | REFERENCE (also in OptimizationSection) |
| Profit Factor card | PF gauge with label + Gross Profit/Loss breakdown | VANITY (3rd rendering of PF on same screen) |
| Win Rate donut | Win rate pie chart with W/L counts | VANITY (duplicated from StatsGrid; same number, visual variant) |

### 3f. PnlCharts (4 charts)

| Chart | What It Shows | Classification |
|---|---|---|
| Cumulative P&L | Equity curve, filtered date range | DECISION-RELEVANT — regime detection |
| Daily P&L | Bar chart per day | REFERENCE (duplicated in Tearsheet) |
| By Hour of Day | Total P&L aggregated by entry hour | DECISION-RELEVANT — which hours to avoid/target |
| By Day of Week | Total P&L aggregated by weekday | DECISION-RELEVANT — which days to be cautious |

### 3g. SymbolsTable

Breakdown by symbol: P&L, trades, Win%, Avg P&L.
Classification: VANITY — NQ-only shop; this table is always one row.

### 3h. SetupsTable

Breakdown by setup tag: P&L, trades, Win%, Avg P&L.
Classification: DECISION-RELEVANT — which setups are profitable; directly actionable if tagging is consistent.

### 3i. OptimizationSection (Trade Optimization)

| Item | What It Shows | Classification |
|---|---|---|
| MFE Distribution histogram | Distribution of how far price moved in your favor | DECISION-RELEVANT — calibrates TP targets |
| MAE Distribution histogram (winners) | How far winners dipped before recovering | DECISION-RELEVANT — calibrates stop placement |
| Median MFE card | 50th percentile MFE in points | DECISION-RELEVANT |
| Median MAE (winners) card | 50th percentile MAE of winners | DECISION-RELEVANT |
| MFE Capture Rate card | % of the move actually kept | DECISION-RELEVANT — exit quality signal |
| Suggested TP/Stop card | 75th pct MFE / 75th pct MAE of winners | DECISION-RELEVANT |
| Stop placement table | P&L at various stop distances | DECISION-RELEVANT |
| Performance by Time of Day table | Win%, Avg P&L, count by hour | DECISION-RELEVANT (overlaps PnlCharts By Hour — one should be cut) |

### 3j. BehaviorSection (Trading Behavior Analysis)

| Item | What It Shows | Classification |
|---|---|---|
| Pattern cards (6 types) | Clean Green / Comeback / Partial / Gave Back / Mixed / Straight Down — count, avg P&L | DECISION-RELEVANT — session pattern distribution; directly tied to give-back problem |
| Pattern bar chart | Avg P&L per pattern type | DECISION-RELEVANT |
| Session count by trade count | P&L and WR broken down by sessions traded per day | DECISION-RELEVANT — "does trading more sessions hurt?" |
| First-session WIN stats | Avg S1/S2/S3/final P&L on first-win days; % stayed green | DECISION-RELEVANT |
| First-session LOSS stats | Avg S1/S2/S3/final P&L on first-loss days; % recovered | DECISION-RELEVANT — most relevant panel for post-loss spiral |

Classification: All BehaviorSection items = DECISION-RELEVANT. Most action-relevant section on the entire dashboard.

---

## 4. MORNING PREP TAB (ACDView — 7 tabs)

### 4a. Dashboard sub-tab

| Item | What It Shows | Classification |
|---|---|---|
| MorningBriefPanel (AI Read) | 3–5 bullet AI read of structural state, bias, key price | DECISION-RELEVANT (pre-session only) |
| BigPictureSnapshot | Live ACD structural state, NL, OR, A levels, G-Line, day type | DECISION-RELEVANT (pre-session only) |

### 4b. History sub-tab

ACD number line history, past day-type classification log.
Classification: REFERENCE.

### 4c. Walkthrough sub-tab (PreMarketWalkthrough)

Step-by-step morning prep checklist.
Classification: DECISION-RELEVANT (pre-session only).

### 4d. Chart sub-tab

Embedded chart view.
Classification: REFERENCE.

### 4e. Log sub-tab

ACD log entry history.
Classification: REFERENCE.

### 4f. Backtest sub-tab

| Item | Classification |
|---|---|
| LevelConfluenceReference table | DECISION-RELEVANT — which combo/level setups have edge by category and tier |

### 4g. Correlation sub-tab

Correlation analysis between ACD signals and outcomes.
Classification: REFERENCE.

---

## 5. TEARSHEET VIEW

### §1. P&L Summary (13 KPIs)

| Metric | Classification |
|---|---|
| Total P&L | DECISION-RELEVANT |
| Gross Profit | REFERENCE |
| Gross Loss | REFERENCE |
| Best Trade | VANITY |
| Worst Trade | VANITY |
| Avg P&L/Trade | DECISION-RELEVANT |
| Avg Win | DECISION-RELEVANT |
| Avg Loss | DECISION-RELEVANT |
| Best Day | REFERENCE |
| Worst Day | REFERENCE |
| Avg Win Day | DECISION-RELEVANT (targets) |
| Avg Loss Day | DECISION-RELEVANT (targets) |
| Max Runup | REFERENCE |

### §2. Win/Loss Statistics (15 KPIs)

| Metric | Classification |
|---|---|
| Total Trades | VANITY |
| Winning Trades | VANITY |
| Losing Trades | VANITY |
| Win Rate | DECISION-RELEVANT |
| Breakeven WR | DECISION-RELEVANT |
| Profit Factor | REFERENCE |
| Payoff Ratio | DECISION-RELEVANT |
| Expectancy | DECISION-RELEVANT |
| Win Days | REFERENCE |
| Loss Days | REFERENCE |
| % Profitable Weeks | REFERENCE |
| % Profitable Months | REFERENCE |
| Trading Days | VANITY |
| Max Win Streak | REFERENCE |
| Max Loss Streak | REFERENCE |

### §3. Risk-Adjusted Performance (9 KPIs)

| Metric | Classification |
|---|---|
| Sharpe Ratio | DECISION-RELEVANT |
| Sortino Ratio | DECISION-RELEVANT |
| Calmar Ratio | VANITY/STALE |
| Omega Ratio | VANITY/STALE |
| Recovery Factor | REFERENCE |
| Ulcer Index | VANITY/STALE |
| Max Drawdown | DECISION-RELEVANT |
| SQN | VANITY/STALE |
| Kelly % | DECISION-RELEVANT |

### §4. Duration & Direction (11 KPIs)

| Metric | Classification |
|---|---|
| Avg Duration | REFERENCE |
| Avg Win Duration | REFERENCE |
| Avg Loss Duration | REFERENCE |
| Shortest Trade | VANITY |
| Longest Trade | VANITY |
| Long Trades | REFERENCE |
| Short Trades | REFERENCE |
| Long Win Rate | DECISION-RELEVANT |
| Short Win Rate | DECISION-RELEVANT |
| Long P&L | DECISION-RELEVANT |
| Short P&L | DECISION-RELEVANT |

### §5. Profit Concentration (3 KPIs)

Top-1/5/10 Win Share.
Classification: REFERENCE — useful to know if results are driven by outliers.

### Charts & Tables

| Chart | Classification |
|---|---|
| Equity Curve | DECISION-RELEVANT (duplicate of Dashboard cumulative P&L — keep Tearsheet) |
| Daily P&L | REFERENCE (duplicate of Dashboard — keep Dashboard) |
| Trade P&L Distribution | DECISION-RELEVANT — shape of edge, not shown elsewhere |
| Rolling 20-Trade Expectancy & Win Rate | DECISION-RELEVANT — regime detection, not shown on Dashboard |
| Monthly Return Heatmap | DECISION-RELEVANT — seasonal patterns |
| Timing Heatmap (DOW x Hour) | DECISION-RELEVANT — best/worst slot identification |
| Total P&L by Hour bar | REFERENCE (Timing Heatmap is strictly more informative) |
| P&L by Day of Week bar | REFERENCE (Timing Heatmap is strictly more informative) |
| Monthly Breakdown table | REFERENCE (same data as heatmap in table form) |
| By Symbol table | VANITY — always one row (NQ only) |
| By Setup table | DECISION-RELEVANT (duplicate of Dashboard SetupsTable — pick one) |

### §6. Excursion & Execution Efficiency (13 KPIs + 3 charts)

| Item | Classification |
|---|---|
| Avg MFE | DECISION-RELEVANT |
| MFE P50 | DECISION-RELEVANT |
| MFE P75 | REFERENCE |
| MFE P90 | REFERENCE |
| MFE Capture % | DECISION-RELEVANT |
| Avg MAE | DECISION-RELEVANT |
| MAE P50 | DECISION-RELEVANT |
| MAE P75 | REFERENCE |
| MAE P90 | REFERENCE |
| Avg Entry Efficiency | DECISION-RELEVANT |
| Avg Exit Efficiency | DECISION-RELEVANT |
| Avg Total Efficiency | DECISION-RELEVANT |
| Fills with Data | VANITY |
| MFE vs MAE scatter | DECISION-RELEVANT (outlier identification) |
| Entry Efficiency distribution | DECISION-RELEVANT (duplicate of OptimizationSection — pick one) |
| Exit Efficiency distribution | DECISION-RELEVANT (duplicate of OptimizationSection — pick one) |

---

## 6. RISK VIEW

| Panel | What It Shows | Classification |
|---|---|---|
| RollingStatsBar | Rolling lookback stats (30d/60d/all-time win rate, avg P&L, expectancy) | DECISION-RELEVANT — current regime vs baseline |
| RiskOfRuinWidget | Expected Value at various risk amounts, loss streak probability, drawdown recovery | DECISION-RELEVANT — sizing guardrails |
| PositionSizingPanel (Kelly) | Half Kelly, full Kelly, suggested size | DECISION-RELEVANT — actual sizing number |
| KellyExplainer | Text explanation of Kelly formula | REFERENCE |

---

## 7. OVERLAP / DUPLICATION MATRIX

| Metric / Chart | Dashboard | Tearsheet | Sidebar | Morning Prep | Notes |
|---|---|---|---|---|---|
| Win Rate | StatsGrid + PerformanceVisuals donut | §2 | — | — | 3 renderings on Dashboard alone |
| Profit Factor | StatsGrid + PerformanceVisuals card | §2 | — | — | 2 renderings on Dashboard |
| Total P&L | StatsGrid | §1 | — | — | Duplicate |
| Avg Trade P&L | StatsGrid | §1 | — | — | Duplicate |
| Avg Win / Avg Loss | StatsGrid | §1 | — | — | Duplicate |
| Max Drawdown | StatsGrid | §3 | — | — | Duplicate |
| Win/Loss Streaks | StatsGrid | §2 | — | — | Duplicate |
| Equity Curve | PnlCharts | Tearsheet | — | — | Duplicate |
| Daily P&L chart | PnlCharts | Tearsheet | — | — | Duplicate |
| By Hour chart | PnlCharts + OptimizationSection TOD table | Tearsheet bar + Timing Heatmap | — | — | 4 renderings |
| By Day of Week | PnlCharts | Tearsheet bar + Timing Heatmap | — | — | 3 renderings |
| By Setup table | SetupsTable | Tearsheet By Setup | — | — | Duplicate |
| MFE/MAE histograms | OptimizationSection | Tearsheet Excursion | — | — | Duplicate |
| ACD structural state | — | — | LiveReadPanel | BigPictureSnapshot | Duplicate |

---

## 8. USAGE SIGNALS (estimated)

- HOT (every session): /api/cooldown/status, /api/live-signal, /api/stats/overview, /api/morning-brief/dates
- DAILY: /api/stats/daily, /api/stats/tearsheet-overview, /api/stats/rolling
- ON DEMAND: /api/stats/excursion, /api/stats/pnl-distribution, /api/stats/timing-heatmap, /api/stats/monthly-heatmap
- EFFECTIVELY UNUSED: SymbolsTable (one row always), Tearsheet By Symbol

---

## 9. CLASSIFICATION SUMMARY

### DECISION-RELEVANT (keep)
- PostLossCooldown, LiveReadPanel, LiveSessionPanel
- All 5 global modals
- MorningBriefPanel (AI Read), BigPictureSnapshot, LevelConfluenceReference
- BehaviorSection (all items)
- SetupsTable
- OptimizationSection (MFE/MAE/TP-Stop cards + histograms)
- PnlCharts: Cumulative P&L + By Hour + By DOW
- Trade P&L Distribution
- Rolling 20-Trade Expectancy & Win Rate
- Timing Heatmap (DOW x Hour)
- Monthly Return Heatmap
- RollingStatsBar, RiskOfRuinWidget, PositionSizingPanel
- Tearsheet KPIs: Win Rate, Expectancy, Breakeven WR, Payoff Ratio, Long/Short Win Rate, Long/Short P&L, Max Drawdown, Sharpe, Sortino, Kelly %

### REFERENCE (keep but could be collapsed/secondary)
- SystemHealthSummary, WeeklyReportPanel, MarketRecapPanel
- ACD History / Log / Correlation tabs
- Duration Analysis
- % Profitable Weeks/Months
- Profit Concentration (Top-1/5/10)
- Monthly Breakdown table (text version of heatmap)
- Tearsheet By Hour + By DOW bar charts (heatmap is better)
- Tearsheet Daily P&L bar (keep on Dashboard instead)
- KellyExplainer

### VANITY/STALE (cut or collapse)
- SymbolsTable — always one row
- Tearsheet By Symbol table — same
- StatsGrid Best/Worst Trade — outlier trivia, not actionable
- PerformanceVisuals Profit Factor card — 3rd rendering on same screen
- PerformanceVisuals Win Rate donut — also on StatsGrid 2 cards up
- DashboardQuickNav — anchor links on a scrolling page
- Tearsheet Shortest/Longest Trade duration
- KellyExplainer (static text, not data)
- SQN, Calmar, Omega, Ulcer Index — academic, never influences position size

### CONFIRMED DUPLICATES (pick one, cut the other)
- Equity Curve: Dashboard vs Tearsheet → keep Tearsheet
- Daily P&L bar: Dashboard vs Tearsheet → keep Dashboard
- By Hour + By DOW: PnlCharts + OptimizationSection + Tearsheet bars → all replaced by Timing Heatmap
- MFE/MAE: OptimizationSection vs Tearsheet Excursion → consolidate into one place
- StatsGrid: every metric duplicated in Tearsheet §1–§3 → StatsGrid is redundant if Tearsheet is accessible
