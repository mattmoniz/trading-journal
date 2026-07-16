// Single source of truth for the frontend's own $/pt display math — mirrors
// server/config/instruments.js (frontend/backend are separate module graphs in this
// project, so this is a deliberate, kept-in-sync duplicate, not a second definition of
// truth — if you change one, change both).
//
// Found 2026-07-16: this exact mistake (a wrong $/pt constant) had independently drifted
// into THREE places — a backend script (PT=5, historical, already fixed), a frontend
// modal (App.jsx's CaseSetupDetailModal hardcoded * 5 for risk/reward labels while the
// same setup card's real resolved P&L sat right next to it using the correct $2/pt), and
// this file's sibling backend fix in acd.js's TRT_LONG trade-brief text (also said
// "$5/pt"). User request, verbatim: "Can we have a product table that these views
// reference so that they are not stale."
//
// This journal trades MNQ live. NQ is reference-only (e.g. RiskView.jsx's sizing
// calculator lets a user model NQ hypothetically) — never use NQ's numbers for a live
// setup's actual P&L.
export const INSTRUMENTS = {
  MNQ: { symbol: 'MNQ', label: 'MNQ ($2/pt)', dollarsPerPoint: 2, commissionPerRoundTrip: 1 },
  // NQ's commissionPerRoundTrip is user-recalled, not verified against a statement --
  // see server/config/instruments.js for the full note. Real NQ contracts DO appear in
  // trades history (verified 2026-07-16, ~9.2x MNQ's per-contract P&L for the same
  // contract period -- genuine NQ trading, not mislabeled data).
  NQ:  { symbol: 'NQ',  label: 'NQ ($20/pt)',  dollarsPerPoint: 20, commissionPerRoundTrip: 2 },
};

export const LIVE_INSTRUMENT = INSTRUMENTS.MNQ;

// Convenience export for the common case (most call sites just need the live $/pt).
export const MNQ_DOLLARS_PER_POINT = INSTRUMENTS.MNQ.dollarsPerPoint;
