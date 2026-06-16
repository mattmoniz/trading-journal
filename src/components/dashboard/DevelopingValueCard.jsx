import React, { useState, useEffect } from 'react';

const API_URL = '/api';

// Shared, descriptive-only "where is value building" card.
// Reads from /api/developing-value/context — ONE source for morning prep,
// afternoon review, and weekly review. No prediction, no signal, no rating.

const DRIFT_LABEL = {
  'BUILDING HIGHER': { text: 'Value has been building HIGHER', color: '#4ade80' },
  'BUILDING LOWER':  { text: 'Value has been building LOWER',  color: '#f87171' },
  'BALANCING':       { text: 'Value has been BALANCING (no net drift)', color: '#94a3b8' },
};

const MIGRATION_LABEL = {
  HIGHER: { text: 'HIGHER vs prior session', color: '#4ade80' },
  LOWER: { text: 'LOWER vs prior session', color: '#f87171' },
  HOLDING: { text: 'HOLDING vs prior session', color: '#94a3b8' },
};

function fmtPrice(v) { return v == null ? 'n/a' : Number(v).toFixed(2); }

export default function DevelopingValueCard({ date, title = 'Developing Value', windows = [5, 10, 20] }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const d = date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    fetch(`${API_URL}/developing-value/context?date=${d}&windows=${windows.join(',')}`)
      .then(r => r.json())
      .then(j => !cancelled && setData(j))
      .catch(() => {});
    return () => { cancelled = true; };
  }, [date, windows.join(',')]);

  if (!data) return null;
  const { current, rolling, descriptive_only } = data;

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>{title}</div>
      <div style={methodNote}>
        POC / value area are OHLC-derived approximations (spread-volume method), not tick-true Market Profile.
        {descriptive_only && ' Descriptive only — no prediction or signal.'}
      </div>

      {current ? (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 13, color: '#cbd5e1' }}>
            <strong>{current.trade_date}</strong>{current.provisional && <span style={{ color: '#fbbf24', marginLeft: 6 }}>PROVISIONAL — session in progress, thin volume</span>}
          </div>
          <div style={{ fontSize: 13, color: '#e2e8f0', marginTop: 2 }}>
            POC {fmtPrice(current.poc)} &nbsp; VAH {fmtPrice(current.vah)} &nbsp; VAL {fmtPrice(current.val)}
          </div>
          {current.migrationDir && (
            <div style={{ fontSize: 12, marginTop: 4, color: MIGRATION_LABEL[current.migrationDir]?.color || '#94a3b8' }}>
              Value migration: {MIGRATION_LABEL[current.migrationDir]?.text || current.migrationDir}
              {current.pocDelta != null && ` (POC ${current.pocDelta >= 0 ? '+' : ''}${current.pocDelta.toFixed(2)})`}
            </div>
          )}
          {current.holdReject && current.holdReject !== 'N/A' && (
            <div style={{ fontSize: 12, marginTop: 2, color: current.holdReject === 'ACCEPTED' ? '#4ade80' : '#94a3b8' }}>
              {current.holdReject === 'ACCEPTED' ? 'Price held beyond the migrated value (accepted).' : 'Price returned back into prior value (rejected).'}
            </div>
          )}
          {current.provisional && (
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
              Early-session reads are noisy (thin volume) — the rolling multi-session view below is the more reliable read.
            </div>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: '#94a3b8' }}>No developing-value data for this session yet.</div>
      )}

      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
          Rolling multi-session drift (more reliable than intraday)
        </div>
        {windows.map(w => {
          const r = rolling?.[w] ?? rolling?.[String(w)];
          if (!r) return null;
          if (!r.available) {
            return <div key={w} style={{ fontSize: 12, color: '#94a3b8' }}>Last {w} sessions: insufficient history (N={r.n}).</div>;
          }
          const drift = DRIFT_LABEL[r.drift] || DRIFT_LABEL.BALANCING;
          return (
            <div key={w} style={{ fontSize: 12, color: '#cbd5e1', marginBottom: 3 }}>
              <span style={{ color: '#94a3b8' }}>Last {w} sessions ({r.firstDate} → {r.lastDate}):</span>{' '}
              <span style={{ color: drift.color, fontWeight: 600 }}>{drift.text}</span>{' '}
              <span style={{ color: '#94a3b8' }}>
                — POC {fmtPrice(r.pocStart)} → {fmtPrice(r.pocEnd)} ({r.pocChange >= 0 ? '+' : ''}{r.pocChange.toFixed(2)});
                {' '}{r.tally.HIGHER || 0} higher / {r.tally.LOWER || 0} lower / {r.tally.HOLDING || 0} holding
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const cardStyle = {
  border: '1px solid var(--border-color, #334155)',
  borderRadius: 8,
  padding: '12px 14px',
  marginBottom: 16,
  background: 'rgba(255,255,255,0.02)',
};

const titleStyle = {
  fontSize: 12,
  fontWeight: 700,
  color: '#cbd5e1',
  marginBottom: 6,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const methodNote = {
  fontSize: 11,
  color: '#94a3b8',
  marginBottom: 8,
  lineHeight: 1.4,
};
