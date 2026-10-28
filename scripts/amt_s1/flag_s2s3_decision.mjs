import { flagDecision } from '../flag_decision.mjs';
await flagDecision({
  slug: 'amt_s2_s3_forward_look_due',
  decisionText: 'Passive AMT IB-migration tracker (S2/S3, table amt_daily_state, nightly scripts/amt_s1/amt_daily_state.py, frozen rules in scripts/amt_s1/PASSIVE_TRACKER_PREREG.md). NOTHING to do until a cell reaches its pre-registered threshold; the nightly log prints the forward state-day counts and NO DATA YET. Interim descriptive read at 60 forward state days per cell, DECISION look once at 150 (CONFIRMED needs the one-sided 98.75% lower bound > 0 and a positive matched-control point estimate; otherwise NOT CONFIRMED, underpowered below 0.16 ATR20, never "no effect"). History through 2026-10-26 (849 sessions: S2 up 247 / dn 171, S3 up 170 / dn 124) is deliberately NOT analysed. Expected timing at 21 sessions a month from census frequencies (GUESSES from history shares: S2-UP 29%, S2-DN 20%, S3-UP 20%, S3-DN 15%): 60 days at about 10 / 14 / 14 / 20 months, 150 days at about 25 / 36 / 36 / 49 months (S2-UP interim about Aug 2027, decision about Nov 2028). Resolve when each cell has had its decision look, or earlier if the user retires the line. Needs nothing from the user now.',
  sourceFile: 'scripts/amt_s1/PASSIVE_TRACKER_PREREG.md', sourceDate: '2026-10-28',
});
process.exit(0);
