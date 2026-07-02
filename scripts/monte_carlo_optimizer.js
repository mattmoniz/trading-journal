import fs from 'fs';
import path from 'path';

// Load trade dataset
const TRADES_FILE = '/home/mmoniz/trading-journal/scratch/mc_trades.json';
if (!fs.existsSync(TRADES_FILE)) {
  console.error(`Error: trades dataset file not found at ${TRADES_FILE}`);
  process.exit(1);
}

const trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));

// Group trades by date to preserve intraday correlations and chronological order
const tradesByDay = new Map();
for (const t of trades) {
  if (!tradesByDay.has(t.date)) {
    tradesByDay.set(t.date, []);
  }
  tradesByDay.get(t.date).push(t);
}
const uniqueDates = Array.from(tradesByDay.keys());

// Simulation Constants
const STOPS = [20, 30, 39, 50];        // stop distance in points
const TARGETS = [20, 30, 40, 50, 60];   // target distance in points
const MIN_CONTRACTS = [1, 3, 5];          // contract floor
const RISK_PCTS = [0.005, 0.01, 0.02];   // % of account to risk per trade
const N_PATHS = parseInt(process.env.N_PATHS || '5000', 10);
const STARTING_ACCOUNT = 2000;
const DLL = 400;
const PNL_PER_PT_PER_CONTRACT = 2;       // MNQ = $2/pt
const COMMISSION_PER_CONTRACT = 1;        // $1 round-trip per contract

function getPercentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function simulateTrade(trade, stopPts, targetPts, contracts) {
  const pnlPerPt = contracts * PNL_PER_PT_PER_CONTRACT;
  const commission = contracts * COMMISSION_PER_CONTRACT;
  const baseContracts = trade.quantity || 1;
  const isWinner = trade.pnl > 0;

  // MAE and MFE are worst/best excursions for the whole fill — we don't know
  // which happened first within the bar. Preserve actual win/loss direction,
  // but rescale the exit price based on stop/target.
  if (isWinner) {
    // Trade actually won — target was hit (or expired profitable)
    if (trade.mfe_pts >= targetPts) {
      return targetPts * pnlPerPt - commission;       // full target hit
    } else {
      return trade.pnl * (contracts / baseContracts); // partial win, scale by size
    }
  } else {
    // Trade actually lost — stop was hit (or expired at a loss)
    if (trade.mae_pts >= stopPts) {
      return -(stopPts * pnlPerPt + commission);       // full stop hit
    } else {
      return trade.pnl * (contracts / baseContracts);  // partial loss, scale by size
    }
  }
}

async function run() {
  console.log(`=== STARTING MONTE CARLO OPTIMIZER ===`);
  console.log(`Loaded ${trades.length} trades over ${uniqueDates.length} trading days.`);
  console.log(`Running with N_PATHS = ${N_PATHS}`);

  // Build grid combinations
  const combos = [];
  for (const stop of STOPS) {
    for (const target of TARGETS) {
      for (const minC of MIN_CONTRACTS) {
        for (const risk of RISK_PCTS) {
          combos.push({ stop, target, minC, risk });
        }
      }
    }
  }

  // If validating, run only the first 3 combos
  const isValidation = (N_PATHS === 100);
  const runCombos = isValidation ? combos.slice(0, 3) : combos;
  console.log(`Total parameter grid combos: ${combos.length} (Running: ${runCombos.length})`);

  const results = [];

  for (let idx = 0; idx < runCombos.length; idx++) {
    const { stop, target, minC, risk } = runCombos[idx];
    
    // Sizing limit check for DLL
    const riskPerContract = stop * PNL_PER_PT_PER_CONTRACT + COMMISSION_PER_CONTRACT;
    const maxContractsDll = Math.floor(DLL / riskPerContract);

    const pathFinalEquities = [];
    const pathMaxDrawdowns = [];
    const pathDllHits = [];
    const pathWorstDays = [];

    for (let p = 0; p < N_PATHS; p++) {
      // Replay trades for this path
      let account = STARTING_ACCOUNT;
      let peak = account;
      let maxDrawdown = 0;
      let dllHits = 0;
      let worstDay = 0;

      for (let d = 0; d < uniqueDates.length; d++) {
        const randDate = uniqueDates[Math.floor(Math.random() * uniqueDates.length)];
        const dayTrades = tradesByDay.get(randDate);
        
        let dayPnl = 0;
        let dayDllHit = false;

        for (let i = 0; i < dayTrades.length; i++) {
          if (dayDllHit) break; // Stop trading once DLL is hit for the day

          const trade = dayTrades[i];

          // Size dynamically, bounded by contracts floor (minC) and DLL cap (maxContractsDll)
          const sizeEstimate = Math.floor(account * risk / riskPerContract);
          const contracts = Math.max(minC, Math.min(maxContractsDll, sizeEstimate));

          const tradePnl = simulateTrade(trade, stop, target, contracts);
          account += tradePnl;
          dayPnl += tradePnl;

          if (dayPnl <= -DLL) dayDllHit = true;

          peak = Math.max(peak, account);
          maxDrawdown = Math.max(maxDrawdown, peak - account);
        }

        if (dayPnl <= -DLL) dllHits++;
        worstDay = Math.min(worstDay, dayPnl);
      }

      pathFinalEquities.push(account);
      pathMaxDrawdowns.push(maxDrawdown);
      pathDllHits.push(dllHits);
      pathWorstDays.push(worstDay);
    }

    // Compute aggregated metrics across all paths
    const p5_equity = getPercentile(pathFinalEquities, 5);
    const p50_equity = getPercentile(pathFinalEquities, 50);
    const p95_equity = getPercentile(pathFinalEquities, 95);
    const p50_max_dd = getPercentile(pathMaxDrawdowns, 50);
    const p95_max_dd = getPercentile(pathMaxDrawdowns, 95);
    const pathsDllHitCount = pathDllHits.filter(hits => hits > 0).length;
    const pct_paths_dll_hit = (pathsDllHitCount / N_PATHS) * 100;
    const pathsSurvivedCount = pathFinalEquities.filter(eq => eq > 0).length;
    const pct_paths_survived = (pathsSurvivedCount / N_PATHS) * 100;

    results.push({
      stop,
      target,
      minC,
      risk,
      p5_equity,
      p50_equity,
      p95_equity,
      p50_max_dd,
      p95_max_dd,
      pct_paths_dll_hit,
      pct_paths_survived,
    });

    console.log(`[${idx+1}/${runCombos.length}] Stop=${stop} Target=${target} MinC=${minC} Risk=${(risk*100).toFixed(1)}% -> p50=$${p50_equity.toFixed(2)} MaxDD_p95=$${p95_max_dd.toFixed(2)} Survival=${pct_paths_survived.toFixed(1)}%`);
  }

  // Sort by p50_equity descending
  results.sort((a, b) => b.p50_equity - a.p50_equity);

  // Identify optimal combinations
  const survivedCombos = results.filter(r => r.pct_paths_survived > 95);
  const bestMedian = survivedCombos.length > 0 ? survivedCombos[0] : null;

  const safesResult = results.filter(r => r.p50_equity > 20000).sort((a, b) => a.p95_max_dd - b.p95_max_dd);
  const safest = safesResult.length > 0 ? safesResult[0] : null;

  // Compute Efficient Frontier (Pareto-optimal combos)
  // A combo is Pareto-optimal if no other combo has strictly better p50_equity AND strictly lower p95_max_dd.
  const efficientFrontier = [];
  for (const c of results) {
    let dominated = false;
    for (const other of results) {
      if (other === c) continue;
      // dominates if other equity is higher AND drawdown is lower (or one is strictly better and other is equal)
      const higherEquity = other.p50_equity > c.p50_equity;
      const lowerDrawdown = other.p95_max_dd < c.p95_max_dd;
      const equityOk = other.p50_equity >= c.p50_equity;
      const drawdownOk = other.p95_max_dd <= c.p95_max_dd;
      
      if ((higherEquity && drawdownOk) || (equityOk && lowerDrawdown)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) {
      efficientFrontier.push(c);
    }
  }

  // Build markdown output
  const lines = [];
  lines.push(`# Monte Carlo Simulation Results`);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Paths per combo:** ${N_PATHS}`);
  lines.push(`**Historical dataset size:** ${trades.length} trades across ${uniqueDates.length} days`);
  lines.push('');

  lines.push('## Best Configurations');
  if (bestMedian) {
    lines.push(`- **Best Median Equity (Survival > 95%):** Stop=${bestMedian.stop} Target=${bestMedian.target} MinC=${bestMedian.minC} Risk=${(bestMedian.risk*100).toFixed(1)}% → p50_equity=$${bestMedian.p50_equity.toFixed(2)} (p95_max_dd=$${bestMedian.p95_max_dd.toFixed(2)})`);
  }
  if (safest) {
    lines.push(`- **Safest Configuration (Lowest Drawdown, p50 > $20K):** Stop=${safest.stop} Target=${safest.target} MinC=${safest.minC} Risk=${(safest.risk*100).toFixed(1)}% → p90_max_dd=$${safest.p95_max_dd.toFixed(2)} (p50_equity=$${safest.p50_equity.toFixed(2)})`);
  }

  lines.push('');
  lines.push('## Efficient Frontier (Pareto-Optimal Combos)');
  lines.push('No other combination dominates these on both P&L (p50) and Drawdown (p95).');
  lines.push('');
  lines.push('| Stop (pt) | Target (pt) | MinC | Risk% | p50 Equity | p95 Drawdown | DLL Hit% | Survival% |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const c of efficientFrontier) {
    lines.push(`| ${c.stop} | ${c.target} | ${c.minC} | ${(c.risk*100).toFixed(1)}% | $${c.p50_equity.toFixed(2)} | $${c.p95_max_dd.toFixed(2)} | ${c.pct_paths_dll_hit.toFixed(1)}% | ${c.pct_paths_survived.toFixed(1)}% |`);
  }

  lines.push('');
  lines.push('## Full Results (Sorted by Median p50 Equity)');
  lines.push('');
  lines.push('| Stop (pt) | Target (pt) | MinC | Risk% | p5 Equity | p50 Equity | p95 Equity | p50 MaxDD | p95 MaxDD | DLL Hit% | Survival% |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of results) {
    lines.push(`| ${c.stop} | ${c.target} | ${c.minC} | ${(c.risk*100).toFixed(1)}% | $${c.p5_equity.toFixed(2)} | $${c.p50_equity.toFixed(2)} | $${c.p95_equity.toFixed(2)} | $${c.p50_max_dd.toFixed(2)} | $${c.p95_max_dd.toFixed(2)} | ${c.pct_paths_dll_hit.toFixed(1)}% | ${c.pct_paths_survived.toFixed(1)}% |`);
  }

  const resultsPath = '/home/mmoniz/trading-journal/scratch/mc_results.md';
  fs.writeFileSync(resultsPath, lines.join('\n'), 'utf8');
  console.log(`\nMarkdown report saved to ${resultsPath}`);
}

run().catch(console.error);
