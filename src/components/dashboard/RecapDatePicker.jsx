import React from 'react';

export default function RecapDatePicker({ value, onChange, dailyPerf }) {
  const [open, setOpen] = React.useState(false);
  const [viewDate, setViewDate] = React.useState(() => {
    const d = value ? new Date(value + 'T12:00:00') : new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const ref = React.useRef(null);

  // Build a map of date → pnl from dailyPerf
  const pnlMap = React.useMemo(() => {
    const m = {};
    (dailyPerf || []).forEach(d => { if (d.log_date) m[d.log_date] = parseFloat(d.daily_pnl || d.pnl || 0); });
    return m;
  }, [dailyPerf]);

  React.useEffect(() => {
    if (!open) return;
    const close = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  React.useEffect(() => {
    if (value) {
      const d = new Date(value + 'T12:00:00');
      setViewDate({ year: d.getFullYear(), month: d.getMonth() });
    }
  }, [value]);

  const { year, month } = viewDate;
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthLabel = new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const pad = n => String(n).padStart(2, '0');
  const today = new Date().toLocaleDateString('en-CA');

  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${year}-${pad(month + 1)}-${pad(d)}`);

  const displayLabel = value
    ? new Date(value + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Select date';

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ fontSize: 13, padding: '3px 10px', borderRadius: 5, border: '1px solid var(--border-color)', background: '#0d1117', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
        {displayLabel} <span style={{ fontSize: 13 }}>▾</span>
      </button>
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 1000, background: '#0f1724', border: '1px solid var(--border-color)', borderRadius: 10, padding: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.5)', minWidth: 220 }}>
          {/* Month nav */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <button onClick={() => setViewDate(v => { const d = new Date(v.year, v.month - 1); return { year: d.getFullYear(), month: d.getMonth() }; })}
              style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 14, padding: '2px 6px' }}>‹</button>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{monthLabel}</span>
            <button onClick={() => setViewDate(v => { const d = new Date(v.year, v.month + 1); return { year: d.getFullYear(), month: d.getMonth() }; })}
              style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 14, padding: '2px 6px' }}>›</button>
          </div>
          {/* Day headers */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2, marginBottom: 4 }}>
            {['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => (
              <div key={d} style={{ textAlign: 'center', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>{d}</div>
            ))}
          </div>
          {/* Day cells */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2 }}>
            {cells.map((dateStr, i) => {
              if (!dateStr) return <div key={`e${i}`} />;
              const pnl = pnlMap[dateStr];
              const hasTrade = pnl !== undefined;
              const isSelected = dateStr === value;
              const isToday = dateStr === today;
              const bg = isSelected ? 'var(--accent-purple)'
                : hasTrade && pnl > 0 ? 'rgba(16,185,129,0.18)'
                : hasTrade && pnl < 0 ? 'rgba(239,68,68,0.18)'
                : hasTrade ? 'rgba(100,116,139,0.15)'
                : 'transparent';
              const border = isSelected ? '1px solid var(--accent-purple)'
                : isToday ? '1px solid rgba(139,92,246,0.5)'
                : hasTrade && pnl > 0 ? '1px solid rgba(16,185,129,0.3)'
                : hasTrade && pnl < 0 ? '1px solid rgba(239,68,68,0.3)'
                : '1px solid transparent';
              return (
                <div key={dateStr} onClick={() => { onChange(dateStr); setOpen(false); }}
                  title={hasTrade ? `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}` : ''}
                  style={{ textAlign: 'center', padding: '4px 2px', borderRadius: 4, cursor: 'pointer', fontSize: 13,
                    background: bg, border, color: isSelected ? '#fff' : hasTrade ? 'var(--text-primary)' : 'var(--text-muted)',
                    fontWeight: isSelected || hasTrade ? 600 : 400 }}>
                  {parseInt(dateStr.split('-')[2])}
                </div>
              );
            })}
          </div>
          {/* Today button */}
          <div style={{ marginTop: 8, textAlign: 'center' }}>
            <button onClick={() => { onChange(today); setViewDate({ year: new Date().getFullYear(), month: new Date().getMonth() }); setOpen(false); }}
              style={{ fontSize: 13, background: 'none', border: '1px solid var(--border-color)', borderRadius: 4, color: 'var(--text-muted)', cursor: 'pointer', padding: '2px 10px' }}>Today</button>
          </div>
        </div>
      )}
    </div>
  );
}
