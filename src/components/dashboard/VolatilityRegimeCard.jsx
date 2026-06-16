import React, { useState, useEffect } from 'react';

const API_URL = '/api';

const REGIME_STYLE = {
  'HIGH-VOL-DIRECTIONAL': { label: 'High-Vol Directional', color: '#4ade80', note: 'Phase-1 backtest: setups win 63.5% (n=74) in this regime vs ~42% baseline.' },
  'HIGH-VOL-CHOP':        { label: 'High-Vol Chop',        color: '#f87171', note: 'Phase-1 backtest: setups win 39.3% (n=117) in this regime, slightly below baseline.' },
  'NORMAL-VOL':           { label: 'Normal Volatility',    color: '#94a3b8', note: null },
  'LOW-VOL':              { label: 'Low Volatility',       color: '#60a5fa', note: null },
};

const TREND_LABEL = {
  'settling down': { text: '↓ Settling down', color: '#4ade80' },
  'ramping up':    { text: '↑ Ramping up',    color: '#f87171' },
  'flat':          { text: '→ Flat',          color: '#94a3b8' },
  'insufficient data': { text: '', color: '#64748b' },
};

function Sparkline({ history }) {
  if (!history || history.length < 2) return null;
  const w = 120, h = 32, pad = 2;
  const zs = history.map(p => p.z);
  const minZ = Math.min(...zs, 0);
  const maxZ = Math.max(...zs, 0);
  const range = maxZ - minZ || 1;
  const points = history.map((p, i) => {
    const x = pad + (i / (history.length - 1)) * (w - 2 * pad);
    const y = h - pad - ((p.z - minZ) / range) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  // zero line (z=0)
  const zeroY = h - pad - ((0 - minZ) / range) * (h - 2 * pad);
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <line x1={pad} y1={zeroY} x2={w - pad} y2={zeroY} stroke="#475569" strokeWidth="1" strokeDasharray="2,2" />
      <polyline points={points} fill="none" stroke="#a78bfa" strokeWidth="1.5" />
    </svg>
  );
}

export default function VolatilityRegimeCard() {
  const [data, setData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(`${API_URL}/acd/volatility-regime`)
        .then(r => r.json())
        .then(d => !cancelled && setData(d))
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!data) return null;

  if (!data.available) {
    return (
      <div style={cardStyle}>
        <div style={titleStyle}>Volatility Regime (live)</div>
        <div style={{ fontSize: 12, color: '#64748b' }}>{data.reason}</div>
      </div>
    );
  }

  const regime = REGIME_STYLE[data.regime] || REGIME_STYLE['NORMAL-VOL'];
  const trend = TREND_LABEL[data.trend] || TREND_LABEL['insufficient data'];

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>
        Volatility Regime (live){!data.morningComplete && <span style={{ color: '#64748b', fontWeight: 400 }}> — morning window in progress</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: regime.color }}>{regime.label}</div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
            z = {data.z.toFixed(2)} vs trailing {data.baselineN}-session morning-vol baseline
          </div>
          {trend.text && (
            <div style={{ fontSize: 12, color: trend.color, marginTop: 2, fontWeight: 600 }}>{trend.text}</div>
          )}
        </div>
        <Sparkline history={data.history} />
      </div>
      {regime.note && (
        <div style={{ fontSize: 11, color: '#64748b', marginTop: 8, lineHeight: 1.4 }}>{regime.note}</div>
      )}
    </div>
  );
}

const cardStyle = {
  border: '1px solid var(--border-color, #334155)',
  borderRadius: 8,
  padding: '12px 14px',
  marginBottom: 16,
  background: 'rgba(255,255,255,0.02)',
};

const titleStyle = {
  fontSize: 12,
  fontWeight: 700,
  color: '#cbd5e1',
  marginBottom: 8,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};
