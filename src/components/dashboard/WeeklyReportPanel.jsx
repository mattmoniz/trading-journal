import React, { useState, useEffect } from 'react';

const API_URL = '/api';

const GRADE_COLOR = (g) => {
  if (!g) return 'var(--text-muted)';
  if (g <= 'B') return '#22c55e';
  if (g === 'C') return '#f59e0b';
  return '#ef4444';
};

const navBtn = {
  background: 'none',
  border: '1px solid var(--border-color)',
  borderRadius: 4,
  padding: '1px 7px',
  cursor: 'pointer',
  color: 'var(--text-muted)',
  fontSize: 14,
  lineHeight: 1.4,
};

export default function WeeklyReportPanel({ initialWeekStart = null }) {
  const [weeks, setWeeks] = useState([]);
  const [weekStart, setWeekStart] = useState(initialWeekStart);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    fetch(`${API_URL}/weekly/assessments`)
      .then(r => r.json())
      .then(d => {
        if (!Array.isArray(d)) return;
        setWeeks(d);
        if (!weekStart && d.length) setWeekStart(d[0].week_start);
      })
      .catch(() => {});
  }, []);

  // When parent changes initialWeekStart (e.g. calendar click), follow it
  useEffect(() => {
    if (initialWeekStart) setWeekStart(initialWeekStart);
  }, [initialWeekStart]);

  useEffect(() => {
    if (!weekStart) return;
    setLoading(true);
    setData(null);
    fetch(`${API_URL}/weekly/assessment/${weekStart}`)
      .then(r => r.json())
      .then(d => setData(d || null))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [weekStart]);

  const idx = weeks.findIndex(w => w.week_start === weekStart);
  const hasPrev = idx < weeks.length - 1;
  const hasNext = idx > 0;

  const grade = data?.process_grade;
  const pnl = data?.total_pnl != null ? parseFloat(data.total_pnl) : null;
  const pnlStr = pnl != null ? `${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(0)}` : null;
  const weekLabel = data ? `${data.week_start} – ${data.week_end}` : weekStart || '—';

  return (
    <div style={{ marginBottom: 24, padding: '14px 18px', background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Weekly Report</span>

        <button
          onClick={() => hasPrev && setWeekStart(weeks[idx + 1].week_start)}
          disabled={!hasPrev}
          style={{ ...navBtn, opacity: hasPrev ? 1 : 0.35 }}
          title="Previous week"
        >‹</button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 140 }}>{weekLabel}</span>
        <button
          onClick={() => hasNext && setWeekStart(weeks[idx - 1].week_start)}
          disabled={!hasNext}
          style={{ ...navBtn, opacity: hasNext ? 1 : 0.35 }}
          title="Next week"
        >›</button>

        {loading && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</span>}
        {!loading && !data && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No report for this week</span>}

        {grade && (
          <span style={{
            fontSize: 13, fontWeight: 800,
            color: GRADE_COLOR(grade),
            background: `${GRADE_COLOR(grade)}18`,
            border: `1px solid ${GRADE_COLOR(grade)}60`,
            borderRadius: 6, padding: '1px 10px', letterSpacing: 1,
          }}>
            {grade}
          </span>
        )}
        {pnlStr && (
          <span style={{ fontSize: 12, color: pnl >= 0 ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
            {pnlStr}
          </span>
        )}
        {data && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {data.winning_days}W / {data.losing_days}L  ({data.days_with_trades} days)
          </span>
        )}

        <button
          onClick={() => setExpanded(e => !e)}
          style={{ marginLeft: 'auto', fontSize: 11, background: 'none', border: '1px solid var(--border-color)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', color: 'var(--text-muted)' }}
        >
          {expanded ? 'collapse' : 'expand'}
        </button>
      </div>

      {expanded && data?.report_text && (
        <pre style={{
          margin: '12px 0 0',
          fontSize: 11.5,
          lineHeight: 1.65,
          whiteSpace: 'pre-wrap',
          color: 'var(--text-primary)',
          fontFamily: '"Courier New", Courier, monospace',
          maxHeight: 560,
          overflowY: 'auto',
          paddingTop: 10,
          borderTop: '1px solid var(--border-color)',
        }}>
          {data.report_text}
        </pre>
      )}

      {expanded && !loading && data && !data.report_text && data.assessment_text && (
        <div style={{ margin: '12px 0 0', paddingTop: 10, borderTop: '1px solid var(--border-color)' }}>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px' }}>
            (Full report file not available — showing assessment only)
          </p>
          <pre style={{ fontSize: 11.5, lineHeight: 1.65, whiteSpace: 'pre-wrap', color: 'var(--text-primary)', fontFamily: '"Courier New", Courier, monospace' }}>
            {data.assessment_text}
          </pre>
        </div>
      )}
    </div>
  );
}
