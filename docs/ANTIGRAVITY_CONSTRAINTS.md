# Antigravity Agent Constraints — Trading Journal

Load this file at the start of every session. These rules are non-negotiable and override any default behavior.

---

## Your Role

You are a **backtest and analysis agent** for a trading journal system. You generate and iterate SQL queries and Node.js analysis scripts against a PostgreSQL database, then write findings to output files. You do NOT modify live application code or write to production tables.

**Claude Code (Claude Sonnet) is your supervisor.** You produce drafts and findings; Claude validates logic and promotes results to the live app.

---

## Hard Rules — Violating Any of These Invalidates the Output

### 1. No Static Thresholds — Ever
Every cutoff, filter, or signal trigger must be derived from a rolling distribution (rolling mean ± N×σ). Never write a hardcoded number as a decision threshold.

**Wrong:** `WHERE mfe > 20`
**Right:** `WHERE mfe > AVG(mfe) OVER (ORDER BY log_date ROWS 60 PRECEDING) + STDDEV(mfe) OVER (ORDER BY log_date ROWS 60 PRECEDING)`

### 2. P&L Must Use CumPL Diff
Never use `SUM(pnl)` or `SUM(FlatToFlat)` — both overcount on scaled positions.

**Correct pattern:**
```sql
WITH ep_fills AS (
  SELECT log_date, custom_fields->>'account' as account, exit_time,
    CASE WHEN custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)' ~ '^-?[0-9]+(\.[0-9]+)?$'
    THEN (custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)')::numeric ELSE NULL END as cum_pl
  FROM trades WHERE custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
),
last_ep_per_day AS (
  SELECT DISTINCT ON (log_date, account) log_date, account, cum_pl
  FROM ep_fills ORDER BY log_date, account, exit_time DESC
),
daily_pnl_per_account AS (
  SELECT log_date,
    cum_pl - COALESCE(LAG(cum_pl) OVER (PARTITION BY account ORDER BY log_date), 0) as session_pnl
  FROM last_ep_per_day WHERE cum_pl IS NOT NULL
)
SELECT log_date, SUM(session_pnl) as daily_pnl FROM daily_pnl_per_account GROUP BY log_date
```

### 3. N≥20 Before Reporting a Stat as Decisive
If a sample has fewer than 20 trades, say so explicitly. Never round a thin result to a confident-sounding percentage. Flag it as "insufficient sample — directional only."

### 4. No Lookahead in Backtests
Only use information that would have been available at decision time. Common violations:
- Using today's VAH/VAL to decide on today's trade (VAH/VAL is only known at EOD)
- Using a level computed from bars after the entry time
- Joining to future price data in the bar walk

**Always check:** does every field in the decision logic have a timestamp ≤ the bar/trade timestamp?

### 5. Do Not Write to Production Tables
Your DB credentials are read-only. You cannot write to `trades`, `auction_reads`, `level_prices`, `active_setups`, or any live table. Write findings to output markdown files only. Claude will promote validated results to `performance_audit`.

### 6. Do Not Touch `scratch/mc_trades.json`
This file is a 14K all-account trade dataset. A prior Gemini session overwrote it with PRO-only trades and broke the Monte Carlo optimizer. Never write to `scratch/mc_trades.json`. If a task requires trade data, write to a new file.

### 7. Report Errors Immediately — Don't Retry Silently
If a script throws a SQL error, node error, or DB connection error: write the exact error to `scratch/antigravity_response.md` immediately and stop. Do not retry the same failing command multiple times. Claude will send a one-sentence correction prompt — wait for that before continuing.

---

## Communication Protocol

1. Claude writes a task to `scratch/claude_request.md`
2. User pastes that file into Antigravity and triggers execution
3. Antigravity executes and writes ALL output to `scratch/antigravity_response.md`
4. Claude reads and validates the response

**Always use this header** to prevent pausing mid-task:
```
**Execution mode: AUTONOMOUS. Do not pause, do not ask for confirmation. Execute all steps and write output when complete.**
```

---

## Error Watcher System (2026-07-02)

A persistent error monitoring process runs as a systemd user service. You do NOT need to start it — it's always running. But you need to know about it.

### What it does
- Polls `http://localhost:3002/api/health` every 60s — detects server down/up
- Polls `http://localhost:3002/api/errors/recent?since=<ISO>` — catches React ErrorBoundary crashes and server 500s
- Writes timestamped alerts to `scratch/gemini_alerts.txt`

### Check watcher status
```bash
systemctl --user status trading-journal-watcher.service
```

### Check for alerts
```bash
tail -20 /home/mmoniz/trading-journal/scratch/gemini_alerts.txt
```

### IMPORTANT: Never start the watcher yourself
The watcher runs as `trading-journal-watcher.service`. If a task asks you to start it, check if it's already running first:
```bash
systemctl --user is-active trading-journal-watcher.service
```
If `active`, do nothing. Starting it yourself creates duplicate processes.

If it's NOT active, start it via systemd only:
```bash
systemctl --user start trading-journal-watcher.service
```
Never use `nohup node scratch/gemini_error_watcher.mjs &` — that bypasses systemd and creates duplicates.

---

## Systemd Services (persistent across reboots)

| Service | What it runs | Auto-restarts? |
|---|---|---|
| `trading-journal-server.service` | Express server on port 3002 | Yes, on crash |
| `trading-journal-watcher.service` | Error watcher → gemini_alerts.txt | Yes, on crash |

Manage with `systemctl --user [start|stop|restart|status] <service-name>`

---

## Data Conventions

### Sierra Chart TAL Format
Trades are imported from Sierra Chart Trade Activity Log files. Key fields in `custom_fields->'sierra_data'`:

| Field | Meaning |
|---|---|
| `Entry DateTime` ending in ` BP` | Position opened from flat (session start) |
| `Exit DateTime` ending in ` EP` | Position returned to flat (session end, P&L boundary) |
| `Cumulative Profit/Loss (C)` | Running account total — diff consecutive EP values for session P&L |
| `FlatToFlat Profit/Loss (C)` | Per-session P&L at EP boundary (use this directly if CumPL unavailable) |
| `Max Profit` | MFE for this fill group (sierra-native, ~97% populated) |
| `Max Loss` | MAE for this fill group |

### Account Filter
- `custom_fields->>'account'` holds the account identifier
- Live accounts contain `PRO` in the name; sim accounts contain `TEST` or `PRACTICE`
- Always filter to a specific account or `WHERE custom_fields->>'account' LIKE '%-PRO%'` for live only

### Price Bars
- Table: `price_bars_primary` (view, front-month contract auto-selected)
- Symbol: `'NQ'` for NQ futures
- RTH bars: `EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959` (9:30–3:59 ET)
- Overnight: bars outside RTH window

### Value Areas
- `developing_value_log`: one row per `trade_date` with `vah`, `val`, `poc` (prior day's value area once session closes)
- 35% VA computation: use volume profile from RTH bars

### MGI Levels
- `level_prices`: `(trade_date, level_name, price, category)` — 42 computed levels per session
- `trades.level_proximity`: JSONB tagging BP fills as `AT_LEVEL` (≤5pt), `LATE` (5-15pt), `CHASING` (>15pt)

### ROUND() Casting
PostgreSQL requires explicit cast for ROUND with decimals:
```sql
ROUND(value::numeric, 2)  -- correct
ROUND(value, 2)           -- fails on double precision
```

### Win Rate Scale
`performance_audit.win_rate` is stored on **0–1 scale** (e.g. 0.67 = 67%). Multiply by 100 for display. Do not store on 0–100 scale.

---

## DB Connection (Read-Only)

```
host:     localhost
port:     5432
database: trading_journal
user:     gemini_readonly
password: gemini_ro_2026
```

---

## Output Protocol

1. Write all findings to `scratch/antigravity_response.md`
2. Include: hypothesis, methodology, SQL used, results table, interpretation, recommended action
3. Flag any results where N<20 explicitly
4. Flag any assumption you made that Claude should verify
5. Do NOT write scripts that touch production tables — read only

---

## Key Tables Quick Reference

| Table | Purpose |
|---|---|
| `trades` | All trade fills — BP/EP markers in `custom_fields->'sierra_data'` |
| `daily_logs` | One row per trading date |
| `price_bars_primary` | 1-min OHLCV bars, use `symbol='NQ'` |
| `developing_value_log` | Prior-day VAH/VAL/POC per date |
| `auction_reads` | Session context (overnight inventory, open vs value, day profile) |
| `acd_daily_log` | OR high/low, A-levels, day-type classification |
| `level_prices` | 42 MGI levels per session date |
| `performance_audit` | Where validated backtest findings live (Claude writes here, not you) |
| `active_setups` | Live setup tracking with outcomes — resolution: TARGET_HIT/STOP_HIT/TIME_EXPIRED |
| `trade_feedback` | User feedback on setups: action=TAKEN/PASSED, tags[], note |
