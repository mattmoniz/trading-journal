# AUTONOMOUS — OPUS STRATEGIC AUDIT (AUDIT #2)

You are Claude Opus 4.8. **Audit 1 covered code bugs, data integrity, behavioral forensics, and setup-level WR/MAE/MFE analysis.** All 9 findings from Audit 1 are implemented — see `docs/OPEN_THREADS.md` "Recently completed (2026-07-07)". Do not re-audit what is already fixed.

**This audit answers one question: are we building the right thing, and are we using our edge correctly?**

Deliverable: `scratch/opus_audit_2_results.md` — strategic findings. Same format as Audit 1. No code for immediate paste. Action items specific enough that Sonnet can execute cold.

---

## Context: What This App Is Trying to Do

A professional NQ futures day trader on a prop firm ($50K account, DLL = daily drawdown limit, profit-lock at certain thresholds). The app's job is to:

1. **Detect** when price approaches a historically significant level
2. **Size** the position based on 14 contextual factors (`sizeMultiplier` IIFE, `acd.js` lines ~4464–4521)
3. **Coach** the trader toward better execution and behavioral patterns
4. **Audit** its own edge continuously through backtests and mining scripts

**Current north star metric**: WR (win rate) and EV (expected value) per setup. Everything is optimized against these two numbers.

**The question this audit answers**: is that the right thing to optimize for, and is the 14-factor system actually achieving it?

---

## Read First (in this order)

1. `CLAUDE.md` — hard rules, architecture overview
2. `docs/OPEN_THREADS.md` — pending work (don't re-surface tracked items)
3. `docs/HARDCODED_CONSTANTS.md` — every threshold and its justification
4. `ARCHITECTURE.md` — route/service/table inventory
5. `server/routes/acd.js` lines 4464–4521 — the full `sizeMultiplier` IIFE
6. `scripts/aggregate_behavioral_stats.js` — behavioral theme detection

**Hard rules:**
1. N≥20 before citing any stat as actionable. Below that: state N and do not recommend action.
2. No lookahead in any pattern you find.
3. Never fabricate. Query the DB, cite the count.
4. Check `docs/OPEN_THREADS.md` first.

---

## Part 1 — The sizeMultiplier Architecture

The system applies 14 factors sequentially to a base multiplier (0.75 or 1.0). The factors: win streak depth (+0.25–0.50), first-of-day (+0.10), overnight NEUTRAL (−0.10), approach delta (+0.15), confluence pair (+0.15), elite zone (+0.15), level recency (+0.15 / −0.10), day-type alpha (±variable), inside value (−0.15), stacking ≥7 (set 0.10), NL30 regime (±0.10–0.20), revisit latency (+0.15 / −0.25), VWAP extension (+0.15), OR expansion (+0.10), regime persistence (+0.10), loss streak cap (hard ceiling 0.10–0.25 applied last).

### 1A. Does the multiplier actually discriminate?

From `active_setups WHERE size_multiplier IS NOT NULL` (populated since ~2026-07-06):

```sql
SELECT
  width_bucket(size_multiplier, 0.0, 1.6, 8) AS bucket,
  ROUND(MIN(size_multiplier)::numeric, 2) AS bucket_min,
  COUNT(*)                                 AS n,
  ROUND(100.0 * SUM(CASE WHEN resolution='TARGET_HIT' THEN 1 ELSE 0 END) / COUNT(*)::numeric, 1) AS wr_pct,
  ROUND(AVG(actual_pnl)::numeric, 1)      AS avg_pnl
FROM active_setups
WHERE size_multiplier IS NOT NULL
  AND status = 'RESOLVED'
  AND resolution IN ('TARGET_HIT','STOP_HIT')
GROUP BY 1
ORDER BY 1;
```

**What to look for**: if the 0.1× bucket and 1.5× bucket have the same WR, the 14-factor system is decorative — it costs cognitive load but provides no real sizing signal. If the WR gradient is flat or inverted, that's the most important finding in this audit.

If N is too small for the size_multiplier column (only started persisting 2026-07-06), run the same analysis against a RECONSTRUCTED multiplier. You have all the factor inputs available in `active_setups`, `acd_daily_log`, `auction_reads`, `level_prices`. Pick the 4 highest-weight factors (win streak, loss streak, NL30 regime, revisit latency) and reconstruct an approximate bucket score from historical data. N≥100 required before concluding anything about discrimination.

### 1B. Factor correlation analysis

Several factors likely capture the same underlying signal. Examples:
- **Win streak** (3×win = 87.8% WR) and **NL30 STRONG_BULL** (77.6% WR, LONG) — do these co-occur on the same trades? If win streaks cluster on STRONG_BULL days, stacking both is double-counting "tape is going."
- **VWAP extension** and **elite zone** (TURBULENT + IB direction) — on TURBULENT days, price is by definition extended. Do these co-fire frequently?
- **Approach delta** (buyers/sellers at level) and **level recency** (tested ≤2d ago) — a recently-tested level is more likely to have fresh buyers/sellers. Co-occurrence rate?

For each pair, run:
```sql
-- Example: win_streak vs NL30 bull co-occurrence
-- (reconstruct from active_setups joined to acd_daily_log)
SELECT
  CASE WHEN al.nl30_score > 9 THEN 'STRONG_BULL'
       WHEN al.nl30_score > 4 THEN 'MILD_BULL'
       ELSE 'OTHER' END AS nl30_bucket,
  -- proxy for win streak: count TARGET_HITs in prior 3 rows per session
  SUM(CASE WHEN s.resolution='TARGET_HIT' THEN 1 ELSE 0 END) AS hits,
  COUNT(*) AS n
FROM active_setups s
JOIN acd_daily_log al ON al.trade_date = s.trade_date
WHERE s.status='RESOLVED' AND s.resolution IN ('TARGET_HIT','STOP_HIT')
GROUP BY 1;
```

If 2–3 factors are highly correlated (fire together >60% of the time), adding them both to the multiplier is inflating the signal. The fix is not to remove factors — it's to note which combinations are independent vs. which are essentially one signal with two labels.

### 1C. The ceiling problem

At 1.5× cap, any combination of 4+ positive factors hits the ceiling identically. A setup with 6 positive factors gets the same size as one with 4 — the system has no discrimination above that level. Query:

```sql
SELECT
  ROUND(size_multiplier::numeric, 2) AS mult,
  COUNT(*) AS n
FROM active_setups
WHERE size_multiplier IS NOT NULL
GROUP BY 1
ORDER BY 1;
```

What fraction of live setups hit the 1.5× ceiling? If it's >20%, the ceiling is too low and we're treating very different setups as equivalent.

### 1D. Factor contribution audit

Which of the 14 factors actually moves the final multiplier in practice? A factor that fires on 5% of setups and adds +0.10 to a number that's already capped at 1.5 has zero real-world contribution. For each factor, estimate:
- Fire rate (what % of detected setups have this condition true)
- Average multiplier change it actually produces (accounting for caps and floors)
- Whether it fires more on winning or losing trades

If a factor fires rarely AND doesn't shift the final mult (because caps absorb it), it's dead weight in the architecture — it exists in code but doesn't affect sizing. Name them.

---

## Part 2 — Objective Function Alignment

### 2A. Are we optimizing for the right thing?

The system maximizes EV per setup. But the trader operates under these constraints:
- **DLL**: a daily drawdown limit (typical prop firm: ~4-5% of account). After hitting DLL, trading stops for the day.
- **Profit lock**: once daily profit reaches a threshold, some prop firms lock a portion — you can't give it all back.
- **Monthly consistency**: a losing month threatens the prop account itself.

Under DLL constraints, a setup with EV=+$30 but high variance (40% chance of -$100 loss) is less desirable than a setup with EV=+$20 and low variance, especially late in a losing session.

Query the actual distribution of session P&L from `daily_coaching` or `trades`:

```sql
WITH session_pnl AS (
  SELECT trade_date, SUM(actual_pnl) AS day_pnl
  FROM active_setups
  WHERE status='RESOLVED' AND actual_pnl IS NOT NULL
  GROUP BY trade_date
)
SELECT
  ROUND(AVG(day_pnl)::numeric, 0) AS avg_day,
  ROUND(STDDEV(day_pnl)::numeric, 0) AS std_day,
  ROUND(MIN(day_pnl)::numeric, 0) AS worst_day,
  ROUND(MAX(day_pnl)::numeric, 0) AS best_day,
  ROUND(PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY day_pnl)::numeric, 0) AS p5_day,
  ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY day_pnl)::numeric, 0) AS p25_day
FROM session_pnl;
```

What does the daily P&L distribution look like? Is the tail risk (worst 5% of days) proportionate to the edge, or is there a mismatch — good average days with catastrophic outliers that EV-per-setup doesn't capture?

### 2B. Should sizing be DLL-aware?

Currently the sizeMultiplier doesn't know the state of the session. A 1.5× setup triggered at 9:35 AM on a flat P&L day is treated identically to the same 1.5× setup triggered at 2:30 PM when you're already down 60% of DLL.

Query: do setups triggered later in the session on losing days have different actual outcomes than the same setups on winning days? Use `fired_at` hour and session-cumulative P&L as conditioning variables.

If the data shows that PM setups on down days underperform (which the behavioral forensics in Audit 1 suggested), the fix is a session-state modifier: when cumulative P&L for the day is below a threshold, reduce the sizeMultiplier by a factor. This is different from the DLL guardrail (which is binary ON/OFF) — it's a graduated signal from the session's own P&L trajectory.

### 2C. What is the Sharpe ratio of the current system?

EV per setup doesn't tell you whether the edge is earned with acceptable risk. Compute:

```sql
-- Daily P&L Sharpe (annualized)
WITH daily AS (
  SELECT trade_date, SUM(actual_pnl) AS pnl
  FROM active_setups
  WHERE status='RESOLVED' AND actual_pnl IS NOT NULL
  GROUP BY trade_date
  HAVING COUNT(*) > 0
)
SELECT
  COUNT(*) AS trading_days,
  ROUND(AVG(pnl)::numeric, 2) AS avg_daily_pnl,
  ROUND(STDDEV(pnl)::numeric, 2) AS std_daily_pnl,
  ROUND((AVG(pnl) / NULLIF(STDDEV(pnl), 0) * SQRT(252))::numeric, 2) AS annualized_sharpe,
  ROUND(SUM(pnl)::numeric, 0) AS total_pnl
FROM daily;
```

A Sharpe below 1.0 means the system has edge but is taking too much risk to earn it — variance reduction (tighter stops, fewer setups, DLL-aware sizing) would improve risk-adjusted returns even if raw EV decreases. A Sharpe above 2.0 is excellent and suggests the priority is capturing more of it (more setups, bigger size at high-confidence) rather than reducing variance.

---

## Part 3 — Edge Decomposition

The system tracks individual setup WR but has no "where does our edge actually come from" decomposition. Fix that here.

### 3A. Attribution by level category

Group `active_setups` into level families: CAM levels (R1-R4, S1-S4), OR levels (OR_HIGH/LOW, OR_MID), IB levels (IB_HIGH/LOW, IB_MID), PD levels (PD_POC, PD_VAH, PD_VAL, PD_SESSION_MID), Floor pivots (FLOOR_R1/S1/PIVOT), Other (VWAP_MAGNET, WEEKLY_VWAP, etc.).

For each family:
- Total N (resolved setups)
- WR, EV, total P&L contribution
- % of total system P&L
- What % of trading time does this family fire in (relative frequency)?

If one family (e.g., PD levels) generates 60% of total P&L but we spend most system complexity on CAM levels, that's a resource allocation problem. We should be deepening the best edge, not spreading attention evenly.

### 3B. Attribution by time window

```sql
SELECT
  CASE
    WHEN EXTRACT(HOUR FROM fired_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York') < 10 THEN '9:30-10am'
    WHEN EXTRACT(HOUR FROM fired_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York') < 11 THEN '10-11am'
    WHEN EXTRACT(HOUR FROM fired_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York') < 12 THEN '11am-12pm'
    WHEN EXTRACT(HOUR FROM fired_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York') < 14 THEN '12-2pm'
    ELSE '2-4pm'
  END AS window,
  COUNT(*) AS n,
  ROUND(100.0 * SUM(CASE WHEN resolution='TARGET_HIT' THEN 1 ELSE 0 END)/COUNT(*)::numeric,1) AS wr,
  ROUND(AVG(actual_pnl)::numeric,1) AS avg_pnl,
  ROUND(SUM(actual_pnl)::numeric,0) AS total_pnl
FROM active_setups
WHERE status='RESOLVED' AND resolution IN ('TARGET_HIT','STOP_HIT')
  AND fired_at IS NOT NULL AND actual_pnl IS NOT NULL
GROUP BY 1
ORDER BY 1;
```

If 80% of edge comes from the 9:30–11 AM window and PM setups are noise or worse, the highest-leverage single change might be a hard PM cutoff rather than another sizeMultiplier factor.

### 3C. Attribution by day-type

Break total historical P&L by BALANCE / TREND / TURBULENT. This is already partially tracked in `DAY_TYPE_ALPHA` but has never been stated as "X% of annual edge comes from TURBULENT days." State it. If the system is dependent on a day-type that occurs only 15% of days, that's a fragility. If one day-type destroys edge, that's where suppression work should focus next.

### 3D. What are we leaving on the table?

Given the attribution above — the setups that fire with high EV, in the best time windows, on the best day-types — are we sizing those up maximally? Or are we burning the size ceiling on marginal setups that happen to have 3 positive factors simultaneously?

Specifically: find setups where `size_multiplier >= 1.3` AND `resolution = 'STOP_HIT'` AND `actual_pnl < -50`. These are setups where the system expressed high confidence and was wrong. What factors fired? Was there a common theme — did VWAP extension and win streak co-fire on a day that turned out to be a loss cluster?

---

## Part 4 — Coaching Efficacy

The behavioral coaching system tracks these themes across 55+ sessions: annotation gaps, overtrading, late entries, fading valid signals, missed setups, give-back, annotation quality. Currently it measures frequency (what % of sessions hit each theme) but not velocity (is the rate improving or declining over time?).

### 4A. Has anything actually improved?

Read all `daily_coaching` rows chronologically. For each BEHAVIOR_THEME:

```sql
SELECT
  session_date,
  signal_name,
  win_rate AS frequency,
  notes::json->>'rolling_10d' AS rolling_10d,
  notes::json->>'rolling_30d' AS rolling_30d,
  notes::json->>'trend' AS trend,
  recommendation
FROM performance_audit
WHERE signal_type = 'BEHAVIORAL_STATS'
ORDER BY run_date DESC, signal_name
LIMIT 1 -- most recent run
```

But also reconstruct the time series: pull 4 consecutive `run_date` values for each theme and compute whether the rolling_10d is trending down (improving) or up (worsening). Which themes have actually improved over the coaching period? Which have stayed flat regardless of how many times the coach raised them?

A theme that has been WORSENING for 3+ consecutive weekly runs despite being flagged in coaching every session is a coaching system failure, not a trader failure. The feedback loop isn't working for that theme — either the detection is wrong (keyword mismatch) or the intervention (flagging in coaching) is insufficient.

### 4B. Coaching text vs. actual trade outcomes on flagged days

On days where the coach flagged `give_back_pattern` or `overtrading_after_11am`, query `active_setups` for that session. Do trade outcomes differ from sessions where those themes were NOT flagged? If the coach flags overtrading but the actual outcomes are similar to non-flagged days, the theme detection may be false-positive-heavy (flagging days that aren't actually problematic).

### 4C. What does the premarket commitment predict?

`premarket_walkthroughs` now has 56 rows with `committed_plan` extracted from each coaching session's TOMORROW'S WATCH. Query: on days where `committed_plan` is non-null and detailed (>200 chars), does trade quality differ from days where it's null or minimal? Use number of setups taken, average time between trades (overtrading proxy), or STOP_HIT rate as outcome proxies.

This tests whether pre-market preparation — not coaching frequency — is the actual causal variable.

---

## Part 5 — What We're Not Using

### 5A. Bid/ask volume in `price_bars_primary`

The DB has `ask_volume` and `bid_volume` per 1-min bar. Currently used only for: VWAP calculation, approach delta (buyers/sellers at level, last 5 bars). Not used for: cumulative delta across the session, volume climax detection, divergence between price move and volume, or absorption signals (price moves up on bid volume = selling into rally).

Query what's available:
```sql
SELECT
  COUNT(*) AS total_bars,
  COUNT(ask_volume) AS bars_with_ask_vol,
  COUNT(bid_volume) AS bars_with_bid_vol,
  MIN(ts::date) AS first_date,
  MAX(ts::date) AS last_date
FROM price_bars_primary
WHERE ask_volume IS NOT NULL;
```

If bid/ask volume coverage is >80% for 2024+, what patterns in this data haven't been mined? Specifically:
- Cumulative session delta (sum of (ask_vol − bid_vol) from open). A setup taken when cumulative delta disagrees with direction (e.g., LONG fade but session delta is heavily net-ask / selling dominant) — does that configuration underperform?
- Volume climax: bar with ask_vol or bid_vol > 3× 20-bar rolling mean. Do setups that fire within 2 bars of a volume climax have different outcomes than normal-volume setups?
- Delta divergence at level: price touched the level on rising price but falling bid volume (buyers exhausting). Measurable from bar data. Is this a filter that improves entry quality?

### 5B. Bar structure at detection time

At `fired_at`, what was the 1-min bar doing? From `price_bars_primary` where `ts` = the bar overlapping `fired_at`:
- Bar body quality: `|close - open| / (high - low)`. High = conviction, low = indecision.
- Wick ratio: upper wick / total range (LONG fades with large upper wicks = rejection is real).
- Whether close was in the top or bottom half of the bar's range.

Has Audit 1's Part 2 section 4 (bar body quality at entry) been implemented? If not, it's still an open question worth quantifying here.

### 5C. What do the worst weeks look like in the price data?

Find the 5 worst weeks by P&L. For each week, query `price_bars_primary` to characterize market conditions:
- Average daily range (high − low of RTH session)
- Average volume vs prior 20-session baseline
- Number of A Up / A Down signals from `acd_daily_log`
- Day-type distribution that week

Is there a market fingerprint for bad weeks — e.g., low-volume consolidation weeks where BALANCE days dominate and the system kept firing fade setups into dead range? If yes, a weekly regime warning is a high-value addition.

### 5D. Macro timing

The `acd_daily_log` table has `trade_date`. FOMC meetings, CPI releases, NFP Fridays all create unusual price behavior that breaks normal fade edge. Is there a `macro_event` flag anywhere? If not — query whether days following earnings/economic events (Wednesdays with large overnight gaps >20pt, Fridays with gap >30pt) show degraded setup WR. If the data shows event-day degradation (N≥20), a calendar-based suppression could recover edge.

---

## Part 6 — Fresh Eyes: What Would You Build Differently?

Read the full codebase architecture (`ARCHITECTURE.md`, `server/routes/acd.js` outline, `src/` structure) and answer honestly:

**If you were starting this system from scratch today, knowing what the data shows, what would you do differently?**

This is not a rebuild recommendation — it's a strategic question. Consider:

1. **What is the minimum viable system?** If you had to cut 50% of the complexity (remove factors, backtests, UI panels), what would you keep and what would you drop based on actual P&L attribution? What is essential vs. accumulated?

2. **Is level-fade the right primary strategy for NQ?** The entire system is built around fading to pre-computed levels. What does the data say about when this strategy structurally fails — and is there a complementary strategy the data suggests that the system ignores entirely?

3. **Is the coaching system in the right place in the workflow?** Currently: coaching is post-session (daily review at 4:30 PM), pre-session (morning brief), and real-time (live assess on demand). Is the biggest behavioral gap at 4:30 PM or is it the 5 seconds before clicking a button at 10:47 AM when the system says WAIT and the trader is considering trading anyway?

4. **Is the sizeMultiplier the right paradigm?** It assumes the edge is about sizing the SAME decision differently. An alternative paradigm: filter (decide whether to take the trade at all) rather than size (take all trades but scale). Given that after-loss WR is 47% and after-win is 80% — maybe the after-loss trade shouldn't be taken at all rather than taken at 0.25×.

5. **What single feature would most improve real-time decision making?** Not the thing that looks best on a dashboard — the thing that, in the 30 seconds when a setup fires and the trader is deciding whether to act, would most reliably improve the quality of that specific decision.

---

## Gemini Usage

Write tasks to `scratch/claude_request.md`, then:
```
./scripts/invoke_gemini.sh 30m
```
Output: `scratch/antigravity_response.md`. Gemini = read-only (`gemini_readonly` / `gemini_ro_2026`).

**Always verify 3–5 numbers from Gemini against a direct spot-check before citing.**

Timeout: if `scratch/antigravity_response.md` hasn't updated in 10 min, query the DB yourself (host=localhost, user=trader, password=trader123, db=trading_journal). Never block.

---

## Output Format

Same as Audit 1 — for each finding:
```
## [CATEGORY]: [TITLE]

**Severity**: CRITICAL / HIGH / MEDIUM / LOW / SUGGESTION
**Source**: file, table, or query
**What**: one sentence
**Why it matters**: number if possible
**Action for Sonnet**: specific instruction, no code blocks
**Data needed first**: (if applicable)
```

Categories: `SIZING`, `OBJECTIVE`, `EDGE`, `COACH`, `DATA`, `STRUCTURE`, `STRATEGY`

---

## Part 7 — Open Observations

Same format as Audit 1 Part 5. After the structured sections: write anything else you noticed — hunches, anomalies, things that felt off while reading the data. No format required. No N≥20 rule. Examples:

- A pattern in the data that the system has no name for
- A factor in the sizeMultiplier that seems backwards when you look at the raw numbers
- Something about the coaching text longitudinally that the behavioral stats don't capture
- A market condition where the whole approach seems fragile
- A question you'd want answered if you were trading this system tomorrow
- What the system is clearly good at vs. what it's pretending to be good at

Be direct. The open observations section is the most valuable part.

---

## Deliverable: `scratch/opus_audit_2_results.md`

1. **Executive Summary** — 10 bullets, highest-impact only. Lead with the sizeMultiplier discrimination finding.
2. **Objective Alignment** — Is EV-per-setup the right north star? What should it be instead?
3. **sizeMultiplier Architecture** — Does it discriminate? What's double-counted? What's dead weight?
4. **Edge Attribution** — Where does the annual edge actually come from? What to double down on.
5. **Coaching Efficacy** — What's improving, what's not, and why.
6. **Untapped Data** — What's in the DB that we're not using.
7. **What Would You Do Differently** — Fresh-eyes strategic answer, grounded in the data.
8. **Open Observations** — Free-form. No template.
9. **Gemini Raw Output** — Labeled by task.
10. **Priority Action List for Sonnet** — Ordered by estimated impact. Include estimated session count.

Final line: `[OPUS AUDIT 2 COMPLETE]`
