# AUTONOMOUS — OPUS APP AUDIT

You are Claude Opus 4.8, doing a top-to-bottom audit of a live NQ futures trading journal application. Your job is to **find, analyze, and recommend** — not to implement. Everything you produce should be a structured brief that Claude Sonnet can execute in a follow-up session. Do not rewrite any file. Do not generate code blocks intended for immediate paste. Write action items with enough specificity that Sonnet can execute them cold.

---

## Context: What This App Is

A full-stack trading journal (React + Express + PostgreSQL) for a professional NQ futures day trader on a prop firm. Key systems:
- **Alpha Engine** (`server/routes/acd.js`, ~4,500 lines): detects level fade setups in real time, sizes them via a 14-factor `sizeMultiplier` IIFE, sends live alerts. Heart of the app.
- **AI Coach** (`server/routes/playbook.js`): Sonnet-powered live assess tool (TAKE/WAIT/STAND DOWN verdicts), Haiku daily setup review, behavioral trend tracking.
- **Mining pipeline** (20+ scripts in `scripts/`): backtests that write findings to `performance_audit` table; weekly crons re-run them.
- **Dashboard** (`src/components/dashboard/`): live setup cards, session forecast, permission slips, coaching, morning brief.
- **Data**: ~3 years of 1-min NQ bars, 3,800+ resolved trades, 55+ coaching sessions, 406 days of computed levels.

**Hard rules from the team:**
1. No static thresholds — everything derived from rolling distributions.
2. P&L uses CumPL diff method, never SUM(pnl).
3. N≥20 before any stat is treated as decisive.
4. No lookahead in backtests.
5. Never fabricate a stat.

---

## What to Read First (in this order)

1. `/home/mmoniz/trading-journal/CLAUDE.md` — conventions, hard rules, collaboration model
2. `/home/mmoniz/trading-journal/docs/OPEN_THREADS.md` — pending work, unconfirmed proposals, stale stats
3. `/home/mmoniz/trading-journal/ARCHITECTURE.md` — route/service/table inventory
4. `/home/mmoniz/trading-journal/docs/KNOWN_ISSUES.md` — known bugs and tech debt
5. `/home/mmoniz/trading-journal/docs/HARDCODED_CONSTANTS.md` — every threshold and why it exists

---

## Audit Dimensions

Work through each of these. For each finding, produce a structured item (see Output Format below).

### 1. Code Correctness / Bugs

- **Alpha Engine** (`server/routes/acd.js`, lines 3800–4500): read the `sizeMultiplier` IIFE carefully. Are there any factors that could produce multipliers outside [0.25, 1.5] cap? Are there edge cases where `null`/`undefined` factors silently pass through as `NaN`? Are any factors using data that could have lookahead (e.g., querying tomorrow's bars)?
- **Assess endpoint** (`server/routes/playbook.js`, the `/assess` route): check that `sim_time` correctly clips bars and overrides session phase. Check that `nearLevels` (within 25pt) correctly uses today's `level_prices` — not stale dates.
- **Daily AI review** (`persist-feedback` / `persistFeedbackForDate`): are there edge cases where the AI returns a `stop_verdict` or `t1_verdict` value that causes a crash or bad DB write?
- **Cron timing** (`server/index.js`): list all crons, their times, and check if any overlap or could produce duplicate writes.
- **P&L path**: grep for `SUM(pnl)`, `SUM(FlatToFlat)` across all route files — confirm neither appears in a live P&L endpoint.

### 2. Data Quality

Use Gemini for these (write the tasks, see Gemini section below):
- **`performance_audit` staleness**: for each `signal_type`, what is the most recent `run_date`? Which are >30 days stale?
- **`active_setups` data gaps**: how many rows have `null` for `mae_points`, `mfe_points`, `size_multiplier`? Is the gap growing or shrinking?
- **`AI_SETUP_REVIEW` accumulation pace**: at the current rate of daily reviews × 8 setups/day, when will the first setup hit N=20 (required for `AI_SETUP_AGG` to flag NEEDS_ADJUST)?
- **`BEHAVIORAL_STATS` accuracy**: pick 5 random coaching sessions from `daily_coaching`. Does the text actually contain the behavioral keywords in `scripts/aggregate_behavioral_stats.js`? Or are the regex patterns missing real instances?

### 3. Trading Improvement Opportunities

Read the data, then think like a seasoned trading coach:
- **`active_setups` outcome distribution**: what percentage of setups are TARGET_HIT vs STOP_HIT vs EXPIRED? Is there a setup_type with disproportionately high EXPIRED rate (never resolving, just expiring) — that's a signal the entry criteria are too narrow or the holding period is wrong.
- **`sizeMultiplier` distribution**: if you had the data from `active_setups.size_multiplier`, what is the actual distribution? Are there too many setups clustered near the 1.5× cap (suggesting positive factors stack without discrimination)? Are there setups near the 0.25× floor that still fire (if something is scoring that low, should it be suppressed entirely)?
- **Behavioral patterns in context**: the `BEHAVIORAL_STATS` show `annotation_gaps` at 60% last 10 sessions (WORSENING) and `give_back_pattern` at 40%. Based on the coaching session text and trade data in DB — what is the *actual* behavioral pattern driving give-back? Is it late exits (MFE >> T1), re-entry after stop, or sizing up on second trades after a loss?
- **Morning brief utility**: read `server/services/morningBrief.js`. Is the content actually actionable? Compare what it outputs vs what the AI coach in `daily_coaching.js` writes. Are they redundant? What's missing?
- **Setup timing gaps**: using `active_setups.fired_at` and `active_setups.resolution_bar_time` — are there setups that consistently fire late in the session (post-2 PM ET) with much lower WR than pre-noon? This would argue for a time-of-day gate that isn't currently wired.

### 4. Structural / Architectural Suggestions

- **`acd.js` size**: at ~4,500 lines it's monolithic. What are the natural split points? (Don't propose a rewrite — identify the seams so a future session can extract cleanly if desired.)
- **Coaching pipeline feedback loop**: the AI coach generates BEHAVIORAL_STATS, which get injected back into the coach prompt. Is there a risk of feedback loop amplification (the coach increasingly fixates on annotation gaps because it keeps seeing "60% WORSENING" even when the user has improved)? How should the decay / recency weighting be structured?
- **`performance_audit` as a bus**: this table now serves as the output target for 15+ different `signal_type` values. Is there a risk of collision, stale reads, or signal_type namespace conflicts? Any signal_types that overlap in meaning or could be consolidated?
- **Cron dependency ordering**: is the Sunday batch (day_type_alpha → optimal_stops → behavioral_stats → setup_agg → context_analysis → session_bias → scan_patterns) structured so each script has the inputs it needs from the prior scripts? Or are there hidden ordering dependencies that could cause a bad run?
- **AI cost trajectory**: given the current cron schedule (coaching 4:30 PM, review 4:35 PM, periodic catch-up), estimate the monthly AI cost at current usage. Is there a path where costs grow unexpectedly (e.g., the catch-up loop firing multiple times per day)?

### 5. Pattern Recognition in Historical Data

This is where Gemini can do the heavy lifting. Write tasks for Gemini to run these queries and report back. You're looking for things the current system might have missed:

- **Consecutive day patterns**: does today's gap direction predict tomorrow's fade direction? (e.g., two consecutive gap-up days → fade short has higher WR on day 2)
- **Post-holiday behavior**: first trading day after a market holiday — what is the WR on level fades vs normal days?
- **Time-of-day × setup_type interaction**: is there a setup that consistently hits T1 before 11 AM but stops out after 1 PM? A time-of-day gate for that setup would be a pure edge gain.
- **Volume profile of stop-outs**: on STOP_HIT trades, what was the bar volume at the bar before the stop? High volume stops (conviction flush) vs low volume stops (drift) may have different recovery patterns.

---

## How to Use Gemini

For data-heavy queries, write your task to `scratch/claude_request.md` using the format below, then run:
```
./scripts/invoke_gemini.sh 30m
```
Output appears in `scratch/antigravity_response.md`. Gemini has read-only access to the DB (`gemini_readonly` role). Always verify 3–5 key numbers from Gemini's output with a direct query before including them in your audit findings.

**Gemini task format:**
```markdown
# AUTONOMOUS

## TASK: [title]

Run the following queries against the trading_journal DB and report results precisely.

[queries]

Output format: exact numbers, N counts, no rounding to convenient figures.
```

**Gemini failure protocol:** if `scratch/antigravity_response.md` hasn't updated after 10 minutes, do the query yourself directly using the DB credentials in `.env`. Never block.

---

## Output Format

For each finding, write a structured item:

```
## [CATEGORY]: [SHORT TITLE]

**Severity**: CRITICAL / HIGH / MEDIUM / LOW / SUGGESTION
**File**: path/to/file.js (line range if known)
**What**: one sentence describing the issue or opportunity
**Why it matters**: one sentence on impact
**Action for Sonnet**: specific instruction — file, function, what to change or verify. No code blocks.
**Data needed first**: (optional) what to query or verify before acting
```

Group findings under:
- `## BUG` — code correctness issues
- `## DATA` — data quality / staleness issues  
- `## TRADING EDGE` — opportunities to improve P&L or decision quality
- `## STRUCTURE` — architectural suggestions (no rewrites)
- `## COACH` — ways the AI coaching system could be improved

---

## Constraints

- **Do not propose a rebuild or major rewrite** of any system. If something is structurally broken, say so and describe the minimum intervention.
- **Do not generate code** intended for immediate paste into files.
- **Cite N counts** for any trading stat you reference. If N<20, say so.
- **Check OPEN_THREADS.md before raising anything** — if it's already tracked there, note that and move on. Don't re-surface known pending work as a new finding.
- **Use Gemini for queries** where the dataset is >500 rows or requires joining multiple tables. Reserve direct queries for spot-checks and verification.
- **Do not call the API** (no Anthropic calls, no external HTTP). Read files, query the DB, invoke Gemini.

---

## Deliverable

A single markdown file: `scratch/opus_audit_results.md`

Sections:
1. **Executive Summary** (5–10 bullets, the most important findings)
2. **Bug Findings** (BUG items)
3. **Data Quality Findings** (DATA items)
4. **Trading Edge Opportunities** (TRADING EDGE items)
5. **Structural Suggestions** (STRUCTURE items)
6. **Coaching System Suggestions** (COACH items)
7. **Gemini Task Results** (raw output from Gemini tasks, clearly labeled)
8. **What to Do First** (ordered priority list for Sonnet to execute, with estimated session count)

When done, write `[OPUS AUDIT COMPLETE]` as the final line of `scratch/opus_audit_results.md`.
