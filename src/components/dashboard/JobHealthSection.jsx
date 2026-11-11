import React from 'react';

// Scheduled-job health + de-duplicated alert digest (Fable audit F07/F08, 2026-11-10, CLAUDE.md cv-110: a section of the one Monitor & Learning page).
// Fed by `jobHealth` in /api/setups/monitor-summary (server/services/jobHealth.js: process_log latest-run-per-job and a grouped tail of scratch/gemini_alerts.txt).
const small = { fontSize: 12, color: '#94a3b8', lineHeight: 1.5 };
const box = { background: 'var(--card-bg)', border: '1px solid var(--border-color, #334155)', borderRadius: 8, padding: 16, marginBottom: 16 };
const Row = ({ k, children }) => <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13, padding: '2px 0' }}><span style={{ color: '#94a3b8' }}>{k}</span><span style={{ textAlign: 'right' }}>{children}</span></div>;

export default function JobHealthSection({ board }) {
  const head = <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Scheduled jobs and alerts</div>;
  if (!board) return <div style={box}>{head}<div style={{ ...small, color: '#f59e0b' }}>The monitor summary has no job-health data yet.</div></div>;
  if (board.state !== 'OK') return <div style={box}>{head}<div style={{ ...small, color: '#f59e0b' }}>Unavailable: {board.error || board.state}</div></div>;
  const bad = board.failing.length + board.stuck.length;
  const al = board.alerts;
  return (
    <div style={box}>
      {head}
      <div style={{ ...small, marginBottom: 8 }}>Newest run of every scheduled job in the last 14 days (process_log), and the alert file grouped so a repeated warning shows once with a count.</div>
      <Row k="Jobs tracked">{board.jobsTracked} · <b style={{ color: bad ? '#ef4444' : '#22c55e' }}>{bad ? `${bad} need attention` : 'all healthy'}</b></Row>
      {board.roster && board.roster.gateEnabled && board.roster.state !== 'OK' && (
        <div style={{ fontSize: 13, padding: '4px 0', borderTop: '1px solid var(--border-color, #334155)' }}>
          <b style={{ color: '#ef4444' }}>Live roster {board.roster.state}</b>: {board.roster.state === 'EMPTY' ? 'the calibration ran and chose no setup type' : 'the calibration did not produce a current roster'}; every entry fails closed to SHADOW until it does (last run {board.roster.runDate || 'never'}).
        </div>)}
      {board.failing.map((j) => (
        <div key={j.name} style={{ fontSize: 13, padding: '4px 0', borderTop: '1px solid var(--border-color, #334155)' }}>
          <b style={{ color: '#ef4444' }}>{j.name}</b> failed {j.consecutiveFailures} run{j.consecutiveFailures === 1 ? '' : 's'} in a row (last {j.latestAt}; last success {j.lastSuccessAt || 'none in 14 days'})
          {j.lastError && <div style={small}>{j.lastError}</div>}
        </div>))}
      {board.stuck.map((j) => (
        <div key={j.name} style={{ fontSize: 13, padding: '4px 0', borderTop: '1px solid var(--border-color, #334155)' }}>
          <b style={{ color: '#f59e0b' }}>{j.name}</b> started {j.latestAt} and never finished (a restart killed it, or it hung)
        </div>))}
      <div style={{ ...small, margin: '10px 0 2px' }}>Alerts (last {al && al.windowBytes ? Math.round(al.windowBytes / 1048576) : 0} MB of the alert file{al && al.fileBytes ? `, file ${Math.round(al.fileBytes / 1048576)} MB` : ''})</div>
      {!al || al.state !== 'OK' ? <div style={{ ...small, color: '#f59e0b' }}>Unavailable: {al ? (al.error || al.state) : 'no data'}</div> : <>
        <div style={small}>{al.lines} lines are only {al.distinct} different warnings; the most repeated:</div>
        {al.groups.slice(0, 6).map((g, i) => (
          <div key={i} style={{ fontSize: 12.5, padding: '3px 0', lineHeight: 1.45 }}>
            <b>{g.count}x</b> <span style={{ color: '#94a3b8' }}>[{g.tag}] {g.firstAt === g.lastAt ? g.lastAt : `${g.firstAt} to ${g.lastAt}`}</span><div style={small}>{g.sample}</div>
          </div>))}
      </>}
      {board.nextSteps && <div style={{ ...small, marginTop: 8 }}><b>Next:</b> {board.nextSteps.review}<br /><b>If it holds:</b> {board.nextSteps.ifConfirmed}<br /><b>If it fails:</b> {board.nextSteps.ifFailed}</div>}
    </div>
  );
}
