import React, { useState, useEffect } from 'react';
import { Dot, useDataUpdateDot } from '../shared/UpdateDot.jsx';

const API_URL = '/api';

const navBtn = {
  background: 'none', border: '1px solid var(--border-color)', borderRadius: 4,
  padding: '1px 7px', cursor: 'pointer', color: '#94a3b8', fontSize: 14, lineHeight: 1.4,
};

export default function MorningBriefPanel() {
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const [date, setDate] = useState(todayET);
  const [brief, setBrief] = useState(null);
  const [dates, setDates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/morning-brief/dates`)
      .then(r => r.json())
      .then(d => {
        const list = Array.isArray(d) ? d.map(r => r.brief_date) : [];
        setDates(list);
        if (list.length > 0 && !list.includes(todayET)) setDate(list[0]);
      })
      .catch(() => {});
  }, [todayET]);

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

  const aiReadText = brief?.brief_text
    ? (() => { const m = brief.brief_text.match(/AI READ\n[-─]+\n([\s\S]+?)\n[-─]+/); return m ? m[1].trim() : null; })()
    : null;

  const [updateUnseen, clearUpdateSeen] = useDataUpdateDot('acd-dash-morning-brief', 'acd', JSON.stringify(brief));

  return (
    <div style={{ marginBottom: 24, padding: '14px 18px', background: 'var(--card-bg)', border: '1px solid rgba(139,92,246,0.3)', borderRadius: 10 }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#a78bfa', letterSpacing: '0.06em', textTransform: 'uppercase' }}>AI Read{!expanded && updateUnseen && <Dot />}</span>
        <button onClick={() => hasPrev && setDate(dates[idx + 1])} disabled={!hasPrev}
          style={{ ...navBtn, opacity: hasPrev ? 1 : 0.35 }}>‹</button>
        <span style={{ fontSize: 12, color: '#94a3b8', minWidth: 86 }}>{date}</span>
        <button onClick={() => hasNext && setDate(dates[idx - 1])} disabled={!hasNext}
          style={{ ...navBtn, opacity: hasNext ? 1 : 0.35 }}>›</button>
        <button onClick={() => setDate(todayET)} disabled={date === todayET}
          style={{ ...navBtn, fontSize: 13, opacity: date === todayET ? 0.35 : 1 }}>today</button>
        {loading && <span style={{ fontSize: 12, color: '#94a3b8' }}>Loading…</span>}
        {!loading && !brief && <span style={{ fontSize: 12, color: '#94a3b8' }}>No brief for {date}</span>}
        {!loading && brief && genTime && <span style={{ fontSize: 12, color: '#64748b' }}>generated {genTime} ET</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {brief && (
            <button onClick={() => setShowRaw(r => !r)}
              style={{ fontSize: 13, background: 'none', border: '1px solid var(--border-color)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', color: '#94a3b8' }}>
              {showRaw ? 'structured' : 'raw text'}
            </button>
          )}
          <button onClick={() => { if (!expanded) clearUpdateSeen(); setExpanded(e => !e); }}
            style={{ fontSize: 13, background: 'none', border: '1px solid var(--border-color)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', color: '#94a3b8' }}>
            {expanded ? 'collapse' : 'expand'}
          </button>
        </div>
      </div>

      {expanded && brief && (
        <div style={{ marginTop: 10, borderTop: '1px solid rgba(139,92,246,0.15)', paddingTop: 10 }}>
          {showRaw ? (
            <pre style={{ margin: 0, fontSize: 12.5, lineHeight: 1.7, whiteSpace: 'pre-wrap',
              color: '#e2e8f0', fontFamily: '"Courier New", Courier, monospace',
              maxHeight: 600, overflowY: 'auto' }}>
              {brief.brief_text}
            </pre>
          ) : aiReadText ? (
            <div style={{ fontSize: 13, color: '#e2e8f0', lineHeight: 1.75, whiteSpace: 'pre-line' }}>
              {aiReadText}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: '#64748b', fontStyle: 'italic' }}>No AI read available for this date.</div>
          )}
        </div>
      )}
    </div>
  );
}
