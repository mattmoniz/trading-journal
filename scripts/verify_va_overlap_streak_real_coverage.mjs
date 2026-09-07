// Self-checking recheck for RESEARCH_CLAIM va_overlap_streak_predicts_breakout_bar_level_20260906.
// The confirmed bar-level finding (extended value-area overlap predicts a real lift toward a
// TREND day) could not be tested against real setup EV because zero real trades had ever fired
// on a qualifying LONG-streak (>=3) day since live trade tracking began (2026-07-09) -- the
// last qualifying day was 2026-06-29, before real tracking started. va_overlap_streak is now
// tagged live on every real active_setups insert (2026-09-07), so this no longer needs to
// recompute the streak itself -- it just watches the already-tagged column directly.
//
// No-ops until a real ACTIVE/SHADOW row exists with va_overlap_streak >= 3, then re-runs the
// real-setup-EV test (same logic as scripts/test_va_overlap_streak_vs_real_setups.mjs) across
// the now-real-covered roster and updates the RESEARCH_CLAIM with fresh numbers via
// recordClaim(). Does not resolve an OPEN_DECISION -- this claim never had one blocking on it,
// just an update-in-place once real data exists.
import { query } from '../server/db.js';
import { getBetClass } from '../server/config/setupTypes.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { recordClaim } from './record_claim.mjs';
import { runSelfCheckingClaim } from './lib/selfCheckingClaim.mjs';

const LONG_STREAK_THRESHOLD = 3;

async function checkCondition() {
  const res = await query(`
    SELECT id, trade_date::text as trade_date, setup_type, origin_status, va_overlap_streak
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW')
      AND va_overlap_streak >= $1
    ORDER BY fired_at ASC
  `, [LONG_STREAK_THRESHOLD]);
  return { met: res.rows.length > 0, data: res.rows };
}

function getStats(arr) {
  if (arr.length === 0) return { n: 0, wr: 0, ev: 0 };
  const n = arr.length;
  const wins = arr.filter(x => x.actual_pnl > 0).length;
  const totalPnl = arr.reduce((s, x) => s + x.actual_pnl, 0);
  return { n, wr: +(wins / n * 100).toFixed(1), ev: +(totalPnl * LIVE_INSTRUMENT.dollarsPerPoint / n).toFixed(2) };
}

async function onConditionMet(longRows) {
  console.log(`  ${longRows.length} real LONG-streak (>=${LONG_STREAK_THRESHOLD}) rows now exist:`);
  for (const r of longRows) console.log(`    ${r.trade_date} ${r.setup_type} (${r.origin_status}) streak=${r.va_overlap_streak}`);

  // Pull real PnL for these + a comparison population (streak < LONG_STREAK_THRESHOLD, real N)
  // to compute the same NONE/SHORT/LONG-shaped EV comparison the earlier bar-level test used,
  // now with real trade-level EV instead of raw bar-level forward move.
  const { rows: all } = await query(`
    SELECT trade_date::text as trade_date, setup_type, actual_pnl::float as actual_pnl, va_overlap_streak
    FROM active_setups
    WHERE origin_status IN ('ACTIVE','SHADOW') AND actual_pnl IS NOT NULL AND va_overlap_streak IS NOT NULL
  `);
  const fadeRows = all.filter(r => getBetClass(r.setup_type) === 'VALUE_FADE');
  const longBucket = fadeRows.filter(r => r.va_overlap_streak >= LONG_STREAK_THRESHOLD);
  const restBucket = fadeRows.filter(r => r.va_overlap_streak < LONG_STREAK_THRESHOLD);
  const longStats = getStats(longBucket);
  const restStats = getStats(restBucket);
  console.log(`  Real fade-roster EV: LONG streak N=${longStats.n} EV=$${longStats.ev} | rest N=${restStats.n} EV=$${restStats.ev}`);

  const { rows: [{ today }] } = await query(`SELECT CURRENT_DATE::text as today`);
  await recordClaim({
    slug: 'va_overlap_streak_predicts_breakout_bar_level_20260906',
    claimText: `AUTO-UPDATED ${today} by scripts/verify_va_overlap_streak_real_coverage.mjs: real trade coverage now exists for a LONG (>=${LONG_STREAK_THRESHOLD}) va_overlap_streak day for the first time since live tracking began -- the original bar-level finding (2026-09-06) could not be tested against real setup EV due to zero coverage; that gap is now closed. Real fade-roster (VALUE_FADE bet_class) EV comparison: LONG streak N=${longStats.n}, WR=${longStats.wr}%, EV=$${longStats.ev}/trade vs REST (streak<${LONG_STREAK_THRESHOLD}) N=${restStats.n}, WR=${restStats.wr}%, EV=$${restStats.ev}/trade. This is a FIRST LOOK at real N=${longStats.n} -- likely still thin, needs the same N>=20 floor and per-type replication discipline as every other finding this session before being trusted for anything beyond "worth tracking." The original bar-level (non-setup-gated) finding remains the primary, already-CONFIRMED evidence; this is the trade-level follow-up test it was always waiting on.`,
    sourceFile: 'scripts/verify_va_overlap_streak_real_coverage.mjs',
    sourceDate: today,
    sampleSize: longStats.n,
    winRate: longStats.n > 0 ? longStats.wr / 100 : null,
    evPerTrade: longStats.n > 0 ? longStats.ev : null,
    rigorStatus: longStats.n >= 20 ? 'first_real_coverage_needs_replication_check' : 'first_real_coverage_thin_n',
    status: 'PROVISIONAL',
  });
  console.log('  RESEARCH_CLAIM va_overlap_streak_predicts_breakout_bar_level_20260906 auto-updated with real trade-level data.');
}

runSelfCheckingClaim({ name: 'verify_va_overlap_streak_real_coverage', checkCondition, onConditionMet })
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
