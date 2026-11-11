// Learning Monitor data (2026-11-03). Read-only: writes public/learning_monitor.json for src/views/LearningMonitorView.jsx. Nothing here changes live behaviour.
// Series per arm of the roster scoreboard (docs/ROSTER_SCOREBOARD_PREREG_20261025.md; same rows, same filters, same arm definitions, reused from scripts/roster_scoreboard.mjs and server/services/rosterScoreboard.js),
// the meta-labeler's log-only TAKE/VETO verdicts, signal-to-order delay, the amount of REAL broker evidence, and a virtual prop-account ledger (pass race) that resets after a virtual bust so the
// learning view keeps going. Every P&L here is MODEL P&L (from bars) unless it says broker; the "after haircut" series subtract the standing slippage allowance per trade (commission is already in model P&L) (docs/FILL_MODEL_SCOPE_20261103.md).
//   node scripts/learning_monitor_build.mjs            write public/learning_monitor.json
//   node scripts/learning_monitor_build.mjs --print    print a summary, write nothing
import { argonShadowSummary } from './lib/argonShadowSummary.mjs';
import { vacuumLiveSummary } from './lib/vacuumLiveSummary.mjs';
import { capitulationShadowSummary } from './lib/capitulationShadowSummary.mjs';
import { levelConfluenceSummary } from './lib/levelConfluenceSummary.mjs';
import fs from 'fs';
import { query } from '../server/db.js';
import { buildRosterLookup } from '../server/services/rosterScoreboard.js';
import { SCOREBOARD_START, loadRosterHistory, ROW_FILTER, SELECT, toRow } from './roster_scoreboard.mjs';

export const STANDING_HAIRCUT_USD = 1;           // SLIPPAGE ONLY: 1 tick ($0.50) on each of 2 fills (measured p90 0.75-1.0 tick, claim fill_characterization_ticks_explore_20261103). The $2 commission is ALREADY inside actual_pnl (resolveSetups.js subtracts it on every path), so it is not added again.
export const PASS_TARGET = 3000, TRAIL_LOSS = 2000;   // prop evaluation: +$3,000 target, $2,000 end-of-day trailing max loss from the start (memory reference-prop-account-rules-20261102)
const OUT = new URL('../public/learning_monitor.json', import.meta.url);
const parse = (n) => (typeof n === 'string' ? JSON.parse(n) : n);
const sum = (a) => a.reduce((s, x) => s + x, 0);
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

// Virtual prop-account ledger: daily P&L in date order. Episode equity starts at 0; the floor trails the end-of-day high-water mark by TRAIL_LOSS (starting at -TRAIL_LOSS);
// reaching +PASS_TARGET at the end of a day is a PASS, touching the floor is a BUST; either ends the attempt and a fresh one starts the next day. Returns the daily path and the attempt log.
export function passRace(days, target = PASS_TARGET, trail = TRAIL_LOSS) {
  const path = [], attempts = []; let eq = 0, peak = 0, ep = 1, start = days.length ? days[0].date : null, daysIn = 0;
  for (const d of days) {
    eq += d.pnl; daysIn++;
    const floor = peak - trail; let end = null;
    if (eq >= target) end = 'PASS'; else if (eq <= floor) end = 'BUST';
    path.push({ date: d.date, equity: Math.round(eq * 100) / 100, floor: Math.round(floor * 100) / 100, episode: ep, ended: end });
    if (end) { attempts.push({ episode: ep, result: end, start, end: d.date, days: daysIn, equity: Math.round(eq * 100) / 100 }); eq = 0; peak = 0; ep++; start = null; daysIn = 0; }
    else { peak = Math.max(peak, eq); if (start == null) start = d.date; }
  }
  return { path, attempts, open: { episode: ep, equity: Math.round(eq * 100) / 100, floor: peak - trail, peak, days: daysIn } };
}

// Bootstrap pass probability (Opus review 2026-11-08: judge the system on P(pass), not mean dollars alone). Resamples the arm's own daily P&L in blocks of `block` consecutive days (keeps short-run clustering),
// runs the same virtual account as passRace() (floor trails the end-of-day high-water mark by `trail`, PASS at +target, BUST at the floor) from a fresh start, up to `maxDays` days. END-OF-DAY breach only: an intraday dip below the floor
// also counts on the real rule, so this is OPTIMISTIC about busts. Few source days (see `sourceDays`) make it indicative only. Deterministic seed.
export function passProbability(pnls, { target = PASS_TARGET, trail = TRAIL_LOSS, B = 3000, maxDays = 250, block = 3, seed = 20261108 } = {}) {
  if (!pnls || pnls.length < 10) return { sourceDays: pnls ? pnls.length : 0, state: 'TOO_FEW_DAYS' };
  let sd = seed >>> 0; const rnd = () => { sd = (Math.imul(sd, 1664525) + 1013904223) >>> 0; return sd / 4294967296; };
  let pass = 0, bust = 0; const doneAt = [];
  for (let b = 0; b < B; b++) {
    let eq = 0, peak = 0, day = 0, res = null;
    while (day < maxDays && !res) {
      const i0 = Math.floor(rnd() * pnls.length);
      for (let k = 0; k < block && day < maxDays && !res; k++) {
        eq += pnls[(i0 + k) % pnls.length]; day++;
        if (eq >= target) { res = 'PASS'; } else if (eq <= peak - trail) { res = 'BUST'; } else peak = Math.max(peak, eq);
      }
    }
    if (res === 'PASS') { pass++; doneAt.push(day); } else if (res === 'BUST') { bust++; doneAt.push(day); }
  }
  doneAt.sort((x, y) => x - y);
  return { sourceDays: pnls.length, state: 'OK', pPass: pass / B, pBust: bust / B, pUndecided: 1 - (pass + bust) / B, medianDaysToFinish: doneAt.length ? doneAt[Math.floor(doneAt.length / 2)] : null, B, maxDays, block, breach: 'end-of-day only (optimistic)' };
}

// Bot decisions are written by a (future) shadow bot as performance_audit rows signal_type='BOT_DECISION', signal_name=<active_setups.id>,
// notes = { version, decision: 'TAKE'|'SKIP', p (optional probability the trade works), reason (optional), frozenAt }. The newest row per setup id wins.
export function botSummary(decisions, base, haircut = STANDING_HAIRCUT_USD) {
  if (!decisions.length) return null;
  const last = new Map(); for (const d of decisions) last.set(d.setupId, d);
  const byId = new Map(base.map((r) => [r.id, r])); const joined = [...last.values()].filter((d) => byId.has(d.setupId)).map((d) => ({ ...d, row: byId.get(d.setupId) }));
  const take = joined.filter((d) => d.decision === 'TAKE'), skip = joined.filter((d) => d.decision === 'SKIP');
  const per = (a) => ({ n: a.length, perTrade: a.length ? sum(a.map((d) => d.row.pnl)) / a.length : null, perTradeHaircut: a.length ? sum(a.map((d) => d.row.pnl - haircut)) / a.length : null });
  const withP = joined.filter((d) => typeof d.p === 'number'); const cal = [];
  if (withP.length >= 20) { const s = [...withP].sort((a, b) => a.p - b.p); const k = Math.min(5, Math.floor(s.length / 4)); for (let i = 0; i < k; i++) { const g = s.slice(Math.floor(i * s.length / k), Math.floor((i + 1) * s.length / k)); cal.push({ predicted: sum(g.map((d) => d.p)) / g.length, observed: g.filter((d) => d.row.pnl - haircut > 0).length / g.length, n: g.length }); } }
  const versions = [...new Set(decisions.map((d) => d.version))];
  return { versions, latestVersion: decisions[decisions.length - 1].version, frozenAt: decisions[0].frozenAt || null, decisions: last.size, matchedToResolved: joined.length, take: per(take), skip: per(skip), calibration: cal, daysLogged: new Set(joined.map((d) => d.row.date)).size,
    takeIds: take.map((d) => d.setupId), skipIds: skip.map((d) => d.setupId) };
}

function dailySeries(rows, haircut) {
  const by = new Map();
  for (const r of rows) { const e = by.get(r.date) || { n: 0, pnl: 0 }; e.n++; e.pnl += r.pnl; by.set(r.date, e); }
  return [...by.keys()].sort().map((d) => ({ date: d, n: by.get(d).n, pnl: by.get(d).pnl, pnlHaircut: by.get(d).pnl - haircut * by.get(d).n }));
}
function withCum(days) { let c = 0, h = 0; return days.map((d) => { c += d.pnl; h += d.pnlHaircut; return { ...d, cum: Math.round(c * 100) / 100, cumHaircut: Math.round(h * 100) / 100 }; }); }

async function main() {
  const print = process.argv.includes('--print');
  const hist = await loadRosterHistory(); const lookup = buildRosterLookup(hist);
  const { rows: raw } = await query(`${SELECT} WHERE ${ROW_FILTER} AND fired_at >= $1`, [SCOREBOARD_START]);
  const all = raw.map(toRow);
  const poc = all.filter((r) => r.setupType.startsWith('POC_ROTATION_JOIN'));
  const base = all.filter((r) => !r.setupType.startsWith('POC_ROTATION_JOIN') && r.isPrimary !== false).map((r) => ({ ...r, onRoster: lookup.typesAt(r.firedMs).has(r.setupType) }));
  const ids = base.map((r) => r.id);
  const ml = new Map((await query(`SELECT DISTINCT ON (active_setup_id) active_setup_id id, verdict FROM ml_verdicts WHERE active_setup_id = ANY($1) ORDER BY active_setup_id, scored_at DESC`, [ids])).rows.map((r) => [Number(r.id), r.verdict]));
  const arms = {
    ROSTER_LIVE: base.filter((r) => r.origin === 'ACTIVE'), ROSTER_WOULD_BE: base.filter((r) => r.onRoster), TAKE_ALL: base, TAKE_ALL_EX_ROSTER: base.filter((r) => !r.onRoster),
    ML_TAKE: base.filter((r) => ml.get(r.id) === 'TAKE'), ML_VETO: base.filter((r) => ml.get(r.id) === 'VETO'), POC_ROTATION_JOIN: poc,
    AMT_TELL_STAGE2: all.filter((r) => r.setupType.startsWith('AMT_TELL') && r.origin === 'ACTIVE'),
  };
  const decRows = (await query(`SELECT signal_name, notes FROM performance_audit WHERE signal_type='BOT_DECISION' ORDER BY id`)).rows;
  const decisions = decRows.map((r) => ({ setupId: Number(r.signal_name), ...parse(r.notes) })).filter((d) => Number.isFinite(d.setupId) && (d.decision === 'TAKE' || d.decision === 'SKIP'));
  const bot = botSummary(decisions, base);
  if (bot) { const tk = new Set(bot.takeIds); arms.BOT_SELECTED = base.filter((r) => tk.has(r.id)); }
  const series = Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, withCum(dailySeries(v, STANDING_HAIRCUT_USD))]));
  const allDays = [...new Set(base.map((r) => r.date))].sort();
  const perDay = allDays.map((d) => { const day = base.filter((r) => r.date === d); const live = day.filter((r) => r.origin === 'ACTIVE'), would = day.filter((r) => r.onRoster);
    return { date: d, candidates: day.length, firedLive: live.length, onRoster: would.length, skipped: day.length - would.length, mlTake: day.filter((r) => ml.get(r.id) === 'TAKE').length, mlVeto: day.filter((r) => ml.get(r.id) === 'VETO').length }; });
  const fs_ = (a) => ({ n: a.length, perTrade: a.length ? sum(a.map((r) => r.pnl)) / a.length : null, perTradeHaircut: a.length ? sum(a.map((r) => r.pnl - STANDING_HAIRCUT_USD)) / a.length : null });
  const firedVsSkipped = { firedLive: fs_(arms.ROSTER_LIVE), onRosterNotFiredLive: fs_(arms.ROSTER_WOULD_BE.filter((r) => r.origin !== 'ACTIVE')), skippedByRoster: fs_(arms.TAKE_ALL_EX_ROSTER), mlTake: fs_(arms.ML_TAKE), mlVeto: fs_(arms.ML_VETO), mlUnscored: fs_(base.filter((r) => !ml.has(r.id))) };
  const race = Object.fromEntries(['ROSTER_LIVE', 'ROSTER_WOULD_BE'].map((k) => [k, passRace(series[k].map((d) => ({ date: d.date, pnl: d.pnlHaircut })))]));
  const passProb = Object.fromEntries(['ROSTER_LIVE', 'ROSTER_WOULD_BE'].map((k) => [k, passProbability(series[k].map((d) => d.pnlHaircut))]));
  const dl = (await query(`SELECT o.submitted_at::date::text d, count(*)::int n, percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (o.submitted_at - s.fired_at)))::float med, percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (o.submitted_at - s.fired_at)))::float p90
    FROM order_placements o JOIN active_setups s ON s.id = o.setup_id WHERE o.purpose='ENTRY' AND o.order_type='MARKET' AND o.submitted_at >= '2026-10-05' AND EXTRACT(EPOCH FROM (o.submitted_at - s.fired_at)) BETWEEN 0 AND 3600 GROUP BY 1 ORDER BY 1`)).rows;
  const bk = (await query(`SELECT count(*)::int n, count(DISTINCT fired_at::date)::int days, min(fired_at::date)::text first, max(fired_at::date)::text last, COALESCE(sum(broker_pnl),0)::float pnl FROM active_setups WHERE origin_status='ACTIVE' AND broker_pnl IS NOT NULL`)).rows[0];
  const sbr = (await query(`SELECT notes FROM performance_audit WHERE signal_type='ROSTER_SCOREBOARD' AND signal_name='CURRENT' ORDER BY run_date DESC, id DESC LIMIT 1`)).rows[0];
  const sb = sbr ? parse(sbr.notes) : null;
  const botOut = bot ? { ...bot, takeIds: undefined, skipIds: undefined } : null;
  const out = { generatedAt: new Date().toISOString(), scoreboardStart: SCOREBOARD_START, haircutUsd: STANDING_HAIRCUT_USD, passTarget: PASS_TARGET, trailLoss: TRAIL_LOSS,
    scoreboard: sb ? { verdict: sb.comparison?.verdict, days: sb.window?.days ?? null, firstLookDays: sb.first_look_days, rosterNow: sb.roster_now } : null,
    series, bot: botOut, perDay, firedVsSkipped, passRace: race, passProb, delay: dl.map((r) => ({ date: r.d, n: r.n, median: Math.round(r.med * 10) / 10, p90: Math.round(r.p90 * 10) / 10 })), brokerEvidence: bk,
    botContract: "A shadow bot writes one performance_audit row per candidate: signal_type='BOT_DECISION', signal_name=<active_setups.id>, notes={version, decision:'TAKE'|'SKIP', p?, reason?, frozenAt}. It then appears here automatically as the Bot-selected arm.",
    notes: ['All P&L is MODEL P&L (resolved from bars) except brokerEvidence, which is broker truth on the DTC-Live-Simulator (fills are generous there).', 'Haircut series subtract the standing slippage allowance (1 tick per fill = 1 dollar per round trip; commission is already inside model P&L); the 15 s and 90 s delay lines are the REALISTIC and STRESS delays from docs/FILL_MODEL_SCOPE_20261103.md.', 'The pass-race ledger is daily (end-of-day) and uses the slippage-adjusted P&L of the rows exactly as recorded; the TAKE_ALL arm is multi-position and is NOT used for it.'] };
  out.argonShadow = await argonShadowSummary();
  out.vacuumLive = await vacuumLiveSummary();
  out.capitulationShadow = await capitulationShadowSummary();
  out.levelConfluence = await levelConfluenceSummary();
  try { out.structureModel = JSON.parse(fs.readFileSync(new URL('../public/structure_model.json', import.meta.url).pathname, 'utf8')); } catch (e) { out.structureModel = { state: e.code === 'ENOENT' ? 'NO_DATA' : 'ERROR', error: e.message }; }     // the shadow next-hour range model's history (scripts/structure_model/build_payload.py): a separate file so this build never recomputes it
  if (print) { console.log(JSON.stringify({ days: allDays.length, arms: Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, v.length])), firedVsSkipped, race: Object.fromEntries(Object.entries(race).map(([k, v]) => [k, { attempts: v.attempts.length, open: v.open }])), delay: out.delay.slice(-5), brokerEvidence: bk }, null, 1)); return; }
  fs.mkdirSync(new URL('../public/', import.meta.url), { recursive: true }); fs.writeFileSync(OUT.pathname + '.tmp', JSON.stringify(out)); fs.renameSync(OUT.pathname + '.tmp', OUT.pathname);
  console.log('wrote public/learning_monitor.json', fs.statSync(OUT.pathname).size, 'bytes;', allDays.length, 'days');
}
if (import.meta.url === `file://${process.argv[1]}`) main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
