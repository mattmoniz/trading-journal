import React from 'react';
import NextSteps from './NextSteps.jsx';

// LIVE expansion-rule section of the Learning view (2026-11-09, the user's ORIGINAL idea, candidate Q4-5, CLAUDE.md cv-110). Fed by the `vacuumLive` key of /learning_monitor.json (scripts/lib/vacuumLiveSummary.mjs, refreshed by
// scripts/vacuum_live/shadow.py every minute and after each fire; no fetch of its own). Taken fires become real orders on the SIMULATED account (server/services/vacuumLiveOrders.js).
const small = { fontSize: 12, color: '#94a3b8', lineHeight: 1.5 };
const box = { background: 'var(--card-bg)', border: '1px solid var(--border-color, #334155)', borderRadius: 8, padding: 16, marginBottom: 16 };
const pt = (v) => (v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}`);
const Row = ({ k, children }) => <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13, padding: '2px 0' }}><span style={{ color: '#94a3b8' }}>{k}</span><span style={{ textAlign: 'right' }}>{children}</span></div>;

export default function VacuumLiveSection({ board }) {
  const head = <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Expansion rule, live (the original idea, orders on Sim1)</div>;
  if (!board) return <div style={box}>{head}<div style={{ ...small, color: '#f59e0b' }}>learning_monitor.json has no live-rule data yet.</div></div>;
  if (board.state !== 'OK') return <div style={box}>{head}<div style={{ ...small, color: '#f59e0b' }}>Unavailable: {board.error || board.state}</div></div>;
  const dm = board.daemon; const age = board.generatedAt ? Math.max(0, Math.round((Date.now() - Date.parse(board.generatedAt)) / 1000)) : 0;
  const la = dm && dm.loopAgeSec != null ? dm.loopAgeSec + age : null; const ok = dm && la != null && la < 180 && dm.state === 'LIVE'; const col = ok ? '#22c55e' : (la != null && la < 900 ? '#f59e0b' : '#ef4444');
  return (
    <div style={box}>
      {head}
      <div style={{ ...small, marginBottom: 10 }}>{board.rule}</div>
      {dm ? <>
        <Row k="Detector"><b style={{ color: col }}>{dm.state}</b> <span style={{ color: '#94a3b8' }}>{la == null ? 'n/a' : `${la >= 120 ? `${Math.round(la / 60)} min` : `${la} s`} since the last loop`} · session {dm.session}</span></Row>
        <Row k="This session">{dm.bars} bars · {dm.events} expansion events</Row>
      </> : <Row k="Detector"><span style={{ color: '#ef4444' }}>not reachable</span></Row>}
      <Row k="Latest session">{board.today || 'n/a'}: {(board.sessionCounts || []).map((r) => `${r.track === 'GBX' ? 'Globex' : 'RTH'} ${r.n} (${r.taken} taken)`).join(' · ') || 'none yet'}</Row>
      <div style={{ ...small, margin: '8px 0 2px' }}>Forward since {board.forwardFrom}</div>
      {(board.forward || []).length === 0 ? <div style={small}>No forward events yet.</div> : board.forward.map((r) => (
        <div key={r.track} style={{ fontSize: 13, padding: '2px 0' }}><b>{r.track === 'GBX' ? 'Globex' : 'RTH'}</b>: {r.n} events on {r.days} days · taken {r.taken} (results {r.taken_done}) · mean net per trade WITH the expansion, no stop {pt(r.net_nostop)} pt · with the 2.5x stop {pt(r.net_stop25)} pt · FADING it {pt(r.net_fade)} pt</div>))}
      <div style={{ ...small, margin: '8px 0 2px' }}>Orders on the simulated account (Sim1)</div>
      {board.orders && !board.orders.error ? <>
        <div style={{ fontSize: 13, padding: '2px 0' }}>{(board.orders.states || []).map((x) => `${x.track === 'GBX' ? 'Globex' : 'RTH'} ${String(x.st).toLowerCase().replace('skipped_', 'skipped: ')} ${x.n}`).join(' · ') || 'no taken event yet'}</div>
        {(board.orders.rows || []).length === 0 ? <div style={small}>No order yet: the next taken fire becomes a market order with a 2.5 x EMA10(TR) stop, held 30 bars.</div> : board.orders.rows.map((r) => (
          <div key={r.id} style={{ fontSize: 13, display: 'flex', gap: 10, flexWrap: 'wrap', padding: '2px 0' }}>
            <span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{r.t}</span><span>{r.setup_type === 'VACUUM_EXP_LONG' ? '▲ long' : '▼ short'}</span>
            <span>{r.fill == null ? 'no fill yet' : `filled ${Number(r.fill).toFixed(2)}`} · stop {Number(r.stop).toFixed(2)}</span>
            <b>{r.status === 'ACTIVE' ? 'OPEN' : `${r.resolution || r.status}${r.pnl == null ? '' : ` ${r.pnl >= 0 ? '+$' : '-$'}${Math.abs(r.pnl).toFixed(2)}`}`}</b>
          </div>))}
      </> : <div style={{ ...small, color: '#f59e0b' }}>Order status unavailable.</div>}
      <div style={{ ...small, margin: '8px 0 2px' }}>Latest fires</div>
      {(board.recent || []).length === 0 ? <div style={small}>No event logged yet.</div> : board.recent.map((r, i) => (
        <div key={i} style={{ fontSize: 13, display: 'flex', gap: 10, flexWrap: 'wrap', padding: '2px 0' }}>
          <span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{String(r.d).slice(5)} {r.t}</span><span>{r.track === 'GBX' ? 'Globex' : 'RTH'}</span><span>{r.direction === 1 ? '▲ long' : '▼ short'}</span><span style={{ fontFamily: 'monospace' }}>@ {Number(r.sc).toFixed(2)}</span>
          <span style={{ color: '#94a3b8' }}>Z {Number(r.z).toFixed(2)}{r.late > 3 ? ` · late ${Math.round(r.late)} min` : ''}</span><span>{r.taken ? 'taken' : 'skipped (position open)'}</span><span style={{ fontFamily: 'monospace' }}>{r.nn == null ? 'open' : `30 bars ${pt(r.f30)} pt`}</span>
        </div>))}
      {board.next && <NextSteps n={{ review: board.next.review, ifConfirmed: board.next.ifConfirmed, ifFailed: board.next.ifFailed }} label={null} />}
      <div style={{ ...small, marginTop: 6 }}>{(board.notes || []).join(' ')}</div>
    </div>
  );
}
