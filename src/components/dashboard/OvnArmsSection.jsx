import React from 'react';

// Overnight order-flow forward race section of the Learning view (2026-11-04). Both rules (the researched one and what the live shadow detector actually does) followed from the 1-minute bars for every forward night, four arms each
// (BASE, RISK-300, MOM, MIRROR), and the NEXT STEP written from the pre-registered forward rules (docs/OVN_ORDERFLOW_VARIATIONS_PREREG_20261104.md), from the `ovnArms` key of GET /api/setups/monitor-summary
// (server/services/ovnArmsSummary.js). Read-only: no orders, no setup type. Data comes from the parent (no fetch here); a missing or failed feed renders an explicit notice.
const small = { fontSize: 12, color: '#94a3b8', lineHeight: 1.5 };
const box = { background: 'var(--card-bg)', border: '1px solid var(--border-color, #334155)', borderRadius: 8, padding: 16, marginBottom: 16 };
const COL = { WATCHING: '#94a3b8', 'FIRST LOOK': '#3b82f6', INCONCLUSIVE: '#f59e0b', CONFIRMED: '#22c55e', FAILED: '#ef4444' };
const money = (v) => (v == null ? 'n/a' : `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}`);

function Row({ k, children }) {
  return (<div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, padding: '2px 0' }}><span style={{ color: '#94a3b8' }}>{k}</span><span style={{ textAlign: 'right' }}>{children}</span></div>);
}

function Rule({ R }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <Row k={<b style={{ color: 'inherit' }}>{R.label}</b>}><b style={{ color: COL[R.status] || '#94a3b8' }}>{R.status}</b></Row>
      <Row k="Qualifying nights">{R.completeNights} complete{R.inProgress ? ` · ${R.inProgress} in progress` : ''}</Row>
      {R.completeNights > 0 && (<>
        <Row k="Mean per trade">BASE {money(R.baseMean)}{R.baseCI && <span style={{ color: '#94a3b8' }}> [{money(R.baseCI[0])}, {money(R.baseCI[1])}]</span>} · RISK-300 {money(R.riskMean)}</Row>
        <Row k="Controls">MOM {money(R.momMean)} · MIRROR {money(R.mirrorMean)}</Row>
        <Row k="Hit · win · worst">{R.hitRate != null ? `${R.hitRate}%` : 'n/a'} · {R.winRate != null ? `${R.winRate}%` : 'n/a'} · {money(R.worstBase)}</Row>
      </>)}
      <div style={{ ...small, margin: '4px 0 0' }}><b>Next:</b> {R.next}</div>
    </div>
  );
}

export default function OvnArmsSection({ board }) {
  const head = <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Overnight order-flow forward race (shadow, from the bars)</div>;
  if (!board || board.state !== 'OK') {
    return (<div style={box}>{head}<div style={{ ...small, color: '#f59e0b' }}>{!board ? 'The summary has no overnight order-flow data yet (the server needs a restart to serve it).' : `Unavailable: ${board.error || board.state}.`}</div></div>);
  }
  const { research, live, nights = [], fires = [], notes = [] } = board;
  return (
    <div style={box}>
      {head}
      <div style={{ ...small, marginBottom: 8 }}>Forward nights from {board.forwardFrom}. The live detector counts legs on closes only (threshold {board.liveLegsThreshold}), so it is a stricter rule than the researched one; both are followed.</div>
      <Rule R={research} />
      <Rule R={live} />
      <details style={{ border: '1px solid #334155', borderRadius: 8, padding: '8px 12px', margin: '6px 0 8px' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: 14 }}>Qualifying forward nights and the live shadow rows</summary>
        <div style={{ marginTop: 8 }}>
          <div style={{ ...small, margin: '2px 0' }}>Nights (legs high-low / closes · flow lean; BASE result)</div>
          {nights.length ? nights.map((n) => (
            <div key={n.td} style={{ fontSize: 12.5, display: 'flex', gap: 8, padding: '2px 0' }}>
              <span style={{ fontFamily: 'monospace', color: '#94a3b8' }}>{String(n.td).slice(5)}</span><span>{n.dir === 'LONG' ? '▲' : '▼'}</span>
              <span style={{ color: '#94a3b8' }}>legs {n.legsHl} / {n.legsClose} · flow {n.flowPct}%</span><span>{n.research ? 'research' : ''}{n.research && n.live ? ' + ' : ''}{n.live ? 'live' : ''}</span>
              <span style={{ marginLeft: 'auto' }}>{n.complete ? money(n.base) : 'in progress'}</span>
            </div>)) : <div style={small}>No qualifying forward night yet.</div>}
          <div style={{ ...small, margin: '8px 0 2px' }}>Shadow rows written by the live detector</div>
          {fires.map((f) => (
            <div key={`${f.d}-${f.setup_type}`} style={{ fontSize: 12.5, display: 'flex', gap: 8, padding: '2px 0' }}>
              <span style={{ fontFamily: 'monospace', color: '#94a3b8' }}>{String(f.d).slice(5)}</span><span>{String(f.setup_type).replace('OVERNIGHT_ORDERFLOW_', '')}</span>
              <span style={{ color: '#94a3b8' }}>{f.status}{f.resolution ? ` · ${f.resolution}` : ''}</span><span style={{ marginLeft: 'auto' }}>{f.pnl != null ? money(f.pnl) : 'open'}</span>
            </div>))}
        </div>
      </details>
      <div style={small}>{notes.map((n, i) => <div key={i}>{n}</div>)}</div>
    </div>
  );
}
