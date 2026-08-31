// One-off backfill (docs/OPEN_THREADS.md 2026-08-18): the "suppressed near-level audit"
// insert site (server/routes/acd.js's setup-detection handler) was missing wider_target_mult
// from its INSERT column list until this same session's fix (commit 15a0502, deployed
// 2026-08-18 13:10:20 ET). Every row that fired through that branch BEFORE the fix deployed
// and reached T1 within MAX_BARS_TO_T1_FOR_WIDER bars never got a chance to arm the
// wider-target mechanism -- it just banked at the plain T1 like the mechanism didn't exist.
// User caught this directly (8 real SHADOW trades this morning that should have counted
// toward the mechanism's N) and asked why the fix didn't retroactively catch them: it can't,
// by construction (a code fix only changes future INSERTs) -- this script is the deliberate
// retroactive correction, per CLAUDE.md's no-dead-ends rule (a real trade denied the tag it
// should have gotten is exactly what that rule exists to prevent).
//
// Reuses the EXACT same functions as the already-built per-trade wider-target counterfactual
// endpoint (GET /api/setups/:id/wider-target-counterfactual, acd.js ~9408) -- same
// stepWiderTarget()/resolveDirection() imports, same bar-fetch query, same entry/direction
// convention, same reconstruction consistency check -- per the "export the real function,
// never reimplement" rule. The only difference: that endpoint reports a HYPOTHETICAL and
// never persists; this script persists the result as the row's REAL outcome, because for
// these specific rows the mechanism genuinely *should* have applied at insert time and was
// only denied by the bug, not by the mechanism's own design (unlike every other row that
// endpoint serves, where wider_target_mult IS NULL is the correct, intended state).
//
// Run: node scripts/backfill_wider_target_4th_site_miss_20260818.mjs --dry-run
//      node scripts/backfill_wider_target_4th_site_miss_20260818.mjs --apply
import { query } from '../server/db.js';
import { resolveDirection } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { stepWiderTarget, WIDER_TARGET_MULT, MAX_BARS_TO_T1_FOR_WIDER } from '../server/services/widerTargetWalker.js';
import { firedAtToMod } from '../server/services/sessionBoundary.js';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const BACKUP_TABLE = 'active_setups_widertarget_4thsite_backfill_backup_20260818';

async function main() {
  const apply = process.argv.includes('--apply');
  const dryRun = !apply;

  // Same eligibility gate as the counterfactual endpoint, scoped to the mechanism's own
  // lifetime (shipped 2026-08-17) and to SHADOW-origin (this mechanism never touches ACTIVE
  // rows by construction) -- matches exactly what Claude verified live with the user in this
  // session (8 rows, all dated 2026-08-18, all from the previously-broken 4th insert site).
  const rowsQ = await query(`
    SELECT id, setup_type, resolution, resolution_method, bars_to_resolution,
           wider_target_mult::float as wider_target_mult, extend_target_level::float as extend_target_level,
           entry_zone_low::float as entry_zone_low, entry_zone_high::float as entry_zone_high,
           stop_level::float as stop_level, t1_level::float as t1_level,
           trade_date::text as trade_date, fired_at::text as fired_at, actual_pnl::float as actual_pnl
    FROM active_setups
    WHERE origin_status = 'SHADOW'
      AND resolution = 'TARGET_HIT'
      AND bars_to_resolution IS NOT NULL AND bars_to_resolution <= $1
      AND wider_target_mult IS NULL
      AND extend_target_level IS NULL
      AND runner_trail_width IS NULL
      AND trade_date >= '2026-08-17'
    ORDER BY trade_date, fired_at ASC
  `, [MAX_BARS_TO_T1_FOR_WIDER]);

  console.log(`Found ${rowsQ.rows.length} eligible-but-missed row(s).`);

  const toUpdate = [];
  const skipped = [];

  for (const row of rowsQ.rows) {
    const entry = row.entry_zone_high ?? row.entry_zone_low;
    const stop = row.stop_level;
    const t1 = row.t1_level;
    if (entry == null || stop == null || t1 == null) { skipped.push({ id: row.id, reason: 'missing_levels' }); continue; }
    const direction = resolveDirection(row);
    if (direction == null) { skipped.push({ id: row.id, reason: 'direction_unresolvable' }); continue; }
    const long = direction === 'LONG';

    const barsQ = await query(`
      SELECT ts::text as ts, high::float, low::float, close::float,
             (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as mod
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts::date = $1 AND ts > $2::timestamp
        AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) <= 960
      ORDER BY ts
    `, [row.trade_date, row.fired_at]);
    const bars = barsQ.rows;
    if (!bars.length) { skipped.push({ id: row.id, reason: 'no_bar_data' }); continue; }
    // FIXED 2026-08-30 (DeepSeek code review round 2, finding R1): stepWiderTarget()'s
    // internal session-end check now needs firedMod -- without it, isPastMechanismSessionEnd()
    // silently no-ops (undefined>=960 is false). This eligibility gate is scoped to
    // trade_date>=2026-08-17 SHADOW rows only and this script is a one-off, already-applied
    // backfill (docstring above) -- but fixed for correctness regardless.
    const firedMod = firedAtToMod(row.fired_at);

    const t1Distance = Math.abs(t1 - entry);
    const widerTarget = long ? entry + t1Distance * WIDER_TARGET_MULT : entry - t1Distance * WIDER_TARGET_MULT;

    let state = { widening: false };
    let barCount = 0, finalBarCount = null;
    let resolution = null, priceAtRes = null, method = null, derivedBarsToT1 = null;

    for (const bar of bars) {
      barCount++;
      const step = stepWiderTarget(state, bar, { entry, stop, t1, widerTarget, long, barCount, maxBarsToT1: MAX_BARS_TO_T1_FOR_WIDER, firedMod });
      const wasWidening = state.widening;
      state = step.state;
      if (!wasWidening && state.widening && derivedBarsToT1 == null) derivedBarsToT1 = barCount;
      if (step.resolution) {
        resolution = step.resolution.resolution;
        method = step.resolution.method;
        priceAtRes = step.resolution.priceAtRes;
        finalBarCount = barCount;
        break;
      }
    }

    if (!resolution) { skipped.push({ id: row.id, reason: 'no_resolution_in_window' }); continue; }
    // Same consistency check as the counterfactual endpoint -- refuses to trust a row whose
    // re-walk doesn't reconstruct the already-known original bars-to-T1.
    if (derivedBarsToT1 !== Number(row.bars_to_resolution)) {
      skipped.push({ id: row.id, reason: 'reconstruction_mismatch', derivedBarsToT1, storedBarsToResolution: row.bars_to_resolution });
      continue;
    }

    const newPnl = Math.round(((long ? (priceAtRes - entry) : (entry - priceAtRes)) * PNL_PER_POINT - COMMISSION) * 100) / 100;

    toUpdate.push({
      id: row.id, setup_type: row.setup_type,
      oldResolution: row.resolution, oldMethod: row.resolution_method, oldPnl: row.actual_pnl, oldBars: row.bars_to_resolution,
      newResolution: resolution, newMethod: method, newPriceAtRes: priceAtRes, newPnl, newBars: finalBarCount,
    });
  }

  console.log(`\n${toUpdate.length} row(s) to update, ${skipped.length} skipped.`);
  if (skipped.length) console.log('Skipped:', JSON.stringify(skipped, null, 2));
  console.table(toUpdate.map(u => ({
    id: u.id, type: u.setup_type,
    oldMethod: u.oldMethod, oldPnl: u.oldPnl, oldBars: u.oldBars,
    newMethod: u.newMethod, newPnl: u.newPnl, newBars: u.newBars,
    delta: Math.round((u.newPnl - u.oldPnl) * 100) / 100,
  })));

  if (dryRun) {
    console.log('\nDRY RUN -- no writes made. Re-run with --apply to persist.');
    return;
  }

  if (!toUpdate.length) { console.log('Nothing to apply.'); return; }

  const ids = toUpdate.map(u => u.id);
  await query(`CREATE TABLE ${BACKUP_TABLE} AS SELECT * FROM active_setups WHERE id = ANY($1::int[])`, [ids]);
  console.log(`Backed up ${ids.length} row(s) to ${BACKUP_TABLE}.`);

  for (const u of toUpdate) {
    await query(`
      UPDATE active_setups
      SET wider_target_mult = $2, resolution = $3, resolution_method = $4,
          price_at_resolution = $5, actual_pnl = $6, bars_to_resolution = $7
      WHERE id = $1
    `, [u.id, WIDER_TARGET_MULT, u.newResolution, u.newMethod, u.newPriceAtRes, u.newPnl, u.newBars]);
  }
  console.log(`Applied ${toUpdate.length} update(s).`);

  // Self-verify: re-read one row back and confirm it matches what was just written.
  const check = await query(`SELECT id, wider_target_mult, resolution, resolution_method, actual_pnl, bars_to_resolution FROM active_setups WHERE id = $1`, [toUpdate[0].id]);
  console.log('Self-check (first updated row, re-read from DB):', check.rows[0]);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
