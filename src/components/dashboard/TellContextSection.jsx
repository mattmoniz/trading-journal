import React from 'react';
import NextSteps from './NextSteps.jsx';

// Tell context section of the Learning view (2026-11-03). Where each live tell fire sat in the developing RTH value area when it fired, and how the fires of each label did, from the forward log
// tell_context_fires (scripts/tell_context/reader.py) via the `tellContext` key of GET /api/setups/monitor-summary. Display and learning only: the label is NOT VALIDATED and gates nothing.
// Data comes from the parent (no fetch here) so the view's one poll serves it. A missing or failed feed renders an explicit notice, never an empty card. Model P&L per closed V1 fire, no slippage.
const COL = { AGREES: '#22c55e', AGAINST: '#ef4444', NEUTRAL: '#94a3b8', UNKNOWN: '#64748b' };
const LABELS = ['AGREES', 'AGAINST', 'NEUTRAL', 'UNKNOWN'];
const money = (v) => (v == null ? '--' : `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}`);
const small = { fontSize: 12, color: '#94a3b8', lineHeight: 1.5 };
const box = { background: 'var(--card-bg)', border: '1px solid var(--border-color, #334155)', borderRadius: 8, padding: 16, marginBottom: 16 };

export default function TellContextSection({ board, next }) {
  const head = <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Tell context (forward log, not validated)</div>;
  if (!board || board.state !== 'OK') {
    return (<div style={box}>{head}<div style={{ ...small, color: '#f59e0b' }}>{!board ? 'The summary has no tell-context data yet (the server needs a restart to serve it).' : `Unavailable: ${board.error || board.state}.`}</div></div>);
  }
  const { byLabel = {}, span = {}, reader = {}, recent = [], notes = [], minN, missing = [] } = board;
  const missingN = missing.reduce((a, m) => a + m.n, 0);
  return (
    <div style={box}>
      {head}
      <div style={{ ...small, marginBottom: 10 }}>Where each tell fire sat in the developing RTH value area when it fired, and how the fires of each label did. Display and learning only: it gates nothing.</div>
      <div style={{ ...small, marginBottom: 8 }}>
        {span.rows || 0} fires logged on {span.days || 0} day{span.days === 1 ? '' : 's'}{span.backfilled ? ` (${span.backfilled} backfilled)` : ''} · reader{' '}
        {reader.problem ? <span style={{ color: '#f59e0b' }}>{reader.problem}</span> : (reader.childAlive ? `running${reader.session ? ` (${reader.session})` : ''}` : 'not running')}
      </div>
      {missingN > 0 && <div style={{ ...small, color: '#f59e0b', marginBottom: 8 }}>{missingN} fire(s) in the last 7 days have no context row ({missing.map((m) => `${m.d}: ${m.n}`).join(', ')}). Recover with reader.py --once-date.</div>}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 10 }}>
        <thead><tr style={{ color: '#94a3b8', textAlign: 'left' }}><th>Label</th><th>Fires</th><th>Closed</th><th>Wins</th><th>Broke range</th><th>Per trade</th></tr></thead>
        <tbody>
          {LABELS.map((k) => { const x = byLabel[k] || {}; return (
            <tr key={k} style={{ borderTop: '1px solid #334155' }}>
              <td style={{ color: COL[k], fontWeight: 600 }}>{k}</td><td>{x.n ?? 0}</td><td>{x.closed ?? 0}</td><td>{x.wins ?? 0}</td><td>{x.broke ?? 0}</td>
              <td style={{ color: x.perTrade == null ? undefined : (x.perTrade < 0 ? '#ef4444' : '#22c55e') }}>{money(x.perTrade)}{x.belowFloor ? <span style={{ color: '#94a3b8' }}> (N&lt;{minN}, no result)</span> : null}</td>
            </tr>); })}
        </tbody>
      </table>
      <div style={{ marginBottom: 8 }}>
        {recent.slice(0, 8).map((r) => (
          <div key={r.id} style={{ fontSize: 12, display: 'flex', gap: 10, padding: '2px 0' }}>
            <span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{String(r.fired_at).slice(5, 16)}</span>
            <span>{r.direction === 1 ? '▲' : '▼'}</span>
            <span style={{ color: COL[r.label] }}>{r.label}</span>
            <span style={{ color: '#94a3b8' }}>{r.tail === 'INSIDE' ? (r.location != null ? `${Math.round(r.location * 100)}% of value` : 'inside') : r.tail}</span>
            <span style={{ marginLeft: 'auto', color: r.net == null ? undefined : (r.net < 0 ? '#ef4444' : '#22c55e') }}>{r.status === 'OPEN' ? 'open' : money(r.net)}</span>
          </div>))}
      </div>
      <div style={small}>{notes.map((n, i) => <div key={i}>{n}</div>)}</div>
      <NextSteps n={next} />
    </div>
  );
}
