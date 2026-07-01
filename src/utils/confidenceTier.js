// Returns display metadata based on sample size
export function confidenceTier(n) {
  if (n == null || n < 20) return { tier: 'THIN',      color: '#666',    label: `N=${n??0} ⚠`,  title: 'Too few samples to be reliable (N<20)' };
  if (n < 50)              return { tier: 'MARGINAL',  color: '#b8860b', label: `N=${n} ~`,     title: 'Marginal sample size (N<50) — treat as directional signal only' };
  return                          { tier: 'CONFIDENT', color: 'inherit', label: `N=${n}`,        title: 'Sufficient sample size (N≥50)' };
}
