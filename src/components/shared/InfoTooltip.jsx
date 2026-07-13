import React from 'react';

export default function InfoTooltip({ text, tooltip, children }) {
  const [visible, setVisible] = React.useState(false);
  const [pos, setPos] = React.useState({ top: 0, left: 0 });
  const ref = React.useRef(null);

  const content = tooltip || (text ? { text } : null);
  if (!content) return children || null;

  const handleMouseEnter = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      const tooltipWidth = 320;
      const left = Math.min(
        Math.max(tooltipWidth / 2 + 8, rect.left + rect.width / 2),
        window.innerWidth - tooltipWidth / 2 - 8
      );
      setPos({ top: rect.top - 8, left });
    }
    setVisible(true);
  };

  return (
    <span ref={ref} style={{ display: 'inline-block', marginLeft: children ? 0 : 4, verticalAlign: 'middle', flexShrink: 0 }}
      onMouseEnter={handleMouseEnter} onMouseLeave={() => setVisible(false)}
      onClick={() => setVisible(v => !v)}>
      {children ? children : (
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 14, height: 14, borderRadius: '50%', fontSize: 11, fontWeight: 700,
          background: 'rgba(100,116,139,0.2)', color: 'var(--text-muted)',
          border: '1px solid rgba(100,116,139,0.35)', cursor: 'help', lineHeight: 1 }}>i</span>
      )}
      {visible && (
        <div style={{
          position: 'fixed', top: pos.top, left: pos.left,
          transform: 'translate(-50%, -100%)', marginTop: -6,
          width: 320, padding: '10px 13px', background: '#1a2535',
          border: '1px solid rgba(100,116,139,0.5)', borderRadius: 8, fontSize: 13,
          color: '#94a3b8', boxShadow: '0 6px 20px rgba(0,0,0,0.7)',
          zIndex: 99999, pointerEvents: 'none', lineHeight: 1.7, whiteSpace: 'pre-line' }}>
          <div style={{ color: '#cbd5e1' }}>{content.text}</div>
          {content.source && (
            <div style={{ marginTop: 6, fontSize: 13, color: '#94a3b8', borderTop: '1px solid rgba(100,116,139,0.2)', paddingTop: 5 }}>
              Source: {content.source}
            </div>
          )}
          {content.example && (
            <div style={{ marginTop: 4, fontSize: 13, color: '#94a3b8', fontStyle: 'italic' }}>
              Example: {content.example}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
