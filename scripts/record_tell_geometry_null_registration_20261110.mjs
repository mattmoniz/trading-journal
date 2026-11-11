// Registration of Q4-6 / improvement register row 51 at its START (co-023): ledger look + claim, before any outcome is read.
import { logLook } from './lib/look_ledger.mjs';
import { recordClaim } from './record_claim.mjs';
async function main() {
  const look = await logLook({ family: 'tell_geometry_null_20261110', dataWindow: 'explore_2023-04-04..2025-05-16 (sealed untouched)', kind: 'EXPLORE', tests: 1,
    label: 'Q4-6 geometry-matched null on the 1,760 explore V1 tells: edge-touched-before-stop rate vs a direction-blind placebo with the same distances, session and time of day (T1, one counted test)',
    script: 'scripts/vacuum_sim/tell_geometry_null.py', prereg: 'docs/TELL_GEOMETRY_NULL_PREREG_20261110.md', claimSlug: 'tell_geometry_null_20261110', outcome: 'RUN_PENDING', notes: { candidate_queue: 'Q4-6', origin: 'outside review candidate A' } });
  console.log('LOOK_ID', JSON.stringify(look));
  const c = await recordClaim({ slug: 'tell_geometry_null_20261110', claimText: 'REGISTERED 2026-11-10 night, NOT YET RUN: does the tell know the direction? Edge-touched-before-stop rate of the 1,760 explore V1 tells against a direction-blind placebo (same stop and edge distances, same session, bars within 15 minutes, both directions). One counted test (T1), day-blocked bootstrap; explore result is a lead, the forward read at 150 and 300 live fires decides (Q4-6).',
    sourceFile: 'docs/TELL_GEOMETRY_NULL_PREREG_20261110.md', sourceDate: '2026-11-10', rigorStatus: 'not_checked', status: 'PROVISIONAL', unblockCondition: null, extra: { counted_tests: 1, candidate_queue: 'Q4-6' } });
  console.log('claim', c.slug);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
