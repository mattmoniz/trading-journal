import React, { useState, useEffect } from 'react';

const API_URL = '/api';

export default function VolatilityAlertBanner() {
  const [data, setData] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/vol-alert`)
      .then(r => r.json())
      .then(setData)
      .catch(() => {});

    // Re-check every 5 min (overnight range can extend pre-open)
    const interval = setInterval(() => {
      fetch(`${API_URL}/vol-alert`)
        .then(r => r.json())
        .then(setData)
        .catch(() => {});
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  if (!data?.alert || dismissed) return null;

  const { sigma, on_range, avg_20d, std_20d, threshold } = data;
  const isExtreme = sigma >= 2.0;

  const bg     = isExtreme ? 'rgba(239,68,68,0.12)'  : 'rgba(251,146,60,0.10)';
  const border = isExtreme ? 'rgba(239,68,68,0.5)'   : 'rgba(251,146,60,0.45)';
  const color  = isExtreme ? '#ef4444'                : '#fb923c';
  const label  = isExtreme ? 'EXTREME VOLATILITY'     : 'ELEVATED OVERNIGHT RANGE';

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
      gap: 12, padding: '10px 14px',
      background: bg, border: `1px solid ${border}`,
      borderRadius: 8, marginBottom: 2,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{ fontSize: '1.1rem', lineHeight: 1.4 }}>⚠️</span>
        <div>
          <div style={{ fontSize: '0.82rem', fontWeight: 700, color, letterSpacing: '0.05em', marginBottom: 2 }}>
            {label} — HEAD ON A SWIVEL
          </div>
          <div style={{ fontSize: '0.79rem', color: '#cbd5e1', lineHeight: 1.5 }}>
            Overnight range <strong style={{ color }}>{on_range}pt</strong> is{' '}
            <strong style={{ color }}>{sigma.toFixed(1)}σ</strong> above normal
            (avg {avg_20d}pt · 1σ threshold {threshold}pt).{' '}
            {isExtreme
              ? 'EXTREME: Reduce to 1 contract minimum until OR confirms direction. High whipsaw risk.'
              : '50% size — wider moves mean bigger damage when stopped. Setups still fire; wait for OR direction first.'}
          </div>
        </div>
      </div>
      <button
        onClick={() => setDismissed(true)}
        style={{
          background: 'none', border: 'none', color: '#64748b',
          fontSize: '1rem', cursor: 'pointer', padding: '0 4px', lineHeight: 1, flexShrink: 0,
        }}
        title="Dismiss"
      >×</button>
    </div>
  );
}
