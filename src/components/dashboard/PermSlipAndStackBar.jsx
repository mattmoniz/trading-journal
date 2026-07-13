import React, { useState, useEffect } from 'react';

const API_URL = '/api';
const MAX_STACK = 7;

function barColor(n) {
  return n >= MAX_STACK ? '#ef4444' : n >= 4 ? '#f97316' : '#4ade80';
}

export default function PermSlipAndStackBar() {
  const [perms,    setPerms]    = useState(null);
  const [setups,   setSetups]   = useState(null);
  const [resolved, setResolved] = useState([]);

  useEffect(() => {
    const load = () =>
      fetch(`${API_URL}/antigravity/edges-context`)
        .then(r => r.json())
        .then(d => {
          setPerms(d.sessionPermissions || null);
          setSetups(d.setups || null);
        })
        .catch(() => {});
    load();
    const iv = setInterval(load, 60000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    const load = () =>
      fetch(`${API_URL}/setups/today`)
        .then(r => r.json())
        .then(d => {
          if (Array.isArray(d.setups))
            setResolved(d.setups.filter(s => ['RESOLVED', 'EXPIRED'].includes(s.status)));
        })
        .catch(() => {});
    load();
    const iv = setInterval(load, 60000);
    return () => clearInterval(iv);
  }, []);

  const hasPerms = perms?.conditions?.length > 0;
  if (!hasPerms && !setups) return null;

  const activeList  = setups?.list || [];
  const longTotal   = activeList.filter(s => s.direction === 'LONG').length
                    + resolved.filter(s => s.direction === 'LONG'  || s.setup_type?.endsWith('_LONG')).length;
  const shortTotal  = activeList.filter(s => s.direction === 'SHORT').length
                    + resolved.filter(s => s.direction === 'SHORT' || s.setup_type?.endsWith('_SHORT')).length;

  return (
    <div style={{
      display: 'flex', gap: 8, padding: '0 20px 6px',
      fontFamily: 'Arial, sans-serif', fontSize: 12,
    }}>

      {/* Permission Slip */}
      {hasPerms && (
        <div style={{
          flex: 1, padding: '6px 10px',
          background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.18)',
          borderRadius: 5,
        }}>
          <div style={{ fontSize: 11, color: '#6ee7b7', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>
            Permission Slip
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {perms.conditions.map((c, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>{c.label}</span>
                <span style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                  <span style={{ fontSize: 14, fontWeight: 800, color: c.dir === 'LONG' ? '#22c55e' : '#ef4444' }}>{c.pct}%</span>
                  <span style={{ fontSize: 11, color: '#64748b' }}>closes {c.dir} · N={c.n}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Fade Stacking */}
      <div style={{
        flex: 1, padding: '6px 10px',
        background: 'rgba(10,18,35,0.5)', border: '1px solid rgba(51,65,85,0.3)',
        borderRadius: 5,
      }}>
        <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 5 }}>
          Fade Stacking · suppress at {MAX_STACK}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {[['LONG', longTotal], ['SHORT', shortTotal]].map(([label, count]) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontSize: 11, color: '#94a3b8', width: 34, fontWeight: 700, letterSpacing: '0.06em' }}>{label}</span>
              <div style={{ flex: 1, height: 5, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min(count / MAX_STACK * 100, 100)}%`, background: barColor(count), borderRadius: 3, transition: 'width 0.4s' }} />
              </div>
              <span style={{ fontSize: 12, fontWeight: 700, fontFamily: 'monospace', color: barColor(count), width: 14 }}>{count}</span>
              {count >= MAX_STACK && <span style={{ fontSize: 11, fontWeight: 800, color: '#ef4444', letterSpacing: '0.07em' }}>SUPPRESS</span>}
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}
