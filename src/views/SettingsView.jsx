import React from 'react';

const API_URL = '/api';

function ProcessHealthDashboard() {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [expanded, setExpanded] = React.useState({});

  const load = React.useCallback(() => {
    setLoading(true);
    fetch(`${API_URL}/settings/process-health`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  React.useEffect(() => { load(); }, [load]);

  React.useEffect(() => {
    const sock = window._tradingSocket;
    if (!sock) return;
    const handler = () => load();
    sock.on('process-health-alert', handler);
    return () => sock.off('process-health-alert', handler);
  }, [load]);

  const dot = (color, size = 10) => {
    const bg = color === 'green' ? '#22c55e' : color === 'amber' ? '#f59e0b' : color === 'red' ? '#ef4444' : '#64748b';
    const isGray = color === 'gray';
    return (
      <span style={{
        display: 'inline-block', width: size, height: size, borderRadius: '50%',
        background: isGray ? 'transparent' : bg,
        border: isGray ? `2px solid #64748b` : 'none',
        flexShrink: 0,
      }} />
    );
  };

  const statusLabel = (proc) => {
    if (proc.statusColor === 'green') return 'OK';
    if (proc.statusColor === 'red')   return 'FAIL';
    if (proc.statusColor === 'amber') return proc.statusNote ? 'STALE' : 'WARN';
    if (proc.statusColor === 'gray')  return proc.statusNote ? 'WAIT' : 'N/A';
    return proc.statusColor?.toUpperCase() || '—';
  };

  const redCritical = data?.processes?.filter(p => p.statusColor === 'red' && p.critical) || [];

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>Process Health</h2>
        {data?.checkedAt && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Last checked: {data.checkedAt}</span>}
        <button
          onClick={load}
          disabled={loading}
          style={{ marginLeft: 'auto', fontSize: 12, padding: '4px 12px', borderRadius: 6, background: 'var(--card-bg)', border: '1px solid var(--border-color)', color: 'var(--text-muted)', cursor: 'pointer' }}
        >
          {loading ? '...' : 'Refresh'}
        </button>
      </div>

      {redCritical.length > 0 && (
        <div style={{ background: '#7f1d1d22', border: '1px solid #ef4444', borderRadius: 8, padding: '10px 14px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 14 }}>⚠</span>
          <span style={{ fontSize: 13, color: '#f87171', fontWeight: 600 }}>
            {redCritical.length} critical process{redCritical.length > 1 ? 'es' : ''} need attention: {redCritical.map(p => p.label).join(', ')}
          </span>
        </div>
      )}

      {loading && !data && <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '20px 0' }}>Loading...</div>}

      {data?.processes && (
        <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                {['Process', 'Schedule', 'Last Run', 'Duration', 'Status'].map(h => (
                  <th key={h} style={{ padding: '8px 14px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.processes.map((proc) => {
                const isExpanded = expanded[proc.name];
                return (
                  <React.Fragment key={proc.name}>
                    <tr
                      onClick={() => proc.history?.length > 0 && setExpanded(e => ({ ...e, [proc.name]: !e[proc.name] }))}
                      style={{
                        borderBottom: '1px solid var(--border-color)',
                        cursor: proc.history?.length > 0 ? 'pointer' : 'default',
                        background: isExpanded ? 'var(--hover-bg, rgba(255,255,255,0.03))' : 'transparent',
                      }}
                    >
                      <td style={{ padding: '9px 14px', color: 'var(--text-primary)', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 8 }}>
                        {proc.history?.length > 0 && (
                          <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 10 }}>{isExpanded ? '▼' : '▶'}</span>
                        )}
                        {proc.label}
                        {proc.isLive && <span style={{ fontSize: 12, background: '#1d4ed8', color: '#93c5fd', borderRadius: 4, padding: '1px 5px', fontWeight: 600 }}>LIVE</span>}
                        {proc.critical && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>★</span>}
                      </td>
                      <td style={{ padding: '9px 14px', color: 'var(--text-muted)' }}>{proc.schedule}</td>
                      <td style={{ padding: '9px 14px', color: proc.lastRun ? 'var(--text-primary)' : 'var(--text-muted)', fontFamily: 'monospace' }}>
                        {proc.lastRun || '—'}
                      </td>
                      <td style={{ padding: '9px 14px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{proc.lastDuration || '—'}</td>
                      <td style={{ padding: '9px 14px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {dot(proc.statusColor)}
                            <span style={{
                              color: proc.statusColor === 'green' ? '#22c55e' : proc.statusColor === 'amber' ? '#f59e0b' : proc.statusColor === 'red' ? '#ef4444' : '#64748b',
                              fontWeight: 600, fontSize: 12,
                            }}>{statusLabel(proc)}</span>
                            {proc.errorMessage && !proc.statusNote && <span style={{ fontSize: 11, color: '#ef4444', marginLeft: 4 }}>({proc.errorMessage.slice(0, 40)})</span>}
                          </div>
                          {proc.statusNote && (
                            <span style={{
                              fontSize: 12, marginLeft: 16,
                              color: proc.statusColor === 'amber' ? '#f59e0b' : proc.statusColor === 'gray' ? '#64748b' : '#ef4444',
                            }}>{proc.statusNote}</span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {isExpanded && proc.history?.length > 0 && (
                      <tr style={{ borderBottom: '1px solid var(--border-color)', background: 'var(--hover-bg, rgba(255,255,255,0.02))' }}>
                        <td colSpan={5} style={{ padding: '8px 14px 12px 32px' }}>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6, fontWeight: 600 }}>Last {proc.history.length} runs</div>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                            <thead>
                              <tr>
                                {['Time', 'Status', 'Duration', 'Records'].map(h => (
                                  <th key={h} style={{ textAlign: 'left', padding: '3px 10px', color: 'var(--text-muted)', fontWeight: 600 }}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {proc.history.map((h, hi) => (
                                <tr key={hi}>
                                  <td style={{ padding: '3px 10px', fontFamily: 'monospace', color: 'var(--text-primary)' }}>{h.startedAt}</td>
                                  <td style={{ padding: '3px 10px' }}>
                                    <span style={{ color: h.status === 'SUCCESS' ? '#22c55e' : h.status === 'FAILED' ? '#ef4444' : '#f59e0b', fontWeight: 600 }}>{h.status}</span>
                                    {h.error && <span style={{ color: '#ef4444', marginLeft: 8 }}>— {h.error.slice(0, 50)}</span>}
                                  </td>
                                  <td style={{ padding: '3px 10px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{h.duration || '—'}</td>
                                  <td style={{ padding: '3px 10px', color: 'var(--text-muted)' }}>{h.records ?? '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
        ★ = critical · LIVE = checked via live DB query · click rows with history to expand
      </div>
    </div>
  );
}

export default function SettingsView() {
  return (
    <div className="settings-view">
      <header className="page-header">
        <h1>Settings</h1>
      </header>

      <div style={{ maxWidth: 1000 }}>
        <ProcessHealthDashboard />
      </div>

      <div className="settings-card" style={{ marginTop: 24 }}>
        <h2>Database Configuration</h2>
        <p>Your trading data is stored in PostgreSQL.</p>
        <p>Check your .env file to configure database connection.</p>
      </div>

      <div className="settings-card">
        <h2>Export Data</h2>
        <button className="btn btn-secondary">Export to CSV</button>
        <button className="btn btn-secondary">Backup Database</button>
      </div>
    </div>
  );
}
