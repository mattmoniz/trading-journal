import React from 'react';
import NextSteps from './NextSteps.jsx';

// Capitulation-exit overlay FORWARD SHADOW section of the Learning view (2026-11-09, register row 30, CLAUDE.md cv-110). Fed by the `capitulationShadow` key of /learning_monitor.json (scripts/lib/capitulationShadowSummary.mjs,
// nightly build; no fetch of its own). Shadow only: no orders, no setup change.
const small = { fontSize: 12, color: '#94a3b8', lineHeight: 1.5 };
const box = { background: 'var(--card-bg)', border: '1px solid var(--border-color, #334155)', borderRadius: 8, padding: 16, marginBottom: 16 };
const usd = (v) => (v == null ? 'n/a' : `${v >= 0 ? '+$' : '-$'}${Math.abs(Number(v)).toFixed(0)}`);
const Row = ({ k, children }) => <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13, padding: '2px 0' }}><span style={{ color: '#94a3b8' }}>{k}</span><span style={{ textAlign: 'right' }}>{children}</span></div>;
const Progress = ({ label, p }) => <Row k={label}><b>{p.events}</b> of {p.floorEvents} events · {p.days} of {p.floorDays} days{p.events ? <> · mean (virtual minus actual) {usd(p.meanDelta)} <span style={{ color: '#94a3b8' }}>(no verdict below the floor)</span></> : null}</Row>;

export default function CapitulationShadowSection({ board }) {
  const head = <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Capitulation exit overlay (forward shadow, no orders)</div>;
  if (!board) return <div style={box}>{head}<div style={{ ...small, color: '#f59e0b' }}>learning_monitor.json has no overlay data yet (it fills at the nightly build).</div></div>;
  if (board.state !== 'OK') return <div style={box}>{head}<div style={{ ...small, color: '#f59e0b' }}>Unavailable: {board.error || board.state}</div></div>;
  const t = board.totals || {}; const age = t.age_sec == null ? null : t.age_sec + Math.max(0, Math.round((Date.now() - Date.parse(board.generatedAt)) / 1000)); const col = age != null && age < 36 * 3600 ? '#22c55e' : '#f59e0b';
  return (
    <div style={box}>
      {head}
      <div style={{ ...small, marginBottom: 10 }}>{board.rule}</div>
      <Row k="Logger"><b style={{ color: col }}>{age == null ? 'no rows' : `${age >= 7200 ? `${Math.round(age / 3600)} h` : `${Math.round(age / 60)} min`} since the last update`}</b> <span style={{ color: '#94a3b8' }}>nightly + on demand</span></Row>
      <Row k={`Forward since ${board.forwardFrom}`}>{t.fwd || 0} setup rows · {t.sig || 0} signalled · {t.open_fwd || 0} still open</Row>
      <Row k="Tags (forward)">{t.atb || 0} at a boundary · {t.piv || 0} at a defended pivot · {t.near || 0} near (secondary)</Row>
      <div style={{ ...small, margin: '8px 0 2px' }}>Progress to the floor</div>
      <Progress label="Test 1: at a boundary" p={board.c1 || {}} />
      <Progress label="Test 2: at a defended pivot" p={board.c2 || {}} />
      <Progress label="Test 3: failed sweep reversal (own family)" p={board.c3 || {}} />
      <Progress label="Replace-the-target F1: RTH boundary rows, hold to capitulation vs hold to expiry" p={board.c4 || {}} />
      <div style={{ ...small, margin: '8px 0 2px' }}>Latest signalled rows</div>
      {(board.recent || []).length === 0 ? <div style={small}>No signalled row yet.</div> : board.recent.map((r) => (
        <div key={r.setup_id} style={{ fontSize: 13, display: 'flex', gap: 10, flexWrap: 'wrap', padding: '2px 0' }}>
          <span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{r.t}</span><span>{r.side === 1 ? '▲ long' : '▼ short'}</span><span>{r.setup_type}</span>
          <span style={{ color: '#94a3b8' }}>{r.forward ? 'forward' : 'retro'}{r.at_boundary ? ' · boundary' : ''}{r.pivot_live ? ' · pivot' : ''}</span><span>actual {usd(r.actual)} · virtual {usd(r.virt)}</span>
        </div>))}
      {board.next && <NextSteps n={{ review: board.next.review, ifConfirmed: board.next.ifConfirmed, ifFailed: board.next.ifFailed }} label={null} />}
      <div style={{ ...small, marginTop: 6 }}>{(board.notes || []).join(' ')}</div>
    </div>
  );
}
