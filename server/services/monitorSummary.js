// Read-only monitor summary (2026-10-25) behind GET /api/setups/monitor-summary and the quick-check "Monitor" tab (hamburger menu).
// Collects, in one place, the scheduled research gates so they can be watched from the phone / Home Assistant page: roster scoreboard,
// ML unseen-trade scorecard, the forward tests that are still collecting data (forecast, regime gauge, tell Stage 2) and the on/off state of the live research gates. Reads only; changes nothing.
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { query } from '../db.js';
import { getLiveRoster, LIVE_ROSTER_GATE } from './setupEligibility.js';
import { ML_VETO_GATE } from './mlLiveVetoGate.js';
import { BREAKEVEN_STOP_LIVE, T1_FLOOR_SHADOW } from './resolveSetups.js';
import { getTellContextBoard } from './tellContextSummary.js';
import { getDayContextBoard } from './dayContextSummary.js';
import { getOvnArmsBoard } from './ovnArmsSummary.js';
import { buildNextSteps } from './monitorNextSteps.js';
import { FORWARD_FLOORS } from '../config/forwardFloors.js';

const UNSEEN_DAYS_NEEDED = 20;
// Learning Monitor series (2026-11-03): written nightly by scripts/learning_monitor_build.mjs (read-only research data: arms, fired vs skipped, ML verdicts, delay, pass race, bot decisions).
// Served here so quick-check.html's Learning tab (phone / Home Assistant) needs no new route and no new tunnel path.
const LEARNING_FILE = fileURLToPath(new URL('../../public/learning_monitor.json', import.meta.url));
async function learning() {
  try { return { state: 'OK', ...JSON.parse(await readFile(LEARNING_FILE, 'utf8')) }; }
  catch (e) { return { state: e.code === 'ENOENT' ? 'NO_DATA' : 'ERROR', error: e.message }; }
}
const parse = (n) => (typeof n === 'string' ? JSON.parse(n) : n);
const money = (v) => (v == null ? 'n/a' : `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}`);
const safe = async (label, fn) => { try { return await fn(); } catch (e) { return { state: 'ERROR', error: `${label}: ${e.message}` }; } };

async function scoreboard() {
  const r = (await query(`SELECT run_date::text d, notes FROM performance_audit WHERE signal_type='ROSTER_SCOREBOARD' AND signal_name='CURRENT' ORDER BY run_date DESC, id DESC LIMIT 1`)).rows[0];
  if (!r) return { state: 'NO_DATA' };
  const n = parse(r.notes), a = n.arms?.ALL || {}, daysSoFar = Math.max(a.ROSTER_LIVE?.days || 0, a.TAKE_ALL?.days || 0);
  return { state: 'OK', savedOn: r.d, start: n.start, daysSoFar, firstLookDays: n.first_look_days, look: n.look, verdict: n.comparison?.verdict,
    perTradeDiff: n.comparison?.perTrade?.diff ?? null, rosterNow: n.roster_now, arms: Object.fromEntries(Object.entries(a).map(([k, v]) => [k, { n: v.n, days: v.days, sum: v.sum, perTrade: v.perTrade }])),
    poc: n.separate?.POC_ROTATION_JOIN ? { n: n.separate.POC_ROTATION_JOIN.n, perTrade: n.separate.POC_ROTATION_JOIN.perTrade } : null };
}

async function mlUnseen() {
  const rows = (await query(`SELECT run_date::text d, notes FROM performance_audit WHERE signal_type='ML_UNSEEN_SCORECARD' AND signal_name='LATEST' ORDER BY run_date DESC, id DESC LIMIT 4`)).rows;
  const ck = (await query(`SELECT model_version, trained_at::text t, test_auc::float auc FROM ml_models WHERE is_checkpoint LIMIT 1`)).rows[0] || null;
  const runs = rows.map((x) => { const n = parse(x.notes); return { date: x.d, checkpoint: n.checkpoint, unseenDays: n.unseen_days, unseenTrades: n.unseen_trades, policyMinusRandom: n.policy_minus_random, ci: n.policy_minus_random_ci, spearman: n.spearman, spearmanCi: n.spearman_ci, pass: n.pass, bySession: n.by_session || null }; });
  return { state: runs.length ? 'OK' : 'NO_DATA', daysNeeded: UNSEEN_DAYS_NEEDED, checkpoint: ck, latest: runs[0] || null, history: runs };
}

async function forwardTests() {
  const [fp, looks, champ, ro, tell] = await Promise.all([
    query(`SELECT COUNT(*)::int points, COUNT(DISTINCT trade_date)::int days FROM forecast_points`),
    query(`SELECT COUNT(*)::int n FROM research_looks WHERE family='forecast_learning_loop'`),
    query(`SELECT version FROM forecast_models WHERE role='CHAMPION' ORDER BY id DESC LIMIT 1`),
    query(`SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE realized_bucket IS NOT NULL)::int realized, MAX(trade_date)::text last FROM regime_outlook`),
    query(`SELECT COUNT(*)::int n, COUNT(DISTINCT fired_at::date)::int days, COALESCE(SUM(actual_pnl),0)::float pnl FROM active_setups WHERE setup_type IN ('AMT_TELL_LONG','AMT_TELL_SHORT') AND origin_status='ACTIVE' AND status='RESOLVED'`),
  ]);
  const done = looks.rows[0].n;
  return { forecast: { champion: champ.rows[0]?.version || null, points: fp.rows[0].points, days: fp.rows[0].days, looksDone: done, daysNeeded: FORWARD_FLOORS.forecastSpanDays * (done + 2) },
    regime: { outlooks: ro.rows[0].n, realized: ro.rows[0].realized, needed: FORWARD_FLOORS.regimeOutlooks, last: ro.rows[0].last },
    tell: { trades: tell.rows[0].n, days: tell.rows[0].days, pnl: tell.rows[0].pnl, floor: FORWARD_FLOORS.tellTrades, floorDates: FORWARD_FLOORS.tellDates } };
}

async function gates() {
  const roster = await getLiveRoster();
  const cron = (await query(`SELECT status, started_at::text t FROM process_log WHERE process_name='COMPUTE_LEVELS_OVERNIGHT_FINAL' ORDER BY started_at DESC LIMIT 1`)).rows[0] || null;
  return { liveRoster: { enabled: LIVE_ROSTER_GATE.enabled, state: roster.state, types: [...roster.types], runDate: roster.runDate, ageDays: roster.ageDays ?? null },
    mlVeto: { enabled: ML_VETO_GATE.enabled, enforce: ML_VETO_GATE.enforce }, breakevenStopLive: BREAKEVEN_STOP_LIVE.enabled, t1FloorShadow: T1_FLOOR_SHADOW.enabled, overnightLevelsCron: cron };
}

export async function getMonitorSummary() {
  const [sb, un, fw, gt, lm, tc, dc, oa] = await Promise.all([safe('scoreboard', scoreboard), safe('mlUnseen', mlUnseen), safe('forwardTests', forwardTests), safe('gates', gates), learning(), safe('tellContext', getTellContextBoard), safe('dayContext', getDayContextBoard), safe('ovnArms', getOvnArmsBoard)]);
  const L = [];
  L.push(sb.state === 'OK' ? `Roster scoreboard: ${sb.daysSoFar}/${sb.firstLookDays} days to first look; roster ${money(sb.arms?.ROSTER_LIVE?.perTrade)}/trade vs take-all ${money(sb.arms?.TAKE_ALL?.perTrade)}/trade (${sb.verdict})` : `Roster scoreboard: ${sb.state}`);
  L.push(un.state === 'OK' ? `ML unseen scorecard: ${un.latest.unseenDays}/${un.daysNeeded} unseen days, policy-minus-random ${money(un.latest.policyMinusRandom)}, pass=${un.latest.pass}` : `ML unseen scorecard: ${un.state}`);
  L.push(fw.state === 'ERROR' ? 'Forward tests: ERROR' : `Forward tests: forecast ${fw.forecast.days}/${fw.forecast.daysNeeded} days, regime ${fw.regime.realized}/${fw.regime.needed} realized outlooks, tell ${fw.tell.trades}/${fw.tell.floor} trades (${money(fw.tell.pnl)})`);
  if (gt.liveRoster) L.push(`Live roster ${gt.liveRoster.state}: ${gt.liveRoster.types.join(', ') || 'none'}; ML veto ${gt.mlVeto.enforce ? 'ENFORCING' : 'log-only'}; breakeven stop ${gt.breakevenStopLive ? 'ON' : 'off'}`);
  return { generatedAt: new Date().toISOString(), scoreboard: sb, mlUnseen: un, forwardTests: fw, gates: gt, learning: lm, tellContext: tc, dayContext: dc, ovnArms: oa, nextSteps: buildNextSteps({ sb, un, fw, lm }), summary_text: L.join('\n') };
}
