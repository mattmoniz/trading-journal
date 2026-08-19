// =============================================================================
// PILOT — the "already-turned" entry-timing gate (Opus Audit 8 §4.3 / R3), Stage-1,
// per-setup-type (NOT pooled — the pooled result is a mixture artifact, see below).
//
// Idea: does a real level-fade trade do better when price has ALREADY moved in its
// favour before it fires, vs. firing on the raw touch alone? Signal: the close-to-close
// move over the 15 minutes strictly before a trade's fired_at, signed so positive =
// adverse (against the trade), normalized by the median (high-low) bar range of the
// 30 bars immediately preceding — a data-derived scale, no static threshold. This is
// purely a POST-HOC classifier on trades that already fired at the same level-touch
// entry price under the existing live rules — it does not change the entry price itself.
//
// Pooled result already failed the disqualifying check (Audit 8 §4.3):
//   gated (adv15<=-1.5): n=371, EV +$14.23, WR 60.6%, rigor-clean, 4-point plateau
//   control:             n=1027, EV -$2.34, sign-unstable
//   computeReplication() across 21 types: heldOutPooled -$12.63, 0/10 favourable --
//   the two IB types split in OPPOSITE directions (IB_BEARISH +$43.4, IB_BULLISH -$26.4),
//   meaning the pooled number is a mixture artifact, not a roster-wide edge.
//
// Per DeepSeek's Phase-0 design critique (scratch/deepseek_cluster_loss_fixes_design_review.md,
// §4), the CVD pilot's 3-way template (SIGNAL / SAME_SELECTION_NO_SIGNAL / NEVER_SELECTED)
// does NOT map directly here, because the confound (distance-from-level / remaining risk
// distance -- confound checklist item 1) IS the signal itself: there is no "selection
// happened but signal absent" arm that holds geometry constant, since "moved 1.5 bar-ranges
// in your favour" mechanically means closer to target / further from stop. DeepSeek's fix:
// replace the middle arm with a DIRECTION-MATCHED control -- an adverse move of the SAME
// magnitude -- so the two |adv15|>=1.5 arms hold distance-from-level constant and vary only
// sign. If the adverse arm is also positive (or close to NEVER_SELECTED), geometry is doing
// the work and the "turned in my favour" direction is not a real signal; if favourable beats
// adverse at equal distance, the directional claim survives.
//
//   SIGNAL                 = adv15 <= -CUT   (price already moved >=CUT bar-ranges FAVOURABLY)
//   DIRECTION_MATCHED_CONTROL = adv15 >= +CUT (price already moved >=CUT bar-ranges ADVERSELY)
//   NEVER_SELECTED          = |adv15| <  CUT  (no meaningful pre-fire move either way)
//
// Bar per DeepSeek §2 (Build 2): per-setup-type only, computeRigor().clean on each claimed
// arm, N>=20 in the gated arm, EV/trade + dollar-forgone framing stated explicitly (a gated
// arm can legitimately have HIGHER EV/trade and FEWER total dollars -- that is not a red flag).
// =============================================================================

import { query } from '../server/db.js';
import { resolveDirection } from '../server/config/setupTypes.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { REAL_TRADE_FILTER } from './backtest_setup_status.mjs';
import { recordClaim } from './record_claim.mjs';

const CUT = 1.5; // median-bar-ranges, matches Audit 8's plateau-stable cut point
const LOOKBACK_MIN = 15;
const RANGE_WINDOW_BARS = 30;
const MIN_N_PER_ARM = 20; // CLAUDE.md's standing N>=20 floor, applied per-arm not pooled

function summarize(label, rows) {
  const n = rows.length;
  if (n === 0) return { label, n: 0, str: `    ${label.padEnd(26)} n=0` };
  const wins = rows.filter(r => r.resolution === 'TARGET_HIT').length;
  const wr = (wins / n * 100);
  const evs = rows.map(r => Number(r.actual_pnl)).filter(v => Number.isFinite(v));
  const ev = evs.length ? evs.reduce((a, b) => a + b, 0) / evs.length : null;
  const total = evs.length ? evs.reduce((a, b) => a + b, 0) : null;
  let clean = null;
  if (n >= MIN_N_PER_ARM) {
    const rigor = computeRigor(rows, { dateField: 'dateStr', pnlFn: r => Number(r.actual_pnl) });
    clean = rigor.clean;
  }
  const flag = n >= MIN_N_PER_ARM ? '' : ' (N<20)';
  const str = `    ${label.padEnd(26)} n=${String(n).padEnd(5)} WR=${wr.toFixed(1).padStart(5)}%  EV=$${ev != null ? ev.toFixed(2) : 'n/a'}  total=$${total != null ? total.toFixed(2) : 'n/a'}${flag}${clean != null ? `  clean=${clean}` : ''}`;
  return { label, n, wr, ev, total, clean, str };
}

async function main() {
  const todayRes = await query(`SELECT CURRENT_DATE::text as today`);
  const today = todayRes.rows[0].today;

  const typesRes = await query(`
    SELECT setup_type, COUNT(*) n FROM active_setups
    WHERE ${REAL_TRADE_FILTER} AND resolution IN ('STOP_HIT','TARGET_HIT')
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
      AND actual_pnl IS NOT NULL
    GROUP BY setup_type HAVING COUNT(*) >= 30
    ORDER BY setup_type
  `);
  const setupTypes = typesRes.rows.map(r => r.setup_type);
  console.log(`${setupTypes.length} setup_types with >=30 real, cleanly-resolved trades\n`);

  const perTypeResults = [];
  let pooledSignal = [], pooledControl = [], pooledNever = [];

  for (const setupType of setupTypes) {
    const tradesRes = await query(`
      SELECT id, trade_date, fired_at, resolution, actual_pnl,
             entry_zone_low, entry_zone_high, stop_level, t1_level, setup_type
      FROM active_setups
      WHERE setup_type = $1 AND ${REAL_TRADE_FILTER} AND resolution IN ('STOP_HIT','TARGET_HIT')
        AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL
        AND actual_pnl IS NOT NULL
      ORDER BY trade_date, fired_at
    `, [setupType]);
    const trades = tradesRes.rows.filter(t => resolveDirection(t) != null);
    if (trades.length < 30) continue;

    const signalRows = [], controlRows = [], neverRows = [];
    for (const t of trades) {
      const direction = resolveDirection(t);
      const dateStr = typeof t.trade_date === 'string' ? t.trade_date.slice(0, 10) : t.trade_date.toISOString().slice(0, 10);

      // Median (high-low) range of the RANGE_WINDOW_BARS bars strictly before fired_at
      // (floored to the minute -- floor-timestamps-to-the-minute convention, real trades
      // carry sub-minute fired_at precision, bars are always on-minute).
      const rangeRes = await query(`
        SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (high - low)) AS median_range
        FROM (
          SELECT high::float AS high, low::float AS low FROM price_bars_primary
          WHERE symbol = 'NQ' AND ts < date_trunc('minute', $1::timestamptz)
          ORDER BY ts DESC LIMIT ${RANGE_WINDOW_BARS}
        ) recent
      `, [t.fired_at]);
      const medianRange = +rangeRes.rows[0]?.median_range;
      if (!Number.isFinite(medianRange) || medianRange <= 0) continue;

      // Close at fired_at (floored to minute) and close 15 minutes earlier -- no lookahead,
      // both strictly at/before fired_at.
      const closesRes = await query(`
        SELECT ts, close::float AS close FROM price_bars_primary
        WHERE symbol = 'NQ'
          AND ts IN (date_trunc('minute', $1::timestamptz), date_trunc('minute', $1::timestamptz) - ($2::text || ' minutes')::interval)
      `, [t.fired_at, String(LOOKBACK_MIN)]);
      if (closesRes.rows.length < 2) continue;
      const byTs = new Map(closesRes.rows.map(r => [new Date(r.ts).getTime(), r.close]));
      const fireMinuteMs = new Date(t.fired_at).setSeconds(0, 0);
      const priorMinuteMs = fireMinuteMs - LOOKBACK_MIN * 60 * 1000;
      const closeFire = byTs.get(fireMinuteMs);
      const closePrior = byTs.get(priorMinuteMs);
      if (!Number.isFinite(closeFire) || !Number.isFinite(closePrior)) continue;

      // Signed so positive = adverse. LONG: adverse = price fell (closePrior > closeFire).
      // SHORT: adverse = price rose (closeFire > closePrior).
      const rawMove = direction === 'LONG' ? (closePrior - closeFire) : (closeFire - closePrior);
      const adv15 = rawMove / medianRange;

      const enriched = { ...t, dateStr };
      if (adv15 <= -CUT) signalRows.push(enriched);
      else if (adv15 >= CUT) controlRows.push(enriched);
      else neverRows.push(enriched);
    }

    if (signalRows.length === 0 && controlRows.length === 0) continue;

    const sigSum = summarize('SIGNAL (favourable)', signalRows);
    const ctrlSum = summarize('DIRECTION_MATCHED_CTRL', controlRows);
    const neverSum = summarize('NEVER_SELECTED', neverRows);
    console.log(`### ${setupType} (N=${trades.length})`);
    console.log(sigSum.str);
    console.log(ctrlSum.str);
    console.log(neverSum.str);

    // Confound verdict: does favourable beat adverse at equal |adv15| distance?
    let verdict = 'INSUFFICIENT_DATA';
    if (sigSum.n >= MIN_N_PER_ARM && ctrlSum.n >= MIN_N_PER_ARM) {
      const delta = sigSum.ev - ctrlSum.ev;
      if (delta > 0 && sigSum.clean) verdict = 'DIRECTION_SURVIVES';
      else if (delta <= 0) verdict = 'GEOMETRY_ONLY_NO_REAL_SIGNAL';
      else verdict = 'DIRECTION_POSITIVE_NOT_RIGOR_CLEAN';
    } else if (sigSum.n >= MIN_N_PER_ARM) {
      verdict = 'NO_CONTROL_ARM_DATA';
    }
    console.log(`    verdict: ${verdict}\n`);

    perTypeResults.push({ setupType, n: trades.length, signal: sigSum, control: ctrlSum, never: neverSum, verdict });
    pooledSignal.push(...signalRows); pooledControl.push(...controlRows); pooledNever.push(...neverRows);
  }

  console.log('='.repeat(100));
  console.log('POOLED (reference only -- per-type verdicts above are what this study actually reports)');
  console.log('='.repeat(100));
  console.log(summarize('SIGNAL (favourable)', pooledSignal).str);
  console.log(summarize('DIRECTION_MATCHED_CTRL', pooledControl).str);
  console.log(summarize('NEVER_SELECTED', pooledNever).str);

  const survivors = perTypeResults.filter(r => r.verdict === 'DIRECTION_SURVIVES');
  console.log(`\n${survivors.length} of ${perTypeResults.length} tested setup_types show DIRECTION_SURVIVES (favourable beats adverse at equal distance, N>=20 both arms, rigor-clean):`);
  for (const s of survivors) {
    console.log(`  ${s.setupType}: SIGNAL n=${s.signal.n} EV=$${s.signal.ev.toFixed(2)} vs CTRL n=${s.control.n} EV=$${s.control.ev.toFixed(2)}  (delta $${(s.signal.ev - s.control.ev).toFixed(2)}/trade)`);
  }

  // Dollar-forgone framing (DeepSeek bar 4): for any survivor, state what applying the
  // gate would cost in total realized dollars even as EV/trade improves.
  if (survivors.length > 0) {
    console.log(`\nDollar-forgone framing per survivor (gating removes the CONTROL+NEVER_SELECTED population):`);
    for (const s of survivors) {
      const forgone = (s.control.total || 0) + (s.never.total || 0);
      const forgoneN = s.control.n + s.never.n;
      console.log(`  ${s.setupType}: gating to SIGNAL-only forgoes $${forgone.toFixed(2)} across ${forgoneN} trades not fired`);
    }
  }

  // Guard added 2026-08-19 after this script's first run silently recorded a fabricated
  // "0 of 0, CONFIRMED" claim on a run that never actually classified a single trade (a real
  // bug in the signal computation, not a genuine negative result -- see OPEN_DECISION
  // build2_already_turned_entry_gate_script_broken). perTypeResults.length===0 means the
  // per-trade loop never produced usable data for ANY setup_type -- that is always a bug in
  // this script, never a legitimate "tested and found nothing" outcome, since even a thin
  // real signal should classify SOME trades into SIGNAL/CONTROL for at least one type.
  if (perTypeResults.length === 0) {
    console.error('\n[ABORT] perTypeResults is empty -- every setup_type produced zero SIGNAL+CONTROL trades. This is a bug in the signal computation (see OPEN_DECISION build2_already_turned_entry_gate_script_broken), not a real finding. Refusing to record a RESEARCH_CLAIM on broken data.');
    process.exit(1);
  }

  await recordClaim({
    slug: 'already_turned_entry_gate_per_type',
    claimText: `Per-setup-type test of the "already-turned" entry-timing gate (fire only when ` +
      `price has already moved >=${CUT} median-bar-ranges in the trade's favour over the prior ` +
      `${LOOKBACK_MIN} min) using a direction-matched control (adverse move of the same magnitude, ` +
      `not the CVD pilot's selection-minus-signal template, per DeepSeek's Phase-0 critique -- the ` +
      `distance-from-level confound IS the signal here, so only a sign-matched control at equal ` +
      `distance isolates a real directional effect from geometry). Pooled Audit 8 result already ` +
      `failed computeReplication() (held-out -$12.63, 0/10 favourable) -- this is the per-type ` +
      `re-test that result called for. ${survivors.length} of ${perTypeResults.length} tested ` +
      `setup_types show DIRECTION_SURVIVES (N>=20 both arms, rigor-clean, favourable beats adverse ` +
      `at equal distance): ${survivors.map(s => s.setupType).join(', ') || 'none'}.`,
    sourceFile: 'scripts/pilot_already_turned_entry.mjs',
    sourceDate: today,
    sampleSize: perTypeResults.reduce((a, r) => a + r.n, 0),
    winRate: null,
    evPerTrade: survivors.length ? survivors.reduce((a, s) => a + (s.signal.ev - s.control.ev), 0) / survivors.length : null,
    rigorStatus: 'checked',
    status: survivors.length > 0 ? 'PROVISIONAL' : 'CONFIRMED',
  });

  console.log(`\nRecorded RESEARCH_CLAIM already_turned_entry_gate_per_type. No live wiring -- ` +
    `per DeepSeek's bar (B), that requires the pre-registered per-type decision rule and the ` +
    `combined-retention check with any Build 1 throttle, neither of which exist yet.`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
