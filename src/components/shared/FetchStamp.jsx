import React from 'react';

export function fmtFetchStamp(d) {
  if (!d) return null;
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return null;
  return dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'America/New_York' }) + ' ET';
}

export default function FetchStamp({ at }) {
  const s = fmtFetchStamp(at);
  if (!s) return null;
  return <span style={{ fontSize: 11, color: '#94a3b8', fontStyle: 'italic', fontFamily: 'monospace' }}>updated · {s}</span>;
}
