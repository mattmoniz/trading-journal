import React, { useState, useEffect, useCallback } from 'react';

const API_URL = '/api';

export default function TradeAlertBanner() {
  const [alerts, setAlerts] = useState([]);
  const [dismissed, setDismissed] = useState(new Set());
  const [apiErrors, setApiErrors] = useState([]);

  const fetchAlerts = useCallback(() => {
    const d = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    // Health-check all critical endpoints
    const errors = [];
    const checks = [
      { name: 'Setup detection', url: `${API_URL}/acd/setup-detection?date=${d}` },
      { name: 'Trade alerts', url: `${API_URL}/morning-brief/trade-alerts/${d}` },
      { name: 'Live session', url: `${API_URL}/morning-brief/live-session-context/${d}` },
      { name: 'Case engine', url: `${API_URL}/case?date=${d}&asOf=09:30` },
    ];
    Promise.all(checks.map(c =>
      fetch(c.url).then(r => r.json()).then(data => {
        if (data.error && !data.noData && !data.isWeekend) errors.push(`${c.name}: ${data.error}`);
      }).catch(err => errors.push(`${c.name}: unreachable`))
    )).then(() => setApiErrors(errors));

    fetch(`${API_URL}/morning-brief/trade-alerts/${d}`)
      .then(r => r.json())
      .then(data => {
        const activeIds = new Set((data.alerts || []).map(a => a.id));
        setAlerts(prev => {
          const updated = [...prev];
          // Add new alerts
          for (const a of (data.alerts || [])) {
            const existing = updated.findIndex(x => x.id === a.id);
            if (existing >= 0) {
              // Update the message with latest values but keep original firstSeen
              updated[existing] = { ...a, firstSeen: updated[existing].firstSeen, expired: false };
            } else {
              updated.push({ ...a, firstSeen: new Date().toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }), expired: false });
            }
          }
          // Mark expired alerts (were active, now gone)
          for (const a of updated) {
            if (!activeIds.has(a.id) && !a.expired && !a.dismissed) {
              a.expired = true;
              a.expiredAt = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
            }
          }
          return updated;
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchAlerts();
    const interval = setInterval(fetchAlerts, 15000);
    const sock = window._tradingSocket;
    if (sock) {
      sock.on('price-sync-progress', fetchAlerts);
      sock.on('setup-detected', fetchAlerts);
      sock.on('setup-state', fetchAlerts);
    }
    return () => {
      clearInterval(interval);
      if (sock) {
        sock.off('price-sync-progress', fetchAlerts);
        sock.off('setup-detected', fetchAlerts);
        sock.off('setup-state', fetchAlerts);
      }
    };
  }, [fetchAlerts]);

  const dismiss = (id) => {
    setDismissed(prev => new Set([...prev, id]));
  };

  const visible = alerts.filter(a => !dismissed.has(a.id));
  if (visible.length === 0 && apiErrors.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
      {apiErrors.map((err, i) => (
        <div key={`err-${i}`} style={{
          padding: '8px 12px', background: 'rgba(239,68,68,0.15)',
          border: '1px solid rgba(239,68,68,0.4)', borderLeft: '4px solid #ef4444',
          borderRadius: 6, fontSize: 12, color: '#fca5a5', fontWeight: 600,
        }}>
          SYSTEM ERROR: {err}
        </div>
      ))}
      {visible.map(a => (
        <div key={a.id} style={{
          padding: '8px 12px',
          background: a.expired ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.4)',
          border: `1px solid ${a.expired ? '#64748b40' : a.color + '40'}`,
          borderLeft: `4px solid ${a.expired ? '#ef4444' : a.color}`,
          opacity: a.expired ? 0.7 : 1,
          borderRadius: 6,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          animation: 'fadeIn 0.3s ease-in',
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
              <span style={{
                fontSize: 11, fontWeight: 800, color: a.color,
                background: `${a.color}20`, padding: '1px 6px', borderRadius: 3,
                textTransform: 'uppercase', letterSpacing: '0.04em'
              }}>
                {a.type.replace(/_/g, ' ')}
              </span>
              <span style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: 6 }}>
                {a.firstSeen}
                {a.expired && <span style={{ fontSize: 11, fontWeight: 800, color: '#ef4444', background: 'rgba(239,68,68,0.15)', padding: '1px 5px', borderRadius: 3, letterSpacing: '0.04em' }}>EXPIRED {a.expiredAt}</span>}
              </span>
            </div>
            <div style={{ fontSize: 12, color: '#e2e8f0', fontWeight: 600 }}>
              {a.msg}
            </div>
          </div>
          <button
            onClick={() => dismiss(a.id)}
            style={{
              background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer',
              fontSize: 16, padding: '0 4px', marginLeft: 8, lineHeight: 1,
            }}
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
