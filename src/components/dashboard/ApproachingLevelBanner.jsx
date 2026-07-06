import React, { useState, useEffect, useRef } from 'react';

const DISMISS_AFTER_MS = 45000; // auto-dismiss after 45s

export default function ApproachingLevelBanner() {
  const [alert, setAlert] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => {
    const sock = window._tradingSocket;
    if (!sock) return;

    const onApproach = (data) => {
      setAlert({ ...data, receivedAt: Date.now() });
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setAlert(null), DISMISS_AFTER_MS);
    };

    sock.on('level-approaching', onApproach);
    return () => {
      sock.off('level-approaching', onApproach);
      clearTimeout(timerRef.current);
    };
  }, []);

  if (!alert) return null;

  const tierColor = {
    PRIME:    '#4ade80',
    SOLID:    '#60a5fa',
    MARGINAL: '#94a3b8',
    WEAK:     '#64748b',
  }[alert.tier] ?? '#94a3b8';

  const dirLabel = alert.direction === 'RESISTANCE' ? 'RESISTANCE ↑' : 'SUPPORT ↓';
  const dirColor = alert.direction === 'RESISTANCE' ? '#f87171' : '#4ade80';
  const wrColor  = (alert.wr ?? 0) >= 0.6 ? '#4ade80' : (alert.wr ?? 0) >= 0.5 ? '#fbbf24' : '#f87171';
  const elapsed  = Math.round((Date.now() - alert.receivedAt) / 1000);
  const secsLeft = Math.max(0, Math.round(DISMISS_AFTER_MS / 1000) - elapsed);

  return (
    <div style={{
      background: 'rgba(30, 41, 59, 0.95)',
      border: `1px solid ${tierColor}`,
      borderLeft: `4px solid ${tierColor}`,
      borderRadius: 6,
      padding: '10px 14px',
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap',
      boxShadow: `0 0 12px -3px ${tierColor}40`,
      position: 'relative',
    }}>
      {/* Pulse dot */}
      <span style={{
        width: 8, height: 8, borderRadius: '50%', background: tierColor,
        flexShrink: 0, animation: 'pulse 1.5s infinite',
      }} />

      {/* Level info */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: '#94a3b8', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            APPROACHING
          </span>
          <span style={{ fontSize: 13, fontWeight: 700, color: tierColor }}>
            {alert.levelName?.replace(/_FADE$/, '')}
          </span>
          <span style={{ fontSize: 12, color: dirColor, fontWeight: 600 }}>{dirLabel}</span>
          <span style={{ fontSize: 12, color: '#94a3b8' }}>@ {alert.level?.toLocaleString()}</span>
          <span style={{ fontSize: 12, color: '#cbd5e1', fontVariantNumeric: 'tabular-nums' }}>
            {alert.distance}pt away
          </span>
        </div>

        {/* Stats row */}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontVariantNumeric: 'tabular-nums' }}>
          {alert.wr != null && (
            <span style={{ fontSize: 11, color: wrColor, fontWeight: 700 }}>
              {(alert.wr * 100).toFixed(0)}% WR
            </span>
          )}
          {alert.ev != null && (
            <span style={{ fontSize: 11, color: alert.ev >= 0 ? '#4ade80' : '#f87171', fontWeight: 700 }}>
              ${alert.ev >= 0 ? '+' : ''}{alert.ev?.toFixed(0)} EV
            </span>
          )}
          {alert.n != null && (
            <span style={{ fontSize: 11, color: '#94a3b8' }}>N={alert.n}</span>
          )}
          {alert.confluenceCount > 0 && (
            <span style={{ fontSize: 11, color: '#a78bfa', fontWeight: 700 }}>
              ⚡ {alert.confluenceCount}× confluence: {alert.confluenceLevels?.map(l => l.replace(/_FADE$/, '')).join(' + ')}
            </span>
          )}
          <span style={{ fontSize: 11, color: '#94a3b8' }}>
            {alert.tier} · {secsLeft}s
          </span>
        </div>
      </div>

      {/* Dismiss */}
      <button
        onClick={() => { setAlert(null); clearTimeout(timerRef.current); }}
        style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: 16, cursor: 'pointer', padding: '0 2px', flexShrink: 0 }}
      >×</button>

      <style>{`@keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }`}</style>
    </div>
  );
}
