import React, { useEffect, useState } from 'react';
import { API_URL } from '../../constants/api.js';

// Setup Reference — what each setup IS (criteria, detection window, family) joined
// against what it's ACTUALLY DOING right now (live N/WR/EV/status, plus Key-Levels-style
// touch/MFE/MAE/P&L metrics). Built 2026-07-20, rebuilt as a sortable table 2026-07-28
// per direct user request to match the Key Levels table's format (BacktestView.jsx's
// flat sortable table with Level/Touches/MFE P50/P75/MAE P50/Avg P&L/Left on table
// columns) rather than an accordion of cards. Criteria text: server/config/
// setupDefinitions.js (static). Numbers: always /api/setups/reference (live), never
// hand-typed here.
const REC_COLOR = { ACTIVE: '#4ade80', PROMOTE: '#4ade80', DAY_TYPE_MANAGED: '#22d3ee', THIN_N: '#64748b', SUPPRESS: '#f87171', NOT_YET_CALIBRATED: '#64748b' };
const TREND_COLOR = { DEGRADING: '#f87171', IMPROVING: '#4ade80', NOISY_BUT_STABLE: '#94a3b8', STABLE: '#4ade80', AMBIGUOUS: '#fbbf24', THIN: '#64748b' };

const COLS = [
  { key: 'setupType', label: 'Setup', align: 'left' },
  { key: 'recommendation', label: 'Status', align: 'left' },
  { key: 'n', label: 'N', align: 'right', tip: 'Blended sample size (SETUP_STATUS). "real" shown alongside is genuinely live-detected only — see the Setup Log for why these can differ a lot.' },
  { key: 'wr', label: 'WR', align: 'right' },
  { key: 'ev', label: 'EV', align: 'right', tip: 'Expected value per trade, dollars' },
  { key: 'stop', label: 'Stop', align: 'right', tip: 'Calibrated stop, points' },
  { key: 'target', label: 'Target', align: 'right', tip: 'Calibrated target, points' },
  { key: 'mfeP50', label: 'MFE P50', align: 'right', tip: 'Median max favorable excursion in points, once resolved. Real-only when real N≥5, else blended (marked).' },
  { key: 'mfeP75', label: 'MFE P75', align: 'right', tip: '75th percentile MFE — a more conservative target reference.' },
  { key: 'maeP50', label: 'MAE P50', align: 'right', tip: 'Median max adverse excursion in points, once resolved.' },
  { key: 'avgPnl', label: 'Avg P&L', align: 'right', tip: 'Average realized $ P&L per resolved trade.' },
  { key: 'leftOnTablePts', label: 'Left on Table', align: 'right', tip: 'MFE P50 minus the realized favorable move (converted to points) — positive means the calibrated exit is leaving real available movement unclaimed.' },
  { key: 'totalPnlRealAllTime', label: 'All-Time $ (Real)', align: 'right', tip: 'Cumulative realized $ P&L, real (ACTIVE/SHADOW-origin) trades only — never includes synthetic backfill.' },
  { key: 'touchesTotal', label: 'Touches', align: 'right', tip: 'Total rows ever recorded for this setup_type — blended, includes synthetic backfill. Check the Setup Log\'s origin filter for the real breakdown.' },
  { key: 'touchesThisWeek', label: 'This Week', align: 'right', tip: 'Touches so far this calendar week (Mon-Sun ET) — resets automatically each week.' },
  { key: 'lastTouch', label: 'Last Touch', align: 'right', tip: 'Timestamp of the most recent touch recorded for this setup_type — a live freshness check that the system is still updating.' },
  { key: 'appliedVolZ', label: 'Applied volZ', align: 'left', tip: 'Live volume-Z-score / one-sided-ratio / cluster-size thresholds currently gating this setup, where applicable (currently STACK_VOL_BREAK_LIVE only).' },
  { key: 'rigorTrend', label: 'Stability', align: 'left' },
];

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}

export default function SetupReferenceView() {
  const [data, setData] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'); // all | live | globex | undocumented
  const [expanded, setExpanded] = useState(null);
  const [sort, setSort] = useState({ col: 'ev', dir: 'desc' });

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

  const sorted = [...rows].sort((a, b) => {
    let av = a[sort.col], bv = b[sort.col];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') { av = av.toLowerCase(); bv = bv.toLowerCase(); }
    if (av < bv) return sort.dir === 'asc' ? -1 : 1;
    if (av > bv) return sort.dir === 'asc' ? 1 : -1;
    return 0;
  });

  const toggleSort = (col) => setSort(s => ({ col, dir: s.col === col && s.dir === 'desc' ? 'asc' : 'desc' }));

  const thStyle = (col) => ({
    padding: '8px 10px', textAlign: col.align, fontWeight: 600, fontSize: 11.5, whiteSpace: 'nowrap',
    color: sort.col === col.key ? '#a78bfa' : '#94a3b8', cursor: 'pointer', userSelect: 'none',
    textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '2px solid #1e293b',
  });
  const tdStyle = { padding: '7px 10px', fontSize: 12.5, color: '#cbd5e1', borderBottom: '1px solid rgba(51,65,85,0.25)', whiteSpace: 'nowrap' };

  const renderCell = (r, col) => {
    switch (col.key) {
      case 'setupType': {
        const isLong = r.setupType.includes('LONG') || r.setupType.includes('BULLISH');
        const isShort = r.setupType.includes('SHORT') || r.setupType.includes('BEARISH');
        const dirColor = isLong ? '#4ade80' : isShort ? '#f87171' : '#94a3b8';
        return (
          <td key={col.key} style={{ ...tdStyle, textAlign: 'left' }}>
            <span style={{ color: '#64748b', fontSize: 11, marginRight: 4, cursor: 'pointer' }}
              onClick={() => setExpanded(expanded === r.setupType ? null : r.setupType)}>
              {expanded === r.setupType ? '▾' : '▸'}
            </span>
            <span style={{ color: dirColor, fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>{r.setupType}</span>
            {r.globexCapable && <span title="24hr / Globex-capable" style={{ marginLeft: 5, fontSize: 9.5, fontWeight: 800, color: '#22d3ee', background: 'rgba(34,211,238,0.12)', padding: '1px 4px', borderRadius: 3 }}>24HR</span>}
            {!r.documented && <span title="No written definition yet" style={{ marginLeft: 5, fontSize: 9.5, fontWeight: 800, color: '#fbbf24', background: 'rgba(251,191,36,0.12)', padding: '1px 4px', borderRadius: 3 }}>UNDOC</span>}
          </td>
        );
      }
      case 'recommendation':
        return <td key={col.key} style={{ ...tdStyle, textAlign: 'left' }}><span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 6px', borderRadius: 4, color: REC_COLOR[r.recommendation] || '#64748b', background: (REC_COLOR[r.recommendation] || '#64748b') + '1e' }}>{r.recommendation || '—'}</span></td>;
      case 'n':
        return <td key={col.key} style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace' }}>{r.n ?? '—'}{r.realN != null ? <span style={{ color: '#64748b', fontSize: 10.5 }}> ({r.realN} real)</span> : ''}</td>;
      case 'wr':
        return <td key={col.key} style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace' }}>{r.wr != null ? `${(r.wr * 100).toFixed(1)}%` : '—'}</td>;
      case 'ev':
        return <td key={col.key} style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', color: r.ev == null ? '#64748b' : r.ev >= 0 ? '#4ade80' : '#f87171', fontWeight: 700 }}>{r.ev != null ? `$${r.ev.toFixed(2)}` : '—'}</td>;
      case 'stop':
        return <td key={col.key} style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', color: '#f87171' }}>{r.stop != null ? `${r.stop}pt` : '—'}</td>;
      case 'target':
        return <td key={col.key} style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', color: '#4ade80' }}>{r.target != null ? `${r.target}pt` : '—'}</td>;
      case 'mfeP50':
        return <td key={col.key} style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', color: '#a78bfa' }}>{r.mfeP50 ?? '—'}{r.usingBlendedStats ? <span title="Real N<5 — showing blended (incl. backfill)" style={{ color: '#fbbf24', marginLeft: 3, fontSize: 10 }}>†</span> : ''}</td>;
      case 'mfeP75':
        return <td key={col.key} style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace' }}>{r.mfeP75 ?? '—'}</td>;
      case 'maeP50':
        return <td key={col.key} style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', color: '#f87171' }}>{r.maeP50 ?? '—'}</td>;
      case 'avgPnl':
        return <td key={col.key} style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', color: r.avgPnl == null ? '#64748b' : r.avgPnl >= 0 ? '#4ade80' : '#f87171' }}>{r.avgPnl != null ? `${r.avgPnl >= 0 ? '+' : ''}$${r.avgPnl.toFixed(2)}` : '—'}</td>;
      case 'leftOnTablePts':
        return <td key={col.key} style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', color: r.leftOnTablePts == null ? '#64748b' : r.leftOnTablePts > 5 ? '#f59e0b' : '#94a3b8' }}>{r.leftOnTablePts != null ? `${r.leftOnTablePts > 0 ? '+' : ''}${r.leftOnTablePts}pt` : '—'}</td>;
      case 'totalPnlRealAllTime':
        return <td key={col.key} style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', color: r.totalPnlRealAllTime == null ? '#64748b' : r.totalPnlRealAllTime >= 0 ? '#4ade80' : '#f87171' }}>{r.totalPnlRealAllTime != null ? `${r.totalPnlRealAllTime >= 0 ? '+' : ''}$${r.totalPnlRealAllTime.toFixed(2)}` : '—'}</td>;
      case 'touchesTotal':
        return <td key={col.key} style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace' }}>{r.touchesTotal.toLocaleString()}</td>;
      case 'touchesThisWeek':
        return <td key={col.key} style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', color: r.touchesThisWeek > 0 ? '#e2e8f0' : '#64748b' }}>{r.touchesThisWeek}</td>;
      case 'lastTouch':
        return <td key={col.key} style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', fontSize: 11.5, color: '#94a3b8' }}>{fmtTime(r.lastTouch)}</td>;
      case 'appliedVolZ':
        return <td key={col.key} style={{ ...tdStyle, textAlign: 'left', fontSize: 11, color: r.appliedVolZ ? '#67e8f9' : '#475569', whiteSpace: 'normal' }}>{r.appliedVolZ || '—'}</td>;
      case 'rigorTrend':
        return <td key={col.key} style={{ ...tdStyle, textAlign: 'left' }}>{r.rigorTrend ? <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 6px', borderRadius: 4, color: TREND_COLOR[r.rigorTrend] || '#94a3b8', background: (TREND_COLOR[r.rigorTrend] || '#94a3b8') + '1e' }}>{r.rigorTrend}</span> : '—'}</td>;
      default:
        return <td key={col.key} style={tdStyle}>—</td>;
    }
  };

  const filterBtn = (active) => ({
    background: active ? 'rgba(167,139,250,0.15)' : '#0f172a', border: `1px solid ${active ? '#a78bfa' : '#1e293b'}`,
    borderRadius: 6, padding: '6px 12px', color: active ? '#c4b5fd' : '#94a3b8', fontSize: 12, fontWeight: 600, cursor: 'pointer',
  });

  return (
    <div style={{ padding: '20px 4px' }}>
      <div style={{ fontSize: 13, color: '#64748b', marginBottom: 14 }}>
        {data.total} setup_types tracked — {data.undocumented} without a written definition yet (still shown, flagged UNDOC).
        Criteria/window text is static (rarely changes); every N/WR/EV/touch/MFE/MAE/P&L number is live-queried. Click a row to expand criteria. Click a column header to sort.
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <input style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 6, padding: '7px 10px', color: '#e2e8f0', fontSize: 13, width: 260 }}
          placeholder="Search setup name…" value={search} onChange={e => setSearch(e.target.value)} />
        <button style={filterBtn(filter === 'all')} onClick={() => setFilter('all')}>All ({data.total})</button>
        <button style={filterBtn(filter === 'live')} onClick={() => setFilter('live')}>Currently live</button>
        <button style={filterBtn(filter === 'globex')} onClick={() => setFilter('globex')}>Globex-capable</button>
        <button style={filterBtn(filter === 'undocumented')} onClick={() => setFilter('undocumented')}>Undocumented ({data.undocumented})</button>
      </div>

      <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                {COLS.map(col => (
                  <th key={col.key} title={col.tip} onClick={() => toggleSort(col.key)} style={thStyle(col)}>
                    {col.label}{sort.col === col.key ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => {
                const isOpen = expanded === r.setupType;
                return (
                  <React.Fragment key={r.setupType}>
                    <tr style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.012)' }}>
                      {COLS.map(col => renderCell(r, col))}
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={COLS.length} style={{ padding: '10px 14px 14px 30px', background: 'rgba(255,255,255,0.015)', borderBottom: '1px solid rgba(51,65,85,0.25)', fontSize: 12.5, color: '#cbd5e1', lineHeight: 1.6 }}>
                          {r.criteria ? (
                            <div style={{ marginBottom: 6 }}><strong style={{ color: '#e2e8f0' }}>Criteria: </strong>{r.criteria}</div>
                          ) : (
                            <div style={{ marginBottom: 6, color: '#fbbf24' }}>No written definition yet — add one to server/config/setupDefinitions.js.</div>
                          )}
                          {r.windowDescription && <div style={{ marginBottom: 6 }}><strong style={{ color: '#e2e8f0' }}>Detection window: </strong>{r.windowDescription}</div>}
                          {r.family && <div><strong style={{ color: '#e2e8f0' }}>Family: </strong>{r.family}</div>}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {sorted.length === 0 && (
                <tr><td colSpan={COLS.length} style={{ ...tdStyle, textAlign: 'center', padding: 40 }}>No setups match this filter.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
