import React, { useEffect, useState } from 'react';
import { API_URL } from '../../constants/api.js';

// Setup Reference — what each setup IS (criteria, detection window, family) joined
// against what it's ACTUALLY DOING right now (live N/WR/EV/status). Built 2026-07-20
// after a session spent real time re-explaining the same handful of facts about window
// scope (RTH vs Globex-capable vs same-day-forming) that had never lived anywhere a
// person could read them. Criteria text: server/config/setupDefinitions.js (static).
// Numbers: always /api/setups/reference (live), never hand-typed here.
const S = {
  page: { padding: '20px 4px' },
  toolbar: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' },
  search: { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 6, padding: '7px 10px', color: '#e2e8f0', fontSize: 13, width: 260 },
  filterBtn: (active) => ({
    background: active ? 'rgba(167,139,250,0.15)' : '#0f172a', border: `1px solid ${active ? '#a78bfa' : '#1e293b'}`,
    borderRadius: 6, padding: '6px 12px', color: active ? '#c4b5fd' : '#94a3b8', fontSize: 12, fontWeight: 600, cursor: 'pointer',
  }),
  card: { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, marginBottom: 8, overflow: 'hidden' },
  head: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer' },
  name: { fontWeight: 700, color: '#e2e8f0', fontSize: 14, fontFamily: 'monospace' },
  badge: (color) => ({ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4, color, background: color + '22', border: `1px solid ${color}55` }),
  stat: { fontFamily: 'monospace', fontSize: 12, color: '#94a3b8' },
  body: { padding: '0 14px 14px 14px', fontSize: 12.5, color: '#cbd5e1', lineHeight: 1.6, borderTop: '1px solid #1e293b', marginTop: 0, paddingTop: 10 },
};

const REC_COLOR = { ACTIVE: '#4ade80', PROMOTE: '#4ade80', DAY_TYPE_MANAGED: '#22d3ee', THIN_N: '#64748b', SUPPRESS: '#f87171' };
const TREND_COLOR = { DEGRADING: '#f87171', IMPROVING: '#4ade80', NOISY_BUT_STABLE: '#94a3b8', STABLE: '#4ade80', AMBIGUOUS: '#fbbf24', THIN: '#64748b' };

export default function SetupReferenceView() {
  const [data, setData] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'); // all | live | globex | undocumented
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    fetch(`${API_URL}/setups/reference`).then(r => r.json()).then(d => { if (!d.error) setData(d); }).catch(() => {});
  }, []);

  if (!data) return <div style={{ padding: 20, color: '#94a3b8', fontSize: 13 }}>Loading…</div>;

  let rows = data.setups;
  if (filter === 'live') rows = rows.filter(r => !['SUPPRESS', 'THIN_N'].includes(r.recommendation));
  if (filter === 'globex') rows = rows.filter(r => r.globexCapable);
  if (filter === 'undocumented') rows = rows.filter(r => !r.documented);
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    rows = rows.filter(r => r.setupType.toLowerCase().includes(q) || r.displayName.toLowerCase().includes(q));
  }

  return (
    <div style={S.page}>
      <div style={{ fontSize: 13, color: '#64748b', marginBottom: 14 }}>
        {data.total} setup_types tracked — {data.undocumented} without a written definition yet (still shown, flagged below).
        Criteria/window text is static (rarely changes); every N/WR/EV/status number is live-queried.
      </div>
      <div style={S.toolbar}>
        <input style={S.search} placeholder="Search setup name…" value={search} onChange={e => setSearch(e.target.value)} />
        <button style={S.filterBtn(filter === 'all')} onClick={() => setFilter('all')}>All ({data.total})</button>
        <button style={S.filterBtn(filter === 'live')} onClick={() => setFilter('live')}>Currently live</button>
        <button style={S.filterBtn(filter === 'globex')} onClick={() => setFilter('globex')}>Globex-capable</button>
        <button style={S.filterBtn(filter === 'undocumented')} onClick={() => setFilter('undocumented')}>Undocumented ({data.undocumented})</button>
      </div>
      {rows.map(r => {
        const isOpen = expanded === r.setupType;
        return (
          <div key={r.setupType} style={S.card}>
            <div style={S.head} onClick={() => setExpanded(isOpen ? null : r.setupType)}>
              <span style={{ color: '#64748b', fontSize: 11, width: 12 }}>{isOpen ? '▾' : '▸'}</span>
              <span style={S.name}>{r.setupType}</span>
              <span style={{ color: '#64748b', fontSize: 12 }}>{r.displayName}</span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                {r.globexCapable && <span style={S.badge('#22d3ee')}>24HR</span>}
                {!r.documented && <span style={S.badge('#fbbf24')}>UNDOCUMENTED</span>}
                {r.rigorTrend && <span style={S.badge(TREND_COLOR[r.rigorTrend] || '#94a3b8')}>{r.rigorTrend}</span>}
                <span style={S.stat}>N={r.n}{r.realN != null ? ` (real=${r.realN})` : ''}</span>
                <span style={{ ...S.stat, color: r.ev >= 0 ? '#4ade80' : '#f87171', fontWeight: 700 }}>
                  {r.ev != null ? `$${r.ev.toFixed(2)}` : '--'}
                </span>
                <span style={S.badge(REC_COLOR[r.recommendation] || '#64748b')}>{r.recommendation || '--'}</span>
              </span>
            </div>
            {isOpen && (
              <div style={S.body}>
                {r.criteria ? (
                  <div style={{ marginBottom: 8 }}><strong style={{ color: '#e2e8f0' }}>Criteria: </strong>{r.criteria}</div>
                ) : (
                  <div style={{ marginBottom: 8, color: '#fbbf24' }}>No written definition yet for this setup_type — add one to server/config/setupDefinitions.js.</div>
                )}
                {r.windowDescription && (
                  <div style={{ marginBottom: 8 }}><strong style={{ color: '#e2e8f0' }}>Detection window: </strong>{r.windowDescription}</div>
                )}
                {r.family && <div style={{ marginBottom: 8 }}><strong style={{ color: '#e2e8f0' }}>Family: </strong>{r.family}</div>}
                <div style={{ display: 'flex', gap: 20, marginTop: 10, fontFamily: 'monospace', fontSize: 12 }}>
                  <span>WR: <strong style={{ color: '#e2e8f0' }}>{r.wr != null ? (r.wr * 100).toFixed(1) + '%' : '--'}</strong></span>
                  <span>Stop: <strong style={{ color: '#f87171' }}>{r.stop != null ? r.stop + 'pt' : '--'}</strong></span>
                  <span>Target: <strong style={{ color: '#4ade80' }}>{r.target != null ? r.target + 'pt' : '--'}</strong></span>
                  <span>Last calibrated: <strong style={{ color: '#94a3b8' }}>{r.lastRunDate || '--'}</strong></span>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {rows.length === 0 && <div style={{ padding: 20, color: '#64748b', fontSize: 13 }}>No setups match this filter.</div>}
    </div>
  );
}
