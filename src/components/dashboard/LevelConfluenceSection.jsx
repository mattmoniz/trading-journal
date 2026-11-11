import React from 'react';
import NextSteps from './NextSteps.jsx';

// Level-confluence TAG logger section of the Learning view (2026-11-09, register row 33, CLAUDE.md cv-110). Fed by the `levelConfluence` key of /learning_monitor.json (scripts/lib/levelConfluenceSummary.mjs, nightly build; no fetch of its own). Display only: no orders, no setup change.
const small = { fontSize: 12, color: '#94a3b8', lineHeight: 1.5 };
const box = { background: 'var(--card-bg)', border: '1px solid var(--border-color, #334155)', borderRadius: 8, padding: 16, marginBottom: 16 };
const Row = ({ k, children }) => <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13, padding: '2px 0' }}><span style={{ color: '#94a3b8' }}>{k}</span><span style={{ textAlign: 'right' }}>{children}</span></div>;
const NAMES = { TELL: 'AMT tell', VACUUM: 'Vacuum onsets', TURN: 'Turn signal' };

export default function LevelConfluenceSection({ board }) {
  const head = <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Level confluence tags (market setups, no orders)</div>;
  if (!board) return <div style={box}>{head}<div style={{ ...small, color: '#f59e0b' }}>learning_monitor.json has no level-confluence data yet (it fills at the nightly build).</div></div>;
  if (board.state !== 'OK') return <div style={box}>{head}<div style={{ ...small, color: '#f59e0b' }}>Unavailable: {board.error || board.state}</div></div>;
  return (
    <div style={box}>
      {head}
      <div style={{ ...small, marginBottom: 10 }}>{board.rule}</div>
      <div style={{ ...small, margin: '8px 0 2px' }}>Tagged fires (floor {board.floor} independent per setup before any contrast)</div>
      {(board.setups || []).map((s) => <Row key={s.setup} k={NAMES[s.setup] || s.setup}><b>{s.n}</b> of {board.floor} fires · {s.days} days · {s.defended} at a defended level · {s.fresh_break} just broke a level{s.ahead_med != null ? ` · median level ahead ${s.ahead_med.toFixed(2)} ADR20` : ''}</Row>)}
      <div style={{ ...small, margin: '8px 0 2px' }}>Latest tags</div>
      {(board.recent || []).map((r, i) => <div key={i} style={{ fontSize: 13, display: 'flex', gap: 10, flexWrap: 'wrap', padding: '2px 0' }}><span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{r.t}</span><span>{r.d === 1 ? '▲ long' : '▼ short'}</span><span>{NAMES[r.setup] || r.setup}</span><span style={{ color: '#94a3b8' }}>ahead {r.ahead_name || 'none'}{r.ahead != null ? ` ${r.ahead} ADR20` : ''} · nearest {r.any_name || 'none'}{r.anyd != null ? ` ${r.anyd}` : ''}{r.defended ? ' · defended' : ''}</span></div>)}
      {board.next && <NextSteps n={{ review: board.next.review, ifConfirmed: board.next.ifConfirmed, ifFailed: board.next.ifFailed }} label={null} />}
      <div style={{ ...small, marginTop: 6 }}>{(board.notes || []).join(' ')}</div>
    </div>
  );
}
