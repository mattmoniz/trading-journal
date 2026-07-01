import React from 'react';

export default function SyncProgressPanel({ syncProgress, syncLog, onDismissSync }) {
  const syncPct = syncProgress
    ? syncProgress.status === 'success' ? 100
    : syncProgress.status === 'error' ? null
    : Math.round((Math.min(syncProgress.step, 8) / 8) * 100)
    : 0;

  return (
    <div style={{ margin: '0 0 16px 0', background: 'var(--card-bg)', border: `1px solid ${syncProgress?.status === 'error' ? '#ef4444' : syncProgress?.status === 'success' ? '#22c55e' : '#3b82f6'}`, borderRadius: 10, padding: '14px 18px', fontFamily: 'Arial, sans-serif' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: syncProgress?.status === 'error' ? '#ef4444' : syncProgress?.status === 'success' ? '#22c55e' : '#3b82f6' }}>
            {syncProgress?.status === 'error' ? '✕ Sync Failed' : syncProgress?.status === 'success' ? '✓ Sync Complete' : '⏳ Syncing with Sierra Chart…'}
          </span>
          {syncProgress?.status === 'running' && (
            <span style={{ fontSize: 13, color: '#94a3b8' }}>Progress updates appear below in real time</span>
          )}
        </div>
        {syncProgress?.status !== 'running' && (
          <button onClick={onDismissSync} style={{ background: 'transparent', border: '1px solid var(--border-color)', borderRadius: 5, color: '#94a3b8', cursor: 'pointer', padding: '2px 10px', fontSize: 13 }}>Dismiss</button>
        )}
      </div>
      {/* Progress bar */}
      {syncProgress?.status === 'running' && (
        <div style={{ height: 4, background: 'rgba(59,130,246,0.15)', borderRadius: 2, marginBottom: 12, overflow: 'hidden' }}>
          <div style={{ height: '100%', background: '#3b82f6', borderRadius: 2, width: `${syncPct || 5}%`, transition: 'width 0.4s ease' }} />
        </div>
      )}
      {/* Message log */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
        {syncLog.map((entry, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, fontSize: 13, lineHeight: 1.5 }}>
            <span style={{ color: '#64748b', flexShrink: 0, fontFamily: 'monospace', fontSize: 13 }}>{entry.ts}</span>
            <span style={{ color: entry.status === 'error' ? '#ef4444' : entry.status === 'success' ? '#22c55e' : '#94a3b8' }}>{entry.msg}</span>
          </div>
        ))}
        {syncProgress?.status === 'running' && (
          <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>
            {syncProgress.message}
          </div>
        )}
      </div>
      {/* Error detail */}
      {syncProgress?.status === 'error' && (
        <div style={{ marginTop: 10, padding: '10px 14px', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, fontSize: 13, color: '#94a3b8', lineHeight: 1.9 }}>
          {syncLog.some(e => e.msg?.includes('Trade Activity Log is not open')) ? (<>
            <strong style={{ color: '#fbbf24', display: 'block', marginBottom: 6 }}>⚠ Trade Activity Log must be open before syncing</strong>
            1. In Sierra Chart, open the <strong style={{ color: '#e2e8f0' }}>Trade Activity Log</strong> (Trade menu → Trade Activity Log)<br/>
            2. Make sure your account is selected and data is visible<br/>
            3. Click <strong style={{ color: '#e2e8f0' }}>Sync Trades</strong> again
          </>) : (<>
            <strong style={{ color: '#ef4444' }}>Manual export: </strong>
            Sierra Chart → TAL → <strong style={{ color: '#e2e8f0' }}>File → Export</strong> → save to <code style={{ color: '#fbbf24', fontSize: 13 }}>C:\SierraChart\SavedTradeActivity\</code>
            <br/><span style={{ fontSize: 13, color: '#94a3b8' }}>The watcher will auto-import it when the file appears.</span>
          </>)}
        </div>
      )}
    </div>
  );
}
