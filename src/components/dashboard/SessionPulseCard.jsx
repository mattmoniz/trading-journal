import React, { useState, useEffect } from 'react';

const API_URL = '/api';

function fmtP(p) { return p != null ? p.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'; }

function Chip({ label, value, color, bg }) {
  return (
    <div style={{ padding: '4px 8px', background: bg || 'rgba(30,41,59,0.5)', borderRadius: 4, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
      <div style={{ fontSize: 9, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: color || '#e2e8f0', fontFamily: 'monospace' }}>{value}</div>
    </div>
  );
}

export default function SessionPulseCard() {
  const [ctx, setCtx] = useState(null);

  useEffect(() => {
    const load = () => {
      const d = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      fetch(`${API_URL}/morning-brief/live-session-context/${d}`)
        .then(r => r.json())
        .then(c => { if (!c?.noData) setCtx(c); })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 30000);
    const sock = window._tradingSocket;
    if (sock) sock.on('price-sync-progress', load);
    return () => {
      clearInterval(id);
      if (sock) sock.off('price-sync-progress', load);
    };
  }, []);

  if (!ctx) return null;

  const { rots, delta, relVol, sessionChar, microTrend, price, closeVsOpen, rangePct, range, etMin, open } = ctx;

  // Exhaustion conditions (for down sessions — mirror for up)
  const isDirectional = sessionChar?.includes('TREND') || (rots != null && rots <= 1 && Math.abs(closeVsOpen || 0) > 80);
  const volExtreme    = (relVol?.sigma || 0) >= 1.5;
  const deltaFading   = delta?.trend === 'WEAKENING' || delta?.trend === 'FLAT' || delta?.trend === 'BUYING';
  const higherLows    = microTrend === 'HIGHER_LOWS';
  const lowerHighs    = microTrend === 'LOWER_HIGHS';
  const exhaustionScore = [isDirectional, volExtreme, deltaFading, higherLows || lowerHighs].filter(Boolean).length;

  // Counter-move tracker: only show if session made a big move and we can measure a bounce
  const isDownSession = (closeVsOpen || 0) < -80;
  const isUpSession   = (closeVsOpen || 0) > 80;
  const sessionOpen   = open || (isDownSession ? (price - closeVsOpen) : null);
  const dayLowEst     = sessionOpen && range ? sessionOpen + closeVsOpen - (rangePct != null ? (range * rangePct / 100) : 0) : null;

  // Retrace percentiles (from backtest: P25=46%, Median=68%, P75=88%)
  let retraceDisplay = null;
  if (sessionOpen && range && rangePct != null && Math.abs(closeVsOpen || 0) > 80) {
    const morningDrop = Math.abs(closeVsOpen);
    const p25Target  = isDownSession ? (sessionOpen - morningDrop + morningDrop * 0.46) : (sessionOpen + morningDrop - morningDrop * 0.46);
    const medTarget  = isDownSession ? (sessionOpen - morningDrop + morningDrop * 0.68) : (sessionOpen + morningDrop - morningDrop * 0.68);
    const p75Target  = isDownSession ? (sessionOpen - morningDrop + morningDrop * 0.88) : (sessionOpen + morningDrop - morningDrop * 0.88);
    const counterMove = isDownSession ? (price - (sessionOpen - morningDrop)) : ((sessionOpen + morningDrop) - price);
    const retracePct  = Math.max(0, Math.min(105, counterMove / morningDrop * 100));
    if (counterMove > 20) {
      retraceDisplay = { morningDrop: Math.round(morningDrop), counterMove: Math.round(counterMove), retracePct: Math.round(retracePct), p25Target: Math.round(p25Target), medTarget: Math.round(medTarget), p75Target: Math.round(p75Target), isDown: isDownSession };
    }
  }

  // Colors
  const volColor   = volExtreme ? '#fbbf24' : (relVol?.sigma || 0) >= 1 ? '#fb923c' : '#64748b';
  const rotColor   = (rots ?? 0) <= 1 ? '#f87171' : (rots ?? 0) <= 2 ? '#fbbf24' : '#4ade80';
  const deltaColor = delta?.trend === 'BUYING' ? '#4ade80' : delta?.trend === 'WEAKENING' ? '#fbbf24' : delta?.trend === 'FLAT' ? '#94a3b8' : '#f87171';
  const mtColor    = microTrend === 'HIGHER_LOWS' ? '#4ade80' : microTrend === 'LOWER_HIGHS' ? '#f87171' : '#94a3b8';

  const exhaustBorderColor = exhaustionScore >= 3 ? '#f59e0b' : exhaustionScore >= 2 ? '#475569' : 'rgba(51,65,85,0.4)';

  return (
    <div style={{
      padding: '8px 10px',
      background: 'rgba(15,23,42,0.6)',
      border: `1px solid ${exhaustBorderColor}`,
      borderRadius: 6,
      transition: 'border-color 0.3s',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: '#38bdf8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Session Pulse
        </div>
        <div style={{ fontSize: 11, color: '#475569' }}>
          {sessionChar?.replace(/_/g,' ') || '—'}
        </div>
      </div>

      {/* 4 chips */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, marginBottom: 6 }}>
        <Chip label="Rotations" value={rots ?? '—'} color={rotColor} />
        <Chip label="Volume" value={relVol ? `${relVol.ratio}x` : '—'} color={volColor} />
        <Chip label="Delta" value={delta?.trend || '—'} color={deltaColor} />
        <Chip label="Structure" value={microTrend?.replace('_',' ') || '—'} color={mtColor} />
      </div>

      {/* Exhaustion signal — shows when 3+ conditions stack */}
      {exhaustionScore >= 3 && (
        <div style={{ padding: '5px 8px', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 4, marginBottom: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#fbbf24', marginBottom: 2 }}>
            ⚡ {isDownSession ? 'FLUSH' : 'SPIKE'} EXHAUSTION — {exhaustionScore}/4 signals
          </div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>
            {[
              isDirectional && 'directional session',
              volExtreme && `vol ${relVol?.sigma?.toFixed(1)}σ`,
              deltaFading && `delta ${delta?.trend?.toLowerCase()}`,
              higherLows && 'higher lows',
              lowerHighs && 'lower highs',
            ].filter(Boolean).join(' · ')}
          </div>
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
            Median counter-move: <span style={{ color: '#fbbf24', fontWeight: 700 }}>374pts</span> when delta diverges · 89% had 150pt+ bounce
          </div>
        </div>
      )}

      {/* Counter-move tracker */}
      {retraceDisplay && (
        <div style={{ padding: '5px 8px', background: 'rgba(30,41,59,0.4)', borderRadius: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Counter-Move Tracker
            </div>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0' }}>
              {retraceDisplay.counterMove}pt · <span style={{ color: retraceDisplay.retracePct >= 88 ? '#fbbf24' : retraceDisplay.retracePct >= 68 ? '#4ade80' : '#94a3b8' }}>{retraceDisplay.retracePct}%</span>
            </div>
          </div>
          {/* Progress bar */}
          <div style={{ position: 'relative', height: 6, background: 'rgba(51,65,85,0.5)', borderRadius: 3, marginBottom: 4 }}>
            <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${Math.min(retraceDisplay.retracePct, 100)}%`, background: retraceDisplay.retracePct >= 88 ? '#fbbf24' : retraceDisplay.retracePct >= 68 ? '#4ade80' : '#60a5fa', borderRadius: 3, transition: 'width 0.5s' }} />
            {/* P25 marker */}
            <div style={{ position: 'absolute', left: '46%', top: -2, width: 1, height: 10, background: '#475569' }} />
            {/* Median marker */}
            <div style={{ position: 'absolute', left: '68%', top: -2, width: 1, height: 10, background: '#64748b' }} />
            {/* P75 marker */}
            <div style={{ position: 'absolute', left: '88%', top: -2, width: 1, height: 10, background: '#94a3b8' }} />
          </div>
          {/* Target levels */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 2, fontSize: 10 }}>
            <div style={{ color: retraceDisplay.retracePct >= 46 ? '#4ade80' : '#475569' }}>
              P25 {fmtP(retraceDisplay.p25Target)}
            </div>
            <div style={{ color: retraceDisplay.retracePct >= 68 ? '#4ade80' : '#64748b', textAlign: 'center' }}>
              MED {fmtP(retraceDisplay.medTarget)}
            </div>
            <div style={{ color: retraceDisplay.retracePct >= 88 ? '#fbbf24' : '#64748b', textAlign: 'right' }}>
              P75 {fmtP(retraceDisplay.p75Target)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
