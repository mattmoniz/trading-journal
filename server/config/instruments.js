/**
 * instruments.js — single source of truth for contract $/pt and commission.
 *
 * WHY THIS EXISTS: this exact mistake (a wrong $/pt constant) has now been found
 * independently THREE times in this codebase: scripts/archive/backfill_level_fades.js
 * hardcoded PT=5/COMM=5 and got silently copied into 6 more repair scripts before being
 * caught (see CLAUDE.md's "P&L Formula" hard rule); a frontend modal hardcoded * 5 for
 * risk/reward labels while the same setup card's real resolved P&L sat right next to it
 * using the correct $2/pt (found 2026-07-16); and TRT_LONG's hardcoded trade-brief text
 * in acd.js separately claimed "$5/pt" in its target description (found same session).
 * User request 2026-07-16, verbatim: "Can we have a product table that these views
 * reference so that they are not stale."
 *
 * This journal trades MNQ live — MNQ is the default/only instrument any live resolution
 * path should use. NQ is included only for reference (e.g. RiskView.jsx's sizing
 * calculator lets a user model NQ hypothetically) — never use NQ's numbers in a live
 * setup's actual_pnl calculation.
 */
export const INSTRUMENTS = {
  MNQ: { symbol: 'MNQ', label: 'MNQ ($2/pt)', dollarsPerPoint: 2, commissionPerRoundTrip: 1 },
  // NQ's commissionPerRoundTrip is user-recalled ("I think the commission might be $2
  // for nq", 2026-07-16), not independently verified against a broker statement/receipt
  // the way MNQ's $1 is -- treat as provisional, correct if a real statement contradicts
  // it. Real NQ contracts (NQH5/M5/U5/Z4/Z5) DO appear in trades history (verified
  // 2026-07-16: their per-contract P&L runs ~9.2x MNQ's for the same contract period,
  // matching the real $20-vs-$2 ratio almost exactly -- genuine NQ trading, not
  // mislabeled MNQ data). The live ACD setup-detection engine's own simulated P&L
  // (resolveSetupsByPrice, etc.) always models MNQ regardless of what's in real trades
  // history -- a deliberate, separate modeling choice, not a claim about what the user
  // has or hasn't traded.
  NQ:  { symbol: 'NQ',  label: 'NQ ($20/pt)',  dollarsPerPoint: 20, commissionPerRoundTrip: 2 },
};

// The instrument actually traded live — every live resolution path (resolveSetupsByPrice
// in server/routes/acd.js, and any future one) should use this, not a redeclared literal.
export const LIVE_INSTRUMENT = INSTRUMENTS.MNQ;
