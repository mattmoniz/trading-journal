// Extracted 2026-08-11 (roadmap Phase 6, Setup D "Opening Drive" Stage 1) — pure port of
// the `opening_call_type` formula that exists as 3 near-identical inline copies in
// server/routes/acd.js (~line 1895 per its own neighboring comment, ~3361, ~4086 — the
// third's own comment admits "Mirrors /acd/live's classifier without persisting"). Adding a
// 4th inline copy in the new Setup D backtest would make the duplication worse, not better
// (same "share modules" pattern this codebase has caught and fixed for computeRigor(),
// computeVolatilityDefaultRatios(), etc.) — so this is extracted for the NEW consumer only.
// The 3 existing live inline copies are deliberately left untouched (a separate future
// cleanup, not bundled into this Setup D build — "one change at a time").
//
// NOT the same thing as server/services/caseEngine.js's classifyOpeningType() (a genuinely
// different classifier: first-5-bar window, different category names OPEN_DRIVE_UP/DOWN/
// OPEN_AUCTION/OPEN_REVERSAL, used by daily_coaching.js/day-type reassessment) — named
// distinctly here (classifyACDOpeningCall, not classifyOpeningType) specifically to avoid
// that confusion, per DeepSeek's design-critique flag (scratch/deepseek_setup_d_design.md).
//
// Pure function: no DB access, no window-length assumptions baked in — caller supplies
// BOTH the OR reference (orH/orL) and the bars to check for extension beyond it, so the
// same function serves the live 5-min-anchor/15-min-confirm definition AND any other
// window-length variant a backtest wants to test (e.g. Setup D Stage 1's 5-min vs 15-min
// comparison) without a second copy of the threshold logic.
export function classifyACDOpeningCall(confirmBars, orH, orL) {
  if (!confirmBars || confirmBars.length < 5 || orH == null || orL == null) return null;
  const h = Math.max(...confirmBars.map(b => b.high));
  const l = Math.min(...confirmBars.map(b => b.low));
  const lastPx = confirmBars[confirmBars.length - 1].close;
  const orRng = orH - orL;
  if (orRng <= 0) return null;
  const ext = orRng * 0.3;
  const ext50 = orRng * 0.5;
  const aboveOR = h - orH;
  const belowOR = orL - l;

  let type;
  if (aboveOR > ext && belowOR > ext) {
    type = 'OPEN_TEST_DRIVE';
  } else if (aboveOR > ext50 && belowOR < ext * 0.3) {
    type = 'OPEN_DRIVE';
  } else if (belowOR > ext50 && aboveOR < ext * 0.3) {
    type = 'OPEN_DRIVE';
  } else if ((aboveOR > ext || belowOR > ext) && Math.abs(lastPx - (orH + orL) / 2) < orRng * 0.4) {
    type = 'OPEN_REJECTION_REVERSE';
  } else {
    type = 'OPEN_AUCTION';
  }
  const driveDirection = type === 'OPEN_DRIVE' ? (aboveOR > belowOR ? 'UP' : 'DOWN') : null;
  return { type, driveDirection, aboveOR, belowOR, orRng };
}
