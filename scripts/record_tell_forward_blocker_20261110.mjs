// Flags the blocker found 2026-11-10 night for the forward read of candidate Q4-6 (docs/TELL_GEOMETRY_NULL_PREREG_20261110.md). Count-only inspection: no outcome column was read.
import { flagDecision } from './flag_decision.mjs';
async function main() {
  const d = await flagDecision({
    slug: 'tell_geometry_null_forward_edge_not_stored_20261110', priority: 'MEDIUM',
    decisionText: 'The promised forward read of Q4-6 (same T1 on live tell fires at 150 and 300 fires) cannot be computed yet: live fires are in amt_tell_trades (306 rows since 2026-10-28; the explore rule is bar_rule=split, book=V1: 69 fires on 10 days, so the first read at 150 is a few weeks away) but a row stores neither the range edge B (trade.boundary: overnight high/low widened by the first-hour range once complete) nor the session bars (only a bars_sha256), and the placebo needs both. The pre-registration says use the edge recorded at the fire and do not reconstruct it another way. Options: (a) persist details[\'boundary\'] at fire time in scripts/amt_tell_live/persist.py (sidecar code; takes effect only after a sidecar restart, and fires before it stay without an edge), plus keep the session bars; (b) allow a recompute of B and the bars from the tick files with the SAME functions (trade.boundary, tell_replay_lib) for every fire, flagged as a reconstruction. Until one is chosen the forward read cannot be run; the 150-fire count is the earliest date. Task 4 of docs/SONNET_SPEC_FABLE_FOLLOWUPS_20261110.md was stopped on this.',
    sourceFile: 'docs/TELL_GEOMETRY_NULL_PREREG_20261110.md', sourceDate: '2026-11-10',
  });
  console.log('flagged', d.slug);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
