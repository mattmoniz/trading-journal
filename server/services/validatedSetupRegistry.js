// Small, explicit registry of setups with a VALIDATED, regime-conditioned positive finding,
// 2026-09-09. Built for quick-check.html's "which setups fit today's regime" card addition
// (direct user request, same session as the momentum-chase live wiring). Deliberately a real,
// growable list rather than a hardcoded display string in the HTML -- per this codebase's own
// "no dead ends" rule (a finding this drives a live decision needs to stay discoverable, not
// buried in a template string), add a new entry here whenever another generic-setup research
// thread produces a real, regime-conditioned positive finding worth surfacing live.
//
// Each entry names its OWN backing RESEARCH_CLAIM slug -- if that claim's next_recheck_due ever
// flags it STALE, this registry entry should be re-verified (or removed) in the same pass, not
// left pointing at a claim nobody re-checked. Currently just the one entry; this file's whole
// purpose is to make adding the second one easy and consistent.

export const VALIDATED_SETUP_REGIME_FITS = [
  {
    label: 'Momentum Chase (PDH/PDL breakout)',
    setupTypePrefix: 'MOMENTUM_CHASE_MEDIUM',
    requiredRegime: 'MEDIUM',
    researchClaimSlug: 'setup6_momentum_chase_medium_regime_positive_20260909',
    liveSince: '2026-09-09',
  },
];

// Returns [{ label, requiredRegime, favorableToday, researchClaimSlug }] given the current
// live regime classification (LOW/MEDIUM/HIGH). Pure function, no DB access -- caller supplies
// the regime (from getCurrentGarchRegime()) so this stays testable and doesn't duplicate that
// read.
export function getSetupsFavorableToday(currentRegime) {
  return VALIDATED_SETUP_REGIME_FITS.map((entry) => ({
    label: entry.label,
    requiredRegime: entry.requiredRegime,
    favorableToday: entry.requiredRegime === currentRegime,
    researchClaimSlug: entry.researchClaimSlug,
  }));
}
