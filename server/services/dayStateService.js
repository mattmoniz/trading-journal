// Live day-state service (workplan items F2/G). Wraps the pure machine in server/services/dayState.js: keeps a cached, already-evaluated history of the last ~220 sessions per kind
// (rebuilt when a session key rolls over, coalesced so concurrent callers share one build), evaluates ONLY the current session on every poll, and appends each state change to the
// append-only table day_state_log (hr-068). Read-only toward trading: it gates nothing by itself; amtTellOrders.js asks it (G). It must never throw into a caller and never block an
// order on its own failure: every consumer treats a null / stale / error snapshot as "unknown" and behaves as if the feature did not exist.
import { query } from '../db.js';
import { PARAMS, buildSessions, evaluateSession, isLiquidationState, isMeltUpState, isValidSession } from './dayState.js';

const HISTORY_SESSIONS = PARAMS.CUT_N + PARAMS.Z_N + PARAMS.ATR_N + 20;
const SNAPSHOT_TTL_MS = 15_000;
const STALE_MIN = 5;                       // a latest bar older than this during a session means the feed is stale: the snapshot says so and consumers fail open
let hist = null;                           // { sessions: { RTH: [evaluated], GLOBEX: [evaluated] }, lastKey: { RTH, GLOBEX } }
let building = null, snap = { at: 0, min: -1, val: null }, inflight = null, tableMissingLogged = false, refresher = null;

const BAR_SQL = `SELECT to_char(ts,'YYYY-MM-DD HH24:MI') AS t, (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int AS mod, high::float AS high, low::float AS low, close::float AS close
                 FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date AND ts < $2::date ORDER BY ts`;

async function nowEt() {
  const r = await query(`SELECT to_char(NOW() AT TIME ZONE 'America/New_York','YYYY-MM-DD HH24:MI') AS t, CURRENT_DATE::text AS today, (CURRENT_DATE - 360)::text AS from_d, (CURRENT_DATE + 1)::text AS to_d, (CURRENT_DATE - 3)::text AS recent_from`);
  return r.rows[0];
}
function byKind(sessions) { const out = { RTH: [], GLOBEX: [] }; for (const s of sessions) out[s.kind].push(s); return out; }

/** Evaluate the whole history once (oldest to newest) so every session carries the arrays later sessions' baselines need. The newest session of each kind is left out: it is the live one. */
async function buildHistory(clock) {
  const rows = (await query(BAR_SQL, [clock.from_d, clock.to_d])).rows;
  const lists = byKind(buildSessions(rows));
  const sessions = { RTH: [], GLOBEX: [] }, lastKey = { RTH: null, GLOBEX: null }, meta = { RTH: null, GLOBEX: null };
  for (const kind of ['RTH', 'GLOBEX']) {
    const list = lists[kind], done = list.slice(0, -1).filter(isValidSession).slice(-HISTORY_SESSIONS);   // drop short / holiday sessions BEFORE counting, so they can never eat the history needed for the cutoffs
    for (let i = 0; i < done.length; i++) evaluateSession(done[i], done.slice(0, i));
    sessions[kind] = done; lastKey[kind] = list.length ? list[list.length - 1].key : null;
    const finite = done.filter((x) => x.maxima && Number.isFinite(x.maxima.z1d) && Number.isFinite(x.maxima.z1u)).length;
    meta[kind] = { sessions: done.length, finiteMaxima: finite };
    if (finite < PARAMS.Z_MIN + 20) console.error(`[dayState] ${kind} history has only ${finite} sessions with finite maxima (need > ${PARAMS.Z_MIN}): the gate will stay in warm-up. Check price_bars_primary coverage.`);
  }
  return { sessions, lastKey, meta, builtAt: Date.now() };
}

function summarize(res, clock) {
  const n = res.states.length, last = n ? res.states[n - 1] : null;
  let since = null;
  for (let k = n - 1; k >= 0 && res.states[k] === last; k--) since = res.bars[k].t;
  const lastBar = n ? res.bars[n - 1].t : null;
  const ageMin = lastBar ? Math.round((new Date(clock.t.replace(' ', 'T') + ':00Z') - new Date(lastBar.replace(' ', 'T') + ':00Z')) / 60000) : null;
  return { key: res.key, state: last, since, lastBar, ageMin, warmup: !res.cut, liquidation: isLiquidationState(last), meltUp: isMeltUpState(last),
    z: { down: res.z1d[n - 1], up: res.z1u[n - 1] }, cutoffs: res.cut, ibLow: res.ibL, ibHigh: res.ibH };
}

async function logTransitions(res) {
  const rows = [];
  for (let k = 1; k < res.states.length; k++) if (res.states[k] !== res.states[k - 1] && res.states[k] !== 'WARMUP') rows.push(k);
  if (!rows.length) return;
  try {
    for (const k of rows) {
      await query(`INSERT INTO day_state_log (kind, session_key, bar_time, state, prev_state, z1d, z1u, s2d, s2u, close)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
        [res.kind, res.key, res.bars[k].t, res.states[k], res.states[k - 1], res.z1d[k], res.z1u[k], res.s2d[k], res.s2u[k], res.bars[k].close]);
    }
  } catch (e) { if (!tableMissingLogged) { tableMissingLogged = true; console.error('[dayState] day_state_log write failed (table missing or unwritable); states are still served:', e.message); } }
}

async function compute() {
  const clock = await nowEt();
  const recent = byKind(buildSessions((await query(BAR_SQL, [clock.recent_from, clock.to_d])).rows));
  const cur = { RTH: recent.RTH.at(-1) || null, GLOBEX: recent.GLOBEX.at(-1) || null };
  const need = !hist || ['RTH', 'GLOBEX'].some((k) => cur[k] && hist.lastKey[k] !== cur[k].key);
  if (need) { if (!building) building = buildHistory(clock).then((h) => { hist = h; return h; }).finally(() => { building = null; }); await building; }
  const out = { asOf: clock.t, generatedAt: new Date().toISOString(), RTH: null, GLOBEX: null, history: hist.meta };
  for (const kind of ['RTH', 'GLOBEX']) {
    const s = cur[kind]; if (!s) continue;
    const prior = hist.sessions[kind].filter((p) => p.key < s.key);
    const res = evaluateSession(s, prior);
    out[kind] = summarize(res, clock);
    await logTransitions(res);
  }
  return out;
}

/** The snapshot every consumer uses: { asOf, RTH: {state, since, lastBar, ageMin, ...}|null, GLOBEX: ...|null } or { error }. Cached for 15 s; never throws. */
export async function getDayStateSnapshot() {
  const minuteNow = Math.floor(Date.now() / 60000);
  if (snap.val && Date.now() - snap.at < SNAPSHOT_TTL_MS && snap.min === minuteNow) return snap.val;
  if (inflight) return inflight;
  inflight = compute().then((v) => { snap = { at: Date.now(), min: minuteNow, val: v }; return v; }).catch((e) => { const v = { error: e.message, generatedAt: new Date().toISOString() }; snap = { at: Date.now() - SNAPSHOT_TTL_MS + 5000, min: minuteNow, val: v }; return v; }).finally(() => { inflight = null; });
  return inflight;
}
/** For the tell gate: is the RTH session CURRENTLY in a liquidation? Returns { liquidation, state, since, known } and known=false (so the gate does nothing) whenever the data is missing, stale, in warm-up, or
 *  not available within `timeoutMs`: the order loop must never wait on a history rebuild (a session rollover rebuilds for ~5 s). The refresher below keeps the cache warm so a timeout is the exception. */
export async function getRthLiquidation(timeoutMs = 1500) {
  const timeout = new Promise((resolve) => { const t = setTimeout(() => resolve(null), timeoutMs); if (t.unref) t.unref(); });
  const s = await Promise.race([getDayStateSnapshot(), timeout]);
  const r = s && s.RTH;
  if (!r || r.warmup || r.ageMin == null || r.ageMin > STALE_MIN) return { known: false, liquidation: false, state: r?.state ?? null, since: null };
  return { known: true, liquidation: r.liquidation, state: r.state, since: r.since };
}
/** Keeps the history built and the day_state_log written even when nobody has the page open; started with the tell's order loop. Idempotent, unref'd, never throws. */
export function startDayStateRefresher(everyMs = 20_000) {
  if (refresher) return;
  refresher = setInterval(() => { getDayStateSnapshot().catch(() => {}); }, everyMs);
  if (refresher.unref) refresher.unref();
  getDayStateSnapshot().catch(() => {});
}
export { STALE_MIN };
