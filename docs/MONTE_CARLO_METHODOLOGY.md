# Monte Carlo Optimizer — Methodology Reference

**Last updated:** 2026-07-02  
**Script:** `scripts/monte_carlo_optimizer.js`  
**Dataset:** `scratch/mc_trades_enriched.json` (built by Gemini, ~14K trades)

---

## What it is (vs. a backtest)

| | Backtest | Monte Carlo |
|---|---|---|
| **Question** | Did my edge exist in the past? | Given my edge, how should I size to survive and grow? |
| **Path** | Single deterministic walk through history in order | 5,000 random re-orderings of the same historical trades |
| **Output** | One P&L curve | A *distribution* of outcomes (p5 / p50 / p95) |
| **What it catches** | Whether rules worked | Whether sizing survives bad luck / early drawdown sequences |
| **When to use** | Testing a new signal, level, or filter | Choosing stop/target/risk% before risking real money |

A backtest tells you "this setup won 63% of the time." The MC optimizer tells you "if you size at 2% risk with a 30pt stop, you survive 97% of random 1-year paths even with that 63% WR — but if you size at 2% with a 20pt stop you blow up on 40% of paths."

The key insight: **order of wins and losses matters**. A losing streak early in the year at too-large size can take you below the DLL before your edge kicks in. The MC reveals which parameter combos are fragile to that timing risk.

---

## How it works — step by step

### 1. Trade dataset
Pulled from all BP fills with MAE/MFE data across all accounts. Each row:
- `date`, `pnl`, `quantity`, `mfe_pts`, `mae_pts`
- `level_tag` — AT_LEVEL / LATE / CHASING / NONE (proximity to key level at entry)
- `confluence_count` — how many distinct key levels within 15pt of entry on that date

### 2. Parameter grid (180 combos)
```
Stops:    20, 30, 39, 50 pts
Targets:  20, 30, 40, 50, 60 pts  
MinC:     1, 3, 5 contracts (floor, never goes below)
Risk%:    0.5%, 1%, 2% of account per trade
```

### 3. Simulation loop — for each combo, 5000 paths
Each path simulates one full year:
- For each day: randomly draw a *real trading day* from history (block bootstrap — keeps intraday trade correlation intact)
- For each trade that day:
  - Size dynamically: `floor(account × risk% / riskPerContract)`, bounded by `[minC, DLL/riskPerContract]`
  - Apply confluence multiplier (see below)
  - Simulate outcome using actual MAE/MFE to determine if stop or target was hit
- Track: daily DLL hit? Running max drawdown? Final equity after 252 days

### 4. Confluence sizing multipliers
From `CONFLUENCE_AUDIT` in `performance_audit` table.

The 88.9% DOUBLE stat was computed with a 15-level set (2026-07-02). After expanding to 64 levels,
DOUBLE WR drops to ~51% because nearly every bar qualifies as DOUBLE at 15pt proximity — the tier
signal is meaningless. **DOUBLE multiplier dropped (2026-07-04).** Future path: pair-specific
multipliers once the top pairs are wired into the optimizer.

| Confluence count | WR (64-level audit) | EV | Size multiplier |
|---|---|---|---|
| 0 (no nearby level) | baseline | baseline | **0.75x** |
| 1 (single level) | 50.6% | -$2.75 | **1.0x** |
| 2 (double) | 50.9% | +$0.82 | **1.0x** (was 1.5x — dropped) |
| 3 (triple) | 51.5% | +$6.35 | **1.0x** |
| 4+ (quad plus) | 42.9% | +$2.15 | **SKIP** |

### 5. Output per combo
- `p5_equity` — worst 5% of paths ended here (catastrophic tail)
- `p50_equity` — median outcome
- `p95_equity` — best 5% of paths
- `p50_max_dd` / `p95_max_dd` — drawdown distribution
- `DLL_hit%` — fraction of paths that ever hit the $400 daily loss limit
- `Survival%` — fraction of paths that ended positive

### 6. Report structure
- **Best Median Equity** (survival > 95%): highest p50 among safe combos
- **Safest** (p50 > $20K): lowest drawdown among profitable combos
- **Efficient Frontier**: Pareto-optimal set — no other combo beats these on *both* p50 equity and p95 drawdown

---

## Three filter modes

Run via `FILTER=<mode> node scripts/monte_carlo_optimizer.js`:

| Mode | Trades used | Output file | What it answers |
|---|---|---|---|
| `all` (default) | All 14,076 | `mc_results_all.md` | Baseline over everything traded |
| `at_level` | AT_LEVEL + LATE only (~8K) | `mc_results_at_level.md` | What if you only trade within 15pt of a level |
| `double_only` | Confluence 2-3 only (~3.5K) | `mc_results_double_only.md` | What if you only take double-confluence setups |

Comparing `all` vs `at_level` vs `double_only` quantifies how much of the edge comes from level discipline vs the underlying setup edge.

---

## How to run

```bash
# All three passes in parallel (background)
node scripts/monte_carlo_optimizer.js > scratch/mc_run_all.log 2>&1 &
FILTER=at_level node scripts/monte_carlo_optimizer.js > scratch/mc_run_at_level.log 2>&1 &
FILTER=double_only node scripts/monte_carlo_optimizer.js > scratch/mc_run_double_only.log 2>&1 &

# Quick validation (100 paths instead of 5000, first 3 combos only)
N_PATHS=100 node scripts/monte_carlo_optimizer.js
```

Results land in `scratch/mc_results_<filter>.md`.

---

## When to re-run

**After any of these events:**

| Trigger | Why |
|---|---|
| New levels added or proximity window changed | Dataset `level_tag` + `confluence_count` will be stale — Gemini must re-pull `mc_trades_enriched.json` first |
| CONFLUENCE_AUDIT refreshed | Sizing multipliers are derived from the audit; stale multipliers = stale sim |
| ~20+ new trading days accumulated | Adds new tail scenarios to the bootstrap pool |
| Start of a new quarter | Routine calibration check |
| Major parameter change (stop floor, DLL change, new account tier) | Sim constants need to match live conditions |

**Do NOT re-run just because the market moved.** The bootstrap samples from your real trade history — the distribution is already empirical. Only re-run when the input data or simulation rules change.

**Typical cadence: monthly**, or immediately after a level/confluence rule change.

---

## Gemini's role

Gemini (read-only DB) is responsible for building `mc_trades_enriched.json`. Claude runs the optimizer locally.

To rebuild the dataset (e.g., after a proximity window change):
1. Write task to `scratch/claude_request.md` with the enrichment query (see prior Gemini task)
2. Run `./scripts/invoke_gemini.sh 30m`
3. Verify N > 13,000 in `scratch/antigravity_response.md`
4. Then re-run all three MC passes

The enriched dataset is what makes the confluence sizing meaningful — the baseline file (`mc_trades_all_accounts.json`) has no `level_tag` or `confluence_count`.
