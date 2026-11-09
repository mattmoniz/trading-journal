import React from 'react';
import NextSteps from './NextSteps.jsx';

// Watcher and shadow books section of the Learning view (2026-11-03), fed by the `tellContext.watcher` and `tellContext.shadow` keys of GET /api/setups/monitor-summary (no fetch of its own). The watcher reads how the day is
// developing; the shadow books re-run each live tell fire with the tell's own exit code on the same bars, changing only the stop (B) or the direction and stop (C). Display and learning only: NOT VALIDATED, nothing is ordered
// or gated. Dollars are never summed across books; each book is compared with the tell on the same fires, N below the floor is never a result.
const STATE = { UNKNOWN: 'unknown (before 60 RTH minutes)', BALANCE_FORMING: 'balance forming', BALANCE_CONFIRMED: 'balance confirmed', DRIVE_UP: 'driving up', DRIVE_DOWN: 'driving down', DRIVE_UP_BUILDING: 'driving up, built (a fight, then pushed on)', DRIVE_DOWN_BUILDING: 'driving down, built (a fight, then pushed on)' };
const money = (v) => (v == null ? '--' : `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}`);
const small = { fontSize: 12, color: '#94a3b8', lineHeight: 1.5 };
const box = { background: 'var(--card-bg)', border: '1px solid var(--border-color, #334155)', borderRadius: 8, padding: 16, marginBottom: 16 };
const tone = (v) => (v == null ? undefined : (v < 0 ? '#ef4444' : '#22c55e'));

export default function TellShadowSection({ board, next }) {
  const head = <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Watcher and shadow books (not validated, nothing ordered)</div>;
  if (!board || board.state !== 'OK' || !board.shadow) return null;
  const { watcher: w = {}, shadow: sh, missingShadow = [] } = board;
  return (
    <div style={box}>
      {head}
      <div style={{ ...small, marginBottom: 10 }}>The watcher reads how the day is developing from the completed bars. The shadow books re-run each tell fire with its own exit code on the same bars, changing only the stop (B) or the direction and stop (C, AGAINST fires only).</div>
      {missingShadow.length > 0 && <div style={{ ...small, color: '#f59e0b', marginBottom: 8 }}>{missingShadow.reduce((a, m) => a + m.n, 0)} fire(s) have a context row but no shadow books ({missingShadow.map((m) => `${m.d}: ${m.n}`).join(', ')}).</div>}
      <div style={{ fontSize: 13, marginBottom: 6 }}>Day state now: <b>{w.current ? (STATE[w.current] || w.current) : 'no data yet'}</b>{w.date ? ` (${w.date})` : ''} · state changes per day: {w.flipsPerDay ?? '--'} (stability gauge)</div>
      <div style={{ marginBottom: 10 }}>{(w.timeline || []).slice(-8).map((x, i) => <div key={i} style={{ fontSize: 12, display: 'flex', gap: 10 }}><span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{x.t}</span><span>{STATE[x.state] || x.state}</span></div>)}</div>
      <div style={{ ...small, marginBottom: 6 }}>Control (tell re-simulated through its own code): {sh.control.fires} closed fires on {sh.control.days} day{sh.control.days === 1 ? '' : 's'}, mean {money(sh.control.mean)}, median {money(sh.control.median)} · parity with the tell: {sh.parityFailures ? <span style={{ color: '#f59e0b' }}>{sh.parityFailures} failure(s)</span> : 'exact'}</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 10 }}>
        <thead><tr style={{ color: '#94a3b8', textAlign: 'left' }}><th>Book</th><th>Differs from tell</th><th>Days</th><th>Mean vs tell</th><th>Median vs tell</th><th>Better / worse / same</th></tr></thead>
        <tbody>
          {[['B', 'B: value-edge stop'], ['C', 'C: flip when AGAINST'], ['D', 'D: stop behind node 4'], ['E', 'E: Sierra-style node stop'], ['F', 'F: stop beyond the day extreme']].filter(([k]) => sh.books[k]).map(([k, name]) => { const b = sh.books[k]; return (
            <tr key={k} style={{ borderTop: '1px solid #334155' }}>
              <td>{name}</td><td>{b.changed} of {b.fires}</td><td>{b.days}</td><td style={{ color: tone(b.meanDiff) }}>{money(b.meanDiff)}</td><td style={{ color: tone(b.medianDiff) }}>{money(b.medianDiff)}</td>
              <td>{b.better == null ? 'counts only until the floor' : `${b.better} / ${b.worse} / ${b.same}`}{b.belowFloor ? <span style={{ color: '#94a3b8' }}> (N&lt;{b.floor || sh.minN}, no result)</span> : null}</td>
            </tr>); })}
        </tbody>
      </table>
      <div style={{ ...small, marginBottom: 6 }}>Live override orders (sim account): {(sh.live || []).length ? (sh.live || []).map((x) => `${x.order_state === 'LINKED_C' ? 'flip' : 'edge stop'} ${x.d} ${x.status === 'ACTIVE' ? 'open' : money(x.pnl)} (tell ${x.tell_sim_net == null ? 'n/a' : money(x.tell_sim_net)})`).join(' · ') : 'none yet'}</div>
      <div style={small}>{(sh.notes || []).map((n, i) => <div key={i}>{n}</div>)}</div>
      <NextSteps n={next} />
    </div>
  );
}
