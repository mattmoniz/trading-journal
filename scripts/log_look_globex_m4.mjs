import { logLook } from './lib/look_ledger.mjs';
const prereg = 'docs/GLOBEX_M4_VWAP_FADE_PREREG_20261110.md';
// The outcome-blind count (91 fade events < the 100-event gate) parks all four counted cells BEFORE any outcome is read, so the run is descriptive only: tests = 0.
console.log('look', await logLook({ family: 'globex_m4_vwap_fade_20261110', dataWindow: 'explore_2023-03-07..2025-05-16 Globex 500V bars', kind: 'EXPLORE', tests: 0, label: 'RUN row 38 (descriptive only): fade N 91 < gate 100, all 4 counted cells PARKED outcome-blind; outcomes read descriptively', script: 'scripts/vacuum_sim/globex_m4_fade.py', prereg, claimSlug: 'globex_m4_vwap_fade_20261110', outcome: 'PARKED_GATE', ref: 'globex_m4_vwap_fade_20261110_run1' }));
process.exit(0);
