// Records the claim for docs/SESSION_SPLIT_ROSTER_PREREG_20261108.md (look 185, retrospective LEAD). hr-024 via recordClaim(), awaited (hr-060).
import { recordClaim } from '../../record_claim.mjs';
await recordClaim({
  slug: 'session_split_roster_20261108',
  claimText: 'Pre-registered (ledger look 185, 2 counted tests, walk-forward over 79 scored days 2026-08-07..2026-11-06, rosters rebuilt as of each day, declustered fires, day-block CI 97.5 percent): applying the (pre-2026-11-08) live roster rule per (setup type, session RTH/Globex) instead of per setup type beats the pooled rule: +27.97 per active day [+3.59, +62.32] (detectable 37.2; halves +16.06 / +39.26) and +9.28 per trade [+1.25, +20.44]: LEAD (retrospective). The whole difference comes from about 20 extra fires in three cells (IB_HIGH_FADE_SHORT|RTH 13, CAM_S1_FADE_LONG|RTH 5, FLOOR_PIVOT_FADE_SHORT_OVERNIGHT|GLOBEX 2); SESSION_OLD is +1.15 per trade against take-all -2.51 and pooled -8.14; 5 of 7 types with both sessions do worse in Globex. A lead resting on 20 fires; forward re-run at 60 and 120 days is the test; the live gate was not changed.',
  sourceFile: 'scripts/backtest_session_roster.mjs',
  sourceDate: '2026-11-08', sampleSize: 129, rigorStatus: 'day_blocked_bootstrap_walkforward_prereg', status: 'PROVISIONAL',
  unblockCondition: 'node scripts/backtest_session_roster.mjs --first-forward 2026-11-09 at 60 and 120 forward days; re-running the retrospective window will not change it.',
  extra: { looks: [185], prereg: 'docs/SESSION_SPLIT_ROSTER_PREREG_20261108.md', counted_tests: 2 },
});
console.log('claim recorded'); process.exit(0);
