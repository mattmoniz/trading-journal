// Registers row 36 (Globex version of the vacuum: ROC3 vs ROC10). Registration look (tests=0) + PROVISIONAL claim + improvement-register row. Every call awaited (hr-060).
import { readFileSync, writeFileSync } from 'node:fs';
import { logLook } from './lib/look_ledger.mjs';
import { recordClaim } from './record_claim.mjs';
const slug = 'globex_roc3_vacuum_20261110', prereg = 'docs/GLOBEX_ROC3_VACUUM_PREREG_20261110.md';
const look = await logLook({ family: slug, dataWindow: 'explore_2023-03-07..2025-05-16 Globex 500V bars; sealed and >=2026-10-12 untouched', kind: 'EXPLORE', tests: 0, label: 'REGISTRATION row 36: Globex vacuum, ROC3 vs ROC10 on the live expansion rule; 5 counted tests, none run', prereg, claimSlug: slug, outcome: 'REGISTERED', ref: `${slug}_registration` });
console.log('look', look);
const c = await recordClaim({ slug, claimText: 'REGISTERED, NOT RUN. Row 36: the live vacuum expansion rule on the Globex track with ROC length 3 (arm B) against 10 (arm A, the live rule); same code path, 30-bar hold, 2.0 pt cost. 5 counted tests (ROC3 continuation, ROC3 reversion, ROC3 minus ROC10, ROC3 continuation in SLOW and FAST hour terciles), Holm 0.10, day-blocked bootstrap, cells need >= 100 events and 60 days. Argon v2.2 clock windows, cutoffs and the M4 fade are NOT adopted.', sourceFile: prereg, sourceDate: '2026-11-10', rigorStatus: 'not_checked', status: 'PROVISIONAL', unblockCondition: null, extra: { registered: '2026-11-10', register_rows: '36', prereg, run: false } });
console.log('claim', c.slug);
const p = 'docs/IMPROVEMENT_REGISTER_20261104.md'; let t = readFileSync(p, 'utf8');
if (!t.includes('| 36 |')) {
  const row = '| 36 | GLOBEX VERSION OF THE VACUUM (user 2026-11-10: "we need a Globex version with its own settings"; Argon v2.2 spec) | REGISTERED 2026-11-10: prereg `docs/GLOBEX_ROC3_VACUUM_PREREG_20261110.md`, claim `globex_roc3_vacuum_20261110`. Premise verified (Globex 500V bars median 173-565 s by hour vs RTH 12-31 s), Argon Nov 5/6 narrative NOT supported by our bars. Live Globex taken fires so far 11 (-$461), not decisive. | If ROC3 helps, the Globex setting is one parameter, not a new strategy; the spec clock windows and the M4 fade stay separate registrations | Run: `scripts/vacuum_sim/globex_roc3_test.py` build / null / run; forward shadow track GBX3 in `shadow.py` (no orders) | Nothing survives with the gate met: keep the forward arm to 30 taken, then register M4; two registered nulls with MDE <= 0.015 ADR20 retire it (co-025) | REGISTERED |\n';
  const marker = 'Review: when any row';
  t = t.replace(marker, row + '\n' + marker); writeFileSync(p, t);
}
process.exit(0);
