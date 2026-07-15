import { useState, useEffect } from 'react';
import { API_URL } from '../../constants/api.js';

const S = {
  wrap: { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: 20, marginBottom: 16 },
  header: { color: '#94a3b8', fontSize: 11, fontWeight: 700, letterSpacing: 2, marginBottom: 16, textTransform: 'uppercase' },
  summaryRow: { display: 'flex', gap: 20, marginBottom: 20, flexWrap: 'wrap' },
  metricBox: { flex: 1, minWidth: 120, background: '#1e293b', borderRadius: 6, padding: '10px 14px' },
  metricLabel: { color: '#64748b', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 },
  metricValue: { fontSize: 22, fontWeight: 700 },
  note: { fontSize: 11, color: '#64748b', marginBottom: 16, lineHeight: 1.5 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: { color: '#64748b', fontSize: 10, textAlign: 'right', padding: '4px 8px', borderBottom: '1px solid #1e293b', textTransform: 'uppercase' },
  thLeft: { color: '#64748b', fontSize: 10, textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid #1e293b', textTransform: 'uppercase' },
  td: { padding: '4px 8px', textAlign: 'right', borderBottom: '1px solid #0f172a', color: '#cbd5e1' },
  tdLeft: { padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid #0f172a', color: '#94a3b8', fontSize: 11 },
};

function fmt(n) {
  if (n == null) return '—';
  const sign = n >= 0 ? '+' : '';
  return sign + '$' + Math.abs(n).toLocaleString();
}

function gapColor(gap) {
  if (gap == null) return '#94a3b8';
  if (gap > 200) return '#22c55e';
  if (gap < -500) return '#ef4444';
  if (gap < -200) return '#f97316';
  return '#94a3b8';
}

export default function CaptureRatioPanel() {
  const [data, setData] = useState(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/stats/capture-ratio`).then(r => r.json()).then(setData).catch(() => {});
  }, []);

  if (!data) return null;

  const { summary, by_day } = data;
  const captureColor = summary.capture_ratio == null ? '#94a3b8'
    : summary.capture_ratio > 50 ? '#22c55e'
    : summary.capture_ratio > 0 ? '#f97316'
    : '#ef4444';

  const displayed = showAll ? by_day : by_day.slice(0, 20);

  return (
    <div style={S.wrap}>
      <div style={S.header}>Capture Ratio — Model P&L vs Actual Account</div>

      <div style={S.summaryRow}>
        <div style={S.metricBox}>
          <div style={S.metricLabel}>Capture Ratio</div>
          <div style={{ ...S.metricValue, color: captureColor }}>
            {summary.capture_ratio != null ? summary.capture_ratio + '%' : '—'}
          </div>
        </div>
        <div style={S.metricBox}>
          <div style={S.metricLabel}>Model Edge</div>
          <div style={{ ...S.metricValue, color: summary.model_total >= 0 ? '#22c55e' : '#ef4444' }}>
            {fmt(summary.model_total)}
          </div>
        </div>
        <div style={S.metricBox}>
          <div style={S.metricLabel}>Actual P&L</div>
          <div style={{ ...S.metricValue, color: summary.actual_total >= 0 ? '#22c55e' : '#ef4444' }}>
            {fmt(summary.actual_total)}
          </div>
        </div>
        <div style={S.metricBox}>
          <div style={S.metricLabel}>Trading Days</div>
          <div style={{ ...S.metricValue, color: '#94a3b8' }}>{summary.trading_days}</div>
        </div>
        <div style={S.metricBox}>
          <div style={S.metricLabel}>Likely DLL Hit</div>
          <div style={{ ...S.metricValue, color: summary.dll_hit_days > 3 ? '#f59e0b' : '#94a3b8' }}>
            {summary.dll_hit_days}d
          </div>
        </div>
      </div>

      <div style={S.note}>
        <strong style={{ color: '#e2e8f0' }}>What this measures:</strong> model P&L assumes every detected setup was captured at model size. Actual P&L is from real PRO account fills (CumPL diff). Gap = execution leak + DLL-stop days + trades not matching any setup. "Likely DLL hit" = days where actual was -$300 to -$500 while model was strongly positive (model fired after you stopped trading).
      </div>

      <table style={S.table}>
        <thead>
          <tr>
            <th style={S.thLeft}>Date</th>
            <th style={S.thLeft}>Day Type</th>
            <th style={S.th}>Model</th>
            <th style={S.th}>Actual</th>
            <th style={S.th}>Gap</th>
            <th style={S.th}>Setups</th>
            <th style={S.th}>W/L</th>
            <th style={S.th}>Flag</th>
          </tr>
        </thead>
        <tbody>
          {displayed.map(d => (
            <tr key={d.trade_date} style={d.likely_dll_hit ? { background: 'rgba(245,158,11,0.05)' } : {}}>
              <td style={S.tdLeft}>{d.trade_date}</td>
              <td style={{ ...S.tdLeft, color: d.day_type === 'TREND' ? '#f97316' : d.day_type === 'TURBULENT' ? '#f59e0b' : '#94a3b8' }}>
                {d.day_type || '—'}
              </td>
              <td style={{ ...S.td, color: d.model_pnl >= 0 ? '#22c55e' : '#ef4444' }}>{fmt(d.model_pnl)}</td>
              <td style={{ ...S.td, color: d.actual_pnl >= 0 ? '#22c55e' : '#ef4444' }}>{fmt(d.actual_pnl)}</td>
              <td style={{ ...S.td, color: gapColor(d.gap), fontWeight: Math.abs(d.gap) > 500 ? 700 : 400 }}>{fmt(d.gap)}</td>
              <td style={S.td}>{d.n_setups}</td>
              <td style={S.td}>{d.model_wins}/{d.model_losses}</td>
              <td style={{ ...S.td, color: '#f59e0b', fontSize: 10 }}>{d.likely_dll_hit ? 'DLL?' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {by_day.length > 20 && (
        <div style={{ textAlign: 'center', marginTop: 10 }}>
          <button onClick={() => setShowAll(v => !v)}
            style={{ background: 'none', border: '1px solid #334155', color: '#94a3b8', borderRadius: 4, padding: '4px 12px', cursor: 'pointer', fontSize: 11 }}>
            {showAll ? 'Show less' : `Show all ${by_day.length} days`}
          </button>
        </div>
      )}
    </div>
  );
}
