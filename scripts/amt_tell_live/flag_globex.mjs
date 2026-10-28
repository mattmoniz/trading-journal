import { flagDecision } from '../flag_decision.mjs';
await flagDecision({
  slug: 'amt_tell_globex_arm_untested_20261028',
  decisionText: 'The live tell detector enters only 10:00-14:30 ET (research window, vbars.DEC_FIRST/DEC_LAST). Its day profile includes Globex bars, but the ENTRY rule was never tested in the Globex window (6PM-9:30AM ET), and CLAUDE.md requires any new setup to be evaluated for both RTH and Globex before it is called complete (a tested-and-recorded no is fine, an untested gap is not). Also expect the repo pattern that RTH-validated momentum/flow signals can REVERSE in Globex (Conventions entry), so test from scratch rather than loosening numbers. Needs: a pre-registered Globex-window replication of the tell trade test on the explore sessions (bars already extracted full-session), BOTH bar readings, with its own frozen window and controls. Until then Globex is inactive for the tell, in Stage 1 and Stage 2.',
  sourceFile: 'docs/AMT_TELL_LIVE_PROJECT_SPEC_20261028.md', sourceDate: '2026-10-28',
});
process.exit(0);
