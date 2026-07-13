// Small shared inline-style objects reused across dashboard view components.
// Kept separate from setupDisplay.js (setup-type-specific data) — this file is for
// generic, setup-agnostic style objects.

// De-emphasized/muted badge label (size multiplier factors, stacked-count notes, etc.
// that are informational but not the primary signal). #94a3b8 matches the app's
// documented minimum-contrast color for readable muted text on the dark theme.
export const DIM = { fontSize: 11, fontWeight: 600, color: '#94a3b8', letterSpacing: '0.06em', whiteSpace: 'nowrap' };
