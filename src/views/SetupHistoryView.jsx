import React from 'react';

import { API_URL } from '../constants/api.js';

const SETUP_LOG_COLS = [
  { key: 'trade_date',          label: 'Date',       sortable: true,  tip: 'Trade date (ET)' },
  { key: 'setup_type',          label: 'Setup',      sortable: true,  tip: 'Setup type. Green = long direction, red = short.' },
  { key: 'fired_at_str',        label: 'Time',       sortable: false, tip: 'Time the setup fired (ET)' },
  { key: 'entry_zone_low',      label: 'Entry',      sortable: false, tip: 'Price at detection / entry zone' },
  { key: 'stop_level',          label: 'Stop',       sortable: false, tip: 'Stop loss level (P75 MAE from backtest)' },
  { key: 't1_level',            label: 'T1',         sortable: false, tip: 'First target — scale half position here' },
  { key: 'resolution',          label: 'Outcome',    sortable: true,  tip: 'T1 ✓ = target hit, Stop ✗ = stopped out, Expired/Closed = timed out without resolution' },
  { key: 'actual_pnl',          label: 'P&L',        sortable: true,  tip: 'P&L for this setup ($2/pt per contract, MNQ, net commission)' },
  { key: 'mae_mfe',             label: 'MAE / MFE',  sortable: false, tip: 'Max adverse / favorable excursion in points, once resolved' },
  { key: 'historical_win_rate', label: 'WR at Fire', sortable: false, tip: 'FROZEN snapshot: this setup type\'s win rate at the exact moment this row fired. Never updated afterward — can be badly stale. Only shown when N≥20.' },
  { key: 'current_win_rate',    label: 'WR Now',     sortable: false, tip: 'LIVE current win rate for this setup type, from the weekly-recalibrated SETUP_STATUS pipeline. Compare against "WR at Fire" to see how much this setup has drifted since this row fired.' },
  { key: 'matched_trade_pnl',   label: 'Your Trade',  sortable: false, tip: 'Your own executed trade matched to this setup by time proximity (within 5 min of fire). Blank means no trade of yours was found near this fire — most trades are discretionary and don\'t match any system-detected setup.' },
];

export default function SetupHistoryView() {
  const [setups, setSetups] = React.useState([]);
  const [total, setTotal] = React.useState(0);
  const [originBreakdown, setOriginBreakdown] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [filters, setFilters] = React.useState(() => {
    let session = 'both';
    try { session = sessionStorage.getItem('setup-log-session-filter') || 'both'; } catch (_) {}
    return { type: '', resolution: '', from: '', to: '', shadow: 'hide', session, origin: 'all', hourFrom: '', hourTo: '' };
  });

  React.useEffect(() => {
    try { sessionStorage.setItem('setup-log-session-filter', filters.session); } catch (_) {}
  }, [filters.session]);
  const [sort, setSort] = React.useState({ col: 'trade_date', dir: 'desc' });
  const [colOrder, setColOrder] = React.useState(() => {
    try { const s = localStorage.getItem('setup-log-col-order'); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const [dragCol, setDragCol] = React.useState(null);

  React.useEffect(() => {
    if (colOrder) try { localStorage.setItem('setup-log-col-order', JSON.stringify(colOrder)); } catch (_) {}
  }, [colOrder]);

  const effectiveCols = React.useMemo(() => {
    const order = colOrder || SETUP_LOG_COLS.map(c => c.key);
    return order.map(k => SETUP_LOG_COLS.find(c => c.key === k)).filter(Boolean);
  }, [colOrder]);

  const load = React.useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams();
    if (filters.type) p.set('type', filters.type);
    if (filters.resolution) p.set('resolution', filters.resolution);
    if (filters.from) p.set('from', filters.from);
    if (filters.to) p.set('to', filters.to);
    if (filters.shadow !== 'hide') p.set('shadow', filters.shadow);
    if (filters.session !== 'both') p.set('session', filters.session);
    if (filters.origin !== 'all') p.set('origin', filters.origin);
    if (filters.hourFrom !== '') p.set('hourFrom', filters.hourFrom);
    if (filters.hourTo !== '') p.set('hourTo', filters.hourTo);
    fetch(`${API_URL}/setups/history?${p}`)
      .then(r => r.json())
      .then(d => { setSetups(d.setups || []); setTotal(d.total || d.count || 0); setOriginBreakdown(d.originBreakdown || null); setLoading(false); })
      .catch(() => setLoading(false));
  }, [filters]);

  React.useEffect(() => { load(); }, [load]);

  const sorted = React.useMemo(() => {
    const arr = [...setups];
    arr.sort((a, b) => {
      let av = a[sort.col] ?? '', bv = b[sort.col] ?? '';
      if (sort.col === 'actual_pnl') { av = parseFloat(av) || 0; bv = parseFloat(bv) || 0; }
      if (av < bv) return sort.dir === 'asc' ? -1 : 1;
      if (av > bv) return sort.dir === 'asc' ? 1 : -1;
      return 0;
    });
    return arr;
  }, [setups, sort]);

  const toggleSort = (col) => setSort(s => ({ col, dir: s.col === col && s.dir === 'desc' ? 'asc' : 'desc' }));
  const SortIcon = ({ col }) => sort.col === col ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : '';

  const resolved = setups.filter(s => s.resolution === 'TARGET_HIT' || s.resolution === 'STOP_HIT');
  const wins = resolved.filter(s => s.resolution === 'TARGET_HIT').length;
  const totalPnl = setups.reduce((sum, s) => sum + (parseFloat(s.actual_pnl) || 0), 0);
  const setupTypes = [...new Set(setups.map(s => s.setup_type))].sort();

  const resColor = (r) => r === 'TARGET_HIT' ? '#22c55e' : r === 'STOP_HIT' ? '#ef4444' : r === 'ACTIVE' ? '#fbbf24' : '#64748b';
  const resLabel = (r) => r === 'TARGET_HIT' ? 'T1 ✓' : r === 'STOP_HIT' ? 'Stop ✗' : r === 'TIME_EXPIRED' ? 'Expired' : r === 'SESSION_CLOSED' ? 'Closed' : r === 'INVALIDATED' ? 'Inv.' : r === 'EXPIRED' ? 'Expired' : r === 'ACTIVE' ? 'Active' : r || '—';

  const inputStyle = { background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(51,65,85,0.5)', borderRadius: 6, color: '#cbd5e1', fontSize: 12, padding: '5px 9px' };
  const thBase = { padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid rgba(51,65,85,0.4)', whiteSpace: 'nowrap', userSelect: 'none', cursor: 'grab' };
  const tdStyle = { padding: '7px 10px', fontSize: 12, color: '#cbd5e1', borderBottom: '1px solid rgba(51,65,85,0.15)', verticalAlign: 'middle' };

  const renderCell = (s, col) => {
    const pnl = parseFloat(s.actual_pnl);
    const hasPnl = !isNaN(pnl) && s.actual_pnl != null;
    const isLong = s.setup_type?.includes('LONG') || s.setup_type?.includes('BULLISH');
    const isShort = s.setup_type?.includes('SHORT') || s.setup_type?.includes('BEARISH');
    const dirColor = isLong ? '#4ade80' : isShort ? '#f87171' : '#94a3b8';
    switch (col.key) {
      case 'trade_date':     return <td key={col.key} style={tdStyle}>{s.trade_date}</td>;
      case 'setup_type':     return <td key={col.key} style={{ ...tdStyle, color: dirColor, fontWeight: 600 }}>{s.setup_type?.replace(/_/g, ' ')}</td>;
      case 'fired_at_str':   return <td key={col.key} style={{ ...tdStyle, fontFamily: 'monospace' }}>{s.fired_at_str?.slice(11, 16)}</td>;
      case 'entry_zone_low': return <td key={col.key} style={{ ...tdStyle, fontFamily: 'monospace' }}>{s.entry_zone_low != null ? Math.round(parseFloat(s.entry_zone_low)).toLocaleString() : '—'}</td>;
      case 'stop_level':     return <td key={col.key} style={{ ...tdStyle, fontFamily: 'monospace', color: '#f87171' }}>{s.stop_level != null ? Math.round(parseFloat(s.stop_level)).toLocaleString() : '—'}</td>;
      case 't1_level':       return <td key={col.key} style={{ ...tdStyle, fontFamily: 'monospace', color: '#22c55e' }}>{s.t1_level != null ? Math.round(parseFloat(s.t1_level)).toLocaleString() : '—'}</td>;
      case 'resolution':     return <td key={col.key} style={tdStyle}><span style={{ color: resColor(s.resolution), fontWeight: 600 }}>{resLabel(s.resolution)}</span></td>;
      case 'actual_pnl':     return <td key={col.key} style={{ ...tdStyle, fontFamily: 'monospace', color: hasPnl ? (pnl >= 0 ? '#22c55e' : '#ef4444') : '#64748b', fontWeight: hasPnl ? 700 : 400 }}>{hasPnl ? `${pnl >= 0 ? '+' : ''}$${Math.round(pnl).toLocaleString()}` : '—'}</td>;
      case 'historical_win_rate': return <td key={col.key} style={{ ...tdStyle, color: '#94a3b8' }}>{s.historical_win_rate != null && s.historical_sessions >= 20 ? `${Math.round(s.historical_win_rate * 100)}% · N=${s.historical_sessions}` : '—'}</td>;
      case 'mae_mfe': {
        if (s.mae_points == null && s.mfe_points == null) return <td key={col.key} style={tdStyle}>—</td>;
        return (
          <td key={col.key} style={{ ...tdStyle, fontFamily: 'monospace' }}>
            {s.mae_points != null && <span style={{ color: '#f87171' }}>{Math.round(parseFloat(s.mae_points))}</span>}
            {s.mae_points != null && s.mfe_points != null && <span style={{ color: '#64748b' }}> / </span>}
            {s.mfe_points != null && <span style={{ color: '#4ade80' }}>{Math.round(parseFloat(s.mfe_points))}</span>}
          </td>
        );
      }
      case 'current_win_rate': {
        if (s.current_win_rate == null || s.current_sample_size < 20) return <td key={col.key} style={tdStyle}>—</td>;
        const evNeg = parseFloat(s.current_ev) < 0;
        // Flag when live-current WR has drifted meaningfully (>=8pp) from the frozen at-fire snapshot,
        // so a stale-looking "WR at Fire" number doesn't sit next to a silently-different current one.
        const drifted = s.historical_win_rate != null && Math.abs(s.current_win_rate - s.historical_win_rate) >= 0.08;
        return (
          <td key={col.key} style={{ ...tdStyle, color: evNeg ? '#f87171' : '#94a3b8', fontWeight: drifted ? 700 : 400 }}
            title={drifted ? `Drifted ${Math.round(Math.abs(s.current_win_rate - s.historical_win_rate) * 100)}pp from WR at Fire` : undefined}>
            {Math.round(s.current_win_rate * 100)}% · N={s.current_sample_size}{drifted ? ' ⚠' : ''}
          </td>
        );
      }
      case 'matched_trade_pnl': {
        if (s.matched_trade_pnl == null) return <td key={col.key} style={{ ...tdStyle, color: '#475569' }}>—</td>;
        const tpnl = parseFloat(s.matched_trade_pnl);
        return (
          <td key={col.key} style={{ ...tdStyle, fontFamily: 'monospace', color: tpnl >= 0 ? '#22c55e' : '#ef4444' }}
            title={`${s.matched_trade_qty} lot(s) @ ${s.matched_trade_time}`}>
            {tpnl >= 0 ? '+' : ''}${Math.round(tpnl).toLocaleString()}
          </td>
        );
      }
      default: return <td key={col.key} style={tdStyle}>—</td>;
    }
  };

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1300, margin: '0 auto', color: '#94a3b8' }}>
      <div style={{ marginBottom: 20, display: 'flex', alignItems: 'baseline', gap: 16 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: '#e2e8f0', margin: 0 }}>Setup Log</h2>
        <span style={{ fontSize: 13, color: '#94a3b8' }}>
          {setups.length < total ? `${setups.length.toLocaleString()} of ${total.toLocaleString()} setups` : `${total.toLocaleString()} setups`}
        </span>
        {colOrder && (
          <button onClick={() => { setColOrder(null); localStorage.removeItem('setup-log-col-order'); }}
            style={{ fontSize: 11, color: '#94a3b8', background: 'none', border: '1px solid #334155', borderRadius: 4, padding: '2px 7px', cursor: 'pointer' }}>
            Reset columns
          </button>
        )}
      </div>

      {resolved.length > 0 && (
        <div style={{ display: 'flex', gap: 24, marginBottom: 20, padding: '12px 16px', background: 'rgba(15,23,42,0.6)', border: '1px solid rgba(51,65,85,0.3)', borderRadius: 8 }}>
          <div><span style={{ color: '#94a3b8', fontSize: 12 }}>Win Rate </span><span style={{ color: '#e2e8f0', fontWeight: 700, fontSize: 16 }}>{Math.round(wins / resolved.length * 100)}%</span><span style={{ color: '#94a3b8', fontSize: 11 }}> · N={resolved.length} resolved</span></div>
          <div><span style={{ color: '#94a3b8', fontSize: 12 }}>Wins </span><span style={{ color: '#22c55e', fontWeight: 700, fontSize: 16 }}>{wins}</span></div>
          <div><span style={{ color: '#94a3b8', fontSize: 12 }}>Losses </span><span style={{ color: '#ef4444', fontWeight: 700, fontSize: 16 }}>{resolved.length - wins}</span></div>
          <div><span style={{ color: '#94a3b8', fontSize: 12 }}>Total P&L </span><span style={{ color: totalPnl >= 0 ? '#22c55e' : '#ef4444', fontWeight: 700, fontSize: 16 }}>{totalPnl >= 0 ? '+' : ''}${Math.round(totalPnl).toLocaleString()}</span></div>
          <div style={{ marginLeft: 'auto', fontSize: 11, color: '#94a3b8', alignSelf: 'center' }}>Drag column headers to reorder</div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <select style={inputStyle} value={filters.type} onChange={e => setFilters(f => ({ ...f, type: e.target.value }))}>
          <option value="">All Setup Types</option>
          {setupTypes.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
        </select>
        <select style={inputStyle} value={filters.resolution} onChange={e => setFilters(f => ({ ...f, resolution: e.target.value }))}>
          <option value="">All Outcomes</option>
          <option value="TARGET_HIT">T1 Hit ✓</option>
          <option value="STOP_HIT">Stop Hit ✗</option>
          <option value="EXPIRED">Expired</option>
          <option value="SESSION_CLOSED">Closed</option>
          <option value="ACTIVE">Active</option>
        </select>
        <input type="date" style={inputStyle} value={filters.from} onChange={e => setFilters(f => ({ ...f, from: e.target.value }))} />
        <input type="date" style={inputStyle} value={filters.to} onChange={e => setFilters(f => ({ ...f, to: e.target.value }))} />
        <div style={{ display: 'flex', gap: 1, borderRadius: 6, overflow: 'hidden', border: '1px solid rgba(51,65,85,0.5)' }} title="Live = real, non-suppressed setup types. Shadow = tracked in the background (suppressed/thin-N), not live-traded.">
          {[['hide', 'Live'], ['only', 'Shadow'], ['both', 'Both']].map(([val, label]) => (
            <button key={val} onClick={() => setFilters(f => ({ ...f, shadow: val }))}
              style={{ padding: '5px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', border: 'none',
                background: filters.shadow === val ? (val === 'only' ? 'rgba(139,92,246,0.3)' : 'rgba(51,65,85,0.6)') : 'rgba(15,23,42,0.8)',
                color: filters.shadow === val ? (val === 'only' ? '#a78bfa' : '#e2e8f0') : '#64748b' }}>
              {label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 1, borderRadius: 6, overflow: 'hidden', border: '1px solid rgba(51,65,85,0.5)' }} title="Filter by session: RTH = 9:30-4:00 PM ET, Non-RTH = overnight/Globex hours">
          {[['rth', 'RTH'], ['overnight', 'Non-RTH'], ['both', 'Both']].map(([val, label]) => (
            <button key={val} onClick={() => setFilters(f => ({ ...f, session: val }))}
              style={{ padding: '5px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', border: 'none',
                background: filters.session === val ? 'rgba(51,65,85,0.6)' : 'rgba(15,23,42,0.8)',
                color: filters.session === val ? '#e2e8f0' : '#64748b' }}>
              {label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 1, borderRadius: 6, overflow: 'hidden', border: '1px solid rgba(51,65,85,0.5)' }}
          title="Real = genuinely live-detected (ACTIVE or SHADOW origin), whether or not shown as an alert. Backfill = synthetic history reconstructed after the fact — never actually fired live. Most historical rows are Backfill; check this before reading a count as real experience.">
          {[['all', 'All'], ['real', 'Real'], ['backfill', 'Backfill']].map(([val, label]) => (
            <button key={val} onClick={() => setFilters(f => ({ ...f, origin: val }))}
              style={{ padding: '5px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', border: 'none',
                background: filters.origin === val ? (val === 'real' ? 'rgba(34,197,94,0.25)' : val === 'backfill' ? 'rgba(100,116,139,0.35)' : 'rgba(51,65,85,0.6)') : 'rgba(15,23,42,0.8)',
                color: filters.origin === val ? (val === 'real' ? '#4ade80' : val === 'backfill' ? '#cbd5e1' : '#e2e8f0') : '#64748b' }}>
              {label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }} title="Filter by hour of day the setup fired (ET, 0-23)">
          <span style={{ fontSize: 11, color: '#64748b' }}>Hour</span>
          <input type="number" min="0" max="23" placeholder="from" style={{ ...inputStyle, width: 52 }}
            value={filters.hourFrom} onChange={e => setFilters(f => ({ ...f, hourFrom: e.target.value }))} />
          <span style={{ fontSize: 11, color: '#64748b' }}>–</span>
          <input type="number" min="0" max="23" placeholder="to" style={{ ...inputStyle, width: 52 }}
            value={filters.hourTo} onChange={e => setFilters(f => ({ ...f, hourTo: e.target.value }))} />
        </div>
        {(filters.type || filters.resolution || filters.from || filters.to || filters.shadow !== 'hide' || filters.session !== 'both' || filters.origin !== 'all' || filters.hourFrom !== '' || filters.hourTo !== '') && (
          <button onClick={() => setFilters({ type: '', resolution: '', from: '', to: '', shadow: 'hide', session: 'both', origin: 'all', hourFrom: '', hourTo: '' })} style={{ ...inputStyle, color: '#94a3b8', cursor: 'pointer' }}>Clear</button>
        )}
      </div>

      {originBreakdown && originBreakdown.total_n > 0 && filters.origin === 'all' && (
        <div style={{ marginBottom: 16, fontSize: 12, color: '#94a3b8' }}>
          Of {originBreakdown.total_n.toLocaleString()} rows matching current filters: {' '}
          <span style={{ color: '#4ade80', fontWeight: 700 }}>{originBreakdown.real_n.toLocaleString()} real</span>
          {' '}(genuinely live-detected) · <span style={{ color: '#94a3b8', fontWeight: 700 }}>{originBreakdown.backfill_n.toLocaleString()} backfill</span> (synthetic history)
          {originBreakdown.unknown_n > 0 && <> · <span style={{ color: '#64748b' }}>{originBreakdown.unknown_n.toLocaleString()} unknown</span></>}
        </div>
      )}

      {loading ? (
        <div style={{ color: '#94a3b8', padding: 40, textAlign: 'center' }}>Loading…</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'rgba(15,23,42,0.6)' }}>
                {effectiveCols.map((col, ci) => (
                  <th key={col.key}
                    draggable
                    title={col.tip}
                    onDragStart={() => setDragCol(ci)}
                    onDragOver={e => e.preventDefault()}
                    onDrop={() => {
                      if (dragCol == null || dragCol === ci) return;
                      const order = effectiveCols.map(c => c.key);
                      const [moved] = order.splice(dragCol, 1);
                      order.splice(ci, 0, moved);
                      setColOrder(order);
                      setDragCol(null);
                    }}
                    onClick={() => col.sortable && toggleSort(col.key)}
                    style={{ ...thBase, cursor: col.sortable ? 'pointer' : 'grab', color: sort.col === col.key ? '#e2e8f0' : '#64748b' }}>
                    {col.label}{col.sortable ? <SortIcon col={col.key} /> : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((s, i) => {
                const isShadow = s.is_shadow_type || s.status === 'SHADOW';
                return (
                  <tr key={s.id} style={{
                    background: i % 2 === 0 ? 'rgba(15,23,42,0.3)' : 'transparent',
                    borderLeft: isShadow ? '2px solid #7c3aed' : undefined,
                  }}>
                    {effectiveCols.map(col => {
                      if (col.key === 'setup_type' && (isShadow || s.origin_status === 'BACKFILL')) {
                        const isLong = s.setup_type?.includes('LONG') || s.setup_type?.includes('BULLISH');
                        const isShort = s.setup_type?.includes('SHORT') || s.setup_type?.includes('BEARISH');
                        const dirColor = isLong ? '#4ade80' : isShort ? '#f87171' : '#94a3b8';
                        return (
                          <td key={col.key} style={{ ...tdStyle, color: dirColor, fontWeight: 600 }}>
                            {s.setup_type?.replace(/_/g, ' ')}
                            {isShadow && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 800, color: '#7c3aed', background: 'rgba(124,58,237,0.15)', padding: '1px 4px', borderRadius: 3, letterSpacing: '0.05em' }}>SHADOW</span>}
                            {s.origin_status === 'BACKFILL' && <span title="Synthetic history reconstructed after the fact — never actually fired live" style={{ marginLeft: 6, fontSize: 11, fontWeight: 800, color: '#94a3b8', background: 'rgba(100,116,139,0.2)', padding: '1px 4px', borderRadius: 3, letterSpacing: '0.05em' }}>BACKFILL</span>}
                          </td>
                        );
                      }
                      return renderCell(s, col);
                    })}
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr><td colSpan={effectiveCols.length} style={{ ...tdStyle, textAlign: 'center', color: '#94a3b8', padding: 40 }}>No setups found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
