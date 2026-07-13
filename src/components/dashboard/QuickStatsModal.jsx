import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

const API = '/api';

function fmt(v, decimals = 1) {
  if (v == null || v === '') return '—';
  const n = parseFloat(v);
  return isNaN(n) ? '—' : n.toFixed(decimals);
}
function fmtPct(v) {
  if (v == null || v === '') return '—';
  const n = parseFloat(v);
  return isNaN(n) ? '—' : `${(n * 100).toFixed(1)}%`;
}
function fmtEv(v) {
  if (v == null || v === '') return '—';
  const n = parseFloat(v);
  if (isNaN(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}$${n.toFixed(0)}`;
}
function recColor(rec) {
  if (!rec) return '#94a3b8';
  if (rec === 'ACTIVE') return '#4ade80';
  if (rec === 'SUPPRESS') return '#f87171';
  if (rec === 'SHADOW') return '#fbbf24';
  return '#94a3b8';
}

function ResultCard({ r, expanded, onToggle }) {
  const wr = parseFloat(r.win_rate);
  const ev = parseFloat(r.ev_per_trade);
  const evPos = !isNaN(ev) && ev >= 0;

  return (
    <div
      style={{
        borderBottom: '1px solid rgba(51,65,85,0.5)',
        padding: '10px 14px',
        cursor: 'pointer',
        background: expanded ? 'rgba(99,102,241,0.06)' : 'transparent',
        transition: 'background 0.12s',
      }}
      onClick={onToggle}
    >
      {/* Row 1: name + badges */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', letterSpacing: '0.02em' }}>
          {r.signal_name}
        </span>
        {r.recommendation && (
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
            color: recColor(r.recommendation),
            background: `${recColor(r.recommendation)}22`,
          }}>
            {r.recommendation}
          </span>
        )}
        {r.source && (
          <span style={{ fontSize: 10, color: '#64748b', background: 'rgba(100,116,139,0.15)', padding: '1px 5px', borderRadius: 3 }}>
            {r.source}
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
          {!isNaN(wr) && (
            <span style={{ fontSize: 13, fontWeight: 700, color: wr >= 0.6 ? '#4ade80' : wr >= 0.5 ? '#fbbf24' : '#f87171' }}>
              {(wr * 100).toFixed(1)}% WR
            </span>
          )}
          {r.sample_size != null && (
            <span style={{ fontSize: 11, color: '#64748b' }}>N={r.sample_size}</span>
          )}
          {!isNaN(ev) && (
            <span style={{ fontSize: 12, fontWeight: 600, color: evPos ? '#4ade80' : '#f87171' }}>
              {fmtEv(ev)} EV
            </span>
          )}
          {r.p50_mae != null && (
            <span style={{ fontSize: 11, color: '#f87171' }} title="MAE p50 — median adverse excursion">
              MAE {fmt(r.p50_mae, 0)}
            </span>
          )}
          {r.p50_mfe != null && (
            <span style={{ fontSize: 11, color: '#4ade80' }} title="MFE p50 — median favorable excursion">
              MFE {fmt(r.p50_mfe, 0)}
            </span>
          )}
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px' }}>
          {r.optimal_stop != null && (
            <StatRow label="Opt. Stop" value={`${fmt(r.optimal_stop, 0)} pts`} />
          )}
          {r.optimal_target != null && (
            <StatRow label="Opt. Target" value={`${fmt(r.optimal_target, 0)} pts`} />
          )}
          {r.current_stop != null && r.current_stop !== r.optimal_stop && (
            <StatRow label="Current Stop" value={`${fmt(r.current_stop, 0)} pts`} dim />
          )}
          {r.current_target != null && r.current_target !== r.optimal_target && (
            <StatRow label="Current Target" value={`${fmt(r.current_target, 0)} pts`} dim />
          )}
          {r.p50_mfe != null && (
            <StatRow label="MFE p50" value={`${fmt(r.p50_mfe, 0)} pts`} />
          )}
          {r.p75_mfe != null && (
            <StatRow label="MFE p75" value={`${fmt(r.p75_mfe, 0)} pts`} />
          )}
          {r.p50_mae != null && (
            <StatRow label="MAE p50" value={`${fmt(r.p50_mae, 0)} pts`} warn />
          )}
          {r.p75_mae != null && (
            <StatRow label="MAE p75" value={`${fmt(r.p75_mae, 0)} pts`} warn />
          )}
          {r.stop_blowthrough_pct != null && (
            <StatRow label="Stop Blowthrough" value={fmtPct(r.stop_blowthrough_pct)} warn />
          )}
          {r.notes && (
            <div style={{ gridColumn: '1/-1', fontSize: 11, color: '#94a3b8', marginTop: 2, lineHeight: 1.5 }}>
              {r.notes}
            </div>
          )}
          {r.run_date && (
            <div style={{ gridColumn: '1/-1', fontSize: 10, color: '#475569', marginTop: 4 }}>
              Updated: {r.run_date}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatRow({ label, value, dim, warn }) {
  const color = warn ? '#f87171' : dim ? '#64748b' : '#cbd5e1';
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
      <span style={{ fontSize: 11, color: '#64748b' }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 600, color }}>{value}</span>
    </div>
  );
}

export default function QuickStatsModal({ open, onClose }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const inputRef = useRef(null);
  const timerRef = useRef(null);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQ('');
      setResults([]);
      setExpanded(null);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const search = useCallback((val) => {
    clearTimeout(timerRef.current);
    if (!val || val.trim().length < 2) { setResults([]); return; }
    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await fetch(`${API}/performance-audit/search?q=${encodeURIComponent(val)}`);
        const d = await r.json();
        setResults(d.results || []);
        setExpanded(d.results?.length === 1 ? d.results[0].signal_name : null);
      } catch { setResults([]); }
      finally { setLoading(false); }
    }, 250);
  }, []);

  const handleKey = useCallback((e) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  useEffect(() => {
    if (open) {
      window.addEventListener('keydown', handleKey);
      return () => window.removeEventListener('keydown', handleKey);
    }
  }, [open, handleKey]);

  if (!open) return null;

  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9500,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: 80,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width: 560, maxWidth: 'calc(100vw - 32px)',
        background: '#0f172a',
        border: '1px solid rgba(99,102,241,0.35)',
        borderRadius: 10,
        boxShadow: '0 8px 40px rgba(0,0,0,0.7)',
        overflow: 'hidden',
      }}>
        {/* Search input */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 14px',
          borderBottom: '1px solid rgba(51,65,85,0.5)',
        }}>
          <span style={{ fontSize: 16, color: '#64748b' }}>🔍</span>
          <input
            ref={inputRef}
            type="text"
            placeholder="Search setup or level... (e.g. CAM-R2, IB_MID, WPP)"
            value={q}
            onChange={e => { setQ(e.target.value); search(e.target.value); }}
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              fontSize: 14, color: '#e2e8f0',
            }}
          />
          {loading && <span style={{ fontSize: 11, color: '#64748b' }}>...</span>}
          <kbd style={{ fontSize: 10, color: '#64748b', background: 'rgba(255,255,255,0.05)', padding: '2px 6px', borderRadius: 3, border: '1px solid rgba(255,255,255,0.08)' }}>ESC</kbd>
        </div>

        {/* Results */}
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          {results.length === 0 && q.length >= 2 && !loading && (
            <div style={{ padding: '20px 14px', textAlign: 'center', fontSize: 13, color: '#475569' }}>
              No results for "{q}"
            </div>
          )}
          {results.length === 0 && q.length < 2 && (
            <div style={{ padding: '20px 14px', textAlign: 'center', fontSize: 12, color: '#334155' }}>
              Type at least 2 characters — searches SETUP_STATUS + OPTIMAL_STOP rows
            </div>
          )}
          {results.map((r, i) => (
            <ResultCard
              key={r.signal_name + i}
              r={r}
              expanded={expanded === r.signal_name}
              onToggle={() => setExpanded(expanded === r.signal_name ? null : r.signal_name)}
            />
          ))}
        </div>

        {results.length > 0 && (
          <div style={{ padding: '6px 14px', fontSize: 10, color: '#334155', borderTop: '1px solid rgba(51,65,85,0.3)' }}>
            {results.length} result{results.length !== 1 ? 's' : ''} · click any row to expand · ESC to close
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
