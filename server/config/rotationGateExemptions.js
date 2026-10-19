// Setups that the 65pt POC rotation must NOT act on -- neither as an entry gate (isRotationDirectionConflict, acdRiskGates.js) nor as a forced
// close when the rotation flips (closeOnRotationFlip, rotationFlipClose.js). One list, imported by both, so they cannot drift apart.
//
// 2026-10-19, explicit user directive: "I don't think major defended levels and RTH or Globex flushes should be gated by POC rotations" and
// "it should only fire in the POC rotation toggle" (the POC Gate pill on quick-check is an observation view, not a control on real trades).
// These setups are defined by a larger structural turn, and a major defended break is meant to ride a multi-rotation move; a 65pt rotation flip
// closing it would defeat the setup. MINOR_DEFENDED_LEVEL_ is deliberately NOT listed (the directive named major levels); decide separately.
//
// BRACKET_BREAKOUT_LONG: found 2026-10-12 (RESEARCH_CLAIM rotation_gate_per_setup_breakdown_20261012) to work BACKWARDS under the entry gate.
export const ROTATION_GATE_EXEMPT_TYPES = new Set(['BRACKET_BREAKOUT_LONG']);
export const ROTATION_GATE_EXEMPT_PREFIXES = ['MAJOR_PIVOT_DEFENDED_BREAK_', 'RTH_FLUSH_', 'GLOBEX_FLUSH_'];
export function isRotationGateExempt(setupType) {
  return !!setupType && (ROTATION_GATE_EXEMPT_TYPES.has(setupType) || ROTATION_GATE_EXEMPT_PREFIXES.some(p => setupType.startsWith(p)));
}
