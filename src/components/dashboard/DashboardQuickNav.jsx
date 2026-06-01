import React from 'react';

const NAV_ITEMS = [
  { label: 'P&L Charts', id: 'section-pnl' },
  { label: 'By Hour', id: 'section-hour' },
  { label: 'By Day', id: 'section-dow' },
  { label: 'Symbols', id: 'section-symbols' },
  { label: 'Setups', id: 'section-setups' },
  { label: 'Optimization', id: 'section-optimization' },
  { label: 'Behavior', id: 'section-behavior' },
];

export default function DashboardQuickNav() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '12px 0 20px', borderBottom: '1px solid var(--border-color)', paddingBottom: 14 }}>
      {NAV_ITEMS.map(({ label, id }) => (
        <button key={id} onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          style={{ fontSize: 13, padding: '4px 12px', borderRadius: 20, cursor: 'pointer', border: '1px solid var(--border-color)',
            background: 'var(--card-bg)', color: 'var(--text-secondary)', transition: 'all 0.15s' }}
          onMouseEnter={e => { e.target.style.borderColor = 'var(--accent-purple)'; e.target.style.color = 'var(--accent-purple)'; }}
          onMouseLeave={e => { e.target.style.borderColor = 'var(--border-color)'; e.target.style.color = 'var(--text-secondary)'; }}>
          {label}
        </button>
      ))}
    </div>
  );
}
