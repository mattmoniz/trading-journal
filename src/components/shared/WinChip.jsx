import React from 'react';

/**
 * Reusable win-rate chip. Used in setup detail modals, the live setup card,
 * and any context where a WR + N label is needed.
 *
 * Props:
 *   label      — timeframe or context label ("All", "90d", "TREND", etc.)
 *   stat       — { winRate: 0-1, sessions?: number, n?: number, limitedSample?: bool }
 *   highlight  — adds an indigo panel background (used for "today's day type" context)
 *   isBaseline — appends " *" to label (marks the baseline timeframe)
 */
export default function WinChip({ label, stat, highlight = false, isBaseline = false }) {
  if (!stat || stat.winRate == null) return null;
  const wr = stat.winRate;
  const col = wr >= 0.65 ? '#22c55e' : wr >= 0.50 ? '#f59e0b' : '#ef4444';
  const n = stat.sessions ?? stat.decidedN ?? stat.n;
  return (
    <div style={{
      textAlign: 'center', minWidth: 58,
      ...(highlight && {
        padding: '6px 8px', borderRadius: 6,
        background: 'rgba(99,102,241,0.12)',
        border: '1px solid rgba(99,102,241,0.35)',
      }),
    }}>
      <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
        {label}{isBaseline ? ' *' : ''}
      </div>
      <div style={{ fontSize: 18, fontWeight: 800, fontFamily: 'monospace', color: col }}>
        {(wr * 100).toFixed(0)}%
      </div>
      {n != null && (
        <div style={{ fontSize: 11, color: '#94a3b8' }}>n={n}{stat.limitedSample ? ' ⚠' : ''}</div>
      )}
    </div>
  );
}
