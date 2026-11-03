// Roster scoreboard runner (2026-10-25). Prereg: docs/ROSTER_SCOREBOARD_PREREG_20261025.md. Computation: server/services/rosterScoreboard.js.
//
// Daily (run_daily_calibration.sh, right after calibrate_live_roster.mjs). Reads active_setups + the LIVE_ROSTER history, writes ONE
// performance_audit row per day: signal_type='ROSTER_SCOREBOARD' (its own type, never SETUP_STATUS), signal_name='CURRENT', window_days=0
// (rerun overwrites the day). Also refreshes RESEARCH_CLAIM roster_scoreboard_20261025 so the Research Ledger shows the live verdict.
// Read-only consumer: GET /api/setups/roster-scoreboard -> setup-performance.html. Nothing here changes live behaviour.
//
//   node scripts/roster_scoreboard.mjs                run + persist
//   node scripts/roster_scoreboard.mjs --derive       derive + FREEZE the first-look day count from the explore period (once; --force to redo)
//   node scripts/roster_scoreboard.mjs --dry          compute and print, write nothing
import { query } from '../server/db.js';
import { etNaiveTimestampToMs } from '../server/services/acdShared.js';
import { computeScoreboard, deriveFirstLookDays, lookStatus } from '../server/services/rosterScoreboard.js';
import { recordClaim } from './record_claim.mjs';
import { flagDecision, listDecisions } from './flag_decision.mjs';

export const SCOREBOARD_START = '2026-10-25 18:00:00'; // first clean before/after boundary: the 2026-10-25 Globex open
const CLAIM_SLUG = 'roster_scoreboard_20261025';
const SRC = 'docs/ROSTER_SCOREBOARD_PREREG_20261025.md';
// Mandatory filters from the prereg. MARK_TO_MARKET closes are KEPT: this is an account-level scoreboard, and a mark-to-market close is real realized P&L.
export const ROW_FILTER = `origin_status IN ('ACTIVE','SHADOW') AND actual_pnl IS NOT NULL AND resolution IS DISTINCT FROM 'NOT_FILLED'
  AND ib_window_stale_basis IS NOT TRUE AND stale_entry_price_basis IS NOT TRUE AND late_fill_past_expiry_basis IS NOT TRUE AND bad_bars_basis IS NOT TRUE
  AND NOT (fired_at::time >= '16:00' AND fired_at::time < '18:00')`;

export const toRow = (r) => ({ id: r.id, date: r.d, firedMs: etNaiveTimestampToMs(r.fired), resolvedMs: r.resolved ? etNaiveTimestampToMs(r.resolved) : etNaiveTimestampToMs(r.fired),
  setupType: r.setup_type, origin: r.origin_status, pnl: Number(r.actual_pnl), isRth: r.is_rth === true, clusterId: r.cluster_touch_id, isPrimary: r.is_cluster_primary !== false });
export const SELECT = `SELECT id, trade_date::text d, fired_at::text fired, resolved_at::text resolved, setup_type, origin_status, actual_pnl, is_rth, cluster_touch_id, is_cluster_primary FROM active_setups`;

export async function loadRosterHistory() {
  const { rows } = await query(`SELECT created_at::text c, notes FROM performance_audit WHERE signal_type='LIVE_ROSTER' AND signal_name='CURRENT' ORDER BY id`);
  return rows.map((r) => { const n = typeof r.notes === 'string' ? JSON.parse(r.notes) : r.notes; return { createdMs: etNaiveTimestampToMs(r.c), types: (n.roster || []).map((x) => x.type) }; });
}

// Explore period: the 60 trading days before the start, with TODAY's roster types applied (selection-biased for the MEAN, fine for the SD this uses).
async function derive(force) {
  const have = await query(`SELECT 1 FROM performance_audit WHERE signal_type='ROSTER_SCOREBOARD' AND signal_name='PREREG' LIMIT 1`);
  if (have.rows.length && !force) { console.log('PREREG row already frozen; pass --force to redo'); return; }
  const hist = await loadRosterHistory();
  const types = new Set(hist[hist.length - 1].types);
  const { rows } = await query(`${SELECT} WHERE ${ROW_FILTER} AND fired_at < $1 AND fired_at >= ($1::timestamp - interval '90 days') AND setup_type NOT LIKE 'POC_ROTATION_JOIN%' AND is_cluster_primary IS NOT FALSE`, [SCOREBOARD_START]);
  const byDay = new Map();
  for (const r of rows.map(toRow)) { const d = byDay.get(r.date) || { all: 0, roster: 0 }; d.all += r.pnl; if (types.has(r.setupType)) d.roster += r.pnl; byDay.set(r.date, d); }
  const days = [...byDay.keys()].sort().slice(-60);
  const out = deriveFirstLookDays(days.map((d) => byDay.get(d).roster - byDay.get(d).all), days.map((d) => byDay.get(d).all));
  console.log('first-look derivation', out);
  if (!out) throw new Error('could not derive first-look days');
  const notes = { ...out, roster_types_used: [...types], recurrence_days: 10, derived_for_start: SCOREBOARD_START, source: 'scripts/roster_scoreboard.mjs --derive' };
  await query(`INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes) VALUES (CURRENT_DATE, 0, 'ROSTER_SCOREBOARD', 'PREREG', $1, $2)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET notes = EXCLUDED.notes, sample_size = EXCLUDED.sample_size`, [out.days, JSON.stringify(notes)]);
  const back = await query(`SELECT notes FROM performance_audit WHERE signal_type='ROSTER_SCOREBOARD' AND signal_name='PREREG' ORDER BY id DESC LIMIT 1`);
  console.log('frozen (read back):', typeof back.rows[0].notes === 'string' ? back.rows[0].notes.slice(0, 160) : back.rows[0].notes);
}

const money = (v) => (v == null ? 'n/a' : `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}`);
export function claimText(sb, look) {
  const a = sb.arms.ALL, c = sb.comparison;
  return `Roster scoreboard since 2026-10-25 (${sb.window.days} trading days, ${sb.window.from}..${sb.window.to}). VERDICT: ${c.verdict}. ` +
    `Per-day account view, roster-only minus take-all: mean ${money(c.dailyDiff.mean)}/day, day-blocked 95% CI [${money(c.dailyDiff.ci.lo)}, ${money(c.dailyDiff.ci.hi)}], halves ${money(c.dailyDiff.half1)} / ${money(c.dailyDiff.half2)}. ` +
    `Per trade, roster minus the rest: ${money(c.perTrade.diff)} (roster N=${c.perTrade.nRoster}, rest N=${c.perTrade.nRest}), CI [${money(c.perTrade.ci.lo)}, ${money(c.perTrade.ci.hi)}]. ` +
    `Take-all sum ${money(a.TAKE_ALL.sum)} (max drawdown ${money(-a.TAKE_ALL.maxDrawdown)}); roster-would-be sum ${money(a.ROSTER_WOULD_BE.sum)} (max drawdown ${money(-a.ROSTER_WOULD_BE.maxDrawdown)}); actually fired live ${money(a.ROSTER_LIVE.sum)} over ${a.ROSTER_LIVE.n} trades. ` +
    `POC_ROTATION_JOIN is reported separately (N=${sb.separate.POC_ROTATION_JOIN.n}, ${money(sb.separate.POC_ROTATION_JOIN.sum)}). ` +
    `Look status: ${look.due ? `look #${look.lookNumber} due (at ${look.thisLookAt} days)` : `first look at ${look.nextAt} days`}. A null this early is expected; it means not shown yet, not that the idea fails.`;
}

async function run(dry) {
  const pre = await query(`SELECT notes FROM performance_audit WHERE signal_type='ROSTER_SCOREBOARD' AND signal_name='PREREG' ORDER BY id DESC LIMIT 1`);
  const prereg = pre.rows[0] ? (typeof pre.rows[0].notes === 'string' ? JSON.parse(pre.rows[0].notes) : pre.rows[0].notes) : null;
  const hist = await loadRosterHistory();
  const { rows } = await query(`${SELECT} WHERE ${ROW_FILTER} AND fired_at >= $1`, [SCOREBOARD_START]);
  const sb = computeScoreboard(rows.map(toRow), hist);
  const look = lookStatus(sb.window.days, prereg ? prereg.days : null);
  const notes = { ...sb, look, first_look_days: prereg ? prereg.days : null, start: SCOREBOARD_START, roster_now: hist.length ? hist[hist.length - 1].types : [], source: 'scripts/roster_scoreboard.mjs' };
  console.log(claimText(sb, look));
  if (dry) return;
  await query(`INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes) VALUES (CURRENT_DATE, 0, 'ROSTER_SCOREBOARD', 'CURRENT', $1, $2)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET notes = EXCLUDED.notes, sample_size = EXCLUDED.sample_size`, [sb.arms.ALL.TAKE_ALL.n, JSON.stringify(notes)]);
  const back = await query(`SELECT sample_size FROM performance_audit WHERE signal_type='ROSTER_SCOREBOARD' AND signal_name='CURRENT' AND run_date=CURRENT_DATE`);
  if (!back.rows.length || back.rows[0].sample_size !== sb.arms.ALL.TAKE_ALL.n) throw new Error('ROSTER_SCOREBOARD write did not read back');
  await recordClaim({ slug: CLAIM_SLUG, claimText: claimText(sb, look), sourceFile: SRC, sourceDate: '2026-10-25', sampleSize: sb.arms.ALL.TAKE_ALL.n,
    evPerTrade: sb.comparison.perTrade.diff, rigorStatus: 'day_blocked_bootstrap', status: 'PROVISIONAL' });
  if (look.due) {
    const slug = `roster_scoreboard_look_${look.lookNumber}_20261025`;
    const existing = (await listDecisions({ includeResolved: true })).find((d) => d.slug === slug);
    if (!existing) {
      await flagDecision({ slug, sourceFile: SRC, sourceDate: '2026-10-25', priority: 'HIGH',
        decisionText: `Scheduled roster scoreboard look #${look.lookNumber} (${sb.window.days} distinct days). Verdict under the pre-registered rule: ${sb.comparison.verdict}. ${claimText(sb, look)} ` +
          `Resolving this means reading the performance_audit ROSTER_SCOREBOARD row (or setup-performance.html), stating shown / not shown and what could not be shown, and deciding keep the data-derived roster, change the roster rule, or keep collecting. No peeking between looks.` });
      console.log('flagged', slug);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--derive')) return derive(args.includes('--force'));
  return run(args.includes('--dry'));
}
if (import.meta.url === `file://${process.argv[1]}`) main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
