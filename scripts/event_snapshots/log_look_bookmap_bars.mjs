import { logLook } from '../lib/look_ledger.mjs';
const id = await logLook({ family: 'bookmap_style_bar_detectors_20261102', dataWindow: 'explore<=2025-05-16 (516 sessions, RTH + Globex)', kind: 'EXPLORE', tests: 30, label: 'Stage A bar-level Bookmap-style detectors (absorption, delta divergence, volume bubble, large lot, stop run) x 3 horizons x RTH/Globex', script: 'scripts/event_snapshots/run_bookmap_bars.py', prereg: 'docs/BOOKMAP_STYLE_DETECTORS_PREREG_20261102.md', ref: 'bookmap_bars_20261102' });
console.log('look logged id', id); process.exit(0);
