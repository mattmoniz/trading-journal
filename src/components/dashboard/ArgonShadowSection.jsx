import React from 'react';
import NextSteps from './NextSteps.jsx';

// Argon liquidity-vacuum pullback LIVE SHADOW section of the Learning view (2026-11-08, candidate Q4-4, CLAUDE.md cv-110: monitors live in this one page). Fed by the `argonShadow` key of /learning_monitor.json
// (scripts/lib/argonShadowSummary.mjs, refreshed by scripts/argon_vacuum_live/shadow.py every few minutes and by the nightly build; no fetch of its own). Descriptive forward log, places NO orders, NOT a validated edge.
const small = { fontSize: 12, color: '#94a3b8', lineHeight: 1.5 };
const box = { background: 'var(--card-bg)', border: '1px solid var(--border-color, #334155)', borderRadius: 8, padding: 16, marginBottom: 16 };
const pt = (v) => (v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}`);
const outcome = (r) => (r && r.n_out ? `n ${r.n_out} · 10 bars ${pt(r.m10)} · 30 bars ${pt(r.m30)} · 60 bars ${pt(r.m60)} pt · up at 30: ${Math.round(100 * r.up30)}%` : 'no finished outcomes yet');
const Row = ({ k, children }) => <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13, padding: '2px 0' }}><span style={{ color: '#94a3b8' }}>{k}</span><span style={{ textAlign: 'right' }}>{children}</span></div>;

export default function ArgonShadowSection({ board }) {
  const head = <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Argon vacuum pullback (live shadow, no orders)</div>;
  if (!board) return <div style={box}>{head}<div style={{ ...small, color: '#f59e0b' }}>learning_monitor.json has no Argon shadow data yet (it is added by the daemon or the nightly build).</div></div>;
  if (board.state !== 'OK') return <div style={box}>{head}<div style={{ ...small, color: '#f59e0b' }}>Unavailable: {board.error || board.state}</div></div>;
  // the file's own age is added to the heartbeat age: a dead daemon stops refreshing the file, so the light turns red
  const dm = board.daemon; const age = board.generatedAt ? Math.max(0, Math.round((Date.now() - Date.parse(board.generatedAt)) / 1000)) : 0; const hb = dm && dm.heartbeatAgeSec != null ? dm.heartbeatAgeSec + age : null;  const ok = dm && hb != null && hb < 180 && dm.state === 'LIVE';
  const col = ok ? '#22c55e' : (hb != null && hb < 900 ? '#f59e0b' : '#ef4444');
  const F = board.forward || {}; const C = F.cand || {}; const K = F.ffc || {}; const X = board.explore;
  return (
    <div style={box}>
      {head}
      <div style={{ ...small, marginBottom: 10 }}>Watches the live tape for the Argon spec&apos;s pullback-reclaim setup and for its plain fast-flow control. Watch only: no orders, not a validated edge. Outcomes are signed points from the reclaim bar close, before costs (about 2 points all-in per MNQ round trip).</div>
      {dm ? <>
        <Row k="Detector"><b style={{ color: col }}>{dm.state}</b> <span style={{ color: '#94a3b8' }}>heartbeat {hb == null ? 'n/a' : `${hb >= 120 ? `${Math.round(hb / 60)} min` : `${hb} s`} ago`} · session {dm.session}</span></Row>
        <Row k="This session so far">{dm.bars} bars · {dm.rthBars} RTH · <b>{dm.cand}</b> setup fires · {dm.ffc} control fires</Row>
      </> : <Row k="Detector"><span style={{ color: '#ef4444' }}>no heartbeat row yet</span></Row>}
      <Row k={`Forward since ${board.forwardFrom}`}>{F.sessionsFinal || 0} sessions finished{F.sessionsInvalid ? ` · ${F.sessionsInvalid} invalid` : ''}</Row>
      <Row k="Setup fires">{C.n || 0} on {C.days || 0} days</Row>
      <Row k="  outcome (signed pt before cost)">{outcome(C)}</Row>
      <Row k="Control fires">{K.n || 0} on {K.days || 0} days</Row>
      <Row k="  outcome (signed pt before cost)">{outcome(K)}</Row>
      <div style={{ ...small, margin: '8px 0 2px' }}>Latest setup fires</div>
      {(board.recent || []).length === 0 ? <div style={small}>No setup has fired yet in the forward log.</div> : board.recent.map((r, i) => (
        <div key={i} style={{ fontSize: 13, display: 'flex', gap: 10, flexWrap: 'wrap', padding: '2px 0' }}>
          <span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{String(r.d).slice(5)} {r.t}</span><span>{r.direction === 1 ? '▲ long' : '▼ short'}</span><span style={{ fontFamily: 'monospace' }}>@ {Number(r.ref).toFixed(2)}</span>
          <span style={{ color: '#94a3b8' }}>risk {Number(r.risk).toFixed(1)}{r.late > 3 ? ` · late ${Math.round(r.late)} min` : ''}</span><span style={{ fontFamily: 'monospace' }}>{r.f30 == null ? 'open' : `30 bars ${pt(r.f30)} pt`}</span>
        </div>))}
      {(board.alarms || []).length > 0 && <div style={{ ...small, color: '#f59e0b', marginTop: 6 }}>Alarms (3 days): {board.alarms.map((x) => `${x.kind} ×${x.n}`).join(' · ')}</div>}
      {X && <details style={{ marginTop: 8 }}><summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Explore result and power</summary>
        <Row k="Explore count">{X.triggers} setup fires on {X.scoredSessions} sessions · {X.activeDays} active days</Row>
        <Row k="Smallest detectable mean">{pt(X.mdePool)} pt pooled · {pt(X.mdePair)} pt vs control (gate {X.gate} pt)</Row>
        <Row k="Active days needed for the gate">{X.activeDaysNeeded}</Row>
        <div style={{ ...small, color: '#f59e0b' }}>{X.verdict}</div></details>}
      {board.next && <NextSteps n={{ review: board.next.review, ifConfirmed: board.next.ifConfirmed, ifFailed: board.next.ifFailed }} label={null} />}
      <div style={{ ...small, marginTop: 6 }}>{(board.notes || []).join(' ')}</div>
    </div>
  );
}
