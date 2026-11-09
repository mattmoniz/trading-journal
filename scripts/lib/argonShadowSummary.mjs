// Summary of the Argon liquidity-vacuum LIVE SHADOW (candidate Q4-4) for the Monitor & Learning page (CLAUDE.md cv-110): phone Monitor tab + app Learning view read it from the `argonShadow` key
// of public/learning_monitor.json. Every figure is derived from argon_vacuum_shadow / _sessions or from the frozen Explore count (scratch/argon_blind_funnel_20261108/summary.json); nothing is typed (hr-019).
// Display only: descriptive forward log, NOT a validated edge. Written by scripts/learning_monitor_build.mjs (nightly) and scripts/argon_vacuum_live/refresh_monitor.mjs (the daemon, intraday).
import fs from 'fs';
import { query } from '../../server/db.js';
export const FORWARD_FROM = '2026-11-09';          // first live shadow session; replay-test days before it are not part of the forward sample
const EXPLORE = new URL('../../scratch/argon_blind_funnel_20261108/summary.json', import.meta.url).pathname;
const f = (x) => (x == null ? null : Number(x));

export async function argonShadowSummary() {
  try {
    const ses = (await query(`SELECT trade_date::text d, state, n_bars, n_rth_bars, n_cand, n_ffc, priors_n, last_tick_at::text last_tick, EXTRACT(EPOCH FROM (NOW()::timestamp - heartbeat_at))::int hb_age, notes FROM argon_vacuum_shadow_sessions ORDER BY trade_date DESC LIMIT 1`)).rows[0] || null;
    const fw = (await query(`SELECT arm, count(*)::int n, count(DISTINCT trade_date)::int days, count(fwd_30)::int n_out, avg(fwd_10)::float m10, avg(fwd_30)::float m30, avg(fwd_60)::float m60, avg(mfe_30)::float mfe, avg(mae_30)::float mae,
      avg(CASE WHEN fwd_30 > 0 THEN 1.0 ELSE 0.0 END) FILTER (WHERE fwd_30 IS NOT NULL)::float up30 FROM argon_vacuum_shadow WHERE trade_date >= $1 GROUP BY arm`, [FORWARD_FROM])).rows;
    const done = (await query(`SELECT count(*)::int n FROM argon_vacuum_shadow_sessions WHERE trade_date >= $1 AND state='FINAL'`, [FORWARD_FROM])).rows[0].n;
    const bad = (await query(`SELECT count(*)::int n FROM argon_vacuum_shadow_sessions WHERE trade_date >= $1 AND state='INVALID'`, [FORWARD_FROM])).rows[0].n;
    const recent = (await query(`SELECT trade_date::text d, to_char(fired_at,'HH24:MI:SS') t, direction, entry_ref::float ref, init_risk_pts::float risk, late_min::float late, fwd_10::float f10, fwd_30::float f30, fwd_60::float f60, mfe_30::float mfe, mae_30::float mae
      FROM argon_vacuum_shadow WHERE arm='CAND' AND trade_date >= $1 ORDER BY fired_at DESC LIMIT 8`, [FORWARD_FROM])).rows;
    const al = (await query(`SELECT kind, count(*)::int n, max(at)::text last FROM argon_vacuum_shadow_alarms WHERE at > NOW() - interval '3 days' GROUP BY kind ORDER BY 3 DESC`)).rows;
    let ex = null; try { ex = JSON.parse(fs.readFileSync(EXPLORE, 'utf8')); } catch { /* count file missing: power block omitted */ }
    const arm = (a) => fw.find((r) => r.arm === a) || { n: 0, days: 0, n_out: 0 };
    const gate = ex?.gates?.mde_pool?.[1] ?? null, needDays = ex && gate ? Math.ceil(ex.gates.active_days[0] * Math.pow(ex.mde_pool / gate, 2)) : null;
    return { state: 'OK', generatedAt: new Date().toISOString(), forwardFrom: FORWARD_FROM,
      daemon: ses ? { session: ses.d, state: ses.state, heartbeatAgeSec: ses.hb_age, bars: ses.n_bars, rthBars: ses.n_rth_bars, cand: ses.n_cand, ffc: ses.n_ffc, priors: ses.priors_n, lastTick: ses.last_tick } : null,
      forward: { sessionsFinal: done, sessionsInvalid: bad, cand: arm('CAND'), ffc: arm('FFC') },
      recent, alarms: al,
      explore: ex ? { scoredSessions: ex.scored_sessions, triggers: ex.triggers, activeDays: ex.active_days, mdePool: ex.mde_pool, mdePair: ex.mde_pair, gate, activeDaysNeeded: needDays, verdict: ex.verdict } : null,
      next: { review: 'No edge look yet. This log is descriptive. A forward look needs its own pre-registration that states the number of active forward days first (the Explore count needed about ' + (needDays ?? 'n/a') + ' active days for the pooled test; the log adds about ' + (ex ? (ex.active_days / ex.scored_sessions).toFixed(2) : 'n/a') + ' per session).',
        ifConfirmed: 'If a pre-registered forward look shows the setup beats its own control (FFC) by more than the cost, write the Stage 4a prereg and run it.',
        ifFailed: 'If it does not, the idea stays PARKED (never retired on this log alone, CLAUDE.md co-025); reopen on a Globex 100-contract extract, a longer-hold variant or a cheaper cost basis.' },
      notes: ['Shadow only: places no orders. CAND = the Argon pullback-reclaim setup, FFC = its fast-flow control (fires about 30 times a session).', 'Outcomes are signed points from the reclaim bar close, before costs (about 2.0 pt all-in per MNQ round trip), filled once after the session.'] };
  } catch (e) { return { state: 'ERROR', error: e.message }; }
}
