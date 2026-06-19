import React, { useState, useEffect } from 'react';

const API_URL = '/api';

function fmtDate(d) {
  const dt = new Date(d + 'T12:00:00');
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtPts(n) {
  const s = n % 1 === 0 ? n.toFixed(0) : n.toFixed(2).replace(/\.?0+$/, '');
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function InfoTooltip({ text, children }) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const ref = React.useRef(null);

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
    <span ref={ref} style={{ display: 'block', cursor: 'help' }}
      onMouseEnter={handleMouseEnter} onMouseLeave={() => setVisible(false)}
      onClick={() => setVisible(v => !v)}>
      {children}
      {visible && (
        <div style={{
          position: 'fixed', top: pos.top, left: pos.left,
          transform: 'translate(-50%, -100%)', marginTop: -6,
          width: 320, padding: '10px 13px', background: '#1a2535',
          border: '1px solid rgba(100,116,139,0.5)', borderRadius: 8, fontSize: 13,
          color: '#cbd5e1', boxShadow: '0 6px 20px rgba(0,0,0,0.7)',
          zIndex: 99999, pointerEvents: 'none', lineHeight: 1.7, whiteSpace: 'pre-line' }}>
          <div style={{ color: '#cbd5e1' }}>{text}</div>
        </div>
      )}
    </span>
  );
}

function GapRow({ gap, isLargest }) {
  const isUp = gap.type === 'up';
  const dirColor = isUp ? '#4ade80' : '#f87171';
  const dirLabel = isUp ? '▲ Gap Up' : '▼ Gap Down';

  // Determine how urgent / relevant this gap is
  const atEdge = gap.priceRelation === 'inside'
    || (isUp && gap.priceRelation === 'above' && gap.pctFilled > 0)
    || (!isUp && gap.priceRelation === 'below' && gap.pctFilled > 0);

  let statusColor, statusText;
  if (gap.priceRelation === 'inside') {
    statusColor = '#fb923c';
    statusText = 'Price inside gap — no support/resistance in this zone';
  } else if (isUp && gap.priceRelation === 'above') {
    statusColor = gap.pctFilled > 0 ? '#fb923c' : '#94a3b8';
    statusText = gap.pctFilled > 0
      ? `Partial fill (${gap.pctFilled}%) — ${fmtPts(gap.ptsRemaining)} pts remain to ${fmtPts(gap.gapLow)}`
      : `Unfilled — ${fmtPts(gap.gapHigh)} is gap ceiling, ${fmtPts(gap.gapLow)} is ultimate fill target`;
  } else if (isUp && gap.priceRelation === 'below') {
    statusColor = '#f87171';
    statusText = `Below gap — gap fill complete once price reclaims ${fmtPts(gap.gapLow)}`;
  } else if (!isUp && gap.priceRelation === 'below') {
    statusColor = gap.pctFilled > 0 ? '#fb923c' : '#94a3b8';
    statusText = gap.pctFilled > 0
      ? `Partial fill (${gap.pctFilled}%) — ${fmtPts(gap.ptsRemaining)} pts remain to ${fmtPts(gap.gapHigh)}`
      : `Unfilled — ${fmtPts(gap.gapLow)} is gap floor, ${fmtPts(gap.gapHigh)} is ultimate fill target`;
  } else {
    statusColor = '#f87171';
    statusText = `Above gap — gap fill complete once price drops to ${fmtPts(gap.gapHigh)}`;
  }

  // Tactical bias line
  let biasText = null;
  if (gap.priceRelation === 'inside') {
    biasText = isUp
      ? `Void: fast travel expected toward ${fmtPts(gap.gapLow)}. No support until gap bottom.`
      : `Void: fast travel expected toward ${fmtPts(gap.gapHigh)}. No resistance until gap top.`;
  } else if (isUp && gap.priceRelation === 'above' && gap.pctFilled > 0) {
    biasText = `Tested gap top. Short bias toward ${fmtPts(gap.gapLow)} if ${fmtPts(gap.gapHigh)} fails again. Longs risky inside void.`;
  } else if (isUp && gap.priceRelation === 'above' && gap.pctFilled === 0) {
    biasText = `Below ${fmtPts(gap.gapHigh)} risks fast drop to ${fmtPts(gap.gapLow)} (${fmtPts(gap.gapSize)} pt void, no stops).`;
  }

  const isInside = gap.priceRelation === 'inside';

  const warningText = isInside
    ? `NQ has entered the ${isUp ? 'up' : 'down'}-gap void from ${fmtDate(gap.fromDate)} to ${fmtDate(gap.toDate)} (${fmtPts(gap.gapLow)}–${fmtPts(gap.gapHigh)}). Expect fast travel toward ${isUp ? fmtPts(gap.gapLow) : fmtPts(gap.gapHigh)} (no structural support/resistance inside the void).`
    : null;

  const rowContent = (
    <div style={{
      paddingLeft: 10,
      marginBottom: 10,
      opacity: gap.sessionAge > 20 && gap.gapSize < 50 ? 0.65 : 1,
      background: isInside ? (isUp ? 'rgba(74, 222, 128, 0.08)' : 'rgba(248, 113, 113, 0.08)') : 'transparent',
      border: isInside ? `1.5px dashed ${isUp ? 'rgba(74, 222, 128, 0.4)' : 'rgba(248, 113, 113, 0.4)'}` : 'none',
      borderLeft: `3px solid ${dirColor}`,
      borderRadius: isInside ? 6 : 0,
      padding: isInside ? '8px 12px' : '2px 0 2px 10px',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 3 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: dirColor }}>{dirLabel}</span>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>{fmtDate(gap.fromDate)} → {fmtDate(gap.toDate)}</span>
        <span style={{ fontSize: 10, color: '#64748b' }}>({gap.sessionAge} {gap.sessionAge === 1 ? 'session' : 'sessions'} ago)</span>
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 3 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>
          {fmtPts(gap.gapLow)} – {fmtPts(gap.gapHigh)}
        </span>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>{fmtPts(gap.gapSize)} pts</span>
        {gap.pctFilled > 0 && (
          <span style={{ fontSize: 11, color: '#fb923c' }}>{gap.pctFilled}% filled</span>
        )}
      </div>
      <div style={{ fontSize: 11, color: statusColor, marginBottom: biasText ? 3 : 0 }}>{statusText}</div>
      {biasText && (
        <div style={{ fontSize: 11, color: '#64748b', fontStyle: 'italic' }}>{biasText}</div>
      )}
    </div>
  );

  if (isInside && warningText) {
    return <InfoTooltip text={warningText}>{rowContent}</InfoTooltip>;
  }
  return rowContent;
}

export default function GapContextCard() {
  const [data, setData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(`${API_URL}/acd/gap-context`)
        .then(r => r.json())
        .then(d => !cancelled && setData(d))
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 120000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!data) return null;
  if (!data.gaps || data.gaps.length === 0) return null;

  // Sort: inside > partial fill > large > recent
  const sorted = [...data.gaps].sort((a, b) => {
    const prioA = a.priceRelation === 'inside' ? 0 : a.pctFilled > 0 ? 1 : 2;
    const prioB = b.priceRelation === 'inside' ? 0 : b.pctFilled > 0 ? 1 : 2;
    if (prioA !== prioB) return prioA - prioB;
    return b.gapSize - a.gapSize;
  });

  const largestGap = sorted.reduce((mx, g) => g.gapSize > mx.gapSize ? g : mx, sorted[0]);

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>
        Open RTH Gaps <span style={{ fontWeight: 400, color: '#475569' }}>({sorted.length} unfilled)</span>
      </div>
      {sorted.map((gap, i) => (
        <GapRow key={`${gap.fromDate}-${gap.toDate}`} gap={gap} isLargest={gap === largestGap} />
      ))}
      {data.currentPrice && (
        <div style={{ fontSize: 10, color: '#475569', marginTop: 4, borderTop: '1px solid #1e293b', paddingTop: 6 }}>
          Current price: {data.currentPrice.toLocaleString()}
        </div>
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
  marginBottom: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};
