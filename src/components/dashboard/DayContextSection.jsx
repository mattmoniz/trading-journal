import React from 'react';
import NextSteps from './NextSteps.jsx';

// Day context section of the Learning view (2026-11-04). What the system sees right now: the latest bar and its age, the typical day (ADR), tonight's overnight range in ADR, the initial-balance state, the watcher state, and the
// UNFINISHED BUSINESS of the last 5 completed sessions that no later completed session has filled (single-print zones and poor highs / lows by the TradingView TPO rules), from the `dayContext` key of GET /api/setups/monitor-summary
// (server/services/dayContextSummary.js). Display only: it gates nothing and is not a signal. Data comes from the parent (no fetch here) so the view's one poll serves it; a missing or failed feed renders an explicit notice.
const small = { fontSize: 12, color: '#94a3b8', lineHeight: 1.5 };
const box = { background: 'var(--card-bg)', border: '1px solid var(--border-color, #334155)', borderRadius: 8, padding: 16, marginBottom: 16 };
const f0 = (v) => (v == null ? 'n/a' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }));
const f2 = (v) => (v == null ? 'n/a' : Number(v).toFixed(2));
const sg = (n) => `${n >= 0 ? '+' : ''}${f0(n)}`;

function Row({ k, children }) {
  return (<div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, padding: '2px 0' }}><span style={{ color: '#94a3b8' }}>{k}</span><span style={{ textAlign: 'right' }}>{children}</span></div>);
}

function Level({ L, up }) {
  return (
    <div style={{ padding: '4px 0', borderTop: '1px solid #334155' }}>
      <div style={{ display: 'flex', gap: 8, fontSize: 13 }}>
        <span>{up ? '▲' : '▼'}</span>
        <span style={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{f0(L.lo)}{L.hi > L.lo ? `–${f0(L.hi)}` : ''}</span>
        {L.touched && <span style={{ marginLeft: 'auto', color: '#f59e0b' }} title="tonight's or today's range has already traded into it">touched</span>}
      </div>
      <div style={{ ...small, paddingLeft: 22 }}>{f0(L.distPts)} pts · {f2(L.distAdr)} ADR · {L.kind} {String(L.date).slice(5)}</div>
    </div>
  );
}

// Rotation guide (2026-11-04): the current confirmed 65-point leg, the VWAP anchored at its pivot and where price sits against it; a reading aid, NOT VALIDATED, gates nothing (server/services/rotationGuide.js).
function RotationRows({ r }) {
  if (!r) return <Row k="Rotation guide"><span style={{ color: '#f59e0b' }}>not served yet (the server needs a restart)</span></Row>;
  if (r.state === 'ERROR') return <Row k="Rotation guide"><span style={{ color: '#f59e0b' }}>unavailable: {r.error || 'error'}</span></Row>;
  if (r.state !== 'OK') return <Row k="Rotation guide"><span style={{ color: '#94a3b8' }}>{r.note || r.state}</span></Row>;
  const n = r.now; const f = (v) => (v == null ? '--' : `${v > 0 ? '+' : ''}${v}`);
  if (!n || !n.dir) return <Row k="Rotation guide"><span style={{ color: '#94a3b8' }}>no 65-point leg confirmed yet</span></Row>;
  return (<>
    <Row k="Rotation leg (65 pt)"><b>{n.dir}</b> from {n.anchorT} @ {n.anchorPrice} <span style={{ color: '#94a3b8' }}>(confirmed {n.confirmedT}, {n.size} pts, {n.minutesSinceConfirm} min ago)</span>{r.stale && <span style={{ color: '#f59e0b' }}> feed {r.ageMin} min old</span>}</Row>
    <Row k="Rotational VWAP"><b>{n.rvwap}</b> · price {n.price} is {Math.abs(n.distPts)} pts {n.side.toLowerCase()} it · <b style={{ color: n.supported ? '#22c55e' : '#ef4444' }}>{n.supported ? (n.dir === 'UP' ? 'supports the leg (VWAP under price)' : 'resists (VWAP overhead)') : 'LEG HAS LOST ITS VWAP'}</b></Row>
    <Row k={`Last ${r.moveWindowMin} min`}>VWAP {f(n.vwapMove)} pts, price {f(n.priceMove)} pts <span style={{ color: '#94a3b8' }}>(raw)</span></Row>
    <Row k="Legs this session">{n.legsLastHour} in the last hour <span style={{ color: '#94a3b8' }}>{(r.legs || []).slice(-5).map((l) => `${l.dir === 'UP' ? '↑' : '↓'} ${l.confirmedT} @ ${l.anchorPrice}`).join(' · ')}</span></Row>
  </>);
}

// Symmetric liquidation / melt-up state (server/services/dayState.js). Tolerates an absent field (an older server that has not restarted yet).
function DayStateText({ ds }) {
  if (!ds) return <span style={{ color: '#94a3b8' }}>not served yet (restart pending)</span>;
  if (ds.error) return <span style={{ color: '#f59e0b' }}>unavailable: {ds.error}</span>;
  const one = (x) => (!x ? 'no session yet' : x.warmup ? 'warming up' : (<><b style={{ color: x.liquidation ? '#ef4444' : x.meltUp ? '#22c55e' : undefined }}>{x.state}</b> <span style={{ color: '#94a3b8' }}>since {String(x.since || '').slice(11)}{x.ageMin != null && x.ageMin > 5 ? ' · STALE' : ''}</span></>));
  return (<>RTH {one(ds.RTH)} · Globex {one(ds.GLOBEX)}</>);
}

export default function DayContextSection({ board, next }) {
  const head = <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Day context (what the system sees now)</div>;
  if (!board || board.state !== 'OK') {
    return (<div style={box}>{head}<div style={{ ...small, color: '#f59e0b' }}>{!board ? 'The summary has no day-context data yet (the server needs a restart to serve it).' : `Unavailable: ${board.error || board.state}.`}</div></div>);
  }
  const { overnight: on, ib, watcher: w, above = [], below = [], notes = [] } = board;
  return (
    <div style={box}>
      {head}
      <Row k="Latest bar">{board.asOf} · {board.ageMin != null ? `${board.ageMin} min old` : 'age unknown'}{board.stale && <b style={{ color: '#f59e0b' }}> STALE</b>}</Row>
      <Row k="Price">{f2(board.price)}</Row>
      <Row k="Typical day (ADR)">{f0(board.adr)} pts <span style={{ color: '#94a3b8' }}>median of the last 20 RTH ranges</span></Row>
      <Row k="Overnight">{on ? `${f0(on.range)} pts · ${f2(on.rangeAdr)} ADR · net ${sg(on.net)} · low ${f2(on.low)} (now ${sg(on.lowToLast)} above it)` : 'no bars yet'}</Row>
      <Row k="Initial balance">{ib ? <>{ib.state} <span style={{ color: '#94a3b8' }}>extension up {f2(ib.extensionUp)} / down {f2(ib.extensionDown)} IBR</span></> : <span style={{ color: '#94a3b8' }}>{board.ibNote || 'n/a'}</span>}</Row>
      <Row k="Day state"><DayStateText ds={board.dayState} /></Row>
      <Row k="Watcher">{w ? <>{w.state} <span style={{ color: '#94a3b8' }}>since {w.t}</span></> : <span style={{ color: '#94a3b8' }}>no state yet today</span>}</Row>
      <RotationRows r={board.rotation} />
      <details style={{ border: '1px solid #334155', borderRadius: 8, padding: '8px 12px', margin: '10px 0 8px' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: 14 }}>Unfinished business ({board.unfilledTotal} unfilled, last 5 sessions)</summary>
        <div style={{ marginTop: 8 }}>
          {(above.length || below.length) ? (<>
            <div style={{ ...small, margin: '2px 0' }}>Above the price</div>
            {above.length ? above.map((L, i) => <Level key={`a${i}`} L={L} up />) : <div style={small}>none</div>}
            <div style={{ ...small, margin: '8px 0 2px' }}>Below the price</div>
            {below.length ? below.map((L, i) => <Level key={`b${i}`} L={L} up={false} />) : <div style={small}>none</div>}
          </>) : <div style={small}>No unfilled single prints or poor highs / lows in the last 5 sessions.</div>}
        </div>
      </details>
      <div style={small}>{notes.map((n, i) => <div key={i}>{n}</div>)}</div>
      <NextSteps n={next} />
    </div>
  );
}
