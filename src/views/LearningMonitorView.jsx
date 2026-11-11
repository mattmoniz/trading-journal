import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ReferenceLine } from 'recharts';
import { API_URL } from '../constants/api.js';
import DayContextSection from '../components/dashboard/DayContextSection.jsx';
import NextSteps from '../components/dashboard/NextSteps.jsx';
import ArgonShadowSection from '../components/dashboard/ArgonShadowSection.jsx';
import VacuumLiveSection from '../components/dashboard/VacuumLiveSection.jsx';
import CapitulationShadowSection from '../components/dashboard/CapitulationShadowSection.jsx';
import LevelConfluenceSection from '../components/dashboard/LevelConfluenceSection.jsx';
import OvnArmsSection from '../components/dashboard/OvnArmsSection.jsx';
import TellContextSection from '../components/dashboard/TellContextSection.jsx';
import TellShadowSection from '../components/dashboard/TellShadowSection.jsx';
import JobHealthSection from '../components/dashboard/JobHealthSection.jsx';

// Learning Monitor (2026-11-03). Read-only. Shows what the system fires and what it skips, how each arm of the pre-registered roster scoreboard and the
// (log-only) meta-labeler are doing, how much REAL broker evidence exists, the signal-to-order delay, and a virtual prop-account pass race that resets
// after a virtual bust. Data: /learning_monitor.json (scripts/learning_monitor_build.mjs, rebuilt nightly in run_daily_calibration.sh, served from
// public/ so no server file is involved) plus GET /api/setups/monitor-summary for the ML unseen scorecard. All P&L is MODEL P&L unless it says broker.
const C = { blue: '#3b82f6', purple: '#8b5cf6', green: '#22c55e', red: '#ef4444', amber: '#f59e0b', teal: '#14b8a6', muted: '#94a3b8', grid: '#334155' };
const ARM_COLOR = { BOT_SELECTED: C.green, AMT_TELL_STAGE2: C.green, ROSTER_LIVE: C.blue, ROSTER_WOULD_BE: C.teal, TAKE_ALL: C.muted, TAKE_ALL_EX_ROSTER: C.amber, ML_TAKE: C.purple, ML_VETO: C.red };
const ARM_LABEL = { BOT_SELECTED: 'Bot-selected (shadow)', AMT_TELL_STAGE2: 'AMT tell Stage 2 (sim orders)', ROSTER_LIVE: 'Fired live (roster)', ROSTER_WOULD_BE: 'On roster (would fire)', TAKE_ALL: 'Take everything', TAKE_ALL_EX_ROSTER: 'Skipped by roster', ML_TAKE: 'ML says TAKE (log only)', ML_VETO: 'ML says VETO (log only)' };
const money = (v, d = 0) => (v == null ? '--' : `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(d)}`);
const card = { background: 'var(--card-bg)', border: '1px solid var(--border-color, #334155)', borderRadius: 8, padding: 16 };
const small = { fontSize: 12, color: C.muted, lineHeight: 1.5 };

// `next` = [[label, entry]] from the summary's `nextSteps` (server/services/monitorNextSteps.js): when it is judged, and what follows if it holds or fails (CLAUDE.md co-022).
function Card({ title, children, note, next }) {
  const steps = (next || []).filter(([, n]) => n);
  return (<div style={{ ...card, marginBottom: 16 }}>
    <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>{title}</div>
    {note && <div style={{ ...small, marginBottom: 10 }}>{note}</div>}
    {children}
    {steps.map(([label, n]) => <NextSteps key={label} n={n} label={steps.length > 1 ? label : null} />)}
  </div>);
}
function Stat({ label, value, sub, color }) {
  return (<div style={{ ...card, flex: 1, minWidth: 180 }}>
    <div style={{ fontSize: 12, color: C.muted }}>{label}</div>
    <div style={{ fontSize: 22, fontWeight: 700, color: color || 'var(--text-primary)' }}>{value}</div>
    {sub && <div style={{ ...small, marginTop: 4 }}>{sub}</div>}
  </div>);
}
const tip = { contentStyle: { background: '#0f172a', border: '1px solid #334155', fontSize: 12 }, labelStyle: { color: '#e2e8f0' } };
const axis = { stroke: C.muted, tick: { fontSize: 11, fill: C.muted } };

// merge per-arm daily series on the union of dates, carrying the last cumulative value over days an arm had no trades
function mergeCum(series, arms, key) {
  const dates = [...new Set(arms.flatMap((a) => (series[a] || []).map((d) => d.date)))].sort(); const last = {};
  return dates.map((date) => { const row = { date }; arms.forEach((a) => { const hit = (series[a] || []).find((d) => d.date === date); if (hit) last[a] = hit[key]; row[a] = last[a] ?? 0; }); return row; });
}

export default function LearningMonitorView() {
  const [data, setData] = useState(null); const [ms, setMs] = useState(null); const [err, setErr] = useState(null); const [msErr, setMsErr] = useState(null); const [hc, setHc] = useState(true);
  const load = useCallback(() => {
    setErr(null); setMsErr(null);
    fetch(`/learning_monitor.json?t=${Date.now()}`, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(`learning_monitor.json ${r.status}`); return r.json(); }).then(setData).catch((e) => setErr(e.message));
    fetch(`${API_URL}/setups/monitor-summary`, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(`monitor-summary ${r.status}`); return r.json(); }).then(setMs).catch((e) => setMsErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const key = hc ? 'cumHaircut' : 'cum';
  const hasBot = !!data?.series?.BOT_SELECTED;
  const cumArms = useMemo(() => (hasBot ? ['BOT_SELECTED'] : []).concat(['ROSTER_LIVE', 'ROSTER_WOULD_BE', 'TAKE_ALL_EX_ROSTER', 'TAKE_ALL']), [hasBot]);
  const cumRows = useMemo(() => (data ? mergeCum(data.series, cumArms, key) : []), [data, key, cumArms]);
  const tellRows = useMemo(() => (data ? mergeCum(data.series, ['AMT_TELL_STAGE2'], key) : []), [data, key]);
  const mlRows = useMemo(() => (data ? mergeCum(data.series, ['ML_TAKE', 'ML_VETO', 'TAKE_ALL'], key) : []), [data, key]);
  if (err) return <div style={{ padding: 24, color: C.red }}>Learning Monitor data is missing: {err}. Run <code>node scripts/learning_monitor_build.mjs</code> (nightly in run_daily_calibration.sh).</div>;
  if (!data) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading…</div>;

  const fvs = data.firedVsSkipped; const pt = (g) => (hc ? g.perTradeHaircut : g.perTrade);
  const rows = [['firedLive', 'Fired live (roster)', C.blue], ['onRosterNotFiredLive', 'On roster, not fired live', C.teal], ['skippedByRoster', 'Skipped by roster', C.amber], ['mlTake', 'ML TAKE (log only)', C.purple], ['mlVeto', 'ML VETO (log only)', C.red]];
  const sb = data.scoreboard; const ml = ms?.mlUnseen; const age = Math.round((Date.now() - new Date(data.generatedAt).getTime()) / 3600000);

  return (
    <div style={{ padding: 20, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Learning Monitor</h2>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <label style={{ fontSize: 13 }}><input type="checkbox" checked={hc} onChange={(e) => setHc(e.target.checked)} /> after ${data.haircutUsd}/trade slippage allowance (commission is already in model P&L)</label>
          <button onClick={load} style={{ fontSize: 13, padding: '4px 10px' }}>Refresh</button>
        </div>
      </div>
      <div style={{ ...small, margin: '4px 0 14px' }}>Data built {age < 1 ? 'less than an hour' : `${age} h`} ago (rebuilt nightly). All P&L is MODEL P&L from bars unless labelled broker. Window starts {data.scoreboardStart.slice(0, 10)} (the roster-gate boundary).{msErr && <span style={{ color: C.red }}> Live summary unavailable: {msErr}.</span>}</div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Stat label="Scoreboard days" value={`${sb?.days ?? '--'} of ${sb?.firstLookDays ?? '--'}`} sub={`first pre-registered look at ${sb?.firstLookDays ?? '--'} days; verdict so far: ${sb?.verdict ?? 'n/a'}`} />
        <Stat label="Real broker evidence" value={`${data.brokerEvidence.n} trades`} sub={`${data.brokerEvidence.days} days, ${money(data.brokerEvidence.pnl)} broker P&L, simulator account`} color={data.brokerEvidence.days < 30 ? C.amber : undefined} />
        <Stat label="Roster now" value={(sb?.rosterNow || []).length} sub={(sb?.rosterNow || []).join(', ') || 'empty'} />
        <Stat label="Meta-labeler unseen days" value={ml?.latest ? `${ml.latest.unseenDays} of ${ml.daysNeeded}` : '--'} sub={ml?.latest ? `policy minus random ${ml.latest.policyMinusRandom} (CI ${ml.latest.ci?.join(' to ')}), pass: ${String(ml.latest.pass)}` : (msErr ? 'summary unavailable' : (ms ? 'no scorecard' : 'loading…'))} />
      </div>

      <Card next={[['Roster scoreboard', ms?.nextSteps?.scoreboard]]} title="Cumulative P&L by arm" note={`Each line is a set of rules replayed on the same candidate fires. ${hc ? `After a $${data.haircutUsd} per trade slippage allowance (1 tick per fill).` : 'Raw model P&L (commission already subtracted).'} Multi-position: take-everything adds up every row, so it is not what one MNQ could do.`}>
        <ResponsiveContainer width="100%" height={280}><LineChart data={cumRows}><CartesianGrid stroke={C.grid} strokeDasharray="3 3" /><XAxis dataKey="date" {...axis} /><YAxis {...axis} /><Tooltip {...tip} formatter={(v) => money(v)} /><Legend />
          <ReferenceLine y={0} stroke={C.muted} />{cumArms.map((a) => <Line key={a} type="linear" dataKey={a} name={ARM_LABEL[a]} stroke={ARM_COLOR[a]} dot={false} strokeWidth={a === 'ROSTER_LIVE' ? 3 : 2} />)}</LineChart></ResponsiveContainer>
      </Card>

      <Card title="What it fires and what it skips" note="Per day, how many candidate fires there were, how many the roster let through, and how many it skipped. Below: average P&L per trade for each group (small N early, read the count).">
        <ResponsiveContainer width="100%" height={220}><BarChart data={data.perDay}><CartesianGrid stroke={C.grid} strokeDasharray="3 3" /><XAxis dataKey="date" {...axis} /><YAxis {...axis} /><Tooltip {...tip} /><Legend />
          <Bar dataKey="firedLive" name="Fired live" stackId="a" fill={C.blue} /><Bar dataKey="skipped" name="Skipped by roster" stackId="a" fill={C.amber} /></BarChart></ResponsiveContainer>
        <table style={{ width: '100%', fontSize: 13, marginTop: 10, borderCollapse: 'collapse' }}><thead><tr style={{ color: C.muted, textAlign: 'left' }}><th>Group</th><th>Trades</th><th>Per trade</th></tr></thead><tbody>
          {rows.map(([k, label, col]) => <tr key={k}><td style={{ padding: '4px 0', color: col }}>{label}</td><td>{fvs[k].n}</td><td style={{ color: (pt(fvs[k]) ?? 0) < 0 ? C.red : C.green }}>{money(pt(fvs[k]), 2)}</td></tr>)}</tbody></table>
      </Card>

      <Card next={[['Meta-labeler', ms?.nextSteps?.mlUnseen]]} title="Meta-labeler: TAKE vs VETO (log only, nothing is gated)" note="Same candidate fires split by what the meta-labeler said. If it ranked well, TAKE would sit above VETO. Kept only until the unseen scorecard has 20 days or the end-of-December sunset. Full detail in the ML Silo tab.">
        <ResponsiveContainer width="100%" height={240}><LineChart data={mlRows}><CartesianGrid stroke={C.grid} strokeDasharray="3 3" /><XAxis dataKey="date" {...axis} /><YAxis {...axis} /><Tooltip {...tip} formatter={(v) => money(v)} /><Legend /><ReferenceLine y={0} stroke={C.muted} />
          {['ML_TAKE', 'ML_VETO', 'TAKE_ALL'].map((a) => <Line key={a} type="linear" dataKey={a} name={ARM_LABEL[a]} stroke={ARM_COLOR[a]} dot={false} strokeWidth={2} />)}</LineChart></ResponsiveContainer>
      </Card>

      <Card next={[['Learning bot', ms?.nextSteps?.bot], ['AMT tell Stage 2', ms?.nextSteps?.tell], ['Forecast service', ms?.nextSteps?.forecast], ['Regime gauge', ms?.nextSteps?.regime]]} title="Bots" note="Everything that acts or learns on its own, in one place. The learning bot is not running yet; the AMT tell Stage 2 is trading the simulated account now.">
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 300 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.green }}>Learning bot (shadow)</div>
            {data.bot ? (<div style={{ fontSize: 13, lineHeight: 1.7 }}>
              <div>Version {data.bot.latestVersion}{data.bot.frozenAt ? ` (frozen ${data.bot.frozenAt})` : ''}; {data.bot.decisions} decisions on {data.bot.daysLogged} days.</div>
              <div style={{ color: (hc ? data.bot.take.perTradeHaircut : data.bot.take.perTrade) < 0 ? C.red : C.green }}>TAKE: {data.bot.take.n} trades, {money(hc ? data.bot.take.perTradeHaircut : data.bot.take.perTrade, 2)} per trade</div>
              <div style={{ color: (hc ? data.bot.skip.perTradeHaircut : data.bot.skip.perTrade) < 0 ? C.red : C.green }}>SKIP: {data.bot.skip.n} trades, {money(hc ? data.bot.skip.perTradeHaircut : data.bot.skip.perTrade, 2)} per trade (what it avoided, or left on the table)</div>
              {data.bot.calibration.length > 0 && (<div style={small}>Calibration (said / happened, win rate): {data.bot.calibration.map((c) => `${Math.round(c.predicted * 100)}% / ${Math.round(c.observed * 100)}% (${c.n})`).join('; ')}</div>)}
            </div>) : (<div style={small}>Not running yet. When a frozen shadow bot writes its decisions (contract below) its TAKE arm, what it skipped, its calibration and its pass race appear here with no other change.</div>)}
            <div style={{ ...small, marginTop: 8 }}>Contract: {data.botContract}</div>
          </div>
          <div style={{ flex: 1, minWidth: 300 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.green }}>AMT tell Stage 2 (sim account, running)</div>
            <div style={{ fontSize: 13, marginBottom: 6 }}>{ms?.forwardTests?.tell ? `${ms.forwardTests.tell.trades} trades on ${ms.forwardTests.tell.days} days, ${money(ms.forwardTests.tell.pnl, 2)} model P&L; the pre-registered review is at ${ms.forwardTests.tell.floor} trades (rules frozen until then).` : 'loading…'}</div>
            <ResponsiveContainer width="100%" height={140}><LineChart data={tellRows}><CartesianGrid stroke={C.grid} strokeDasharray="3 3" /><XAxis dataKey="date" {...axis} /><YAxis {...axis} /><Tooltip {...tip} formatter={(v) => money(v)} /><ReferenceLine y={0} stroke={C.muted} /><Line type="linear" dataKey="AMT_TELL_STAGE2" name="Tell cumulative" stroke={C.green} strokeWidth={2} /></LineChart></ResponsiveContainer>
            <div style={{ ...small, marginTop: 6 }}>Forecast service: {ms?.forwardTests?.forecast ? `${ms.forwardTests.forecast.points} points over ${ms.forwardTests.forecast.days} of ${ms.forwardTests.forecast.daysNeeded} days needed for a look` : 'loading…'}. Regime gauge: {ms?.forwardTests?.regime ? `${ms.forwardTests.regime.realized} of ${ms.forwardTests.regime.needed} realized outlooks` : 'loading…'}.</div>
          </div>
        </div>
      </Card>

      <JobHealthSection board={ms?.jobHealth} />
      <DayContextSection board={ms?.dayContext} next={ms?.nextSteps?.dayContext} />
      <OvnArmsSection board={ms?.ovnArms} />
      <VacuumLiveSection board={data.vacuumLive} />
      <CapitulationShadowSection board={data.capitulationShadow} />
      <LevelConfluenceSection board={data.levelConfluence} />
      <ArgonShadowSection board={data.argonShadow} />
      <TellContextSection board={ms?.tellContext} next={ms?.nextSteps?.tellContext} />
      <TellShadowSection board={ms?.tellContext} next={ms?.nextSteps?.tellShadow} />
      <Card next={[['Delay', ms?.nextSteps?.delay]]} title="Signal-to-order delay (market entries)" note="Median and 90th percentile seconds from the signal to the order. Realistic assumption 15 s, stress 90 s (docs/FILL_MODEL_SCOPE_20261103.md). Delay costs more than exchange slippage: about 2.9 points of drift at 15 s in regular hours, 5.8 at 60 s.">
        <ResponsiveContainer width="100%" height={220}><LineChart data={data.delay}><CartesianGrid stroke={C.grid} strokeDasharray="3 3" /><XAxis dataKey="date" {...axis} /><YAxis {...axis} /><Tooltip {...tip} /><Legend />
          <ReferenceLine y={15} stroke={C.green} strokeDasharray="4 4" label={{ value: '15 s', fill: C.green, fontSize: 11 }} /><ReferenceLine y={90} stroke={C.red} strokeDasharray="4 4" label={{ value: '90 s', fill: C.red, fontSize: 11 }} />
          <Line type="linear" dataKey="median" name="Median s" stroke={C.blue} strokeWidth={2} /><Line type="linear" dataKey="p90" name="p90 s" stroke={C.amber} strokeWidth={2} /></LineChart></ResponsiveContainer>
      </Card>

      <Card next={[['Pass race', ms?.nextSteps?.passRace]]} title="Pass race (virtual prop account)" note={`Reach +$${data.passTarget} before the $${data.trailLoss} end-of-day trailing loss. A virtual bust is logged as a failed attempt and the account resets, so the learning keeps going. Uses the slippage-adjusted P&L, one arm at a time; daily resolution.`}>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {Object.entries(data.passRace).map(([k, v]) => {
            const passes = v.attempts.filter((a) => a.result === 'PASS').length, busts = v.attempts.length - passes;
            return (<div key={k} style={{ flex: 1, minWidth: 320 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: ARM_COLOR[k] }}>{ARM_LABEL[k]} — attempts {v.attempts.length} (pass {passes}, bust {busts}); now attempt {v.open.episode}: {money(v.open.equity)}, floor {money(v.open.floor)}</div>
              <ResponsiveContainer width="100%" height={180}><LineChart data={v.path}><CartesianGrid stroke={C.grid} strokeDasharray="3 3" /><XAxis dataKey="date" {...axis} /><YAxis {...axis} domain={[-data.trailLoss - 200, data.passTarget + 200]} /><Tooltip {...tip} formatter={(x) => money(x)} />
                <ReferenceLine y={data.passTarget} stroke={C.green} strokeDasharray="4 4" /><Line type="stepAfter" dataKey="floor" name="Floor" stroke={C.red} dot={false} /><Line type="linear" dataKey="equity" name="Equity" stroke={ARM_COLOR[k]} strokeWidth={2} /></LineChart></ResponsiveContainer>
            </div>);
          })}
        </div>
      </Card>

      <Card next={[['Gates', ms?.nextSteps?.gates]]} title="Research gates" note="Which live research gates are on right now (read-only; nothing here changes trading).">
        {ms?.gates ? (<div style={{ fontSize: 13, lineHeight: 1.8 }}>
          <div>Live roster gate: {ms.gates.liveRoster?.state} {ms.gates.liveRoster?.enabled ? '' : '(disabled) '}· {(ms.gates.liveRoster?.types || []).join(', ') || 'none'}{ms.gates.liveRoster?.ageDays != null ? ` · ${ms.gates.liveRoster.ageDays}d old` : ''}</div>
          <div>ML veto gate: {ms.gates.mlVeto ? (ms.gates.mlVeto.enabled ? (ms.gates.mlVeto.enforce ? 'ENFORCING' : 'log-only') : 'disabled') : 'unknown'}</div>
          <div>Breakeven stop (live): {ms.gates.breakevenStopLive ? 'ON' : 'off'} · T1-floor runner shadow: {ms.gates.t1FloorShadow ? 'ON' : 'off'}</div>
          <div>09:31 overnight-levels refresh: {ms.gates.overnightLevelsCron ? `${ms.gates.overnightLevelsCron.status} · ${ms.gates.overnightLevelsCron.t}` : 'no run recorded yet'}</div>
        </div>) : <div style={small}>{msErr ? `summary unavailable: ${msErr}` : 'loading…'}</div>}
      </Card>

      <Card title="Reading notes">
        <ul style={{ ...small, margin: 0, paddingLeft: 18 }}>{data.notes.map((n) => <li key={n}>{n}</li>)}
          <li>Nothing here is a learner yet: the bot-selected arm, the tape model and the hold/slice study are research only (statistical-only results, not level-specific). This page is where a bot arm would be added once a frozen version exists.</li></ul>
      </Card>
    </div>
  );
}
