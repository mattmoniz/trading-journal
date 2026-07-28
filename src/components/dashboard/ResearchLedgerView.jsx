import React, { useEffect, useState } from 'react';
import { API_URL } from '../../constants/api.js';

// Research Ledger — one page listing every tested idea/mechanism this codebase has
// recorded (RESEARCH_CLAIM: a hypothesis with a real N/WR/EV) and every pending decision
// (OPEN_DECISION: wire it in or drop it, still awaiting a human call). Built 2026-07-28
// per direct user request for "a glimpse into what is currently affecting the app's
// output and the trades that are and are not getting fired" — previously this only
// lived as CLI output (`node scripts/record_claim.mjs --list` / `flag_decision.mjs
// --list`) or scattered prose across CLAUDE.md/docs/OPEN_THREADS.md. Data: always
// GET /api/research/ledger (live), never hand-typed here.
const CLAIM_STATUS_COLOR = { CONFIRMED: '#4ade80', PROVISIONAL: '#fbbf24', STALE: '#f87171' };
const DECISION_STATUS_COLOR = { PENDING: '#fbbf24', RESOLVED: '#4ade80' };
const PRIORITY_COLOR = { HIGH: '#f87171', MEDIUM: '#fbbf24', LOW: '#64748b' };

function Badge({ label, color }) {
  if (!label) return <span style={{ color: '#64748b' }}>—</span>;
  return <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 6px', borderRadius: 4, color, background: color + '1e' }}>{label}</span>;
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n).trim() + '…' : s;
}

export default function ResearchLedgerView() {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('claims'); // claims | decisions
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [expanded, setExpanded] = useState(null);
  const [sort, setSort] = useState({ col: null, dir: 'desc' });

  useEffect(() => {
    fetch(`${API_URL}/research/ledger`).then(r => r.json()).then(d => { if (!d.error) setData(d); }).catch(() => {});
  }, []);

  if (!data) return <div style={{ padding: 20, color: '#94a3b8', fontSize: 13 }}>Loading…</div>;

  const claimStatuses = ['all', 'CONFIRMED', 'PROVISIONAL', 'STALE'];
  const decisionStatuses = ['all', 'PENDING', 'RESOLVED'];

  let claimRows = data.claims;
  if (statusFilter !== 'all') claimRows = claimRows.filter(c => c.status === statusFilter);
  let decisionRows = data.decisions;
  if (statusFilter !== 'all') decisionRows = decisionRows.filter(d => d.status === statusFilter);
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    claimRows = claimRows.filter(c => c.slug.toLowerCase().includes(q) || c.claimText?.toLowerCase().includes(q));
    decisionRows = decisionRows.filter(d => d.slug.toLowerCase().includes(q) || d.decisionText?.toLowerCase().includes(q));
  }

  const sortRows = (rows, defaultCol) => {
    const col = sort.col || defaultCol;
    return [...rows].sort((a, b) => {
      let av = a[col], bv = b[col];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string') { av = av.toLowerCase(); bv = bv.toLowerCase(); }
      if (av < bv) return sort.dir === 'asc' ? -1 : 1;
      if (av > bv) return sort.dir === 'asc' ? 1 : -1;
      return 0;
    });
  };

  const toggleSort = (col) => setSort(s => ({ col, dir: s.col === col && s.dir === 'desc' ? 'asc' : 'desc' }));

  const filterBtn = (active) => ({
    background: active ? 'rgba(167,139,250,0.15)' : '#0f172a', border: `1px solid ${active ? '#a78bfa' : '#1e293b'}`,
    borderRadius: 6, padding: '6px 12px', color: active ? '#c4b5fd' : '#94a3b8', fontSize: 12, fontWeight: 600, cursor: 'pointer',
  });
  const thStyle = { padding: '8px 10px', textAlign: 'left', fontWeight: 600, fontSize: 11.5, whiteSpace: 'nowrap', color: '#94a3b8', cursor: 'pointer', userSelect: 'none', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '2px solid #1e293b' };
  const tdStyle = { padding: '8px 10px', fontSize: 12.5, color: '#cbd5e1', borderBottom: '1px solid rgba(51,65,85,0.25)', verticalAlign: 'top' };

  const sortedClaims = sortRows(claimRows, 'status');
  const sortedDecisions = sortRows(decisionRows, 'priority');

  return (
    <div style={{ padding: '20px 4px' }}>
      <div style={{ fontSize: 13, color: '#64748b', marginBottom: 14 }}>
        Every tested idea/mechanism ({data.claims.length} claims) and every pending product decision ({data.decisions.length}) this codebase has recorded — what it found, whether it's confirmed/provisional/stale, and whether it's actually wired into anything live. Click a row for the full writeup.
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 1, borderRadius: 6, overflow: 'hidden', border: '1px solid #1e293b' }}>
          {[['claims', `Research Claims (${data.claims.length})`], ['decisions', `Open Decisions (${data.decisions.length})`]].map(([v, l]) => (
            <button key={v} onClick={() => { setTab(v); setStatusFilter('all'); setSort({ col: null, dir: 'desc' }); }}
              style={{ padding: '7px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: 'none',
                background: tab === v ? 'rgba(167,139,250,0.18)' : '#0f172a', color: tab === v ? '#c4b5fd' : '#64748b' }}>
              {l}
            </button>
          ))}
        </div>
        <input style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 6, padding: '7px 10px', color: '#e2e8f0', fontSize: 13, width: 260 }}
          placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} />
        {(tab === 'claims' ? claimStatuses : decisionStatuses).map(s => (
          <button key={s} style={filterBtn(statusFilter === s)} onClick={() => setStatusFilter(s)}>{s === 'all' ? 'All' : s}</button>
        ))}
      </div>

      <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          {tab === 'claims' ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                  <th style={thStyle} onClick={() => toggleSort('status')}>Status</th>
                  <th style={thStyle} onClick={() => toggleSort('slug')}>Claim</th>
                  <th style={{ ...thStyle, textAlign: 'right' }} onClick={() => toggleSort('sampleSize')}>N</th>
                  <th style={{ ...thStyle, textAlign: 'right' }} onClick={() => toggleSort('winRate')}>WR</th>
                  <th style={{ ...thStyle, textAlign: 'right' }} onClick={() => toggleSort('evPerTrade')}>EV</th>
                  <th style={thStyle} onClick={() => toggleSort('sourceFile')}>Source</th>
                  <th style={thStyle} onClick={() => toggleSort('nextRecheckDue')}>Recheck Due</th>
                </tr>
              </thead>
              <tbody>
                {sortedClaims.map(c => {
                  const isOpen = expanded === c.slug;
                  return (
                    <React.Fragment key={c.slug}>
                      <tr style={{ cursor: 'pointer' }} onClick={() => setExpanded(isOpen ? null : c.slug)}>
                        <td style={tdStyle}><Badge label={c.status} color={CLAIM_STATUS_COLOR[c.status] || '#94a3b8'} /></td>
                        <td style={{ ...tdStyle, maxWidth: 480 }}>
                          <div style={{ fontFamily: 'monospace', fontWeight: 600, color: '#e2e8f0', fontSize: 12 }}>{c.slug}</div>
                          {!isOpen && <div style={{ color: '#64748b', marginTop: 2 }}>{truncate(c.claimText, 160)}</div>}
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace' }}>{c.sampleSize ?? '—'}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace' }}>{c.winRate != null ? `${(c.winRate * 100).toFixed(1)}%` : '—'}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', color: c.evPerTrade == null ? '#64748b' : c.evPerTrade >= 0 ? '#4ade80' : '#f87171' }}>{c.evPerTrade != null ? `$${(+c.evPerTrade).toFixed(2)}` : '—'}</td>
                        <td style={{ ...tdStyle, fontSize: 11, color: '#64748b' }}>{c.sourceFile}</td>
                        <td style={{ ...tdStyle, fontSize: 11.5, color: c.overdue ? '#f87171' : '#94a3b8' }}>{c.nextRecheckDue || '—'}{c.overdue ? ' ⚠ overdue' : ''}</td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={7} style={{ padding: '4px 14px 14px 14px', background: 'rgba(255,255,255,0.015)', borderBottom: '1px solid rgba(51,65,85,0.25)', fontSize: 12.5, color: '#cbd5e1', lineHeight: 1.6 }}>
                            {c.claimText}
                            <div style={{ marginTop: 8, fontSize: 11.5, color: '#64748b' }}>
                              Rigor: {c.rigorStatus || '—'} · Last verified: {c.lastVerifiedDate || '—'} · Source date: {c.sourceDate || '—'}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
                {sortedClaims.length === 0 && <tr><td colSpan={7} style={{ ...tdStyle, textAlign: 'center', padding: 40 }}>No claims match this filter.</td></tr>}
              </tbody>
            </table>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                  <th style={thStyle} onClick={() => toggleSort('priority')}>Priority</th>
                  <th style={thStyle} onClick={() => toggleSort('status')}>Status</th>
                  <th style={thStyle} onClick={() => toggleSort('slug')}>Decision</th>
                  <th style={thStyle} onClick={() => toggleSort('sourceFile')}>Source</th>
                  <th style={{ ...thStyle, textAlign: 'right' }} onClick={() => toggleSort('ageDays')}>Age (days)</th>
                </tr>
              </thead>
              <tbody>
                {sortedDecisions.map(d => {
                  const isOpen = expanded === d.slug;
                  return (
                    <React.Fragment key={d.slug}>
                      <tr style={{ cursor: 'pointer' }} onClick={() => setExpanded(isOpen ? null : d.slug)}>
                        <td style={tdStyle}><Badge label={d.priority} color={PRIORITY_COLOR[d.priority] || '#94a3b8'} /></td>
                        <td style={tdStyle}><Badge label={d.status} color={DECISION_STATUS_COLOR[d.status] || '#94a3b8'} /></td>
                        <td style={{ ...tdStyle, maxWidth: 480 }}>
                          <div style={{ fontFamily: 'monospace', fontWeight: 600, color: '#e2e8f0', fontSize: 12 }}>{d.slug}</div>
                          {!isOpen && <div style={{ color: '#64748b', marginTop: 2 }}>{truncate(d.decisionText, 160)}</div>}
                        </td>
                        <td style={{ ...tdStyle, fontSize: 11, color: '#64748b' }}>{d.sourceFile}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace' }}>{d.ageDays ?? '—'}</td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={5} style={{ padding: '4px 14px 14px 14px', background: 'rgba(255,255,255,0.015)', borderBottom: '1px solid rgba(51,65,85,0.25)', fontSize: 12.5, color: '#cbd5e1', lineHeight: 1.6 }}>
                            {d.decisionText}
                            {d.resolutionText && (
                              <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #1e293b' }}>
                                <strong style={{ color: '#4ade80' }}>Resolution ({d.resolvedDate}): </strong>{d.resolutionText}
                              </div>
                            )}
                            <div style={{ marginTop: 8, fontSize: 11.5, color: '#64748b' }}>First flagged: {d.firstFlaggedDate || '—'}</div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
                {sortedDecisions.length === 0 && <tr><td colSpan={5} style={{ ...tdStyle, textAlign: 'center', padding: 40 }}>No decisions match this filter.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
