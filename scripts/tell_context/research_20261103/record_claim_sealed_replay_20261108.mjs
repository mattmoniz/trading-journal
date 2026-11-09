// Records the claim for docs/STRUCTURE_MODEL_SEALED_REPLAY_PREREG_20261108.md (sealed look ledger 184, NOT SHOWN by the frozen rule). hr-024 via recordClaim(), awaited (hr-060).
import { recordClaim } from '../../record_claim.mjs';
await recordClaim({
  slug: 'structure_model_sealed_replay_20261108',
  claimText: 'Pre-registered ONE sealed spend (ledger 184, 2 counted tests, 347 qualifying sessions 2025-05-19..2026-10-19, frozen explore-only ridge M2, day-block CI 97.5 percent): the next-hour range model improves on HAR-X + clock by +26.82 percent [+21.30, +31.83] (the explore claim +24.9 replicates) and on the hard persistence baseline by +4.33 percent [-0.13, +8.26] (detectable 4.0; halves +4.21 / +4.46): NOT SHOWN by the frozen rule (lower bound -0.13) but positive in all four half-years and at every decision time (gain +9.6 percent at 10:30 falling to +0.6 at 14:30). The honest edge over plain persistence is about +4 percent and the window cannot separate it from zero. Not tested: event-calendar feature, Globex, GBM challenger. The sealed window is spent for this family.',
  sourceFile: 'scripts/structure_model/sealed_replay.py',
  sourceDate: '2026-11-08', sampleSize: 347, rigorStatus: 'sealed_look_day_blocked_bootstrap_prereg', status: 'PROVISIONAL',
  unblockCondition: 'Forward rows (structure_model_rows) at the pre-registered 60 / 120-day looks; underpowered for a 4 percent edge, so expect no verdict before about 700 days; a new model version needs a new window.',
  extra: { looks: [184], prereg: 'docs/STRUCTURE_MODEL_SEALED_REPLAY_PREREG_20261108.md', counted_tests: 2 },
});
console.log('claim recorded'); process.exit(0);
