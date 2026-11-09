// Records the registration claim for docs/RANGE_MODEL_TELL_FILTER_PREREG_20261105.md (look 178, PRE-REGISTERED, NOT RUN). hr-024 via recordClaim(), awaited (hr-060). Update the claim with the result after the run.
import { recordClaim } from '../../record_claim.mjs';
await recordClaim({
  slug: 'range_model_tell_filter_preregistered_20261105',
  claimText: 'Pre-registered, NOT RUN (ledger look 178, 3 counted tests): whether the walk-forward next-hour range forecast (WIDE vs NARROW tercile, ranked causally within the decision minute) sorts the book-A dollars of the 729 tell explore trades it covers (305 dates, entries inside the forecast hour at 10:30 / 11:30 / 13:00), with a control on the hard baseline forecast, an approve-minus-all per-day contrast, a circular-shift placebo and a halves rule. No outcome has been joined to a forecast yet. A LEAD would only justify a simulated All / Approved / Vetoed dollar chart; no sealed era has forecasts, so confirmation needs the forward join at 60 days.',
  sourceFile: 'docs/RANGE_MODEL_TELL_FILTER_PREREG_20261105.md',
  sourceDate: '2026-11-04', sampleSize: 729, rigorStatus: 'preregistered_not_run', status: 'PROVISIONAL',
  unblockCondition: 'The user says go; write and run range_tell_filter.py from the spec, then append section 9 and update this claim.',
  extra: { looks: [178], prereg: 'docs/RANGE_MODEL_TELL_FILTER_PREREG_20261105.md', counted_tests: 3 },
});
console.log('claim recorded'); process.exit(0);
