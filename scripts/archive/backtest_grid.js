import { execSync } from 'child_process';

const MIN_CONTRACTS_LIST = [1, 2, 3, 4, 5];
const RISK_PCT_LIST      = [0.005, 0.01, 0.015, 0.02];
const results = [];

for (const minC of MIN_CONTRACTS_LIST) {
  for (const riskPct of RISK_PCT_LIST) {
    process.stdout.write(`Running MIN_CONTRACTS=${minC} RISK_PCT=${riskPct}...`);
    let stdout = '';
    try {
      stdout = execSync(
        `MIN_CONTRACTS=${minC} RISK_PCT=${riskPct} node scripts/backtest_full_system.js`,
        { cwd: '/home/mmoniz/trading-journal', timeout: 120000, encoding: 'utf8' }
      );
      process.stdout.write(' done\n');
    } catch (e) {
      process.stdout.write(' ERROR\n');
      results.push({ minC, riskPct: (riskPct*100).toFixed(1)+'%', error: (e.stdout||'') + e.message });
      continue;
    }

    const get = (re) => { const m = stdout.match(re); return m ? m[1].trim() : 'N/A'; };
    results.push({
      minC,
      riskPct:  (riskPct * 100).toFixed(1) + '%',
      totalPnL: get(/Ending equity:\s+\$?([\d,.-]+)/),
      winRate:  get(/Win rate:\s+([\d.]+%)/),
      pf:       get(/Profit factor:\s+([\d.]+)/),
      maxDD:    get(/Max drawdown:\s+\$?([\d,.-]+)/),
      worstDay: get(/Worst day:\s+\$?([\d,.-]+)/),
      dllHits:  get(/Days hitting \$400 DLL:\s+(\d+)/),
      survived: stdout.includes('Survived every day?       YES') ? 'YES' : '⚠️ NO',
    });
  }
}

const parseDollar = s => parseFloat(String(s).replace(/[$,]/g, '')) || 0;
results.sort((a, b) => parseDollar(b.totalPnL) - parseDollar(a.totalPnL));

// Build markdown output
const lines = [];
lines.push('# Prop Firm Risk Grid Results');
lines.push(`**Generated:** ${new Date().toISOString()}`);
lines.push('');
lines.push('## Full Grid (sorted by Total P&L)');
lines.push('');
lines.push('| MIN_C | RISK% | Total P&L | WR | PF | Max DD | Worst Day | DLL Hits | Survived |');
lines.push('|---|---|---|---|---|---|---|---|---|');

for (const r of results) {
  if (r.error) {
    lines.push(`| ${r.minC} | ${r.riskPct} | ERROR | | | | | | ⚠️ |`);
    continue;
  }
  lines.push(`| ${r.minC} | ${r.riskPct} | $${r.totalPnL} | ${r.winRate} | ${r.pf} | $${r.maxDD} | ${r.worstDay} | ${r.dllHits} | ${r.survived} |`);
}

const survived = results.filter(r => !r.error && r.survived === 'YES' && r.dllHits === '0');
const failed   = results.filter(r => r.survived !== 'YES' || (r.dllHits !== '0' && r.dllHits !== 'N/A'));

lines.push('');
lines.push('## Summary');
if (survived.length) {
  lines.push(`- **Best P&L (survived, 0 DLL hits):** MIN_C=${survived[0].minC} RISK=${survived[0].riskPct} → $${survived[0].totalPnL}`);
  const safest = [...survived].sort((a,b) => parseDollar(a.maxDD)-parseDollar(b.maxDD))[0];
  lines.push(`- **Safest (lowest drawdown):** MIN_C=${safest.minC} RISK=${safest.riskPct} → MaxDD=$${safest.maxDD}`);
}
if (failed.length) {
  lines.push(`- **⚠️ Failed combos:** ${failed.map(r=>`MIN_C=${r.minC} RISK=${r.riskPct}`).join(', ')}`);
}

import { writeFileSync } from 'fs';
writeFileSync('/home/mmoniz/trading-journal/scratch/antigravity_response.md', lines.join('\n'));
console.log('\nDone. Results written to scratch/antigravity_response.md');
