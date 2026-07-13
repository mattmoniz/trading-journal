import React from 'react';
import FetchStamp from './FetchStamp.jsx';
import { useDataUpdateDot, Dot } from './UpdateDot.jsx';

export default function CollapsibleSection({ title, defaultOpen = false, children, badge, updatedAt, fetchedAt, updateId, updateView, dataSignature }) {
  const [open, setOpen] = React.useState(defaultOpen);
  const lastSeenAt = React.useRef(defaultOpen ? updatedAt : null);
  const openedWithNew = React.useRef(false);

  const showUpdated = !open && !!updatedAt && updatedAt !== lastSeenAt.current;

  const [updateUnseen, clearUpdateSeen] = useDataUpdateDot(updateId || 'unused', updateView || 'unused', dataSignature);

  const handleToggle = () => {
    if (!open) {
      if (updatedAt && updatedAt !== lastSeenAt.current) openedWithNew.current = true;
      if (updateId) clearUpdateSeen();
    } else {
      if (openedWithNew.current) {
        lastSeenAt.current = updatedAt;
        openedWithNew.current = false;
      }
    }
    setOpen(o => !o);
  };

  return (
    <div style={{ marginBottom: 8 }}>
      <button onClick={handleToggle}
        style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '10px 16px', background: open ? 'var(--card-bg)' : 'rgba(15,23,42,0.4)',
          border: `1px solid ${showUpdated ? 'rgba(99,102,241,0.45)' : 'var(--border-color)'}`,
          borderRadius: open ? '8px 8px 0 0' : 8,
          cursor: 'pointer', fontFamily: 'Arial, sans-serif' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: open ? '#94a3b8' : '#94a3b8', letterSpacing: '0.05em', textTransform: 'uppercase' }}>{title}{!open && updateId && updateUnseen && <Dot />}</span>
          {fetchedAt && <FetchStamp at={fetchedAt} />}
          {badge && <span style={{ fontSize: 13, padding: '1px 7px', borderRadius: 4, background: badge.bg, color: badge.color, fontWeight: 700 }}>{badge.text}</span>}
          {showUpdated && (
            <span style={{ fontSize: 13, padding: '1px 7px', borderRadius: 4, background: 'rgba(99,102,241,0.15)', color: '#818cf8', fontWeight: 600, fontFamily: 'monospace' }}>
              updated {updatedAt}
            </span>
          )}
        </div>
        <span style={{ color: '#94a3b8', fontSize: 13 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ border: '1px solid var(--border-color)', borderTop: 'none', borderRadius: '0 0 8px 8px', padding: '12px 0 4px' }}>
          {children}
        </div>
      )}
    </div>
  );
}
