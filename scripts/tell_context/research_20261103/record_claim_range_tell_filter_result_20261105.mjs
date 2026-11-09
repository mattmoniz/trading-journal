// Records the RESULT claim for docs/RANGE_MODEL_TELL_FILTER_PREREG_20261105.md (look 178, NOT SHOWN). hr-024 via recordClaim(), awaited (hr-060).
import { recordClaim } from '../../record_claim.mjs';
await recordClaim({
  slug: 'range_model_tell_filter_not_shown_20261105',
  claimText: 'Pre-registered (ledger look 178, 3 counted tests, 680 matched tell explore trades on 273 dates, entries inside the forecast hour, day-block CI 98.33 percent): the walk-forward next-hour range forecast does NOT sort the tell dollars: WIDE minus NARROW tercile -4.24 per trade [-37.75, +27.96] (detectable 38.5; placebo 97.5th +23.79 not beaten; halves +1.85 / -6.44); model minus hard-baseline contrast +7.31 [-12.13, +26.25]; approved minus all -3.40 per day [-15.09, +8.00]. The oracle (realized range) contrast is only +35.5, below the detectable effect, so this is a low-power null. Narrow hours win more often but smaller, wide hours less often but bigger. Not tested: entries before 10:30, live or Stage 2 tell trades, width-scaled targets or stops. No dollar chart built.',
  sourceFile: 'scripts/tell_context/research_20261103/range_tell_filter.py',
  sourceDate: '2026-11-04', sampleSize: 680, rigorStatus: 'day_blocked_bootstrap_explore_prereg', status: 'PROVISIONAL',
  unblockCondition: 'The forward join of structure_model_rows to live tell trades at 60 forward days; re-running the explore window will not change it.',
  extra: { looks: [178], prereg: 'docs/RANGE_MODEL_TELL_FILTER_PREREG_20261105.md', counted_tests: 3 },
});
console.log('claim recorded'); process.exit(0);
