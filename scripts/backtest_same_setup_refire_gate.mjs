// Same-setup-type "refire gate" calibration -- generalizes the sibling-reversal gate's own
// mechanism (server/routes/acd.js, isPostWinOppositeFamilyBlocked(), 2026-09-02: "the very next
// trade cannot be from the same family in the opposite direction... until a different family
// setup fires first") to the SAME exact setup_type re-firing, not opposite-direction. User's
// explicit design confirmation: event-based reset ("blocked until a DIFFERENT setup fires"),
// never a fixed-minute timer -- distinct from REFIRE_COOLDOWN_MINUTES (flat 30min, hardcoded to
// 12 types) and isCrossDirectionFastFlip() (calibrated but still time-window-based).
//
// METHODOLOGY NOTE (2026-09-03): an initial Gemini-authored version of this analysis
// (scratch/cooldown_analysis.mjs) used a strict `T.fired_at > P.resolved_at` boundary check
// against only the SINGLE nearest same-type predecessor P. Since fired_at/resolved_at are
// overwhelmingly minute-quantized in this data, a same-type setup that resolves and re-fires on
// the very next tick ties EXACTLY on that boundary (T.fired_at === P.resolved_at) -- the single
// most common refire pattern -- and the strict inequality silently misclassified it as "allowed"
// instead of "blocked", undercounting the true blocked population by ~2.6x (308 vs the
// independently-verified ~807-875) and flipping several per-type verdicts (confirmed by hand-
// tracing the VWAP_MAGNET_LONG 2026-07-29 cluster against the raw data). This version instead
// asks, per real trade T: does there EXIST some earlier same-type trade P such that no
// DIFFERENT-type real trade fired in the interval (P.resolved_at, T.fired_at)? This is
// mathematically equivalent to "walk back through the same-type chain until you either hit a
// different type (allowed) or run out of history (allowed, nothing to block against)" and is
// immune to the exact-tie boundary bug because it doesn't rely on comparing a single P's
// timestamp to T's -- an exact tie earlier in the chain simply gets walked through.
//
// RTH vs Globex are evaluated SEPARATELY per CLAUDE.md's standing rule -- confirmed live during
// this analysis that pooling them hides real differences (IB_BEARISH: RTH blocked EV -$11.28
// N=54, Globex blocked EV +$0.20 N=82 -- pooling would have understated the real RTH effect).
//
// GATE requires: blocked-bucket real N>=20 (this project's own decisive floor, not a new
// number), blockedEv clearly negative AND worse than the allowed bucket (mirrors the
// cross-direction-flip pooled test's "fast worse than the alternative" check), and NOT
// day-clustered (computeRigor().clustered, i.e. top5-day % <= 50 -- shared function, not a new
// reimplementation) with distinctDates>=10 (borrowed from backtest_cross_direction_fast_flip.mjs,
// same convention). A type/session that fails any of these gets NO_GATE (real data, verdict
// explained) or THIN_N (not enough blocked-bucket N to judge), never silence.
//
// Per-(setup_type, session) rows are the primary verdict; a per-session pooled fallback
// (_POOLED_ALL_RTH / _POOLED_ALL_GLOBEX, same blended-default pattern as CROSS_DIRECTION_FLIP_
// CALIB's _POOLED_ALL) covers any type too thin to individually qualify.
//
// Run nightly via run_daily_calibration.sh per user request (day-clustering here is severe
// enough at per-type granularity that this needs to react quickly as new real data lands, not
// wait for a weekly cycle).
import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const MIN_BLOCKED_N = 20; // this project's own decisive-claim floor
const MIN_DISTINCT_DATES = 10; // same convention as backtest_cross_direction_fast_flip.mjs

async function main() {
  const { rows: [{ today }] } = await query(`SELECT CURRENT_DATE::text as today`);

  // Single query computes is_blocked (the reachability test) and is_rth (session split) for
  // every real, resolved trade. See file header for why this boundary handling differs from
  // (and corrects) the initial Gemini pass.
  const { rows: trades } = await query(`
    WITH real_trades AS (
      SELECT id, setup_type, trade_date::text as trade_date, fired_at, resolved_at, actual_pnl, resolution,
             EXTRACT(HOUR FROM fired_at)*60 + EXTRACT(MINUTE FROM fired_at) AS mins_of_day
      FROM active_setups
      WHERE origin_status IN ('ACTIVE','SHADOW')
        AND resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED')
        AND actual_pnl IS NOT NULL AND resolved_at IS NOT NULL
    )
    SELECT t.id, t.setup_type, t.trade_date, t.actual_pnl::float as actual_pnl, t.resolution,
      (t.mins_of_day >= 570 AND t.mins_of_day < 960) AS is_rth,
      EXISTS (
        SELECT 1 FROM real_trades p
        WHERE p.setup_type = t.setup_type AND p.id <> t.id
          AND p.resolved_at < t.fired_at
          AND NOT EXISTS (
            SELECT 1 FROM real_trades d
            WHERE d.setup_type <> t.setup_type
              AND d.fired_at > p.resolved_at AND d.fired_at < t.fired_at
          )
      ) AS is_blocked
    FROM real_trades t
  `);

  function evOf(bucket) { return bucket.length ? bucket.reduce((s, t) => s + t.actual_pnl, 0) / bucket.length : null; }

  function gateVerdict(label, blocked, allowed, extra = {}) {
    if (blocked.length < MIN_BLOCKED_N) {
      return { recommendation: 'THIN_N', notes: { blockedN: blocked.length, allowedN: allowed.length, blockedEv: evOf(blocked), allowedEv: evOf(allowed), ...extra } };
    }
    const blockedEv = evOf(blocked), allowedEv = evOf(allowed);
    const rigor = computeRigor(blocked, { dateField: 'trade_date', pnlFn: t => t.actual_pnl });
    const worseThanAllowed = blockedEv < 0 && (allowedEv == null || blockedEv < allowedEv);
    const clearsDateFloor = (rigor.distinctDates ?? 0) >= MIN_DISTINCT_DATES && !rigor.clustered;
    const notes = {
      blockedN: blocked.length, allowedN: allowed.length, blockedEv, allowedEv,
      top5DayPct: rigor.top5DayPct, distinctDates: rigor.distinctDates, clustered: rigor.clustered,
      ...extra,
    };
    if (worseThanAllowed && clearsDateFloor) return { recommendation: 'GATE', notes };
    const reason = !worseThanAllowed
      ? `blocked bucket not clearly worse (blockedEv=$${blockedEv.toFixed(2)}, allowedEv=${allowedEv != null ? '$' + allowedEv.toFixed(2) : 'n/a'})`
      : `worse but day-clustered/thin-dates (top5=${rigor.top5DayPct}%, distinctDates=${rigor.distinctDates})`;
    return { recommendation: 'NO_GATE', notes: { ...notes, reason } };
  }

  async function writeRow(signalName, sampleSize, evPerTrade, recommendation, notes) {
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, recommendation, notes)
      VALUES ($1, 0, 'SAME_TYPE_REFIRE_GATE_CALIB', $2, $3, $4, $5, $6)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
        SET sample_size = EXCLUDED.sample_size, ev_per_trade = EXCLUDED.ev_per_trade,
            recommendation = EXCLUDED.recommendation, notes = EXCLUDED.notes
    `, [today, signalName, sampleSize, evPerTrade, recommendation, JSON.stringify(notes)]);
  }

  const bySession = { RTH: [], GLOBEX: [] };
  for (const t of trades) bySession[t.is_rth ? 'RTH' : 'GLOBEX'].push(t);

  let gateCount = 0, noGateCount = 0, thinCount = 0;

  for (const session of ['RTH', 'GLOBEX']) {
    const sessionTrades = bySession[session];
    const byType = new Map();
    for (const t of sessionTrades) {
      if (!byType.has(t.setup_type)) byType.set(t.setup_type, []);
      byType.get(t.setup_type).push(t);
    }

    for (const [type, list] of byType) {
      if (list.length < MIN_BLOCKED_N) continue; // not even enough real N in this session to bother
      const blocked = list.filter(t => t.is_blocked);
      const allowed = list.filter(t => !t.is_blocked);
      const { recommendation, notes } = gateVerdict(`${type}_${session}`, blocked, allowed);
      const signalName = `${type}_${session}`;
      await writeRow(signalName, blocked.length, notes.blockedEv, recommendation, notes);
      console.log(`${signalName.padEnd(40)} realN=${list.length} blockedN=${blocked.length} -> ${recommendation}${notes.blockedEv != null ? ` (blockedEv=$${notes.blockedEv.toFixed(2)})` : ''}`);
      if (recommendation === 'GATE') gateCount++; else if (recommendation === 'NO_GATE') noGateCount++; else thinCount++;
    }

    // Pooled fallback for this session -- covers any setup_type too thin to individually qualify.
    const allBlocked = sessionTrades.filter(t => t.is_blocked);
    const allAllowed = sessionTrades.filter(t => !t.is_blocked);
    const { recommendation, notes } = gateVerdict(`_POOLED_ALL_${session}`, allBlocked, allAllowed, { typesContributing: byType.size });
    await writeRow(`_POOLED_ALL_${session}`, allBlocked.length, notes.blockedEv, recommendation, notes);
    console.log(`\n_POOLED_ALL_${session.padEnd(33)} blockedN=${allBlocked.length} -> ${recommendation}${notes.blockedEv != null ? ` (blockedEv=$${notes.blockedEv.toFixed(2)})` : ''}\n`);
  }

  console.log(`\nDone. ${gateCount} GATE, ${noGateCount} NO_GATE, ${thinCount} THIN_N (per-type rows).`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
