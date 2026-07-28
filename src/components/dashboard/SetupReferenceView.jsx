import React, { useEffect, useState } from 'react';
import { API_URL } from '../../constants/api.js';

// Setup Reference — what each setup IS (criteria, detection window, family) joined
// against what it's ACTUALLY DOING right now (live N/WR/EV/status, plus Key-Levels-style
// touch/MFE/MAE/P&L metrics). Built 2026-07-20, rebuilt as a sortable table 2026-07-28
// per direct user request to match the Key Levels table's format (BacktestView.jsx's
// flat sortable table with Level/Group/Touches/MFE P50/P75/MAE P50/Avg P&L/Left on
// table columns, plus its click-through touch-detail panel and chart drill-down) rather
// than an accordion of cards. Criteria text: server/config/setupDefinitions.js (static).
// Numbers: always /api/setups/reference + /api/setups/reference/:type/detail (live),
// never hand-typed here.
const REC_COLOR = { ACTIVE: '#4ade80', PROMOTE: '#4ade80', DAY_TYPE_MANAGED: '#22d3ee', THIN_N: '#64748b', SUPPRESS: '#f87171', NOT_YET_CALIBRATED: '#64748b' };
const TREND_COLOR = { DEGRADING: '#f87171', IMPROVING: '#4ade80', NOISY_BUT_STABLE: '#94a3b8', STABLE: '#4ade80', AMBIGUOUS: '#fbbf24', THIN: '#64748b' };

const DEFAULT_COLS = [
  { key: 'setupType', label: 'Setup', align: 'left', sortable: true },
  { key: 'group', label: 'Group', align: 'left', sortable: true, tip: 'Level/pattern family, same grouping convention as the Key Levels table.' },
  { key: 'recommendation', label: 'Status', align: 'left', sortable: true },
  { key: 'n', label: 'N', align: 'right', sortable: true, tip: 'Blended sample size (SETUP_STATUS). "real" shown alongside is genuinely live-detected only — see the Setup Log for why these can differ a lot.' },
  { key: 'wr', label: 'WR', align: 'right', sortable: true },
  { key: 'ev', label: 'EV', align: 'right', sortable: true, tip: 'Expected value per trade, dollars' },
  { key: 'stop', label: 'Stop', align: 'right', sortable: true, tip: 'Calibrated stop, points' },
  { key: 'target', label: 'Target', align: 'right', sortable: true, tip: 'Calibrated target, points' },
  { key: 'mfeP50', label: 'MFE P50', align: 'right', sortable: true, tip: 'Median max favorable excursion in points, once resolved. Real-only when real N≥5, else blended (marked). Click a row for the full distribution.' },
  { key: 'mfeP75', label: 'MFE P75', align: 'right', sortable: true, tip: '75th percentile MFE — a more conservative target reference.' },
  { key: 'maeP50', label: 'MAE P50', align: 'right', sortable: true, tip: 'Median max adverse excursion in points, once resolved.' },
  { key: 'avgPnl', label: 'Avg P&L', align: 'right', sortable: true, tip: 'Average realized $ P&L per resolved trade.' },
  { key: 'leftOnTablePts', label: 'Left on Table', align: 'right', sortable: true, tip: 'MFE P50 minus the realized favorable move (converted to points) — positive means the calibrated exit is leaving real available movement unclaimed.' },
  { key: 'totalPnlRealAllTime', label: 'All-Time $ (Real)', align: 'right', sortable: true, tip: 'Cumulative realized $ P&L, real (ACTIVE/SHADOW-origin) trades only — never includes synthetic backfill.' },
  { key: 'touchesTotal', label: 'Touches', align: 'right', sortable: true, tip: 'Total rows ever recorded for this setup_type — blended, includes synthetic backfill. Check the Setup Log\'s origin filter for the real breakdown.' },
  { key: 'touchesThisWeek', label: 'This Week', align: 'right', sortable: true, tip: 'Touches so far this calendar week (Mon-Sun ET) — resets automatically each week.' },
  { key: 'lastTouch', label: 'Last Touch', align: 'right', sortable: true, tip: 'Timestamp of the most recent touch recorded for this setup_type — a live freshness check that the system is still updating.' },
  { key: 'appliedVolZ', label: 'Applied volZ', align: 'left', sortable: false, tip: 'Live volume-Z-score / one-sided-ratio / cluster-size thresholds currently gating this setup, where applicable (currently STACK_VOL_BREAK_LIVE only).' },
  { key: 'rigorTrend', label: 'Stability', align: 'left', sortable: true },
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

function SrMfeBar({ mfe, mae, avgPnl }) {
  if (!mfe?.p50) return <div style={{ padding: '12px 18px', fontSize: 12.5, color: '#64748b' }}>Not enough resolved trades yet for a distribution.</div>;
  const max = Math.max(mfe.p90 || 0, 40);
  const pctW = v => v != null ? `${Math.min(100, (v / max) * 100).toFixed(1)}%` : '0%';
  return (
    <div style={{ padding: '12px 18px', borderBottom: '1px solid #1e293b' }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: '#cbd5e1', marginBottom: 8 }}>MFE Distribution</div>
      <div style={{ position: 'relative', height: 20, background: 'rgba(255,255,255,0.05)', borderRadius: 4, marginBottom: 4, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: pctW(mfe.p90), background: 'rgba(167,139,250,0.15)', borderRadius: 4 }} />
        <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: pctW(mfe.p75), background: 'rgba(167,139,250,0.25)', borderRadius: 4 }} />
        <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: pctW(mfe.p50), background: 'rgba(167,139,250,0.5)', borderRadius: 4 }} />
        <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: pctW(mfe.p25), background: 'rgba(167,139,250,0.8)', borderRadius: 4 }} />
        {avgPnl != null && <div style={{ position: 'absolute', top: 0, bottom: 0, width: 2, background: '#f59e0b', left: pctW(Math.max(0, avgPnl)) }} title={`Avg realized: ${avgPnl}pt`} />}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#64748b', marginBottom: 8 }}>
        <span>P25 <b style={{ color: '#cbd5e1' }}>{mfe.p25}pt</b></span>
        <span>P50 <b style={{ color: '#a78bfa', fontSize: 12.5 }}>{mfe.p50}pt</b></span>
        <span>P75 <b style={{ color: '#cbd5e1' }}>{mfe.p75}pt</b></span>
        <span>P90 <b style={{ color: '#cbd5e1' }}>{mfe.p90}pt</b></span>
        {avgPnl != null && <span style={{ color: '#f59e0b' }}>Avg <b>{avgPnl}pt</b></span>}
      </div>
      {mae?.p50 != null && (
        <>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: '#cbd5e1', marginBottom: 4, marginTop: 4 }}>Adverse Excursion (MAE — stop guidance)</div>
          <div style={{ display: 'flex', gap: 16, fontSize: 12.5, color: '#64748b' }}>
            <span>P25 <b style={{ color: '#f87171' }}>{mae.p25}pt</b></span>
            <span>P50 <b style={{ color: '#f87171' }}>{mae.p50}pt</b></span>
            <span>P75 <b style={{ color: '#f87171' }}>{mae.p75}pt</b></span>
          </div>
        </>
      )}
    </div>
  );
}

function SrHourBreakdown({ byHour }) {
  if (!byHour?.length) return null;
  const maxTouches = Math.max(...byHour.map(h => h.touches), 1);
  return (
    <div style={{ padding: '12px 18px', borderBottom: '1px solid #1e293b' }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: '#cbd5e1', marginBottom: 8 }}>Touches by Hour (ET)</div>
      <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 50 }}>
        {byHour.map(h => {
          const barH = Math.max(4, (h.touches / maxTouches) * 44);
          const rr = h.respectRate;
          const col = rr == null ? '#64748b' : rr >= 65 ? '#4ade80' : rr >= 45 ? '#f59e0b' : '#f87171';
          return (
            <div key={h.hour} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}
              title={`${h.label} — ${h.touches} touches, ${rr ?? '—'}% target-hit, MFE P50 ${h.mfe_p50 ?? '—'}pt`}>
              <div style={{ width: '100%', height: barH, background: col, opacity: 0.75, borderRadius: '2px 2px 0 0', minHeight: 4 }} />
              <div style={{ fontSize: 10.5, color: '#64748b', whiteSpace: 'nowrap' }}>{h.label.replace(':00', '')}</div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 10.5, color: '#64748b', marginTop: 4 }}>Bar height = touch count · color = target-hit rate</div>
    </div>
  );
}

function SrDetailPanel({ setupType, displayName, onClose, onJumpToChart }) {
  const [detail, setDetail] = useState(null);
  useEffect(() => {
    setDetail(null);
    fetch(`${API_URL}/setups/reference/${setupType}/detail`).then(r => r.json()).then(d => { if (!d.error) setDetail(d); }).catch(() => {});
  }, [setupType]);

  return (
    <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 420, background: '#0f1724', borderLeft: '1px solid #1e293b', zIndex: 10000, display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 32px rgba(0,0,0,0.6)' }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid #1e293b', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#e2e8f0', fontFamily: 'monospace' }}>{setupType}</div>
          <div style={{ fontSize: 12.5, color: '#94a3b8', marginTop: 2 }}>{displayName}</div>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#64748b', fontSize: 18, cursor: 'pointer', padding: '4px 8px', lineHeight: 1 }}>✕</button>
      </div>
      {!detail ? (
        <div style={{ padding: 20, color: '#94a3b8', fontSize: 13 }}>Loading…</div>
      ) : (
        <>
          <SrMfeBar mfe={detail.mfe} mae={detail.mae} avgPnl={detail.avgPnl} />
          <SrHourBreakdown byHour={detail.byHour} />
          <div style={{ padding: '8px 18px', borderBottom: '1px solid #1e293b', fontSize: 12.5, color: '#64748b', flexShrink: 0 }}>
            {detail.details.length} real touch-day{detail.details.length === 1 ? '' : 's'} · <span style={{ color: '#a78bfa' }}>click a date</span> to view the chart
            {detail.timeToPeak?.p50 != null && (
              <span style={{ marginLeft: 10, color: '#94a3b8' }}>Typical peak: <b style={{ color: '#a78bfa' }}>{detail.timeToPeak.p50} bars</b> ({detail.timeToPeak.p25}–{detail.timeToPeak.p75})</span>
            )}
            {detail.usingBlendedStats && <div style={{ marginTop: 4, color: '#fbbf24' }}>Real N below 5 — distribution above is blended (incl. backfill).</div>}
          </div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {detail.details.length === 0 ? (
              <div style={{ padding: 20, color: '#64748b', fontSize: 13 }}>No real (live-detected) touches recorded yet.</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead style={{ position: 'sticky', top: 0, background: '#0f1724', zIndex: 1 }}>
                  <tr style={{ borderBottom: '1px solid #1e293b' }}>
                    <th style={{ padding: '7px 12px', textAlign: 'left', color: '#64748b', fontWeight: 500 }}>Date</th>
                    <th style={{ padding: '7px 8px', textAlign: 'center', color: '#64748b', fontWeight: 500 }}>Price</th>
                    <th style={{ padding: '7px 8px', textAlign: 'center', color: '#64748b', fontWeight: 500 }}>T</th>
                    <th style={{ padding: '7px 8px', textAlign: 'center', color: '#64748b', fontWeight: 500 }}>R</th>
                    <th style={{ padding: '7px 8px', textAlign: 'center', color: '#64748b', fontWeight: 500 }}>Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.details.map((d, i) => {
                    const rate = d.touches > 0 ? d.respects / d.touches : 0;
                    const rateCol = rate >= 0.65 ? '#4ade80' : rate >= 0.45 ? '#f59e0b' : '#f87171';
                    return (
                      <tr key={d.date} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                        <td style={{ padding: '6px 12px', fontWeight: 500 }}>
                          <span onClick={() => onJumpToChart?.(d.date)} style={{ color: '#a78bfa', cursor: 'pointer', textDecoration: 'underline dotted' }}>
                            {new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}
                          </span>
                        </td>
                        <td style={{ padding: '6px 8px', textAlign: 'center', color: '#64748b' }}>{d.levelPrice ?? '—'}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'center', color: '#cbd5e1' }}>{d.touches}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'center', color: d.respects > 0 ? '#4ade80' : '#f87171' }}>{d.respects}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                          <span style={{ color: rateCol, fontWeight: 700 }}>{d.touches > 0 ? `${Math.round(rate * 100)}%` : '—'}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function SetupReferenceView({ onJumpToChart }) {
  const [data, setData] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'); // all | live | globex | undocumented
  const [expanded, setExpanded] = useState(null);
  const [detailFor, setDetailFor] = useState(null); // setupType with the touch-detail panel open
  const [sort, setSort] = useState({ col: 'ev', dir: 'desc' });
  const [colOrder, setColOrder] = useState(() => {
    try { const s = localStorage.getItem('setup-reference-col-order'); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const [dragCol, setDragCol] = useState(null);

  useEffect(() => {
    fetch(`${API_URL}/setups/reference`).then(r => r.json()).then(d => { if (!d.error) setData(d); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (colOrder) try { localStorage.setItem('setup-reference-col-order', JSON.stringify(colOrder)); } catch (_) {}
  }, [colOrder]);

  const cols = React.useMemo(() => {
    const order = colOrder || DEFAULT_COLS.map(c => c.key);
    return order.map(k => DEFAULT_COLS.find(c => c.key === k)).filter(Boolean);
  }, [colOrder]);

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
    color: sort.col === col.key ? '#a78bfa' : '#94a3b8', cursor: col.sortable ? 'pointer' : 'grab', userSelect: 'none',
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
              onClick={(e) => { e.stopPropagation(); setExpanded(expanded === r.setupType ? null : r.setupType); }}>
              {expanded === r.setupType ? '▾' : '▸'}
            </span>
            <span style={{ color: dirColor, fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>{r.setupType}</span>
            {r.globexCapable && <span title="24hr / Globex-capable" style={{ marginLeft: 5, fontSize: 9.5, fontWeight: 800, color: '#22d3ee', background: 'rgba(34,211,238,0.12)', padding: '1px 4px', borderRadius: 3 }}>24HR</span>}
            {!r.documented && <span title="No written definition yet" style={{ marginLeft: 5, fontSize: 9.5, fontWeight: 800, color: '#fbbf24', background: 'rgba(251,191,36,0.12)', padding: '1px 4px', borderRadius: 3 }}>UNDOC</span>}
          </td>
        );
      }
      case 'group':
        return <td key={col.key} style={{ ...tdStyle, textAlign: 'left', color: '#94a3b8' }}>{r.group || '—'}</td>;
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
        Criteria/window text is static (rarely changes); every N/WR/EV/touch/MFE/MAE/P&L number is live-queried.
        Click the ▸ to expand criteria, click elsewhere on a row for the full touch-by-touch breakdown, drag column headers to reorder.
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <input style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 6, padding: '7px 10px', color: '#e2e8f0', fontSize: 13, width: 260 }}
          placeholder="Search setup name…" value={search} onChange={e => setSearch(e.target.value)} />
        <button style={filterBtn(filter === 'all')} onClick={() => setFilter('all')}>All ({data.total})</button>
        <button style={filterBtn(filter === 'live')} onClick={() => setFilter('live')}>Currently live</button>
        <button style={filterBtn(filter === 'globex')} onClick={() => setFilter('globex')}>Globex-capable</button>
        <button style={filterBtn(filter === 'undocumented')} onClick={() => setFilter('undocumented')}>Undocumented ({data.undocumented})</button>
        {colOrder && (
          <button onClick={() => { setColOrder(null); localStorage.removeItem('setup-reference-col-order'); }}
            style={{ fontSize: 11, color: '#94a3b8', background: 'none', border: '1px solid #334155', borderRadius: 4, padding: '4px 9px', cursor: 'pointer' }}>
            Reset columns
          </button>
        )}
      </div>

      <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                {cols.map((col, ci) => (
                  <th key={col.key}
                    draggable
                    title={col.tip}
                    onDragStart={() => setDragCol(ci)}
                    onDragOver={e => e.preventDefault()}
                    onDrop={() => {
                      if (dragCol == null || dragCol === ci) return;
                      const order = cols.map(c => c.key);
                      const [moved] = order.splice(dragCol, 1);
                      order.splice(ci, 0, moved);
                      setColOrder(order);
                      setDragCol(null);
                    }}
                    onClick={() => col.sortable && toggleSort(col.key)}
                    style={thStyle(col)}>
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
                    <tr style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.012)', cursor: 'pointer' }}
                      onClick={() => setDetailFor(r.setupType)}>
                      {cols.map(col => renderCell(r, col))}
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={cols.length} style={{ padding: '10px 14px 14px 30px', background: 'rgba(255,255,255,0.015)', borderBottom: '1px solid rgba(51,65,85,0.25)', fontSize: 12.5, color: '#cbd5e1', lineHeight: 1.6 }}
                          onClick={e => e.stopPropagation()}>
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
                <tr><td colSpan={cols.length} style={{ ...tdStyle, textAlign: 'center', padding: 40 }}>No setups match this filter.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {detailFor && (
        <SrDetailPanel
          setupType={detailFor}
          displayName={data.setups.find(s => s.setupType === detailFor)?.displayName || ''}
          onClose={() => setDetailFor(null)}
          onJumpToChart={onJumpToChart}
        />
      )}
    </div>
  );
}
