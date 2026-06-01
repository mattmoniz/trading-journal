import React, { useState, useEffect } from 'react';

const API_URL = '/api';

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

export default function MorningBriefPanel() {
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const [date, setDate] = useState(todayET);
  const [brief, setBrief] = useState(null);
  const [dates, setDates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    fetch(`${API_URL}/morning-brief/dates`)
      .then(r => r.json())
      .then(d => setDates(Array.isArray(d) ? d.map(r => r.brief_date) : []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    setBrief(null);
    fetch(`${API_URL}/morning-brief/${date}`)
      .then(r => r.json())
      .then(d => setBrief(d || null))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [date]);

  const idx = dates.indexOf(date);
  const hasPrev = idx < dates.length - 1;
  const hasNext = idx > 0;

  const genTime = brief?.created_at
    ? new Date(brief.created_at).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div style={{ marginBottom: 24, padding: '14px 18px', background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Morning Prep</span>
        <button
          onClick={() => hasPrev && setDate(dates[idx + 1])}
          disabled={!hasPrev}
          style={{ ...navBtn, opacity: hasPrev ? 1 : 0.35 }}
          title="Previous brief"
        >‹</button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 86 }}>{date}</span>
        <button
          onClick={() => hasNext && setDate(dates[idx - 1])}
          disabled={!hasNext}
          style={{ ...navBtn, opacity: hasNext ? 1 : 0.35 }}
          title="Next brief"
        >›</button>
        <button
          onClick={() => setDate(todayET)}
          disabled={date === todayET}
          style={{ ...navBtn, fontSize: 11, opacity: date === todayET ? 0.35 : 1 }}
          title="Jump to today"
        >today</button>
        {loading && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</span>}
        {!loading && !brief && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No brief for {date}</span>}
        {!loading && brief && genTime && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>generated {genTime} ET</span>
        )}
        <button
          onClick={() => setExpanded(e => !e)}
          style={{ marginLeft: 'auto', fontSize: 11, background: 'none', border: '1px solid var(--border-color)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', color: 'var(--text-muted)' }}
        >
          {expanded ? 'collapse' : 'expand'}
        </button>
      </div>

      {expanded && brief?.brief_text && (
        <pre style={{
          margin: '12px 0 0',
          fontSize: 11.5,
          lineHeight: 1.65,
          whiteSpace: 'pre-wrap',
          color: 'var(--text-primary)',
          fontFamily: '"Courier New", Courier, monospace',
          maxHeight: 520,
          overflowY: 'auto',
          paddingTop: 10,
          borderTop: '1px solid var(--border-color)',
        }}>
          {brief.brief_text}
        </pre>
      )}
    </div>
  );
}
