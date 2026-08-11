// scripts/seed_setup_b_d_setup_status_20260811.mjs
// One-off: seed SETUP_STATUS rows for FAILED_SWEEP_REVERSAL_LONG/SHORT (roadmap Setup B)
// and OPENING_DRIVE_15MIN_LONG/SHORT (roadmap Setup D) — per CLAUDE.md's "new setup type
// checklist" item 11 (a setup_type with zero real active_setups history is NOT
// automatically SHADOW-safe; an absent SETUP_STATUS row is invisible to
// backtest_setup_status.mjs's generic GROUP BY scan, since that scan can only classify
// rows that already exist). Same pattern as the 2026-07-27 PM_POC_FADE seed
// (scripts/seed_pm_poc_setup_status_20260727.mjs).
//
// Found during Phase 8's UI verification pass (2026-08-11, roster-rebuild roadmap): the
// Setup Reference page's own driving query is a union of (has a SETUP_STATUS row) ∪ (has
// active_setups history) ∪ 2 known hardcoded exceptions — Setup B and D had neither, so
// both were silently absent from the page (192 setup_types shown, 0 of them these 4),
// despite being real, already-committed, already-live-firing (SHADOW) parts of this
// session's own Phase 4/6 work. Not a rendering bug — a data-completeness gap the render
// correctly reflected.
//
// Both seeded THIN_N (real SHADOW N=0, not ACTIVE/PROMOTE) — the real Stage 1 bar-history
// backtest results below are strong, but per this codebase's own standing rule, only real
// live/SHADOW data promotes a type out of THIN_N, never a backtest number alone.
// backtest_setup_status.mjs self-heals to a real calibration the moment real touches
// accumulate, same self-healing pattern as every other THIN_N seed.
import { query } from '../server/db.js';

async function seedStatus({ signalName, recommendation, sampleSize, notes }) {
  const { rows } = await query(`SELECT CURRENT_DATE::text as today`);
  const today = rows[0].today;
  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, recommendation, notes)
    VALUES ($1, 0, 'SETUP_STATUS', $2, $3, $4, $5)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
      SET sample_size = EXCLUDED.sample_size, recommendation = EXCLUDED.recommendation, notes = EXCLUDED.notes
  `, [today, signalName, sampleSize, recommendation, JSON.stringify(notes)]);
  console.log(`Seeded SETUP_STATUS ${signalName} -> ${recommendation}`);
}

async function main() {
  const bNotes = {
    source: 'manual seed — Setup B (Failed Sweep Reversal) shipped SHADOW-only, roadmap Phase 4, 2026-08-11; zero real active_setups history at seed time so the generic backtest_setup_status.mjs scan cannot produce even a THIN_N row on its own.',
    reason: 'RESEARCH_CLAIM setup_b_failed_sweep_reversal_stage1 (Stage 1 bar-history backtest, real detectStopSweep() population, N=803 touches/420 sessions, shared order-aware resolve()): winning arm stop=68/target=250, IS_EV=$10.15 -> OOS_EV=$12.99 (N_oos=268), rigor.clean=true, top5DayPct=1.2, chronological thirds stable ($15.87/$4.17/$13.24). Beats the flat volatility-scaled default (OOS_EV=$2.00). Passed the pre-registered Stage 1 gate, advanced to Stage 2 (shadow live). This is Stage 1 backtest evidence, not real forward SHADOW data — seeded THIN_N, not ACTIVE, until real touches accumulate.',
    research_claim: 'setup_b_failed_sweep_reversal_stage1',
    real_shadow_n_at_seed_time: 0,
  };
  await seedStatus({ signalName: 'FAILED_SWEEP_REVERSAL_LONG', recommendation: 'THIN_N', sampleSize: 0, notes: bNotes });
  await seedStatus({ signalName: 'FAILED_SWEEP_REVERSAL_SHORT', recommendation: 'THIN_N', sampleSize: 0, notes: bNotes });

  const dNotes = {
    source: 'manual seed — Setup D (Opening Drive, 15-min OR variant) shipped SHADOW-only, roadmap Phase 6, 2026-08-11; zero real active_setups history at seed time so the generic backtest_setup_status.mjs scan cannot produce even a THIN_N row on its own.',
    reason: 'RESEARCH_CLAIM setup_d_opening_drive_stage1 (Stage 1 bar-history backtest, VARIANT_15MIN Arm A, N=138, DeepSeek-required blind-delay confound control): stop=85/target=150, IS_EV=$38.23 -> OOS_EV=$43.72 (N_test=46), rigor.clean=true, top5DayPct=3.6, chronological thirds stable ($42/$34.47/$43.72). Beats its own blind-delay control (Arm B OOS_EV=-$47.18 — rules out the "just enter later" confound) and beats the flat volatility-scaled default. The live 5-min-OR definition (VARIANT_5MIN) FAILED this same check (Arm A did not beat its blind-delay control) — this is why OPENING_DRIVE_15MIN was shipped as a NEW setup_type rather than fixing the pre-existing OPEN_DRIVE_LONG/SHORT in place. This is Stage 1 backtest evidence, not real forward SHADOW data — seeded THIN_N, not ACTIVE, until real touches accumulate.',
    research_claim: 'setup_d_opening_drive_stage1',
    real_shadow_n_at_seed_time: 0,
  };
  await seedStatus({ signalName: 'OPENING_DRIVE_15MIN_LONG', recommendation: 'THIN_N', sampleSize: 0, notes: dNotes });
  await seedStatus({ signalName: 'OPENING_DRIVE_15MIN_SHORT', recommendation: 'THIN_N', sampleSize: 0, notes: dNotes });

  console.log('Done.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
