// Daily recheck for the opening-drive counter-trade gate (server/services/openingDriveGate.js).
// Reuses the service's own pure functions (sessionMoveSoFar/buildBaseline/
// classifyOpeningDriveCounter) so the tested logic and the live logic cannot drift.
//
// Two sections, deliberately separate (freeze + pre-registered single look, per CLAUDE.md's
// optional-stopping convention -- this script NEVER changes the live percentile):
//  1. RETROSPECTIVE (since RETRO_START): informational drift tracking of the frozen P.
//  2. PROSPECTIVE (fired after FREEZE_DATE, when the gate went live): the only population that
//     counts as independent evidence. Pre-registered look: once it has >= PROSPECTIVE_MIN_DAYS
//     distinct affected days, check whether the blocked set's day-blocked mean EV CI is below 0.
// Blocked rows are force-SHADOW'd live, so they still resolve and keep producing actual_pnl.
import { query } from '../server/db.js';
import { resolveDirection } from '../server/config/setupTypes.js';
import { dayBlockedBootstrapCI } from '../server/services/rigorDiagnostics.js';
import { OPENING_DRIVE_GATE, sessionMoveSoFar, buildBaseline, classifyOpeningDriveCounter } from '../server/services/openingDriveGate.js';
import { recordClaim } from './record_claim.mjs';

const RETRO_START = '2026-07-09';
const FREEZE_DATE = '2026-09-25';
const PROSPECTIVE_MIN_DAYS = 20;

async function main() {
  const tr = (await query(`
    SELECT id, setup_type, trade_date::text d, to_char(fired_at,'HH24:MI') hm, origin_status, suppression_reason,
      actual_pnl::float pnl, stop_level::float stop_level, t1_level::float t1_level
    FROM active_setups
    WHERE trade_date >= $1::date AND actual_pnl IS NOT NULL AND origin_status IN ('ACTIVE','SHADOW')
      AND (is_cluster_primary IS NULL OR is_cluster_primary = true)
      AND fired_at::time >= '09:31' AND fired_at::time < '10:00'
    ORDER BY fired_at`, [RETRO_START])).rows;
  const bars = (await query(`
    SELECT ts::date::text d, to_char(ts,'HH24:MI') hm, open::float o, close::float c
    FROM price_bars_primary
    WHERE symbol='NQ' AND ts >= ($1::date - 45) AND ts < CURRENT_DATE + 1
      AND ts::time >= '09:30' AND ts::time < '10:00'
    ORDER BY ts`, [RETRO_START])).rows;
  const byDay = new Map();
  for (const b of bars) { if (!byDay.has(b.d)) byDay.set(b.d, []); byDay.get(b.d).push(b); }
  const days = [...byDay.keys()].sort();
  const moves = new Map(days.map(d => [d, sessionMoveSoFar(byDay.get(d))]));

  const classified = [];
  for (const t of tr) {
    const dir = resolveDirection(t); if (!dir) continue;
    const i = days.indexOf(t.d); const today = moves.get(t.d); if (i < 0 || !today) continue;
    const prior = days.slice(0, i).map(d => moves.get(d)).filter(Boolean).slice(-OPENING_DRIVE_GATE.LOOKBACK_SESSIONS);
    const [h, m] = t.hm.split(':').map(Number); const etMin = h * 60 + m;
    const r = classifyOpeningDriveCounter({ direction: dir, etMin, moveSoFar: today[etMin - 1 - OPENING_DRIVE_GATE.OPEN_MIN], baseline: buildBaseline(prior) });
    if (r.applies) classified.push({ ...t, dir, ...r });
  }

  const summarize = (pop, label) => {
    const blocked = pop.filter(t => t.blocked), withStrong = pop.filter(t => t.strong && !t.against);
    const ev = a => a.length ? a.reduce((s, t) => s + t.pnl, 0) / a.length : null;
    const ci = blocked.length ? dayBlockedBootstrapCI(blocked.map(t => ({ date: t.d, pnl: t.pnl })), `odg_${label}`) : null;
    const out = {
      label, classified: pop.length, blockedN: blocked.length, blockedEv: ev(blocked), blockedDays: new Set(blocked.map(t => t.d)).size,
      blockedCi: ci, withStrongN: withStrong.length, withStrongEv: ev(withStrong),
      longN: blocked.filter(t => t.dir === 'LONG').length, longEv: ev(blocked.filter(t => t.dir === 'LONG')),
      shortN: blocked.filter(t => t.dir === 'SHORT').length, shortEv: ev(blocked.filter(t => t.dir === 'SHORT')),
      activeBlockedN: blocked.filter(t => t.origin_status === 'ACTIVE').length,
    };
    console.log(`${label}: classified N=${out.classified} | BLOCKED N=${out.blockedN} EV=$${out.blockedEv?.toFixed(2)} days=${out.blockedDays} CI[${ci?.lo?.toFixed(2)}, ${ci?.hi?.toFixed(2)}] (LONG ${out.longN} $${out.longEv?.toFixed(2)} / SHORT ${out.shortN} $${out.shortEv?.toFixed(2)}, ACTIVE ${out.activeBlockedN}) | WITH-strong control N=${out.withStrongN} EV=$${out.withStrongEv?.toFixed(2)}`);
    return out;
  };
  const retro = summarize(classified.filter(t => t.d < FREEZE_DATE), 'RETROSPECTIVE');
  const pro = summarize(classified.filter(t => t.d >= FREEZE_DATE), 'PROSPECTIVE');
  const lookReady = pro.blockedDays >= PROSPECTIVE_MIN_DAYS;
  const verdict = !lookReady ? `ACCUMULATING (${pro.blockedDays}/${PROSPECTIVE_MIN_DAYS} distinct prospective days)`
    : (pro.blockedCi && pro.blockedCi.hi < 0 ? 'PROSPECTIVE_CONFIRMED' : 'PROSPECTIVE_NOT_CONFIRMED');
  console.log(`Pre-registered prospective look: ${verdict}`);

  const f = x => x == null ? 'n/a' : `$${x.toFixed(2)}`;
  await recordClaim({
    slug: 'opening_drive_counter_trade_20260925',
    claimText: `Opening-drive counter-trade gate (server/services/openingDriveGate.js, LIVE force-SHADOW since ${FREEZE_DATE}, frozen P=${OPENING_DRIVE_GATE.PERCENTILE}): during 9:31-10:00 ET, a candidate whose direction opposes a move-so-far >= the p${OPENING_DRIVE_GATE.PERCENTILE * 100} of the prior ${OPENING_DRIVE_GATE.LOOKBACK_SESSIONS} sessions' |move-so-far| at the same minute is forced SHADOW. Auto-rechecked by scripts/recheck_opening_drive_gate.mjs (daily). RETROSPECTIVE (${RETRO_START} to ${FREEZE_DATE}, informational -- the population the rule was derived from): blocked N=${retro.blockedN} EV=${f(retro.blockedEv)} over ${retro.blockedDays} days, day-blocked EV CI [${retro.blockedCi?.lo?.toFixed(2)}, ${retro.blockedCi?.hi?.toFixed(2)}]; LONG N=${retro.longN} EV=${f(retro.longEv)}, SHORT N=${retro.shortN} EV=${f(retro.shortEv)}; ACTIVE-origin blocked N=${retro.activeBlockedN}; same-strength WITH-drive control N=${retro.withStrongN} EV=${f(retro.withStrongEv)}. PROSPECTIVE (post-freeze, the only independent evidence): blocked N=${pro.blockedN} EV=${f(pro.blockedEv)} over ${pro.blockedDays} days. Pre-registered look at >=${PROSPECTIVE_MIN_DAYS} distinct prospective affected days: ${verdict}. P is never changed by this script. Globex analog tested flat (not wired). See OPEN_DECISION opening_drive_gate_6week_revisit_20260925.`,
    sourceFile: 'scripts/recheck_opening_drive_gate.mjs',
    sourceDate: FREEZE_DATE,
    sampleSize: retro.blockedN + pro.blockedN,
    winRate: null,
    evPerTrade: retro.blockedEv,
    rigorStatus: lookReady ? verdict.toLowerCase() : 'frozen_p_accumulating_prospective_days',
    status: 'PROVISIONAL',
  });
  console.log('Claim recorded.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
