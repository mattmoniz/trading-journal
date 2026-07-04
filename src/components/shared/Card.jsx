import React from 'react';

/**
 * Standard dashboard card wrapper. Matches the var(--card-bg) / var(--border-color)
 * theme vars used throughout the app.
 *
 * Props:
 *   title    — optional header string (rendered in muted uppercase)
 *   style    — overrides applied to the outer container
 *   children — card body
 */
export default function Card({ title, children, style }) {
  return (
    <div style={{
      background: 'var(--card-bg)',
      border: '1px solid var(--border-color)',
      borderRadius: 12,
      padding: '16px 20px',
      ...style,
    }}>
      {title && (
        <div style={{
          fontSize: 13, fontWeight: 600, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12,
        }}>
          {title}
        </div>
      )}
      {children}
    </div>
  );
}
