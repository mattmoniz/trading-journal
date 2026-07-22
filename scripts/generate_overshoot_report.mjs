import fs from 'fs';

const data = JSON.parse(fs.readFileSync('/home/mmoniz/trading-journal/scratch/overshoot_results.json', 'utf8'));

let md = `# Overshoot-Then-Reversal-Pattern Re-entry Test Results

## Hypothesis
The prior test showed that reversal candlestick patterns on the *first touch* of a level do not offer a statistically significant edge. The new hypothesis tests a distinctly different entry mechanic: waiting for price to *overshoot* the level by a meaningful margin, then looking for a reversal pattern at that deeper extreme before entering.

## Methodology
1. **Overshoot Threshold**: Computed as the P50 (median) of the MAE-at-resolution across each \`setup_type\`'s entire resolved history.
2. **Identification**: Re-walked every trade's 1-minute bars from \`fired_at\`. Found the first bar where adverse excursion crossed the setup's overshoot threshold.
   - Excluded trades that hit their target before crossing the threshold (clean winners without overshoot).
   - Excluded trades where the setup's overshoot threshold was $\\ge$ the original stop distance (overshoot would trigger the stop).
3. **Pattern Matching**: At the overshoot bar, looked forward for a reaction window (P25 of bars-to-resolution) to find a reversal pattern using the standard \`classifyReversalPattern\` (90-day baseline).
4. **Resimulation**: For trades with a pattern, simulated a new entry at the close of the pattern-completion bar. Walked the remaining bars against the original absolute \`stop_level\` and \`t1_level\`.
5. **Comparison**: Compared the original blind-entry P&L (\`OVERSHOT_BASELINE\`) vs the new resimulated P&L (\`OVERSHOOT_PATTERN_REENTRY\`) strictly for the paired subset of trades that had an overshoot and a valid pattern.

## Pooled Summary (Across All Setups)
- **Total Trades that Overshot**: ${data.pooled.counts.overshotTotal}
- **Clean Winners (Never Overshot)**: ${data.pooled.counts.neverOvershot}
- **Excluded (Stop Too Tight)**: ${data.pooled.counts.stopTooTight}
- **Overshot but No Pattern**: ${data.pooled.counts.noPattern} (WR: ${data.pooled.noPattern.wr.toFixed(1)}%, EV: $${data.pooled.noPattern.ev.toFixed(2)})
- **Overshot with Pattern (Paired Subset N=${data.pooled.counts.pairedPattern})**:
  - Original Blind Entry EV: **$${data.pooled.pairedOrig.ev.toFixed(2)}** (WR: ${data.pooled.pairedOrig.wr.toFixed(1)}%)
  - New Post-Pattern Entry EV: **$${data.pooled.pairedNew.ev.toFixed(2)}** (WR: ${data.pooled.pairedNew.wr.toFixed(1)}%)

## Per-Setup Results
| Setup Type | Never Overshot | Stop Too Tight | No Pattern N | Paired N | Orig WR% | Orig EV$ | New WR% | New EV$ | Orig Rigor | New Rigor |
|---|---|---|---|---|---|---|---|---|---|---|
`;

for (const r of data.results) {
  const c = r.counts;
  const o = r.pairedOrig;
  const n = r.pairedNew;
  
  const origRigorStr = o.n >= 20 ? `clustered:${o.rigor.clustered} stable:${o.rigor.stable}` : 'N<20';
  const newRigorStr = n.n >= 20 ? `clustered:${n.rigor.clustered} stable:${n.rigor.stable}` : 'N<20';
  const origWr = o.wr ? o.wr.toFixed(1) : '0.0';
  const origEv = o.ev ? o.ev.toFixed(2) : '0.00';
  const newWr = n.wr ? n.wr.toFixed(1) : '0.0';
  const newEv = n.ev ? n.ev.toFixed(2) : '0.00';

  md += `| ${r.setupType} | ${c.neverOvershot} | ${c.stopTooTight} | ${c.noPattern} | **${c.pairedPattern}** | ${origWr}% | $${origEv} | ${newWr}% | $${newEv} | ${origRigorStr} | ${newRigorStr} |\n`;
}

md += `
## Interpretation & Recommendation
While waiting for an overshoot and a reversal pattern *does* show a marked improvement in EV for the paired subset compared to the original blind entries (e.g. going from a heavily negative EV to a near-breakeven or positive EV on the same trades), the new EV profile is generally still negative or flat on an absolute basis across the vast majority of setups, and stability is frequently broken.

Crucially, this mechanism naturally filters out the "clean winners" (the ${data.pooled.counts.neverOvershot} trades that hit targets without overshooting). By forcing an overshoot, we are self-selecting into trades that are inherently struggling. A reversal pattern at the overshoot point mitigates some of that damage (hence the EV improvement vs the blind baseline *for that specific struggling subset*), but it does not magically turn them into high-conviction winners that outperform the overall un-filtered baseline.

**Action**: Do not implement this as a universal entry mechanism. The edge gained from fading an overshoot is heavily offset by the opportunity cost of missing the clean winners.
`;

fs.writeFileSync('/home/mmoniz/trading-journal/scratch/antigravity_response.md', md);
