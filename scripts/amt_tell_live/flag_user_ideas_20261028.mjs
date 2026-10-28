import { flagDecision } from '../flag_decision.mjs';
await flagDecision({
  slug: 'poc_join_blown_through_at_range_edge_breakout_idea_20261028',
  decisionText: 'User idea 2026-10-28: when a POC Join (POC_ROTATION_JOIN) is blown through at the top or bottom of a range (the edges), that may be a sign of a breakout. Test on raw bar history FIRST (market behaviour question, CLAUDE.md hard rule), pre-registered before any result: edge = join fired near the session high/low, overnight high/low or initial-balance extremes; blown through = price keeps going through the join stop instead of rotating back; outcome = continuation beyond the edge vs all other joins and a random-time control, day-blocked CI, using the real detector inputs (scripts/lib/pocJoinLoader.mjs, withVolume true, match a sample to real active_setups rows first). Also check overlap with the live node-ladder tell (a failed join at an extreme may be the same event). Only then ask whether a trade rule can capture it.',
  sourceFile: 'docs/AMT_TELL_LIVE_PROJECT_SPEC_20261028.md', sourceDate: '2026-10-28',
});
await flagDecision({
  slug: 'amt_tell_globex_arm_untested_20261028',
  decisionText: 'UPDATED 2026-10-28 with the user direction: "globex should be turned on and studied in our ML". Plan: (1) log Globex-window tells WATCH-ONLY in the live sidecar as their own tagged window (no orders), and replay the Globex entry window on the explore sessions (full-session bars already extracted) under a pre-registered frozen window with both bar readings and the same controls; (2) once real active_setups rows exist the existing ML scores them and its Globex-specific tracker (scripts/recalibrate_ml_globex_split.mjs, is_rth feature) separates the sessions; (3) NO Globex orders until the offline replay clears: RTH-validated momentum/flow signals have repeatedly REVERSED in Globex in this repo. Original gap stands: the tell entry rule was only ever tested 10:00-14:30 ET and CLAUDE.md requires an RTH-and-Globex evaluation (a recorded no is fine, an untested gap is not).',
  sourceFile: 'docs/AMT_TELL_LIVE_PROJECT_SPEC_20261028.md', sourceDate: '2026-10-28',
});
process.exit(0);
