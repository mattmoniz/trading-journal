import React, { useState, useEffect } from 'react';

import { API_URL } from '../../constants/api.js';

const CATEGORY_ORDER = ['CURRENT', 'PRIOR_DAY', 'OVERNIGHT', 'OPENS', 'VWAP', 'PIVOT', 'WEEKLY', 'MONTHLY', 'QUARTERLY'];
const CATEGORY_LABELS = {
  CURRENT:   'Session (Today)',
  PRIOR_DAY: 'Prior Day',
  OVERNIGHT: 'Overnight',
  OPENS:     'Opens',
  VWAP:      'VWAP',
  PIVOT:     'Floor Pivots',
  WEEKLY:    'Prior Week',
  MONTHLY:   'Prior Month',
  QUARTERLY: '3-Month',
};

function proximityClass(dist) {
  if (dist == null) return '';
  if (dist <= 5)  return 'at-level';
  if (dist <= 25) return 'near-level';
  return 'far-level';
}

export default function LevelMonitorPanel({ date }) {
  const [levels, setLevels] = useState([]);
  const [currentPrice, setCurrentPrice] = useState(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState({});

  const targetDate = date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  useEffect(() => {
    if (!targetDate) return;
    setLoading(true);
    fetch(`${API_URL}/level-prices/${targetDate}`)
      .then(r => r.json())
      .then(j => setLevels(j.levels || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [targetDate]);

  // Pull current price from live-day endpoint (close of last bar)
  useEffect(() => {
    fetch(`${API_URL}/chart/live-day?date=${targetDate}`)
      .then(r => r.json())
      .then(j => {
        const bars = j.bars || [];
        if (bars.length) setCurrentPrice(parseFloat(bars[bars.length - 1].close));
      })
      .catch(() => {});
  }, [targetDate]);

  const grouped = CATEGORY_ORDER.reduce((acc, cat) => {
    acc[cat] = levels.filter(l => l.category === cat).sort((a, b) => b.price - a.price);
    return acc;
  }, {});

  const withDist = (lvls) => lvls.map(l => ({
    ...l,
    dist: currentPrice != null ? Math.abs(currentPrice - l.price) : null,
  }));

  const toggleCat = (cat) => setCollapsed(c => ({ ...c, [cat]: !c[cat] }));

  return (
    <div className="level-monitor-panel card">
      <div className="panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>MGI Level Monitor</h3>
        <span style={{ fontSize: '0.8rem', color: '#888' }}>
          {targetDate}
          {currentPrice && <span style={{ marginLeft: 8, color: '#aaa' }}>Last: {currentPrice.toFixed(2)}</span>}
          {!levels.length && !loading && <span style={{ marginLeft: 8, color: '#f59e0b' }}> — run compute_levels.js for this date</span>}
        </span>
      </div>

      {loading && <div style={{ padding: '12px', color: '#888', fontSize: '0.85rem' }}>Loading levels…</div>}

      {!loading && CATEGORY_ORDER.map(cat => {
        const rows = withDist(grouped[cat] || []);
        if (!rows.length) return null;
        const isOpen = !collapsed[cat];
        return (
          <div key={cat} className="level-category">
            <div
              className="level-category-header"
              onClick={() => toggleCat(cat)}
              style={{ cursor: 'pointer', userSelect: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 12px', background: 'rgba(255,255,255,0.04)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
            >
              <span style={{ fontWeight: 600, fontSize: '0.78rem', letterSpacing: '0.05em', textTransform: 'uppercase', color: '#94a3b8' }}>
                {CATEGORY_LABELS[cat] || cat}
              </span>
              <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>{isOpen ? '▾' : '▸'} {rows.length}</span>
            </div>
            {isOpen && (
              <div className="level-rows">
                {rows.map(l => (
                  <div
                    key={l.level_name}
                    className={`level-row ${proximityClass(l.dist)}`}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr auto auto',
                      gap: '8px',
                      padding: '5px 12px',
                      borderBottom: '1px solid rgba(255,255,255,0.03)',
                      fontSize: '0.82rem',
                      alignItems: 'center',
                    }}
                  >
                    <span style={{ color: l.dist != null && l.dist <= 5 ? '#4ade80' : l.dist != null && l.dist <= 25 ? '#fbbf24' : '#94a3b8' }}>
                      {l.level_name}
                    </span>
                    <span style={{ fontVariantNumeric: 'tabular-nums', color: '#e2e8f0' }}>
                      {l.price?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    <span style={{ fontVariantNumeric: 'tabular-nums', color: l.dist != null && l.dist <= 5 ? '#4ade80' : l.dist != null && l.dist <= 25 ? '#fbbf24' : '#475569', minWidth: '52px', textAlign: 'right' }}>
                      {l.dist != null ? `${l.dist <= 5 ? '★ ' : ''}${l.dist.toFixed(1)}pt` : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <style>{`
        .level-monitor-panel { margin-bottom: 16px; }
        .level-monitor-panel .panel-header { padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); }
        .level-row.at-level { background: rgba(74, 222, 128, 0.06); }
        .level-row.near-level { background: rgba(251, 191, 36, 0.04); }
      `}</style>
    </div>
  );
}
