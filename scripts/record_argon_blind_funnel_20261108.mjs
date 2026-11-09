// Records the ledger look + claim for scripts/argon_vacuum_blind_funnel.py (prereg docs/ARGON_VACUUM_BLIND_FUNNEL_PREREG_20261108.md). Awaits every call (hr-060).
import fs from 'fs';
import { logLook } from './lib/look_ledger.mjs';
import { recordClaim } from './record_claim.mjs';
const s = JSON.parse(fs.readFileSync(new URL('../scratch/argon_blind_funnel_20261108/summary.json', import.meta.url)));
const look = await logLook({ family: 'argon_vacuum_blind_funnel', dataWindow: 'explore<=2025-05-16', kind: 'EXPLORE', tests: 0, label: 'blind funnel count + power gate (RTH VB500)',
  script: 'scripts/argon_vacuum_blind_funnel.py', prereg: 'docs/ARGON_VACUUM_BLIND_FUNNEL_PREREG_20261108.md', claimSlug: 'argon_vacuum_blind_funnel_underpowered_20261108', outcome: 'PARKED_UNDERPOWERED',
  notes: { note: 'no trigger outcome read; only unconditional fast-tape 30-bar volatility', triggers: s.triggers, active_days: s.active_days } });
console.log('look', look);
const claim = await recordClaim({ slug: 'argon_vacuum_blind_funnel_underpowered_20261108', sourceFile: 'scratch/argon_blind_funnel_20261108/summary.json', sourceDate: '2026-11-08', sampleSize: s.triggers,
  claimText: `Argon liquidity-vacuum pullback spec, RTH VB500, Explore ${s.scored_sessions} scored sessions: ${s.triggers} triggers (${(s.triggers / s.scored_sessions).toFixed(3)}/session), ${s.active_days} active days, N_eff ${s.n_eff.toFixed(0)}. Fast-tape 30-bar sigma ${s.sigma30.toFixed(1)} pt. Minimum detectable mean at 80 percent power: pooled ${s.mde_pool.toFixed(2)} pt, paired vs FAST_FLOW_CONTROL ${s.mde_pair.toFixed(2)} pt (frozen gates 3.5 / 3.0), cost floor 2.0 pt. Funnel gates passed, power gates failed -> PARKED, UNDERPOWERED ON EXPLORE (NOT retired, NOT tested for edge). Globex VB100 track untested.`,
  rigorStatus: 'not_checked', status: 'PROVISIONAL', unblockCondition: 'reopen: forward shadow trigger log reaches enough active days, Globex VB100 extract, a longer-hold variant, or a cheaper cost basis (prereg section 6)', extra: s.gates });
console.log('claim', claim);
process.exit(0);
