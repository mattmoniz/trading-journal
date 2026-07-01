import React, { useState, useEffect } from 'react';

const API_URL = '/api';

export default function TradeCalibrationCard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_URL}/acd/feedback/calibration?days=90`)
      .then(r => r.json())
      .then(d => setData(d))
      .catch(e => console.error('Error fetching trade calibration:', e))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div style={{ fontSize: 13, color: '#94a3b8', padding: '10px 0' }}>Loading Trade Calibration...</div>;
  }

  if (!data || !data.calibration || data.calibration.length === 0) {
    return (
      <div style={containerStyle}>
        <div style={titleStyle}>📈 Personal Calibration (90-Day Lookback)</div>
        <div style={{ fontSize: 13, color: '#94a3b8', fontStyle: 'italic', padding: '6px 0' }}>
          No personal trade feedback logs found. Log trades using the Quick Trade Log to calibrate your edge.
        </div>
      </div>
    );
  }

  const { calibration, tagEdges } = data;

  return (
    <div style={containerStyle}>
      <div style={titleStyle}>📈 Personal Calibration vs System Baseline</div>
      <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 12 }}>
        Comparing your manual execution (Quick Trade Log) against the mechanical system rules (Last 90 Days).
      </div>

      <div style={gridStyle}>
        {/* Left Column: Setups WR Calibration */}
        <div style={sectionStyle}>
          <div style={subtitleStyle}>Setup Execution Accuracy</div>
          <div style={{ overflowX: 'auto', border: '1px solid var(--border-color)', borderRadius: 6 }}>
            <table style={tableStyle}>
              <thead>
                <tr style={headerRowStyle}>
                  <th style={thStyle}>Setup</th>
                  <th style={{ ...thStyle, textAlign: 'center' }}>Your WR (n)</th>
                  <th style={{ ...thStyle, textAlign: 'center' }}>System WR (n)</th>
                  <th style={{ ...thStyle, textAlign: 'center' }}>Skip WR (n)</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Avg P&L</th>
                </tr>
              </thead>
              <tbody>
                {calibration.map((c, idx) => {
                  const wrDiff = c.wrDelta != null ? c.wrDelta * 100 : 0;
                  const diffColor = wrDiff >= 5 ? '#22c55e' : wrDiff <= -5 ? '#ef4444' : '#cbd5e1';
                  const userWrStr = c.userWR != null ? `${(c.userWR * 100).toFixed(0)}%` : '—';
                  const sysWrStr = c.systemWR != null ? `${(c.systemWR * 100).toFixed(0)}%` : '—';
                  const skipWrStr = c.skipWR != null ? `${(c.skipWR * 100).toFixed(0)}%` : '—';

                  return (
                    <tr key={idx} style={rowStyle}>
                      <td style={{ ...tdStyle, fontWeight: 700, color: '#a78bfa' }}>{c.setupType}</td>
                      <td style={{ ...tdStyle, textAlign: 'center', fontWeight: 600 }}>
                        <span style={{ color: diffColor }}>{userWrStr}</span>
                        <span style={{ fontSize: 12, color: '#94a3b8', marginLeft: 4 }}>({c.userN})</span>
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'center', color: '#cbd5e1' }}>
                        {sysWrStr} <span style={{ fontSize: 12, color: '#94a3b8' }}>({c.systemN})</span>
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'center', color: '#94a3b8' }}>
                        {skipWrStr} <span style={{ fontSize: 12, color: '#94a3b8' }}>({c.skipN})</span>
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', color: parseFloat(c.userAvgPnl) >= 0 ? '#10b981' : '#ef4444' }}>
                        {c.userAvgPnl != null ? `$${parseFloat(c.userAvgPnl).toFixed(0)}` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right Column: Tag Analytics & Skips */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Tag Behavior Card */}
          <div style={sectionStyle}>
            <div style={subtitleStyle}>🏷️ Tag-Level Performance</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {tagEdges && tagEdges.length > 0 ? (
                tagEdges.map((t, idx) => {
                  const wr = (t.wins / t.decided) * 100;
                  const isPositive = wr >= 55;
                  return (
                    <div key={idx} style={tagRowStyle}>
                      <span style={t.wins > 0 ? tagBadgeStyle : tagWarningBadgeStyle}>{t.tag}</span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: isPositive ? '#10b981' : '#f59e0b' }}>
                        {wr.toFixed(0)}% WR <span style={{ fontSize: 12, color: '#94a3b8' }}>(n={t.decided})</span>
                      </span>
                      <span style={{ fontSize: 11, fontFamily: 'monospace', color: parseFloat(t.avg_pnl) >= 0 ? '#10b981' : '#ef4444', marginLeft: 'auto' }}>
                        {parseFloat(t.avg_pnl) >= 0 ? '+' : ''}${parseFloat(t.avg_pnl).toFixed(0)} avg
                      </span>
                    </div>
                  );
                })
              ) : (
                <div style={{ fontSize: 12, color: '#94a3b8', fontStyle: 'italic' }}>
                  No tag-level analytics available yet. Tag your trades with qualifiers (e.g. 'absorption', 'gut_read') to populate.
                </div>
              )}
            </div>
          </div>

          {/* Skip Accuracy Guide */}
          <div style={sectionStyle}>
            <div style={subtitleStyle}>💡 Skip Analysis Playbook</div>
            <div style={{ fontSize: 12, lineHeight: 1.6, color: '#cbd5e1' }}>
              <div style={{ marginBottom: 6 }}>
                • <strong>Skip WR:</strong> Represents the system success rate on setups you chose to <em>pass</em>.
              </div>
              <div style={{ marginBottom: 6 }}>
                • <strong>High Skip WR:</strong> Indicates you are skipping winning trades (FOMO/hesitation). Look to take these setups more aggressively.
              </div>
              <div>
                • <strong>Low Skip WR:</strong> Indicates your filter is highly accurate (excellent selection). Keep passing on these low-probability setups.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Styling Config
const containerStyle = {
  marginBottom: 20,
  padding: '14px 18px',
  background: 'var(--card-bg)',
  border: '1px solid var(--border-color)',
  borderRadius: 10,
  fontFamily: 'Arial, sans-serif'
};

const titleStyle = {
  fontSize: 14,
  fontWeight: 700,
  color: '#cbd5e1',
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  marginBottom: 4
};

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
  gap: 16
};

const sectionStyle = {
  background: 'rgba(255,255,255,0.01)',
  border: '1px solid rgba(255,255,255,0.03)',
  borderRadius: 8,
  padding: 12
};

const subtitleStyle = {
  fontSize: 12,
  fontWeight: 700,
  color: '#94a3b8',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  marginBottom: 10,
  borderBottom: '1px solid rgba(255,255,255,0.05)',
  paddingBottom: 4
};

const tableStyle = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 12
};

const headerRowStyle = {
  borderBottom: '1px solid var(--border-color)',
  background: 'rgba(15,23,42,0.3)'
};

const thStyle = {
  padding: '6px 8px',
  textAlign: 'left',
  fontWeight: 600,
  color: '#94a3b8'
};

const rowStyle = {
  borderBottom: '1px solid rgba(255,255,255,0.03)'
};

const tdStyle = {
  padding: '8px'
};

const tagRowStyle = {
  display: 'flex',
  alignItems: 'center',
  padding: '6px 8px',
  background: 'rgba(255,255,255,0.02)',
  borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.03)'
};

const tagBadgeStyle = {
  fontSize: 12,
  fontWeight: 700,
  background: 'rgba(16, 185, 129, 0.12)',
  color: '#34d399',
  padding: '1px 6px',
  borderRadius: 4,
  marginRight: 10
};

const tagWarningBadgeStyle = {
  fontSize: 12,
  fontWeight: 700,
  background: 'rgba(239, 68, 68, 0.12)',
  color: '#f87171',
  padding: '1px 6px',
  borderRadius: 4,
  marginRight: 10
};
